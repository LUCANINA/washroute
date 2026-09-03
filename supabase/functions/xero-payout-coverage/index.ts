import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sendAlertSms, alertSmsConfigFromEnv, trimForSms } from '../_shared/alert-sms.ts'

// xero-payout-coverage (built Sep 3, 2026 — session 266)
//
// WHY THIS EXISTS. On 2026-07-22 a Stripe payout of $10,630.05 was never booked
// to Xero. It was not a failure. Nothing errored, nothing retried, nothing was
// flagged, and no alert fired -- because the payout never got an
// `xero_payout_syncs` row at all. The whole deposit therefore sat in
// 403 Delivery - Wash & Fold un-split for six weeks, and the Stripe Capital
// balance chain (which is written payout by payout, each one chained off the
// last) skipped a link and ran overstated from 2026-07-23 onward.
//
// ROOT CAUSE. `xero-payout-sync` has exactly two entry points: Stripe's
// `payout.paid` webhook, and a manual call naming one `payout_id`. July 2026
// predates the sync entirely -- it shipped on Aug 3 -- so July was caught up by
// hand on Aug 4 as 23 individual calls, newest-first. The list went
// 7/23 -> 7/21. A hand-typed list dropped one entry, and nothing downstream
// could tell.
//
// THE HOLE THIS CLOSES, and it is the important part. `xero-payout-watchdog`
// is a good alarm, but it can only ever inspect rows that EXIST -- it reads
// `xero_payout_syncs` and asks which rows are stuck or failed. A payout with no
// row is invisible to it, permanently. Detecting a stuck row and detecting an
// absent one are different questions, and only Stripe's own payout list can
// answer the second. So this function asks Stripe what it paid out, compares
// that to what we hold, and reports the difference.
//
// READ-ONLY BY CONSTRUCTION. There is no Xero import in this file, no write
// branch against `xero_payout_syncs`, and no call to `xero-payout-sync`. It
// reads Stripe, reads our table, and writes only an alert record. Deciding to
// book a missing payout stays a human act -- the same standing rule
// xero-payout-watchdog was built on, and for the same reason: a financial post
// made on a timer's judgement is how the payroll incident happened.
//
// Query params (or JSON body): from, to (YYYY-MM-DD), alert (default true).
// Default window: the last 45 days.

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_WINDOW_DAYS = 45
const ALERT_DEDUP_HOURS = 20

// Same derivation `xero-payout-sync`'s buildPlan() uses for
// `payout_arrival_date` (index.ts:237). It must match exactly or a payout would
// appear under one date here and another in the table, and the diff below would
// report phantom gaps. If that line ever changes, change this one in the same
// commit.
const arrivalDateOf = (p: any) => new Date(p.arrival_date * 1000).toISOString().slice(0, 10)

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const { data } = await supabase.from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch (_) {
    return false
  }
}

async function requireAdmin(req: Request) {
  const auth = req.headers.get('authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('Missing Authorization header')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired session')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (!profile || !['admin', 'manager'].includes(profile.role)) throw new Error('Admin/manager role required')
  return user
}

