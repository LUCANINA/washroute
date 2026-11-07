// daily-registrations — morning email to David listing yesterday's new customer sign-ups.
// Session 2026-11-05.
//
// WHAT  One internal email (NOT to customers) at 7 am Pacific: yesterday's sign-ups with
//       source, contact, card on file and first order; 7- and 30-day totals; a by-source
//       count; and last week's sign-ups who still haven't booked.
// WHO   Recipient is hard-coded (REPORT_TO). This function never emails a customer.
// WHEN  pg_cron fires at 14:05 and 15:05 UTC. Mode "run" only sends when it is the 7 am
//       hour in Oakland, so exactly one of the two fires sends in both PDT and PST.
// MODES dryrun — returns the report JSON + HTML, sends nothing
//       run    — scheduled send (hour-gated)
//       test   — send right now, ignoring the hour gate
//       All modes accept {"date":"YYYY-MM-DD"} to report on a specific Pacific day.
// AUTH  x-wr-internal header only (pg_cron). verify_jwt must be FALSE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SG_KEY = Deno.env.get('SENDGRID_API_KEY') || ''
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const REPORT_TO = 'david@familylaundry.com'
const FROM = { email: 'reports@news.familylaundry.com', name: 'WashRoute Reports' }
const ADMIN = 'https://admin.familylaundry.com/'
const TZ = 'America/Los_Angeles'
const SEND_HOUR = 7
const DAY = 86_400_000

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

// ── Pacific date helpers ───────────────────────────────────────────────────
function pacificParts(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(d).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 }
}
// UTC instant of 00:00 Pacific on a YYYY-MM-DD date (handles PDT/PST).
function pacificMidnight(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  for (const off of [7, 8]) {
    const t = new Date(Date.UTC(y, m - 1, d, off))
    const p = pacificParts(t)
    if (p.date === date && p.hour === 0) return t
  }
  return new Date(Date.UTC(y, m - 1, d, 8))
}
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const fmtDay = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }) : ''

const SOURCE_LABEL: Record<string, string> = {
  google: 'Google', yelp: 'Yelp', instagram: 'Instagram', facebook: 'Facebook', friend_family: 'Friend / family',
  pos_walkin: 'POS walk-in', ai: 'AI assistant', other: 'Other', nextdoor: 'Nextdoor',
}
const srcLabel = (s: string | null) => s ? (SOURCE_LABEL[s] || s) : 'Not given'

// ── Data ──────────────────────────────────────────────────────────────────
type Cust = { id: string; first_name_cache: string | null; last_name_cache: string | null; email_cache: string | null
  phone_cache: string | null; address_cache: string | null; referral_source: string | null; account_type: string | null
  stripe_default_payment_method_id: string | null; card_last4: string | null; subscription_plan: string | null
  last_order_at: string | null; created_at: string }
const COLS = 'id, first_name_cache, last_name_cache, email_cache, phone_cache, address_cache, referral_source, account_type, stripe_default_payment_method_id, card_last4, subscription_plan, last_order_at, created_at'

async function customersBetween(from: Date, to: Date): Promise<Cust[]> {
  const { data, error } = await db.from('customers').select(COLS)
    .gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
    .order('created_at', { ascending: true }).limit(2000)
  if (error) throw new Error('customers: ' + error.message)
  return (data || []) as Cust[]
}

type OrderInfo = { first: string | null; last: string | null; count: number; nextStatus: string | null }
async function ordersFor(ids: string[]): Promise<Map<string, OrderInfo>> {
  const out = new Map<string, OrderInfo>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('orders').select('customer_id, created_at, status')
      .in('customer_id', ids.slice(i, i + 100)).order('created_at', { ascending: true })
    if (error) throw new Error('orders: ' + error.message)
    for (const o of (data || []) as any[]) {
      if (o.status === 'cancelled') continue
      const cur = out.get(o.customer_id) || { first: null, last: null, count: 0, nextStatus: null }
      cur.count++
      if (!cur.first) cur.first = o.created_at
      cur.last = o.created_at
      cur.nextStatus = o.status
      out.set(o.customer_id, cur)
    }
  }
  return out
}

const name = (c: Cust) => [c.first_name_cache, c.last_name_cache].filter(Boolean).join(' ') || '(no name)'
const later = (a: string | null, b: string | null) => !a ? b : !b ? a : (a > b ? a : b)

