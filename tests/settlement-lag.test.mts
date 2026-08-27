// tests/settlement-lag.test.mts — the gap that is supposed to be there.
//
// Run:  npx tsx tests/settlement-lag.test.mts

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { explainBalanceGap, dailyWithholdingFromMonths, dailyWithholdingFromBalances, businessDaysBetween,
         settlementWindow, lenderExportFromCsv,
         DEFAULT_MAX_BUSINESS_DAYS, GAP_GROWTH_LIMIT, EXPORT_FRESHNESS_TOLERANCE_DAYS }
  from '../supabase/functions/_shared/settlement-lag.ts'
// The export-first path is tested against the REAL file, through the REAL parser.
// A hand-typed day table would be a test of my arithmetic, not of the lender's.
import { parseStripeCapitalCsv } from '../supabase/functions/_shared/stripe-capital.ts'

// A balance row as the estimator now requires one: a document from the LENDER,
// stating principal only. Session 244 — before it, this function was handed every
// statement row on the loan and a row's source and basis were not looked at, which
// is what let the books' own daily snapshots into a measurement of the lender's
// withholding. Every case below says which kind of row it is building.
const lenderRow = (statement_date: string, principal_balance: number | string) =>
  ({ statement_date, principal_balance, source: 'lender_statement', balance_basis: 'principal_only' })
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

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
  // CHANGED, session 245 (defect 5: the rate-only path was a division, not a test).
  // These two assertions read '...is EXPLAINED' and '...is benign', and they were
  // pinning the defect at its purest. $430.47/day is the July export's MEAN; Stripe
  // withholds 8% of each sale, so the mean describes no day of the month (the real
  // daily figure runs $28.40 to $694.44). gap / mean returns a number of days for
  // ANY gap, so nothing here was ever tested — it was divided. The arithmetic below
  // is unchanged and still shown, because it is a fair DESCRIPTION of the size of
  // the gap; what it is not, and never was, is a confirmation of it.
  ok('the gap is NOT confirmed by a rate alone', r.verdict === 'unconfirmed_no_export', r.verdict)
  ok('...and is not benign', !r.benign)
  ok('...and nothing was checked against the lender', r.exportEvidence === 'absent' && r.windowWithholding === null)
  ok('the description survives: 5.03 calendar days of withholding', r.impliedCalendarDays === 5.03, `got ${r.impliedCalendarDays}`)
  // Still the arithmetic that lands on the 2-3 business days David described —
  // now offered as the size of the gap rather than as proof of what caused it.
  ok('THREE business days — the lag David described', r.impliedBusinessDays === 3, `got ${r.impliedBusinessDays}`)
  ok('books would reflect receipts settled through Friday 2026-08-21', r.impliedBooksThrough === '2026-08-21', `got ${r.impliedBooksThrough}`)
  ok('the sentence shows the arithmetic', /\$2,166\.05 is 5\.03 days of withholding at \$430\.47 a day/.test(r.statement))
  ok('...says plainly that it is an assumption', /an assumption, not a measurement/.test(r.statement), r.statement)
  ok('...says WHY the average cannot settle it', /withholds a percentage of every sale/.test(r.statement))
  ok('...and names the one thing that would', /Upload a transaction export from this lender covering 2026-08-21 to 2026-08-26/.test(r.statement))
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
  // CHANGED, session 245 (defect 5). This read '$500 ... is explained'. The
  // boundary it tests is real and is unchanged — it is the line between a gap the
  // rate can RULE OUT and one it cannot — but landing inside that line no longer
  // earns a benign verdict, only 'consistent, and unconfirmed'.
  ok('$500 (5 calendar days, 3 business) is consistent with the lag, and unconfirmed',
     at(500) === 'unconfirmed_no_export', at(500))
  // CHANGED, session 244 (defect 3: the default lag was 5 business days).
  // This assertion used to read '...is explained', and it was pinning the defect:
  // the module's header says 2-3 business days, its worked example lands on 3, and
  // the default said 5. Five business days of tolerance at $100/day is $200 of
  // permanent allowance here and $1,721.88 at Stripe Capital's real rate — granted
  // in the direction that hides money. Two more business days is not a rounding
  // choice, it is a decision that a $700 gap is nobody's problem.
  ok('$700 (7 calendar days, 5 business) is TOO LARGE — the lag is 2-3 days, not 5', at(700) === 'too_large', at(700))
  ok('$900 (9 calendar days, 6 business) is too large', at(900) === 'too_large', at(900))

  // With no lender date the fallback is calendar days, and must not be laxer.
  const noDate = (gap: number) => explainBalanceGap({
    gap, lenderAsOf: null, dailyWithholding: 100,
    rateBasis: 'the export', repaysContinuously: true })
  // CHANGED with the same defect: the calendar fallback is maxBiz + 2, so it moved
  // from 7 days to 5 along with the default it is derived from. $500 is the case it
  // now admits, and it is still the same rule — no laxer than the business-day path.
  // CHANGED with the same defect, for the same reason as $500 above.
  ok('no date -> falls back to calendar days', noDate(500).verdict === 'unconfirmed_no_export', noDate(500).verdict)
  // With no export AND no date, the missing export is the headline: it is the thing
  // that would settle this whichever date the balance carries.
  ok('no date -> the refusal names the missing export first',
     /No transaction export from this lender is on file/.test(noDate(500).statement), noDate(500).statement)
  // An export offered against no as-of date has no window to be judged over, and
  // says so rather than silently ignoring the file it was handed.
  const exportNoDate = explainBalanceGap({
    gap: 500, lenderAsOf: null, dailyWithholding: 100, rateBasis: 'the export', repaysContinuously: true,
    lenderExport: { days: [{ date: '2026-08-26', withheld: 900 }], coversFrom: '2026-08-01',
                    coversThrough: '2026-08-26', complete: true, measures: 'withheld', label: 'an export' } })
  ok('an export with no as-of date to measure against is refused, and says why',
     exportNoDate.verdict === 'unconfirmed_no_export' && exportNoDate.exportEvidence === 'no_window' &&
     /no lender as-of date/.test(exportNoDate.statement), exportNoDate.statement)
  ok('no date -> 7 calendar days is no longer inside the lag', noDate(700).verdict === 'too_large')
  ok('no date -> and still refuses a large gap', noDate(900).verdict === 'too_large')
  ok('no date -> no business-day claim is made', noDate(500).impliedBusinessDays === null)

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
    lenderRow('2026-08-01', 138000),
    lenderRow('2026-08-11', 133700),
    lenderRow('2026-08-21', 129400),
  ]
  const r = dailyWithholdingFromBalances(rows, '2026-08-26')
  ok('the rate comes off the decreases', r.rate === 430, `got ${r.rate}`)
  // CHANGED, session 244 (defect 1: the rate was the MEAN of the whole window).
  // The old assertion read '$8,600.00 of balance decreases across 20 days'. The
  // arithmetic behind the sentence is now a day-weighted median of the per-interval
  // rates, so the sentence has to say that — a basis line that describes a total
  // when the number shown is a median is the module lying about its own working.
  // The steady case is deliberately unchanged in VALUE: two intervals at $430.00 a
  // day are $430.00 a day by either method, which is the point of the median.
  ok('and says where it came from, and that it is a median',
     /the middle day's rate across 2 intervals on which this loan's balance actually fell — \$8,600\.00 over 20 such days/.test(r.basis), r.basis)

  // A balance that RISES is a fee or an advance. Averaging it in understates the
  // rate, which turns an ordinary gap into an alarm — the exact failure this
  // module exists to prevent.
  //
  // CHANGED, session 244 (defect 1: two falling intervals are now required). This
  // case used to build three rows — fall, rise — leaving ONE falling interval to
  // carry the whole answer. The property it was written for is real and is kept, so
  // it now builds a fourth row: the rise is still not a payment, and there are still
  // two intervals to take a median of.
  const withFee = dailyWithholdingFromBalances([
    lenderRow('2026-07-27', 138000),
    lenderRow('2026-08-06', 133700),
    lenderRow('2026-08-16', 150000),   // fee capitalised
    lenderRow('2026-08-26', 145700),
  ], '2026-08-26')
  ok('a rise is not counted as a payment', withFee.rate === 430, `got ${withFee.rate}`)

  ok('one balance cannot give a rate',
     dailyWithholdingFromBalances([lenderRow('2026-08-01', 1)], '2026-08-26').rate === null)
  // Three rows, so it is refused for the reason it claims — nothing ever fell —
  // rather than for being too few.
  ok('a balance that only ever rises gives no rate',
     dailyWithholdingFromBalances([
       lenderRow('2026-08-01', 100),
       lenderRow('2026-08-11', 200),
       lenderRow('2026-08-21', 300),
     ], '2026-08-26').rate === null)
  // CHANGED, session 244 (defect 1): both of the cases below used to prove their
  // point with the minimum two usable rows, which is now no longer a measurable
  // history. Each gains a row; each still tests exactly what it always tested.
  ok('future-dated rows are ignored',
     dailyWithholdingFromBalances([
       lenderRow('2026-08-01', 138000),
       lenderRow('2026-08-11', 133700),
       lenderRow('2026-08-21', 129400),
       lenderRow('2027-01-01', 1),
     ], '2026-08-26').rate === 430)
  ok('strings parse as well as numbers',
     dailyWithholdingFromBalances([
       lenderRow('2026-08-01', '138000'),
       lenderRow('2026-08-11', '133700'),
       lenderRow('2026-08-21', '129400'),
     ], '2026-08-26').rate === 430)
}

