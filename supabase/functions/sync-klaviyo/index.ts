import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_API_KEY') || ''
const REVISION = '2024-10-15'
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SECRET = 'wr-klaviyo-sync-9x2'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const kHeaders = {
  'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
  'accept': 'application/json',
  'content-type': 'application/json',
  'revision': REVISION,
}

function normPhone(raw: string | null): string | null {
  if (!raw) return null
  const d = raw.replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}

function buildProfile(c: any) {
  const marketable = !!c.email_marketing_consent_at && !c.email_marketing_opt_out_at
  const email = (c.email_cache || '').trim().toLowerCase()
  const isPlaceholder = /\+app\.starchup\.com@/i.test(email)
  const phone = normPhone(c.phone_cache)
  const attrs: any = {
    email,
    properties: {
      wr_customer_id: c.id,
      wr_lifetime_value: Number(c.lifetime_value || 0),
      wr_total_orders: Number(c.total_orders || 0),
      wr_last_order_at: c.last_order_at || null,
      wr_customer_since: c.created_at || null,
      wr_billing_type: c.billing_type || null,
      wr_customer_type: c.customer_type || null,
      wr_credits: Number(c.credits || 0),
      wr_marketing_status: marketable ? 'subscribed' : 'suppressed',
      wr_email_placeholder: isPlaceholder,
    },
  }
  if (c.first_name_cache) attrs.first_name = c.first_name_cache
  if (c.last_name_cache) attrs.last_name = c.last_name_cache
  if (phone) attrs.phone_number = phone
  return { type: 'profile', attributes: attrs }
}

const SELECT_COLS = 'id, first_name_cache, last_name_cache, email_cache, phone_cache, lifetime_value, total_orders, last_order_at, created_at, billing_type, customer_type, credits, email_marketing_consent_at, email_marketing_opt_out_at'

// Submit one page of profiles to Klaviyo's bulk-import endpoint, retrying on 429.
async function submitPage(offset: number, limit: number): Promise<any> {
  const { data: rows, error } = await db.from('customers')
    .select(SELECT_COLS)
    .not('email_cache', 'is', null).neq('email_cache', '')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw new Error('DB: ' + error.message)
  const returned = rows?.length || 0
  if (returned === 0) return { returned: 0, submitted: 0, done: true }
  const profiles = rows.map(buildProfile).filter((p: any) => p.attributes.email.includes('@'))
  const payload = { data: { type: 'profile-bulk-import-job', attributes: { profiles: { data: profiles } } } }
  let attempt = 0
  while (attempt < 4) {
    const r = await fetch('https://a.klaviyo.com/api/profile-bulk-import-jobs/', { method: 'POST', headers: kHeaders, body: JSON.stringify(payload) })
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); attempt++; continue }
    const j = await r.json().catch(() => ({}))
    return { returned, submitted: profiles.length, ok: r.ok, status: r.status, job_id: j?.data?.id || null, error: j?.errors?.[0]?.detail || null, done: returned < limit }
  }
  return { returned, submitted: profiles.length, ok: false, error: 'throttled after retries', done: returned < limit }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    if (body.secret !== SECRET) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    if (!KLAVIYO_KEY) return new Response(JSON.stringify({ error: 'KLAVIYO_API_KEY not set in environment' }), { status: 500 })
    const mode = body.mode || 'verify'

    if (mode === 'verify') {
      const r = await fetch('https://a.klaviyo.com/api/accounts/', { headers: kHeaders })
      const j = await r.json()
      return new Response(JSON.stringify({ ok: r.ok, status: r.status, org: j?.data?.[0]?.attributes?.contact_information?.organization_name || null, error: j?.errors?.[0]?.detail || null }), { headers: { 'content-type': 'application/json' } })
    }

    if (mode === 'jobstatus') {
      const r = await fetch(`https://a.klaviyo.com/api/profile-bulk-import-jobs/${body.job_id}/`, { headers: kHeaders })
      const j = await r.json()
      return new Response(JSON.stringify({ status: j?.data?.attributes?.status || null, completed: j?.data?.attributes?.completed_count, failed: j?.data?.attributes?.failed_count, total: j?.data?.attributes?.total_count, error: j?.errors?.[0]?.detail || null }), { headers: { 'content-type': 'application/json' } })
    }

    if (mode === 'backfill') {
      const r = await submitPage(Number(body.offset || 0), Math.min(Number(body.limit || 500), 1000))
      return new Response(JSON.stringify(r), { headers: { 'content-type': 'application/json' } })
    }

    // fullsync: self-paginate ALL emailable customers, paced + retried. This is
    // the nightly cron entry point. Profiles only — never sends or subscribes.
    if (mode === 'fullsync') {
      const limit = 500
      let offset = 0, pages = 0, totalReturned = 0, totalSubmitted = 0
      const errors: string[] = []
      while (pages < 60) {
        const r = await submitPage(offset, limit)
        totalReturned += r.returned; totalSubmitted += (r.submitted || 0); pages++
        if (r.error) errors.push(`offset ${offset}: ${r.error}`)
        if (r.returned === 0 || r.done) break
        offset += limit
        await sleep(1500) // pace to stay under Klaviyo's import rate limit
      }
      return new Response(JSON.stringify({ mode: 'fullsync', pages, totalReturned, totalSubmitted, errors }), { headers: { 'content-type': 'application/json' } })
    }

    return new Response(JSON.stringify({ error: 'unknown mode' }), { status: 400 })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
})
