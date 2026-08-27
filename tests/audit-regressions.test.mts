// tests/audit-regressions.test.mts — the eight defects the session-242 audit found.
//
// Every case below was REPRODUCED against the real modules before it was fixed.
// None of them was hypothetical, and none was caught by the 396 assertions that
// existed at the time — which is the point of writing them down here.
//
// Run:  npx tsx tests/audit-regressions.test.mts

import { checkPortalTotals, mergePortal } from '../supabase/functions/_shared/portal-figures.ts'
import { findOriginationFeeJournal, normaliseLedgerEntry } from '../supabase/functions/_shared/origination-fee.ts'
import { matchLoan } from '../supabase/functions/_shared/loan-matcher.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const blank = (o: any = {}): any => ({
  as_of: null, amount_remaining: null, paid_to_date: null, principal_paid: null,
  fee_paid: null, total_amount_due: null, funds_deposited: null, funds_deposited_date: null,
  sources: [], checks: [], warnings: [], disputes: [], corroborated: [], ...o })

section('A — the derived sum must not launder the $125,000 misread')
{
  // On this loan total = funding + fee BY CONSTRUCTION (145,875 = 125,000 +
  // 20,875). So a screen reporting the DEPOSIT as the balance and the printed
  // "Fixed Fee" as fee_paid satisfies total − (0 + fee) = remaining identically,
  // by algebra rather than by evidence. The guard tested "is amount_remaining
  // corroborated?" and the derived path had just answered yes.
  const dep = checkPortalTotals(blank({ sources: ['Stripe deposit.png'],
    funds_deposited: 125000, amount_remaining: 125000, total_amount_due: 145875,
    principal_paid: 0, fee_paid: 20875 }))
  ok('the funding figure is still dropped', dep.amount_remaining === null, String(dep.amount_remaining))
  ok('the funding guard fires', dep.warnings.some((w: any) => /read twice on a funding screen/.test(w.detail)))
  ok('and its corroboration is withdrawn with it', !dep.corroborated.includes('amount_remaining'))

  // The consequence that made it critical: it beat the truth in the merge.
  const truth = blank({ sources: ['overview.png'], amount_remaining: 145875 })
  ok('the true balance survives the merge', mergePortal(truth, dep).amount_remaining === 145875)

  // A stated, non-zero sum still proves a balance — the fix must not break that.
  const real = checkPortalTotals(blank({ sources: ['ov.png'],
    total_amount_due: 145875, paid_to_date: 22783.34, amount_remaining: 123091.66 }))
  ok('a genuinely proven balance is untouched', real.amount_remaining === 123091.66)
  ok('...and still counts as proven', real.corroborated.includes('amount_remaining'))
}

section('B — a zero sum proves nothing')
{
  // total − 0 = remaining collapses to total = remaining.
  const z = checkPortalTotals(blank({ sources: ['x.png'],
    funds_deposited: 99000, amount_remaining: 99000, total_amount_due: 99000,
    principal_paid: 0, fee_paid: 0 }))
  ok('a vacuous identity does not corroborate', !z.corroborated.includes('amount_remaining'))
  ok('...and the balance is dropped', z.amount_remaining === null)
}

section('C — a silent screen must not erase another screen\'s proof')
{
  const proven = checkPortalTotals(blank({ sources: ['ov.png'],
    total_amount_due: 145875, paid_to_date: 22783.34, amount_remaining: 123091.66 }))
  const silent = blank({ sources: ['fund.png'], funds_deposited: 125000 })
  const wrong = blank({ sources: ['bad.png'], amount_remaining: 125000 })
  const fold = (xs: any[]) => xs.reduce((a, b) => mergePortal(a, b))
  const orders: [string, any[]][] = [
    ['proven,silent,wrong', [proven, silent, wrong]],
    ['proven,wrong,silent', [proven, wrong, silent]],
    ['silent,proven,wrong', [silent, proven, wrong]],
    ['silent,wrong,proven', [silent, wrong, proven]],
    ['wrong,silent,proven', [wrong, silent, proven]],
    ['wrong,proven,silent', [wrong, proven, silent]],
  ]
  for (const [name, xs] of orders) {
    const m = fold(xs)
    ok(`${name} -> the proven balance stands`, m.amount_remaining === 123091.66, String(m.amount_remaining))
  }
  ok('and no order manufactures a dispute', orders.every(([, xs]) => fold(xs).disputes.length === 0))
}

section('D — a DRAFT journal has not booked anything')
{
  const draft = normaliseLedgerEntry({ id: 'j-draft', date: '2026-06-30', status: 'DRAFT',
    narration: 'Stripe fee (DRAFT — do not post until reviewed)',
    lines: [{ account: '304', amount: -20875 }, { account: '264', amount: 20875 }] }, 'manual_journal')!
  ok('a DRAFT is not evidence the fee was booked',
     findOriginationFeeJournal({ journals: [draft], loanAccountCode: '304', feeAmount: 20875, complete: true })
       .verdict === 'not_found')

  // The mirror case: a real journal beside its own abandoned draft is not ambiguous.
  const posted = normaliseLedgerEntry({ id: 'j-real', date: '2026-06-30', status: 'POSTED',
    narration: 'Stripe Capital fee',
    lines: [{ account: '304', amount: -20875 }, { account: '264', amount: 20875 }] }, 'manual_journal')!
  ok('a posted journal beside its draft copy is still found',
     findOriginationFeeJournal({ journals: [draft, posted], loanAccountCode: '304', feeAmount: 20875, complete: true })
       .verdict === 'found')
}