// ═══════════════════════════════════════════════════════════════════════════
// The four defects of the session-244 audit. Every number below is the number
// the audit reproduced against this module before it was fixed, so a regression
// does not merely fail — it fails with a recognisable figure.
// ═══════════════════════════════════════════════════════════════════════════

section('defect 1a — no rate from a single interval, ever')
{
  // A statement reissued the day after its predecessor. The old code, finding fewer
  // than two rows inside the 120-day window, fell back to `clean.slice(-2)` — the
  // last two rows whatever their dates — and measured $12,900.00 a day from that one
  // interval against a true $430.00 a day. Thirty times.
  //
  // Reachable in ordinary use, not in theory: a mode:'deep' run opens the run window
  // to 365 days while this cutoff stayed at 120, so every row reaching here can be
  // older than the window.
  const reissued = [
    lenderRow('2025-12-15', 160000),
    lenderRow('2026-01-14', 142900),
    lenderRow('2026-01-15', 130000),   // reissued one day later: -$12,900 in one day
  ]
  const r = dailyWithholdingFromBalances(reissued, '2026-08-26')
  ok('no window, no rate — the one-interval fallback is gone', r.rate === null, `got ${r.rate}`)
  ok('and it says which rule refused', /inside the last 120 days/.test(r.basis) && /at least 3/.test(r.basis), r.basis)

  // WHAT THAT FALLBACK BOUGHT, and why null is not a lesser answer. At $12,900.00 a
  // day a $60,000 discrepancy is four business days of settlement timing, benign,
  // severity info, grey text on the board. The rate is the whole finding.
  const asShipped = explainBalanceGap({
    gap: 60000, lenderAsOf: '2026-08-27', dailyWithholding: 12900,
    rateBasis: 'one interval', repaysContinuously: true, maxBusinessDays: 5 })
  // CHANGED, session 245 (defect 5). These two read '...was "4 business days of
  // settlement timing"' with verdict 'explained', and '...and was waved through as
  // benign'. Both described the module as it shipped, which is why they were
  // written — but the second one can no longer be true of ANY rate, however bogus,
  // so it is rewritten to say what actually protects the $60,000 now. The
  // arithmetic still lands on 4 business days: that is exactly the point, since the
  // arithmetic was never the safeguard.
  ok('$60,000 at the bogus rate STILL measures 4 business days of withholding',
     asShipped.impliedBusinessDays === 4, String(asShipped.impliedBusinessDays))
  ok('...but a rate can no longer wave it through', asShipped.verdict === 'unconfirmed_no_export' && !asShipped.benign,
     asShipped.verdict)

  // With no rate the same $60,000 stays in front of a person. A refusal to answer is
  // always safer than a wrong answer here, because only the wrong answer hides money.
  const refused = explainBalanceGap({
    gap: 60000, lenderAsOf: '2026-08-27', dailyWithholding: r.rate,
    rateBasis: r.basis, repaysContinuously: true })
  ok('with no rate the $60,000 is not explained away', refused.verdict === 'no_rate')
  ok('...and is not benign', !refused.benign)
}

