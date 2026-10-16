import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { fetchAllPaged } from "../_shared/paged-select.ts"
import { perBagCost, planCost, subscriberVariant, money, addMonths, type Prices, type Usage } from "../_shared/savings-math.ts"

// Session 346 — monthly savings emails.
// AUTH  x-wr-internal header only (pg_cron + manual runs from SQL). verify_jwt FALSE.
//
// POST body:
//   { mode: 'subscribers' }            day-before-renewal summaries. With scheduled:true it only
//                                      acts when it is 3 pm in Oakland (cron fires at 22:05 and
//                                      23:05 UTC so DST never matters).
//   { mode: 'perbag' }                 "you could have saved" pilot, previous calendar month.
//                                      With scheduled:true only on the 1st (Pacific).
//   dry_run: true                      compute + return, send nothing, write nothing
//   test_to: 'someone@…'               send each email to this address instead (is_test rows,
//                                      no once-per-period claim). Combine with limit.
//   limit: n                           at most n emails this run
//   for_date: 'YYYY-MM-DD'             subscribers: pretend today is this Pacific date
//
// Every real send BCCs info@ (David, Oct 15) and is claimed in savings_email_sends BEFORE sending,
// so a retry or a second cron firing can never email a customer twice for the same period.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const TZ = 'America/Los_Angeles'
const BCC = 'info@familylaundry.com'
const APP = 'https://app.familylaundry.com'
const APP_PLAN = 'https://app.familylaundry.com/?plan=1'   // opens Account → Subscription
const PILOT = 'perbag-2026-11'
const PILOT_SIZE = 20
const COUNTED = ['picked_up', 'processing', 'folding', 'ready_for_delivery', 'out_for_delivery', 'delivered', 'delivery_failed']

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const ptDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ })
const ptHour = (d: Date) => Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }))
const fmtShort = (d: Date | string) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })
const fmtLong  = (d: Date | string) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })
const esc = (t: string) => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const lbsTxt = (n: number) => (Math.round(n * 10) / 10).toString()

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
  return !!data?.secret && provided === data.secret
}

// Prices come from the live price tables, never typed in here (CLAUDE.md).
async function loadPrices(): Promise<Prices> {
  const { data: svc } = await db.from('services').select('base_price')
    .eq('pricelist', 'Delivery').eq('is_active', true).eq('is_addon', false).eq('pricing_type', 'per_bag')
    .order('sort_order').limit(1).maybeSingle()
  const { data: fee } = await db.from('service_fees').select('amount')
    .eq('is_active', true).eq('category', 'Delivery').is('pricelist', null).gt('amount', 0).limit(1).maybeSingle()
  const { data: plan } = await db.from('subscription_plans').select('price_monthly, weight_limit_lbs, overage_price_per_lb')
    .eq('is_active', true).order('price_monthly').limit(1).maybeSingle()
  const p = {
    perBag: Number(svc?.base_price), deliveryFee: Number(fee?.amount), planPrice: Number(plan?.price_monthly),
    planLbs: Number(plan?.weight_limit_lbs), overagePerLb: Number(plan?.overage_price_per_lb),
  }
  for (const [k, v] of Object.entries(p)) if (!(v > 0)) throw new Error(`price lookup failed: ${k}=${v}`)
  return p
}

// ── shared email shell (same look as the approved mockups) ────────────────────
const stat = (v: string, label: string) =>
  `<td width="33%" style="border:1px solid #eceef2;border-radius:8px;padding:10px 4px;text-align:center;"><div style="font-size:20px;font-weight:700;color:#111827;">${v}</div><div style="font-size:11.5px;color:#6b7280;">${label}</div></td>`
const stats = (cells: string[]) =>
  `<table width="100%" cellpadding="0" cellspacing="6" style="margin:4px 0 14px;"><tr>${cells.join('')}</tr></table>`
