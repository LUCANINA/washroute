// winback — session 321 (2026-09-28). Win-back credit campaign for customers who stopped ordering.
//
// Per released row in public.winback_grants:
//   Day 0  add the credit through adjust_customer_credits (ledger), then email it (if they agreed to email)
//   Day 1  one text, only if they still haven't booked since the credit was added (and haven't opted out)
//   Day 30 take back whatever part of the win-back credit is still unused, through the same ledger RPC
//
// SAFETY
//   - Only rows with release_at <= now() are ever touched. Enrolling a customer does nothing by itself.
//   - Every step claims its row first (pending -> granting/sending) so overlapping runs never double-act.
//   - Per-run caps; a run refuses outright if the released backlog looks like a bug.
//   - Eligibility and consent are re-checked at the moment of each action, not at enrollment.
//   - Credits only ever move through adjust_customer_credits, so they show in Billing History.
//
// MODES  dryrun — what a tick would do, nothing changes      tick — do it (pg_cron)
//        test {email?, phone?} — send both messages to a STAFF address/phone only, no credit, no log
// AUTH   x-wr-internal header only. verify_jwt must be FALSE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SG_KEY = Deno.env.get('SENDGRID_API_KEY') || ''
const db = createClient(SUPABASE_URL, SVC_KEY)

const UNSUB_GROUP_ID = 34476                // SendGrid "Marketing emails"
const FROM = { email: 'news@news.familylaundry.com', name: 'Family Laundry' }
const REPLY_TO = { email: 'info@familylaundry.com', name: 'Family Laundry' }
const APP = 'https://app.familylaundry.com/'
const LOGO = 'https://app.familylaundry.com/assets/logo.png'
const ADDRESS = 'Family Laundry · 2609 Foothill Blvd, Oakland, CA 94601'
const HOUR = 3_600_000, DAY = 24 * HOUR
const EXPIRES_DAYS = 30
const SMS_AFTER_HOURS = 20                  // "day 1": the next daily run after the credit was added
const GRANT_CAP = 100, SMS_CAP = 100, EXPIRE_CAP = 200   // per run
const ANOMALY = 600                         // more released work than this = something is wrong
const TEST_EMAIL_ALLOW = /(@familylaundry\.com|^dmacquart@gmail\.com)$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ACTIVE_ORDER = ['scheduled', 'picked_up', 'processing', 'folding', 'ready_for_delivery', 'on_hold']

const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase()
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const money = (n: number) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })
const firstName = (s: string | null) => (s || '').trim().split(/\s+/)[0] || 'there'
function e164(p: string | null): string | null {
  const d = (p || '').replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}

