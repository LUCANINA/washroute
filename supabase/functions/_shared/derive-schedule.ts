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
  solvePaymentAndRate, statedPayment, paymentDayOfMonth, r2, type Period,
} from "./rate-fit.ts"
import { fitScheduleRate, lenderIssuedVerdict } from "./schedule-fit.ts"
import { scheduleGoesStale } from "./schedule-provenance.ts"

export const REAL_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']

// ── THE BACKFILL TRAP ───────────────────────────────────────────────────────
// A loan_statements row whose source is 'amortization_schedule' is a BACKFILL OF a
// schedule, not a statement -- Verdant carries 85 of them, one per row of the very
// document schedule-fit.ts now measures. Fitting those as statements would dress a
// schedule up as independent balance evidence and "corroborate" the schedule with
// itself. They are outside REAL_SOURCES today; this assertion makes that deliberate
// rather than incidental, and stops the two lists growing into each other later --
// the guard sits where both paths converge, at import, so no branch can miss it.
export const SCHEDULE_BACKFILL_SOURCES = ['amortization_schedule']
for (const s of SCHEDULE_BACKFILL_SOURCES) {
  if (REAL_SOURCES.includes(s)) {
    throw new Error(`derive-schedule.ts: "${s}" is a backfill of an amortization schedule, not lender statement evidence. It must never be in REAL_SOURCES.`)
  }
}
const MAX_PROJECTED_PERIODS = 240

export const num = (v: any): number | null =>
  (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export function todayPacific(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })).toISOString().slice(0, 10)
}

