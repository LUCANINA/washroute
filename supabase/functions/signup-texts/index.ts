// signup-texts — session 321 (2026-09-28). Two texts to people who signed up but never ordered.
//
//   signup_d2  ~day 2   "welcome, here's {pct}% off {scope}" + booking link with the code applied
//   signup_d7  ~day 7   "your {pct}% off is still waiting" (only after d2 went out or was skipped)
//
// The link, not "reply PICKUP", is the call to action: almost no one who hasn't ordered yet has a
// saved address, and the PICKUP text command needs one (checked 2026-09-28: 2 of 36).
//
// SAFETY
//   - Only customers created on/after FLOOR are ever considered.
//   - marketing_sms_log has UNIQUE (customer_id, kind); the row is inserted BEFORE the send.
//   - Per-run cap, plus a refusal when the eligible count looks like a bug.
//   - Skips anyone who has any non-cancelled order, has account credit (referred friends),
//     is frozen/cancelled, is a walk-in, or has opted out of texts.
//   - Sends nothing if the promo code is inactive.
//
// MODES  dryrun — who would get what, no sends     run — send (pg_cron)
//        test {phone} — both texts to an admin/manager phone on file, no log
// AUTH   x-wr-internal header only. verify_jwt must be FALSE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(SUPABASE_URL, SVC_KEY)

const FLOOR = '2026-09-21T00:00:00Z'        // signups before this are never texted here
const PROMO_CODE = 'LOVELAUNDRY'
const LINK = `app.familylaundry.com/?promo=${PROMO_CODE}`
const HOUR = 3_600_000
const D2_MIN_H = 40, D2_MAX_H = 6 * 24      // day 2 .. day 6
const D7_MIN_H = 156, D7_MAX_H = 14 * 24    // day 6.5 .. day 14
const CAP = 50                              // per run
const ANOMALY = 150

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const firstName = (s: string | null) => (s || '').trim().split(/\s+/)[0] || 'there'
function e164(p: string | null): string | null {
  const d = (p || '').replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}
function scopeOf(uses: number | null) {
  const n = uses == null ? null : Math.max(1, Math.floor(Number(uses) || 1))
  return n == null ? 'every order' : n === 1 ? 'your first order' : `your first ${n} orders`
}
const msgD2 = (first: string, pct: number, uses: number | null) =>
  `Hi ${first}, welcome to Family Laundry! Here's ${pct}% off ${scopeOf(uses)}. Book in 2 minutes: ${LINK} Reply STOP to opt out.`
const msgD7 = (first: string, pct: number, uses: number | null) =>
  `Hi ${first}, your ${pct}% off ${scopeOf(uses)} is still waiting. Book your first pickup: ${LINK} Reply STOP to opt out.`

type Cust = { id: string; first_name_cache: string | null; phone_cache: string | null; credits: number | null
  account_type: string | null; referral_source: string | null; frozen_at: string | null; cancelled_at: string | null
  sms_marketing_opt_out_at: string | null; sms_notifications_opt_out_at: string | null; created_at: string }
const COLS = 'id, first_name_cache, phone_cache, credits, account_type, referral_source, frozen_at, cancelled_at, sms_marketing_opt_out_at, sms_notifications_opt_out_at, created_at'