section('defect 1b — the median, so one interval cannot carry the answer')
{
  // A $30,000 catch-up sweep on a single day, against ten ordinary ten-day intervals
  // of $4,300 ($430.00 a day). The mean of the window is $73,000 over 101 days =
  // $722.77 a day, 1.68x, and every dollar of that overstatement is tolerance.
  const sweep = [] as ReturnType<typeof lenderRow>[]
  const first = addDays('2026-08-26', -101)
  let bal = 138000
  for (let k = 0; k <= 10; k++) { sweep.push(lenderRow(addDays(first, k * 10), bal)); bal -= 4300 }
  sweep.push(lenderRow('2026-08-26', 65000))          // the sweep: -$30,000 in one day
  const swept = dailyWithholdingFromBalances(sweep, '2026-08-26')
  ok('a $30,000 sweep does not move the rate off $430.00', swept.rate === 430, `got ${swept.rate}`)
  ok('...and the old mean of those same rows was $722.77',
     Math.round((73000 / 101) * 100) / 100 === 722.77)

  // The worse one, because the module's own correct guard makes it: a rise is
  // DISCARDED, so a $24,000 fee capitalised and then reversed contributes nothing
  // when the balance goes up and the whole $24,000 when it comes back down. Mean:
  // $32,600 over 20 counted days = $1,630.00 a day, 3.79x.
  const reversed = [
    lenderRow('2026-07-27', 138000),
    lenderRow('2026-08-06', 133700),   // -4,300 over 10 days  =   $430.00/day
    lenderRow('2026-08-16', 157700),   // +24,000 fee capitalised: discarded, correctly
    lenderRow('2026-08-26', 129400),   // -28,300 over 10 days = $2,830.00/day
  ]
  const rev = dailyWithholdingFromBalances(reversed, '2026-08-26')
  ok('a capitalised-then-reversed fee does not move the rate off $430.00', rev.rate === 430, `got ${rev.rate}`)
  ok('...and the old mean of those same rows was $1,630.00 (3.79x)',
     Math.round((32600 / 20) * 100) / 100 === 1630 && Math.round((1630 / 430) * 100) / 100 === 3.79)
  // The tie rule, stated as a test because it is the whole difference here: two
  // equal-weight intervals of $430.00 and $2,830.00 average to exactly $1,630.00,
  // so a median that splits a tie by averaging would return the mean it replaced.
  ok('a two-way tie resolves DOWN, to the safer rate', rev.rate === 430 && rev.rate < (430 + 2830) / 2)

  // Weighted by DAYS, not by interval count. Three one-day reissues at $3,000 a day
  // must not outvote a quarter of real history at $430.00.
  const noisy = [
    lenderRow('2026-05-28', 138000),
    lenderRow('2026-06-27', 125100),   // 30 days at $430.00
    lenderRow('2026-07-27', 112200),   // 30 days at $430.00
    lenderRow('2026-07-28', 109200),   // 1 day at $3,000.00
    lenderRow('2026-07-29', 106200),   // 1 day at $3,000.00
    lenderRow('2026-07-30', 103200),   // 1 day at $3,000.00
  ]
  ok('three one-day spikes do not outvote sixty days of history',
     dailyWithholdingFromBalances(noisy, '2026-08-26').rate === 430,
     String(dailyWithholdingFromBalances(noisy, '2026-08-26').rate))

  // Two falling intervals is the floor: below it the "median" is one number again.
  const oneLeg = dailyWithholdingFromBalances([
    lenderRow('2026-08-01', 138000),
    lenderRow('2026-08-11', 150000),   // rise, discarded
    lenderRow('2026-08-21', 129400),   // the only fall
  ], '2026-08-26')
  ok('one falling interval is not a rate', oneLeg.rate === null, `got ${oneLeg.rate}`)
  ok('...and it says so', /at least 2/.test(oneLeg.basis), oneLeg.basis)
}

