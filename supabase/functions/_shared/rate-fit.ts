// _shared/rate-fit.ts — session 230
// =============================================================================
// The arithmetic behind a DERIVED amortization schedule, kept separate from the
// edge function that does the IO so it can be run offline against every loan's real
// history. (This module has no Supabase, no Deno.env, no network -- import it from
// a test harness and it just runs.)
//
// What it answers: "does this lender's own statement history demonstrate a rule we
// can project forward, and how wrong would we be if we did?"

export interface StatementLike { statement_date: string; principal_balance: number | string; total_amount_due?: number | string | null }

export interface Period {
  from: string; to: string; b0: number; b1: number; days: number
  payment: number; principal: number; interest: number
}

export type RateModel = 'daily_actual_365' | 'flat_per_period'

export interface Fit {
  model: RateModel
  periodic: number          // per day (daily model) or per period (flat model)
  annual: number            // the same figure as an annual percentage, for humans
  residual: number          // worst |predicted - actual| in dollars
  periods: number
  errors: Array<{ to: string; predicted: number; actual: number; error: number }>
}

export const r2 = (n: number) => Math.round(n * 100) / 100
export const r8 = (n: number) => Math.round(n * 1e8) / 1e8
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const num = (v: any): number | null =>
  (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

// Ford's portal is pulled twice a month and both pulls carry the SAME balance (the
// 12th and the 22nd, say). Treating those as two periods invents a zero-payment
// period between them and wrecks the fit, so a run of identical balances collapses
// to its EARLIEST member -- the date the balance actually became that value.
export function collapseDuplicateBalances<T extends StatementLike>(stmts: T[]): T[] {
  const out: T[] = []
  for (const s of stmts) {
    const prev = out[out.length - 1]
    if (prev && Math.abs(Number(prev.principal_balance) - Number(s.principal_balance)) < 0.005) continue
    out.push(s)
  }
  return out
}

export function buildPeriods(stmts: StatementLike[], fallbackPayment: number | null): Period[] {
  const out: Period[] = []
  for (let k = 1; k < stmts.length; k++) {
    const a = stmts[k - 1], b = stmts[k]
    const payment = num(b.total_amount_due) ?? fallbackPayment
    if (payment === null) continue
    const b0 = Number(a.principal_balance), b1 = Number(b.principal_balance)
    const principal = r2(b0 - b1)
    out.push({
      from: a.statement_date, to: b.statement_date, b0, b1,
      days: daysBetween(a.statement_date, b.statement_date),
      payment, principal, interest: r2(payment - principal),
    })
  }
  return out
}

// Which periods count as EVIDENCE. A period spanning a statement gap covers several
// payments and would drag the fitted rate up; a period containing an extra principal
// payment shows negative interest. Both are excluded from the fit and reported --
// they are exactly the situations a human needs to see.
export function classifyPeriods(periods: Period[]): {
  clean: Period[]; excluded: Array<Period & { why: string }>; medianDays: number
} {
  const sorted = periods.map((p) => p.days).sort((x, y) => x - y)
  const medianDays = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const clean: Period[] = []
  const excluded: Array<Period & { why: string }> = []
  for (const p of periods) {
    let why: string | null = null
    if (p.days < medianDays * 0.5 || p.days > medianDays * 1.5) {
      why = `spans ${p.days} days against a typical ${medianDays} -- it covers more than one payment, or a statement is missing`
    } else if (p.b0 <= 0) why = 'no opening balance'
    else if (p.principal <= 0) why = 'the balance did not fall, so this is not an ordinary payment period'
    else if (p.interest < 0) why = `implies negative interest ($${p.interest.toFixed(2)}) -- an extra principal payment almost certainly landed inside this period`
    if (why) excluded.push({ ...p, why }); else clean.push(p)
  }
  return { clean, excluded, medianDays }
}

// THE CURRENT REGIME, not the whole life of the loan.
//
// E-Transit 4140's first live run fitted 43 periods back to 2022 and missed by $0.62,
// against $0.01 on recent history. The reason turned out to be real: its implied
// daily rate sits at 22.712e-5 for most of the loan, but drops to 22.650e-5 for
// eleven months (2024-02 to 2024-12) and then returns. The loan genuinely changed
// rate and changed back. Averaging across that break produces a rate that was never
// true on any single period.
//
// So: start from the newest period and walk backwards while each period's own
// implied rate stays within `tol` of it. Stop at the break. Within a regime the
// spread is ~0.005%; the 4140 break is 0.27%, so a 0.1% tolerance separates them
// with two orders of magnitude to spare in both directions.
//
// This uses as much evidence as is CONSISTENT, rather than as much as exists -- and
// it reports the break, which is how a rate change becomes visible instead of just
// degrading the fit.
// The line between "the same rate, measured through cent-rounding noise" and "the
// rate actually changed". Exported because schedule-fit.ts cuts a LENDER'S OWN
// amortization schedule into rate segments by this same rule -- one definition of
// what counts as a different rate, rather than two that can quietly drift apart.
export const REGIME_TOL = 0.001

export function currentRegime(ps: Period[], model: RateModel, tol = REGIME_TOL): {
  regime: Period[]; dropped: number; breakAt: string | null
} {
  if (ps.length < 2) return { regime: ps, dropped: 0, breakAt: null }
  const implied = (p: Period) => (model === 'daily_actual_365' ? p.interest / (p.b0 * p.days) : p.interest / p.b0)
  const newest = implied(ps[ps.length - 1])
  if (!Number.isFinite(newest) || newest <= 0) return { regime: ps, dropped: 0, breakAt: null }
  const regime: Period[] = []
  let breakAt: string | null = null
  for (let k = ps.length - 1; k >= 0; k--) {
    const r = implied(ps[k])
    if (!Number.isFinite(r) || Math.abs(r - newest) / newest > tol) { breakAt = ps[k].to; break }
    regime.unshift(ps[k])
  }
  return { regime, dropped: ps.length - regime.length, breakAt }
}

export function fitModel(model: RateModel, ps: Period[]): Fit {
  const rate = ps.reduce((s, p) =>
    s + (model === 'daily_actual_365' ? p.interest / (p.b0 * p.days) : p.interest / p.b0), 0) / ps.length
  const errors = ps.map((p) => {
    const predicted = r2(model === 'daily_actual_365' ? p.b0 * rate * p.days : p.b0 * rate)
    return { to: p.to, predicted, actual: p.interest, error: r2(predicted - p.interest) }
  })
  return {
    model, periodic: r8(rate),
    annual: r8(rate * (model === 'daily_actual_365' ? 365 : 12) * 100),
    residual: Math.max(...errors.map((e) => Math.abs(e.error))),
    periods: ps.length, errors,
  }
}

// Ford accrues DAILY on the outstanding balance; Funding Circle accrues a FLAT
// amount per period. Try both, let the loan's own numbers pick.
export function chooseFit(clean: Period[], minPeriods = 4): {
  best: Fit; runnerUp: Fit; regime: { periods: number; dropped: number; breakAt: string | null }
} {
  const models: RateModel[] = ['daily_actual_365', 'flat_per_period']
  const candidates = models.map((m) => {
    // Trim to the current regime first, then fit -- but never below the minimum
    // number of periods a fit is allowed to rest on. If the regime is too short,
    // fall back to everything and let the residual gate refuse it honestly rather
    // than manufacture confidence from three data points.
    const { regime, dropped, breakAt } = currentRegime(clean, m)
    const use = regime.length >= minPeriods ? regime : clean
    return { fit: fitModel(m, use), meta: { periods: use.length, dropped: use === clean ? 0 : dropped, breakAt: use === clean ? null : breakAt } }
  }).sort((a, b) => a.fit.residual - b.fit.residual)
  return { best: candidates[0].fit, runnerUp: candidates[1].fit, regime: candidates[0].meta }
}

// SOLVE the rate AND the payment from balances alone, as a cross-check.
//
// Every model here is linear in two unknowns. For the flat model each period says
//     principal_i = P - r * b0_i
// and for the daily model
//     principal_i = P - r * (b0_i * days_i)
// so a least-squares line through (b0, principal) yields BOTH the periodic rate and
// the level payment, using nothing but balances. Nothing is assumed about what the
// payment is.
//
// Why this matters: session 230 found Funding Circle fitting to $1.63 and the gate
// refusing it. The rate model was fine -- the PAYMENT was wrong. Its statements
// mostly omit the amount due, so the fitter fell back to
// loan_accounts.scheduled_monthly_payment, a human's note reading $2,000.00 when the
// real instalment is $2,033.77. Same class of error as the contract rate saying
// 9.000% for a Ford loan charging 8.29%: a typed figure quietly poisoning a
// measurement. With the right payment the same loan fits to ONE CENT at 17.99%.
//
// So this is not used to replace the lender's own stated payment -- it is used to
// CHECK it. Solved and stated agreeing is meaningful corroboration (on Ford 4140 the
// solver returns $1,180.32, the exact printed instalment); disagreeing is a signal
// that one of them is wrong, which a human should see rather than a projection
// silently absorb.
export function solvePaymentAndRate(model: RateModel, stmts: StatementLike[]): {
  rate: number; payment: number; residual: number; points: number
} | null {
  const pts: Array<{ x: number; y: number }> = []
  for (let k = 1; k < stmts.length; k++) {
    const b0 = Number(stmts[k - 1].principal_balance)
    const principal = r2(b0 - Number(stmts[k].principal_balance))
    const days = daysBetween(stmts[k - 1].statement_date, stmts[k].statement_date)
    if (!Number.isFinite(b0) || b0 <= 0 || !Number.isFinite(principal) || days <= 0) continue
    pts.push({ x: model === 'daily_actual_365' ? b0 * days : b0, y: principal })
  }
  if (pts.length < 3) return null
  const n = pts.length
  const sx = pts.reduce((s, p) => s + p.x, 0)
  const sy = pts.reduce((s, p) => s + p.y, 0)
  const sxx = pts.reduce((s, p) => s + p.x * p.x, 0)
  const sxy = pts.reduce((s, p) => s + p.x * p.y, 0)
  const den = n * sxx - sx * sx
  if (Math.abs(den) < 1e-9) return null
  const slope = (n * sxy - sx * sy) / den
  const payment = (sy - slope * sx) / n
  const rate = -slope
  if (!(rate > 0) || !(payment > 0)) return null
  const residual = Math.max(...pts.map((p) => Math.abs((payment - rate * p.x) - p.y)))
  return { rate: r8(rate), payment: r2(payment), residual: r2(residual), points: n }
}

// The payment figure a fit should REST on, in order of how much it deserves trust:
//   1. what a lender statement actually states (their own number, most recent first)
//   2. the scheduled payment typed onto the loan account (a human's note)
// The solver above then checks whichever was used. Session 230: skipping straight to
// (2) is what made Funding Circle look unfittable.
export function statedPayment(stmts: StatementLike[]): number | null {
  for (let k = stmts.length - 1; k >= 0; k--) {
    const due = num(stmts[k].total_amount_due)
    if (due !== null && due > 0) return r2(due)
  }
  return null
}

// The recurring payment, taken from EVIDENCE rather than from the newest statement.
// E4 -9744's most recent statement carries total_amount_due = $5,000 -- a one-off
// extra principal payment, not the monthly instalment. Anchoring a projection to it
// produced a schedule of $5,000 monthly payments. The median payment across the
// clean periods is the loan's actual rhythm; the scheduled figure on the account is
// the fallback when there is no evidence at all.
export function recurringPayment(clean: Period[], scheduled: number | null): number | null {
  if (clean.length) {
    const sorted = clean.map((p) => p.payment).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  return scheduled
}

// THE DAY THE LOAN ACTUALLY PAYS, measured -- not the day we happened to look.
//
// Session 231. projectRows took its day-of-month from the ANCHOR statement's date,
// but an anchor date is a PULL date, not a payment date. Ford's portal is pulled
// twice a month (see collapseDuplicateBalances above); when the later pull shows an
// unchanged balance it still became the anchor, and the whole projection inherited
// that pull's day.
//
// Measured against real data, 3 of 7 derived loans were being projected onto the
// wrong day:
//
//   E-Transit E4-9744   pays the 9th (40 payments)   projected the 20th
//   BayFirst SBA 2      pays the 2nd (5 payments)    projected the 31st
//   Funding Circle      pays the 1st (8 payments)    projected the 3rd
//
// Not cosmetic. The stage sweep flags any match reconciled more than
// STAGE_EARLY_MATCH_GRACE_DAYS before the scheduled date, so E4-9744's real
// 9th-of-the-month payment against a row dated the 20th trips matched_early_suspect
// every period, forever -- never posting, never creating the next card, and never
// self-healing because the projection keeps regenerating the same wrong date.
// BayFirst SBA 2's is worse in kind: a stage dated Aug 31 for a payment that lands
// Sep 2 books the September payment into August.
//
// The right signal is already in hand. A clean period is one where the balance
// actually FELL by a sensible amount, so its closing date is a date the loan really
// paid. The median of those closing days is the loan's demonstrated payment day, and
// it uses exactly the evidence the rate fit already rests on. Median, not mode or
// mean: it ignores the odd early/late posting without being dragged by it.
export function paymentDayOfMonth(clean: Period[]): number | null {
  return medianDayOfMonth(clean.map((p) => p.to))
}

// The same median, over dates the caller chooses.
//
// ── SESSION 274: WHY THIS SPLIT EXISTS ──────────────────────────────────────
// On a `period_start` loan every anchor is RE-DATED to its month end before the
// fit runs (see _shared/statement-period.ts). That is right for the BALANCE --
// it is what the figure is actually as of -- and completely wrong as evidence of
// which day the loan pays: after re-dating, every clean period closes on the
// 30th or 31st by construction, so the median is an artefact of our own
// arithmetic rather than a measurement of the lender's behaviour. Funding
// Circle pays in the first days of the month and would have projected onto the
// 31st, moving every future payment into the wrong month -- the exact class of
// error session 272 and 245 both paid for.
//
// The day-of-month information lives in the FILED dates, so a caller that
// re-dates its anchors passes those instead. Session 231's rule is unchanged and
// is the reason for the care: a projection's day-of-month is MEASURED, never
// inherited -- this only fixes WHICH measurement is the honest one.
export function medianDayOfMonth(dates: string[]): number | null {
  const days = (dates || [])
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))
    .map((d) => new Date(Date.parse(d + 'T00:00:00Z')).getUTCDate())
    .sort((a, b) => a - b)
  if (!days.length) return null
  return days[Math.floor(days.length / 2)]
}

