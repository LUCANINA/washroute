// welcome-emails — WashRoute's own welcome series (replaces Klaviyo's "Email Welcome Series").
// Session 315 (2026-09-23).
//
//   Email 1  "Welcome to Family Laundry"   — to a new customer who agreed to marketing email,
//            within ~15 min of signing up (cron every 15 min).
//   Email 2  "{pct}% off your first pickup" — 3 days after email 1, ONLY if they still have no
//            order, have not already redeemed the code, and the code is still active.
//
// SAFETY
//   - Only customers created on/after GO_LIVE are ever considered. Existing customers can
//     never receive email 1 from this function.
//   - email_send_log has UNIQUE (customer_id, kind). The row is inserted BEFORE the send, so a
//     second copy of the same email is impossible even if two runs overlap.
//   - Per-run caps, plus a refusal when the eligible count looks like a bug.
//   - Consent + opt-out + email_suppressions are re-checked at send time.
//   - Every send carries the SendGrid "Marketing emails" unsubscribe group (34476).
//
// MODES  dryrun — who would get what, no sends     run — send (cron)
//        test {to} — send both templates to a staff address, no log
// AUTH   x-wr-internal header only (pg_cron). verify_jwt must be FALSE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SG_KEY = Deno.env.get('SENDGRID_API_KEY') || ''
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const GO_LIVE = '2026-09-24T00:00:00Z'      // customers created before this are never emailed here
const UNSUB_GROUP_ID = 34476                // SendGrid "Marketing emails"
const FROM = { email: 'news@news.familylaundry.com', name: 'Family Laundry' }
const REPLY_TO = { email: 'info@familylaundry.com', name: 'Family Laundry' }
const PROMO_CODE = 'LOVELAUNDRY'
const APP = 'https://app.familylaundry.com/'
const LOGO = 'https://app.familylaundry.com/assets/logo.png'
const ADDRESS = 'Family Laundry · 5215 Genoa St, Oakland, CA'
const DAY = 86_400_000
const EMAIL2_AFTER_DAYS = 3
const EMAIL2_STALE_DAYS = 14                // if the job was down, don't send a stale email 2
const EMAIL1_CAP = 25, EMAIL2_CAP = 50      // per run (every 15 min)
const ANOMALY = 150                         // more eligible than this = something is wrong
const TEST_ALLOW = /(@familylaundry\.com|^dmacquart@gmail\.com)$/i

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase()
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

