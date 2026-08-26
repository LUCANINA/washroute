import { assertEquals } from 'jsr:@std/assert@1'
import { lenderIssuedVerdict, buildSchedulePeriods, fitScheduleRate, type AmortRowLike } from './schedule-fit.ts'

// Rows below are REAL rows from loan_amortization_rows, trimmed to the shortest excerpt
// that still exercises the behaviour. The full-history figures they come from --
// Dexter Loan 2 at 6.63999892% over 59 rows and 5.88999750% over 24, Verdant at
// 8.78004007% over 83, every one to a worst error of $0.01 -- are in the session 239
// entry of PROJECT-NOTES-BOOKKEEPING.md.

const row = (row_date: string, payment: number, interest: number, principal: number, balance: number): AmortRowLike =>
  ({ row_date, row_type: 'payment', payment, interest, principal, balance })

// Dexter Loan 2 across its 2026-08-31 rate change (6.64% -> 5.89%).
const DEXTER: AmortRowLike[] = [
  row('2025-11-30', 3839.38, 656.79, 3182.59, 115514.20),
  row('2025-12-31', 3839.38, 639.18, 3200.20, 112314.00),
  row('2026-01-31', 3839.38, 621.47, 3217.91, 109096.09),
  row('2026-02-28', 3839.38, 603.67, 3235.71, 105860.38),
  row('2026-03-31', 3839.38, 585.76, 3253.62, 102606.76),
  row('2026-04-30', 3839.38, 567.76, 3271.62, 99335.14),
  row('2026-05-31', 3839.38, 549.65, 3289.73, 96045.41),
  row('2026-06-30', 3839.38, 531.45, 3307.93, 92737.48),
  row('2026-07-31', 3839.38, 513.15, 3326.23, 89411.25),
  row('2026-08-31', 3839.38, 494.74, 3344.64, 86066.61),
  { row_date: '2026-08-31', row_type: 'rate_change', rate: 5.89, interest: 0, principal: 0, balance: 0 },
  row('2026-09-30', 3810.26, 422.44, 3387.82, 82678.79),
  row('2026-10-31', 3810.26, 405.82, 3404.44, 79274.35),
  row('2026-11-30', 3810.26, 389.10, 3421.16, 75853.19),
  row('2026-12-31', 3810.26, 372.31, 3437.95, 72415.24),
  row('2027-01-31', 3810.26, 355.44, 3454.82, 68960.42),
  row('2027-02-28', 3810.26, 338.48, 3471.78, 65488.64),
]

// Verdant Capital's first fourteen rows, all at one rate.
const VERDANT: AmortRowLike[] = [
  row('2025-07-10', 4543.32, 2080.53, 2462.79, 281891.71),
  row('2025-08-10', 4543.32, 2062.51, 2480.81, 279410.90),
  row('2025-09-10', 4543.32, 2044.36, 2498.96, 276911.94),
  row('2025-10-10', 4543.32, 2026.08, 2517.24, 274394.70),
  row('2025-11-10', 4543.32, 2007.66, 2535.66, 271859.04),
  row('2025-12-10', 4543.32, 1989.11, 2554.21, 269304.83),
  row('2026-01-10', 4543.32, 1970.42, 2572.90, 266731.93),
  row('2026-02-10', 4543.32, 1951.59, 2591.73, 264140.20),
  row('2026-03-10', 4543.32, 1932.63, 2610.69, 261529.51),
]

Deno.test('our own projection is refused on any one of its three markers', () => {
  const lender = { id: 'x', amort_type: 'amortization_schedule', source: 'client_parsed_verified', storage_path: 'uuid/amortization/doc.pdf', balance_basis: 'principal_only' }
  assertEquals(lenderIssuedVerdict(lender).ok, true)
  assertEquals(lenderIssuedVerdict({ ...lender, amort_type: 'derived_flat_per_period' }).reason, 'schedule_is_our_own_projection')
  assertEquals(lenderIssuedVerdict({ ...lender, storage_path: 'derived://loan-derive-schedule/x/2026-08-24' }).reason, 'schedule_is_our_own_projection')
  assertEquals(lenderIssuedVerdict({ ...lender, source: 'derived_from_statements' }).reason, 'schedule_is_our_own_projection')
})

