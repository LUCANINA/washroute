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
  assert(d.components!.every((c) => c.already_booked))
  assert(d.components!.every((c) => c.booked_by === 'our_journal'))
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
    splits: FORD_4140.splits.map((s) => ({ ...s, xero_manual_journal_id: null, status: 'pending_review' })),
  })!
  assertEquals(d.shape, 'no_duplication')
  assertEquals(d.duplicated, 0)
  assertEquals(d.entry, null)
})

Deno.test('a split whose journal never reached Xero is not evidence', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) => ({ ...s, status: 'pending_review', xero_manual_journal_id: null })),
  })!
  assertEquals(d.shape, 'no_duplication')
  assertEquals(d.entry, null)
})

// ── session 235: the two ways a month can already be booked ────────────────
// Verified against production before being trusted: an `already_in_xero` split
// carries NO journal id, and every one sampled across loans 242 / 332 / 338 /
// 243 resolves to a bank transaction split AT SOURCE for exactly the
// principal/interest the split row records. Reading it as "never booked" — which
// the first draft did — would leave a real duplicate unreversed.

Deno.test('already_in_xero counts as booked even with no journal id', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) => ({ ...s, status: 'already_in_xero', xero_manual_journal_id: null })),
  })!
  assertEquals(d.shape, 'duplicated_reallocation')
  assertEquals(d.duplicated, 415.88)
  assert(d.components!.every((c) => c.booked_by === 'at_source'))
  assertEquals(d.entry!.amount, 415.88)
  assert(/handled directly in Xero/.test(d.note))
})

Deno.test('the two routes mix freely within one split', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    splits: FORD_4140.splits.map((s) =>
      s.period_label === '2026-05' ? { ...s, status: 'already_in_xero', xero_manual_journal_id: null } : s),
  })!
  assertEquals(d.duplicated, 415.88)
  assertEquals(d.components!.map((c) => c.booked_by), ['our_journal', 'at_source', 'our_journal'])
  assertEquals(d.entry!.amount, 415.88)
})

// ── session 235: PARTLY DUPLICATED — the case this session was for ─────────

// April was never booked (pending_review, no journal). May and June were.
// Her split covers all three; only May + June are duplicates. The span's gap is
// $268.45 — the duplicated part alone — which is how we know April's share is
// not in question here.
const PARTIAL = {
  ...FORD_4140,
  gap: 268.45,
  splits: FORD_4140.splits.map((s) =>
    s.period_label === '2026-04'
      ? { ...s, status: 'pending_review', xero_manual_journal_id: null }
      : s),
}

Deno.test('partly duplicated: reverses only the months that were already booked', () => {
  const d = diagnoseWorkedEntry(PARTIAL)!
  assertEquals(d.shape, 'partly_duplicated')
  assertEquals(d.at_source, 415.88)
  assertEquals(d.duplicated, 268.45) // 135.64 + 132.81
  assertEquals(d.entry!.amount, 268.45)
  assertEquals(d.entry!.JournalLines.reduce((s, l) => s + l.LineAmount, 0), 0)
  assertEquals(d.entry!.JournalLines.find((l) => l.AccountCode === '242')!.LineAmount, 268.45)
})

Deno.test('partly duplicated: names the carry-over and says why it stays', () => {
  const d = diagnoseWorkedEntry(PARTIAL)!
  assertEquals(d.carry_over, { amount: 147.43, months: ['2026-04'] })
  assert(/never been booked at all/.test(d.note))
  assert(/re-break/.test(d.note))
  // The narration must name only the months actually being reversed.
  assert(/2026-05, 2026-06/.test(d.entry!.Narration))
  assert(!/2026-04/.test(d.entry!.Narration))
})

Deno.test('partly duplicated that does NOT tie to the gap proposes nothing', () => {
  // Gap is the whole $415.88, so the never-booked month IS in this span too —
  // reversing $268.45 alone would leave the loan out by $147.43.
  const d = diagnoseWorkedEntry({ ...PARTIAL, gap: 415.88 })!
  assertEquals(d.shape, 'partly_duplicated')
  assertEquals(d.entry, null)
  assert(/would leave the loan out by \$147\.43/.test(d.note))
})

Deno.test('a fully-duplicated diagnosis carries no carry-over', () => {
  assertEquals(diagnoseWorkedEntry(FORD_4140)!.carry_over, null)
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