// ── Templates ──────────────────────────────────────────────────────────────
function shell(inner: string, preview: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px">
<tr><td align="center" style="padding:28px 24px 8px"><a href="${APP}"><img src="${LOGO}" width="160" alt="Family Laundry" style="display:block;width:160px;height:auto;border:0"></a></td></tr>
<tr><td style="padding:8px 28px 28px;font-size:17px;line-height:1.55">${inner}</td></tr>
</table>
<p style="font-size:12.5px;line-height:1.5;color:#666;margin:16px 0 0;text-align:center">${esc(ADDRESS)}<br>
You're getting this because you signed up for Family Laundry emails. <a href="<%asm_group_unsubscribe_raw_url%>" style="color:#666">Unsubscribe</a></p>
</td></tr></table></body></html>`
}
const button = (href: string, label: string) =>
  `<p style="text-align:center;margin:28px 0 8px"><a href="${href}" style="display:inline-block;background:#ffcc33;color:#000;text-decoration:none;font-weight:700;padding:15px 36px;border-radius:50px">${esc(label)}</a></p>`

function email1(first: string) {
  const subject = "Welcome to Family Laundry — here's how it works"
  const preview = 'Your first pickup in three easy steps'
  const html = shell(`
<p>Hi ${esc(first)},</p>
<p>Thanks for signing up with Family Laundry. Here's how your first order works.</p>
<p><b>1. Schedule a pickup.</b> Book in the <a href="${APP}">app</a>, or text PICKUP to the number that texted you when you signed up. Choose a morning pickup and, in most areas, your laundry comes back clean and folded by 10 p.m. the same day.</p>
<p><b>2. Pack your laundry.</b> Any trash bag or laundry bag works for your first order. We'll return everything in a Family Laundry bag that's yours to keep. Two tall kitchen bags hold about as much as one of ours. Orders over two bags may take an extra day, and we'll let you know.</p>
<p><b>3. Leave it out when your driver texts.</b> You'll get a text about 10–15 minutes before arrival. Set your bag outside your door or on your porch.</p>
<p><b>How we clean:</b> warm wash, cold rinse, medium-heat dry. Free &amp; Clear detergent only, with no fragrance, fabric softener or bleach. Every load is sanitized with ozonated water.</p>
<p><b>Pricing:</b> <a href="${APP}?page=pricing">see current prices and our monthly plan in the app</a>.</p>
<p>Questions? Just reply to this email and a real person on our team will answer.</p>
${button(APP, 'Schedule a pickup')}`, preview)
  const text = `Hi ${first},

Thanks for signing up with Family Laundry. Here's how your first order works.

1. Schedule a pickup. Book in the app (${APP}), or text PICKUP to the number that texted you when you signed up. Choose a morning pickup and, in most areas, your laundry comes back clean and folded by 10 p.m. the same day.

2. Pack your laundry. Any trash bag or laundry bag works for your first order. We'll return everything in a Family Laundry bag that's yours to keep. Two tall kitchen bags hold about as much as one of ours. Orders over two bags may take an extra day, and we'll let you know.

3. Leave it out when your driver texts. You'll get a text about 10-15 minutes before arrival. Set your bag outside your door or on your porch.

How we clean: warm wash, cold rinse, medium-heat dry. Free & Clear detergent only, with no fragrance, fabric softener or bleach. Every load is sanitized with ozonated water.

Pricing: ${APP}?page=pricing

Questions? Just reply to this email and a real person on our team will answer.

${ADDRESS}
Unsubscribe: <%asm_group_unsubscribe_raw_url%>`
  return { subject, preview, html, text }
}

function email2(first: string, pct: number) {
  const p = `${pct}%`
  const subject = `${p} off your first pickup`
  const preview = `Use code ${PROMO_CODE} when you book`
  const link = `${APP}?promo=${PROMO_CODE}`
  const html = shell(`
<p>Hi ${esc(first)},</p>
<p>Still thinking it over? We'd love to take laundry off your list. Use code <b>${PROMO_CODE}</b> for <b>${p} off</b> your first order.</p>
<p>Book in the app, or just text PICKUP. We'll handle the rest.</p>
<p>Questions? Reply to this email and we'll help.</p>
${button(link, 'Book my first pickup')}`, preview)
  const text = `Hi ${first},

Still thinking it over? We'd love to take laundry off your list. Use code ${PROMO_CODE} for ${p} off your first order.

Book in the app (${link}), or just text PICKUP. We'll handle the rest.

Questions? Reply to this email and we'll help.

${ADDRESS}
Unsubscribe: <%asm_group_unsubscribe_raw_url%>`
  return { subject, preview, html, text }
}

// ── SendGrid ───────────────────────────────────────────────────────────────
async function send(to: string, name: string | null, kind: string, t: { subject: string; html: string; text: string }, customerId?: string) {
  const body = {
    personalizations: [{ to: [name ? { email: to, name } : { email: to }] }],
    from: FROM, reply_to: REPLY_TO, subject: t.subject,
    content: [{ type: 'text/plain', value: t.text }, { type: 'text/html', value: t.html }],
    asm: { group_id: UNSUB_GROUP_ID },
    categories: [kind],
    custom_args: customerId ? { customer_id: customerId, kind } : { kind },
  }
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', headers: { 'Authorization': `Bearer ${SG_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (r.status === 202) return { ok: true, id: r.headers.get('x-message-id') }
  const txt = await r.text().catch(() => '')
  return { ok: false, error: `${r.status} ${txt.slice(0, 300)}` }
}

// ── Eligibility ────────────────────────────────────────────────────────────
type Cust = { id: string; email_cache: string | null; first_name_cache: string | null; last_name_cache: string | null
  email_marketing_consent_at: string | null; email_marketing_opt_out_at: string | null; created_at: string }
const CUST_COLS = 'id, email_cache, first_name_cache, last_name_cache, email_marketing_consent_at, email_marketing_opt_out_at, created_at'

async function suppressed(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < emails.length; i += 100) {
    const { data, error } = await db.from('email_suppressions').select('email').in('email', emails.slice(i, i + 100))
    if (error) throw new Error('email_suppressions: ' + error.message)
    for (const r of data || []) out.add(norm((r as any).email))
  }
  return out
}
const mailable = (c: Cust, supp: Set<string>) => {
  const e = norm(c.email_cache)
  return !!c.email_marketing_consent_at && !c.email_marketing_opt_out_at && EMAIL_RE.test(e)
    && !/\+app\.starchup\.com@/i.test(e) && !supp.has(e)
}

