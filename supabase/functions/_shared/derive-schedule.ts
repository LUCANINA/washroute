// _shared/derive-schedule.ts — session 230
// =============================================================================
// THE derive-a-schedule-from-statement-history routine. Extracted from
// loan-derive-schedule so that the three things that need it all run the SAME
// code:
//
//   1. loan-derive-schedule            — a human asking for it, dry-run first
//   2. loan-record-principal-payment   — a lump invalidates the projection
//   3. loan-ingest-statement           — a new anchor supersedes the old one
//
// The alternative was for (2) and (3) to HTTP-call (1), which needs a user JWT
// they do not have, or to reimplement the projection, which is how two copies of
// a rule start disagreeing. Same doctrine as staging-next.ts: the rule that
// decides a number lives in exactly one place.
//
// ── WHY RE-DERIVING MATTERS ──────────────────────────────────────────────────
// A derived schedule is a projection from ONE balance on ONE date. An extra
// principal payment makes every future row wrong -- each one charges interest on
// a balance that is now too high. Crucially that error is not IMPOSSIBLE, just
// wrong: principal and interest still sum to the payment, so the split invariant
// cannot catch it. It would stage and post quietly. Hence: re-derive at the
// events that move the anchor, and flag anything already staged whose numbers
// have moved (staging-guard.ts refuses to stage a card older than its evidence).

import { ensureUpcomingSplit } from "./staging-next.ts"
import {
  collapseDuplicateBalances, buildPeriods, classifyPeriods, chooseFit, projectRows, recurringPayment,
  solvePaymentAndRate, statedPayment, r2, type Period,
} from "./rate-fit.ts"

export const REAL_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']
const MAX_PROJECTED_PERIODS = 240

export const num = (v: any): number | null =>
  (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export function todayPacific(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).toISOString().slice(0, 10)
}

// A schedule this product PROJECTED, as opposed to one the lender issued. Only
// projections are re-derived automatically, and only projections are subject to
// the staleness guard: a lender's own amortization document is not invalidated by
// a new statement arriving, but our projection is.
export const isDerived = (amortType: string | null | undefined) => String(amortType ?? '').startsWith('derived_')

export interface DeriveOpts {
  confirm?: boolean
  enableStaging?: boolean
  maxResidual?: number
  minPeriods?: number
  actor?: string
  reason?: string          // why this run happened -- stored on the schedule row
}

