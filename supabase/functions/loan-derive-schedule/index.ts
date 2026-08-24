import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { deriveSchedule, num } from "../_shared/derive-schedule.ts"

// loan-derive-schedule — v2 (session 230)
// v2: the projection itself moved to _shared/derive-schedule.ts, because two other
// callers need it (loan-record-principal-payment when a lump lands,
// loan-ingest-statement when a new anchor arrives) and neither can HTTP-call this
// function -- they have no user JWT. This file is now only the HTTP door: auth,
// find the loan, call the shared routine, return what it said.
// =============================================================================
// Lets a loan with NO lender-issued amortization schedule take part in pre-staging,
// by DERIVING one from the loan's own statement history.
//
// ── THE BLOCKER THIS REMOVES ─────────────────────────────────────────────────
// ensureUpcomingSplit picks the period to stage from future payment rows on a
// loan_amortization_schedules row. The four active Ford loans have none, so they
// could never stage -- not because anything about them is unsuitable, but because
// Ford does not send a schedule. Everything downstream (stage mode, WR-STAGE
// reference, never-stage-twice guards, the sweep) is indifferent to where the rows
// came from. So this function supplies the missing INPUT and changes nothing else.
//
// ── WHY THIS IS A MEASUREMENT, NOT A GUESS ───────────────────────────────────
// Fitting one daily rate per loan against real statements reproduces every Ford
// period to within ONE CENT (4140 → 8.29%, E5-4751 → 9.99%, E6-7410 → 8.99%).
// Those are clean numbers; a model that was fitting noise would not land on them.
// The stored contract rate says 9.000% for all three -- wrong for two, by $10-12 a
// period. So the measured rate is stored separately and the contract note is never
// used for posting.
//
// ── THE CONVENTION IS PER-LENDER: FIT IT, DO NOT ASSUME IT ───────────────────
// Ford accrues DAILY on the outstanding balance (actual/365). Funding Circle
// accrues a FLAT amount per period (17.41%/yr, fits to $1.41). Both BayFirst loans
// fit neither model within $85 -- their balances on file are xero_derived (our own
// ledger, so the fit would be self-referential) and SBA rates are often prime-linked.
// Both models are therefore tried, the better one wins, and NOTHING IS ENABLED when
// the residual is too large. A staged transaction that is wrong by $85 is worse than
// no staged transaction at all.
//
// ── DRY RUN BY DEFAULT ───────────────────────────────────────────────────────
// Writes nothing unless `confirm: true`. Enables staging only on `enable_staging:
// true` AND a passing gate. Never touches Xero.
//
// Body: {
//   lender_account_number?: string,   // or loan_account_id
//   loan_account_id?: string,
//   confirm?: boolean,                // default false -- dry run
//   enable_staging?: boolean,         // default false -- set prestage_enabled + make the first card
//   max_residual?: number,            // default 0.05 -- dollars
//   min_periods?: number,             // default 4
// }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors })

    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: cors })
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: userData } = await anon.auth.getUser(token)
    if (!userData?.user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: cors })
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: prof } = await supa.from('profiles').select('role').eq('id', userData.user.id).single()
    const role = prof?.role
    if (!['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: `Forbidden (role: ${role ?? 'none'})` }), { status: 403, headers: cors })
    }

    const body = await req.json().catch(() => ({}))
    const confirm = body.confirm === true
    // Reading is advisory; writing is admin/manager, same contract as every other
    // function in this module.
    if (confirm && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Writing a derived schedule requires admin or manager.' }), { status: 403, headers: cors })
    }

    let q = supa.from('loan_accounts').select('*')
    if (body.loan_account_id) q = q.eq('id', body.loan_account_id)
    else if (body.lender_account_number) q = q.eq('lender_account_number', String(body.lender_account_number))
    else return new Response(JSON.stringify({ error: 'Pass loan_account_id or lender_account_number.' }), { status: 400, headers: cors })
    const { data: loans } = await q
    const loan = loans?.[0]
    if (!loan) return new Response(JSON.stringify({ error: 'No matching loan account.' }), { status: 404, headers: cors })

    const result = await deriveSchedule(supa, loan, {
      confirm,
      enableStaging: body.enable_staging === true,
      maxResidual: num(body.max_residual) ?? undefined,
      minPeriods: num(body.min_periods) ?? undefined,
      actor: `loan-derive-schedule (${userData.user.email ?? role})`,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    })
    const status = result.ok === false && result.reason === 'loan_not_active' ? 409 : 200
    return new Response(JSON.stringify(result), { status, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