section("defect 2 — whose balances, and measuring what")
{
  // THE BOOKS' OWN BALANCE, interleaved with the lender's. A snapshot row is the
  // Xero-derived figure and sits ABOVE the lender's by exactly the settlement lag,
  // so every snapshot -> statement step reads as a one-day payment of the whole lag.
  // Real shape: lender statements every ten days at $430.47 a day, with the books'
  // daily snapshot landing five days into each gap, carrying the $2,166.05 lag.
  const lender: any[] = [], mixed: any[] = []
  for (let k = 0; k <= 3; k++) {
    const day = addDays('2026-07-27', k * 10)
    const bal = Math.round((125000 - 430.47 * k * 10) * 100) / 100
    lender.push(lenderRow(day, bal)); mixed.push(lenderRow(day, bal))
    if (k < 3) mixed.push({                       // the BOOKS balance, not the lender's
      statement_date: addDays('2026-07-27', k * 10 + 5),
      principal_balance: Math.round((125000 - 430.47 * (k * 10 + 5) + 2166.05) * 100) / 100,
      source: 'xero_balance_snapshot', balance_basis: 'total_payback',
    })
  }
  ok('the truth, from the lender rows alone', dailyWithholdingFromBalances(lender, '2026-08-26').rate === 430.47,
     String(dailyWithholdingFromBalances(lender, '2026-08-26').rate))
  ok('the snapshots are refused, and the rate is unchanged by their presence',
     dailyWithholdingFromBalances(mixed, '2026-08-26').rate === 430.47,
     String(dailyWithholdingFromBalances(mixed, '2026-08-26').rate))
  // The same rows with the snapshots wearing a lender label — i.e. exactly what the
  // function used to see. $863.68 a day, 2.01x, and the median does NOT save it:
  // every falling interval is contaminated, so the middle one is too. Only knowing
  // whose row it is saves it.
  const asItWas = dailyWithholdingFromBalances(
    mixed.map(r => ({ ...r, source: 'lender_statement', balance_basis: 'principal_only' })), '2026-08-26')
  ok('unfiltered, those same rows read $863.68 a day — 2.01x', asItWas.rate === 863.68, String(asItWas.rate))
  // What that bought, on the module as it actually shipped — the inflated rate AND
  // the 5-business-day default, which is the combination the audit measured. A real
  // $6,000 shortfall is 6.95 days at $863.68 (5 business days: benign) and 13.94
  // days at the true $430.47 (10 business days: not). Defect 3 happens to catch this
  // particular gap on its own now, which is what defence in depth looks like; the
  // rate is still the thing that decided it.
  const asShipped = (rate: number) => explainBalanceGap({
    gap: 6000, lenderAsOf: '2026-08-26', dailyWithholding: rate,
    rateBasis: 'x', repaysContinuously: true, maxBusinessDays: 5 })
  // CHANGED, session 245 (defect 5). This read '...which is what made a real
  // $6,000 shortfall benign' and asserted asShipped(863.68).benign === true. No
  // rate makes anything benign now, so the assertion states what the rate still
  // DECIDES: at the inflated rate the gap looks like timing (unconfirmed, and in
  // front of a person); at the true rate the same gap is ruled out outright. The
  // inflated rate is still worth preventing — it is the difference between a
  // finding that says "confirm this" and one that says "this is not timing".
  ok('...which turned a real $6,000 shortfall from ruled-out into merely unconfirmed',
     asShipped(863.68).verdict === 'unconfirmed_no_export' && asShipped(430.47).verdict === 'too_large',
     `${asShipped(863.68).verdict} / ${asShipped(430.47).verdict}`)
  ok('...and neither of them is benign any more',
     asShipped(863.68).benign === false && asShipped(430.47).benign === false)
  ok('...and at the true rate it was ten business days of withholding, not five',
     asShipped(430.47).impliedBusinessDays === 10 && asShipped(863.68).impliedBusinessDays === 5)

  // A DIFFERENT BASIS. A total_payback row carries the unamortized fee on top of
  // principal, so the step down to the next principal_only row books the fee as
  // withholding. Real fee: PayPal 2's $2,983.12. Truth $150.00 a day; unfiltered
  // $292.05 a day, 1.95x.
  const tp: any[] = []
  for (let k = 0; k <= 3; k++) {
    tp.push(lenderRow(addDays('2026-06-20', k * 22), 100000 - 150 * k * 22))
    if (k < 3) tp.push({
      statement_date: addDays('2026-06-20', k * 22 + 1),
      principal_balance: 100000 - 150 * (k * 22 + 1) + 2983.12,
      source: 'lender_statement', balance_basis: 'total_payback',
    })
  }
  ok('a total_payback row does not get to price principal withholding',
     dailyWithholdingFromBalances(tp, '2026-08-26').rate === 150,
     String(dailyWithholdingFromBalances(tp, '2026-08-26').rate))
  ok('unfiltered, that same fee read $292.05 a day',
     dailyWithholdingFromBalances(tp.map(r => ({ ...r, balance_basis: 'principal_only' })), '2026-08-26').rate === 292.05)

  // An unknown source or a missing basis fails INTO the filter, not out of it —
  // the same rule reconciliation-run's isDerivedSource() lives by. A future writer
  // inventing a source string must not be able to escape this the way
  // 'xero_balance_snapshot' escaped the derived-drift check.
  const bare = [
    { statement_date: '2026-08-01', principal_balance: 138000 },
    { statement_date: '2026-08-11', principal_balance: 133700 },
    { statement_date: '2026-08-21', principal_balance: 129400 },
  ]
  const bareR = dailyWithholdingFromBalances(bare, '2026-08-26')
  ok('rows with no source and no basis measure nothing', bareR.rate === null, `got ${bareR.rate}`)
  ok('...and the refusal names what it wanted', /lender document stating principal only/.test(bareR.basis), bareR.basis)
  ok('a brand-new source string is refused too',
     dailyWithholdingFromBalances(bare.map(r => ({ ...r, source: 'lender_api_v2', balance_basis: 'principal_only' })),
                                  '2026-08-26').rate === null)
  ok('...as is a lender row of unknown basis',
     dailyWithholdingFromBalances(bare.map(r => ({ ...r, source: 'portal_manual_pull', balance_basis: 'unknown' })),
                                  '2026-08-26').rate === null)
  // The two other real lender sources are not second-class.
  ok('email_pdf_upload and portal_manual_pull anchor a rate exactly as a statement does',
     dailyWithholdingFromBalances([
       { ...bare[0], source: 'email_pdf_upload', balance_basis: 'principal_only' },
       { ...bare[1], source: 'portal_manual_pull', balance_basis: 'principal_only' },
       { ...bare[2], source: 'lender_statement', balance_basis: 'principal_only' },
     ], '2026-08-26').rate === 430)
}

