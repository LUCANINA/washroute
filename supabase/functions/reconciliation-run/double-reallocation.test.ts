// Regression fixtures for checkDoubleReallocation.
//
// Case 1 is the bug that shipped: 33 false "corrected twice" findings in a single run,
// every one of them a payment blamed for its NEIGHBOUR's reallocation journal because
// the old pairing rule was "any journal within ±40 days". On a monthly loan that window
// covers the months either side. Keep this test passing and that cannot recur.
import { assertEquals } from 'jsr:@std/assert@1'
import { checkDoubleReallocation } from './double-reallocation.ts'

const loan = (code: string, name: string) => ({ id: 'loan-' + code, xero_account_code: code, xero_account_name: name, ingestion_method: 'manual', status: 'active' })
const txn = (id: string, date: string, total: number, lines: [string, number][]) =>
  ({ srcId: id, srcType: 'BankTransaction', type: 'SPEND', date, total, lines: lines.map(([c, a]) => ({ c, a })) })
const jnl = (id: string, date: string, lines: [string, number][]) =>
  ({ srcId: id, srcType: 'ManualJournal', date, total: 0, lines: lines.map(([c, a]) => ({ c, a })) })
const split = (o: any) => ({ id: 'split-' + o.period_label, status: 'posted', voided_at: null, ...o })

Deno.test('a neighbouring month\'s journal is not this payment\'s second correction', () => {
  // BayFirst SBA 2, exactly as it stood on 2026-08-25. Three monthly payments; only the
  // July one was lumped and journalled. June and August were split at source, correctly,
  // once each. The old check reported BOTH of them as "corrected twice" — and put the
  // July journal's $1,300.30 against each.
  const ledger = { '251': [
    txn('jun', '2026-06-03', 2108.25, [['251', 714.06], ['800', 1394.19]]),
    txn('jul', '2026-07-03', 2108.25, [['251', 2108.25]]),
    txn('aug', '2026-08-03', 2108.24, [['251', 858.66], ['800', 1249.58]]),
    jnl('j-jul', '2026-07-03', [['800', 1300.30], ['251', -1300.30]]),
  ] }
  const splits = [split({ period_label: '2026-07-02', interest_amount: 1300.30,
    matched_xero_bank_transaction_id: 'jul', xero_manual_journal_id: 'j-jul' })]
  assertEquals(checkDoubleReallocation(loan('251', 'BayFirst SBA 2'), ledger, splits), [])
})

Deno.test('a journal that TOPS UP a partial split is not a double count', () => {
  // Rapid Credit Line 2026-03-31: $742.60 of interest on the transaction itself, plus a
  // $480.00 journal. The period's real interest is $1,222.60 — exactly the sum. The
  // journal finished the split; it did not repeat it.
  const ledger = { '247': [
    txn('t', '2026-03-31', 2068.89, [['247', 1326.29], ['800', 742.60]]),
    jnl('j', '2026-03-31', [['247', -480], ['800', 480]]),
  ] }
  const splits = [split({ period_label: '2026-03-31', interest_amount: 1222.60,
    matched_xero_bank_transaction_id: 't', xero_manual_journal_id: 'j' })]
  assertEquals(checkDoubleReallocation(loan('247', 'Rapid Credit Line'), ledger, splits), [])
})

Deno.test('the real thing: split at source AND journalled, beyond what the period owes', () => {
  // Funding Circle 2026-07-20, the case that motivated the check. Split at source on
  // 2026-08-11 ($1,023.20 to interest) while journal #52216 of 2026-08-05 had already
  // moved $1,008.06 of the same payment. Net: $2.51 against a $2,033.77 loan payment.
  const ledger = { '396': [
    txn('t', '2026-07-20', 2033.77, [['396', 1010.57], ['800', 1023.20]]),
    jnl('j', '2026-08-05', [['396', -1008.06], ['800', 1008.06]]),
  ] }
  const splits = [split({ period_label: '2026-07', interest_amount: 1023.20,
    matched_xero_bank_transaction_id: 't', xero_manual_journal_id: 'j' })]
  const out = checkDoubleReallocation(loan('396', 'Funding Circle Loan'), ledger, splits)
  assertEquals(out.length, 1)
  assertEquals(out[0].check_key, 'double_reallocation')
  assertEquals(out[0].detail.overstated_by, 1008.06)
  // Never emit an impossible number. The old check reported principal remainders of
  // -$586.24 and -$3,562.28 and nobody noticed, which is how it reached production.
  assertEquals(out[0].detail.overstated_by <= out[0].detail.total, true)
})

Deno.test('two periods booked against one payment is its own finding', () => {
  // E-Transit 4140: the 2026-05 and 2026-06 splits both point at the 2026-05-18 bank
  // transaction, so two journals landed on one $1,180.32 payment and the June payment
  // was never corrected at all.
  const ledger = { '242': [txn('may', '2026-05-18', 1180.32, [['242', 1180.32]])] }
  const splits = [
    split({ period_label: '2026-05', interest_amount: 135.64, matched_xero_bank_transaction_id: 'may', xero_manual_journal_id: 'j1' }),
    split({ period_label: '2026-06', interest_amount: 132.81, matched_xero_bank_transaction_id: 'may', xero_manual_journal_id: 'j2' }),
  ]
  const out = checkDoubleReallocation(loan('242', 'E-Transit Loan - 4140'), ledger, splits)
  assertEquals(out.length, 1)
  assertEquals(out[0].check_key, 'split_collision')
  assertEquals(out[0].detail.periods, ['2026-05', '2026-06'])
})
