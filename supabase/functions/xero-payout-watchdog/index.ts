import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { mayAutoRetry, retriesExhausted, MAX_AUTO_ATTEMPTS } from '../_shared/payout-retry.ts'
import { sendAlertSms, alertSmsConfigFromEnv, trimForSms } from '../_shared/alert-sms.ts'

// xero-payout-watchdog (built Aug 7, 2026)
//
// WHY THIS EXISTS. On Aug 6 the Stripe payout po_1U1FUnGACgbvEugHa2Ax5hIa
// ($5,753.10) never reached Xero. Its xero_payout_syncs row was created at
// 02:02 with status 'pending' and simply stayed there: no error_message, no
// bank transaction, nothing anywhere to notice. A whole day of revenue was
// missing and the only reason anyone found out was David spotting a gap
// between Aug 5 and Aug 7 in a Xero report.
//
// ROOT CAUSE. xero-payout-sync claims the sync row as 'pending' BEFORE it does
// the expensive part (100+ Stripe API calls to classify every balance
// transaction), then posts to Xero and flips the row to 'posted' or 'failed'.
// It runs that work in a background task:
//     processPayout(payout).catch((e) => console.error(...))
// If that task throws, the only trace is a console line that ages out of the
// log retention window. Worse, if the isolate is TERMINATED mid-flight (very
// possible given the number of API calls), even the .catch() never runs -- so
// no in-function error handling can fully close this hole. The row is stranded
// on 'pending' forever, which looks identical to 'in progress'.
//
// THE FIX. A stuck row can only be detected from outside the function that got
// killed. This watchdog runs on a schedule, finds any sync row still 'pending'
// well past the point where it could plausibly still be working, and flips it
// to 'failed' with an explicit message. That converts a silent disappearance
// into a visible, retryable failure.
//
// It deliberately does NOT retry automatically: a payout that failed for a
// real reason (an unclassified transaction, a Xero validation error) would
// just fail again, and auto-retrying financial posts without a human looking
// is how the payroll incident earlier today happened. Marking it failed and
// surfacing it is the job; a human decides whether to re-run.
//
// Body: { stale_minutes?: number }  (default 30)

const DEFAULT_STALE_MINUTES = 30