// ── Messages ───────────────────────────────────────────────────────────────
function emailMsg(first: string, amount: number, until: string) {
  const a = money(amount)
  const subject = `${a} is waiting in your Family Laundry account`
  const preview = `It comes off your next order automatically, through ${until}`
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px">
<tr><td align="center" style="padding:28px 24px 8px"><a href="${APP}"><img src="${LOGO}" width="160" alt="Family Laundry" style="display:block;width:160px;height:auto;border:0"></a></td></tr>
<tr><td style="padding:8px 28px 28px;font-size:17px;line-height:1.55">
<p>Hi ${esc(first)},</p>
<p>It's been a while, and we'd love to have you back. We've added a <b>${a} credit</b> to your account. It comes off your next order automatically, through <b>${esc(until)}</b>.</p>
<p style="text-align:center;margin:28px 0 8px"><a href="${APP}" style="display:inline-block;background:#ffcc33;color:#000;text-decoration:none;font-weight:700;padding:15px 36px;border-radius:50px">Book a pickup</a></p>
<p style="text-align:center;margin:0 0 20px">or just text <b>PICKUP</b> to (510) 588-4102</p>
<p>If something about your last order wasn't right, reply to this email. We read every reply.</p>
</td></tr></table>
<p style="font-size:12.5px;line-height:1.5;color:#666;margin:16px 0 0;text-align:center">${esc(ADDRESS)}<br>
You're getting this because you signed up for Family Laundry emails. <a href="<%asm_group_unsubscribe_raw_url%>" style="color:#666">Unsubscribe</a></p>
</td></tr></table></body></html>`
  const text = `Hi ${first},

It's been a while, and we'd love to have you back. We've added a ${a} credit to your account. It comes off your next order automatically, through ${until}.

Book a pickup: ${APP}
Or just text PICKUP to (510) 588-4102.

If something about your last order wasn't right, reply to this email. We read every reply.

${ADDRESS}
Unsubscribe: <%asm_group_unsubscribe_raw_url%>`
  return { subject, html, text }
}
const smsMsg = (first: string, amount: number, until: string) =>
  `Hi ${first}, it's Family Laundry. We've added ${money(amount)} to your account, good through ${until}. Reply PICKUP to book, or visit app.familylaundry.com. Reply STOP to opt out.`

// ── Senders ────────────────────────────────────────────────────────────────
async function sendEmail(to: string, name: string | null, m: { subject: string; html: string; text: string }, customerId?: string) {
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', headers: { 'Authorization': `Bearer ${SG_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [name ? { email: to, name } : { email: to }] }],
      from: FROM, reply_to: REPLY_TO, subject: m.subject,
      content: [{ type: 'text/plain', value: m.text }, { type: 'text/html', value: m.html }],
      asm: { group_id: UNSUB_GROUP_ID }, categories: ['winback'],
      custom_args: customerId ? { customer_id: customerId, kind: 'winback' } : { kind: 'winback' },
    }),
  })
  if (r.status === 202) return { ok: true as const }
  return { ok: false as const, error: `${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}` }
}
async function sendSms(to: string, body: string, customerId?: string) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SVC_KEY}`, 'apikey': SVC_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, body, customer_id: customerId || null }),
  })
  if (r.ok) return { ok: true as const }
  return { ok: false as const, error: `${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}` }
}

// ── Data ───────────────────────────────────────────────────────────────────
type Cust = { id: string; first_name_cache: string | null; last_name_cache: string | null; email_cache: string | null
  phone_cache: string | null; credits: number | null; frozen_at: string | null; cancelled_at: string | null
  email_marketing_consent_at: string | null; email_marketing_opt_out_at: string | null
  sms_marketing_opt_out_at: string | null; sms_notifications_opt_out_at: string | null }
const CUST_COLS = 'id, first_name_cache, last_name_cache, email_cache, phone_cache, credits, frozen_at, cancelled_at, email_marketing_consent_at, email_marketing_opt_out_at, sms_marketing_opt_out_at, sms_notifications_opt_out_at'
type Row = { id: number; batch: string; customer_id: string; amount: number; granted_at: string | null; expires_at: string | null; created_at: string }
const ROW_COLS = 'id, batch, customer_id, amount, granted_at, expires_at, created_at'

async function customers(ids: string[]): Promise<Map<string, Cust>> {
  const out = new Map<string, Cust>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('customers').select(CUST_COLS).in('id', ids.slice(i, i + 100))
    if (error) throw new Error('customers: ' + error.message)
    for (const c of (data || []) as Cust[]) out.set(c.id, c)
  }
  return out
}
async function suppressed(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const list = emails.filter(Boolean)
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await db.from('email_suppressions').select('email').in('email', list.slice(i, i + 100))
    if (error) throw new Error('email_suppressions: ' + error.message)
    for (const r of data || []) out.add(norm((r as any).email))
  }
  return out
}
// customer_id -> latest created_at of any non-cancelled order
async function lastOrderAt(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('orders').select('customer_id, created_at, status')
      .in('customer_id', ids.slice(i, i + 100)).not('status', 'in', '(cancelled,skipped,pickup_failed)')
      .order('created_at', { ascending: false }).limit(5000)
    if (error) throw new Error('orders: ' + error.message)
    for (const o of (data || []) as any[]) if (!out.has(o.customer_id)) out.set(o.customer_id, o.created_at)
  }
  return out
}
async function activeOrder(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('orders').select('customer_id').in('customer_id', ids.slice(i, i + 100)).in('status', ACTIVE_ORDER)
    if (error) throw new Error('orders: ' + error.message)
    for (const o of (data || []) as any[]) out.add(o.customer_id)
  }
  return out
}
const emailable = (c: Cust, supp: Set<string>) => {
  const e = norm(c.email_cache)
  return !!c.email_marketing_consent_at && !c.email_marketing_opt_out_at && EMAIL_RE.test(e)
    && !/starchup\.com/i.test(e) && !supp.has(e)
}
const textable = (c: Cust) => !!e164(c.phone_cache) && !c.sms_marketing_opt_out_at && !c.sms_notifications_opt_out_at

// ── Plan ───────────────────────────────────────────────────────────────────
async function plan() {
  const now = new Date().toISOString()
  const [g, s, x] = await Promise.all([
    db.from('winback_grants').select(ROW_COLS)
      .eq('grant_status', 'pending').not('release_at', 'is', null).lte('release_at', now).order('id').limit(ANOMALY + 1),
    db.from('winback_grants').select(ROW_COLS)
      .eq('grant_status', 'granted').eq('sms_status', 'pending')
      .lte('granted_at', new Date(Date.now() - SMS_AFTER_HOURS * HOUR).toISOString()).order('id').limit(ANOMALY + 1),
    db.from('winback_grants').select(ROW_COLS)
      .eq('grant_status', 'granted').is('expired_at', null).lte('expires_at', now).order('id').limit(ANOMALY + 1),
  ])
  for (const r of [g, s, x]) if (r.error) throw new Error('winback_grants: ' + r.error.message)
  return { grants: (g.data || []) as Row[], sms: (s.data || []) as Row[], expire: (x.data || []) as Row[] }
}

// ── Steps ──────────────────────────────────────────────────────────────────
async function doGrants(rows: Row[], res: any) {
  if (!rows.length) return
  const ids = rows.map(r => r.customer_id)
  const [cm, active, last] = await Promise.all([customers(ids), activeOrder(ids), lastOrderAt(ids)])
  const supp = await suppressed([...cm.values()].map(c => norm(c.email_cache)))
  for (const r of rows) {
    const c = cm.get(r.customer_id)
    const lo = last.get(r.customer_id)
    const orderedSinceEnroll = !!lo && Date.parse(lo) >= Date.parse(r.created_at)
    // claim
    const { data: claimed, error: ce } = await db.from('winback_grants').update({ grant_status: 'granting' })
      .eq('id', r.id).eq('grant_status', 'pending').select('id')
    if (ce) throw new Error('claim: ' + ce.message)
    if (!claimed?.length) { res.grant.raced++; continue }
    const skip = !c ? 'customer not found' : c.frozen_at ? 'account frozen' : c.cancelled_at ? 'account cancelled'
      : Number(c.credits || 0) > 0 ? 'already has credit' : active.has(c.id) ? 'already has an order booked'
      : orderedSinceEnroll ? 'ordered since enrollment' : null
    if (skip) {
      await db.from('winback_grants').update({ grant_status: 'skipped', grant_note: skip, email_status: 'skipped', sms_status: 'skipped' }).eq('id', r.id)
      res.grant.skipped++; continue
    }
    const expires = new Date(Date.now() + EXPIRES_DAYS * DAY).toISOString()
    const until = day(expires)
    const { error: re } = await db.rpc('adjust_customer_credits', {
      p_customer_id: c!.id, p_amount: r.amount, p_type: 'credit_add',
      p_note: `Win-back ${r.batch}: ${money(r.amount)}, unused part removed after ${until}`, p_actor_name: 'Win-back',
    })
    if (re) {
      await db.from('winback_grants').update({ grant_status: 'failed', grant_note: re.message.slice(0, 300), email_status: 'skipped', sms_status: 'skipped' }).eq('id', r.id)
      res.grant.failed++; continue
    }
    const grantedAt = new Date().toISOString()
    const { error: ue } = await db.from('winback_grants').update({ grant_status: 'granted', granted_at: grantedAt, expires_at: expires }).eq('id', r.id)
    if (ue) { console.error('winback: CREDIT ADDED BUT ROW NOT STAMPED', r.id, ue.message); res.grant.stamp_errors++; continue }
    res.grant.granted++
    // email
    if (!emailable(c!, supp)) {
      await db.from('winback_grants').update({ email_status: 'skipped', email_error: 'no email consent / unmailable' }).eq('id', r.id)
      res.email.skipped++; continue
    }
    await db.from('winback_grants').update({ email_status: 'sending' }).eq('id', r.id)
    const name = [c!.first_name_cache, c!.last_name_cache].filter(Boolean).join(' ').trim() || null
    const e = await sendEmail(norm(c!.email_cache), name, emailMsg(firstName(c!.first_name_cache), r.amount, until), c!.id)
    await db.from('winback_grants').update(e.ok
      ? { email_status: 'sent', email_sent_at: new Date().toISOString() }
      : { email_status: 'failed', email_error: e.error }).eq('id', r.id)
    e.ok ? res.email.sent++ : res.email.failed++
  }
}

async function doSms(rows: Row[], res: any) {
  if (!rows.length) return
  const ids = rows.map(r => r.customer_id)
  const [cm, last] = await Promise.all([customers(ids), lastOrderAt(ids)])
  for (const r of rows) {
    const c = cm.get(r.customer_id)
    const { data: claimed } = await db.from('winback_grants').update({ sms_status: 'sending' })
      .eq('id', r.id).eq('sms_status', 'pending').select('id')
    if (!claimed?.length) { res.sms.raced++; continue }
    const lo = last.get(r.customer_id)
    const skip = !c ? 'customer not found' : (lo && r.granted_at && Date.parse(lo) >= Date.parse(r.granted_at)) ? 'already booked'
      : !textable(c) ? 'no valid phone / opted out' : null
    if (skip) { await db.from('winback_grants').update({ sms_status: 'skipped', sms_error: skip }).eq('id', r.id); res.sms.skipped++; continue }
    const s = await sendSms(e164(c!.phone_cache)!, smsMsg(firstName(c!.first_name_cache), r.amount, day(r.expires_at!)), c!.id)
    await db.from('winback_grants').update(s.ok
      ? { sms_status: 'sent', sms_sent_at: new Date().toISOString() }
      : { sms_status: 'failed', sms_error: s.error }).eq('id', r.id)
    s.ok ? res.sms.sent++ : res.sms.failed++
  }
}

async function doExpire(rows: Row[], res: any) {
  for (const r of rows) {
    // claim first so two overlapping runs can never both remove credit
    const { data: claimed, error: ce } = await db.from('winback_grants').update({ expired_at: new Date().toISOString() })
      .eq('id', r.id).is('expired_at', null).select('id')
    if (ce) throw new Error('claim expire: ' + ce.message)
    if (!claimed?.length) continue
    // Customers were enrolled with $0 credit, so credit used since the grant came out of the win-back first.
    // Net of credit refunded back from a cancelled/refunded order (credit_refund).
    const { data: uses, error: ue } = await db.from('customer_transactions').select('type, amount')
      .eq('customer_id', r.customer_id).in('type', ['credit_use', 'credit_refund']).gte('created_at', r.granted_at!)
    if (ue) throw new Error('customer_transactions: ' + ue.message)
    const used = Math.max(0, (uses || []).reduce((s: number, u: any) =>
      s + (u.type === 'credit_use' ? 1 : -1) * Math.abs(Number(u.amount || 0)), 0))
    const { data: cust, error: cerr } = await db.from('customers').select('credits').eq('id', r.customer_id).maybeSingle()
    if (cerr) throw new Error('customers: ' + cerr.message)
    const remove = Math.max(0, Math.min(Number(r.amount) - used, Number(cust?.credits || 0)))
    let actual = 0
    if (remove > 0) {
      const { data, error } = await db.rpc('adjust_customer_credits', {
        p_customer_id: r.customer_id, p_amount: Math.round(remove * 100) / 100, p_type: 'credit_remove',
        p_note: `Win-back ${r.batch}: unused credit expired`, p_actor_name: 'Win-back',
      })
      if (error) {
        // release the claim so the next run retries
        await db.from('winback_grants').update({ expired_at: null }).eq('id', r.id)
        res.expire.failed++; console.error('winback expire failed', r.id, error.message); continue
      }
      actual = Number((data as any)?.actual || 0)
    }
    await db.from('winback_grants').update({ expired_amount: actual }).eq('id', r.id)
    res.expire.done++; res.expire.removed = Math.round((res.expire.removed + actual) * 100) / 100
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────
async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
  return !!data?.secret && provided === data.secret
}

Deno.serve(async (req) => {
  try {
    if (!(await isInternalCall(req))) return json({ error: 'forbidden' }, 403)
    if (!SG_KEY) return json({ error: 'SENDGRID_API_KEY not set' }, 500)
    const body = await req.json().catch(() => ({}))
    const mode = body.mode || 'dryrun'

    if (mode === 'test') {
      const until = day(new Date(Date.now() + EXPIRES_DAYS * DAY).toISOString())
      const out: any = { mode, until }
      if (body.email) {
        const to = norm(body.email)
        if (!EMAIL_RE.test(to) || !TEST_EMAIL_ALLOW.test(to)) return json({ error: 'test email only goes to staff addresses' }, 400)
        out.email = await sendEmail(to, 'David', emailMsg('David', 20, until))
      }
      if (body.phone) {
        const to = e164(body.phone)
        const { data: staff } = await db.from('profiles').select('phone, role').in('role', ['admin', 'manager'])
        const ok = !!to && (staff || []).some((p: any) => e164(p.phone) === to)
        if (!ok) return json({ error: 'test text only goes to an admin/manager phone on file' }, 400)
        out.sms = await sendSms(to!, smsMsg('David', 20, until))
      }
      return json(out)
    }

    const p = await plan()
    const summary: any = { mode, grants_due: p.grants.length, sms_due: p.sms.length, expire_due: p.expire.length }
    if (p.grants.length > ANOMALY || p.sms.length > ANOMALY || p.expire.length > ANOMALY) {
      console.error('winback: refused, backlog looks wrong', summary)
      return json({ ...summary, refused: true, reason: `more than ${ANOMALY} rows due in one step` }, 409)
    }
    if (mode !== 'tick') return json(summary)

    const res = {
      grant: { granted: 0, skipped: 0, failed: 0, raced: 0, stamp_errors: 0 },
      email: { sent: 0, skipped: 0, failed: 0 },
      sms: { sent: 0, skipped: 0, failed: 0, raced: 0 },
      expire: { done: 0, failed: 0, removed: 0 },
    }
    await doGrants(p.grants.slice(0, GRANT_CAP), res)
    await doSms(p.sms.slice(0, SMS_CAP), res)
    await doExpire(p.expire.slice(0, EXPIRE_CAP), res)
    summary.result = res
    console.log('winback tick', JSON.stringify(res))
    return json(summary)
  } catch (e: any) {
    console.error('winback error:', e?.message || e)
    return json({ error: e?.message || String(e) }, 500)
  }
})
