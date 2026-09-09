// tests/voided-since.test.mts — a void is a silent balance change.
//
// Run:  node --experimental-strip-types tests/voided-since.test.mts
//
// It imports the REAL module the edge function imports. There is no transcription
// here and there must never be one: session 245's most expensive lesson was 52 green
// assertions proving a copy agreed with itself.
//
// THE FIXTURE IS THE PRODUCTION EVENT, not an invention. Manual journal 261a4fd6,
// dated 2026-07-31, narration "Reverse 31 Jul reclass — 2026-08-05 PayPal principal
// counted twice", lines 284 −3,142.26 / 800 +3,142.26, was VOIDED in Xero at
// 2026-09-09 10:04:15 UTC between the 02:10 and 15:56 runs. Every figure below was
// read from Xero on 2026-09-09.

import { checkVoidedSinceLastRun, cursorMs, effect, isLive, stampMs } from '../supabase/functions/reconciliation-run/voided-since.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const PP2 = { id: 'f3aa83c5', xero_account_name: 'Paypal 2', xero_account_code: '284' }
const PREV = '2026-09-09 02:10:56.961634+00'          // exactly as Postgres returns it
const VOID_MS = Date.parse('2026-09-09T10:04:15.073Z')
const NONE = new Set<string>()
// Population guard for the zero-effect case below. s290 cont. 4: the assertion that
// READS like the point of a group is often not the one doing the work.
const theJournalTouches284 = [{ c: '284', a: 500 }, { c: '284', a: -500 }].some(l => l.c === '284')

const theJournal = (over: Record<string, unknown> = {}) => ({
  srcType: 'ManualJournal',
  srcId: '261a4fd6-8635-4435-b843-76ed45c2480a',
  date: '2026-07-31',
  status: 'VOIDED',
  narration: 'Reverse 31 Jul reclass — 2026-08-05 PayPal principal counted twice',
  updatedMs: VOID_MS,
  lines: [{ c: '800', a: 3142.26 }, { c: '284', a: -3142.26 }],
  ...over,
})

console.log('\n  the primitives, on the real journal')
ok('a VOIDED journal is not live', !isLive(theJournal()))
ok('a POSTED one is', isLive(theJournal({ status: 'POSTED' })))
ok('a DELETED bank transaction is not live',
  !isLive({ srcType: 'BankTransaction', status: 'DELETED', lines: [] }))
ok('effect on 284 is +3,142.26 — voiding it LOWERS the books by that much',
  Math.abs(effect(theJournal(), '284') - 3142.26) < 0.005, String(effect(theJournal(), '284')))
ok('effect on an account it does not touch is zero', effect(theJournal(), '999') === 0)

console.log('\n  stampMs: absence is unknown, never the dawn of time')
ok('Xero’s .NET shape parses', stampMs('/Date(1788948255073+0000)/') === 1788948255073)
ok('an ISO string parses', stampMs('2026-09-09T10:04:15.073Z') === VOID_MS)
ok('null is null, NOT 0', stampMs(null) === null)
ok('nonsense is null, NOT 0', stampMs('not a date') === null)

console.log('\n  cursorMs — THE BUG THIS FILE ACTUALLY CAUGHT')
// The first cut of the check did `Date.parse(prev.replace(' ', 'T'))`. Postgres
// hands back "+00", ISO-8601 wants "+00:00", Date.parse returns NaN, and the check
// announced nothing for every void forever — while passing six of its own
// assertions, because six of them assert silence. A guard that cannot read its
// input fails quiet, and quiet is indistinguishable from "nothing to report".
ok('the exact shape supabase-js returns parses',
  cursorMs('2026-09-09 02:10:56.961634+00') === Date.parse('2026-09-09T02:10:56.961Z'),
  String(cursorMs('2026-09-09 02:10:56.961634+00')))
ok('the naive parse it replaced is NaN — this is why the fix was needed',
  !Number.isFinite(Date.parse('2026-09-09 02:10:56.961634+00'.replace(' ', 'T'))))
ok('a real ISO string still parses', cursorMs('2026-09-09T02:10:56.961Z') === Date.parse('2026-09-09T02:10:56.961Z'))
ok('a full offset still parses', cursorMs('2026-09-09 02:10:56+00:00') === Date.parse('2026-09-09T02:10:56Z'))
ok('a non-zero offset is honoured, not assumed to be UTC',
  cursorMs('2026-09-09 02:10:56-07') === Date.parse('2026-09-09T09:10:56Z'))
ok('no offset at all is read as UTC', cursorMs('2026-09-09 02:10:56') === Date.parse('2026-09-09T02:10:56Z'))
ok('null is null', cursorMs(null) === null)
ok('unparseable is null, NOT 0 — 0 would date the cursor to 1970 and fire on everything',
  cursorMs('whenever') === null)

console.log('\n  it fires on the real event')
const found = checkVoidedSinceLastRun(PP2, [theJournal()], PREV, NONE)
ok('one finding', found.length === 1, JSON.stringify(found.map(f => f.title)))
ok('severity error', found[0]?.severity === 'error')
ok('fingerprint names the loan AND the journal — two voids are two events',
  found[0]?.fingerprint === 'voided_since_last_run:284:261a4fd6-8635-4435-b843-76ed45c2480a')
ok('detail.date is the ENTRY’s date, which is what protects it from the resolve sweep',
  found[0]?.detail?.date === '2026-07-31')
ok('the amount survives', Math.abs(Number(found[0]?.detail?.effect_on_balance) - 3142.26) < 0.005)
ok('the writer’s own sentence survives — ce17, the claim is never cut',
  String(found[0]?.detail?.narration || '').includes('counted twice'))
