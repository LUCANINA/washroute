// tests/existing-deposit.test.mts — the guard that would have stopped the
// 2026-09-03 double-post, and proof that each half of it discriminates.
//
// Run:  npx tsx tests/existing-deposit.test.mts

import { findConflictingDeposit } from '../supabase/functions/_shared/existing-deposit.ts'

const BANK = '8fd57c83-6519-442b-a34f-26adb9343429'
const REF = 'Stripe payout po_1TvoN0GACgbvEugHBUZlA2Fs'
const AMT = 10630.05

// The real shapes, taken from what Xero actually returned on 2026-09-03.
const feedDeposit = {
  BankTransactionID: 'ce40f5c4-8cb8-4767-a86d-bb0c07812a33',
  Status: 'AUTHORISED', Total: AMT, Reference: null, IsReconciled: true,
  BankAccount: { AccountID: BANK }, Contact: { Name: 'Family Laundry' },
}
const ourDeletedTwin = {
  BankTransactionID: '633d4439-f389-48bd-ae0e-634b263bbb3e',
  Status: 'DELETED', Total: AMT, Reference: REF, IsReconciled: false,
  BankAccount: { AccountID: BANK }, Contact: { Name: 'Stripe' },
}
const ourLiveTxn = { ...ourDeletedTwin, Status: 'AUTHORISED' }

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const find = (txns: any[]) => findConflictingDeposit(txns, { bankAccountId: BANK, amount: AMT, ourReference: REF })

console.log('\n  the case that actually happened')
// THE regression. On 2026-09-03 this returned nothing, because the only question
// asked was "does a transaction carry our reference?" and a feed deposit has none.
ok('a bank-feed deposit with NO reference is a conflict',
  find([feedDeposit])?.BankTransactionID === feedDeposit.BankTransactionID)
ok('...and it is named, so the refusal can quote the contact',
  find([feedDeposit])?.Contact?.Name === 'Family Laundry')
ok('nothing at all is not a conflict — the live path must stay open',
  find([]) === null)

console.log('\n  each rejection discriminates (remove the reason, the answer flips)')
// A DELETED twin exists on this book right now. Counting it would block the very
// repair that removes a double-post — the failure mode is "can never be fixed".
ok('a DELETED twin is NOT a conflict', find([ourDeletedTwin]) === null)
ok('...but the SAME row AUTHORISED and without our reference IS',
  find([{ ...ourDeletedTwin, Status: 'AUTHORISED', Reference: null }]) !== null,
  'so the status test is doing work, not decoration')

ok('our own live transaction is NOT a conflict (the reference pre-check owns it)',
  find([ourLiveTxn]) === null)
ok('...but strip the reference and it IS',
  find([{ ...ourLiveTxn, Reference: null }]) !== null,
  'so the reference test is doing work')

ok('a same-amount deposit on ANOTHER bank account is not a conflict',
  find([{ ...feedDeposit, BankAccount: { AccountID: 'ffffffff-0000-0000-0000-000000000000' } }]) === null)
ok('...and moving it back onto our account makes it one',
  find([{ ...feedDeposit, BankAccount: { AccountID: BANK.toUpperCase() } }]) !== null,
  'account id compare is case-insensitive, as Xero mixes case')

ok('a different amount is not a conflict', find([{ ...feedDeposit, Total: 9999.99 }]) === null)
ok('one cent out is STILL a conflict (tolerance is 2c, not exactness)',
  find([{ ...feedDeposit, Total: AMT + 0.01 }]) !== null)
ok('three cents out is not', find([{ ...feedDeposit, Total: AMT + 0.03 }]) === null)

console.log('\n  shapes that must not crash or fail open')
ok('null list is not a conflict', findConflictingDeposit(null, { bankAccountId: BANK, amount: AMT, ourReference: REF }) === null)
ok('a Total arriving as a string still matches (PostgREST/Xero both do this)',
  find([{ ...feedDeposit, Total: '10630.05' as any }]) !== null)
ok('a non-numeric Total is skipped rather than matching NaN',
  find([{ ...feedDeposit, Total: 'n/a' as any }]) === null)
ok('a missing BankAccount is skipped, not treated as ours',
  find([{ ...feedDeposit, BankAccount: undefined }]) === null)
ok('the DELETED twin does not hide a real conflict later in the list',
  find([ourDeletedTwin, feedDeposit])?.BankTransactionID === feedDeposit.BankTransactionID)

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
