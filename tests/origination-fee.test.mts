// tests/origination-fee.test.mts — deducing where the capitalised fee was debited.
//
// This module PROPOSES A CHANGE TO A FINANCIAL RECORD off a pattern match, so most
// of what follows is the cases where it must refuse.
//
// Run:  npx tsx tests/origination-fee.test.mts

import { findOriginationFeeJournal, classifyFeeDebit, type JournalWithLines }
  from '../supabase/functions/_shared/origination-fee.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const FEE = 20875
const LOAN = '835'

// The shape journal #52168 should have: fee credited to the loan, debited to an
// expense account.
const THE_ONE: JournalWithLines = {
  id: 'j-52168', date: '2026-06-30', narration: 'Stripe Capital loan fee', status: 'POSTED',
  lines: [
    { account: LOAN, account_name: 'Stripe Capital Loan', amount: -20875 },
    { account: '437', account_name: 'Interest & Finance Costs', amount: 20875 },
  ],
}
const NOISE: JournalWithLines[] = [
  { id: 'j-1', date: '2026-06-28', narration: 'Payroll accrual', status: 'POSTED',
    lines: [{ account: '477', account_name: 'Wages', amount: 20875 }, { account: '814', account_name: 'Accrual', amount: -20875 }] },
  { id: 'j-2', date: '2026-07-02', narration: 'Depreciation', status: 'POSTED',
    lines: [{ account: '620', account_name: 'Depreciation', amount: 100 }, { account: '710', account_name: 'Accum Dep', amount: -100 }] },
]
const base = { loanAccountCode: LOAN, feeAmount: FEE, complete: true, windowFrom: '2026-06-20', windowTo: '2026-07-10' }

section('the answer David said was there to be found')
{
  const r = findOriginationFeeJournal({ ...base, journals: [...NOISE, THE_ONE] })
  ok('the journal is found', r.verdict === 'found', r.verdict)
  ok('it is the right one', r.journal?.id === 'j-52168')
  ok('the DEBIT side is named — the actual question', r.debits[0].account === '437')
  ok('with its account name', r.debits[0].account_name === 'Interest & Finance Costs')
  ok('the sentence says where the money went',
     /debits Interest & Finance Costs \(437\)/.test(r.statement), r.statement)
  ok('and quotes the narration', /Stripe Capital loan fee/.test(r.statement))
  // A payroll accrual of the same amount must not be mistaken for it.
  ok('an unrelated journal of the SAME amount is ignored', r.candidates.length === 0)
}

section('the cases where it must refuse')
{
  // Two journals both crediting the fee: a question, not an answer.
  const twin = { ...THE_ONE, id: 'j-2nd', date: '2026-07-01', narration: 'Loan fee (reposted)' }
  const amb = findOriginationFeeJournal({ ...base, journals: [THE_ONE, twin] })
  ok('two matching journals -> ambiguous', amb.verdict === 'ambiguous')
  ok('...it proposes nothing', amb.journal === null && amb.debits.length === 0)
  ok('...and names both candidates', amb.candidates.length === 2)
  ok('...in the sentence too', /2 journals/.test(amb.statement) && /reposted/.test(amb.statement))

  // A DEBIT of the fee to the loan is a repayment, not a capitalisation.
  const wrongSide: JournalWithLines = { ...THE_ONE, id: 'j-dr',
    lines: [{ account: LOAN, account_name: 'Loan', amount: 20875 }, { account: '437', account_name: 'x', amount: -20875 }] }
  ok('a DEBIT to the loan is not the fee entry',
     findOriginationFeeJournal({ ...base, journals: [wrongSide] }).verdict === 'not_found')

  // A fee is a contractual figure. A near miss is a different entry.
  const offByACent: JournalWithLines = { ...THE_ONE, id: 'j-cent',
    lines: [{ account: LOAN, account_name: 'Loan', amount: -20875.01 }, { account: '437', account_name: 'x', amount: 20875.01 }] }
  ok('one cent off is not a match', findOriginationFeeJournal({ ...base, journals: [offByACent] }).verdict === 'not_found')

  // Right amount, wrong account.
  const otherAccount: JournalWithLines = { ...THE_ONE, id: 'j-other',
    lines: [{ account: '999', account_name: 'Other loan', amount: -20875 }, { account: '437', account_name: 'x', amount: 20875 }] }
  ok('the right amount on the WRONG loan is not a match',
     findOriginationFeeJournal({ ...base, journals: [otherAccount] }).verdict === 'not_found')

  const deleted: JournalWithLines = { ...THE_ONE, id: 'j-del', status: 'DELETED' }
  ok('a deleted journal is not evidence', findOriginationFeeJournal({ ...base, journals: [deleted] }).verdict === 'not_found')

  ok('no account code on the loan -> nothing can be concluded',
     findOriginationFeeJournal({ ...base, loanAccountCode: null, journals: [THE_ONE] }).verdict === 'incomplete')
}

