// tests/origination-fee.test.mts — deducing where the capitalised fee was debited.
//
// This module PROPOSES A CHANGE TO A FINANCIAL RECORD off a pattern match, so most
// of what follows is the cases where it must refuse.
//
// Run:  npx tsx tests/origination-fee.test.mts

import { findOriginationFeeJournal, classifyFeeDebit, normaliseLedgerEntry, xeroDate, type LedgerEntry as JournalWithLines }
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
  id: 'j-52168', source: 'manual_journal', date: '2026-06-30', narration: 'Stripe Capital loan fee', status: 'POSTED',
  lines: [
    { account: LOAN, account_name: 'Stripe Capital Loan', amount: -20875 },
    { account: '437', account_name: 'Interest & Finance Costs', amount: 20875 },
  ],
}
const NOISE: JournalWithLines[] = [
  { id: 'j-1', source: 'manual_journal', date: '2026-06-28', narration: 'Payroll accrual', status: 'POSTED',
    lines: [{ account: '477', account_name: 'Wages', amount: 20875 }, { account: '814', account_name: 'Accrual', amount: -20875 }] },
  { id: 'j-2', source: 'manual_journal', date: '2026-07-02', narration: 'Depreciation', status: 'POSTED',
    lines: [{ account: '620', account_name: 'Depreciation', amount: 100 }, { account: '710', account_name: 'Accum Dep', amount: -100 }] },
]
const base = { loanAccountCode: LOAN, feeAmount: FEE, complete: true, windowFrom: '2026-06-20', windowTo: '2026-07-10',
               searched: ['manual_journal', 'bank_transaction'] as const }

section('the answer David said was there to be found')
{
  const r = findOriginationFeeJournal({ ...base, journals: [...NOISE, THE_ONE] })
  ok('the journal is found', r.verdict === 'found', r.verdict)
  ok('it is the right one', r.journal?.id === 'j-52168')
  ok('the DEBIT side is named — the actual question', r.debits[0].account === '437')
  ok('with its account name', r.debits[0].account_name === 'Interest & Finance Costs')
  ok('the sentence says where the money went',
     /debits Interest & Finance Costs \(437\)/.test(r.statement), r.statement)
  ok('and names the source', /^The journal dated/.test(r.statement))
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
  ok('...in the sentence too', /2 entries/.test(amb.statement) && /reposted/.test(amb.statement))

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
     /not an entry that does not exist/.test(partial.statement))

  const full = findOriginationFeeJournal({ ...base, complete: true, journals: NOISE })
  ok('a complete search may say not found', full.verdict === 'not_found')
  ok('...and names what WAS searched', /journals and bank transactions were searched/.test(full.statement))
  ok('...and names the one place it could not look', /opening balance/.test(full.statement))
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

section('the other half of the ledger — a bank transaction can credit a loan too')
{
  // Searching journals alone was half a tool, and its own not-found message said
  // so. A RECEIVE coded to the loan account credits it, exactly like a journal.
  const receive: JournalWithLines = {
    id: 'bt-1', source: 'bank_transaction', type: 'RECEIVE', date: '2026-06-30',
    narration: 'Stripe Capital advance', status: 'AUTHORISED',
    lines: [{ account: LOAN, account_name: 'Stripe Capital Loan', amount: 20875 }],
  }
  const r = findOriginationFeeJournal({ ...base, journals: [receive] })
  ok('a RECEIVE crediting the loan is found', r.verdict === 'found', r.verdict)
  ok('it is named as a bank transaction, not a journal', /^A bank transaction dated/.test(r.statement))
  ok('and it does NOT invent a debit account', r.debits.length === 0)
  ok('...saying the other side is the bank', /other side is the bank account/.test(r.statement))

  // A SPEND of the same amount is a REPAYMENT. Getting this backwards would
  // report a repayment as the fee going on.
  const spend: JournalWithLines = { ...receive, id: 'bt-2', type: 'SPEND' }
  ok('a SPEND of the same amount is not the fee',
     findOriginationFeeJournal({ ...base, journals: [spend] }).verdict === 'not_found')

  // Journal sign convention is the mirror image and must not leak across.
  const journalPositive: JournalWithLines = {
    id: 'j-pos', source: 'manual_journal', date: '2026-06-30', status: 'POSTED',
    lines: [{ account: LOAN, account_name: 'Loan', amount: 20875 }],
  }
  ok('a POSITIVE journal line on the loan is a debit, not the fee',
     findOriginationFeeJournal({ ...base, journals: [journalPositive] }).verdict === 'not_found')

  const voided: JournalWithLines = { ...receive, id: 'bt-v', status: 'VOIDED' }
  ok('a voided bank transaction is not evidence',
     findOriginationFeeJournal({ ...base, journals: [voided] }).verdict === 'not_found')

  // One from each source is still ambiguous — two answers is a question.
  const both = findOriginationFeeJournal({ ...base, journals: [THE_ONE, receive] })
  ok('a journal AND a bank transaction both matching is ambiguous', both.verdict === 'ambiguous')
  ok('...and the sentence distinguishes them',
     /journal 2026-06-30/.test(both.statement) && /bank transaction 2026-06-30/.test(both.statement), both.statement)
}