// ── SESSION 260: WHY THIS FUNCTION NOW RETRIES AND TEXTS ────────────────────
// The watchdog did its job on 2026-08-27: it turned a stranded row into a row
// marked 'failed'. And then nothing happened, because 'failed' was written into a
// table no screen reads, no alert watches, and nothing retries. The payout never
// reached Xero, the bank feed line arrived the next morning, and the unreconciled
// line got hand-coded from Xero's "suggest previous entries" -- $7,813.03 of mixed
// revenue booked entirely to 405 Delivery - Subscription Fees, found six days later
// by eye. Detecting a failure and telling nobody is the same as not detecting it.
//
// Two additions, deliberately narrow:
//
//   RETRY, but only the transient class -- failures where the Xero PRE-CHECK could
//   not answer, so nothing was posted or even classified. The standing rule that
//   this function "deliberately does NOT retry automatically" is preserved for
//   every other failure; the carve-out and its reasoning live in
//   _shared/payout-retry.ts and are unit-tested in tests/payout-recovery.test.mts.
//
//   ALERT, at any hour. health-monitor suppresses order alerts outside 8am-9pm
//   Pacific, which is right for order-rate noise and wrong here: payouts land
//   ~7pm PT and the feed line arrives next morning, so the entire useful window is
//   that same evening. A payout alert that waits until 8am arrives after the wrong
//   entry has already been created.
const MAX_RETRIES_PER_RUN = 3
const ALERT_DEDUP_HOURS = 6

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function handleRequest(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}))
  const staleMinutes = Number(body.stale_minutes) > 0 ? Number(body.stale_minutes) : DEFAULT_STALE_MINUTES
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString()

  const supa = admin()

  const { data: stuck, error } = await supa
    .from('xero_payout_syncs')
    .select('id, stripe_payout_id, payout_amount, payout_arrival_date, status, created_at')
    .eq('status', 'pending')
    .lt('created_at', cutoff)
    .order('payout_arrival_date', { ascending: true })

  if (error) {
    return new Response(JSON.stringify({ error: 'Could not read xero_payout_syncs: ' + error.message }), { status: 500 })
  }

  const marked: any[] = []
  for (const row of stuck || []) {
    // ── SESSION 241: STATE UNKNOWN IS NOT THE SAME AS MISSING ───────────────
    // This message used to assert "Nothing was posted -- this payout is currently
    // MISSING from Xero" WITHOUT ASKING XERO, and then recommend force=true,
    // which was the one flag that bypassed the only idempotency check there was.
    // A row strands on 'pending' precisely when xero-payout-sync died AFTER the
    // POST, so "still pending" is entirely consistent with the payout being
    // posted -- and following this advice put a full day's revenue in twice.
    //
    // The watchdog's job is to convert a silent disappearance into a visible
    // failure. It can do that honestly without claiming to know something it
    // never checked. (xero-payout-sync now pre-checks the Reference itself and
    // self-heals this exact row, so a re-run is safe -- but the copy must not
    // depend on the reader knowing that.)
    const msg = 'Stuck: xero-payout-sync claimed this payout at ' + row.created_at +
      ' but never recorded an outcome (still "pending" ' + staleMinutes +
      '+ minutes later). The background task threw or was terminated mid-flight. ' +
      'STATE UNKNOWN -- this payout may or may not have reached Xero, because the ' +
      'row also strands this way when the post SUCCEEDED and the row update did not. ' +
      'CHECK XERO FIRST: search bank transactions for reference "Stripe payout ' +
      row.stripe_payout_id + '". If it is there, this row just needs repairing to ' +
      "'posted' with that transaction id. If it is genuinely absent, re-send the " +
      'payout.paid webhook for ' + row.stripe_payout_id + ' from the Stripe dashboard. ' +
      'Flagged automatically by xero-payout-watchdog.'
    const { error: updErr } = await supa
      .from('xero_payout_syncs')
      // Session 260: 'unknown', NOT 'transient'. A row strands this way when the
      // isolate died -- possibly AFTER a successful POST. That state is not safe to
      // re-run on a timer's judgement, so it alerts and waits for a person, exactly
      // as this function's original design intended.
      .update({ status: 'failed', error_message: msg, failure_kind: 'unknown', next_retry_at: null })
      .eq('id', row.id)
      .eq('status', 'pending')
    if (!updErr) {
      marked.push({
        stripe_payout_id: row.stripe_payout_id,
        amount: row.payout_amount,
        arrival_date: row.payout_arrival_date,
        stuck_since: row.created_at,
      })
    }
  }

  // ── Stage 2: retry the transient failures that are due ────────────────────
  // Capped per run so a systemic Xero outage cannot turn a 30-minute cron into a
  // request flood -- and because each attempt costs a call against the same 1,000/day
  // accounting quota whose exhaustion caused this in the first place.
  const { data: retryable } = await supa
    .from('xero_payout_syncs')
    .select('id, stripe_payout_id, status, failure_kind, attempt_count, next_retry_at')
    .eq('status', 'failed')
    .eq('failure_kind', 'transient')
    .order('payout_arrival_date', { ascending: true })

  const nowD = new Date()
  const due = (retryable || []).filter((r: any) => mayAutoRetry(r, nowD)).slice(0, MAX_RETRIES_PER_RUN)
  const retried: any[] = []
  for (const row of due) {
    try {
      // The sweep authenticates with the shared internal secret; it has no user JWT.
      // xero-payout-sync re-runs its own Xero pre-check on this call, so a duplicate
      // remains impossible even if this row's state is wrong.
      const { data: secretRow } = await supa.from('wr_internal_auth').select('secret').maybeSingle()
      const res = await fetch(
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/xero-payout-sync?payout_id=${encodeURIComponent(row.stripe_payout_id)}`,
        { headers: { 'x-wr-internal': secretRow?.secret || '', 'Content-Type': 'application/json' } })
      retried.push({ stripe_payout_id: row.stripe_payout_id, attempt: (row.attempt_count ?? 0) + 1, http: res.status })
    } catch (e) {
      retried.push({ stripe_payout_id: row.stripe_payout_id, error: String((e as Error)?.message || e) })
    }
  }

  // Everything currently not posted, so one call answers "is any payout missing
  // from Xero right now?" without a second query.
  const { data: outstanding } = await supa
    .from('xero_payout_syncs')
    // failure_kind + attempt_count are load-bearing for the alert gate below --
    // retriesExhausted() reads them, and a missing column would make it silently
    // return false, which is the fail-SILENT direction. Session 245's lesson about
    // a guard that cannot verify what it suppresses applies here exactly.
    .select('stripe_payout_id, payout_amount, payout_arrival_date, status, error_message, failure_kind, attempt_count')
    .neq('status', 'posted')
    .order('payout_arrival_date', { ascending: true })

  const totalMissing = (outstanding || []).reduce((s: number, r: any) => s + Number(r.payout_amount || 0), 0)

  // ── Stage 3: tell a human, for the rows a human actually has to act on ─────
  // A transient failure still inside its retry budget is NOT alerted -- it will most
  // likely heal itself, and an alert per cron tick is how an alarm gets ignored. Once
  // the budget is spent, or the failure was never auto-retryable, it needs a person.
  const needsHuman = (outstanding || []).filter((r: any) =>
    r.status === 'failed' && (r.failure_kind !== 'transient' || retriesExhausted(r)))

  const alerts: any[] = []
  for (const row of needsHuman) {
    const dedupSince = new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000).toISOString()
    const { data: recent } = await supa.from('_health_alerts')
      .select('id')
      .eq('alert_type', 'payout_post_failed')
      .gte('created_at', dedupSince)
      .contains('context', { stripe_payout_id: row.stripe_payout_id })
      .limit(1)
      .maybeSingle()
    if (recent) { alerts.push({ stripe_payout_id: row.stripe_payout_id, suppressed: true }); continue }

    // Short and actionable. The reader is on a phone, in the evening, and the one
    // thing that must not happen next is hand-coding the bank line tomorrow morning.
    const msg = trimForSms(
      `WashRoute: Stripe payout $${Number(row.payout_amount).toFixed(2)} (${row.payout_arrival_date}) `
      + `did NOT reach Xero after ${MAX_AUTO_ATTEMPTS} tries. `
      + `Do NOT code the bank line by hand -- leave it unreconciled. ${row.stripe_payout_id}`)
    const smsResult = await sendAlertSms(msg, alertSmsConfigFromEnv((k) => Deno.env.get(k)))
    await supa.from('_health_alerts').insert({
      alert_type: 'payout_post_failed',
      severity: 'critical',
      message: msg,
      context: {
        stripe_payout_id: row.stripe_payout_id,
        amount: row.payout_amount,
        arrival_date: row.payout_arrival_date,
        failure_kind: row.failure_kind,
        twilio: smsResult,
      },
      sent_sms: smsResult.ok,
      sent_to: smsResult.ok ? (Deno.env.get('ALERT_PHONE') || '+14156085446') : null,
    })
    alerts.push({ stripe_payout_id: row.stripe_payout_id, sms: smsResult })
  }

  return new Response(JSON.stringify({
    ok: true,
    stale_minutes: staleMinutes,
    newly_marked_failed: marked.length,
    marked,
    retried,
    alerts,
    outstanding_count: (outstanding || []).length,
    // Renamed from `outstanding_total_missing_from_xero` (session 241): these rows
    // are NOT KNOWN to be missing -- nothing here asked Xero. Naming a number
    // "missing from Xero" is the same unproven claim as the message above, and it
    // is the field a human reads first.
    outstanding_total_unconfirmed_in_xero: Math.round(totalMissing * 100) / 100,
    outstanding: (outstanding || []).map((r: any) => ({
      stripe_payout_id: r.stripe_payout_id,
      amount: r.payout_amount,
      arrival_date: r.payout_arrival_date,
      status: r.status,
    })),
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const res = await handleRequest(req)
    const merged = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) merged.set(k, v)
    if (!merged.has('Content-Type')) merged.set('Content-Type', 'application/json')
    return new Response(res.body, { status: res.status, headers: merged })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
