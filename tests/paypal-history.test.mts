// tests/paypal-history.test.mts — PayPal's loan-history CSV as a ledger, and as
// the only document on file that states this loan's opening terms.
//
// Run:  npx tsx tests/paypal-history.test.mts

import { detectPayPalHistoryCsv, parsePayPalHistoryCsv } from '../supabase/functions/_shared/paypal-history.ts'
import { paidFromOutstanding } from '../supabase/functions/_shared/ledger-dating.ts'
import { dateFromLedger } from '../supabase/functions/_shared/ledger-dating.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// The real file, verbatim: David's 2026-09-02 export for Paypal 2 (A00845102).
const HEAD = 'Date,Description,Amount,Principal,Fee,Other'
const PAYMENTS: [string, string, string][] = [
  ['09/02/2026', '3,180.33', '234.38'], ['08/26/2026', '3,165.30', '249.41'],
  ['08/19/2026', '3,150.32', '264.39'], ['08/12/2026', '3,135.43', '279.28'],
  ['08/05/2026', '3,120.60', '294.11'], ['07/29/2026', '3,105.85', '308.86'],
  ['07/22/2026', '3,091.15', '323.56'], ['07/15/2026', '3,076.54', '338.17'],
  ['07/08/2026', '3,061.98', '352.73'], ['07/01/2026', '3,047.51', '367.20'],
  ['06/24/2026', '3,033.09', '381.62'], ['06/17/2026', '3,018.75', '395.96'],
  ['06/10/2026', '3,004.47', '410.24'], ['06/03/2026', '2,990.27', '424.44'],
  ['05/27/2026', '2,976.12', '438.59'], ['05/20/2026', '2,962.05', '452.66'],
  ['05/13/2026', '2,948.04', '466.67'], ['05/06/2026', '2,934.10', '480.61'],
  ['04/29/2026', '2,920.23', '494.48'], ['04/22/2026', '2,906.41', '508.30'],
  ['04/15/2026', '2,892.67', '522.04'], ['04/08/2026', '2,878.99', '535.72'],
  ['04/01/2026', '2,865.37', '549.34'], ['03/25/2026', '2,851.82', '562.89'],
  ['03/18/2026', '2,838.34', '576.37'], ['03/11/2026', '2,824.91', '589.80'],
  ['03/04/2026', '2,811.55', '603.16'], ['02/25/2026', '2,798.26', '616.45'],
  ['02/18/2026', '2,785.02', '629.69'], ['02/11/2026', '2,771.86', '642.85'],
  ['02/04/2026', '2,758.74', '655.97'], ['01/28/2026', '2,745.70', '669.01'],
  ['01/21/2026', '2,732.71', '682.00'], ['01/14/2026', '2,719.79', '694.92'],
  ['01/07/2026', '2,706.93', '707.78'], ['12/31/2025', '2,694.12', '720.59'],
  ['12/24/2025', '2,681.39', '733.32'], ['12/17/2025', '2,668.70', '746.01'],
]
const payRow = ([d, p, f]: [string, string, string]) =>
  `${d},Auto Draft Payment,"-$3,414.71","-$${p}","-$${f}","$0.00"`
const REAL_CSV = [
  HEAD, ...PAYMENTS.map(payRow),
  '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
  '12/10/2025,Total Loan Fee,"$20,565.12","$0.00","$20,565.12","$0.00"',
].join('\n')

section('the file is recognised and read')
{
  ok('detected', detectPayPalHistoryCsv(REAL_CSV))
  ok('a Stripe export is not mistaken for one',
     !detectPayPalHistoryCsv('balance_transaction_id,created,net,fee\na,b,c,d'))
  const r = parsePayPalHistoryCsv(REAL_CSV)
  ok('it parses clean', r.ok === true, r.refused_because || '')
  ok('38 payment days', r.days.length === 38, String(r.days.length))
  ok('the two origination rows are SKIPPED, not rejected',
     r.rows_skipped_not_applicable === 2 && r.rows_rejected_count === 0)
  ok('first and last day', r.first_date === '2025-12-17' && r.last_date === '2026-09-02')
  ok('total paid', Math.abs(r.totals!.total_paid - 129758.98) < 0.005, String(r.totals?.total_paid))
  ok('financing paid', Math.abs(r.totals!.principal_paid - 110855.41) < 0.005, String(r.totals?.principal_paid))
  ok('fee paid', Math.abs(r.totals!.fee_paid - 18903.57) < 0.005, String(r.totals?.fee_paid))
  ok('the parts foot to the whole',
     Math.abs((r.totals!.principal_paid + r.totals!.fee_paid) - r.totals!.total_paid) < 0.005)
}

