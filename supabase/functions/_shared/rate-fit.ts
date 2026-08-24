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
export function currentRegime(ps: Period[], model: RateModel, tol = 0.001): {
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

export interface ProjectedRow {
  row_date: string; row_type: 'payment'; payment: number; interest: number
  principal: number; balance: number; source_label: string; addl_info: string
}

export function projectRows(opts: {
  anchorDate: string; anchorBalance: number; payment: number; fit: Fit
  medianDays: number; maturity?: string | null; maxPeriods?: number
}): ProjectedRow[] {
  const { anchorDate, anchorBalance, payment, fit, medianDays, maturity } = opts
  const maxPeriods = opts.maxPeriods ?? 240
  // Monthly loans keep their day-of-month: a fixed 30-day step drifts off the due
  // date by nearly a week within a year, and a staged transaction dated wrongly is
  // a staged transaction the CPA has to fix.
  const monthly = medianDays >= 26 && medianDays <= 32
  const rows: ProjectedRow[] = []
  let bal = anchorBalance
  let date = anchorDate
  for (let k = 0; k < maxPeriods && bal > 0.005; k++) {
    const prevDate = date
    if (monthly) {
      const d = new Date(Date.parse(prevDate + 'T00:00:00Z'))
      const dom = d.getUTCDate()
      d.setUTCMonth(d.getUTCMonth() + 1, 1)
      const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
      d.setUTCDate(Math.min(dom, lastDom))
      date = d.toISOString().slice(0, 10)
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