section("Xero's response shape — the part I had only guessed at")
{
  // xero-read's TRIMMED shape.
  const trimmed = normaliseLedgerEntry({
    id: 'j-a', date: '2026-06-30', narration: 'Fee', status: 'POSTED',
    lines: [{ account: '835', account_name: 'Loan', amount: -20875 }],
  }, 'manual_journal')
  ok('the trimmed shape reads', trimmed?.lines[0].amount === -20875 && trimmed?.lines[0].account === '835')

  // Xero's RAW shape — different key for every single field.
  const raw = normaliseLedgerEntry({
    ManualJournalID: 'j-b', Date: '/Date(1782777600000+0000)/', Narration: 'Fee', Status: 'POSTED',
    JournalLines: [{ AccountCode: '835', AccountName: 'Loan', LineAmount: -20875 }],
  }, 'manual_journal')
  ok('the raw shape reads too', raw?.lines[0].amount === -20875, JSON.stringify(raw?.lines))
  ok('...including the account code', raw?.lines[0].account === '835')
  ok('...and the /Date(...)/ format', raw?.date === '2026-06-30', String(raw?.date))

  // A raw bank transaction, whose lines live under yet another key.
  const bt = normaliseLedgerEntry({
    BankTransactionID: 'bt-a', Type: 'RECEIVE', DateString: '2026-06-30T00:00:00', Reference: 'Advance',
    LineItems: [{ AccountCode: '835', LineAmount: '20875' }],
  }, 'bank_transaction')
  ok('a raw bank transaction reads', bt?.lines[0].amount === 20875)
  ok('...its type survives', bt?.type === 'RECEIVE')
  ok('...and a string amount is coerced', typeof bt?.lines[0].amount === 'number')

  // AND THE POINT: a shape that cannot be read must yield NOTHING, never a
  // half-parsed entry that could match by accident.
  const junk = normaliseLedgerEntry({ id: 'j-c', lines: [{ somethingElse: 1 }] }, 'manual_journal')
  ok('an unreadable line becomes a null amount, not a number', junk?.lines[0].amount === null)
  ok('...so it can never match a fee',
     findOriginationFeeJournal({ ...base, journals: [junk!] }).verdict === 'not_found')
  ok('an object with no id is refused outright', normaliseLedgerEntry({ lines: [] }, 'manual_journal') === null)
  ok('so is a non-object', normaliseLedgerEntry(null, 'manual_journal') === null)
  ok('missing lines are an empty list, not a crash', normaliseLedgerEntry({ id: 'x' }, 'manual_journal')?.lines.length === 0)

  ok('a plain ISO date passes through', xeroDate('2026-06-30T00:00:00') === '2026-06-30')
  ok('an unparseable date is null, not a wrong date', xeroDate('nonsense') === null)
}

section('the real journal, verbatim from Xero')
{
  // Copied byte for byte out of xero-read's live reply for
  // 531c23c0-011c-42c0-8986-0fdc00635f6d. This is the fixture that stops the
  // response shape from ever being a guess again.
  const REAL = {
    id: '531c23c0-011c-42c0-8986-0fdc00635f6d',
    number: null,
    date: '2026-06-30',
    status: 'POSTED',
    narration: 'Stripe Capital Loan — record Fixed Fee ($20,875.00) per loan agreement, bringing Total Repayment Amount to $145,875.00 (Loan Amount $125,000.00 + Fixed Fee $20,875.00)',
    lines: [
      { description: 'Stripe Capital Loan — Fixed Fee per signed Loan Agreement (Origination Date 6/30/2026)', account: '264', amount: 20875 },
      { description: 'Stripe Capital Loan — Fixed Fee added to total loan liability', account: '304', amount: -20875 },
    ],
  }
  const e = normaliseLedgerEntry(REAL, 'manual_journal')!
  ok('the real shape parses', e.lines.length === 2)
  ok('the credit line keeps its sign', e.lines[1].amount === -20875)
  ok('the date passes through', e.date === '2026-06-30')

  const r = findOriginationFeeJournal({
    journals: [e], searched: ['manual_journal', 'bank_transaction'],
    loanAccountCode: '304', feeAmount: 20875, complete: true,
    windowFrom: '2026-06-09', windowTo: '2026-07-21',
  })
  ok('the real journal is FOUND', r.verdict === 'found', r.verdict)
  ok('debited to 264 — the answer to the question', r.debits[0].account === '264')
  ok('and the loan account 304 is named as the credit', /credits \$20,875\.00 to account 304/.test(r.statement))

  // The live failure was never the matcher: hand it the entry and it works. It
  // was the fetch, capped at 40 against a window holding 70.
  ok('an EMPTY entry list is what actually produced "incomplete"',
     findOriginationFeeJournal({
       journals: [], searched: ['manual_journal', 'bank_transaction'],
       loanAccountCode: '304', feeAmount: 20875, complete: false,
       windowFrom: '2026-06-09', windowTo: '2026-07-21',
     }).verdict === 'incomplete')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