section('defect 3 — the lag is 2-3 business days, so the default is 3')
{
  ok('the default is 3 business days', DEFAULT_MAX_BUSINESS_DAYS === 3, String(DEFAULT_MAX_BUSINESS_DAYS))

  // THE CASE THAT MUST NOT BREAK. David's real Stripe Capital gap, at the rate from
  // the lender's own July export, against the lender's real as-of date. It was the
  // module's founding example and it is still explained at the tighter default —
  // three business days, which is the lag he described.
  const real = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: "the lender's July export", repaysContinuously: true,
  })
  // CHANGED, session 245 (defect 5). The first two read '...is still EXPLAINED at
  // the 3-day default' and '...still benign'. What this block exists to protect is
  // the SIZE test's boundary — that the founding example stays INSIDE the lag at
  // the tighter 3-day default rather than being ruled out by it — and that property
  // is unchanged and asserted below. It is the reassurance that moved, not the
  // arithmetic.
  ok('$2,166.05 at $430.47 a day is still inside the lag at the 3-day default',
     real.verdict === 'unconfirmed_no_export', real.verdict)
  ok('...but is no longer benign on the strength of an average', !real.benign)
  ok('...still 5.03 calendar days', real.impliedCalendarDays === 5.03, String(real.impliedCalendarDays))
  ok('...still exactly THREE business days', real.impliedBusinessDays === 3, String(real.impliedBusinessDays))

  // What the two extra days were worth, in the currency of this loan: a permanent
  // per-close allowance nobody had ever claimed. The 4th and 5th business day back
  // from Wednesday 2026-08-26 are Thursday and Friday the 20th/21st.
  const fourth = explainBalanceGap({
    gap: 2166.05 + 2 * 430.47, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: 'x', repaysContinuously: true })
  ok('two further days of withholding — $860.94 — is no longer inside the lag',
     fourth.verdict === 'too_large', fourth.verdict)
  // CHANGED, session 245 (defect 5): both of these asserted 'explained' on a
  // rate-only path. They test the maxBusinessDays boundary, which is unchanged —
  // inside the lag is now 'unconfirmed_no_export' and outside it is still
  // 'too_large', so the boundary is still visible and still moves with the override.
  ok('...it was inside the lag, at the old default of 5',
     explainBalanceGap({ gap: 2166.05 + 2 * 430.47, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
                         rateBasis: 'x', repaysContinuously: true, maxBusinessDays: 5 }).verdict === 'unconfirmed_no_export')
  ok('the override still works, so this was a change of DEFAULT and not of logic',
     explainBalanceGap({ gap: 700, lenderAsOf: '2026-08-26', dailyWithholding: 100,
                         rateBasis: 'x', repaysContinuously: true, maxBusinessDays: 5 }).verdict === 'unconfirmed_no_export')
}

section("defect 4 — the growth test the 'explained' sentence promises")
{
  ok('the bar is 25%', GAP_GROWTH_LIMIT === 0.25, String(GAP_GROWTH_LIMIT))

  // A shortfall compounding about $1,000 a close, on a loan withholding $430.47 a
  // day. Every one of these gaps is small enough to BE settlement timing; what says
  // it is not is that it keeps getting bigger, which is exactly what the sentence
  // shown to the user has always said would matter.
  const close = (gap: number, priorGap: number | null, priorGapAsOf: string | null = null) => explainBalanceGap({
    gap, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
    rateBasis: "the lender's July export", repaysContinuously: true, priorGap, priorGapAsOf })

  // CHANGED, session 245 (defect 5), here and everywhere below that this section
  // asserted 'explained'. Every `close()` call is a rate-only path — no export is
  // offered — so the verdict a gap inside the lag now reaches is
  // 'unconfirmed_no_export'. NOTHING about the growth test moved: 'growing' still
  // beats 'consistent', the 25% bar is unchanged, and the figures that cannot
  // measure growth are still ignored rather than guessed at. What changed is the
  // name of the verdict the growth test is distinguishing itself FROM.
  const first = close(700, null)
  ok('the first close has nothing to compare against, and is merely unconfirmed',
     first.verdict === 'unconfirmed_no_export', first.verdict)
  const second = close(1700, 700, '2026-07-26')
  ok('the second close is the same SIZE of lag but 142.9% bigger', second.verdict === 'growing', second.verdict)
  ok('...and is NOT benign', !second.benign)
  ok('...and names both figures and the percentage',
     /\$700\.00 at the 2026-07-26 close/.test(second.statement) &&
     /\$1,700\.00 now/.test(second.statement) && /up 142\.9%/.test(second.statement), second.statement)
  ok('...and still shows the arithmetic it was judged on',
     /\$1,700\.00 is 3\.95 days of withholding at \$430\.47 a day/.test(second.statement), second.statement)
  // Before this test existed all three closes came back benign:true while the gap
  // tripled. The third is now caught twice over — it has outgrown the lag as well.
  ok('the third close is too large on size alone', close(2700, 1700, '2026-08-26').verdict === 'too_large')

  // The bar, from both sides. Exactly 25% is not growth; a dollar more is.
  ok('exactly 25% is not growth', close(1250, 1000, '2026-07-26').verdict === 'unconfirmed_no_export')
  ok('25.1% is growing', close(1251, 1000, '2026-07-26').verdict === 'growing')

  // ADDITIVE. A caller that cannot supply a prior gap must lose nothing, so the
  // result with no prior figure has to be byte-identical to the result from before
  // the growth test existed.
  const bare = explainBalanceGap({ gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
                                   rateBasis: 'the export', repaysContinuously: true })
  const withNull = explainBalanceGap({ gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: 430.47,
                                       rateBasis: 'the export', repaysContinuously: true,
                                       priorGap: null, priorGapAsOf: null })
  ok('priorGap absent and priorGap null are the same answer, to the byte',
     JSON.stringify(bare) === JSON.stringify(withNull))
  // CHANGED, session 245 (defect 5). This read '...and that answer is the one this
  // module shipped with', asserting explained/benign — i.e. it pinned the shipped
  // answer, and the shipped answer was the defect. The ADDITIVE property it guards
  // (a caller with no prior gap loses nothing) is untouched and is the assertion
  // above; what this one now pins is that the answer both callers get is the
  // refusal rather than the reassurance.
  ok('...and that answer is a refusal, not a reassurance',
     bare.verdict === 'unconfirmed_no_export' && !bare.benign && /an assumption, not a measurement/.test(bare.statement))

  // Figures that cannot measure growth are ignored rather than guessed at.
  ok('a zero prior gap is not an infinite increase', close(1700, 0, '2026-07-26').verdict === 'unconfirmed_no_export')
  ok('a prior gap that ran the other way is not a baseline', close(1700, -700, '2026-07-26').verdict === 'unconfirmed_no_export')
  ok('a baseline that is not older measures nothing', close(1700, 700, '2026-08-26').verdict === 'unconfirmed_no_export')
  ok('a baseline dated AFTER this close is refused too', close(1700, 700, '2026-09-26').verdict === 'unconfirmed_no_export')
  ok('a prior gap with no date is still usable — the caller chose the close',
     close(1700, 700, null).verdict === 'growing')
  ok('...and says so without inventing a date',
     /at the previous close/.test(close(1700, 700, null).statement))

  // When a prior close IS supplied and the gap held steady, the sentence says so —
  // otherwise "what would matter is the gap growing" reads as an untested promise
  // on a finding where it was, in fact, tested.
  // CHANGED, session 245 (defect 5): 'a gap that held steady is explained' asserted
  // the benign verdict, and the sentence it checked for was the 'explained' branch's
  // wording. The property is kept in full — when a baseline IS supplied, the
  // comparison must be REPORTED and not merely made — and it now has to hold on the
  // unconfirmed branch, which is where a gap with no export ends up. The wording
  // differs because the claim differs: on this branch a steady gap is a fact worth
  // knowing and explicitly not a confirmation.
  const held = close(2166.05, 2100, '2026-07-26')
  ok('a gap that held steady is consistent with timing, and unconfirmed', held.verdict === 'unconfirmed_no_export')
  ok('...and the sentence reports the comparison it made',
     /The gap has not grown, for what that is worth: it was \$2,100\.00 at the 2026-07-26 close and is \$2,166\.05 now, up 3\.1%\./.test(held.statement),
     held.statement)
  ok('...and a shrinking gap is reported as down, not as a negative rise',
     /is \$700\.00 now, down 58\.8%\./.test(close(700, 1700, '2026-07-26').statement),
     close(700, 1700, '2026-07-26').statement)

  // Growth cannot rescue the verdicts that were never about size.
  ok('a shrinking gap is not growth', close(700, 1700, '2026-07-26').verdict === 'unconfirmed_no_export')
  ok('the wrong direction is still the wrong direction',
     explainBalanceGap({ gap: -1700, lenderAsOf: '2026-08-26', dailyWithholding: 430.47, rateBasis: 'x',
                         repaysContinuously: true, priorGap: 700, priorGapAsOf: '2026-07-26' }).verdict === 'wrong_direction')
  ok('a loan not repaid from receipts is still not_continuous',
     explainBalanceGap({ gap: 1700, lenderAsOf: '2026-08-26', dailyWithholding: 430.47, rateBasis: 'x',
                         repaysContinuously: false, priorGap: 700, priorGapAsOf: '2026-07-26' }).verdict === 'not_continuous')
  ok('no rate is still no_rate — growth is not a substitute for a measurement',
     explainBalanceGap({ gap: 1700, lenderAsOf: '2026-08-26', dailyWithholding: null, rateBasis: 'x',
                         repaysContinuously: true, priorGap: 700, priorGapAsOf: '2026-07-26' }).verdict === 'no_rate')
}