async function planEmail1(): Promise<Cust[]> {
  const { data, error } = await db.from('customers').select(CUST_COLS)
    .gte('created_at', GO_LIVE).not('email_marketing_consent_at', 'is', null).is('email_marketing_opt_out_at', null)
    .not('email_cache', 'is', null).order('created_at', { ascending: true }).limit(1000)
  if (error) throw new Error('customers: ' + error.message)
  const custs = (data || []) as Cust[]
  if (!custs.length) return []
  const done = new Set<string>()
  for (let i = 0; i < custs.length; i += 100) {
    const { data: logs, error: le } = await db.from('email_send_log').select('customer_id')
      .eq('kind', 'welcome_1').in('customer_id', custs.slice(i, i + 100).map(c => c.id))
    if (le) throw new Error('email_send_log: ' + le.message)
    for (const l of logs || []) done.add((l as any).customer_id)
  }
  const supp = await suppressed(custs.map(c => norm(c.email_cache)))
  return custs.filter(c => !done.has(c.id) && mailable(c, supp))
}

async function planEmail2(): Promise<{ list: Cust[]; pct: number | null; reason?: string }> {
  const { data: disc } = await db.from('discounts').select('value, active, deleted_at, type')
    .eq('name', PROMO_CODE).maybeSingle()
  if (!disc || !disc.active || disc.deleted_at || disc.type !== 'percent') return { list: [], pct: null, reason: `${PROMO_CODE} not active` }
  const pct = Number(disc.value)
  const now = Date.now()
  const { data: firsts, error } = await db.from('email_send_log').select('customer_id, sent_at')
    .eq('kind', 'welcome_1').eq('status', 'sent')
    .lte('sent_at', new Date(now - EMAIL2_AFTER_DAYS * DAY).toISOString())
    .gte('sent_at', new Date(now - EMAIL2_STALE_DAYS * DAY).toISOString()).limit(1000)
  if (error) throw new Error('email_send_log: ' + error.message)
  const ids = (firsts || []).map((r: any) => r.customer_id)
  if (!ids.length) return { list: [], pct }
  const { data: seconds } = await db.from('email_send_log').select('customer_id').eq('kind', 'welcome_2').in('customer_id', ids)
  const already = new Set((seconds || []).map((r: any) => r.customer_id))
  const todo = ids.filter(id => !already.has(id))
  if (!todo.length) return { list: [], pct }
  const [{ data: custs, error: ce }, { data: orders, error: oe }, { data: reds, error: re }] = await Promise.all([
    db.from('customers').select(CUST_COLS).in('id', todo),
    db.from('orders').select('customer_id').in('customer_id', todo).not('status', 'in', '(cancelled,skipped)'),
    db.from('discount_redemptions').select('customer_id, discounts!inner(name)').in('customer_id', todo).eq('discounts.name', PROMO_CODE),
  ])
  if (ce || oe || re) throw new Error('plan email 2: ' + (ce || oe || re)!.message)
  const ordered = new Set((orders || []).map((r: any) => r.customer_id))
  const redeemed = new Set((reds || []).map((r: any) => r.customer_id))
  const supp = await suppressed(((custs || []) as Cust[]).map(c => norm(c.email_cache)))
  const list = ((custs || []) as Cust[]).filter(c => !ordered.has(c.id) && !redeemed.has(c.id) && mailable(c, supp))
  return { list, pct }
}