export async function deriveSchedule(supa: any, loan: any, opts: DeriveOpts = {}): Promise<any> {
  const confirm = opts.confirm === true
  const enableStaging = opts.enableStaging === true
  const maxResidual = opts.maxResidual ?? 0.05
  const minPeriods = opts.minPeriods ?? 4
  const actor = opts.actor ?? 'loan-derive-schedule'
  const today = todayPacific()

  if (loan.status !== 'active') {
    return { ok: false, reason: 'loan_not_active', message: `This loan is ${loan.status} -- there is nothing left to project.` }
  }

  // ── 1. Real statements only ────────────────────────────────────────────────
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
  const usable = (rawStmts || []).filter((s: any) => s.balance_basis !== 'total_payback')
  const stmts = collapseDuplicateBalances(usable)
  if (stmts.length < minPeriods + 1) {
    return {
      ok: false, reason: 'not_enough_statements',
      message: `This loan has ${stmts.length} distinct lender balances on file; at least ${minPeriods + 1} are needed to measure a rate.`,
      statements_on_file: stmts.length,
    }
  }

  // ── 2. Periods, and which of them are usable evidence ──────────────────────
  // The payment a period is measured against, in order of how much it deserves
  // trust: what a lender statement STATES, then the figure typed onto the loan.
  // Session 230: going straight to the typed figure is what made Funding Circle
  // unfittable -- its statements mostly omit the amount due, the account said
  // $2,000.00, and the real instalment is $2,033.77. Every period's interest was
  // therefore out by $33.77 and the gate refused a loan that actually fits to a
  // cent. A typed number must never quietly stand in for the lender's own.
  const stated = statedPayment(usable)
  const fallbackPayment = stated ?? num(loan.scheduled_monthly_payment)
  const allPeriods: Period[] = buildPeriods(stmts, fallbackPayment)
  if (!allPeriods.length) {
    return { ok: false, reason: 'no_periods', message: 'No usable statement-to-statement periods -- no payment amount is known for any of them.' }
  }
  const { clean, excluded, medianDays } = classifyPeriods(allPeriods)
  if (clean.length < minPeriods) {
    return {
      ok: false, reason: 'not_enough_clean_periods',
      message: `Only ${clean.length} of ${allPeriods.length} periods are ordinary payment periods; ${minPeriods} are needed. The rest are usually a missing statement or an extra principal payment.`,
      clean_periods: clean.length, excluded,
    }
  }

  // ── 3. Fit both conventions; the better one wins ───────────────────────────
  const { best, runnerUp, regime } = chooseFit(clean, minPeriods)
  const passes = best.residual <= maxResidual

  // Independent corroboration: solve the rate AND the payment from balances alone
  // and see whether the payment we USED is the one the loan's own numbers imply.
  // On Ford 4140 the solver returns $1,180.32 -- the exact printed instalment --
  // which is real evidence the model is right. A disagreement is surfaced rather
  // than absorbed: it means the stated payment, the balances, or the model is wrong,
  // and a human should decide which.
  const solved = solvePaymentAndRate(best.model, stmts)
  const usedPayment = recurringPayment(clean, fallbackPayment)
  const paymentCheck = solved && usedPayment
    ? {
        solved_payment: solved.payment,
        payment_used: r2(usedPayment),
        stated_on_a_statement: stated,
        agrees: Math.abs(solved.payment - usedPayment) <= Math.max(0.05, usedPayment * 0.002),
        note: Math.abs(solved.payment - usedPayment) <= Math.max(0.05, usedPayment * 0.002)
          ? `The payment implied by this loan's own balances ($${solved.payment.toFixed(2)}) matches the one used ($${r2(usedPayment).toFixed(2)}).`
          : `The payment implied by this loan's own balances is $${solved.payment.toFixed(2)}, but the figure used is $${r2(usedPayment).toFixed(2)}. One of them is wrong — check the instalment on a recent statement before trusting this projection.`,
      }
    : null

  const fit = {
    chosen: best.model, annual_rate_percent: best.annual, periodic_rate: best.periodic,
    payment_check: paymentCheck,
    periods_fitted: best.periods, worst_error_dollars: r2(best.residual),
    passes_gate: passes, gate_max_residual: maxResidual,
    contract_rate_on_file: num(loan.interest_rate),
    runner_up: { model: runnerUp.model, worst_error_dollars: r2(runnerUp.residual) },
    regime: regime.breakAt
      ? { periods_used: regime.periods, periods_before_rate_change: regime.dropped,
          note: `This loan's rate changed around ${regime.breakAt}; only the ${regime.periods} periods since then were used.` }
      : { periods_used: regime.periods, periods_before_rate_change: 0, note: 'No rate change detected — the whole clean history was used.' },
    per_period: best.errors,
    excluded_periods: excluded,
  }

  if (!passes) {
    return {
      ok: false, reason: 'fit_not_good_enough',
      message: `The best fit for this loan is ${best.model.replace(/_/g, ' ')} at ${best.annual.toFixed(3)}%, but it misses the lender's own figures by as much as $${r2(best.residual).toFixed(2)}. That is an estimate, not a measurement, so no schedule was derived. A staged transaction wrong by that much is worse than none.`,
      fit,
    }
  }

  // ── 4. Project forward from the last real balance ──────────────────────────
  const last = usable[usable.length - 1] ?? stmts[stmts.length - 1]
  const payment = usedPayment!
  const monthly = medianDays >= 26 && medianDays <= 32
  const maturity: string | null = loan.maturity_date ? String(loan.maturity_date).slice(0, 10) : null

  const projected = projectRows({
    anchorDate: last.statement_date, anchorBalance: Number(last.principal_balance),
    payment, fit: best, medianDays, maturity, maxPeriods: MAX_PROJECTED_PERIODS,
  })
  const endsShort = projected.length && Number(projected[projected.length - 1].balance) > 1
    ? { stopped_at: projected[projected.length - 1].row_date, balance_remaining: projected[projected.length - 1].balance,
        note: `The projection reached this loan's maturity date on file (${maturity}) with ${projected[projected.length - 1].balance.toFixed(2)} still outstanding, so the maturity date is probably wrong. Staging still works; the schedule just runs out early.` }
    : null
  const futureRows = projected.filter((r) => r.row_date >= today)

  const anchor = { statement_date: last.statement_date, balance: Number(last.principal_balance), payment }
  if (!confirm) {
    return {
      ok: true, dry_run: true, wrote_nothing: true,
      loan: { id: loan.id, name: loan.xero_account_name, lender: loan.lender },
      fit, anchor, cadence: monthly ? 'monthly' : `every ~${medianDays} days`,
      projected_periods: projected.length, future_periods: futureRows.length, ends_short: endsShort,
      first_future_rows: futureRows.slice(0, 3),
    }
  }

  // ── 5. Write ───────────────────────────────────────────────────────────────
  // A new schedule row every time, never an edit of an old one: staging-next
  // picks the newest schedule that still has future rows, keeping every
  // re-derivation auditable and never deleting a row a split already points at.
  const { data: sched, error: schedErr } = await supa.from('loan_amortization_schedules').insert({
    loan_account_id: loan.id,
    amort_type: `derived_${best.model}`,
    schedule_generated_date: today,
    // WHICH statement this projection rests on. The staleness guard compares this
    // against the newest real statement, so a projection is stale exactly when
    // better evidence exists -- immune to same-day ordering, unlike the generation
    // date (derive at 10am, statement dated today ingested at 2pm).
    anchor_statement_date: last.statement_date,
    storage_path: `derived://loan-derive-schedule/${loan.id}/${today}`,
    source: 'derived_from_statements',
    uploaded_by: actor + (opts.reason ? ` — ${opts.reason}` : ''),
    balance_basis: 'principal_only',
  }).select('id').single()
  if (schedErr || !sched) return { ok: false, reason: 'schedule_insert_failed', message: schedErr?.message }

  const { error: rowsErr } = await supa.from('loan_amortization_rows')
    .insert(projected.map((r: any) => ({ ...r, schedule_id: sched.id })))
  if (rowsErr) return { ok: false, reason: 'rows_insert_failed', message: rowsErr.message, schedule_id: sched.id }

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

  // ── 6. Anything ALREADY staged whose numbers just moved ────────────────────
  // A staged split is a live transaction sitting in Xero. Re-deriving does not
  // and must not touch it (never edit a staged transaction behind the CPA's
  // back), but leaving it silently stale is exactly the failure this whole pass
  // exists to prevent. So: compare, and flag the ones that changed. The CPA
  // unstages and re-stages; the guard in staging-guard.ts stops it being matched
  // in the meantime.
  const staleStaged: any[] = []
  const { data: stagedSplits } = await supa.from('loan_splits')
    .select('id, period_label, principal_amount, interest_amount, total_amount')
    .eq('loan_account_id', loan.id)
    .eq('status', 'staged')
    .eq('source', 'amortization_schedule')
  for (const sp of stagedSplits || []) {
    const label = String(sp.period_label)
    const match = projected.find((r: any) => (label.length === 7 ? r.row_date.slice(0, 7) === label : r.row_date === label))
    if (!match) continue
    const moved = Math.abs(Number(sp.principal_amount) - match.principal) > 0.005
      || Math.abs(Number(sp.interest_amount) - match.interest) > 0.005
    if (!moved) continue
    staleStaged.push({
      split_id: sp.id, period_label: label,
      staged: { principal: Number(sp.principal_amount), interest: Number(sp.interest_amount) },
      now: { principal: match.principal, interest: match.interest },
    })
    await supa.from('loan_splits').update({
      stage_sweep_flag: 'stale_projection',
      review_notes: `The projection this staged transaction was built from has been superseded (re-derived ${today}${opts.reason ? ' — ' + opts.reason : ''}). Staged as principal $${Number(sp.principal_amount).toFixed(2)} / interest $${Number(sp.interest_amount).toFixed(2)}; the schedule now says principal $${match.principal.toFixed(2)} / interest $${match.interest.toFixed(2)}. Unstage and re-stage this period before matching it in Xero.`,
    }).eq('id', sp.id)
  }

  let staging: any = { skipped: 'staging not requested' }
  if (enableStaging) staging = await ensureUpcomingSplit(supa, loan.id)

  return {
    ok: true, dry_run: false,
    loan: { id: loan.id, name: loan.xero_account_name },
    schedule_id: sched.id, rows_written: projected.length, future_rows: futureRows.length,
    ends_short: endsShort, fit, anchor, prestage_enabled: enableStaging, staging,
    stale_staged: staleStaged,
  }
}