const row = (l: string, v: string, style = '') =>
  `<tr><td style="padding:7px 0;border-bottom:1px solid #f1f2f5;font-size:13.5px;${style}">${l}</td><td align="right" style="padding:7px 0;border-bottom:1px solid #f1f2f5;font-size:13.5px;font-weight:600;white-space:nowrap;${style}">${v}</td></tr>`
const headRow = (l: string) =>
  `<tr><td colspan="2" style="padding:14px 0 4px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#9ca3af;">${l}</td></tr>`
const hero = (k: string, v: string, s: string, pink = false) =>
  `<div style="background:${pink ? '#fbe9ee' : '#fbf6f1'};border-radius:8px;padding:18px;margin:14px 0 16px;text-align:center;"><div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#8a8f9c;">${k}</div><div style="font-size:36px;font-weight:900;color:#1f2a4d;line-height:1.15;margin-top:4px;">${v}</div><div style="font-size:13px;color:#6b7280;margin-top:4px;">${s}</div></div>`
const note = (t: string) => `<div style="font-size:12.5px;color:#6b7280;background:#f7f8fa;border-radius:6px;padding:9px 12px;margin:12px 0;">${t}</div>`
const renew = (t: string) => `<div style="border:1px solid #f3c9d5;background:#fff8fa;border-radius:8px;padding:12px 14px;margin:16px 0;font-size:13.5px;color:#4b2a35;">${t}</div>`
const btn = (label: string, primary = true, href = APP) =>
  `<a href="${href}" style="display:inline-block;margin:4px;${primary ? 'background:#1f2a4d;color:#fff;' : 'background:#fff;color:#1f2a4d;border:1.5px solid #1f2a4d;'}text-decoration:none;font-weight:700;border-radius:999px;padding:11px 22px;font-size:14px;">${label}</a>`
const ctas = (...b: string[]) => `<div style="text-align:center;margin:18px 0 8px;">${b.join('')}</div>`