// `isDerived` -- a `startsWith('derived_')` DENYLIST -- used to live here and was
// the gate on rederiveIfDerived. Removed session 270: it is the same denylist
// session 268 replaced in the staging guard, and it was the last caller. The
// question "is this a projection?" now has ONE answer for the whole module,
// `scheduleGoesStale()` in _shared/schedule-provenance.ts. Two spellings of one
// question is how the two halves came to disagree in the first place.

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
  //
  // ── SESSION 270: THE FALLBACK THIS COMMENT WARNS ABOUT WAS ON THE NEXT LINE ──
  // It read `stated ?? num(loan.scheduled_monthly_payment)`. Two defects in one
  // expression, and the second is the one nobody would have predicted:
  //
  //   1. It is the typed figure standing in for the lender's own -- exactly what
  //      the paragraph above forbids, one line below where it forbids it.
  //   2. IT IS ALSO A UNITS ERROR. The column is scheduled_MONTHLY_payment; a
  //      period here is one statement-to-statement interval, which on PayPal 2 is
  //      SEVEN DAYS. A monthly figure was handed in as the amount of a single
  //      weekly draft.
  //
  // Measured on PayPal 2, 2026-09-04: the account says $15,000.00 (a fair note --
  // the loan really does pay about $14,797 a month) and the actual draft is
  // $3,414.71 weekly. Every period's implied interest therefore came out as
  // 15,000.00 - 2,681.39 = $12,318.61, which is the first row of that run's
  // per_period output to the cent. To explain $12k of weekly interest the fitter
  // needed 1.69% PER DAY, and reported an annual rate of 618.064%. It refused to
  // write, correctly -- but it refused for "the rate does not fit" when the truth
  // was "you were never given a payment amount."
  //
  // MEASURED BEFORE REMOVING IT (2026-09-04): not one loan carrying a derived_*
  // schedule depends on this fallback. Ford x4 have 50/44/31/21 lender-stated
  // payments, both BayFirst have 6, Funding Circle has exactly 1 -- which is the
  // single row session 230 went to the trouble of preferring over its typed
  // $2,000. The only loans with none are PayPal 2, Dexter 2 and Verdant (all of
  // which carry a lender's own schedule and never derive) and Rapid and Stripe
  // (no schedule at all). So this removes a source of wrong answers and no source
  // of right ones.
  //
  // A loan with no stated payment anywhere now gets an honest refusal naming the
  // typed figure and saying why it was not used, rather than a fitted rate built
  // on it. Refusing is not a regression here: the alternative was 618%.
  const stated = statedPayment(usable)
  if (stated === null) {
    return {
      ok: false, reason: 'no_stated_payment',
      message: `No lender statement on this loan states a payment amount, so there is nothing to measure a rate against. `
        + `The loan record's typed figure${num(loan.scheduled_monthly_payment) !== null ? ` ($${num(loan.scheduled_monthly_payment)!.toFixed(2)})` : ''} is a MONTHLY note, not the amount of one payment period, and is deliberately not used here. `
        + `Upload a lender statement that carries the amount due, or -- if this lender states each payment's principal and fee outright, as PayPal does -- this loan should take its schedule from that document rather than from a fitted rate.`,
      typed_monthly_payment: num(loan.scheduled_monthly_payment),
      statements_on_file: stmts.length,
    }
  }
  const allPeriods: Period[] = buildPeriods(stmts, stated)
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

  // The day the loan DEMONSTRABLY pays, measured from the clean periods, rather than
  // the day of whichever pull happened to be newest (session 231). See
  // paymentDayOfMonth in rate-fit.ts for what this was doing wrong and to whom.
  const payDom = monthly ? paymentDayOfMonth(clean) : null
  const anchorDom = Number(String(last.statement_date).slice(8, 10))
  const domDivergence = payDom != null && payDom !== anchorDom
    ? { measured_payment_day: payDom, anchor_day: anchorDom,
        note: `This loan's own history says it pays on day ${payDom} of the month (median across ${clean.length} clean periods), but its newest statement is dated the ${anchorDom}. `
          + `The projection now follows day ${payDom}. Before this was measured, the projection inherited the anchor's day -- which on a portal pulled more than once a month is a pull date, not a payment date.` }
    : null

  const projected = projectRows({
    anchorDate: last.statement_date, anchorBalance: Number(last.principal_balance),
    payment, fit: best, medianDays, maturity, maxPeriods: MAX_PROJECTED_PERIODS,
    paymentDom: payDom,
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
      payment_day_of_month: payDom, payment_day_divergence: domDivergence,
      projected_periods: projected.length, future_periods: futureRows.length, ends_short: endsShort,
      first_future_rows: futureRows.slice(0, 3),
    }
  }

  // ── 5. Write ───────────────────────────────────────────────────────────────
  // A new schedule row every time, never an edit of an old one: staging-next
  // picks the newest schedule that still has future rows, keeping every
  // re-derivation auditable and never deleting a row a split already points at.
  //
  // ── EXCEPT WHEN THE NEW SCHEDULE SAYS THE SAME THING (session 231) ─────────
  // "Append, never edit" is right for a re-derivation that MOVED. It is wrong for
  // one that did not. Running this twice on BayFirst SBA (2026-08-24) wrote two
  // 76-row schedules with the same anchor and identical numbers -- harmless that
  // day only because they agreed. They are indistinguishable to staging-next,
  // which orders by schedule_generated_date: two schedules generated on the same
  // day are a TIE, and which one wins is arbitrary. Two agreeing schedules make
  // that harmless; a genuine same-day re-derive after a new statement would make
  // it a coin flip over which projection stages.
  //
  // So a re-derivation that reproduces an existing projection EXACTLY -- same
  // anchor, same model, same rows to the cent -- writes nothing and returns the
  // schedule already on file. Nothing is lost: there is nothing to record. The
  // audit trail only grows when the answer actually changes.
  const amortType = `derived_${best.model}`
  const { data: sameAnchor } = await supa.from('loan_amortization_schedules')
    .select('id')
    .eq('loan_account_id', loan.id)
    .eq('amort_type', amortType)
    .eq('anchor_statement_date', last.statement_date)
  for (const cand of sameAnchor || []) {
    const { data: candRows } = await supa.from('loan_amortization_rows')
      .select('row_date, payment, interest, principal, balance')
      .eq('schedule_id', cand.id)
      .eq('row_type', 'payment')
      .order('row_date', { ascending: true })
    if ((candRows?.length ?? 0) !== projected.length) continue
    const same = projected.every((p: any, i: number) => {
      const c: any = candRows![i]
      return String(c.row_date).slice(0, 10) === p.row_date
        && Math.abs(Number(c.payment) - p.payment) < 0.005
        && Math.abs(Number(c.interest) - p.interest) < 0.005
        && Math.abs(Number(c.principal) - p.principal) < 0.005
        && Math.abs(Number(c.balance) - p.balance) < 0.005
    })
    if (!same) continue
    // Identical. The account's fit fields and the staging card are still brought
    // up to date -- those are cheap, idempotent, and the caller may be asking for
    // staging to be enabled on a run where the projection happened not to move.
    const patch: Record<string, any> = {
      rate_model: best.model,
      fitted_periodic_rate: best.periodic,
      fitted_annual_rate: best.annual,
      rate_fit_residual: r2(best.residual),
      rate_fit_periods: best.periods,
      rate_fit_at: new Date().toISOString(),
    }
    if (enableStaging) patch.prestage_enabled = true
    await supa.from('loan_accounts').update(patch).eq('id', loan.id)
    return {
      ok: true, dry_run: false, unchanged: true, wrote_no_schedule: true,
      loan: { id: loan.id, name: loan.xero_account_name },
      schedule_id: cand.id, rows_written: 0, future_rows: futureRows.length,
      ends_short: endsShort, fit, anchor, prestage_enabled: enableStaging,
      staging: enableStaging ? await ensureUpcomingSplit(supa, loan.id) : { skipped: 'staging not requested' },
      stale_staged: [],
      note: `This re-derivation reproduces the schedule already on file (anchor ${last.statement_date}, ${projected.length} rows, identical to the cent), so nothing was written. A duplicate schedule would be a tie for staging-next to break arbitrarily.`,
    }
  }

  const { data: sched, error: schedErr } = await supa.from('loan_amortization_schedules').insert({
    loan_account_id: loan.id,
    amort_type: amortType,
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
    payment_day_of_month: payDom, payment_day_divergence: domDivergence,
    stale_staged: staleStaged,
  }
}