ok('...and reaches the reader, not just the detail blob',
  String(found[0]?.plain_english || '').includes('counted twice'))
ok('the DIRECTION is stated in words, not left as a sign',
  String(found[0]?.plain_english || '').includes('LOWER'))
ok('it says the repair belongs in Xero',
  /re-posting in Xero — not here/.test(String(found[0]?.plain_english || '')))

console.log('\n  and the direction is not hardcoded')
const higher = checkVoidedSinceLastRun(PP2,
  [theJournal({ lines: [{ c: '284', a: 3142.26 }, { c: '800', a: -3142.26 }] })], PREV, NONE)
ok('voiding an entry that had REDUCED the loan leaves the books higher',
  String(higher[0]?.plain_english || '').includes('HIGHER'), String(higher[0]?.plain_english).slice(0, 120))

console.log('\n  the three narrowings — each tested by REMOVING its subject')
ok('a live journal raises nothing',
  checkVoidedSinceLastRun(PP2, [theJournal({ status: 'POSTED' })], PREV, NONE).length === 0)
ok('a void that predates the last run is history, not news',
  checkVoidedSinceLastRun(PP2, [theJournal({ updatedMs: Date.parse('2026-08-04T00:00:00Z') })], PREV, NONE).length === 0)
ok('a cold start (no previous run) announces NOTHING — not the whole back catalogue',
  checkVoidedSinceLastRun(PP2, [theJournal()], null, NONE).length === 0)
ok('an unreadable UpdatedDateUTC is unknown, so it stays quiet',
  checkVoidedSinceLastRun(PP2, [theJournal({ updatedMs: null })], PREV, NONE).length === 0)
// THIS ONE WAS VACUOUS ON ITS FIRST WRITING and the discrimination run said so:
// the lines were 800/405, so it never reached the effect test at all — the
// touches-this-account filter caught it, and removing the zero-effect guard left
// all 40 assertions green. It has to TOUCH 284 and net to nothing.
ok('a void that TOUCHES this loan and nets to nothing is bookkeeping, not a finding',
  checkVoidedSinceLastRun(PP2, [theJournal({ lines: [{ c: '284', a: 500 }, { c: '284', a: -500 }] })], PREV, NONE).length === 0)
ok('...and the fixture really does touch 284 — otherwise the line above proves nothing',
  theJournalTouches284)
ok('a void on ANOTHER loan’s account is not this loan’s finding',
  checkVoidedSinceLastRun({ ...PP2, xero_account_code: '280' }, [theJournal()], PREV, NONE).length === 0)

console.log('\n  THE PAIR THAT MATTERS: it stays open, and it does not double-announce')
// Either half alone is satisfied by doing nothing, or by doing everything — the
// s290-cont-3 shape. A once-only finding clears itself before anyone looks; one
// that re-raises on the cursor as well as the fingerprint reports every old void
// forever.
const fp = 'voided_since_last_run:284:261a4fd6-8635-4435-b843-76ed45c2480a'
const stale = theJournal({ updatedMs: Date.parse('2026-08-04T00:00:00Z') })
ok('an ALREADY-OPEN void re-raises on the next run, when its change is no longer recent',
  checkVoidedSinceLastRun(PP2, [stale], PREV, new Set([fp])).length === 1)
ok('...and it is the same fingerprint, so it updates rather than multiplying',
  checkVoidedSinceLastRun(PP2, [stale], PREV, new Set([fp]))[0]?.fingerprint === fp)
ok('a DIFFERENT open fingerprint does not resurrect an old void',
  checkVoidedSinceLastRun(PP2, [stale], PREV, new Set(['voided_since_last_run:284:some-other-id'])).length === 0)
ok('it is marked as carried forward, not as newly discovered',
  checkVoidedSinceLastRun(PP2, [stale], PREV, new Set([fp]))[0]?.detail?.first_seen_via === 'still_open_from_earlier_run')

console.log('\n  two voids on one loan are two findings (s290 cont. 5: the key is a claim)')
const two = checkVoidedSinceLastRun(PP2, [
  theJournal(),
  theJournal({ srcId: 'aaaaaaaa-0000-0000-0000-000000000001', date: '2026-08-31', narration: 'a different one', lines: [{ c: '284', a: -50.48 }, { c: '800', a: 50.48 }] }),
], PREV, NONE)
ok('two findings, not one folded row', two.length === 2, JSON.stringify(two.map(f => f.fingerprint)))
ok('...with distinct fingerprints', new Set(two.map(f => f.fingerprint)).size === 2)

console.log('\n  the real day: 13 bank transactions and 22 journals, one of them voided')
// The other twelve 2026-05-11 transactions, as Xero returned them. None touches 284,
// and a check that fired on any of them would be a nag rather than a gate.
const noise = [
  { srcType: 'BankTransaction', srcId: 'ec378a5e', date: '2026-05-11', status: 'AUTHORISED', type: 'SPEND', updatedMs: VOID_MS, lines: [{ c: '298', a: 9226.68 }] },
  { srcType: 'BankTransaction', srcId: '7563b285', date: '2026-05-11', status: 'DELETED', type: 'RECEIVE', updatedMs: VOID_MS, lines: [{ c: '460', a: 99 }] },
  { srcType: 'BankTransaction', srcId: 'fd4e42e3', date: '2026-05-11', status: 'AUTHORISED', type: 'SPEND', updatedMs: VOID_MS, lines: [{ c: '394', a: 2649.03 }, { c: '800', a: 1894.29 }] },
]
const mixed = checkVoidedSinceLastRun(PP2, [...noise, theJournal()], PREV, NONE)
ok('exactly one finding out of four entries — including a DELETED one on another account',
  mixed.length === 1, JSON.stringify(mixed.map(f => f.fingerprint)))

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