// Re-derive a loan's projection after something moved its anchor. A no-op unless
// the loan already carries a DERIVED schedule -- this never turns a loan into a
// projected one on its own, and never touches a lender-issued schedule.
export async function rederiveIfDerived(supa: any, loanId: string, reason: string): Promise<any> {
  const { data: scheds } = await supa.from('loan_amortization_schedules')
    .select('id, amort_type, schedule_generated_date')
    .eq('loan_account_id', loanId)
    .order('schedule_generated_date', { ascending: false })
    .limit(1)
  const newest = scheds?.[0]
  if (!newest || !isDerived(newest.amort_type)) return { skipped: 'no derived schedule on this loan' }

  const { data: loans } = await supa.from('loan_accounts').select('*').eq('id', loanId).limit(1)
  const loan = loans?.[0]
  if (!loan) return { skipped: 'loan not found' }

  const res = await deriveSchedule(supa, loan, {
    confirm: true,
    enableStaging: loan.prestage_enabled === true,
    actor: 'auto re-derive',
    reason,
  })
  // A failure here must never fail the caller: recording a principal payment or
  // ingesting a statement is the primary job and has already succeeded. The
  // projection simply stays stale, and the staging guard refuses to stage from
  // it -- which is the safe direction to fail in.
  return res.ok
    ? { rederived: true, schedule_id: res.schedule_id, rate: res.fit?.annual_rate_percent, stale_staged: res.stale_staged, staging: res.staging }
    : { rederived: false, reason: res.reason, message: res.message }
}
