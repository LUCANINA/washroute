// auto-nudge — session 344 (2026-10-12). First-order "nudge" texts, sent automatically when an
// admin or manager opens the admin dashboard. Replaces clicking "Nudge" on Reports → New Customers.
//
// WHO GETS ONE: signed up 1 hour – 3 days ago, no non-cancelled order, never nudged before
//   (manual or auto), individual account, not a walk-in, not a staff login, not frozen/cancelled,
//   valid US phone, not opted out of texts.
// SENT AS: the staff member who opened the dashboard ("this is Lili from Family Laundry"),
//   through send-sms with THEIR login, so the inbox shows who sent it.
//
// SAFETY
//   - ENABLED below is the on/off switch (no database setting — see session 344 notes).
//   - Server-enforced quiet hours: nothing before 7 am or after 8 pm Pacific.
//   - Only admin / manager logins can trigger it.
//   - At most MAX_SEND texts per call; if more than ABORT_OVER look eligible, sends NOTHING
//     (that many means something is wrong, not that many people signed up).
//   - Each customer is re-checked for an existing nudge right before their text goes out.
//
// MODES  POST {}               → send (normal dashboard call)
//        POST {"dryrun":true}  → who would get a text, nothing sent
// AUTH   staff JWT in Authorization header. verify_jwt FALSE (checked here, same as send-sms).

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const ENABLED = false             // ← on/off switch
const START_HOUR = 7              // Pacific, inclusive
const END_HOUR = 20               // Pacific, exclusive (nothing at/after 8 pm)
const MIN_AGE_MIN = 60            // give brand-new sign-ups an hour to book on their own
const MAX_AGE_DAYS = 3
const MAX_SEND = 10
const ABORT_OVER = 25
const NUDGE_MARK = 'place your first order'   // same phrase the manual Nudge button uses
const TRIGGER_ROLES = new Set(['admin', 'manager'])

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const db = createClient(SUPABASE_URL, SVC_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

function e164(p: string | null): string | null {
  const d = (p || '').replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}

function pacificHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(d))
}

async function staffFromJwt(jwt: string) {
  if (!jwt || jwt === ANON_KEY || jwt === SVC_KEY) return null
  const { data: { user }, error } = await db.auth.getUser(jwt)
  if (error || !user) return null
  const { data: p } = await db.from('profiles').select('id, role, first_name').eq('id', user.id).single()
  if (!p || !TRIGGER_ROLES.has(p.role)) return null
  return p as { id: string; role: string; first_name: string | null }
}

async function alreadyNudged(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('sms_messages').select('customer_id')
      .in('customer_id', ids.slice(i, i + 100)).eq('direction', 'outbound').ilike('body', `%${NUDGE_MARK}%`)
    if (error) throw new Error('sms_messages: ' + error.message)
    for (const r of data || []) out.add((r as any).customer_id)
  }
  return out
}

async function eligible() {
  const now = Date.now()
  const oldest = new Date(now - MAX_AGE_DAYS * 864e5).toISOString()
  const newest = new Date(now - MIN_AGE_MIN * 6e4).toISOString()
  const { data, error } = await db.from('customers')
    .select('id, first_name_cache, last_name_cache, phone_cache, account_type, referral_source, frozen_at, cancelled_at, sms_marketing_opt_out_at, sms_notifications_opt_out_at, profile_id, created_at')
    .gte('created_at', oldest).lte('created_at', newest).order('created_at').limit(500)
  if (error) throw new Error('customers: ' + error.message)
  let custs = (data || []).filter((c: any) =>
    (c.account_type || 'individual') === 'individual' && c.referral_source !== 'pos_walkin'
    && !c.frozen_at && !c.cancelled_at && !!e164(c.phone_cache)
    && !c.sms_marketing_opt_out_at && !c.sms_notifications_opt_out_at)
  if (!custs.length) return []

  const ids = custs.map((c: any) => c.id)
  // Staff logins that also have a customer row
  const profIds = custs.map((c: any) => c.profile_id).filter(Boolean)
  const staff = new Set<string>()
  if (profIds.length) {
    const { data: ps, error: pe } = await db.from('profiles').select('id, role').in('id', profIds)
    if (pe) throw new Error('profiles: ' + pe.message)
    for (const p of ps || []) if ((p as any).role !== 'customer') staff.add((p as any).id)
  }
  // Anyone with a non-cancelled order
  const ordered = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data: o, error: oe } = await db.from('orders').select('customer_id')
      .in('customer_id', ids.slice(i, i + 100)).neq('status', 'cancelled')
    if (oe) throw new Error('orders: ' + oe.message)
    for (const r of o || []) ordered.add((r as any).customer_id)
  }
  const nudged = await alreadyNudged(ids)
  return custs.filter((c: any) => !ordered.has(c.id) && !nudged.has(c.id) && !(c.profile_id && staff.has(c.profile_id)))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    const staff = await staffFromJwt(jwt)
    if (!staff) return json({ error: 'admin or manager login required' }, 403)

    let body: any = {}
    try { body = await req.json() } catch { /* empty body is fine */ }
    const dryrun = body?.dryrun === true

    const hour = pacificHour()
    const inHours = hour >= START_HOUR && hour < END_HOUR
    const list = await eligible()
    const preview = list.map((c: any) => ({ id: c.id, name: `${c.first_name_cache || ''} ${c.last_name_cache || ''}`.trim(), joined: c.created_at }))

    if (dryrun) return json({ dryrun: true, enabled: ENABLED, in_hours: inHours, pacific_hour: hour, eligible: preview.length, would_send: preview.slice(0, MAX_SEND), aborted: preview.length > ABORT_OVER })
    if (!ENABLED) return json({ sent: 0, skipped: 'disabled' })
    if (!inHours) return json({ sent: 0, skipped: 'quiet hours', pacific_hour: hour })
    if (list.length > ABORT_OVER) {
      console.warn(`auto-nudge aborted: ${list.length} eligible > ${ABORT_OVER}`)
      return json({ sent: 0, skipped: `aborted: ${list.length} eligible looks wrong` })
    }

    const sender = (staff.first_name || '').trim() || 'Family Laundry'
    const sent: string[] = [], failed: string[] = []
    for (const c of list.slice(0, MAX_SEND) as any[]) {
      // Re-check right before sending: another staff member's dashboard may have just nudged them.
      if ((await alreadyNudged([c.id])).size) continue
      const name = (c.first_name_cache || '').trim() || 'there'
      const text = `Hi ${name}, this is ${sender} from Family Laundry. Can I help you place your first order with us? You can book here: https://app.familylaundry.com/ — or just reply with any questions!`
      const r = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify({ to: e164(c.phone_cache), body: text, customer_id: c.id }),
      })
      if (r.ok) sent.push(name)
      else { failed.push(name); console.error('auto-nudge send failed', c.id, await r.text()) }
    }
    console.log(`auto-nudge by ${sender}: sent ${sent.length}, failed ${failed.length}, eligible ${list.length}`)
    return json({ sent: sent.length, failed: failed.length, names: sent })
  } catch (e) {
    console.error('auto-nudge error', e)
    return json({ error: String(e) }, 500)
  }
})