// ═══════════════════════════════════════════════════════════════════════════
// DEFECT 5, the session-245 audit: the rate WAS the test, and a rate cannot be
// one. Every figure below is measured off the real July export in fixtures/,
// by the shipped parser, at the time the test runs — nothing here is a number
// somebody typed in.
// ═══════════════════════════════════════════════════════════════════════════

const JULY_CSV = process.env.WR_STRIPE_CSV
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'Stripe_July.csv')
// Loudly, not as a skip: a fixture that has moved must fail this file, because an
// assertion that quietly stops firing reads exactly like an assertion that passes.
if (!fs.existsSync(JULY_CSV)) throw new Error(`the real July export is not at ${JULY_CSV} — these assertions cannot run against a substitute`)
const CSV = parseStripeCapitalCsv(fs.readFileSync(JULY_CSV, 'utf8'))

section('defect 5a — what the mean was hiding')
{
  ok('the real export parses, 1,352 paydown rows', CSV.ok && CSV.rows_accepted === 1352, `${CSV.ok} ${CSV.rows_accepted}`)
  ok('...over 26 Pacific days, 2026-07-06 to 2026-07-31',
     CSV.days.length === 26 && CSV.first_date === '2026-07-06' && CSV.last_date === '2026-07-31')
  const sum = (k: 'total_paid' | 'principal_paid') =>
    Math.round(CSV.days.reduce((a, d) => a + d[k], 0) * 100) / 100
  ok('the new per-day totals reconcile to the month, to the cent',
     sum('total_paid') === CSV.totals!.total_paid && sum('principal_paid') === CSV.totals!.principal_paid,
     `${sum('total_paid')} vs ${CSV.totals!.total_paid}`)

  // THE FIGURE THE MODULE USED TO DIVIDE BY, and what it is.
  const daily = CSV.days.map(d => d.total_paid)
  const lo = Math.min(...daily), hi = Math.max(...daily)
  const mean = Math.round((CSV.totals!.total_paid / CSV.days.length) * 100) / 100
  ok('$430.47 is exactly the mean of this month, which is where it came from', mean === 430.47, String(mean))
  ok('...and NO day in the month is $430.47', !daily.includes(430.47))
  ok('daily withholding runs $28.40 to $694.44 — a 24x swing around that mean',
     lo === 28.4 && hi === 694.44 && Math.round(hi / lo) === 24, `${lo} to ${hi}`)

  // THE WINDOW, on the other hand, is a real quantity: 1.8x rather than 24x. That
  // is why the fix is to measure the window, not to find a better rate.
  const windowTotal = (from: string, to: string) =>
    Math.round(CSV.days.filter(d => d.date > from && d.date <= to).reduce((a, d) => a + d.total_paid, 0) * 100) / 100
  let cheapest = Infinity, dearest = 0, dearestEnd = ''
  for (const d of CSV.days) {
    const w = settlementWindow(d.date, DEFAULT_MAX_BUSINESS_DAYS)!
    if (w.from < CSV.first_date!) continue          // window runs off the front of the file
    const t = windowTotal(w.from, w.to)
    if (t < cheapest) cheapest = t
    if (t > dearest) { dearest = t; dearestEnd = d.date }
  }
  ok('the cheapest three-business-day window in the month is $1,346.09', cheapest === 1346.09, String(cheapest))
  ok('the dearest is $2,393.23, ending 2026-07-15', dearest === 2393.23 && dearestEnd === '2026-07-15', `${dearest} ${dearestEnd}`)
  ok('a window swings 1.8x where a day swings 24x — which is why the window is what gets measured',
     Math.round((dearest / cheapest) * 10) / 10 === 1.8)
}