section('silence only means something if the search was complete')
{
  const partial = findOriginationFeeJournal({ ...base, complete: false, journals: NOISE })
  ok('an incomplete search never says "not found"', partial.verdict === 'incomplete')
  ok('...and says why that matters',
     /not a journal that does not exist/.test(partial.statement))

  const full = findOriginationFeeJournal({ ...base, complete: true, journals: NOISE })
  ok('a complete search may say not found', full.verdict === 'not_found')
  ok('...and suggests what else it could be', /opening balance, or a bill/.test(full.statement))
  ok('...naming the window it searched', /2026-06-20 to 2026-07-10/.test(full.statement))

  // Found beats incomplete: if we found it, we found it.
  ok('finding it while incomplete still counts',
     findOriginationFeeJournal({ ...base, complete: false, journals: [THE_ONE] }).verdict === 'found')
}

section('a split debit is reported in full')
{
  const split: JournalWithLines = { ...THE_ONE, id: 'j-split',
    lines: [
      { account: LOAN, account_name: 'Loan', amount: -20875 },
      { account: '437', account_name: 'Finance Costs', amount: 15000 },
      { account: '620', account_name: 'Prepayments', amount: 5875 },
    ] }
  const r = findOriginationFeeJournal({ ...base, journals: [split] })
  ok('both debit lines are reported', r.debits.length === 2)
  ok('largest first', r.debits[0].amount === 15000)
  ok('and both appear with their amounts',
     /Finance Costs \(437\) \$15,000\.00/.test(r.statement) && /Prepayments \(620\) \$5,875\.00/.test(r.statement))

  const noDebit: JournalWithLines = { ...THE_ONE, id: 'j-nodr',
    lines: [{ account: LOAN, account_name: 'Loan', amount: -20875 }] }
  const nd = findOriginationFeeJournal({ ...base, journals: [noDebit] })
  ok('a journal with no readable debit is not an answer', nd.verdict === 'ambiguous')
  ok('...and says the other side is still unknown', /still unknown/.test(nd.statement))
}

section('what the debit account MEANS — three answers, three fixes')
{
  ok('an expense account means recognised', classifyFeeDebit('EXPENSE').kind === 'expensed')
  ok('...and warns it lands in one month', /flatters every month after it/.test(classifyFeeDebit('OVERHEADS').consequence))
  ok('an asset means capitalised', classifyFeeDebit('PREPAYMENT').kind === 'capitalised')
  ok('...and warns nothing amortises it', /nothing in this system does/.test(classifyFeeDebit('CURRENT').consequence))
  ok('a suspense account means parked', classifyFeeDebit('SUSPENSE').kind === 'suspense')
  ok('...and says it is not booked', /parked, not booked/.test(classifyFeeDebit('CLEARING').consequence))
  ok('an unknown type is not guessed at', classifyFeeDebit('WEIRD').kind === 'unknown')
  ok('a missing type is not guessed at either', classifyFeeDebit(null).kind === 'unknown')
  // Keyed on TYPE, never on the label — "Loan Fees" can be either.
  ok('a label is never used as a type', classifyFeeDebit('Loan Fees').kind === 'unknown')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