// The first projected payment: the earliest date after the anchor whose day-of-month
// is the loan's payment day (clamped into short months), AND which is far enough past
// the anchor to be a genuinely different period.
//
// Both halves are load-bearing. Stepping a whole month from the anchor is wrong when
// the anchor is a mid-cycle pull -- E4-9744 anchored 2026-07-20 with a payment day of
// 9 owes its next payment on 08-09, not 08-20. But taking the next matching day
// blindly is wrong in the other direction: BayFirst SBA 2 anchors on 2026-07-31, a
// pull that ALREADY reflects that cycle's payment, and its payment day is the 2nd --
// so 2026-08-02 would project a payment two days after one just made, double-counting
// the cycle.
//
// The minimum gap is half the loan's own period. Anything closer than that to the
// anchor is the payment the anchor already shows, not the next one.
function nextPaymentOnOrAfter(anchorDate: string, dom: number, minGapDays: number): string {
  const a = new Date(Date.parse(anchorDate + 'T00:00:00Z'))
  for (let bump = 0; bump < 4; bump++) {
    const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + bump, 1))
    const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(dom, lastDom))
    const iso = d.toISOString().slice(0, 10)
    if (daysBetween(anchorDate, iso) >= minGapDays) return iso
  }
  return addDays(anchorDate, 30)
}

