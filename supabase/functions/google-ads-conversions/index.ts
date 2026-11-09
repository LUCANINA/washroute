// google-ads-conversions — Nov 9 2026.
// A CSV that Google Ads downloads once a day ("scheduled upload from HTTPS") to learn which ad
// clicks became real customers. One row per customer who arrived from a Google Ads click (gclid
// saved in customers.acquisition by the website/app) and then had a FIRST order delivered.
//
//   Google Click ID, Conversion Name, Conversion Time, Conversion Value, Conversion Currency
//
// Nothing personal leaves WashRoute: only Google's own click id, a timestamp and an amount.
// Google de-duplicates on (click id, conversion name, time), so re-sending the same rows every
// day is safe; rows older than Google's 90-day click window are left out.
//
// CONVERSION NAME must match the Google Ads conversion action exactly: "First order delivered".
// VALUE = that first order's billed total less refunds. Subscription orders bill $0, so for a
// subscriber the first subscription invoice is used instead.
//
// AUTH  HTTP Basic, user/password from the edge secrets GADS_UPLOAD_USER / GADS_UPLOAD_PASSWORD
//       (entered once in Google Ads → Conversions → Uploads → Schedules). GET only.
//       verify_jwt must be FALSE: Google cannot send a Supabase JWT.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CONVERSION_NAME = 'First order delivered'
const TZ = 'America/Los_Angeles'
const CLICK_WINDOW_DAYS = 90
const DAY = 86_400_000

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

function authorized(req: Request): boolean {
  const user = Deno.env.get('GADS_UPLOAD_USER') || ''
  const pass = Deno.env.get('GADS_UPLOAD_PASSWORD') || ''
  if (!user || !pass) return false
  const h = req.headers.get('Authorization') || ''
  if (!h.startsWith('Basic ')) return false
  let decoded = ''
  try { decoded = atob(h.slice(6)) } catch { return false }
  const expected = `${user}:${pass}`
  if (decoded.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= decoded.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// 'YYYY-MM-DD HH:mm:ss' in Pacific time (the file declares TimeZone=America/Los_Angeles).
function pt(ts: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

const csvCell = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v

async function inBatches<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 100) out.push(...await fn(ids.slice(i, i + 100)))
  return out
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  if (!authorized(req)) {
    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="gads"' } })
  }
  try {
    const since = new Date(Date.now() - (CLICK_WINDOW_DAYS + 5) * DAY).toISOString()
    const { data: custs, error: ce } = await db.from('customers')
      .select('id, acquisition, created_at')
      .filter('acquisition->>gclid', 'neq', '')
      .gte('created_at', since)
    if (ce) throw ce
    const withClick = (custs || []).filter(c => typeof c.acquisition?.gclid === 'string' && c.acquisition.gclid.trim())
    const ids = withClick.map(c => c.id)

    const orders = await inBatches(ids, async chunk => {
      const { data, error } = await db.from('orders')
        .select('customer_id, total_amount, amount_refunded, actual_delivery_at, created_at, status')
        .in('customer_id', chunk).eq('status', 'delivered')
      if (error) throw error
      return data || []
    })
    const subs = await inBatches(ids, async chunk => {
      const { data, error } = await db.from('customer_transactions')
        .select('customer_id, amount, created_at')
        .in('customer_id', chunk).eq('type', 'subscription_invoice')
      if (error) throw error
      return data || []
    })

    const rows: string[] = []
    for (const c of withClick) {
      const first = orders
        .filter(o => o.customer_id === c.id)
        .map(o => ({ ...o, when: o.actual_delivery_at || o.created_at }))
        .sort((a, b) => String(a.when).localeCompare(String(b.when)))[0]
      if (!first) continue
      const clickAt = Date.parse(c.acquisition.at || c.created_at)
      const convAt = Date.parse(first.when)
      if (!(convAt >= clickAt) || convAt - clickAt > CLICK_WINDOW_DAYS * DAY) continue
      let value = Number(first.total_amount || 0) - Number(first.amount_refunded || 0)
      if (value <= 0) {
        const sub = subs.filter(s => s.customer_id === c.id)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]
        value = sub ? Number(sub.amount || 0) : 0
      }
      rows.push([csvCell(c.acquisition.gclid.trim()), CONVERSION_NAME, pt(first.when),
                 Math.max(0, value).toFixed(2), 'USD'].join(','))
    }

    const body = `Parameters:TimeZone=${TZ}\n`
      + 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency\n'
      + rows.join('\n') + (rows.length ? '\n' : '')
    return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('google-ads-conversions:', e)
    return new Response('Error building conversions', { status: 500 })
  }
})
