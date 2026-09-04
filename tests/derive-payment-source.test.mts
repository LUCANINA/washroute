// tests/derive-payment-source.test.mts — the payment a rate is measured against
// must come from the LENDER, never from the note typed on the loan.
//
// Run:  npx tsx tests/derive-payment-source.test.mts
//
// Session 270. deriveSchedule read `statedPayment(usable) ?? loan.scheduled_monthly_payment`,
// directly beneath a comment explaining why the typed figure must never stand in for the
// lender's own. Two defects in one expression:
//
//   1. the forbidden substitution itself, and
//   2. a UNITS error nobody had named: a *monthly* column handed in as the payment for one
//      statement-to-statement PERIOD, which on a weekly-draft loan is seven days.
//
// Measured on PayPal 2 (A00845102): typed $15,000.00 monthly, real draft $3,414.71 weekly.
// Implied interest per period came out as 15,000.00 - 2,681.39 = $12,318.61, matching that
// run's first per_period row to the cent, and the fitter reported 618.064% annual before
// refusing. The refusal was right and its REASON was wrong: it said the rate would not fit
// when the truth was that no payment amount had ever been supplied.

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}

const src = readFileSync(new URL('../supabase/functions/_shared/derive-schedule.ts', import.meta.url), 'utf-8')
const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

console.log('\n  the typed figure is not a payment source')
ok('no `?? num(loan.scheduled_monthly_payment)` fallback survives',
  !/\?\?\s*num\(loan\.scheduled_monthly_payment\)/.test(code),
  'the typed monthly figure is standing in for the lender again — see session 270')
ok('buildPeriods is fed the lender-stated payment',
  /buildPeriods\(stmts,\s*stated\)/.test(code))
ok('a missing stated payment is refused, not substituted',
  /reason:\s*'no_stated_payment'/.test(code))
ok('...and the refusal names the typed figure so the reader knows why it was skipped',
  /typed_monthly_payment/.test(code))

console.log('\n  IT DISCRIMINATES — the shipped defect, reproduced')
// The exact expression that was in the file, and the exact arithmetic it produced.
const brokenLine = 'const fallbackPayment = stated ?? num(loan.scheduled_monthly_payment)'
ok('the first assertion would have caught the shipped line',
  /\?\?\s*num\(loan\.scheduled_monthly_payment\)/.test(brokenLine))
ok('the second would have caught it too (buildPeriods took the fallback, not `stated`)',
  !/buildPeriods\(stmts,\s*stated\)/.test('const allPeriods = buildPeriods(stmts, fallbackPayment)'))

console.log('\n  the measurement that identified it, frozen')
// Not arithmetic for its own sake: this is the fingerprint that told us the typed MONTHLY
// figure was being used as a WEEKLY payment. If a future change reintroduces a per-period
// payment of 15000 on this loan, the per_period `actual` will be this number again.
const TYPED_MONTHLY = 15000.00
const PAYPAL2_FIRST_PERIOD_PRINCIPAL_DROP = 154331.30 - 151649.91   // 2025-12-17 -> 2025-12-24
const OBSERVED_ACTUAL_IN_RUN = 12318.61
ok('15,000.00 − 2,681.39 = 12,318.61, the run\'s first per_period `actual`',
  Math.abs((TYPED_MONTHLY - PAYPAL2_FIRST_PERIOD_PRINCIPAL_DROP) - OBSERVED_ACTUAL_IN_RUN) < 0.005,
  `got ${(TYPED_MONTHLY - PAYPAL2_FIRST_PERIOD_PRINCIPAL_DROP).toFixed(2)}`)
ok('the real draft is nowhere near it — 3,414.71 weekly, ~14,797 a month',
  Math.abs(3414.71 * 52 / 12 - 14797.08) < 0.5)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
if (fail) process.exit(1)
