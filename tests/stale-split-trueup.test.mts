// tests/stale-split-trueup.test.mts — THE SIGNATURE, AND THAT IT CAN FAIL
//
// Run:  npx tsx tests/stale-split-trueup.test.mts
//
// Session 275. The value of this module is not that it computes a difference —
// subtraction is easy and a difference is not a finding. It is that it refuses on
// every difference EXCEPT the one whose cause is established, because a wrong
// journal in a real ledger is the expensive failure here and "book it so the row
// goes green" is exactly what David rejected in session 272.
//
// So most of this file is about what does NOT fire.

import {
  findStaleSplits, trueUpJournalLines, trueUpCard, TRUEUP_TOL,
} from '../supabase/functions/_shared/stale-split-trueup.ts'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`)) }
const eq = (n: string, a: any, b: any) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)

// Funding Circle's real figures, 2026-09-05. Lender balances from the portal
// statements; Xero movements from the walk in §0e.
const FC = [
  { period_label: '2026-06', lender_principal: 1010.57, xero_principal: 1010.57, booked_principal: 1010.57, closed: true },
  { period_label: '2026-07', lender_principal: 1025.71, xero_principal: 1010.57, booked_principal: null },
  { period_label: '2026-08', lender_principal: 1041.09, xero_principal: 1025.71, booked_principal: 1025.71 },
]

console.log('\n1. the real loan')
{
  const r = findStaleSplits(FC)
  eq('both open periods are correctable', r.correctable.map(x => x.period_label), ['2026-07', '2026-08'])
  eq('July is short by the lender\'s own arithmetic', r.correctable[0].amount, 15.14)
  eq('August likewise', r.correctable[1].amount, 15.38)
  eq('the total is the accumulated open backlog', r.total, 30.52)
  eq('both move interest back onto the loan', [...new Set(r.correctable.map(x => x.direction))], ['interest_back_to_loan'])
  eq('August is corroborated by our own split', r.correctable[1].corroborated_by_split, true)
  eq('July is not — its split was voided, so Xero and the lender stand alone',
    r.correctable[0].corroborated_by_split, false)
  ok('nothing is proposed and no refusal is needed', r.refusal === null)
}

console.log('\n2. what it REFUSES, which is the point')
{
  // A loan that simply disagrees. Same size of gap, no signature.
  const r = findStaleSplits([
    { period_label: '2026-07', lender_principal: 1025.71, xero_principal: 1025.71 },
    { period_label: '2026-08', lender_principal: 1041.09, xero_principal: 1025.71 - 15.38 },
  ])
  eq('an ordinary difference gets no correction', r.correctable.length, 0)
  ok('...and says why, in words that name the cause', /not a stale split/.test(r.refusal || ''), r.refusal || '')
}
{
  // A CLOSED period. Established cause, deliberately not proposed (session 230).
  const r = findStaleSplits(FC.map(p => ({ ...p, closed: true })))
  eq('a closed period is never proposed', r.correctable.length, 0)
  eq('...but it is still recognised and named', r.closed_periods.map(x => x.period_label), ['2026-07', '2026-08'])
  ok('...and the refusal says the CPA settled them', /closed/.test(r.refusal || ''), r.refusal || '')
}
{
  // ⚠ THE HALF THAT MAKES IT A TEST. A loan whose books are RIGHT and whose
  // principal is flat month to month matches "equals the previous period" on the
  // first half alone. Without the second half it would be offered a correction
  // for ever, on a loan with nothing wrong with it.
  const flat = [
    { period_label: '2026-07', lender_principal: 500, xero_principal: 500 },
    { period_label: '2026-08', lender_principal: 500, xero_principal: 500 },
  ]
  const r = findStaleSplits(flat)
  eq('a flat, correct loan gets nothing', r.correctable.length, 0)
  ok('...and is told it agrees', /agree with the lender/.test(r.refusal || ''), r.refusal || '')
  // DISCRIMINATION: prove the first half alone would have matched it.
  ok('...even though its movement DOES equal the previous period\'s figure',
    Math.abs(flat[1].xero_principal - flat[0].lender_principal) < TRUEUP_TOL)
}
{
  eq('one period alone proves nothing', findStaleSplits([FC[2]]).correctable.length, 0)
  ok('...and says so', /two consecutive periods/i.test(findStaleSplits([FC[2]]).refusal || ''))
  ok('no periods at all still refuses in words', (findStaleSplits([]).refusal || '').length > 0)
}
{
  // Materiality. A cent of rounding is not a correction.
  const r = findStaleSplits([
    { period_label: '2026-07', lender_principal: 1000.00, xero_principal: 1000.00 },
    { period_label: '2026-08', lender_principal: 1000.01, xero_principal: 1000.00 },
  ])
  eq('a penny is not a finding', r.correctable.length, 0)
}

console.log('\n3. the journal')
{
  const r = findStaleSplits(FC)
  const lines = trueUpJournalLines({
    amount: r.total, direction: 'interest_back_to_loan',
    loanAccountCode: '253', interestAccountCode: '800', loanName: 'Funding Circle Loan',
  })
  eq('it balances to zero', Math.round(lines.reduce((s, l) => s + l.LineAmount, 0) * 100) / 100, 0)
  // Xero: positive LineAmount is a DEBIT. The loan account is a liability, so
  // debiting it REDUCES the balance — which is what this correction must do.
  eq('the loan account is DEBITED, reducing the balance', lines.find(l => l.AccountCode === '253')!.LineAmount, 30.52)
  eq('Interest Expense is CREDITED', lines.find(l => l.AccountCode === '800')!.LineAmount, -30.52)
  const mirror = trueUpJournalLines({
    amount: 30.52, direction: 'interest_out_of_loan',
    loanAccountCode: '253', interestAccountCode: '800', loanName: 'x',
  })
  eq('the mirror direction reverses both legs', mirror.map(l => l.LineAmount), [-30.52, 30.52])
  eq('...and still balances', Math.round(mirror.reduce((s, l) => s + l.LineAmount, 0) * 100) / 100, 0)
}

console.log('\n4. the card a person approves from')
{
  const r = findStaleSplits(FC)
  const one = trueUpCard([r.correctable[1]], 'Funding Circle Loan')
  const words = one.plain_english.trim().split(/\s+/).length
  ok(`the visible card is within the 40-word budget (${words})`, words <= 40, one.plain_english)
  ok('it states the figure that gets written', /\$15\.38/.test(one.plain_english))
  ok('it states the check that would have failed', /1,?041\.09|\$1041\.09/.test(one.plain_english.replace(/,/g, '')))
  // NOTHING IS DELETED — the ce17 limit. Anything trimmed from the visible card
  // must survive in the working, or the cut is a lie rather than a trim.
  ok('the working keeps the period label', /2026-08/.test(one.working))
  ok('the working keeps the corroborating split', /1025\.71/.test(one.working.replace(/,/g, '')))
  ok('the working names the matched period', /2026-07/.test(one.working))

  const both = trueUpCard(r.correctable, 'Funding Circle Loan')
  const w2 = both.plain_english.trim().split(/\s+/).length
  ok(`the two-period card is also within budget (${w2})`, w2 <= 40, both.plain_english)
  ok('...and its working carries BOTH periods in full',
    /2026-07/.test(both.working) && /2026-08/.test(both.working) && /15\.14/.test(both.working) && /15\.38/.test(both.working))
  ok('a split that disagrees with Xero is flagged, not hidden',
    /⚠/.test(trueUpCard([{ ...r.correctable[1], booked_principal: 999, corroborated_by_split: false }], 'x').working))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