// Re-derive a loan's projection after something moved its anchor. Never touches a
// lender-issued contractual schedule, and never turns a loan into a projected one
// on its own (a loan with NO schedule is still skipped).
//
// ── SESSION 270: THE GUARD AND ITS OWN REMEDY DISAGREED ──────────────────────
// Session 268 fixed the staging staleness guard to ask "is this the lender's
// contractual schedule?" via an allowlist, which correctly caught PayPal 2
// (amort_type 'actual_payment_history_from_lender_csv' -- a parse of the lender's
// payment HISTORY, projected forward). Its refusal message tells the reader:
// "re-derive this loan's schedule first, then stage the fresh card."
//
// This function -- the automatic half of that remedy -- was still asking the OLD
// denylist question, `startsWith('derived_')`, which PayPal 2's amort_type does
// not match. So the guard blocked the loan and pointed at a fix that was a no-op
// for exactly that loan. Not a rule that outlived its fact (session 247); a rule
// and its remedy born answering different questions, one file apart.
//
// Both halves now read `scheduleGoesStale`. A contractual lender schedule
// (Verdant, PCV, Dexter 2) is still never re-derived; anything else is, because
// anything else goes stale when a newer statement lands. Failure stays safe:
// deriveSchedule returns ok:false when it cannot fit a rate, and the caller
// already ignores that by design -- the projection simply stays stale and the
// staging guard keeps refusing it.
export async function rederiveIfDerived(supa: any, loanId: string, reason: string): Promise<any> {
  const { data: scheds } = await supa.from('loan_amortization_schedules')
    .select('id, source, amort_type, schedule_generated_date')
    .eq('loan_account_id', loanId)
    .order('schedule_generated_date', { ascending: false })
    .limit(1)
  const newest = scheds?.[0]
  if (!newest) return { skipped: 'no schedule on this loan' }
  if (!scheduleGoesStale(newest)) return { skipped: 'lender-issued contractual schedule -- never re-derived' }

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

// ═══════════════════════════════════════════════════════════════════════════
// RATE MEASUREMENT FROM A LENDER-ISSUED AMORTIZATION SCHEDULE  (session 239)
// ═══════════════════════════════════════════════════════════════════════════
//
// Everything above measures a rate from STATEMENTS and, having measured one, projects
// a schedule so a loan with no lender document can still pre-stage. Two active loans
// break that chain from the other end: Dexter Loan 2 and Verdant Capital have never
// sent a statement, but they DO have the lender's own amortization schedule on file --
// which is why they already stage happily and yet published a typed interest_rate on a
// Debt Schedule that goes out to lenders and vendors.
//
// So what they need is the opposite half: a RATE, and nothing else.
//
// ── THIS PATH MEASURES A RATE. IT DOES NOT PROJECT, STAGE, OR TOUCH A SPLIT ──
// A loan reaching this path already has a lender schedule, so staging-next already has
// real rows to work from and deriving a projection over the top would be inventing a
// second, worse copy of a document we already hold. The only thing missing was the
// number in the rate column. This path therefore writes the six rate_fit_* fields and
// nothing else -- no schedule row, no split, no prestage_enabled, no Xero.
//
// ── THE STATEMENT PATH ALWAYS GETS FIRST REFUSAL ────────────────────────────
// measureRate() runs deriveSchedule first, every time, and only falls through when the
// statements cannot support a fit AT ALL. That ordering is what makes this an added
// source rather than a replacement: no loan that has a statement-based fit today can
// have it changed by anything below.
//
// And the fall-through is deliberately narrow. "Not enough statements" means we have no
// evidence and the lender's own contract is the best we have. "The statements fit badly"
// means we DO have evidence and it disagrees with the model -- switching to the contract
// document there would quietly bury exactly the discrepancy this module exists to
// surface. So a failed residual gate never falls through.

/** Statement-path refusals that mean "there is no evidence", as opposed to
 *  "there is evidence and it does not fit". Only these may fall through to a schedule. */
export const STATEMENT_EVIDENCE_MISSING = ['not_enough_statements', 'no_periods', 'not_enough_clean_periods']

export interface MeasureOpts extends DeriveOpts {
  /** The date the published rate must be the one IN FORCE on. Defaults to today
   *  (Pacific). Exposed so the same code can be run for a future date offline. */
  asOf?: string
  /** Never let the statement path write, whatever `confirm` says. The scheduled
   *  refresh uses this: its job is the schedule-sourced rates, and a statement-fitted
   *  loan is already re-derived by its own statement-ingest hook. */
  rateOnly?: boolean
}

const rateFitPatch = (fit: any) => ({
  rate_model: fit.model,
  fitted_periodic_rate: fit.published.periodic_rate,
  fitted_annual_rate: fit.published.annual_rate_percent,
  rate_fit_residual: r2(fit.published.worst_error_dollars),
  rate_fit_periods: fit.published.rows_used,
  rate_fit_at: new Date().toISOString(),
})

export async function measureRateFromSchedule(supa: any, loan: any, opts: MeasureOpts = {}): Promise<any> {
  const confirm = opts.confirm === true
  const asOf = opts.asOf ?? todayPacific()
  const maxResidual = opts.maxResidual ?? 0.05
  const minPeriods = opts.minPeriods ?? 4

  if (loan.status !== 'active') {
    return { ok: false, reason: 'loan_not_active', wrote_nothing: true, message: `This loan is ${loan.status} -- there is no rate left to publish for it.` }
  }

  const { data: scheds, error: schedErr } = await supa.from('loan_amortization_schedules')
    .select('id, amort_type, source, storage_path, balance_basis, schedule_generated_date, created_at, contract_id')
    .eq('loan_account_id', loan.id)
  if (schedErr) return { ok: false, reason: 'schedule_read_failed', wrote_nothing: true, message: schedErr.message }

  // ── Which documents count as evidence, and a plain-English record of why the
  //    rest do not. A silent filter here would be the whole bug: fitting our own
  //    projection looks exactly like success.
  const evidence: any[] = []
  const refused: any[] = []
  for (const s of scheds || []) {
    const v = lenderIssuedVerdict(s)
    if (v.ok) evidence.push(s)
    else refused.push({ schedule_id: s.id, amort_type: s.amort_type, source: s.source, storage_path: s.storage_path, reason: v.reason, message: v.message })
  }
  if (!evidence.length) {
    return {
      ok: false, reason: 'no_lender_schedule', wrote_nothing: true,
      message: !(scheds?.length)
        ? 'This loan has no amortization schedule on file at all, so there is nothing to measure a rate from. It needs either lender statements or the lender’s own schedule.'
        : `This loan has ${scheds.length} schedule${scheds.length === 1 ? '' : 's'} on file, but not one of them is lender-issued evidence. See refused_schedules for what is wrong with each.`,
      refused_schedules: refused,
    }
  }

  // Newest wins: a re-amortization supersedes what came before it. Same ordering rule
  // staging-next uses, including the created_at tie-break, so the two can never pick
  // different documents for the same loan.
  evidence.sort((a, b) => {
    const d = String(b.schedule_generated_date ?? '').localeCompare(String(a.schedule_generated_date ?? ''))
    return d !== 0 ? d : String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  })

  const loadRows = async (scheduleId: string) => {
    const { data } = await supa.from('loan_amortization_rows')
      .select('row_date, row_type, rate, payment, interest, principal, balance, source_label')
      .eq('schedule_id', scheduleId)
      .order('row_date', { ascending: true })
    return (data || []).map((r: any) => ({ ...r, row_date: String(r.row_date).slice(0, 10) }))
  }

  const primary = evidence[0]
  const fit = fitScheduleRate(await loadRows(primary.id), { asOf, maxResidual, minPeriods })

  // Independent corroboration, in the spirit of solvePaymentAndRate: where a loan has
  // MORE than one lender schedule on file, read the others too and say whether they
  // agree. Verdant has two -- a 2025-06-12 parse and a 2026-08-25 client-verified
  // re-parse -- and two documents landing on the same rate is real evidence.
  const corroboration: any[] = []
  for (const s of evidence.slice(1)) {
    const other = fitScheduleRate(await loadRows(s.id), { asOf, maxResidual, minPeriods })
    corroboration.push({
      schedule_id: s.id, generated: s.schedule_generated_date, source: s.source,
      annual_rate_percent: other.ok ? other.published!.annual_rate_percent : null,
      worst_error_dollars: other.ok ? other.published!.worst_error_dollars : null,
      refused_because: other.ok ? null : other.reason,
      agrees: other.ok && fit.ok
        ? Math.abs(other.published!.annual_rate_percent - fit.published!.annual_rate_percent) <= 0.01
        : null,
    })
  }

  const base = {
    rate_source: 'lender_schedule',
    loan: { id: loan.id, name: loan.xero_account_name, lender: loan.lender },
    schedule: {
      id: primary.id, amort_type: primary.amort_type, source: primary.source,
      generated: primary.schedule_generated_date, contract_id: primary.contract_id,
      storage_path: primary.storage_path,
    },
    schedules_refused: refused,
    corroborating_schedules: corroboration,
    contract_rate_on_file: num(loan.interest_rate),
    fit,
  }

  if (!fit.ok) return { ok: false, reason: fit.reason, message: fit.message, wrote_nothing: true, ...base }

  const published = fit.published!
  const contract = num(loan.interest_rate)
  const contractNote = contract === null
    ? 'No rate is typed onto this loan account, so there is nothing to compare against.'
    : Math.abs(contract - published.annual_rate_percent) <= 0.01
      ? `The rate typed onto this loan (${contract}%) agrees with what the lender’s own schedule works out to.`
      : `The rate typed onto this loan says ${contract}%. Its own lender schedule works out to ${published.annual_rate_percent.toFixed(3)}%. The measured figure is the one that gets published; the typed one is a human’s note and is left alone.`

  if (opts.enableStaging === true) {
    // Refused rather than ignored. Staging on a loan with a lender schedule is
    // ensureUpcomingSplit's job and it already has real rows; turning it on from here
    // would imply this path had produced something to stage, which it never does.
    return {
      ok: false, reason: 'staging_not_available_on_this_path', wrote_nothing: true, ...base,
      message: 'This loan already has the lender’s own amortization schedule, so pre-staging is driven by that document, not by anything measured here. Rate measurement from a schedule never enables staging. Enable it on the loan itself if that is what you want.',
    }
  }

  if (!confirm) {
    return {
      ok: true, dry_run: true, wrote_nothing: true, ...base,
      would_write: rateFitPatch(fit),
      contract_rate_note: contractNote,
      staging: 'not applicable -- this loan already has the lender’s own schedule, so nothing needs projecting or staging here.',
    }
  }

  // ── Nothing to record when nothing moved ──────────────────────────────────
  // Same rule as a re-derivation that reproduces the schedule already on file: an
  // audit trail should only grow when the answer changes. It also stops the scheduled
  // refresh below from re-stamping rate_fit_at every night and making the screen claim
  // a measurement was taken when none was.
  const unchanged = String(loan.rate_model ?? '') === fit.model
    && Number(loan.fitted_annual_rate) === published.annual_rate_percent
    && Number(loan.fitted_periodic_rate) === published.periodic_rate
    && Number(loan.rate_fit_periods) === published.rows_used
  if (unchanged) {
    return {
      ok: true, dry_run: false, unchanged: true, wrote_nothing: true, ...base,
      contract_rate_note: contractNote,
      note: `This measurement reproduces the rate already recorded on the loan (${published.annual_rate_percent.toFixed(4)}% over ${published.rows_used} rows), so nothing was written.`,
    }
  }

  const previous = {
    rate_model: loan.rate_model ?? null,
    fitted_annual_rate: num(loan.fitted_annual_rate),
    rate_fit_periods: loan.rate_fit_periods ?? null,
    rate_fit_at: loan.rate_fit_at ?? null,
  }
  const patch = rateFitPatch(fit)
  const { error: updErr } = await supa.from('loan_accounts').update(patch).eq('id', loan.id)
  if (updErr) return { ok: false, reason: 'rate_write_failed', wrote_nothing: true, message: updErr.message, ...base }

  return {
    ok: true, dry_run: false, ...base,
    wrote: patch, previous,
    contract_rate_note: contractNote,
    note: `Measured from ${loan.lender}’s own amortization schedule dated ${primary.schedule_generated_date}. No schedule, split or staging was created -- only the loan’s rate fields were updated.`,
  }
}

// ── THE ONE DOOR ────────────────────────────────────────────────────────────
// Statements first, always; a lender schedule only where there is no statement
// evidence at all. Everything that wants a measured rate goes through here so the
// precedence rule lives in one place rather than in each caller.
export async function measureRate(supa: any, loan: any, opts: MeasureOpts = {}): Promise<any> {
  const rateOnly = opts.rateOnly === true
  const stmt = await deriveSchedule(supa, loan, { ...opts, confirm: opts.confirm === true && !rateOnly })

  if (stmt.ok) {
    return {
      ...stmt, rate_source: 'lender_statements',
      ...(rateOnly && opts.confirm === true
        ? { wrote_nothing: true, note: 'This loan’s rate is measured from its own lender statements, which is the stronger evidence and is already refreshed whenever a statement arrives. The scheduled rate refresh deliberately leaves it alone.' }
        : {}),
    }
  }

  if (!STATEMENT_EVIDENCE_MISSING.includes(String(stmt.reason))) {
    // Evidence exists and disagrees with the model. Falling back to the lender's
    // contract here would publish a number this loan's own history contradicts.
    return {
      ...stmt, rate_source: 'none',
      schedule_fallback: `Not attempted. This loan has statement evidence -- it simply does not fit (${stmt.reason}). A lender schedule is only allowed to stand in where there is no statement evidence at all, because otherwise it would paper over exactly the disagreement worth seeing.`,
    }
  }

  const sched = await measureRateFromSchedule(supa, loan, opts)
  return {
    ...sched,
    statement_path: { reason: stmt.reason, message: stmt.message, statements_on_file: stmt.statements_on_file ?? null, clean_periods: stmt.clean_periods ?? null },
  }
}

// ── THE SCHEDULED REFRESH ───────────────────────────────────────────────────
// A lender schedule can carry a rate change dated in the future -- Dexter Loan 2's
// steps from 6.640% to 5.890% on 2026-08-31 -- and loan_accounts holds exactly ONE
// fitted_annual_rate. Something has to move that number on the day, or the Debt
// Schedule keeps publishing yesterday's rate until a human remembers. This is that
// something, and it is deliberately the narrowest thing that can be:
//
//   * it never takes the statement path's write branch (rateOnly)
//   * it only ever writes the six rate_fit_* columns
//   * it writes nothing at all when the answer has not moved
//   * confirm:false makes it a read-only report, like everything else here
//
// See the header of loan-derive-schedule/index.ts for why this, and not an
// effective-dated rate table, is the right size of fix for now.
export async function refreshScheduleRates(supa: any, opts: MeasureOpts = {}): Promise<any> {
  const confirm = opts.confirm === true
  const asOf = opts.asOf ?? todayPacific()
  const { data: loans, error } = await supa.from('loan_accounts').select('*').eq('status', 'active')
  if (error) return { ok: false, reason: 'loan_read_failed', message: error.message, wrote_nothing: true }

  const results: any[] = []
  for (const loan of loans || []) {
    const res = await measureRate(supa, loan, { ...opts, asOf, confirm, rateOnly: true, actor: opts.actor ?? 'scheduled rate refresh' })
    // The statement path's fit object is a different shape (no segments), so read
    // whichever of the two carries the rate rather than reporting null for one of them.
    const published = res.fit?.published ?? null
    const measured = published ? published.annual_rate_percent : (num(res.fit?.annual_rate_percent) ?? null)
    results.push({
      loan_account_id: loan.id, name: loan.xero_account_name, lender: loan.lender,
      rate_source: res.rate_source ?? 'none',
      ok: res.ok === true,
      reason: res.ok === true ? null : res.reason,
      rate_on_file: num(loan.fitted_annual_rate),
      measured_rate: measured,
      wrote: res.wrote ? true : false,
      unchanged: res.unchanged === true,
      upcoming_rate_change: res.fit?.upcoming_rate_change ?? null,
    })
  }
  const changed = results.filter((r) => r.wrote)
  const upcoming = results.filter((r) => r.upcoming_rate_change)
  return {
    ok: true, dry_run: !confirm, as_of: asOf,
    loans_checked: results.length,
    rates_updated: changed.length,
    updated: changed.map((r) => `${r.name}: ${r.rate_on_file ?? 'none'} -> ${r.measured_rate}`),
    rate_changes_ahead: upcoming.map((r) => `${r.name}: ${r.upcoming_rate_change.note}`),
    results,
    ...(confirm ? {} : { wrote_nothing: true }),
  }
}