section('E — the debits have to actually be the fee')
{
  const composite = normaliseLedgerEntry({ id: 'j-me', date: '2026-06-30', status: 'POSTED',
    narration: 'June 2026 month-end journal', lines: [
      { account: '477', account_name: 'Wages', amount: 412000 },
      { account: '429', account_name: 'Rent', amount: 38000 },
      { account: '304', account_name: 'Stripe Capital Loan', amount: -20875 },
      { account: '090', account_name: 'Bank', amount: -429125 }] }, 'manual_journal')!
  const r = findOriginationFeeJournal({ journals: [composite], loanAccountCode: '304', feeAmount: 20875, complete: true })
  ok('a composite journal is not an answer', r.verdict === 'ambiguous', r.verdict)
  ok('...it does not name Wages as the fee account', !/Wages/.test(r.statement))
  ok('...and it says what it actually is', /composite entry/.test(r.statement))
  ok('...proposing nothing', r.debits.length === 0)

  // A standalone fee posting still works.
  const clean = normaliseLedgerEntry({ id: 'j-fee', date: '2026-06-30', status: 'POSTED',
    lines: [{ account: '304', amount: -20875 }, { account: '264', account_name: 'Loan Fees', amount: 20875 }] }, 'manual_journal')!
  ok('a standalone fee journal is still found',
     findOriginationFeeJournal({ journals: [clean], loanAccountCode: '304', feeAmount: 20875, complete: true }).verdict === 'found')
  // A split debit that sums correctly is still fine.
  const split = normaliseLedgerEntry({ id: 'j-split', date: '2026-06-30', status: 'POSTED',
    lines: [{ account: '304', amount: -20875 }, { account: '264', amount: 15000 }, { account: '620', amount: 5875 }] }, 'manual_journal')!
  ok('a split debit that sums to the fee is accepted',
     findOriginationFeeJournal({ journals: [split], loanAccountCode: '304', feeAmount: 20875, complete: true }).verdict === 'found')
}

section('F — a name that MENTIONS the lender is not that lender')
{
  // Closing the true loan is what removes the ambiguity that would have refused.
  const r = matchLoan({ loans: [
    { id: 'stripe-old', status: 'closed', lender: 'Stripe Capital', xero_account_name: 'Stripe Capital Loan' },
    { id: 'bay-refi', status: 'active', lender: 'BayFirst National Bank',
      xero_account_name: 'BayFirst SBA - refinance of Stripe Capital Loan' }],
    acctRef: 'acct_1MPrRD', lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 })
  ok('a refinance account does not take the bundle', r.loan === null, String(r.loan?.id))

  ok('punctuation does not merge two institutions',
     matchLoan({ loans: [{ id: 'mt', status: 'active', lender: 'M&T Bank' }],
       lenderHints: ['MT Bank'] }).loan === null)

  // The real case must still work, both ways round.
  ok('the real Stripe loan still matches',
     matchLoan({ loans: [{ id: 's', status: 'active', lender: 'Stripe Capital',
       xero_account_name: 'Stripe Capital Loan', original_amount: 125000 }],
       lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 }).loan?.id === 's')
  ok('a loan recorded under a shorter name still matches',
     matchLoan({ loans: [{ id: 's', status: 'active', lender: 'Stripe' }],
       lenderHints: ['Stripe Capital'] }).loan?.id === 's')
}

section('G — a sibling stored as "Active" must not make its twin unique')
{
  const r = matchLoan({ loans: [
    { id: 'bay1', status: 'Active', lender: 'BayFirst National Bank', original_amount: 150000 },
    { id: 'bay2', status: 'active', lender: 'BayFirst National Bank', original_amount: 90000 }],
    lenderHints: ['BayFirst National Bank'], agreementLoanAmount: 150000 })
  ok('two BayFirst loans are still refused', r.loan === null, String(r.loan?.id))
  ok('ACTIVE in caps counts as active',
     matchLoan({ loans: [{ id: 'x', status: 'ACTIVE', lender: 'Verdant Commercial Capital' }],
       lenderHints: ['Verdant Commercial Capital'] }).loan?.id === 'x')
}

section('H — a contradicting amount vetoes rather than staying silent')
{
  ok('a $125,000 agreement does not file against a $40,000 loan',
     matchLoan({ loans: [{ id: 'stripe2', status: 'active', lender: 'Stripe Capital', original_amount: 40000 }],
       lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 }).loan === null)
  ok('an agreeing amount still corroborates',
     /matches the agreement's Loan Amount to the cent/.test(
       matchLoan({ loans: [{ id: 's', status: 'active', lender: 'Stripe Capital', original_amount: 125000 }],
         lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 }).matchedOn || ''))
  ok('a loan with no recorded amount is not vetoed',
     matchLoan({ loans: [{ id: 's', status: 'active', lender: 'Stripe Capital', original_amount: null }],
       lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 }).loan?.id === 's')
  ok('...nor is one recorded as zero',
     matchLoan({ loans: [{ id: 's', status: 'active', lender: 'Stripe Capital', original_amount: 0 }],
       lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 }).loan?.id === 's')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
