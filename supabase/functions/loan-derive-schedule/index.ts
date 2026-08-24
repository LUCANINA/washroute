import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { ensureUpcomingSplit } from "../_shared/staging-next.ts"
import {
  collapseDuplicateBalances, buildPeriods, classifyPeriods, chooseFit, projectRows, recurringPayment,
  r2, daysBetween, type Period, type Fit,
} from "../_shared/rate-fit.ts"

// loan-derive-schedule — v1 (session 230)
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

const REAL_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']
const MAX_PROJECTED_PERIODS = 240
const num = (v: any): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function todayPacific(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).toISOString().slice(0, 10)
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
    const enableStaging = body.enable_staging === true
    const maxResidual = num(body.max_residual) ?? 0.05
    const minPeriods = num(body.min_periods) ?? 4
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
    if (loan.status !== 'active') {
      return new Response(JSON.stringify({ error: `This loan is ${loan.status} -- there is nothing left to project.` }), { status: 409, headers: cors })
    }

    const today = todayPacific()

    // ── 1. Real statements only ──────────────────────────────────────────────
    // xero_derived rows are OUR OWN ledger. Fitting a lender's rate to our ledger
    // would be self-referential: it would "confirm" whatever we already booked,
    // including any error. Only what the lender itself said counts as evidence.
    const { data: rawStmts } = await supa.from('loan_statements')
      .select('id, statement_date, principal_balance, total_amount_due, source, balance_basis')
      .eq('loan_account_id', loan.id)
      .in('source', REAL_SOURCES)
      .not('principal_balance', 'is', null)
      .lte('statement_date', today)
      .order('statement_date', { ascending: true })
    const stmts = collapseDuplicateBalances((rawStmts || []).filter((s: any) => s.balance_basis !== 'total_payback'))
    if (stmts.length < minPeriods + 1) {
      return new Response(JSON.stringify({
        ok: false, reason: 'not_enough_statements',
        message: `This loan has ${stmts.length} distinct lender balances on file; at least ${minPeriods + 1} are needed to measure a rate. Upload more statements or a transaction history.`,
        statements_on_file: stmts.length,
      }), { headers: cors })
    }

    // ── 2. Periods, and which of them are usable evidence ────────────────────
    // The arithmetic lives in _shared/rate-fit.ts so it can be replayed offline
    // against every loan's real history -- see tests/rate-fit-harness.ts.
    const allPeriods: Period[] = buildPeriods(stmts, num(loan.scheduled_monthly_payment))
    if (!allPeriods.length) {
      return new Response(JSON.stringify({ ok: false, reason: 'no_periods', message: 'No usable statement-to-statement periods -- no payment amount is known for any of them.' }), { headers: cors })
    }
    const { clean, excluded, medianDays } = classifyPeriods(allPeriods)
    if (clean.length < minPeriods) {
      return new Response(JSON.stringify({
        ok: false, reason: 'not_enough_clean_periods',
        message: `Only ${clean.length} of ${allPeriods.length} periods are ordinary payment periods; ${minPeriods} are needed. The rest are listed below -- usually a missing statement or an extra principal payment.`,
        clean_periods: clean.length, excluded,
      }), { headers: cors })
    }

    // ── 3. Fit both conventions; the better one wins ─────────────────────────
    const { best, runnerUp } = chooseFit(clean)
    const passes = best.residual <= maxResidual

    const fitReport = {
      chosen: best.model, annual_rate_percent: best.annual, periodic_rate: best.periodic,
      periods_fitted: best.periods, worst_error_dollars: r2(best.residual),
      passes_gate: passes, gate_max_residual: maxResidual,
      contract_rate_on_file: num(loan.interest_rate),
      runner_up: { model: runnerUp.model, worst_error_dollars: r2(runnerUp.residual) },
      per_period: best.errors,
      excluded_periods: excluded,
    }

    if (!passes) {
      return new Response(JSON.stringify({
        ok: false, reason: 'fit_not_good_enough',
        message: `The best fit for this loan is ${best.model.replace(/_/g, ' ')} at ${best.annual.toFixed(3)}%, but it misses the lender's own figures by as much as $${r2(best.residual).toFixed(2)}. That is an estimate, not a measurement, so no schedule was derived. A staged transaction wrong by that much is worse than none.`,
        fit: fitReport,
      }), { headers: cors })
    }

    // ── 4. Project forward from the last real balance ────────────────────────
    // The ANCHOR is the newest real statement, not the newest DISTINCT balance:
    // collapseDuplicateBalances exists to keep the fit honest, but E4 -9744's balance
    // has not moved since May (it is paid ahead), so anchoring on the collapsed
    // series would project from three months ago and emit past-dated rows.
    const lastRaw = (rawStmts || []).filter((s: any) => s.balance_basis !== 'total_payback')
    const last = lastRaw[lastRaw.length - 1] ?? stmts[stmts.length - 1]
    // NOT the newest statement's total due -- that figure can be a one-off (E4 -9744's
    // newest statement says $5,000, which was an extra principal payment, and
    // projecting from it produced a schedule of $5,000 monthly instalments).
    const payment = recurringPayment(clean, num(loan.scheduled_monthly_payment))!
    const monthly = medianDays >= 26 && medianDays <= 32
    const maturity: string | null = loan.maturity_date ? String(loan.maturity_date).slice(0, 10) : null

    const projected = projectRows({
      anchorDate: last.statement_date, anchorBalance: Number(last.principal_balance),
      payment, fit: best, medianDays, maturity, maxPeriods: MAX_PROJECTED_PERIODS,
    })
    // If the projection runs into the maturity date with real money still owed, the
    // maturity on file is probably wrong. Say so rather than quietly truncating: a
    // schedule that stops early stops producing staging cards, silently.
    const endsShort = projected.length && Number(projected[projected.length - 1].balance) > 1
      ? { stopped_at: projected[projected.length - 1].row_date, balance_remaining: projected[projected.length - 1].balance,
          note: `The projection reached this loan's maturity date on file (${maturity}) with ${projected[projected.length - 1].balance.toFixed(2)} still outstanding, so the maturity date is probably wrong. Staging still works; the schedule just runs out early.` }
      : null
    const futureRows = projected.filter((r) => r.row_date >= today)

    if (!confirm) {
      return new Response(JSON.stringify({
        ok: true, dry_run: true, wrote_nothing: true,
        loan: { id: loan.id, name: loan.xero_account_name, lender: loan.lender },
        fit: fitReport,
        anchor: { statement_date: last.statement_date, balance: Number(last.principal_balance), payment },
        cadence: monthly ? 'monthly' : `every ~${medianDays} days`,
        projected_periods: projected.length, future_periods: futureRows.length, ends_short: endsShort,
        first_future_rows: futureRows.slice(0, 3),
      }), { headers: cors })
    }

    // ── 5. Write ─────────────────────────────────────────────────────────────
    // A new schedule row every time, never an edit of an old one: staging-next
    // already picks the newest schedule that still has future rows, and a derived
    // schedule is only ever as good as the statement it was anchored to. Keeping
    // the old ones makes every re-derivation auditable, and means no row that a
    // split already points at is ever deleted.
    const storagePath = `derived://loan-derive-schedule/${loan.id}/${today}`
    const { data: sched, error: schedErr } = await supa.from('loan_amortization_schedules').insert({
      loan_account_id: loan.id,
      amort_type: `derived_${best.model}`,
      schedule_generated_date: today,
      storage_path: storagePath,
      source: 'derived_from_statements',
      uploaded_by: `loan-derive-schedule (${userData.user.email ?? role})`,
      balance_basis: 'principal_only',
    }).select('id').single()
    if (schedErr || !sched) {
      return new Response(JSON.stringify({ error: 'Could not create the derived schedule', details: schedErr?.message }), { status: 500, headers: cors })
    }
    const { error: rowsErr } = await supa.from('loan_amortization_rows')
      .insert(projected.map((r) => ({ ...r, schedule_id: sched.id })))
    if (rowsErr) {
      return new Response(JSON.stringify({ error: 'Could not write the projected rows', details: rowsErr.message, schedule_id: sched.id }), { status: 500, headers: cors })
    }

    const acctPatch: Record<string, any> = {
      rate_model: best.model,
      fitted_periodic_rate: best.periodic,
      fitted_annual_rate: best.annual,
      rate_fit_residual: r2(best.residual),
      rate_fit_periods: best.periods,
      rate_fit_at: new Date().toISOString(),
    }
    if (enableStaging) acctPatch.prestage_enabled = true
    await supa.from('loan_accounts').update(acctPatch).eq('id', loan.id)

    // The card itself is created by the ONE function that decides which period
    // stages next -- never by a second copy of that rule living here.
    let staging: any = { skipped: 'enable_staging not requested' }
    if (enableStaging) staging = await ensureUpcomingSplit(supa, loan.id)

    return new Response(JSON.stringify({
      ok: true, dry_run: false,
      loan: { id: loan.id, name: loan.xero_account_name },
      schedule_id: sched.id, rows_written: projected.length, future_rows: futureRows.length, ends_short: endsShort,
      fit: fitReport, prestage_enabled: enableStaging, staging,
    }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