// ── Report ────────────────────────────────────────────────────────────────
async function buildReport(day: string) {
  const dayStart = pacificMidnight(day), dayEnd = pacificMidnight(addDays(day, 1))
  const wkStart = pacificMidnight(addDays(day, -6)), prevWkStart = pacificMidnight(addDays(day, -13))
  const monthStart = pacificMidnight(addDays(day, -29))

  const last30 = await customersBetween(monthStart, dayEnd)
  const prevWeek = await customersBetween(prevWkStart, wkStart)
  const yday = last30.filter(c => c.created_at >= dayStart.toISOString())
  const week = last30.filter(c => c.created_at >= wkStart.toISOString())
  const orders = await ordersFor(week.map(c => c.id))

  const bySource = new Map<string, number>()
  for (const c of week) bySource.set(srcLabel(c.referral_source), (bySource.get(srcLabel(c.referral_source)) || 0) + 1)
  const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1])

  const rows = yday.map(c => {
    const o = orders.get(c.id)
    const lastOrder = later(o?.last ?? null, c.last_order_at)
    return {
      id: c.id, name: name(c), time: fmtTime(c.created_at), source: srcLabel(c.referral_source),
      email: c.email_cache || '', phone: c.phone_cache || '', address: c.address_cache || '',
      card: !!c.stripe_default_payment_method_id, plan: c.subscription_plan || '',
      business: (c.account_type || 'individual') !== 'individual',
      orders: o?.count || 0, lastOrder, status: o?.nextStatus || null,
    }
  })
  const weekNoOrder = week.filter(c => c.created_at < dayStart.toISOString() && !orders.get(c.id) && !c.last_order_at && c.referral_source !== 'pos_walkin')
    .map(c => ({ name: name(c), signedUp: fmtDate(c.created_at), source: srcLabel(c.referral_source), phone: c.phone_cache || '', card: !!c.stripe_default_payment_method_id }))

  const weekWithOrder = week.filter(c => orders.get(c.id) || c.last_order_at).length
  return {
    day, label: fmtDay(day),
    counts: { yesterday: yday.length, week: week.length, prevWeek: prevWeek.length, month: last30.length,
      yesterdayWithCard: rows.filter(r => r.card).length, yesterdayBooked: rows.filter(r => r.orders > 0).length,
      weekBooked: weekWithOrder },
    rows, sources, weekNoOrder,
  }
}

function renderHtml(r: Awaited<ReturnType<typeof buildReport>>): string {
  const c = r.counts
  const delta = c.week - c.prevWeek
  const deltaTxt = delta === 0 ? 'same as the week before' : `${delta > 0 ? '+' : ''}${delta} vs the week before (${c.prevWeek})`
  const pct = (n: number, d: number) => d ? Math.round(100 * n / d) + '%' : '—'
  const th = 'style="text-align:left;padding:6px 8px;border-bottom:2px solid #ddd;font-size:12px;color:#555;white-space:nowrap"'
  const td = 'style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top"'
  const tile = (n: string | number, l: string) => `<td style="padding:10px 12px;background:#f4f6f8;border-radius:8px;text-align:center"><div style="font-size:24px;font-weight:bold">${n}</div><div style="font-size:12px;color:#555">${l}</div></td>`

  const signupTable = r.rows.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
<tr><th ${th}>Name</th><th ${th}>Time</th><th ${th}>Source</th><th ${th}>Contact</th><th ${th}>Card</th><th ${th}>Last order</th></tr>
${r.rows.map(x => `<tr><td ${td}><a href="${ADMIN}" style="color:#111;font-weight:bold;text-decoration:none">${esc(x.name)}</a>${x.business ? ' <span style="color:#888">(business)</span>' : ''}${x.plan ? `<br><span style="color:#888;font-size:12px">${esc(x.plan)}</span>` : ''}${x.address ? `<br><span style="color:#888;font-size:12px">${esc(x.address)}</span>` : ''}</td>
<td ${td}>${esc(x.time)}</td><td ${td}>${esc(x.source)}</td>
<td ${td}>${esc(x.phone)}${x.email ? `<br><span style="font-size:12px">${esc(x.email)}</span>` : ''}</td>
<td ${td}>${x.card ? '✅' : '—'}</td>
<td ${td}>${x.lastOrder ? `${esc(fmtDate(x.lastOrder))}${x.status ? `<br><span style="color:#888;font-size:12px">${esc(x.status)}</span>` : ''}` : '<span style="color:#b45309">None yet</span>'}</td></tr>`).join('\n')}
</table>` : '<p style="color:#555">No new sign-ups yesterday.</p>'

  const srcList = r.sources.length ? r.sources.map(([s, n]) => `${esc(s)} <b>${n}</b>`).join(' &nbsp;·&nbsp; ') : '—'
  const followUp = r.weekNoOrder.length ? `<h3 style="font-size:15px;margin:24px 0 6px">Signed up earlier this week, no order yet (${r.weekNoOrder.length})</h3>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%">
<tr><th ${th}>Name</th><th ${th}>Signed up</th><th ${th}>Source</th><th ${th}>Phone</th><th ${th}>Card</th></tr>
${r.weekNoOrder.map(x => `<tr><td ${td}>${esc(x.name)}</td><td ${td}>${esc(x.signedUp)}</td><td ${td}>${esc(x.source)}</td><td ${td}>${esc(x.phone)}</td><td ${td}>${x.card ? '✅' : '—'}</td></tr>`).join('\n')}
</table>` : ''

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#fff;font-family:Arial,Helvetica,sans-serif;color:#111">
<div style="max-width:760px;margin:0 auto;padding:20px 16px">
<h2 style="margin:0 0 4px;font-size:20px">New registrations — ${esc(r.label)}</h2>
<p style="margin:0 0 16px;color:#555;font-size:13px">Last 7 days: ${c.week} sign-ups, ${esc(deltaTxt)}.</p>
<table cellpadding="0" cellspacing="6" style="width:100%"><tr>
${tile(c.yesterday, 'Yesterday')}${tile(`${c.yesterdayWithCard}/${c.yesterday}`, 'Added a card')}${tile(c.week, 'Last 7 days')}${tile(c.month, 'Last 30 days')}${tile(pct(c.weekBooked, c.week), '7-day booked')}
</tr></table>
<h3 style="font-size:15px;margin:20px 0 6px">Yesterday's sign-ups (${c.yesterday})</h3>
${signupTable}
<p style="font-size:13px;margin:16px 0 0"><b>Where they came from (7 days):</b> ${srcList}</p>
${followUp}
<p style="font-size:11.5px;color:#888;margin:24px 0 0">Times are Pacific. "Last order" ignores cancelled orders. POS walk-ins are left out of the no-order list. Sent daily at 7 am by WashRoute (daily-registrations).</p>
</div></body></html>`
}