// ── Send one, logging first ────────────────────────────────────────────────
async function sendLogged(c: Cust, kind: 'welcome_1' | 'welcome_2', t: { subject: string; html: string; text: string }) {
  const email = norm(c.email_cache)
  const { data: row, error } = await db.from('email_send_log')
    .insert({ customer_id: c.id, kind, email, status: 'sending' }).select('id').single()
  if (error) {
    if ((error as any).code === '23505') return 'duplicate'     // already sent/sending — never twice
    throw new Error(`log insert failed (${kind}): ${error.message} — nothing sent`)
  }
  const name = [c.first_name_cache, c.last_name_cache].filter(Boolean).join(' ').trim() || null
  const r = await send(email, name, kind, t, c.id)
  const { error: ue } = await db.from('email_send_log').update(r.ok
    ? { status: 'sent', sent_at: new Date().toISOString(), sendgrid_message_id: r.id }
    : { status: 'failed', error: r.error }).eq('id', row.id)
  if (ue) console.error('welcome-emails: log update failed', row.id, ue.message)
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
    if (!SG_KEY) return json({ error: 'SENDGRID_API_KEY not set' }, 500)
    const body = await req.json().catch(() => ({}))
    const mode = body.mode || 'dryrun'

    if (mode === 'test') {
      const to = norm(body.to)
      if (!EMAIL_RE.test(to) || !TEST_ALLOW.test(to)) return json({ error: 'test sends only go to staff addresses' }, 400)
      const { data: disc } = await db.from('discounts').select('value').eq('name', PROMO_CODE).maybeSingle()
      const first = String(body.first_name || 'David')
      const a = await send(to, first, 'welcome_test', email1(first))
      const b = await send(to, first, 'welcome_test', email2(first, Number(disc?.value || 15)))
      return json({ mode, to, email1: a, email2: b })
    }

    const e1 = await planEmail1()
    const e2 = await planEmail2()
    const summary: any = {
      mode, go_live: GO_LIVE,
      email1_eligible: e1.length, email2_eligible: e2.list.length, email2_pct: e2.pct, email2_note: e2.reason || null,
      sample1: e1.slice(0, 3).map(c => norm(c.email_cache)), sample2: e2.list.slice(0, 3).map(c => norm(c.email_cache)),
    }
    if (e1.length > ANOMALY || e2.list.length > ANOMALY) {
      console.error('welcome-emails: refused, eligible count looks wrong', summary)
      return json({ ...summary, refused: true, reason: `more than ${ANOMALY} eligible — check GO_LIVE / data before sending` }, 409)
    }
    if (mode !== 'run') return json(summary)

    const res = { welcome_1: { sent: 0, failed: 0, duplicate: 0 }, welcome_2: { sent: 0, failed: 0, duplicate: 0 } } as any
    for (const c of e1.slice(0, EMAIL1_CAP)) {
      const first = (c.first_name_cache || '').trim() || 'there'
      res.welcome_1[await sendLogged(c, 'welcome_1', email1(first))]++
    }
    if (e2.pct) for (const c of e2.list.slice(0, EMAIL2_CAP)) {
      const first = (c.first_name_cache || '').trim() || 'there'
      res.welcome_2[await sendLogged(c, 'welcome_2', email2(first, e2.pct))]++
    }
    summary.result = res
    if (res.welcome_1.sent || res.welcome_2.sent || res.welcome_1.failed || res.welcome_2.failed)
      console.log('welcome-emails run', JSON.stringify(res))
    return json(summary)
  } catch (e: any) {
    console.error('welcome-emails error:', e?.message || e)
    return json({ error: e?.message || String(e) }, 500)
  }
})