function shell(title: string, inner: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f4;padding:24px 12px;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:520px;width:100%;">
<tr><td style="background:#1f2a4d;padding:18px 26px;color:#fff;font-weight:800;letter-spacing:.06em;text-transform:uppercase;font-size:14px;">Family Laundry<div style="font-weight:500;letter-spacing:.02em;text-transform:none;color:#c9cfe3;font-size:11px;">Oakland, CA</div></td></tr>
<tr><td style="padding:22px 26px 6px;font-size:14px;line-height:1.6;color:#374151;">${inner}</td></tr>
<tr><td style="padding:18px 26px 22px;border-top:1px solid #f3f4f6;font-size:11.5px;color:#9ca3af;text-align:center;line-height:1.7;">Questions? Reply to this email or visit app.familylaundry.com<br>Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601</td></tr>
</table></td></tr></table></body></html>`
}

// ── usage for one period ──────────────────────────────────────────────────────
type PeriodUsage = Usage & { overagePaid: number, unweighed: number }
// `counted_at` = when the order counts toward a period. For subscribers that is when the plan
// counted it (the order_ready usage log — apply_subscription_usage_fn fires at ready_for_delivery),
// NOT the pickup time: a bag picked up the evening before a cycle starts and weighed the next
// morning belongs to the NEW cycle and carries its overage (Laurel, Oct 16 test email).
function usageOf(orders: any[], from: Date, to: Date): PeriodUsage {
  const u: PeriodUsage = { orders: 0, bags: 0, lbs: 0, overagePaid: 0, unweighed: 0 }
  for (const o of orders) {
    const t = new Date(o.counted_at || o.actual_pickup_at || o.pickup_window_start)
    if (t < from || t >= to || !COUNTED.includes(o.status)) continue
    u.orders++; u.bags += Number(o.total_bags || 0); u.lbs += Number(o.weight_lbs || 0)
    if (o.weight_lbs == null) u.unweighed++
    if (Array.isArray(o.line_items)) for (const li of o.line_items) if (li?.type === 'lb_overage') u.overagePaid += Number(li.amount || 0)
  }
  u.overagePaid = Math.round(u.overagePaid * 100) / 100
  return u
}

// ── subscriber summaries ──────────────────────────────────────────────────────
async function buildSubscriber(sub: any, cust: any, P: Prices) {
  const end = new Date(sub.current_period_end), start = new Date(sub.current_period_start)
  const histFrom = addMonths(start, -2)
  const orders = await fetchAllPaged('subscriber orders', (from, to) => db.from('orders')
    .select('id, status, total_bags, weight_lbs, line_items, actual_pickup_at, pickup_window_start, source')
    .eq('subscription_id', sub.id)
    .neq('source', 'walk_in')   // counter sales never use plan pounds (apply_subscription_usage_fn)
    .gte('pickup_window_start', addMonths(histFrom, -1).toISOString())
    .order('id', { ascending: true }).range(from, to))
  // When the plan counted each order (first order_ready entry in the usage log).
  const logs = await fetchAllPaged('usage log', (from, to) => db.from('subscription_usage_log')
    .select('id, order_id, created_at').eq('subscription_id', sub.id).eq('event_type', 'order_ready')
    .order('id', { ascending: true }).range(from, to))
  const countedAt: Record<string, string> = {}
  for (const l of logs) if (l.order_id && (!countedAt[l.order_id] || l.created_at < countedAt[l.order_id])) countedAt[l.order_id] = l.created_at
  for (const o of orders) (o as any).counted_at = countedAt[(o as any).id] || null

  const u = usageOf(orders || [], start, end)
  const paid = P.planPrice + u.overagePaid
  const would = perBagCost(u, P)
  const saved = Math.round((would - paid) * 100) / 100

  // Up to two earlier periods — only those the plan was running for, and not a pause month.
  const history: number[] = []
  const subStart = new Date(sub.signup_date || sub.created_at)
  for (let k = 1; k <= 2; k++) {
    const ps = addMonths(start, -k), pe = addMonths(start, -k + 1)
    if (ps.getTime() < subStart.getTime() - 86400000) break
    if (sub.pause_starts_at && ps >= new Date(sub.pause_starts_at) && ps < new Date(sub.pause_ends_at)) continue
    const hu = usageOf(orders || [], ps, pe)
    history.push(Math.round((perBagCost(hu, P) - (P.planPrice + hu.overagePaid)) * 100) / 100)
  }
  const total3 = Math.round((saved + history.reduce((a, b) => a + b, 0)) * 100) / 100
  const variant = subscriberVariant(u, saved, history)

  const first = esc(cust.first_name_cache || 'there')
  const period = `${fmtShort(start)} – ${fmtShort(new Date(end.getTime() - 1))}`
  const renewDay = fmtLong(end)
  const price = money(P.planPrice).replace('.00', '')
  const statRow = stats([stat(String(u.orders), u.orders === 1 ? 'pickup' : 'pickups'), stat(String(u.bags), u.bags === 1 ? 'bag' : 'bags'), stat(lbsTxt(u.lbs), `of ${P.planLbs} lbs`)])
  const unweighedNote = u.unweighed ? note(`We're still washing ${u.unweighed === 1 ? '1 order' : u.unweighed + ' orders'}, so ${u.unweighed === 1 ? 'its' : 'their'} weight isn't in the pounds above yet.`) : ''
  const breakdown = `<table width="100%" cellpadding="0" cellspacing="0">
    ${headRow('Without a subscription')}
    ${row(`${u.bags} ${u.bags === 1 ? 'bag' : 'bags'} × ${money(P.perBag)}`, money(u.bags * P.perBag))}
    ${row(`${u.orders} ${u.orders === 1 ? 'delivery' : 'deliveries'} × ${money(P.deliveryFee)}`, money(u.orders * P.deliveryFee))}
    ${row('Would have paid', money(would), 'border-top:2px solid #111827;font-weight:800;color:#111827;')}
    ${row('You paid (subscription' + (u.overagePaid ? ' + overage' : '') + ')', money(paid))}
  </table>`
  const renewLine = renew(`<b style="color:#7a1f3d;">We'll charge your ${price} renewal tomorrow, ${renewDay}.</b> `)

  let subject = '', inner = ''
  if (variant === 'saved') {
    subject = `You saved ${money(saved)} on laundry this month`
    inner = `Hi ${first}, here's a summary of your Family Laundry usage (${period}).
      ${hero('You saved', money(saved), 'compared with paying per bag')}${statRow}${breakdown}
      ${history.length ? note(`Last ${history.length + 1} months: you ${total3 >= 0 ? 'saved' : 'paid'} <b>${money(total3)}</b> ${total3 >= 0 ? 'in total' : 'more than per bag'}.`) : ''}
      ${unweighedNote}${renewLine.replace('</div>', 'Nothing to do if you\'d like to keep going.</div>')}${ctas(btn('Book your next pickup'))}`
  } else if (variant === 'light_month') {
    subject = `Your Family Laundry usage summary`
    inner = `Hi ${first}, here's a summary of your Family Laundry usage (${period}).
      ${statRow}${breakdown}
      ${note(`This was a lighter month: paying per bag would have saved you <b>${money(-saved)}</b>.` + (history.length ? ` Over the last ${history.length + 1} months you're ${total3 >= 0 ? 'still ahead by' : 'behind by'} <b>${money(total3)}</b>.` : ''))}
      ${unweighedNote}${renewLine.replace('</div>', 'Nothing to do if you\'d like to keep going.</div>')}${ctas(btn('Book your next pickup'))}`
  } else if (variant === 'switch') {
    subject = `Your laundry this month, and a cheaper option for you`
    inner = `Hi ${first}, here's a summary of your Family Laundry usage (${period}).
      ${statRow}
      <table width="100%" cellpadding="0" cellspacing="0">${headRow('This month')}
        ${row('You paid (subscription' + (u.overagePaid ? ' + overage' : '') + ')', money(paid))}
        ${row('Pay-per-bag would have been', money(would))}
        <tr><td colspan="2" style="color:#9ca3af;font-size:12.5px;">${u.bags} ${u.bags === 1 ? 'bag' : 'bags'} × ${money(P.perBag)} + ${u.orders} ${u.orders === 1 ? 'delivery' : 'deliveries'} × ${money(P.deliveryFee)}</td></tr></table>
      ${hero("You'd have saved", money(-total3), `by paying per bag over the last ${history.length + 1} months`, true)}
      We want you on the option that costs you least. Based on how you've used Family Laundry lately, paying per bag would save you money, with the same service and pickup windows.
      ${unweighedNote}${renew(`<b style="color:#7a1f3d;">We'll charge your ${price} renewal tomorrow, ${renewDay}.</b> To switch, tap the button below today and choose Cancel Subscription. You keep your plan through today, and we won't charge you tomorrow.`)}
      ${ctas(btn('Switch to pay-per-bag', true, APP_PLAN))}
      <div style="text-align:center;font-size:13px;color:#6b7280;margin-bottom:8px;">Happy with your plan? Nothing to do. It renews tomorrow as usual.</div>`
  } else {
    subject = `No pickups this month. Want to pause before tomorrow?`
    inner = `Hi ${first}, we didn't pick up any laundry from you this month (${period}).
      ${renew(`<b style="color:#7a1f3d;">We'll charge your ${price} renewal tomorrow, ${renewDay}.</b> If you're away or don't need us for a while, tap Pause my plan below today and choose Pause for one month. We won't charge you tomorrow, and your plan restarts on its own a month later.`)}
      ${ctas(btn('Pause my plan', true, APP_PLAN), btn('Book a pickup', false))}`
  }
  return {
    variant, subject, html: shell(subject, inner),
    figures: { period_start: start, period_end: end, ...u, paid, would_have_paid: would, saved, history, total3 },
  }
}

async function runSubscribers(opts: any, P: Prices) {
  const now = opts.for_date ? new Date(`${opts.for_date}T15:00:00-07:00`) : new Date()
  if (opts.scheduled && ptHour(now) !== 15) return { skipped: `not 3 pm Pacific (hour ${ptHour(now)})` }
  const tomorrow = ptDate(new Date(now.getTime() + 24 * 3600 * 1000))
  // Testing only: look at every renewal in the next N days instead of just tomorrow's.
  const wideHours = (opts.dry_run || opts.test_to) && opts.window_days ? Number(opts.window_days) * 24 : 0

  const { data: subs, error } = await db.from('subscriptions')
    .select('id, customer_id, status, current_period_start, current_period_end, cancel_at_period_end, signup_date, created_at, pause_starts_at, pause_ends_at')
    .eq('status', 'active').eq('cancel_at_period_end', false)
    .gte('current_period_end', new Date(now.getTime()).toISOString())
    .lte('current_period_end', new Date(now.getTime() + Math.max(60, wideHours) * 3600 * 1000).toISOString())
  if (error) throw new Error('subscriptions: ' + error.message)

  // Renewing tomorrow (Pacific date) and not about to start a pause (that renewal isn't charged).
  const due = (subs || []).filter((s: any) => (wideHours ? true : ptDate(new Date(s.current_period_end)) === tomorrow)
    && !(s.pause_starts_at && new Date(s.pause_starts_at).getTime() === new Date(s.current_period_end).getTime()))
  return await sendAll('subscriber_cycle', due.map((s: any) => ({ sub: s, customer_id: s.customer_id, period_key: ptDate(new Date(s.current_period_end)) })),
    async (item: any, cust: any) => buildSubscriber(item.sub, cust, P), opts)
}

// ── pay-per-bag pilot ─────────────────────────────────────────────────────────
async function perBagMonths(fromIso: string, toIso: string) {
  // Regular pay-per-bag delivery customers only (no walk-ins, no on-account / commercial).
  // Thousands of rows: PostgREST stops at 1,000 without saying so — read every page.
  const data = await fetchAllPaged('per-bag orders', (from, to) => db.from('orders')
    .select('id, customer_id, status, total_bags, weight_lbs, line_items, actual_pickup_at, pickup_window_start, source, is_subscription_order, customers!inner(pricelist, billing_type, customer_type, email_cache, first_name_cache, email_marketing_opt_out_at)')
    .eq('is_subscription_order', false).neq('source', 'walk_in')
    .gte('pickup_window_start', fromIso).lt('pickup_window_start', toIso)
    .in('status', COUNTED)
    .order('id', { ascending: true }).range(from, to))
  return (data || []).filter((o: any) => o.customers?.pricelist === 'Delivery'
    && o.customers?.billing_type !== 'on_account' && !['Commercial', 'HCEB'].includes(o.customers?.customer_type))
}

async function runPerBag(opts: any, P: Prices) {
  const now = new Date()
  if (opts.scheduled && ptDate(now).slice(8) !== '01') return { skipped: 'not the 1st (Pacific)' }
  // Previous three calendar months, Pacific.
  const [y, m] = ptDate(now).split('-').map(Number)
  const monthStart = (yy: number, mm: number) => new Date(`${new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10)}T00:00:00-08:00`)
  const bounds = [3, 2, 1, 0].map(k => monthStart(m - k <= 0 ? y - 1 : y, ((m - k - 1 + 12) % 12) + 1))
  const orders = await perBagMonths(bounds[0].toISOString(), bounds[3].toISOString())

  const per: Record<string, { cust: any, months: PeriodUsage[] }> = {}
  for (const o of orders) (per[o.customer_id] ||= { cust: o.customers, months: [] })
  for (const [cid, v] of Object.entries(per)) {
    const mine = orders.filter((o: any) => o.customer_id === cid)
    v.months = [0, 1, 2].map(i => usageOf(mine, bounds[i], bounds[i + 1]))
  }
  const savingOf = (u: PeriodUsage) => Math.round((perBagCost(u, P) - planCost(u, P)) * 100) / 100
  const qualifiers = Object.entries(per).filter(([, v]) => v.months.every(u => u.orders > 0 && savingOf(u) > 0)
    && !v.cust.email_marketing_opt_out_at && v.cust.email_cache)

  // Pilot cohort: picked once, at random, then fixed. Everyone else who qualified is the comparison group.
  let { data: pilot } = await db.from('savings_email_pilot').select('customer_id, cohort').eq('pilot', PILOT)
  if (!pilot?.length && !opts.dry_run && !opts.test_to) {
    const shuffled = qualifiers.map(([cid, v]) => ({ cid, v, r: crypto.getRandomValues(new Uint32Array(1))[0] })).sort((a, b) => a.r - b.r)
    const rows = shuffled.map((q, i) => ({ customer_id: q.cid, pilot: PILOT, cohort: i < PILOT_SIZE ? 'email' : 'control',
      figures: { months: q.v.months.map(u => ({ ...u, saving: savingOf(u) })) } }))
    const { error } = await db.from('savings_email_pilot').insert(rows)
    if (error) throw new Error('pilot insert: ' + error.message)
    pilot = rows.map(r => ({ customer_id: r.customer_id, cohort: r.cohort }))
  }
  const emailCohort = new Set((pilot || []).filter((p: any) => p.cohort === 'email').map((p: any) => p.customer_id))
  const targets = qualifiers.filter(([cid]) => opts.dry_run || opts.test_to ? true : emailCohort.has(cid))
  const periodKey = ptDate(bounds[2]).slice(0, 7)
  const monthName = bounds[2].toLocaleDateString('en-US', { timeZone: TZ, month: 'long' })

  return await sendAll('perbag_monthly', targets.map(([cid, v]) => ({ customer_id: cid, v, period_key: periodKey })), async (item: any, cust: any) => {
    const u = item.v.months[2] as PeriodUsage
    const would = perBagCost(u, P), plan = planCost(u, P), save = Math.round((would - plan) * 100) / 100
    const save3 = item.v.months.reduce((a: number, x: PeriodUsage) => a + savingOf(x), 0)
    const over = Math.max(0, u.lbs - P.planLbs)
    const subject = `You could have saved ${money(save)} on laundry last month`
    const inner = `Hi ${esc(cust.first_name_cache || 'there')}, thanks for a busy ${monthName} with Family Laundry. We looked at your orders and found a way for you to pay less.
      ${hero("On a subscription you'd have saved", money(save), `in ${monthName} · ${money(save3)} over the last 3 months`, true)}
      ${stats([stat(String(u.orders), u.orders === 1 ? 'pickup' : 'pickups'), stat(String(u.bags), u.bags === 1 ? 'bag' : 'bags'), stat(lbsTxt(u.lbs), 'lbs')])}
      <table width="100%" cellpadding="0" cellspacing="0">
        ${headRow(`Your ${monthName} at pay-per-bag prices`)}
        ${row(`${u.bags} bags × ${money(P.perBag)}`, money(u.bags * P.perBag))}
        ${row(`${u.orders} deliveries × ${money(P.deliveryFee)}`, money(u.orders * P.deliveryFee))}
        ${row('Total', money(would), 'border-top:2px solid #111827;font-weight:800;color:#111827;')}
        ${headRow('On the monthly subscription')}
        ${row(`Plan (${P.planLbs} lbs, free delivery)`, money(P.planPrice))}
        ${over > 0 ? row(`${lbsTxt(over)} extra lbs × ${money(P.overagePerLb)}`, money(over * P.overagePerLb)) : ''}
        ${row('Total', money(plan), 'border-top:2px solid #111827;font-weight:800;color:#111827;')}
      </table>
      ${note('Same service, same pickup windows. Pause or cancel anytime.')}
      ${ctas(btn('Switch to the subscription', true, APP_PLAN))}`
    return { variant: 'perbag_save', subject, html: shell(subject, inner), figures: { month: periodKey, ...u, would_have_paid: would, plan_cost: plan, saved: save, saved_3mo: save3 } }
  }, opts)
}

// ── claim → send → record ─────────────────────────────────────────────────────
async function sendAll(kind: string, items: any[], build: (item: any, cust: any) => Promise<any>, opts: any) {
  const out: any[] = []
  const seen = new Set<string>()
  let sent = 0
  for (const item of items) {
    if (opts.limit && sent >= opts.limit) break
    try {
      const { data: cust } = await db.from('customers').select('id, email_cache, first_name_cache').eq('id', item.customer_id).single()
      if (!cust?.email_cache) { out.push({ customer_id: item.customer_id, skipped: 'no email' }); continue }
      const e = await build(item, cust)
      // Testing only: one sample of each variant.
      if (opts.one_per_variant) { if (seen.has(e.variant)) continue; seen.add(e.variant) }
      if (opts.dry_run) { out.push({ customer_id: item.customer_id, variant: e.variant, subject: e.subject, figures: e.figures }); continue }

      const isTest = !!opts.test_to
      const { data: claim, error: cErr } = await db.from('savings_email_sends').insert({
        customer_id: item.customer_id, subscription_id: item.sub?.id ?? null, kind, period_key: item.period_key,
        variant: e.variant, figures: e.figures, to_email: isTest ? opts.test_to : cust.email_cache, is_test: isTest,
      }).select('id').single()
      if (cErr) {
        if (cErr.code === '23505') { out.push({ customer_id: item.customer_id, skipped: 'already sent this period' }); continue }
        throw new Error('claim: ' + cErr.message)
      }

      const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          customer_id: isTest ? null : cust.id,
          to_email: isTest ? opts.test_to : cust.email_cache,
          bcc: isTest ? undefined : BCC,
          subject: (isTest ? `[TEST · ${e.variant}] ` : '') + e.subject,
          body: e.html,
        }),
      })
      const ok = r.ok && (await r.json().catch(() => ({})))?.ok !== false
      await db.from('savings_email_sends').update(ok ? { status: 'sent', sent_at: new Date().toISOString() }
        : { status: 'failed', error: `send-email ${r.status}` }).eq('id', claim.id)
      if (!ok) throw new Error(`send-email failed (${r.status})`)
      sent++
      out.push({ customer_id: item.customer_id, variant: e.variant, sent_to: isTest ? opts.test_to : 'customer' })
    } catch (err: any) {
      console.error(`savings ${kind} ${item.customer_id}:`, err.message)
      out.push({ customer_id: item.customer_id, error: err.message })
    }
  }
  return { candidates: items.length, sent, results: out }
}

Deno.serve(async (req) => {
  if (!(await isInternalCall(req))) return json({ error: 'forbidden' }, 403)
  let opts: any = {}
  try { opts = await req.json() } catch { /* empty */ }
  if (opts.test_to && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(opts.test_to)) return json({ error: 'bad test_to' }, 400)
  if (!opts.dry_run && !opts.test_to) {
    const { data } = await db.from('settings').select('wr_environment').eq('id', 1).single()
    if (data?.wr_environment !== 'production') return json({ error: 'staging kill-switch: not production' }, 403)
  }
  try {
    const P = await loadPrices()
    const result = opts.mode === 'subscribers' ? await runSubscribers(opts, P)
      : opts.mode === 'perbag' ? await runPerBag(opts, P)
      : null
    if (!result) return json({ error: "mode must be 'subscribers' or 'perbag'" }, 400)
    console.log('savings-summary', opts.mode, JSON.stringify({ dry: !!opts.dry_run, test: !!opts.test_to, sent: (result as any).sent, candidates: (result as any).candidates }))
    return json({ mode: opts.mode, prices: P, ...result })
  } catch (e: any) {
    console.error('savings-summary error:', e.message)
    return json({ error: e.message }, 500)
  }
})
