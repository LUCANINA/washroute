// tests/split-pair.test.mts — MAY THIS PAIR DEFINE A PERIOD'S SPLIT?
//
// Run:  node --experimental-strip-types tests/split-pair.test.mts
//
// Session 290. David: "What's keeping us from proposing a fix?" The answer was
// that a fix would have been a plug, because nobody knew what the $15.38 WAS.
// This is the guard that stops the cause being created in the first place.
//
// Every money figure below is Funding Circle's real one.

import assert from 'node:assert'
import { splitPairObjection, splitPairNote, SAME_BALANCE_TOL } from '../supabase/functions/_shared/split-pair.ts'

let pass = 0, fail = 0
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)) }
}
const h = (s: string) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)))

// The real rows, from loan_statements on 2026-09-09.
const JUL = { statement_date: '2026-07-01', principal_balance: 66215.03, file_sha256: 'aaa', anchor_exclusion_reason: null }
const AUG03 = { statement_date: '2026-08-03', principal_balance: 66215.03, file_sha256: 'aaa',
                anchor_exclusion_reason: 'Not a balance as of 2026-08-03. This is the SAME PDF as the 2026-07-01 row.' }
const AUG01 = { statement_date: '2026-08-01', principal_balance: 65173.94, file_sha256: 'bbb', anchor_exclusion_reason: null }

h('THE REAL PAIR — the one that booked July as August')
t('it is refused', () => assert.ok(splitPairObjection(JUL, AUG03)))
t('the human\'s objection leads, because it names a document a person opened', () =>
  assert.equal(splitPairObjection(JUL, AUG03)!.kind, 'excluded'))
t('...and BOTH objections are reported as applying', () =>
  assert.equal(splitPairObjection(JUL, AUG03)!.bothApply, true))

h('⭐ THE HALF THAT NEEDED NOBODY TO NOTICE FIRST')
/* The exclusion note was written months after the damage started. Strip it and
   the pair must STILL be refused — on the bytes alone. This is the assertion
   that would have fired in April, and it is why the same-pair test must never be
   collapsed into the exclusion field. */
t('⭐ with the human note removed, it is STILL refused', () => {
  const o = splitPairObjection(JUL, { ...AUG03, anchor_exclusion_reason: null })
  assert.ok(o); assert.equal(o!.kind, 'unmeasurable')
})
t('...and says it is the same document, not merely the same number', () =>
  assert.match(splitPairObjection(JUL, { ...AUG03, anchor_exclusion_reason: null })!.why, /SAME DOCUMENT/))
t('⭐ and with the HASHES gone too, the equal balances alone still refuse it', () => {
  const o = splitPairObjection({ ...JUL, file_sha256: null }, { ...AUG03, file_sha256: null, anchor_exclusion_reason: null })
  assert.ok(o); assert.equal(o!.kind, 'unmeasurable')
  assert.match(o!.why, /both report \$66215\.03/)
})

h('THE CONTROL — the genuine pair must pass, or this is a nag')
t('⭐ July → the real 2026-08-01 statement is ACCEPTED', () =>
  assert.equal(splitPairObjection(JUL, AUG01), null))
t('...and that pair moves 1,041.09, which is the lender\'s own August figure', () =>
  assert.equal(Number((JUL.principal_balance - AUG01.principal_balance).toFixed(2)), 1041.09))
/* THE ARITHMETIC THAT MAKES THIS THE RIGHT FIX, stated once so a future reader
   can check it: the split that WAS written booked 1,025.71 (July's own figure,
   off the duplicate). 1,041.09 - 1,025.71 = 15.38, the number on David's card. */
t('...and the gap that was booked instead is exactly the card\'s $15.38', () =>
  assert.equal(Number((1041.09 - 1025.71).toFixed(2)), 15.38))

h('WHAT MUST NOT BE REFUSED — a false ask is worse than a missing one')
t('an ordinary month with a real movement', () =>
  assert.equal(splitPairObjection(
    { statement_date: '2026-06-01', principal_balance: 67240.74, file_sha256: 'c' },
    { statement_date: '2026-07-01', principal_balance: 66215.03, file_sha256: 'd' }), null))
t('no prior at all — the explicit branch does not require one', () =>
  assert.equal(splitPairObjection(null, AUG01), null))
t('a prior with no balance recorded cannot make the pair unmeasurable', () =>
  assert.equal(splitPairObjection({ statement_date: '2026-07-01', principal_balance: null }, AUG01), null))
t('a cent of rounding is a movement, not a refusal', () =>
  assert.equal(splitPairObjection(
    { statement_date: '2026-07-01', principal_balance: 100.00 },
    { statement_date: '2026-08-01', principal_balance: 99.99 }), null))
t('...but a difference under the tolerance is not', () =>
  assert.ok(splitPairObjection(
    { statement_date: '2026-07-01', principal_balance: 100.000 },
    { statement_date: '2026-08-01', principal_balance: 100.000 + SAME_BALANCE_TOL / 2 })))

h('THE SENTENCE A BOOKKEEPER READS')
t('it names the period it is refusing', () =>
  assert.match(splitPairNote(splitPairObjection(JUL, AUG03)!, '2026-08'), /NOT ACCEPTED as 2026-08's split/))
t('the unmeasurable note says what to do about it', () =>
  assert.match(
    splitPairNote(splitPairObjection(JUL, { ...AUG03, anchor_exclusion_reason: null })!, '2026-08'),
    /Upload the statement that covers 2026-08/))
t('...and does not pretend the figures below it are this period\'s', () =>
  assert.match(
    splitPairNote(splitPairObjection(JUL, { ...AUG03, anchor_exclusion_reason: null })!, '2026-08'),
    /about ITS OWN period, not this one/))

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
if (fail) process.exit(1)