async function sendSms(to: string, body: string, customerId?: string) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SVC_KEY}`, 'apikey': SVC_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body, customer_id: customerId || null }),
  })
  if (r.ok) return { ok: true as const }
  return { ok: false as const, error: `${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}` }
}

async function promo(): Promise<{ pct: number; uses: number | null } | null> {
  const { data } = await db.from('discounts').select('value, active, deleted_at, type, max_orders_per_customer')
    .eq('name', PROMO_CODE).maybeSingle()
  if (!data || !data.active || data.deleted_at || data.type !== 'percent') return null
  return { pct: Number(data.value), uses: data.max_orders_per_customer ?? null }
}

async function candidates(minH: number, maxH: number): Promise<Cust[]> {
  const now = Date.now()
  const newest = new Date(now - minH * HOUR).toISOString()
  const oldest = new Date(Math.max(Date.parse(FLOOR), now - maxH * HOUR)).toISOString()
  const { data, error } = await db.from('customers').select(COLS)
    .gte('created_at', oldest).lte('created_at', newest).order('created_at').limit(1000)
  if (error) throw new Error('customers: ' + error.message)
  const custs = ((data || []) as Cust[]).filter(c =>
    (c.account_type || 'individual') === 'individual' && c.referral_source !== 'pos_walkin'
    && !c.frozen_at && !c.cancelled_at && Number(c.credits || 0) <= 0
    && !!e164(c.phone_cache) && !c.sms_marketing_opt_out_at && !c.sms_notifications_opt_out_at)
  if (!custs.length) return []
  const ordered = new Set<string>()
  for (let i = 0; i < custs.length; i += 100) {
    const { data: o, error: oe } = await db.from('orders').select('customer_id')
      .in('customer_id', custs.slice(i, i + 100).map(c => c.id)).neq('status', 'cancelled')
    if (oe) throw new Error('orders: ' + oe.message)
    for (const r of o || []) ordered.add((r as any).customer_id)
  }
  return custs.filter(c => !ordered.has(c.id))
}

async function logged(ids: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('marketing_sms_log').select('customer_id, kind').in('customer_id', ids.slice(i, i + 100))
    if (error) throw new Error('marketing_sms_log: ' + error.message)
    for (const r of (data || []) as any[]) {
      if (!out.has(r.customer_id)) out.set(r.customer_id, new Set())
      out.get(r.customer_id)!.add(r.kind)
    }
  }
  return out
}

async function plan() {
  const [c2, c7] = await Promise.all([candidates(D2_MIN_H, D2_MAX_H), candidates(D7_MIN_H, D7_MAX_H)])
  const log = await logged([...new Set([...c2, ...c7].map(c => c.id))])
  const d2 = c2.filter(c => !log.get(c.id)?.has('signup_d2'))
  const d7 = c7.filter(c => log.get(c.id)?.has('signup_d2') && !log.get(c.id)?.has('signup_d7'))
  return { d2, d7 }
}

async function sendLogged(c: Cust, kind: 'signup_d2' | 'signup_d7', body: string) {
  const { data: row, error } = await db.from('marketing_sms_log')
    .insert({ customer_id: c.id, kind, status: 'sending' }).select('id').single()
  if (error) {
    if ((error as any).code === '23505') return 'duplicate'
    throw new Error(`log insert failed (${kind}): ${error.message} — nothing sent`)
  }
  const r = await sendSms(e164(c.phone_cache)!, body, c.id)
  const { error: ue } = await db.from('marketing_sms_log').update(r.ok
    ? { status: 'sent', sent_at: new Date().toISOString() }
    : { status: 'failed', note: r.error }).eq('id', row.id)
  if (ue) console.error('signup-texts: log update failed', row.id, ue.message)
  return r.ok ? 'sent' : 'failed'
}

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
  return !!data?.secret && provided === data.secret
}

Deno.serve(async (req) => {
  try {
    if (!(await isInternalCall(req))) return json({ error: 'forbidden' }, 403)
    const body = await req.json().catch(() => ({}))
    const mode = body.mode || 'dryrun'
    const p = await promo()
    if (!p) return json({ mode, sent: 0, note: `${PROMO_CODE} not active — nothing sent` })

    if (mode === 'test') {
      const to = e164(body.phone)
      const { data: staff } = await db.from('profiles').select('phone, role').in('role', ['admin', 'manager'])
      if (!to || !(staff || []).some((s: any) => e164(s.phone) === to))
        return json({ error: 'test text only goes to an admin/manager phone on file' }, 400)
      const a = await sendSms(to, msgD2('David', p.pct, p.uses))
      const b = await sendSms(to, msgD7('David', p.pct, p.uses))
      return json({ mode, d2: a, d7: b, sample_d2: msgD2('David', p.pct, p.uses), sample_d7: msgD7('David', p.pct, p.uses) })
    }

    const { d2, d7 } = await plan()
    const summary: any = { mode, floor: FLOOR, d2_eligible: d2.length, d7_eligible: d7.length,
      sample_d2: msgD2('<first>', p.pct, p.uses), sample_d7: msgD7('<first>', p.pct, p.uses) }
    if (d2.length > ANOMALY || d7.length > ANOMALY) {
      console.error('signup-texts: refused, eligible count looks wrong', summary)
      return json({ ...summary, refused: true, reason: `more than ${ANOMALY} eligible` }, 409)
    }
    if (mode !== 'run') return json(summary)

    const res = { signup_d2: { sent: 0, failed: 0, duplicate: 0 }, signup_d7: { sent: 0, failed: 0, duplicate: 0 } } as any
    let left = CAP
    for (const c of d2) { if (left-- <= 0) break; res.signup_d2[await sendLogged(c, 'signup_d2', msgD2(firstName(c.first_name_cache), p.pct, p.uses))]++ }
    for (const c of d7) { if (left-- <= 0) break; res.signup_d7[await sendLogged(c, 'signup_d7', msgD7(firstName(c.first_name_cache), p.pct, p.uses))]++ }
    summary.result = res
    console.log('signup-texts run', JSON.stringify(res))
    return json(summary)
  } catch (e: any) {
    console.error('signup-texts error:', e?.message || e)
    return json({ error: e?.message || String(e) }, 500)
  }
})
