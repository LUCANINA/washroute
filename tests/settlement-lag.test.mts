// tests/settlement-lag.test.mts — the gap that is supposed to be there.
//
// Run:  npx tsx tests/settlement-lag.test.mts

import { explainBalanceGap, dailyWithholdingFromMonths, dailyWithholdingFromBalances, businessDaysBetween }
  from '../supabase/functions/_shared/settlement-lag.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// The real Stripe Capital July export.
const JULY = [{ month: '2026-07', total_paid: 11192.29, principal_paid: 9591.14, fee_paid: 1601.15,
                first_date: '2026-07-06', last_date: '2026-07-31', transaction_count: 1352 }]

section("David's actual numbers")
{
  const { rate, basis, continuous } = dailyWithholdingFromMonths(JULY)
  ok('the daily rate comes off the export', rate === 430.47, `got ${rate}`)
  ok('and is described', /1,352 withholdings totalling \$11,192\.29 over 26 days/.test(basis), basis)
  ok('1352 withholdings in a month reads as continuous repayment', continuous)

  const r = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-08-26',
    dailyWithholding: rate, rateBasis: basis, repaysContinuously: continuous,
  })
  ok('the gap is EXPLAINED', r.verdict === 'explained', r.verdict)
  ok('it is benign', r.benign)
  ok('5.03 calendar days of withholding', r.impliedCalendarDays === 5.03, `got ${r.impliedCalendarDays}`)
  // The whole point: derived from the documents, this lands on the 2-3 business
  // days David described without being told.
  ok('THREE business days — the lag David described', r.impliedBusinessDays === 3, `got ${r.impliedBusinessDays}`)
  ok('books reflect receipts settled through Friday 2026-08-21', r.impliedBooksThrough === '2026-08-21', `got ${r.impliedBooksThrough}`)
  ok('the sentence shows the arithmetic', /\$2,166\.05 is 5\.03 days of withholding at \$430\.47 a day/.test(r.statement))
  ok('...and says what WOULD matter', /gap GROWING/.test(r.statement))
}

section('the direction that is never timing')
{
  const r = explainBalanceGap({
    gap: -2166.05, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: 'the export', repaysContinuously: true,
  })
  ok('books ahead of the lender is never lag', r.verdict === 'wrong_direction')
  ok('and is never benign', !r.benign)
  ok('the sentence says why', /always leaves the LENDER ahead/.test(r.statement))
}

section('a gap too big to be timing')
{
  const r = explainBalanceGap({
    gap: 21660.50, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: 'the export', repaysContinuously: true,
  })
  ok('fifty days of withholding is not settlement lag', r.verdict === 'too_large', r.verdict)
  ok('not benign', !r.benign)
  ok('the arithmetic is still shown', /50\.32 days of withholding/.test(r.statement))
  ok('and it says it needs explaining', /needs explaining before this loan is relied on in a close/.test(r.statement))
}

section('loans this does not apply to')
{
  // A monthly-ACH loan. The arithmetic would happily produce a number, and the
  // number would mean nothing — so it is never run.
  const r = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: 'derived', repaysContinuously: false,
  })
  ok('a loan not repaid from receipts gets no lag excuse', r.verdict === 'not_continuous')
  ok('and stays something to look at', !r.benign)

  const monthly = dailyWithholdingFromMonths([{ month: '2026-07', total_paid: 13000,
    first_date: '2026-07-01', last_date: '2026-07-01', transaction_count: 1 }])
  ok('one payment a month is not continuous repayment', monthly.continuous === false)

  const noRate = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: null,
    rateBasis: 'nothing to measure', repaysContinuously: true,
  })
  ok('no measurable rate -> no conclusion either way', noRate.verdict === 'no_rate')
  ok('...and it does NOT get waved through', !noRate.benign)
  ok('a zero rate is treated the same as none',
     explainBalanceGap({ gap: 100, lenderAsOf: '2026-08-26', dailyWithholding: 0,
                         rateBasis: 'x', repaysContinuously: true }).verdict === 'no_rate')
}

