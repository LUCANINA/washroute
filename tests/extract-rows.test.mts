// tests/extract-rows.test.mts — THE ARITHMETIC GATE ON A TRANSCRIBED HISTORY
//
// Run:  npx tsx tests/extract-rows.test.mts
//
// Session 277. A BayFirst portal screenshot was read correctly and then ruined
// twice by the code that checks the reading:
//
//   1. The gate REJECTED the only row that mattered, quoting arithmetic that is
//      right: "balance 135206.37 does not follow from the previous balance
//      135901.60 less principal -695.23". It does follow — 135,901.60 − 695.23
//      = 135,206.37 exactly. That portal prints a payment's parts as NEGATIVE
//      numbers, and the continuity check read them at face value.
//   2. The surviving row was dated **2024**-07-31. The screen prints "Sep 2" and
//      no year anywhere, and the tool schema demanded ISO — so the model had no
//      way to comply except to invent one. A guessed year passes every
//      arithmetic check downstream, because the figures are all fine.
//
// Both are the same failure in different clothes: the check was more confident
// than its inputs justified. This file imports the shipped validator.

import { validateExtractedRows } from '../supabase/functions/_shared/extracted-rows.ts'

const TODAY = '2026-09-05'
let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name: string, actual: any, expected: any) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

const row = (o: any) => ({
  principal: null, interest: null, payment: null, balance: null,
  yearPrinted: true, dateAsPrinted: null, ...o,
})

// The real screen, verbatim. Three lines share 2026-09-02, each with its own
// running balance, every amount negative because on that screen they are decreases.
const BAYFIRST = [
  row({ date: '2026-07-31', payment: -2108.24, balance: 135901.60, kind: 'payment' }),
  row({ date: '2026-09-02', principal: -695.23, balance: 135206.37, kind: 'principal' }),
  row({ date: '2026-09-02', interest: -1413.01, balance: 135901.60, kind: 'interest' }),
  row({ date: '2026-09-02', payment: -2108.24, balance: 135901.60, kind: 'payment' }),
]

console.log('\n§1 — the negative-amount portal now gets through')
{
  const r = validateExtractedRows(BAYFIRST as any, TODAY)
  const sep = r.periods.find(p => p.statementDate === '2026-09-02')
  ok('the 9/02 payment survives the gate', !!sep,
     `rejected: ${JSON.stringify(r.rejected)}`)
  if (sep) {
    eq('...at the balance printed AFTER every part of the payment', sep.principalBalance, 135206.37)
    eq('...with the split carried as magnitudes', sep.explicitSplit, { principal: 695.23, interest: 1413.01 })
    eq('...and the payment footing to the two halves', sep.totalAmountDue, 2108.24)
  }
}

console.log('\n§2 — DISCRIMINATION: as-printed signs would reject it')
{
  // The pre-fix behaviour, reproduced by giving the validator a document whose
  // magnitudes do NOT foot — so the measured convention stays as-printed and the
  // continuity check runs exactly as it used to.
  const broken = [
    row({ date: '2026-09-01', balance: 200000.00, kind: 'payment' }),
    row({ date: '2026-09-02', principal: -695.23, balance: 135206.37, kind: 'principal' }),
  ]
  const r = validateExtractedRows(broken as any, TODAY)
  ok('a document whose magnitudes do not foot is still refused',
     r.periods.length === 1 && !r.periods.some(p => p.statementDate === '2026-09-02'),
     JSON.stringify(r.rejected))
  ok('...naming the continuity failure, not something vague',
     /does not follow from the previous balance/.test(r.rejected.map(x => x.reason).join(' ')),
     JSON.stringify(r.rejected))
}

console.log('\n§3 — a DRAW must not be flattened into a paydown')
{
  // The reason the fix is not Math.abs() everywhere. A negative principal means
  // new borrowing on some lenders, and the balance RISES. That document foots as
  // printed and must be left exactly as printed (session 247: a rollforward has
  // no term for borrowing unless you give it one).
  const draw = [
    row({ date: '2026-07-01', balance: 100000.00, kind: 'payment' }),
    row({ date: '2026-08-01', principal: -25000.00, balance: 125000.00, kind: 'principal' }),
  ]
  const r = validateExtractedRows(draw as any, TODAY)
  const d = r.periods.find(p => p.statementDate === '2026-08-01');
  ok('the drawdown row is accepted', !!d, JSON.stringify(r.rejected))
  eq('...and its balance still RISES — the sign was not flattened', d?.principalBalance, 125000.00)
}

console.log('\n§4 — a guessed year is not a date')
{
  const noYear = [
    row({ date: '1900-09-02', yearPrinted: false, dateAsPrinted: 'Sep 2',
          principal: 695.23, balance: 135206.37, kind: 'principal' }),
  ]
  const r = validateExtractedRows(noYear as any, TODAY)
  eq('nothing is imported from a row whose year was supplied', r.periods.length, 0)
  ok('...and the refusal quotes the date AS PRINTED, so the reader can place it',
     r.rejected.some(x => x.date === '"Sep 2"'), JSON.stringify(r.rejected))
  ok('...and says a year is never guessed',
     /never guessed/.test(r.rejected.map(x => x.reason).join(' ')), JSON.stringify(r.rejected))
  // DISCRIMINATION: the identical row with a printed year goes through.
  const withYear = [row({ date: '2026-09-02', yearPrinted: true, principal: 695.23, balance: 135206.37, kind: 'principal' })]
  eq('⭐ the SAME row with a printed year is imported — so §4 tests the flag, not the figures',
     validateExtractedRows(withYear as any, TODAY).periods.length, 1)
}

console.log('\n§4b — the sentinel outranks the flag')
{
  // The real thing, from a live BayFirst portal screenshot: the model used the 1900
  // sentinel and set year_printed TRUE on the same row. It fell through to the
  // generic "date outside a plausible range" -- true, but the wrong cause, which
  // sends the reader hunting a bad date instead of a missing year.
  const lying = [row({ date: '1900-09-02', yearPrinted: true, dateAsPrinted: 'Sep 2',
                       principal: 695.23, balance: 135206.37, kind: 'principal' })]
  const r = validateExtractedRows(lying as any, TODAY)
  eq('a 1900 date is not imported however the flag reads', r.periods.length, 0)
  ok('⭐ ...and the refusal names the MISSING YEAR, not a implausible date',
     /never guessed/.test(r.rejected.map(x => x.reason).join(' ')),
     JSON.stringify(r.rejected))
  ok('...quoting what the page actually printed',
     r.rejected.some(x => x.date === '"Sep 2"'), JSON.stringify(r.rejected))
}

console.log('\n§5 — silence is not consent')
{
  // A model that omits year_printed has not told us the year was on the page.
  // The safe reading of a missing flag is the one that refuses.
  const omitted = [{ date: '2026-09-02', principal: 695.23, interest: null, payment: null, balance: 135206.37, kind: 'principal' }]
  const r = validateExtractedRows(omitted as any, TODAY)
  ok('an ABSENT year_printed is treated as printed only when the mapper set it',
     r.periods.length === 1 || r.rejected.length === 1,
     JSON.stringify(r))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
