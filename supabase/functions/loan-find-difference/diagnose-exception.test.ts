import { assertEquals, assert } from 'jsr:@std/assert@1'
import { diagnoseWorkedEntry } from './diagnose-exception.ts'

// ─────────────────────────────────────────────────────────────────────────────
// EVERY NUMBER BELOW IS READ OFF A LIVE WALK, not off PROJECT-NOTES.
//
// Session 236 ran `loan-find-difference` against E-Transit 4140 through the real
// dashboard (loan b1008b4a…, account 242) and read the result. The previous
// version of this file was written from the notes' prose instead, and asserted a
// span gap of $415.88 that the walk shows has never existed — so it passed while
// the feature it was testing never fired on the case it was built for.
//
// What the live walk actually says:
//
//   headline / total_period_diff .......... 415.88
//   span 2026-05-28 → 2026-06-17 .......... diff +283.07   (entry win 06-02 → 06-22)
//   pair 2026-04-27 → 2026-05-28 .......... residue +132.81 ("the 2026-06 interest portion")
//   pair 2025-10-17 → 2025-12-17 .......... nets −0.01, pure
//
//   payment 2026-06-17 (0d297c29), total 1180.32, coded 242=764.44 / 800=415.88
//   splits: 2026-04 int 147.43 jnl 31ad48e9 · 2026-05 int 135.64 jnl 7ce60981
//           2026-06 int 132.81 jnl 12ef542c (dated 2026-05-18 — OUTSIDE the June span)
//
//   415.88 = 147.43 + 135.64 + 132.81
//   283.07 = 147.43 + 135.64          ← foreign months only; this is the span's gap
//   132.81 = June's own, doubled by a journal dated into a different span
// ─────────────────────────────────────────────────────────────────────────────
const FORD_4140 = {
  loanCode: '242',
  interestCode: '800',
  loanName: 'Ford E-Transit 4140',
  paymentPeriod: '2026-06',
  gap: 283.07,              // the LIVE span gap, not the headline
  ownJournalInSpan: false,  // 12ef542c is dated 2026-05-18
  postingDate: '2026-08-31',
  postingWhy: 'books are closed through 2026-06-30 and July is being closed',
  lines: [
    { c: '242', a: 764.44, d: 'Loan payment' },
    { c: '800', a: 415.88, d: 'Interest' },
  ],
  splits: [
    { period_label: '2026-03', interest_amount: 139.79, xero_manual_journal_id: null, status: 'already_in_xero' },
    { period_label: '2026-04', interest_amount: 147.43, xero_manual_journal_id: '31ad48e9-0000', status: 'posted' },
    { period_label: '2026-05', interest_amount: 135.64, xero_manual_journal_id: '7ce60981-0000', status: 'posted' },
    { period_label: '2026-06', interest_amount: 132.81, xero_manual_journal_id: '12ef542c-0000', status: 'posted' },
  ],
}

Deno.test('4140 LIVE: a $283.07 span gap decomposes into April + May, and the correction is $415.88', () => {
  const d = diagnoseWorkedEntry(FORD_4140)!
  assertEquals(d.shape, 'duplicated_reallocation')
  assertEquals(d.at_source, 415.88)
  assertEquals(d.owed, 132.81)
  // The gap is the FOREIGN months only...
  assertEquals(r2(147.43 + 135.64), Math.abs(FORD_4140.gap))
  // ...but the correction includes June's own duplicate, which lands elsewhere.
  assertEquals(d.duplicated, 415.88)
  assertEquals(d.components!.map((c) => c.period), ['2026-04', '2026-05', '2026-06'])
  assert(d.components!.every((c) => c.already_booked))
})

const r2 = (n: number) => Math.round(n * 100) / 100

Deno.test('4140 LIVE: the note says the correction reaches beyond this span', () => {
  const d = diagnoseWorkedEntry(FORD_4140)!
  assert(/surfaces in a different span/.test(d.note))
  assert(/\$132\.81/.test(d.note))
})

