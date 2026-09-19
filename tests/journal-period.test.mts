// tests/journal-period.test.mts — did Xero store the date we sent it? (s318)
//
// Run:  npx tsx tests/journal-period.test.mts
//
// THE CASE THIS PINS IS LIVE. Rapid Credit Line, August 2026: journal 71ed82b2 sent
// as 2026-08-31, stored by Xero as 2026-09-01, and $457.14 left the month being
// closed. Xero's Trial Balance for account 247 read 51,071.88 at 31 Aug against the
// lender's 51,529.02 — and 51,071.88 + 457.14 = 51,529.02 exactly.

import { journalDateWarning, checkJournalPeriodMismatch } from '../supabase/functions/_shared/journal-period.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const RAPID = { id: 'rapid', xero_account_name: 'Rapid Credit Line', xero_account_code: '247' }
const JID = '71ed82b2-c62e-4c27-8a0a-75074ce8e2f7'
const mj = (over: any = {}) => ({
  srcType: 'ManualJournal', srcId: JID, date: '2026-09-01',
  narration: 'Rapid Credit Line — interest, 2026-08-31', ...over,
})
const split = (over: any = {}) => ({
  id: '45ee2abd', period_label: '2026-08-31', xero_manual_journal_id: JID,
  principal_amount: -457.14, interest_amount: 457.14, total_amount: 0, ...over,
})

section('the post-time warning')
{
  const w = journalDateWarning('2026-08-31', { Date: '2026-09-01', ManualJournalID: JID })
  ok('a month-crossing shift is reported', !!w)
  ok('...and names both dates', w?.sent === '2026-08-31' && w?.stored === '2026-09-01', JSON.stringify(w))
  ok('...and says it crosses a month', w?.crosses_month === true)
  ok('...in words a reader can act on', /DIFFERENT MONTH/.test(w?.message || ''), w?.message)

  // THE PAIR. Without this, "warn on any difference" satisfies the half above and
  // every correct post carries a warning — which is how a warning stops being read.
  ok('an exact match is silent', journalDateWarning('2026-08-31', { Date: '2026-08-31' }) === null)

  // A day out INSIDE the month moves no month-end balance. Reported, because the
  // operator is looking straight at it — but never as a problem.
  const sameMonth = journalDateWarning('2026-08-30', { Date: '2026-08-31', ManualJournalID: JID })
  ok('a same-month shift is reported but not alarming', !!sameMonth && sameMonth.crosses_month === false)
  ok('...and says so plainly', /nothing to do/.test(sameMonth?.message || ''), sameMonth?.message)

  // §247: a missing answer is not a passing one.
  ok('no stored date is not a pass', journalDateWarning('2026-08-31', {}) === null)
  ok('no sent date is not a pass', journalDateWarning(null, { Date: '2026-09-01' }) === null)
  // Xero returns DateString on some payloads and Date on others.
  ok('DateString is read when Date is absent',
     journalDateWarning('2026-08-31', { DateString: '2026-09-01T00:00:00' })?.stored === '2026-09-01')
}

section('the engine check — Rapid, exactly as it stands')
{
  const out = checkJournalPeriodMismatch(RAPID, [mj()], [split()])
  ok('the misdated journal is found', out.length === 1, JSON.stringify(out))
  ok('...as an error, not a warning', out[0]?.severity === 'error')
  ok('...keyed on the journal, so it is one finding however often it is re-read',
     out[0]?.fingerprint === `journal_period_mismatch:${JID.toLowerCase()}`)
  ok('...naming the month we meant and the date Xero holds',
     /2026-08/.test(out[0]?.title || '') && /2026-09-01/.test(out[0]?.title || ''), out[0]?.title)
  ok('...and telling the reader the one thing to change',
     /Change the date on journal/.test(out[0]?.plain_english || ''), out[0]?.plain_english)
  // The resolve sweep in reconciliation-run reads `detail.date` to decide whether a
  // finding is inside its window. Without it this finding can never be swept.
  ok('...carrying detail.date for the resolve sweep', out[0]?.detail?.date === '2026-09-01')
}

section('...and it discriminates')
{
  // THE FIX, SIMULATED. Re-date the journal and the finding must vanish — this is
  // what makes the "clears automatically" promise true.
  ok('a journal dated as sent raises nothing',
     checkJournalPeriodMismatch(RAPID, [mj({ date: '2026-08-31' })], [split()]).length === 0)

  // A day out inside the month moves no month-end balance and must not nag.
  ok('a same-month day shift raises nothing',
     checkJournalPeriodMismatch(RAPID, [mj({ date: '2026-08-15' })], [split()]).length === 0)

  // A split we did not post through this system has no id to join on.
  ok('a hand-posted journal is not ours to judge',
     checkJournalPeriodMismatch(RAPID, [mj()], [split({ xero_manual_journal_id: null })]).length === 0)

  // §247: not pulled this run is not evidence of anything. checkVoidedSinceLastRun
  // owns "it is not there any more".
  ok('a journal outside the window is not called misdated',
     checkJournalPeriodMismatch(RAPID, [], [split()]).length === 0)
  ok('...nor is one Xero returned with no date',
     checkJournalPeriodMismatch(RAPID, [mj({ date: null })], [split()]).length === 0)

  // A monthly-labelled split names no day, so only the month can be compared —
  // which is the same answer this check gives everywhere else.
  ok('a monthly label matches any day in its month',
     checkJournalPeriodMismatch(RAPID, [mj({ date: '2026-08-15' })], [split({ period_label: '2026-08' })]).length === 0)
  ok('...and still fails when the month is wrong',
     checkJournalPeriodMismatch(RAPID, [mj()], [split({ period_label: '2026-08' })]).length === 1)
  ok('an unlabelled split is skipped, never guessed at',
     checkJournalPeriodMismatch(RAPID, [mj()], [split({ period_label: 'Period 14' })]).length === 0)

  // Postgres lowercases uuids; Xero returns mixed-case GUIDs. Comparing them raw is
  // the silent-false this module has been bitten by before.
  ok('⭐ case does not decide the answer',
     checkJournalPeriodMismatch(RAPID, [mj({ srcId: JID.toUpperCase() })], [split()]).length === 1)

  // A BankTransaction carrying the same id must not be mistaken for the journal.
  ok('only ManualJournals are joined',
     checkJournalPeriodMismatch(RAPID, [mj({ srcType: 'BankTransaction' })], [split()]).length === 0)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
