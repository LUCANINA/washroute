import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

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
      .update({ status: 'failed', error_message: msg })
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

  // Everything currently not posted, so one call answers "is any payout missing
  // from Xero right now?" without a second query.
  const { data: outstanding } = await supa
    .from('xero_payout_syncs')
    .select('stripe_payout_id, payout_amount, payout_arrival_date, status, error_message')
    .neq('status', 'posted')
    .order('payout_arrival_date', { ascending: true })

  const totalMissing = (outstanding || []).reduce((s: number, r: any) => s + Number(r.payout_amount || 0), 0)

  return new Response(JSON.stringify({
    ok: true,
    stale_minutes: staleMinutes,
    newly_marked_failed: marked.length,
    marked,
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