Deno.test('Dexter Loan 2 amort_type "Customer" is lender-issued; PayPal 2 total-payback is not', () => {
  assertEquals(lenderIssuedVerdict({ id: 'd', amort_type: 'Customer', source: 'claude_assisted_parse', storage_path: 'uuid/amortization/Dexter2.pdf', balance_basis: 'principal_only' }).ok, true)
  assertEquals(lenderIssuedVerdict({ id: 'p', amort_type: 'actual_payment_history_from_lender_csv', source: 'claude_assisted_parse', storage_path: 'uuid/amortization/paypal.csv', balance_basis: 'total_payback' }).reason, 'schedule_is_total_payback')
})

Deno.test('the opening balance comes from the row itself, not from its neighbour', () => {
  // loan_amortization_rows has no ordinal column and Dexter Loan 2 has three rows on
  // 2021-09-30, so a neighbour cannot be trusted to be the previous period.
  const { periods } = buildSchedulePeriods(DEXTER)
  assertEquals(periods[0].b0, 112314.00 + 3200.20)   // 2025-12-31: closing + principal
  assertEquals(periods[0].b1, 112314.00)
})

Deno.test('a row whose interest and principal do not add up to its payment is not evidence', () => {
  const bent = DEXTER.slice()
  bent[4] = row('2026-03-31', 3839.38, 585.76, 3200.00, 102606.76)   // 53.62 short
  const { rowProblems } = buildSchedulePeriods(bent)
  assertEquals(rowProblems.length, 1)
  assertEquals(rowProblems[0].row_date, '2026-03-31')
})

Deno.test('Dexter Loan 2 splits into its two real rate periods, and the lender printed both', () => {
  const r = fitScheduleRate(DEXTER, { asOf: '2026-08-26' })
  assertEquals(r.ok, true)
  assertEquals(r.model, 'flat_per_period')
  assertEquals(r.segments!.length, 2)
  assertEquals(r.segments![0].annual_rate_percent.toFixed(4), '6.6400')
  assertEquals(r.segments![1].annual_rate_percent.toFixed(4), '5.8900')
  assertEquals(r.segments![1].effective_from, '2026-08-31')
  assertEquals(r.segments![1].lender_stated_rate, 5.89)
  assertEquals(r.segments![1].lender_stated_agrees, true)
  assertEquals(r.published!.worst_error_dollars <= 0.05, true)
})

Deno.test('the published rate is the one in force on the as-of date, and it turns over by itself', () => {
  const on = (d: string) => fitScheduleRate(DEXTER, { asOf: d }).published!.annual_rate_percent.toFixed(3)
  assertEquals(on('2026-08-26'), '6.640')
  assertEquals(on('2026-08-30'), '6.640')
  assertEquals(on('2026-08-31'), '5.890')   // the day the lender's own rate change lands
  assertEquals(on('2026-09-01'), '5.890')
  assertEquals(on('2027-06-01'), '5.890')
})

Deno.test('a rate change still ahead of us is named out loud rather than averaged away', () => {
  const r = fitScheduleRate(DEXTER, { asOf: '2026-08-26' })
  assertEquals(r.upcoming_rate_change!.effective_from, '2026-08-31')
  assertEquals(r.upcoming_rate_change!.days_away, 5)
  assertEquals(r.upcoming_rate_change!.to_rate_percent.toFixed(3), '5.890')
  assertEquals(fitScheduleRate(DEXTER, { asOf: '2026-09-01' }).upcoming_rate_change, null)
})

Deno.test('Verdant Capital is one flat rate the lender never printed', () => {
  const r = fitScheduleRate(VERDANT, { asOf: '2026-08-26' })
  assertEquals(r.ok, true)
  assertEquals(r.model, 'flat_per_period')
  assertEquals(r.segments!.length, 1)
  assertEquals(r.published!.annual_rate_percent.toFixed(4), '8.7800')
  assertEquals(r.published!.lender_stated_rate, null)      // nothing to corroborate against
  assertEquals(r.published!.worst_error_dollars <= 0.05, true)
})

Deno.test('too few rows to measure is a refusal, not a rate from three data points', () => {
  const r = fitScheduleRate(VERDANT.slice(0, 4), { asOf: '2026-08-26' })
  assertEquals(r.ok, false)
  assertEquals(r.reason, 'not_enough_clean_rows')
})