section('defect 5b — the settlement window is calendar days, delayed by business days')
{
  // The module's own founding example, as a function rather than as a sentence.
  ok('3 business days back from Wednesday 2026-08-26 opens on Friday 2026-08-21',
     settlementWindow('2026-08-26', 3)!.from === '2026-08-21', JSON.stringify(settlementWindow('2026-08-26', 3)))
  ok('...and that span really does contain exactly 3 business days',
     businessDaysBetween('2026-08-21', '2026-08-26') === 3)
  // The weekend inside the span is IN the window. Stripe withholds when the sale
  // clears and sales happen on Saturday; the July file carries $28.40 on a Sunday.
  ok('the window includes the weekend it spans (5 calendar days for 3 business days)',
     Math.round((Date.parse('2026-08-26') - Date.parse('2026-08-21')) / 86_400_000) === 5)
  ok('the window never OPENS on a weekend — the books move when a payout lands',
     [0, 6].indexOf(new Date(settlementWindow('2026-08-24', 3)!.from + 'T00:00:00Z').getUTCDay()) === -1,
     settlementWindow('2026-08-24', 3)!.from)
  ok('a nonsense day count is refused rather than looped',
     settlementWindow('2026-08-26', 0) === null && settlementWindow('2026-08-26', 999) === null)
  ok('an unreadable date is refused', settlementWindow('not-a-date', 3) === null)
}

section('defect 5c — $2,166.05, the founding example, against the real export')
{
  const july = lenderExportFromCsv(CSV, 'total_paid')!
  const rate = dailyWithholdingFromMonths(CSV.months)

  // THE HEADLINE. The gap David actually had, the export he actually filed, and
  // the date the balance is actually as of. July cannot speak for August.
  const real = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-08-26', dailyWithholding: rate.rate, rateBasis: rate.basis,
    repaysContinuously: rate.continuous, lenderExport: july })
  ok('$2,166.05 on 2026-08-26 is NOT benign on a July export', !real.benign && real.verdict === 'unconfirmed_no_export', real.verdict)
  ok('...and the refusal is freshness, named as such', real.exportEvidence === 'stale')
  ok('...and it names the date the last export ends', /ends 2026-07-31, 26 days before this balance date/.test(real.statement), real.statement)
  ok('...and asks for the one thing that would settle it',
     /Upload a transaction export from this lender covering 2026-08-21 to 2026-08-26/.test(real.statement))
  ok('...and claims no measurement it did not make', real.windowWithholding === null && real.windowFrom === '2026-08-21')

  // AND A REAL EXPORT COVERING THE WINDOW CAN CONFIRM A GAP. Same gap, same file,
  // a date the file actually covers: the dearest window in the month is $2,393.23,
  // which covers $2,166.05 with room to spare.
  const covered = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-07-15', dailyWithholding: rate.rate, rateBasis: rate.basis,
    repaysContinuously: rate.continuous, lenderExport: july })
  ok('the same gap on a date the export covers IS explained', covered.verdict === 'explained', covered.verdict)
  ok('...and is benign', covered.benign)
  ok('...against a MEASURED window of $2,393.23 from 2026-07-10',
     covered.windowWithholding === 2393.23 && covered.windowFrom === '2026-07-10',
     `${covered.windowWithholding} ${covered.windowFrom}`)
  ok('...and the books-through date is walked back through real days, not divided out',
     covered.impliedBooksThrough === '2026-07-10' && covered.impliedBusinessDays === 3,
     `${covered.impliedBooksThrough} / ${covered.impliedBusinessDays}`)
  ok('...and the sentence says it was measured, not assumed',
     /measured against the lender's own transactions rather than assumed from an average/.test(covered.statement))

  // THE POINT OF THE WHOLE EXERCISE, in one pair of assertions: the SAME gap
  // against the SAME export is explained in one window and ruled out in another,
  // because the two windows hold different money. A mean cannot tell these apart —
  // it returns 5.03 days for both.
  const thin = explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-07-31', dailyWithholding: rate.rate, rateBasis: rate.basis,
    repaysContinuously: rate.continuous, lenderExport: july })
  ok('the same gap over the LAST three business days of July is too large',
     thin.verdict === 'too_large' && !thin.benign, thin.verdict)
  ok('...because those three days only carried $1,369.37', thin.windowWithholding === 1369.37, String(thin.windowWithholding))
  // And the mean cannot tell the two apart: strip the export out and both dates
  // return the identical 5.03 days, 3 business days, "consistent with timing".
  const byRate = (asOf: string) => explainBalanceGap({
    gap: 2166.05, lenderAsOf: asOf, dailyWithholding: 430.47, rateBasis: 'the mean', repaysContinuously: true })
  // The identical 5.03 days for both, because gap / mean depends on the GAP and
  // nothing else — not on which days those were or what happened on them. (The
  // business-day count it derives does differ, 3 against 5, but only because of
  // where the weekend falls in the calendar: still not because of any money.)
  ok('...and the mean calls BOTH of those windows 5.03 days of withholding',
     byRate('2026-07-15').impliedCalendarDays === 5.03 && byRate('2026-07-31').impliedCalendarDays === 5.03,
     `${byRate('2026-07-15').impliedCalendarDays} / ${byRate('2026-07-31').impliedCalendarDays}`)
  ok('...which is why neither of them is allowed to be benign on the mean alone',
     !byRate('2026-07-15').benign && !byRate('2026-07-31').benign)
}

section('defect 5d — the basis of the window has to match the basis of the gap')
{
  const rate = dailyWithholdingFromMonths(CSV.months)
  const ask = (basis: 'principal_only' | 'total_paid') => explainBalanceGap({
    gap: 2166.05, lenderAsOf: '2026-07-15', dailyWithholding: rate.rate, rateBasis: rate.basis,
    repaysContinuously: rate.continuous, lenderExport: lenderExportFromCsv(CSV, basis) })
  // The same window, the same gap, 14% apart — and the 14% is the fee. A gap
  // measured principal-only compared against total withholding is arithmetic
  // between two different quantities, and here it is the difference between
  // 'explained' and 'too_large'.
  ok('total withholding over the window is $2,393.23', ask('total_paid').windowWithholding === 2393.23)
  ok('principal withholding over the same window is $2,050.75', ask('principal_only').windowWithholding === 2050.75)
  ok('...so a principal-only gap of $2,166.05 is NOT covered by it',
     ask('principal_only').verdict === 'too_large' && ask('total_paid').verdict === 'explained',
     `${ask('principal_only').verdict} / ${ask('total_paid').verdict}`)
}

