// tests/payroll-clearing.test.mts — which account payroll draws on, and when a
// draw is genuinely an overdraft.
//
// Run:  npx tsx tests/payroll-clearing.test.mts
//
// The figures below are the REAL 2026-08-21 period and the REAL account
// balances that blocked it, taken from Xero on 2026-09-03. That matters: the
// old model was not wrong in the abstract, it was wrong about this book, and a
// test built on invented round numbers would have been satisfied by it.

import { cashDraw, overdraws, shortfall, BALANCE_TOLERANCE }
  from '../supabase/functions/_shared/payroll-clearing.ts'

let pass = 0
const fails: string[] = []
function eq(actual: unknown, expected: unknown, what: string) {
  if (Object.is(actual, expected)) { pass++; return }
  fails.push(`${what}\n     expected: ${expected}\n     actual:   ${actual}`)
}

// ── The 2026-08-21 period, as Square reported it ────────────────────────────
// Employer tax $1,563.80 and employee CA $639.18 are the figures on the import;
// $639.18 is also, to the cent, the EDD payment made that same day — which is
// the whole point: the money was paid, it just went to 170.
const AUG21 = {
  netPay: 16_820.87,
  eeFederal: 2_474.95,
  eeCalifornia: 639.18,
  erTax: 1_563.80,
}
// Corroboration, and the reason these are not invented numbers: the Post to Xero
// screen for this period showed "Payroll cash draw (net pay + EE fed + ER tax)
// -$20,859.62" and "EE CA tax to EDD -$639.18". Under the old model those are
// the two credits; 20,859.62 + 639.18 = 21,498.80, which is the single credit
// now. If someone changes these inputs, that identity is what to re-derive.
const OLD_MODEL_170 = 20_859.62
const OLD_MODEL_171 = 639.18

const draw = cashDraw(AUG21)

// 1. Employee CA tax is part of the 170 draw.
eq(draw.from170, 21_498.80, 'Aug 21 draws net pay + EE fed + EE CA + ER tax from 170')

// 1b. The new single credit is exactly the old two added together — nothing was
//     invented and nothing was lost, only relocated.
eq(draw.from170, Math.round((OLD_MODEL_170 + OLD_MODEL_171) * 100) / 100,
   'the one credit equals the two it replaced, to the cent')

// 2. Nothing is drawn from 171. This is the assertion that goes red if anyone
//    reinstates the split.
eq(draw.from171, 0, 'nothing is drawn from 171')

// 3. Every dollar is accounted for — the draw equals the sum of its parts, so a
//    future edit cannot quietly drop a component and still look plausible.
eq(draw.from170 + draw.from171,
   Math.round((AUG21.netPay + AUG21.eeFederal + AUG21.eeCalifornia + AUG21.erTax) * 100) / 100,
   'the draw loses nothing')

// ── The false alarm, reproduced exactly ─────────────────────────────────────
// 171 really held -$955.80 on 2026-09-03. Under the old rule the period drew
// $639.18 from it and was refused "short $1,594.98". Both numbers appear here
// so the regression is recognisable if it ever returns.
const REAL_171 = { ok: true, available: -955.80 }
const REAL_170 = { ok: true, available: 46_321.79 }

eq(overdraws(draw.from171, REAL_171), false,
   'a zero draw against a negative 171 is NOT an overdraft')
eq(shortfall(draw.from171, REAL_171), null,
   'a zero draw reports no shortfall (not +955.80)')
eq(overdraws(draw.from170, REAL_170), false,
   'the real 170 balance covers the real Aug 21 draw')

// The old arithmetic, stated once so it is unmistakable what changed:
// money(0 - (-955.80)) = +955.80 > 0.01 would have been an "overdraft" on an
// account the posting never touches.
eq(Math.round((0 - REAL_171.available!) * 100) / 100 > BALANCE_TOLERANCE, true,
   'the unguarded comparison really would have blocked (this is the bug, stated)')

// ── The gate must still work where it is real ───────────────────────────────
eq(overdraws(draw.from170, { ok: true, available: 100 }), true,
   'a genuine shortfall in 170 still blocks')
eq(shortfall(draw.from170, { ok: true, available: 100 }), 21_398.80,
   'and reports the right shortfall')
eq(overdraws(draw.from170, { ok: true, available: draw.from170 }), false,
   'exactly enough cash is not an overdraft')
eq(overdraws(draw.from170, { ok: true, available: draw.from170 - 0.005 }), false,
   'a half-cent under is within tolerance')
eq(overdraws(draw.from170, { ok: true, available: draw.from170 - 0.02 }), true,
   'two cents under is not')

// ── An unreadable balance blocks only a draw actually being made ────────────
eq(overdraws(draw.from170, { ok: false }), true,
   'cannot read 170 and we are drawing on it -> refuse to post blind')
eq(overdraws(draw.from171, { ok: false }), false,
   'cannot read 171 and we are NOT drawing on it -> irrelevant, do not block')

// ── A period with no cash draws nothing ─────────────────────────────────────
const empty = cashDraw({ netPay: 0, eeFederal: 0, eeCalifornia: 0, erTax: 0 })
eq(empty.from170, 0, 'an empty period draws nothing from 170')
eq(overdraws(empty.from170, { ok: true, available: -1_000_000 }), false,
   'an empty period cannot overdraw anything')

if (fails.length) {
  console.error(`\n✗ ${fails.length} FAILED, ${pass} passed\n`)
  for (const f of fails) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`✓ payroll-clearing: ${pass} assertions passed`)
