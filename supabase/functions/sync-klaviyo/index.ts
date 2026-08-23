import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_API_KEY') || ''
const REVISION = '2024-10-15'
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
// Session 137 security: the shared secret used to be a string literal
// committed in this file (and therefore in every clone of the repo). It now
// comes from Supabase Secrets only, and MUST be rotated to a new value —
// the old literal is compromised. If KLAVIYO_SYNC_SECRET is unset the
// function fails CLOSED (403) rather than accepting an empty secret.
const SYNC_SECRET = Deno.env.get('KLAVIYO_SYNC_SECRET') || ''

// Constant-time string compare so a caller can't recover the secret one
// character at a time from response timing.
function secretMatches(provided: unknown): boolean {
  if (!SYNC_SECRET) return false
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = new TextEncoder().encode(provided)
  const b = new TextEncoder().encode(SYNC_SECRET)
  // Compare a fixed number of bytes so length alone doesn't short-circuit.
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}
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


// ── Session 228: internal-caller auth (pg_cron / DB functions) ──────────────
// pg_cron and SECURITY DEFINER DB functions reach edge functions through
// net.http_post and CANNOT present the service-role key — it is not stored
// anywhere reachable from SQL and the Supabase vault is empty. Every pg_cron
// HTTP job in this project sends the ANON key, which is why session 227 held
// these four functions back: hardening them to require the service-role key
// would have killed their cron silently.
//
// They now send the shared secret from public.wr_internal_auth (RLS on, no
// policies, no anon/authenticated grants — only a service-role client can read
// it) as the x-wr-internal header, via public.wr_internal_secret(). Same
// mechanism charge-order / send-email / send-order-notification already use.
// See migration session_227h_internal_call_secret.
async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const c = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await c.from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch (_) {
    return false
  }
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    // Session 228: the nightly cron authenticates with the x-wr-internal shared
    // secret held in the DB, so no dashboard secret is needed and nothing lands in
    // cron.job.command. KLAVIYO_SYNC_SECRET still works for a manual call if set.
    // The old literal 'wr-klaviyo-sync-9x2' is dead — it is in git history and is
    // no longer accepted by anything.
    const internalOk = await isInternalCall(req)
    if (!internalOk && !secretMatches(body.secret)) {
      console.warn('sync-klaviyo: rejected caller with no valid internal secret')
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    }
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
