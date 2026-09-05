// tests/period-label.test.mts — WHICH MONTH A PAYMENT BELONGS TO
//
// Run:  npx tsx tests/period-label.test.mts
//
// Session 277. `loan-ingest-statement` decided a payment's month with
// `statement_date.slice(0, 7)`, in two places. BayFirst SBA 2 applies on the last
// day of its cycle (7/31) and the bank drafts two or three days later (8/3), so
// its August payment filed as 2026-07 and July's close rollforward counted $858.66
// of principal that belongs to August — beside the real July payment, which is
// already there.
//
// The subject of this file is a rule that must be capable of REFUSING. Most of the
// assertions below are therefore about what it does NOT conclude: an ambiguous
// match, a Xero outage and a one-legged match must all fall back to the statement
// date and SAY they did. A labeller that always produces a month is not a
// measurement, it is a division wearing a verdict's clothes (session 245).
//
// It imports the shipped function. Session 245's transcription trap and session
// 275's hand-composed dry run are the same mistake twice, and both were found in
// files whose authors believed they were testing the code.

import { resolvePeriodLabel } from '../supabase/functions/_shared/period-label.ts'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name: string, actual: any, expected: any) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

// ── The real case, to the cent. BayFirst SBA 2 (account code 251), statement
// dated 2026-07-31, Xero bank transaction e895f420 dated 2026-08-03 carrying
// $858.66 -> 251 and $1,249.58 -> 800. Confirmed live via xero-read.
const BAYFIRST = { statementDate: '2026-07-31', principal: 858.66, interest: 1249.58, loanAccountCode: '251' }
const REAL_TXN = { date: '2026-08-03', lines: [{ code: '251', amt: 858.66 }, { code: '800', amt: 1249.58 }] }

// The rule as it stood BEFORE this change. Kept only to prove the new one differs
// — an assertion that passes against both the fixed and the broken code is
// decoration.
const OLD_RULE = (statementDate: string) => statementDate.slice(0, 7)

console.log('\n§1 — the month comes from the money')
{
  const r = resolvePeriodLabel({ ...BAYFIRST, window: [REAL_TXN] })
  eq('BayFirst 7/31 statement, 8/3 payment, files as 2026-08', r.label, '2026-08')
  eq('...and says so: the basis is measured, not assumed', r.basis, 'bank_transaction')
  ok('...and the note names both dates, so a reader can check it',
    r.note.includes('2026-07-31') && r.note.includes('2026-08-03'))
  // DISCRIMINATION. This is the assertion that would go red if the fix were reverted.
  ok('...which is NOT what the old rule said', OLD_RULE(BAYFIRST.statementDate) === '2026-07' && r.label !== '2026-07')
}

console.log('\n§2 — it agrees with the paper when the paper is right')
{
  // Most loans on this book draft in the same month they apply. The fix must not
  // move those, or it trades one wrong label for thirteen.
  const sameMonth = { date: '2026-07-15', lines: [{ code: '251', amt: 858.66 }, { code: '800', amt: 1249.58 }] }
  const r = resolvePeriodLabel({ ...BAYFIRST, statementDate: '2026-07-10', window: [sameMonth] })
  eq('a mid-month statement and a mid-month payment agree', r.label, '2026-07')
  eq('...still recorded as measured — agreement is a result, not a default', r.basis, 'bank_transaction')
  eq('...and it says nothing, because there is nothing to explain', r.note, '')
}

console.log('\n§3 — the refusals, which are most of the rule')
{
  // (a) AMBIGUITY. PayPal 2 and Dexter draft the same amount every period, so two
  // months' transactions carry identical lines. Picking the nearest would repeat
  // the mistake that let Xero offer an earlier payment against a future stage.
  const twin = { date: '2026-08-03', lines: [{ code: '251', amt: 858.66 }, { code: '800', amt: 1249.58 }] }
  const twin2 = { date: '2026-07-27', lines: [{ code: '251', amt: 858.66 }, { code: '800', amt: 1249.58 }] }
  const amb = resolvePeriodLabel({ ...BAYFIRST, window: [twin, twin2] })
  eq('two identical transactions: falls back to the statement date', amb.label, '2026-07')
  eq('...and does not claim to have measured it', amb.basis, 'statement_date')
  ok('...and says how many it saw, so the reader knows why', amb.note.includes('2 bank transactions'))
  ok('...DISCRIMINATION: a single one of those same two WOULD have been measured',
    resolvePeriodLabel({ ...BAYFIRST, window: [twin] }).basis === 'bank_transaction')

  // (b) OUTAGE. An outage must never silently change how a period is labelled.
  const down = resolvePeriodLabel({ ...BAYFIRST, window: null, windowError: 'xero 503' })
  eq('Xero unreachable: the old behaviour, unchanged', down.label, '2026-07')
  eq('...recorded as the assumption it is', down.basis, 'statement_date')
  ok('...and the note says Xero was the reason', down.note.toLowerCase().includes('could not be reached'))

  // (c) NOT YET CLEARED. Normal, and must be quiet about it.
  const none = resolvePeriodLabel({ ...BAYFIRST, window: [] })
  eq('no matching transaction: the statement date', none.label, '2026-07')
  eq('...as an assumption', none.basis, 'statement_date')
  eq('...with nothing to say — this is the ordinary case, not an exception', none.note, '')

  // (d) ONE LEG IS NOT A MATCH. On an amortizing loan an adjacent month's principal
  // can sit within a couple of cents of this one. Matching on the principal alone
  // would date the payment wrong with full confidence, which is worse than refusing.
  const oneLeg = { date: '2026-08-03', lines: [{ code: '251', amt: 858.66 }, { code: '800', amt: 999.99 }] }
  const half = resolvePeriodLabel({ ...BAYFIRST, window: [oneLeg] })
  eq('principal matches but interest does not: no match', half.matchCount, 0)
  eq('...so the label is the statement date', half.label, '2026-07')
  ok('...DISCRIMINATION: correcting the interest leg makes the SAME transaction match',
    resolvePeriodLabel({ ...BAYFIRST, window: [REAL_TXN] }).matchCount === 1)

  // (e) THE WINDOW WAS NEVER CONSULTED. Distinct from "consulted and found nothing":
  // the gate skips historical rows, and those must not read as checked.
  const skipped = resolvePeriodLabel({ ...BAYFIRST, window: null })
  eq('no window consulted at all: the statement date', skipped.label, '2026-07')
  eq('...as an assumption, never as a measurement', skipped.basis, 'statement_date')
}

console.log('\n§4 — sign, because Xero does not promise one')
{
  // A liability payment can arrive as a negative line depending on the transaction
  // type. The magnitudes are what identify the payment.
  const neg = { date: '2026-08-03', lines: [{ code: '251', amt: -858.66 }, { code: '800', amt: -1249.58 }] }
  eq('negative lines match on magnitude', resolvePeriodLabel({ ...BAYFIRST, window: [neg] }).label, '2026-08')
}

console.log('\n§5 — tolerance is two cents, and it is a limit, not a suggestion')
{
  const near = { date: '2026-08-03', lines: [{ code: '251', amt: 858.67 }, { code: '800', amt: 1249.57 }] }
  eq('a penny either way still matches', resolvePeriodLabel({ ...BAYFIRST, window: [near] }).label, '2026-08')
  const far = { date: '2026-08-03', lines: [{ code: '251', amt: 858.70 }, { code: '800', amt: 1249.58 }] }
  eq('four cents does not', resolvePeriodLabel({ ...BAYFIRST, window: [far] }).matchCount, 0)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