section('the boundary')
{
  const at = (gap: number) => explainBalanceGap({
    gap, lenderAsOf: '2026-08-26', dailyWithholding: 100,
    rateBasis: 'the export', repaysContinuously: true }).verdict
  // 2026-08-26 is a Wednesday. Going back N calendar days crosses the weekend
  // of the 22nd/23rd, so business days lag well behind calendar days.
  ok('$500 (5 calendar days, 3 business) is explained', at(500) === 'explained')
  ok('$700 (7 calendar days, 5 business) is explained', at(700) === 'explained')
  ok('$900 (9 calendar days, 6 business) is too large', at(900) === 'too_large', at(900))

  // With no lender date the fallback is calendar days, and must not be laxer.
  const noDate = (gap: number) => explainBalanceGap({
    gap, lenderAsOf: null, dailyWithholding: 100,
    rateBasis: 'the export', repaysContinuously: true })
  ok('no date -> falls back to calendar days', noDate(700).verdict === 'explained')
  ok('no date -> and still refuses a large gap', noDate(900).verdict === 'too_large')
  ok('no date -> no business-day claim is made', noDate(700).impliedBusinessDays === null)

  ok('a zero gap is explained trivially',
     explainBalanceGap({ gap: 0, lenderAsOf: '2026-08-26', dailyWithholding: 100,
                         rateBasis: 'x', repaysContinuously: true }).verdict === 'explained')
}

section('business days')
{
  ok('Fri -> Wed across a weekend is 3', businessDaysBetween('2026-08-21', '2026-08-26') === 3)
  ok('Mon -> Tue is 1', businessDaysBetween('2026-08-24', '2026-08-25') === 1)
  ok('same day is 0', businessDaysBetween('2026-08-26', '2026-08-26') === 0)
  ok('Fri -> Mon is 1 (the weekend does not count)', businessDaysBetween('2026-08-21', '2026-08-24') === 1)
  ok('a backwards range is refused', businessDaysBetween('2026-08-26', '2026-08-21') === null)
  ok('a nonsense range is refused rather than looped', businessDaysBetween('1999-01-01', '2026-08-26') === null)
  ok('an unparseable date is refused', businessDaysBetween('not-a-date', '2026-08-26') === null)
}

section('the rate is measured on the most recent month')
{
  // A business that has grown: last year's rate would badly understate the lag
  // and turn an ordinary gap into an alarm.
  const r = dailyWithholdingFromMonths([
    { month: '2025-07', total_paid: 1000, first_date: '2025-07-01', last_date: '2025-07-10', transaction_count: 100 },
    { month: '2026-07', total_paid: 11192.29, first_date: '2026-07-06', last_date: '2026-07-31', transaction_count: 1352 },
  ])
  ok('the newest month wins', r.rate === 430.47, `got ${r.rate}`)
  ok('empty input yields no rate', dailyWithholdingFromMonths([]).rate === null)
  ok('...and is not treated as continuous', dailyWithholdingFromMonths([]).continuous === false)
}

section('the rate from balances — what the scheduled check has to work with')
{
  // The bundle has the export; reconciliation-run never does. A falling balance
  // is a payment whether or not anyone filed the export explaining it.
  const rows = [
    { statement_date: '2026-08-01', principal_balance: 138000 },
    { statement_date: '2026-08-11', principal_balance: 133700 },
    { statement_date: '2026-08-21', principal_balance: 129400 },
  ]
  const r = dailyWithholdingFromBalances(rows, '2026-08-26')
  ok('the rate comes off the decreases', r.rate === 430, `got ${r.rate}`)
  ok('and says where it came from', /balance decreases across 20 days on which this loan's balance actually fell/.test(r.basis), r.basis)

  // A balance that RISES is a fee or an advance. Averaging it in understates the
  // rate, which turns an ordinary gap into an alarm — the exact failure this
  // module exists to prevent.
  const withFee = dailyWithholdingFromBalances([
    { statement_date: '2026-08-01', principal_balance: 138000 },
    { statement_date: '2026-08-11', principal_balance: 150000 },   // fee capitalised
    { statement_date: '2026-08-21', principal_balance: 145700 },
  ], '2026-08-26')
  ok('a rise is not counted as a payment', withFee.rate === 430, `got ${withFee.rate}`)

  ok('one balance cannot give a rate',
     dailyWithholdingFromBalances([{ statement_date: '2026-08-01', principal_balance: 1 }], '2026-08-26').rate === null)
  ok('a balance that only ever rises gives no rate',
     dailyWithholdingFromBalances([
       { statement_date: '2026-08-01', principal_balance: 100 },
       { statement_date: '2026-08-11', principal_balance: 200 },
     ], '2026-08-26').rate === null)
  ok('future-dated rows are ignored',
     dailyWithholdingFromBalances([
       { statement_date: '2026-08-01', principal_balance: 138000 },
       { statement_date: '2026-08-21', principal_balance: 129400 },
       { statement_date: '2027-01-01', principal_balance: 1 },
     ], '2026-08-26').rate === 430)
  ok('strings parse as well as numbers',
     dailyWithholdingFromBalances([
       { statement_date: '2026-08-01', principal_balance: '138000' },
       { statement_date: '2026-08-21', principal_balance: '129400' },
     ], '2026-08-26').rate === 430)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