export interface ProjectedRow {
  row_date: string; row_type: 'payment'; payment: number; interest: number
  principal: number; balance: number; source_label: string; addl_info: string
}

export function projectRows(opts: {
  anchorDate: string; anchorBalance: number; payment: number; fit: Fit
  medianDays: number; maturity?: string | null; maxPeriods?: number
  /** The loan's measured payment day-of-month (paymentDayOfMonth). Falls back to
   *  the anchor's own day only when there is no clean period to measure from. */
  paymentDom?: number | null
  /** True when `anchorDate` is the CLOSE of a completed period rather than a pull
   *  taken at some point inside one -- which is what a re-dated `period_start`
   *  anchor always is (see anchorIsPeriodEnd's use below). */
  anchorIsPeriodEnd?: boolean
}): ProjectedRow[] {
  const { anchorDate, anchorBalance, payment, fit, medianDays, maturity } = opts
  const paymentDom = opts.paymentDom ?? null
  const maxPeriods = opts.maxPeriods ?? 240
  // Monthly loans keep their day-of-month: a fixed 30-day step drifts off the due
  // date by nearly a week within a year, and a staged transaction dated wrongly is
  // a staged transaction the CPA has to fix.
  //
  // The day-of-month is carried from the ANCHOR, not from the previous projected
  // row (session 231). Reading it from the previous row makes the clamp permanent:
  // BayFirst SBA 2 anchored on the 31st and produced Aug 31 -> Sep 30 -> Oct 30 ->
  // Nov 30 -> ... -> Feb 28 -> the 28th for the rest of the loan. Every short month
  // ratcheted the due date down and no long month ever gave the day back, which is
  // the exact drift this block exists to prevent -- just arriving by a different
  // route than a fixed 30-day step. Clamping against each month independently means
  // February borrows the day and March returns it.
  // The MEASURED payment day wins over the anchor's own day-of-month; the anchor
  // date is only where the projection starts from.
  const anchorDom = new Date(Date.parse(anchorDate + 'T00:00:00Z')).getUTCDate()
  const dom = paymentDom ?? anchorDom
  const monthly = medianDays >= 26 && medianDays <= 32
  const rows: ProjectedRow[] = []
  let bal = anchorBalance
  let date = anchorDate
  for (let k = 0; k < maxPeriods && bal > 0.005; k++) {
    const prevDate = date
    if (monthly) {
      if (k === 0) {
        // ── SESSION 274: THE MINIMUM GAP IS ABOUT AMBIGUITY, NOT DISTANCE ────
        // The half-period gap below exists because a mid-cycle PULL may already
        // reflect the payment just made, so a payment day falling a few days
        // after it is probably that same payment rather than the next one.
        //
        // A re-dated `period_start` anchor is not a pull. It is the CLOSE of a
        // completed period, so the next payment day after it is unambiguously
        // the next payment and there is nothing to disambiguate. Applying the
        // gap there skips a month: Funding Circle anchors at 2026-08-31 and pays
        // on the 1st, so 2026-09-01 sits ONE day past the anchor, was rejected,
        // and the projection jumped straight to October -- silently dropping the
        // September payment out of a schedule that gets staged into Xero.
        // A month-boundary error of exactly the kind sessions 245 and 272 paid
        // for, arriving through a guard that is correct everywhere else.
        const minGap = opts.anchorIsPeriodEnd === true ? 1 : Math.max(1, Math.round(medianDays / 2))
        date = nextPaymentOnOrAfter(anchorDate, dom, minGap)
      } else {
        const d = new Date(Date.parse(prevDate + 'T00:00:00Z'))
        d.setUTCMonth(d.getUTCMonth() + 1, 1)
        const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
        d.setUTCDate(Math.min(dom, lastDom))
        date = d.toISOString().slice(0, 10)
      }
    } else {
      date = addDays(prevDate, medianDays)
    }
    if (maturity && date > maturity) break
    const nDays = daysBetween(prevDate, date)
    const interest = r2(fit.model === 'daily_actual_365' ? bal * fit.periodic * nDays : bal * fit.periodic)
    let principal = r2(payment - interest)
    let thisPayment = payment
    // Final period: never project a payment larger than what is actually owed.
    if (principal >= bal) { principal = r2(bal); thisPayment = r2(principal + interest) }
    bal = r2(bal - principal)
    rows.push({
      row_date: date, row_type: 'payment', payment: thisPayment, interest, principal, balance: bal,
      source_label: 'derived projection',
      addl_info: `Projected from the ${anchorDate} lender balance at the measured ${fit.annual.toFixed(3)}% (${fit.model.replace(/_/g, ' ')}).`,
    })
  }
  return rows
}
