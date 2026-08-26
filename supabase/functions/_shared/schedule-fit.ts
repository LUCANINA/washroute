// _shared/schedule-fit.ts — session 239
// =============================================================================
// MEASURING A RATE FROM A LENDER-ISSUED AMORTIZATION SCHEDULE.
//
// rate-fit.ts measures a rate from what a lender said the BALANCE was, month after
// month. That works for the loans that send statements. Two active loans send none
// and never have -- Dexter Loan 2 and Verdant Capital -- so until now they published
// loan_accounts.interest_rate, the typed figure the fitted column exists to stop
// publishing, on a Debt Schedule that now goes to lenders and vendors.
//
// Both DO have the lender's own amortization schedule on file, and a schedule states
// its interest column. That column is evidence of the same kind as a statement: it is
// the lender's arithmetic rather than ours, and it is checkable -- interest against
// each row's own opening balance has to come out to ONE number, row after row, or the
// document is not the schedule it claims to be. On the two loans in question it does:
//
//   Dexter Loan 2     6.6400 %/yr over 58 rows (spread 6.6399-6.6401)   typed on file: 6.500
//   Verdant Capital   8.7800 %/yr over 83 rows (spread 8.7796-8.7825)   typed on file: 9.000
//
// ── RATES ONLY. NEVER BALANCES. ─────────────────────────────────────────────
// A lender schedule's future rows are the lender's PLAN, not a fact about money: one
// extra principal payment makes every future balance on it wrong. The invariant that
// a BALANCE must be dated today-or-earlier (_loanOutstandingBalance, and the two
// production bugs behind it) is untouched by anything in this file, because nothing
// in this file reads or writes a balance.
//
// What an extra principal payment does NOT move is the ratio inside a single row --
// its stated interest against its own stated opening balance -- and that ratio is the
// rate. Which is why this module deliberately reads FUTURE rows (it has to: that is
// where a scheduled rate change lives), and why its output may only ever be written
// to the rate_fit_* columns. It projects nothing, stages nothing, and touches no
// split.
//
// ── OUR OWN PROJECTIONS ARE NOT EVIDENCE ────────────────────────────────────
// deriveSchedule writes its projections INTO loan_amortization_schedules. Fitting one
// of those would measure our own arithmetic and "confirm" whatever we already
// assumed, including any error -- the same self-reference that keeps xero_derived
// statements out of the statement fit. lenderIssuedVerdict() refuses them on three
// independent markers and says so out loud, rather than quietly measuring less.
//
// (The same trap wearing a different hat: Verdant carries 85 loan_statements rows
// whose source is 'amortization_schedule' -- a backfill OF this very document, not
// statements. They sit outside REAL_SOURCES already, and derive-schedule.ts now
// asserts that at import time so the two lists cannot drift into overlapping.)

import {
  classifyPeriods, fitModel, daysBetween, r2, r8, REGIME_TOL,
  type Period, type Fit, type RateModel,
} from "./rate-fit.ts"