Deno.test('the own month is only a duplicate when a JOURNAL doubled it', () => {
  // June marked already_in_xero instead: that IS this payment's own split, not a
  // second booking. Only April + May are duplicates, and the gap still ties.
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    atSourceEvidence: () => true,
    splits: FORD_4140.splits.map((s) =>
      s.period_label === '2026-06' ? { ...s, status: 'already_in_xero', xero_manual_journal_id: null } : s),
  })!
  assertEquals(d.duplicated, 283.07)
  assertEquals(d.entry!.amount, 283.07)
})

Deno.test('an own-month duplicate whose journal IS in this span shows up in the gap', () => {
  // The mirror of 4140: same doubling, but the journal is dated inside the span,
  // so the walk sees 283.07 + 132.81 and the tie test must expect all of it.
  const d = diagnoseWorkedEntry({ ...FORD_4140, gap: 415.88, ownJournalInSpan: true })!
  assertEquals(d.entry!.amount, 415.88)
  assert(!/surfaces in a different span/.test(d.note))
})

Deno.test('the same case with ownJournalInSpan mis-set does NOT propose', () => {
  // Guard against the caller getting the flag wrong: 4140's real gap is 283.07,
  // so claiming the journal is in-span makes the expectation 415.88 and it refuses.
  const d = diagnoseWorkedEntry({ ...FORD_4140, ownJournalInSpan: true })!
  assertEquals(d.entry, null)
  assert(/Something else is moving here too/.test(d.note))
})

Deno.test('4140 LIVE: proposes a balanced entry, debit the loan, dated into the open period', () => {
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
  const e = diagnoseWorkedEntry({ ...FORD_4140, gap: -283.07 })!.entry!
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

Deno.test('already_in_xero counts as booked when Xero corroborates it', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    atSourceEvidence: () => true,   // a real split-at-source payment exists for each month
    splits: FORD_4140.splits.map((s) => ({ ...s, status: 'already_in_xero', xero_manual_journal_id: null })),
  })!
  assertEquals(d.shape, 'duplicated_reallocation')
  assert(d.components!.every((c) => c.booked_by === 'at_source'))
  // April + May are duplicates: booked at source in their own months, and on this
  // payment again. June is NOT — `already_in_xero` on the payment's own month means
  // THIS split, the one being looked at, and a thing is not a duplicate of itself.
  assertEquals(d.duplicated, 283.07)
  assertEquals(d.entry!.amount, 283.07)
  assert(/handled directly in Xero/.test(d.note))
})

Deno.test('the two routes mix freely within one split', () => {
  const d = diagnoseWorkedEntry({
    ...FORD_4140,
    atSourceEvidence: () => true,
    splits: FORD_4140.splits.map((s) =>
      s.period_label === '2026-05' ? { ...s, status: 'already_in_xero', xero_manual_journal_id: null } : s),
  })!
  assertEquals(d.duplicated, 415.88)
  assertEquals(d.components!.map((c) => c.booked_by), ['our_journal', 'at_source', 'our_journal'])
  assertEquals(d.entry!.amount, 415.88)
})

// ── PARTLY DUPLICATED, re-derived on session 236's model ──────────────────
// April never booked (pending_review, no journal). It is still a FOREIGN month, so
// its interest is still wrongly on this payment and still in the span's gap — the
// gap is unchanged at 283.07. What changes is what may be reversed: May (booked)
// and June (doubled by journal), but never April, whose only correction is her
// split. Reversing April would re-break April.
const PARTIAL = {
  ...FORD_4140,
  splits: FORD_4140.splits.map((s) =>
    s.period_label === '2026-04'
      ? { ...s, status: 'pending_review', xero_manual_journal_id: null }
      : s),
}