function isoDay(d: Date) { return d.toISOString().slice(0, 10) }

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const param = (k: string) => url.searchParams.get(k) ?? (body as any)[k]

  const today = new Date()
  const to = String(param('to') || isoDay(today))
  const from = String(param('from') || isoDay(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86400_000)))
  const alertEnabled = String(param('alert') ?? 'true') !== 'false'

  // Stripe filters on arrival_date as a unix timestamp. Take the whole of `to`
  // by reaching the end of that day, so a payout arriving on the boundary date
  // is inside the window rather than a day out of it.
  const gte = Math.floor(new Date(from + 'T00:00:00Z').getTime() / 1000)
  const lte = Math.floor(new Date(to + 'T23:59:59Z').getTime() / 1000)

  const payouts: any[] = []
  let startingAfter: string | undefined
  while (true) {
    const page = await stripe.payouts.list({
      arrival_date: { gte, lte }, limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    payouts.push(...page.data)
    if (!page.has_more) break
    startingAfter = page.data[page.data.length - 1].id
  }

  // Only a PAID payout is money that has actually landed and therefore owes a
  // Xero entry. Pending and in-transit ones are not late, they are early; failed
  // and canceled ones must never be booked at all. Counting any of them as
  // "missing" would produce a standing false alarm, and an alarm that is always
  // on is one people learn to scroll past.
  const paid = payouts.filter((p) => p.status === 'paid')
  const notYetPaid = payouts.filter((p) => p.status !== 'paid')

  // A payout that arrived TODAY may legitimately not be booked yet -- payouts
  // land around 7pm Pacific and the webhook follows within seconds, but a run
  // that happens to fall in that gap should not raise an alarm about it.
  const todayIso = isoDay(today)
  const due = paid.filter((p) => arrivalDateOf(p) < todayIso)
  const tooRecent = paid.filter((p) => arrivalDateOf(p) >= todayIso)

  const { data: rows, error: rowsErr } = await supabase
    .from('xero_payout_syncs')
    .select('stripe_payout_id, status, payout_amount, payout_arrival_date')
    .gte('payout_arrival_date', from)
    .lte('payout_arrival_date', to)
  if (rowsErr) {
    return new Response(JSON.stringify({ error: 'Could not read xero_payout_syncs: ' + rowsErr.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const byId = new Map((rows || []).map((r: any) => [r.stripe_payout_id, r]))

  // NO ROW AT ALL -- the case this function exists for, and the one nothing else
  // in the system can see.
  const missing = due
    .filter((p) => !byId.has(p.id))
    .map((p) => ({ stripe_payout_id: p.id, amount: p.amount / 100, arrival_date: arrivalDateOf(p) }))

  // A row exists but has not reached Xero. xero-payout-watchdog owns this class
  // and alerts on it already, so this function REPORTS it and does not alert --
  // two alarms on one condition is how both end up ignored. It is listed because
  // a person reading a coverage report wants one answer to "is all of it in
  // Xero?", not two half-answers.
  const notPosted = due
    .filter((p) => byId.has(p.id) && byId.get(p.id)!.status !== 'posted')
    .map((p) => ({
      stripe_payout_id: p.id, amount: p.amount / 100, arrival_date: arrivalDateOf(p),
      status: byId.get(p.id)!.status,
    }))

  // The mirror question, and worth asking: a row we hold for a payout Stripe did
  // not report in this window. Most likely a window-edge artifact rather than a
  // defect, so it is reported flatly and never alerted on.
  const stripeIds = new Set(paid.map((p) => p.id))
  const unmatchedRows = (rows || [])
    .filter((r: any) => !stripeIds.has(r.stripe_payout_id))
    .map((r: any) => ({ stripe_payout_id: r.stripe_payout_id, amount: Number(r.payout_amount), arrival_date: r.payout_arrival_date, status: r.status }))

  const missingTotal = Math.round(missing.reduce((s, m) => s + m.amount, 0) * 100) / 100

  const alerts: any[] = []
  if (alertEnabled && missing.length) {
    const dedupSince = new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000).toISOString()
    const { data: recent } = await supabase.from('_health_alerts')
      .select('id').eq('alert_type', 'payout_never_booked')
      .gte('created_at', dedupSince).limit(1).maybeSingle()
    if (recent) {
      alerts.push({ suppressed: true, reason: 'alerted within the last ' + ALERT_DEDUP_HOURS + 'h' })
    } else {
      const oldest = missing[missing.length - 1] || missing[0]
      const msg = trimForSms(
        `WashRoute: ${missing.length} Stripe payout(s) totalling $${missingTotal.toFixed(2)} `
        + `never reached Xero and have no sync record at all. Oldest ${oldest.arrival_date}. `
        + `Do NOT hand-code the bank lines. ${oldest.stripe_payout_id}`)
      const smsResult = await sendAlertSms(msg, alertSmsConfigFromEnv((k) => Deno.env.get(k)))
      await supabase.from('_health_alerts').insert({
        alert_type: 'payout_never_booked',
        severity: 'critical',
        message: msg,
        context: { window: { from, to }, missing, missing_total: missingTotal, twilio: smsResult },
        sent_sms: smsResult.ok,
        sent_to: smsResult.ok ? (Deno.env.get('ALERT_PHONE') || '+14156085446') : null,
      })
      alerts.push({ sms: smsResult, missing_count: missing.length })
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    window: { from, to },
    stripe_paid_payouts: paid.length,
    stripe_payouts_due: due.length,
    sync_rows_in_window: (rows || []).length,
    // The headline. Zero here is the whole point of the function.
    missing_count: missing.length,
    missing_total: missingTotal,
    missing,
    not_posted: notPosted,
    unmatched_sync_rows: unmatchedRows,
    excluded: {
      arrived_today_grace: tooRecent.map((p) => ({ stripe_payout_id: p.id, arrival_date: arrivalDateOf(p) })),
      not_paid: notYetPaid.map((p) => ({ stripe_payout_id: p.id, status: p.status, arrival_date: arrivalDateOf(p) })),
    },
    alerts,
  }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    // Fails CLOSED: isInternalCall returns false on a missing header, a mismatch,
    // or any throw, and requireAdmin then has to pass.
    if (!(await isInternalCall(req))) await requireAdmin(req)
    return await handleRequest(req)
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