section('defect 5e — freshness, coverage, completeness')
{
  const day = (date: string, withheld: number) => ({ date, withheld })
  // A synthetic export rich enough to cover any gap below, so that every refusal
  // here is the refusal it claims to be and not "not enough money in the window".
  const rich = (from: string, through: string, complete = true) => {
    const days = []
    for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(through + 'T00:00:00Z'); t += 86_400_000) {
      days.push(day(new Date(t).toISOString().slice(0, 10), 1000))
    }
    return { days, coversFrom: from, coversThrough: through, complete, measures: 'withheld', label: 'a test export' }
  }
  const ask = (ex: any) => explainBalanceGap({
    gap: 500, lenderAsOf: '2026-08-26', dailyWithholding: 100, rateBasis: 'x',
    repaysContinuously: true, lenderExport: ex })

  ok('an export ending ON the balance date confirms', ask(rich('2026-08-01', '2026-08-26')).verdict === 'explained')
  // ONE day of tolerance, and exactly one: an export pulled on the morning of the
  // 26th holds no paydowns for the 26th yet. Two days is a different claim — it
  // covers a whole missing business day of the very sales in question.
  ok('an export ending the day before is still current (the pull-time boundary)',
     ask(rich('2026-08-01', '2026-08-25')).verdict === 'explained')
  ok('an export ending two days before is stale',
     ask(rich('2026-08-01', '2026-08-24')).verdict === 'unconfirmed_no_export' &&
     ask(rich('2026-08-01', '2026-08-24')).exportEvidence === 'stale')
  ok('the tolerance is one day, and is declared', EXPORT_FRESHNESS_TOLERANCE_DAYS === 1)

  // COVERAGE. A current export that starts inside the window is missing the
  // earliest and largest part of the unsettled withholding.
  ok('an export that does not reach back to the window start cannot confirm',
     ask(rich('2026-08-24', '2026-08-26')).verdict === 'unconfirmed_no_export' &&
     ask(rich('2026-08-24', '2026-08-26')).exportEvidence === 'not_covering')
  ok('...and an export starting exactly on the first day of the window can',
     ask(rich('2026-08-22', '2026-08-26')).verdict === 'explained',
     ask(rich('2026-08-22', '2026-08-26')).verdict)

  // COMPLETENESS. rows_rejected_count > 0 makes StripeCsvParseResult.ok false, and
  // an export with unread rows understates the window. It fails safe either way —
  // but it is not allowed to be the thing that blesses a gap.
  ok('an export that could not be read in full cannot confirm',
     ask(rich('2026-08-01', '2026-08-26', false)).verdict === 'unconfirmed_no_export' &&
     ask(rich('2026-08-01', '2026-08-26', false)).exportEvidence === 'incomplete')
  ok('...and the refusal says so, naming the file it will not lean on',
     /could not be read in full/.test(ask(rich('2026-08-01', '2026-08-26', false)).statement))

  // The builder carries ok:false through rather than dropping the file: the DATE
  // is still worth naming in a refusal.
  const incompleteCsv = lenderExportFromCsv({ ...CSV, ok: false }, 'total_paid')!
  ok('lenderExportFromCsv keeps a refused export, marked incomplete',
     incompleteCsv.complete === false && incompleteCsv.coversThrough === '2026-07-31')
  ok('an empty export is nothing at all', lenderExportFromCsv({ ok: true, days: [], first_date: null, last_date: null }, 'total_paid') === null)
}

section('defect 5f — no rate-only path reaches a benign verdict, ever')
{
  // The invariant, swept rather than sampled. Any gap, any rate, any date, any
  // baseline: with no export nothing comes back benign except a gap of exactly
  // zero, which has no money in it to attribute to anything.
  let benignSeen = 0, nonZeroBenign = 0
  for (const gap of [0, 0.01, 1, 100, 500, 700, 2166.05, 6000, 21660.5, 60000]) {
    for (const rate of [1, 100, 430.47, 863.68, 12900]) {
      for (const asOf of ['2026-08-26', null]) {
        for (const prior of [null, 700, 100000]) {
          for (const maxBiz of [3, 5]) {
            const r = explainBalanceGap({
              gap, lenderAsOf: asOf, dailyWithholding: rate, rateBasis: 'x',
              repaysContinuously: true, priorGap: prior, priorGapAsOf: '2026-01-01', maxBusinessDays: maxBiz })
            if (r.benign) { benignSeen++; if (gap !== 0) nonZeroBenign++ }
            if (r.verdict === 'explained' && gap !== 0) nonZeroBenign++
          }
        }
      }
    }
  }
  ok('600 rate-only combinations, and not one non-zero gap comes back benign', nonZeroBenign === 0, String(nonZeroBenign))
  ok('...the only benign ones are the 60 zero-gap combinations', benignSeen === 60, String(benignSeen))
  ok('a zero gap says so, rather than borrowing the timing sentence',
     /no gap for settlement timing or anything else to explain/.test(
       explainBalanceGap({ gap: 0, lenderAsOf: '2026-08-26', dailyWithholding: 100, rateBasis: 'x', repaysContinuously: true }).statement))

  // The verdicts that were never about size are still reached before any of this.
  const withExport = (gap: number, extra: Record<string, unknown>) => explainBalanceGap({
    gap, lenderAsOf: '2026-08-26', dailyWithholding: 430.47, rateBasis: 'x', repaysContinuously: true,
    lenderExport: lenderExportFromCsv(CSV, 'total_paid'), ...extra })
  ok('a current export cannot rescue the wrong direction', withExport(-100, {}).verdict === 'wrong_direction')
  ok('...nor a loan that is not repaid from receipts', withExport(100, { repaysContinuously: false }).verdict === 'not_continuous')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