Deno.test('partly duplicated: reverses May + June, never April', () => {
  const d = diagnoseWorkedEntry(PARTIAL)!
  assertEquals(d.shape, 'partly_duplicated')
  assertEquals(d.at_source, 415.88)
  assertEquals(d.duplicated, 268.45) // 135.64 + 132.81
  assertEquals(d.entry!.amount, 268.45)
  assertEquals(d.entry!.JournalLines.reduce((s, l) => s + l.LineAmount, 0), 0)
  assert(/2026-05, 2026-06/.test(d.entry!.Narration))
  assert(!/2026-04/.test(d.entry!.Narration))
})

Deno.test('partly duplicated: names the carry-over and says why it stays', () => {
  const d = diagnoseWorkedEntry(PARTIAL)!
  assertEquals(d.carry_over, { amount: 147.43, months: ['2026-04'] })
  assert(/never been booked at all/.test(d.note))
  assert(/re-break/.test(d.note))
})

Deno.test('a gap that disagrees with the decomposition proposes nothing', () => {
  const d = diagnoseWorkedEntry({ ...FORD_4140, gap: 900.00 })!
  assertEquals(d.entry, null)
  assert(/Something else is moving here too/.test(d.note))
})

Deno.test('a fully-duplicated diagnosis carries no carry-over', () => {
  assertEquals(diagnoseWorkedEntry(FORD_4140)!.carry_over, null)
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

Deno.test('a lone own-month duplicate is invisible unless its journal is in this span', () => {
  const one = { ...FORD_4140, lines: [{ c: '800', a: 132.81 }], gap: 132.81 }
  // Journal dated elsewhere: no foreign months, so this span should be off by $0 —
  // the 132.81 the walk sees must be something else. Refuse.
  assertEquals(diagnoseWorkedEntry(one)!.entry, null)
  // Journal inside this span: now the gap is exactly the duplicate. Propose.
  const d = diagnoseWorkedEntry({ ...one, ownJournalInSpan: true })!
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

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER TWO FORD LOANS — read off the same live lender-level run that
// produced the 4140 numbers above. All three turned out to be the same shape:
// the accountant catching several months of interest up on one payment.
// ─────────────────────────────────────────────────────────────────────────────

// E5-4751. The one that caught the bug. Payment 2026-05-12 coded 332=498.74 /
// 800=548.21; span 2026-04-22 → 2026-05-12 off by +281.79; loan $266.42 above
// the lender overall.
//
//   2026-04 $281.79  already_in_xero, NO journal — and no April booking exists
//                    anywhere in Xero: that month's own payment (2026-04-13) is a
//                    single unsplit line of $1,046.95. The marker is a note about
//                    THIS catch-up, not evidence of a prior booking.
//   2026-05 $266.42  journal 85c70a85, dated 2026-04-13 — outside this span.
//
// So only May is a duplicate. Reversing $548.21 would push the loan $281.79 BELOW
// its lender.
const FORD_4751 = {
  loanCode: '332',
  interestCode: '800',
  loanName: 'E-Transit Loan E5-4751',
  paymentPeriod: '2026-05',
  gap: 281.79,
  ownJournalInSpan: false,
  postingDate: '2026-08-31',
  postingWhy: 'books are closed through 2026-06-30 and July is being closed',
  lines: [{ c: '332', a: 498.74 }, { c: '800', a: 548.21 }],
  splits: [
    { period_label: '2026-03', interest_amount: 260.54, xero_manual_journal_id: null, status: 'already_in_xero' },
    { period_label: '2026-04', interest_amount: 281.79, xero_manual_journal_id: null, status: 'already_in_xero' },
    { period_label: '2026-05', interest_amount: 266.42, xero_manual_journal_id: '85c70a85-0000', status: 'posted' },
  ],
  // Xero holds split-at-source payments for Jan/Feb/Mar (301.17 / 294.84 /
  // 260.54) and nothing at all for April.
  atSourceEvidence: (interest: number) => [301.17, 294.84, 260.54].some((x) => Math.abs(x - interest) < 0.02),
}

Deno.test('4751 LIVE: an uncorroborated already_in_xero month is NOT reversed', () => {
  const d = diagnoseWorkedEntry(FORD_4751)!
  assertEquals(d.at_source, 548.21)
  assertEquals(d.owed, 266.42)
  // April is downgraded: marked handled, but nothing in Xero books it.
  const apr = d.components!.find((c) => c.period === '2026-04')!
  assertEquals(apr.already_booked, false)
  assertEquals(apr.booked_by, 'at_source_unverified')
  assertEquals(d.duplicated, 266.42)
  assertEquals(d.carry_over, { amount: 281.79, months: ['2026-04'] })
})

Deno.test('4751 LIVE: the entry matches the loan\'s actual variance, and never overshoots', () => {
  const d = diagnoseWorkedEntry(FORD_4751)!
  // $266.42 is exactly how far 4751 sits above its lender. $548.21 would overshoot
  // by $281.79 and push it below — the bug this fixture exists to prevent.
  assertEquals(d.entry!.amount, 266.42)
  assertEquals(d.entry!.JournalLines.reduce((s, l) => s + l.LineAmount, 0), 0)
  assertEquals(d.entry!.JournalLines.find((l) => l.AccountCode === '332')!.LineAmount, 266.42)
  assert(/no separate transaction actually books/.test(d.note))
})

Deno.test('4751: with corroboration for April, it DOES reverse both months', () => {
  // Same inputs, except Xero really does show an April split-at-source. Then both
  // months are genuine duplicates and $548.21 is the right answer — April's share
  // is the span's gap, May's lands in the span its journal is dated into, exactly
  // as on 4140. The entire difference between this and the live case is whether
  // that April booking actually exists. It does not, which is the whole point:
  // the marker is a claim, and the claim decides how much money moves.
  const d = diagnoseWorkedEntry({ ...FORD_4751, atSourceEvidence: () => true })!
  assertEquals(d.duplicated, 548.21)
  assertEquals(d.entry!.amount, 548.21)
  assertEquals(d.carry_over, null)
})

// E4-9744. Payment 2026-05-11 coded 244=793.81 / 800=350.74; span 2026-04-19 →
// 2026-05-09 off by +181.97 against a schedule that says 181.99. Two cents.
const FORD_9744 = {
  loanCode: '244',
  interestCode: '800',
  loanName: 'E-Transit Loan E4 -9744',
  paymentPeriod: '2026-05',
  gap: 181.97,
  ownJournalInSpan: false,
  postingDate: '2026-08-31',
  postingWhy: 'books are closed through 2026-06-30 and July is being closed',
  lines: [{ c: '244', a: 793.81 }, { c: '800', a: 350.74 }],
  splits: [
    { period_label: '2026-04', interest_amount: 181.99, xero_manual_journal_id: 'f49a48db-0000', status: 'posted' },
    { period_label: '2026-05', interest_amount: 168.77, xero_manual_journal_id: null, status: 'already_in_xero' },
  ],
  atSourceEvidence: () => false,
}

Deno.test('9744 LIVE: two cents of walk drift does not block the diagnosis', () => {
  const d = diagnoseWorkedEntry(FORD_9744)!
  assertEquals(d.at_source, 350.74)
  assertEquals(d.owed, 168.77)
  // April was journalled; May is the payment's own month, so its already_in_xero
  // marker refers to THIS split and is never a duplicate of itself.
  assertEquals(d.duplicated, 181.99)
  assertEquals(d.entry!.amount, 181.99)   // the split's exact figure, not the walk's 181.97
})

Deno.test('9744: the slack is two cents, not two dollars', () => {
  assertEquals(diagnoseWorkedEntry({ ...FORD_9744, gap: 181.50 })!.entry, null)
  assertEquals(diagnoseWorkedEntry({ ...FORD_9744, gap: 181.95 })!.entry!.amount, 181.99)
})