const num = (v: any): number | null =>
  (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// ── What a lender schedule looks like to this module ────────────────────────

export interface AmortScheduleLike {
  id: string
  amort_type?: string | null
  source?: string | null
  storage_path?: string | null
  balance_basis?: string | null
  schedule_generated_date?: string | null
  created_at?: string | null
  contract_id?: string | null
}

export interface AmortRowLike {
  row_date: string
  row_type: string
  rate?: number | string | null
  payment?: number | string | null
  interest?: number | string | null
  principal?: number | string | null
  balance?: number | string | null
  source_label?: string | null
}

// ── IS THIS DOCUMENT EVIDENCE, OR IS IT US TALKING TO OURSELVES? ────────────
// Three independent markers, because a projection that lost one of them would still
// be a projection. deriveSchedule stamps all three; a lender-issued row carries none.
// Any ONE of them disqualifies.
export const DERIVED_AMORT_TYPE_PREFIX = 'derived_'
export const DERIVED_STORAGE_PREFIX = 'derived://'
export const DERIVED_SCHEDULE_SOURCES = ['derived_from_statements']

export interface LenderIssuedVerdict { ok: boolean; reason: string; message: string }

export function lenderIssuedVerdict(s: AmortScheduleLike): LenderIssuedVerdict {
  const amortType = String(s.amort_type ?? '').trim().toLowerCase()
  const storage = String(s.storage_path ?? '').trim().toLowerCase()
  const source = String(s.source ?? '').trim().toLowerCase()
  const basis = String(s.balance_basis ?? '').trim().toLowerCase()

  const derivedMarkers: string[] = []
  if (amortType.startsWith(DERIVED_AMORT_TYPE_PREFIX)) derivedMarkers.push(`its amort_type is "${s.amort_type}"`)
  if (storage.startsWith(DERIVED_STORAGE_PREFIX)) derivedMarkers.push(`its storage_path starts with "${DERIVED_STORAGE_PREFIX}"`)
  if (DERIVED_SCHEDULE_SOURCES.includes(source)) derivedMarkers.push(`its source is "${s.source}"`)
  if (derivedMarkers.length) {
    return {
      ok: false, reason: 'schedule_is_our_own_projection',
      message: `This schedule is one this system projected itself (${derivedMarkers.join('; ')}). `
        + `Measuring a rate from it would only measure our own arithmetic -- it would confirm whatever we already assumed, `
        + `including a mistake -- so it proves nothing about what the lender charges. Only a schedule the lender issued counts as evidence.`,
    }
  }

  // total_payback schedules quote the gross amount owed, not a principal balance, so
  // "interest against opening balance" is not the rate of anything. The statement
  // fitter refuses total_payback for the same reason (PayPal 2 is the loan in question).
  if (basis === 'total_payback') {
    return {
      ok: false, reason: 'schedule_is_total_payback',
      message: `This schedule is kept on a total-payback basis (balance_basis = "${s.balance_basis}"), so its balance column is the gross amount still owed rather than a principal balance. `
        + `Interest measured against it would not be an interest rate. A principal-only schedule is needed.`,
    }
  }

  return { ok: true, reason: 'lender_issued', message: 'This is a lender-issued, principal-basis schedule.' }
}

// ── Periods out of schedule rows ────────────────────────────────────────────
//
// THE OPENING BALANCE IS RECOVERED FROM THE ROW ITSELF, not read off the row before
// it: opening = closing + principal. loan_amortization_rows has no ordinal column, so
// rows sharing a date have no defined order (Dexter Loan 2 has three on 2021-09-30),
// and chaining through a neighbour would silently measure the wrong period. Recovering
// the opening from the row's own two stated figures is immune to that -- and it turns
// the neighbour into an independent CHECK instead of a dependency.

export interface RowProblem { row_date: string; why: string }

export function buildSchedulePeriods(rows: AmortRowLike[]): {
  periods: Period[]; rowProblems: RowProblem[]; paymentRows: number; openingAnchor: string | null
} {
  const pay = rows
    .filter((r) => String(r.row_type) === 'payment')
    .slice()
    // Date first; then descending closing balance, which is the only principled
    // tie-break available for same-date rows -- within one day the balance falls.
    .sort((a, b) => (a.row_date < b.row_date ? -1 : a.row_date > b.row_date ? 1
      : (num(b.balance) ?? 0) - (num(a.balance) ?? 0)))

  // An 'initial' row dated before the first payment gives the first period an opening
  // date it would otherwise not have. Without one the first row is simply not a period.
  const firstPayDate = pay.length ? pay[0].row_date : null
  let openingAnchor: string | null = null
  for (const r of rows) {
    if (String(r.row_type) === 'payment') continue
    if (num(r.balance) === null) continue
    if (firstPayDate && r.row_date < firstPayDate && (!openingAnchor || r.row_date > openingAnchor)) openingAnchor = r.row_date
  }

  const periods: Period[] = []
  const rowProblems: RowProblem[] = []
  for (let k = 0; k < pay.length; k++) {
    const r = pay[k]
    const interest = num(r.interest), principal = num(r.principal), b1 = num(r.balance)
    if (interest === null || principal === null || b1 === null) {
      rowProblems.push({ row_date: r.row_date, why: 'the row does not state interest, principal and a closing balance, so no rate can be read from it' })
      continue
    }
    const b0 = r2(b1 + principal)
    const statedPayment = num(r.payment)
    const payment = statedPayment ?? r2(interest + principal)
    // A row that does not foot is a parse error or a document that is not what it
    // claims. Either way it is not evidence.
    if (statedPayment !== null && Math.abs(statedPayment - (interest + principal)) > 0.01) {
      rowProblems.push({ row_date: r.row_date, why: `interest $${interest.toFixed(2)} plus principal $${principal.toFixed(2)} does not add up to the stated payment $${statedPayment.toFixed(2)}` })
      continue
    }
    const from = k > 0 ? pay[k - 1].row_date : openingAnchor
    if (!from) continue   // the first row of a schedule that states no opening balance
    // The neighbour as a CHECK: on a different date the previous row's closing balance
    // must be this row's recovered opening. Where it isn't, one of the two rows is
    // mis-parsed and neither can be trusted to measure a period.
    if (k > 0 && pay[k - 1].row_date !== r.row_date) {
      const prevClose = num(pay[k - 1].balance)
      if (prevClose !== null && Math.abs(prevClose - b0) > 0.05) {
        rowProblems.push({ row_date: r.row_date, why: `its opening balance works out to $${b0.toFixed(2)}, but the previous row closes at $${prevClose.toFixed(2)} -- the schedule does not join up here` })
        continue
      }
    }
    periods.push({
      from, to: r.row_date, b0, b1,
      days: daysBetween(from, r.row_date),
      payment, principal, interest,
    })
  }
  return { periods, rowProblems, paymentRows: pay.length, openingAnchor }
}

// ── Rate segments ───────────────────────────────────────────────────────────
//
// currentRegime() in rate-fit.ts walks BACKWARDS from the newest statement period and
// stops at the first break, because a statement history only ever needs to answer
// "what is the rate now". A lender's schedule is a different object: it states the
// whole term, including changes that have not happened yet. Dexter Loan 2 carries a
// rate_change row dated 2026-08-31 taking 6.640% to 5.890%, and its own later rows
// prove it (2026-09-30: $422.44 of interest on $86,066.61 is 5.8900%, and the payment
// steps from $3,839.38 to $3,810.26).
//
// So the same break rule is walked FORWARDS instead, cutting wherever a period's own
// implied rate leaves REGIME_TOL of the segment it started -- the identical tolerance,
// imported rather than copied.

export const impliedRate = (p: Period, model: RateModel) =>
  (model === 'daily_actual_365' ? p.interest / (p.b0 * p.days) : p.interest / p.b0)

export function segmentPeriods(clean: Period[], model: RateModel, tol = REGIME_TOL): Period[][] {
  const out: Period[][] = []
  let cur: Period[] = []
  let anchor = NaN
  for (const p of clean) {
    const r = impliedRate(p, model)
    if (!cur.length) { cur = [p]; anchor = r; continue }
    const broke = Number.isFinite(anchor) && anchor > 0 && Number.isFinite(r)
      && Math.abs(r - anchor) / anchor > tol
    if (broke) { out.push(cur); cur = [p]; anchor = r } else cur.push(p)
  }
  if (cur.length) out.push(cur)
  return out
}

// ── The whole measurement ───────────────────────────────────────────────────

export interface SegmentReport {
  effective_from: string
  effective_to: string
  annual_rate_percent: number
  periodic_rate: number
  rows_used: number
  worst_error_dollars: number
  lender_stated_rate: number | null
  lender_stated_agrees: boolean | null
  in_force_on_as_of_date: boolean
  note: string
}

export interface ScheduleFitResult {
  ok: boolean
  reason?: string
  message?: string
  model?: RateModel
  cadence?: string
  median_days?: number
  as_of?: string
  published?: SegmentReport
  segments?: SegmentReport[]
  upcoming_rate_change?: {
    effective_from: string; from_rate_percent: number; to_rate_percent: number
    lender_stated_rate: number | null; days_away: number; note: string
  } | null
  gate_max_residual?: number
  passes_gate?: boolean
  payment_rows_on_file?: number
  clean_periods?: number
  excluded_periods?: Array<Period & { why: string }>
  row_problems?: RowProblem[]
  runner_up?: { model: RateModel; segments: number; published_worst_error_dollars: number | null }
}

const MONTHLY_MIN_DAYS = 26
const MONTHLY_MAX_DAYS = 32

function buildSegmentReports(
  segs: Period[][], model: RateModel, statedRates: Array<{ date: string; rate: number }>, asOf: string,
): { reports: SegmentReport[]; fits: Fit[]; publishedIndex: number } {
  const fits = segs.map((s) => fitModel(model, s))
  const effFrom = segs.map((s) => s[0].from)

  // Each rate the lender PRINTED belongs to the last segment that had already started
  // when it was printed; anything printed before the first segment opens (an 'initial'
  // rate row) belongs to the first.
  const stated: Array<number | null> = segs.map(() => null)
  for (const sr of statedRates) {
    let idx = 0
    for (let i = 0; i < effFrom.length; i++) if (effFrom[i] <= sr.date) idx = i
    if (sr.date < effFrom[0]) idx = 0
    stated[idx] = sr.rate
  }

  let publishedIndex = 0
  for (let i = 0; i < effFrom.length; i++) if (effFrom[i] <= asOf) publishedIndex = i

  const reports = segs.map((s, i) => {
    const f = fits[i]
    const st = stated[i]
    const agrees = st === null ? null : Math.abs(st - f.annual) <= 0.01
    return {
      effective_from: effFrom[i],
      effective_to: s[s.length - 1].to,
      annual_rate_percent: f.annual,
      periodic_rate: f.periodic,
      rows_used: f.periods,
      worst_error_dollars: r2(f.residual),
      lender_stated_rate: st,
      lender_stated_agrees: agrees,
      in_force_on_as_of_date: i === publishedIndex,
      note: `${f.annual.toFixed(4)}% a year from ${effFrom[i]}, measured across ${f.periods} of the lender's own rows and reproducing every one of them to within $${r2(f.residual).toFixed(2)}.`
        + (st === null ? '' : agrees
          ? ` The schedule also prints this rate as ${st}%, which agrees.`
          : ` The schedule prints this rate as ${st}%, which does NOT agree with its own interest column -- one of the two is wrong and a human should look.`),
    }
  })
  return { reports, fits, publishedIndex }
}

export function fitScheduleRate(rows: AmortRowLike[], opts: {
  asOf: string; maxResidual?: number; minPeriods?: number
}): ScheduleFitResult {
  const maxResidual = opts.maxResidual ?? 0.05
  const minPeriods = opts.minPeriods ?? 4
  const asOf = opts.asOf

  const { periods, rowProblems, paymentRows } = buildSchedulePeriods(rows)
  if (!periods.length) {
    return {
      ok: false, reason: 'no_schedule_periods',
      message: `This schedule has ${paymentRows} payment rows but none of them can be read as a period -- see row_problems for what is wrong with each.`,
      payment_rows_on_file: paymentRows, row_problems: rowProblems,
    }
  }

  // Exactly the statement fitter's own definition of an ordinary payment period:
  // a sensible span, a positive opening balance, a balance that fell, interest that
  // is not negative. Imported, not restated.
  const { clean, excluded, medianDays } = classifyPeriods(periods)
  if (clean.length < minPeriods) {
    return {
      ok: false, reason: 'not_enough_clean_rows',
      message: `Only ${clean.length} of this schedule's ${periods.length} readable rows are ordinary payment rows; ${minPeriods} are needed to measure a rate.`,
      payment_rows_on_file: paymentRows, clean_periods: clean.length,
      excluded_periods: excluded, row_problems: rowProblems, median_days: medianDays,
    }
  }

  // A flat per-period rate is annualised by multiplying by 12, which is only true when
  // a period IS a month. On anything else that answer would be silently wrong, so it
  // is refused rather than published.
  const monthly = medianDays >= MONTHLY_MIN_DAYS && medianDays <= MONTHLY_MAX_DAYS

  const candidates = (['daily_actual_365', 'flat_per_period'] as RateModel[]).map((model) => {
    const segs = segmentPeriods(clean, model)
    const statedRates = rows
      .filter((r) => (num(r.rate) ?? 0) > 0)
      .map((r) => ({ date: r.row_date, rate: Number(num(r.rate)) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    const { reports, publishedIndex } = buildSegmentReports(segs, model, statedRates, asOf)
    const published = reports[publishedIndex]
    const usable = model === 'flat_per_period' && !monthly ? false : published.rows_used >= minPeriods
    return {
      model, segs, reports, published, usable,
      score: usable ? published.worst_error_dollars : Number.POSITIVE_INFINITY,
      worst: Math.max(...reports.map((r) => r.worst_error_dollars)),
    }
  }).sort((a, b) => (a.score - b.score) || (a.segs.length - b.segs.length) || (a.worst - b.worst))

  const best = candidates[0]
  const other = candidates[1]
  const runner_up = {
    model: other.model, segments: other.segs.length,
    published_worst_error_dollars: other.usable ? other.published.worst_error_dollars : null,
  }
  const common = {
    model: best.model, cadence: monthly ? 'monthly' : `every ~${medianDays} days`,
    median_days: medianDays, as_of: asOf,
    segments: best.reports, published: best.published,
    gate_max_residual: maxResidual,
    payment_rows_on_file: paymentRows, clean_periods: clean.length,
    excluded_periods: excluded, row_problems: rowProblems, runner_up,
  }

  if (best.model === 'flat_per_period' && !monthly) {
    return {
      ok: false, reason: 'cadence_not_monthly', passes_gate: false, ...common,
      message: `This schedule's rows are about ${medianDays} days apart, so a period is not a month. The flat-per-period model fits it, but turning a per-period rate into an annual one by multiplying by twelve would then be wrong, and a wrong rate on a document sent to a lender is worse than none. A human needs to say what the period is.`,
    }
  }
  if (!best.usable) {
    return {
      ok: false, reason: 'not_enough_rows_in_force', passes_gate: false, ...common,
      message: `The rate in force on ${asOf} rests on only ${best.published.rows_used} of the lender's rows; ${minPeriods} are needed. `
        + `This schedule splits into ${best.segs.length} rate ${best.segs.length === 1 ? 'period' : 'periods'}, and the current one is too short to measure.`,
    }
  }

  const nextSeg = best.reports[best.reports.indexOf(best.published) + 1] ?? null
  const upcoming = nextSeg ? {
    effective_from: nextSeg.effective_from,
    from_rate_percent: best.published.annual_rate_percent,
    to_rate_percent: nextSeg.annual_rate_percent,
    lender_stated_rate: nextSeg.lender_stated_rate,
    days_away: daysBetween(asOf, nextSeg.effective_from),
    note: `This loan's own schedule changes rate on ${nextSeg.effective_from}, from ${best.published.annual_rate_percent.toFixed(3)}% to ${nextSeg.annual_rate_percent.toFixed(3)}%`
      + (nextSeg.lender_stated_rate === null ? '' : ` (the lender prints the new rate as ${nextSeg.lender_stated_rate}%)`)
      + `. The published rate is the one in force today; it becomes ${nextSeg.annual_rate_percent.toFixed(3)}% on ${nextSeg.effective_from}, which needs this measurement to be re-run on or after that date.`,
  } : null

  const passes = best.published.worst_error_dollars <= maxResidual
  if (!passes) {
    return {
      ok: false, reason: 'fit_not_good_enough', passes_gate: false, upcoming_rate_change: upcoming, ...common,
      message: `The best reading of this schedule is ${best.model.replace(/_/g, ' ')} at ${best.published.annual_rate_percent.toFixed(3)}%, but it misses the lender's own interest column by as much as $${best.published.worst_error_dollars.toFixed(2)}. `
        + `That is an estimate, not a measurement, so no rate was recorded. A rate published to a lender needs to be right.`,
    }
  }

  return { ok: true, passes_gate: true, upcoming_rate_change: upcoming, ...common }
}
