// Regression fixtures for adjustment-patterns.ts.
//
// Case fixtures are the real Paypal 2 journals from session 258's investigation --
// seven hand-posted corrections over seven months, three different narrations for one
// underlying habit (Xero's bank rule applied every auto-draft entirely to principal;
// the CPA reclassed the interest portion back at month end).
import { assertEquals } from 'jsr:@std/assert@1'
import { matchAgainstPatterns, clusterCandidates, splitRowForMatch, type AdjustmentPattern, type PatternJournal } from './adjustment-patterns.ts'

const J = (id: string, date: string, narration: string, principal284: number): PatternJournal => ({
  srcId: id, date, narration,
  lines: [{ c: '284', a: principal284 }, { c: '800', a: -principal284 }],
})
const journals = [
  J('670f3dbe', '2026-01-31', 'To record adjustment interest of Paypal Loan 2 to match end balance Jan 26', 59.59),
  J('b0b4a203', '2026-02-28', 'To record adjustment interest of Paypal Loan 2 to match end balance Feb 26', 2544.96),
  J('0d080de1', '2026-03-31', 'To record adjustment interest of Paypal Loan 2 to match end balance Feb 26', 5746.93),
  J('e4d26ad1', '2026-04-30', 'To record adjustment interest of Paypal Loan 2 to match end balance Feb 26', -4219.54),
  J('a8bbccca', '2026-05-31', 'To reverse part of the adjustment from march (see note)', 9700.61),
  J('5351abb3', '2026-06-30', 'To record adjustment interest of Paypal Loan 2 to match end balance Feb 26', 1859.69),
  J('a2c49ead', '2026-07-31', 'To reclass the payment made for paypal', 3142.26),
]

Deno.test('clustering finds the 5-member "match end balance" group and leaves the other 2 as singletons', () => {
  const clusters = clusterCandidates(journals, '284')
  assertEquals(clusters.length, 1)
  assertEquals(clusters[0].journals.length, 5)
})

Deno.test('a sign flip (April\'s credit instead of debit) still belongs to the same account-pair cluster', () => {
  // April is the negative instance -- the group key must not be direction-sensitive.
  const april = journals[3]
  const clusters = clusterCandidates(journals, '284')
  const memberIds = clusters[0].journals.map(j => j.srcId)
  assertEquals(memberIds.includes(april.srcId), true)
})

Deno.test('a confirmed pattern with all three narration variants recognizes all 7 journals', () => {
  const pattern: AdjustmentPattern = {
    id: 'p1', loan_account_id: 'loan', label: 'test',
    debit_account_code: '284', credit_account_code: '800',
    narration_signatures: ['to match end balance', 'reclass the payment made for paypal', 'reverse part of the adjustment from march'],
    status: 'active',
  }
  const { matched, unmatched } = matchAgainstPatterns(journals, [pattern])
  assertEquals(matched.length, 7)
  assertEquals(unmatched.length, 0)
})

Deno.test('a matching narration on the WRONG account pair never matches', () => {
  const pattern: AdjustmentPattern = {
    id: 'p1', loan_account_id: 'loan', label: 'test',
    debit_account_code: '284', credit_account_code: '800',
    narration_signatures: ['to match end balance'], status: 'active',
  }
  const wrongAccount: PatternJournal = {
    srcId: 'x', date: '2026-08-31', narration: 'to match end balance Aug 26',
    lines: [{ c: '515', a: 100 }, { c: '800', a: -100 }],
  }
  assertEquals(matchAgainstPatterns([wrongAccount], [pattern]).matched.length, 0)
})

Deno.test('a three-line journal never matches or clusters, even with a perfect narration hit', () => {
  const pattern: AdjustmentPattern = {
    id: 'p1', loan_account_id: 'loan', label: 'test',
    debit_account_code: '284', credit_account_code: '800',
    narration_signatures: ['to match end balance'], status: 'active',
  }
  const threeLine: PatternJournal = {
    srcId: 'y', date: '2026-08-31', narration: 'to match end balance Aug 26',
    lines: [{ c: '284', a: 100 }, { c: '800', a: -60 }, { c: '999', a: -40 }],
  }
  assertEquals(matchAgainstPatterns([threeLine], [pattern]).matched.length, 0)
  assertEquals(clusterCandidates([threeLine, threeLine], '284').length, 0)
})

Deno.test('a dormant pattern is never matched -- confirming a pattern does not mean it stays active forever', () => {
  const dormant: AdjustmentPattern = {
    id: 'p1', loan_account_id: 'loan', label: 'test',
    debit_account_code: '284', credit_account_code: '800',
    narration_signatures: ['to match end balance'], status: 'dormant',
  }
  assertEquals(matchAgainstPatterns([journals[0]], [dormant]).matched.length, 0)
})

Deno.test('splitRowForMatch produces a net-zero reclassification with the right sign', () => {
  const row = splitRowForMatch('284', journals[6])  // the July $3,142.26 entry
  assertEquals(row?.principal_amount, 3142.26)
  assertEquals(row?.interest_amount, -3142.26)
  assertEquals(row?.total_amount, 0)
  assertEquals(row?.source, 'manual_adjustment')
  assertEquals(row?.xero_manual_journal_id, 'a2c49ead')
})