section('the origination rows state the contract')
{
  const r = parsePayPalHistoryCsv(REAL_CSV)
  ok('advance', r.origination!.loan_amount === 157000)
  ok('fee', r.origination!.fixed_fee === 20565.12)
  ok('total repayment is the two added', r.origination!.total_repayment_amount === 177565.12)
  ok('origination date', r.origination!.origination_date === '2025-12-10')
  ok('four recordable terms', r.terms.length === 4, String(r.terms.length))
  ok('every term carries the text it was read from',
     r.terms.every(t => typeof t.source_text === 'string' && t.source_text.length > 0))
  ok('the total says out loud that it was ADDED, not printed',
     /not a figure the file prints/.test(r.terms.find(t => t.term_key === 'total_repayment_amount')!.basis))

  // This is the figure the loan record gets wrong: original_amount says $177,500.
  ok('and it contradicts the typed $177,500 on the loan record',
     r.origination!.total_repayment_amount !== 177500)

  // A file with only ONE origination half must not invent the total.
  const halfOnly = [HEAD, ...PAYMENTS.map(payRow),
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"'].join('\n')
  const h = parsePayPalHistoryCsv(halfOnly)
  ok('one half alone gives no total repayment', h.origination!.total_repayment_amount === null)
  ok('but the half it has is still stated', h.origination!.loan_amount === 157000)
}

section('rows it refuses, each of which would date a screen wrong')
{
  const bad = (row: string) => parsePayPalHistoryCsv([HEAD, row,
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"'].join('\n'))
  const split = bad('09/02/2026,Auto Draft Payment,"-$3,414.71","-$3,180.33","-$999.00","$0.00"')
  ok('a payment whose split does not foot is rejected', split.rows_rejected_count === 1 && split.ok === false)
  ok('...and the reason names both figures', /does not foot/.test(split.rows_rejected_sample[0].reason))

  const unreadable = bad('09/02/2026,Auto Draft Payment,"-$3,414.71","n/a","-$234.38","$0.00"')
  ok('an unreadable amount is REJECTED, never silently zero', unreadable.rows_rejected_count === 1)
  ok('...and it does not reach the totals', (unreadable.totals?.total_paid ?? 0) === 0)

  const twoAdvances = parsePayPalHistoryCsv([HEAD, ...PAYMENTS.map(payRow),
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
    '01/05/2026,Wire,"$50,000.00","$50,000.00","$0.00","$0.00"'].join('\n'))
  ok('a second advance is refused, not summed into one opening figure',
     twoAdvances.origination!.loan_amount === 157000 && twoAdvances.rows_rejected_count === 1)

  // Two drafts in one day must be ONE day with two transactions.
  const twice = parsePayPalHistoryCsv([HEAD,
    payRow(['09/02/2026', '3,180.33', '234.38']), payRow(['09/02/2026', '3,180.33', '234.38']),
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"'].join('\n'))
  ok('two drafts on one date collapse to one day', twice.days.length === 1)
  ok('...counted as two transactions', twice.days[0].transaction_count === 2)
  ok('...and summed', Math.abs(twice.days[0].total_paid - 6829.42) < 0.005)
}

section('end to end: the screenshot gets a date, and only because it is independent')
{
  const r = parsePayPalHistoryCsv(REAL_CSV)
  const terms = {
    loan_amount: r.origination!.loan_amount,
    fixed_fee: r.origination!.fixed_fee,
    total_repayment_amount: r.origination!.total_repayment_amount,
  }
  // The screenshot, which prints NO as-of date.
  const SCREEN = { principal_balance: 46144.59, fee_balance: 1661.55, total_balance: 47806.14 }
  const conv = paidFromOutstanding(SCREEN, terms)
  ok('the CSV terms unlock the conversion', conv.refused_because === null, conv.statement)

  const dated = dateFromLedger({
    days: r.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
    complete: r.ok, coversFrom: r.first_date!, periodStart: r.first_date!,
    target: conv.target!,
  })
  ok('the undated screenshot is dated 2026-09-02', dated.date === '2026-09-02', dated.statement)
  ok('and it is corroborated by the financing/fee split', dated.corroborated === true)

  // THE PAIRED ASSERTION (§246). The check must be capable of FAILING, or it is
  // arithmetic agreeing with itself. Move the screen's balance and no day fits.
  const wrongScreen = paidFromOutstanding(
    { principal_balance: 40000, fee_balance: 1661.55, total_balance: 41661.55 }, terms)
  const noMatch = dateFromLedger({
    days: r.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
    complete: r.ok, coversFrom: r.first_date!, periodStart: r.first_date!,
    target: wrongScreen.target!,
  })
  ok('a screenshot that disagrees with the ledger matches NO day',
     noMatch.date === null, `${noMatch.date} / ${noMatch.refused_because}`)
  // A balance LOWER than the truth implies more paid than the ledger holds, so
  // the refusal is 'beyond the file' rather than 'between two days'. Both are
  // refusals; asserting the specific one keeps this honest about which guard
  // actually caught it.
  ok('...and says why rather than rounding to the nearest',
     noMatch.refused_because === 'target_beyond_export', String(noMatch.refused_because))

  // The other shape: a balance that lands mid-ledger but on no day's cumulative.
  const midScreen = paidFromOutstanding(
    { principal_balance: 60000, fee_balance: 2500, total_balance: 62500 }, terms)
  const between = dateFromLedger({
    days: r.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
    complete: r.ok, coversFrom: r.first_date!, periodStart: r.first_date!,
    target: midScreen.target!,
  })
  ok('a balance landing between two days is refused, never rounded',
     between.date === null && between.refused_because === 'between_days',
     `${between.date} / ${between.refused_because}`)

  // And without the terms there is no target at all — the conversion is what
  // joins the two documents, and it refuses rather than assuming a contract.
  const noTerms = paidFromOutstanding(SCREEN,
    { loan_amount: null, fixed_fee: null, total_repayment_amount: null })
  ok('no terms, no target, no date', noTerms.target === null && noTerms.refused_because === 'no_terms')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
