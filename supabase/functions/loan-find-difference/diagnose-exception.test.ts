import { assertEquals, assert } from 'jsr:@std/assert@1'
import { diagnoseWorkedEntry } from './diagnose-exception.ts'

// The live case this was built from: E-Transit 4140, 2026-06-17.
// Payment $1,180.32 coded $764.44 to the loan and $415.88 to Interest Expense.
// $415.88 = April 147.43 + May 135.64 + June 132.81 — all three already
// reallocated by journals. The loan fell $631.63 instead of $1,047.51.
const FORD_4140 = {
  loanCode: '242',
  interestCode: '800',
  loanName: 'Ford E-Transit 4140',
  paymentPeriod: '2026-06',
  gap: 415.88,
  postingDate: '2026-08-31',
  postingWhy: 'books are closed through 2026-06-30 and July is being closed',
  lines: [
    { c: '242', a: 764.44, d: 'Loan payment' },
    { c: '800', a: 415.88, d: 'Interest' },
  ],
  splits: [
    { period_label: '2026-03', interest_amount: 151.20, xero_manual_journal_id: 'aaaaaaaa-1', status: 'posted' },
    { period_label: '2026-04', interest_amount: 147.43, xero_manual_journal_id: '31ad48e9-0000', status: 'posted' },
    { period_label: '2026-05', interest_amount: 135.64, xero_manual_journal_id: '7ce60981-0000', status: 'posted' },
    { period_label: '2026-06', interest_amount: 132.81, xero_manual_journal_id: '12ef542c-0000', status: 'posted' },
  ],
}

Deno.test('4140: decomposes $415.88 into the three months that were already reallocated', () => {
  const d = diagnoseWorkedEntry(FORD_4140)!
  assertEquals(d.shape, 'duplicated_reallocation')
  assertEquals(d.at_source, 415.88)
  assertEquals(d.owed, 132.81)
  assertEquals(d.duplicated, 415.88)
  assertEquals(d.components!.map((c) => c.period), ['2026-04', '2026-05', '2026-06'])
  assert(d.components!.every((c) => c.reallocated))
})

Deno.test('4140: proposes a balanced entry, debit the loan, dated into the open period', () => {
  const e = diagnoseWorkedEntry(FORD_4140)!.entry!
  assertEquals(e.amount, 415.88)
  assertEquals(e.direction, 'interest_back_to_loan')
  assertEquals(e.Date, '2026-08-31')
  assertEquals(e.JournalLines.length, 2)
  // Balanced.
  assertEquals(e.JournalLines.reduce((s, l) => s + l.LineAmount, 0), 0)
  // Debit 242 (positive) / credit 800 (negative) — brings the loan DOWN.
  const loanLine = e.JournalLines.find((l) => l.AccountCode === '242')!
  const intLine = e.JournalLines.find((l) => l.AccountCode === '800')!
  assertEquals(loanLine.LineAmount, 415.88)
  assertEquals(intLine.LineAmount, -415.88)
  // Names the journals that already did the work.
  assert(/31ad48e9/.test(diagnoseWorkedEntry(FORD_4140)!.note))
  assert(/7ce60981/.test(diagnoseWorkedEntry(FORD_4140)!.note))
  assert(/12ef542c/.test(diagnoseWorkedEntry(FORD_4140)!.note))
})

Deno.test('the mirror: Xero below the lender reverses the direction', () => {
  const e = diagnoseWorkedEntry({ ...FORD_4140, gap: -415.88 })!.entry!
  assertEquals(e.direction, 'interest_out_of_loan')
  assertEquals(e.JournalLines.find((l) => l.AccountCode === '242')!.LineAmount, -415.88)
  assertEquals(e.JournalLines.find((l) => l.AccountCode === '800')!.LineAmount, 415.88)
})

// ── The guards. Each of these is a shape that MUST NOT produce an entry. ──

Deno.test('no journal on any component: her split is the only correction — nothing proposed', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) => ({ ...s, xero_manual_journal_id: null })),
  })!
  assertEquals(d.shape, 'no_duplication')
  assertEquals(d.duplicated, 0)
  assertEquals(d.entry, null)
})

Deno.test('only some months reallocated: two halves need different answers — nothing proposed', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) =>
      s.period_label === '2026-04' ? { ...s, xero_manual_journal_id: null } : s),
  })!
  assertEquals(d.shape, 'partly_duplicated')
  assertEquals(d.duplicated, 268.45) // 135.64 + 132.81
  assertEquals(d.entry, null)
})

Deno.test('a split whose journal never reached Xero is not evidence', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) => ({ ...s, status: 'pending_review' })),
  })!
  assertEquals(d.shape, 'no_duplication')
  assertEquals(d.entry, null)
})

Deno.test('duplication that does not equal the span gap proposes nothing', () => {
  const d = diagnoseWorkedEntry({ ...FORD_4140, gap: 900.00 })!
  assertEquals(d.entry, null)
  assert(/something else is moving here too/.test(d.note))
})

Deno.test('an at-source figure that is not a run of consecutive months is undecomposable', () => {
  const d = diagnoseWorkedEntry({ ...FORD_4140, lines: [{ c: '800', a: 401.11 }] })!
  assertEquals(d.shape, 'undecomposable')
  assertEquals(d.components, null)
  assertEquals(d.entry, null)
})

Deno.test('no interest line at all is a different shape of hand-edit — not ours', () => {
  assertEquals(diagnoseWorkedEntry({ ...FORD_4140, lines: [{ c: '242', a: 1180.32 }] }), null)
})

Deno.test('a single month that was already reallocated still works', () => {
  const d = diagnoseWorkedEntry({ ...FORD_4140, lines: [{ c: '800', a: 132.81 }], gap: 132.81 })!
  assertEquals(d.shape, 'duplicated_reallocation')
  assertEquals(d.components!.map((c) => c.period), ['2026-06'])
  assertEquals(d.entry!.amount, 132.81)
})

Deno.test('lookback is bounded — it never reaches back further than maxLookback months', () => {
  const many = Array.from({ length: 24 }, (_, i) => ({
    period_label: `2025-${String(i % 12 + 1).padStart(2, '0')}`,
    interest_amount: 100, xero_manual_journal_id: 'j', status: 'posted',
  }))
  // 1500 would need 15 months of lookback; the cap is 12.
  const d = diagnoseWorkedEntry({
    ...FORD_4140, paymentPeriod: '2025-12', splits: many,
    lines: [{ c: '800', a: 1500 }], gap: 1500, maxLookback: 12,
  })!
  assertEquals(d.shape, 'undecomposable')
})

Deno.test('splits after the payment period are never components', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: [...FORD_4140.splits, { period_label: '2026-07', interest_amount: 130.0, xero_manual_journal_id: 'future', status: 'posted' }],
  })!
  assertEquals(d.components!.map((c) => c.period), ['2026-04', '2026-05', '2026-06'])
})