function renderText(r: Awaited<ReturnType<typeof buildReport>>): string {
  const c = r.counts
  return [`New registrations — ${r.label}`, `Yesterday: ${c.yesterday} (${c.yesterdayWithCard} with card) · 7 days: ${c.week} (prev ${c.prevWeek}) · 30 days: ${c.month}`, '',
    ...r.rows.map(x => `- ${x.name} · ${x.time} · ${x.source} · ${x.phone} ${x.email} · card ${x.card ? 'yes' : 'no'} · last order ${x.lastOrder ? fmtDate(x.lastOrder) : 'none yet'}`),
    '', 'Sources (7 days): ' + r.sources.map(([s, n]) => `${s} ${n}`).join(', '),
    ...(r.weekNoOrder.length ? ['', `Earlier this week, no order yet (${r.weekNoOrder.length}):`, ...r.weekNoOrder.map(x => `- ${x.name} · ${x.signedUp} · ${x.source} · ${x.phone}`)] : []),
  ].join('\n')
}

async function sendReport(subject: string, html: string, text: string) {
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST', headers: { Authorization: `Bearer ${SG_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: REPORT_TO }] }], from: FROM, subject,
      content: [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }],
      categories: ['daily-registrations'], tracking_settings: { click_tracking: { enable: false } },
    }),
  })
  if (r.status === 202) return { ok: true, id: r.headers.get('x-message-id') }
  return { ok: false, error: `${r.status} ${(await r.text().catch(() => '')).slice(0, 300)}` }
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
    const now = pacificParts(new Date())
    if (mode === 'run' && now.hour !== SEND_HOUR) return json({ ok: true, skipped: `not ${SEND_HOUR} am Pacific (hour ${now.hour})` })

    const day = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : addDays(now.date, -1)
    const report = await buildReport(day)
    const html = renderHtml(report), text = renderText(report)
    const subject = `Registrations ${report.label}: ${report.counts.yesterday} new (7-day ${report.counts.week})`
    if (mode === 'dryrun') return json({ ok: true, subject, report, html })
    if (mode !== 'run' && mode !== 'test') return json({ error: 'unknown mode' }, 400)
    if (!SG_KEY) return json({ error: 'SENDGRID_API_KEY not set' }, 500)
    const sent = await sendReport(subject, html, text)
    console.log('daily-registrations', mode, day, JSON.stringify(sent))
    return json({ ok: sent.ok, mode, subject, sent }, sent.ok ? 200 : 502)
  } catch (e: any) {
    console.error('daily-registrations error:', e)
    return json({ error: e.message }, 500)
  }
})
