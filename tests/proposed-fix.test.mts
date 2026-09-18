// tests/proposed-fix.test.mts — the stored fix is an allowlist, foots, and stales (s309)
//
// Imports the SHIPPED module. Every assertion was proved to discriminate by mutating
// proposed-fix.ts (drop the allowlist, drop the footing check, drop a version column)
// and watching the named assertion go red — the table is in the session 309 notes.
//
// Run:  npx tsx tests/proposed-fix.test.mts

import { fixFromWalk, versionKey, FIX_KINDS, PROPOSED_FIX_SCHEMA } from '../supabase/functions/_shared/proposed-fix.ts'
import { selectLoans } from '../supabase/functions/loan-attribution-run/selection.ts'

let n = 0, bad = 0
const ok = (cond: unknown, msg: string) => { n++; if (!cond) { bad++; console.log('  ✗', msg) } }
const eq = (a: unknown, b: unknown, msg: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)

const V = '2026-09-17T03:00:00.000Z'
const journal = (a: number, code = '284') => ({
  Narration: 'X — balance correction, 2026-07', Date: '2026-08-31', Status: 'POSTED',
  JournalLines: [
    { LineAmount: a, AccountCode: '800', Description: 'Interest', TaxType: 'NONE' },
    { LineAmount: -a, AccountCode: code, Description: 'principal correction', TaxType: 'NONE' },
  ],
})
const walk = (extra: any) => ({ ok: true, mode: 'analyze', ...extra })

console.log('fixFromWalk')
{
  // 1. a cause-built reallocation is a fix, and the journal travels verbatim
  const f = fixFromWalk(walk({ proposal: { kind: 'interest_reallocation_journal', amount: 1023.2, direction: 'interest_out_of_loan', dated_into: '2026-08-31', dated_because: 'July is closed', based_on: 'Lender moved 2,033.77; Xero moved 3,056.97. The gap equals July interest.', journal: journal(1023.2), token: 'abc' } }), V)
  eq(f.state, 'fix', 't1 reallocation → fix')
  if (f.state === 'fix') {
    eq(f.post_flag, 'post_fix', 't1 posts via post_fix')
    eq(f.token, 'abc', 't1 token carried')
    eq(f.journal.JournalLines.map(l => l.AccountCode), ['800', '284'], 't1 lines verbatim')
    eq(f.check, 'Lender moved 2,033.77; Xero moved 3,056.97.', 't1 check is the FIRST sentence of based_on')
    eq(f.version, V, 't1 version stamped')
    ok(f.working.some(w => w.label === 'Based on' && w.text.includes('July interest')), 't1 the rest of based_on survives in working')
    eq(f.schema, PROPOSED_FIX_SCHEMA, 't1 schema')
  }

  // 2. an unknown kind is NONE, never a fix — the allowlist is the point
  const u = fixFromWalk(walk({ proposal: { kind: 'brand_new_kind_from_next_month', amount: 5, journal: journal(5), token: 'zzz' } }), V)
  eq(u.state, 'none', 't2 unknown kind → none')
  ok(u.state === 'none' && /brand_new_kind/.test(u.why || ''), 't2 names the kind it refused')
  ok(!FIX_KINDS.has('recorded_cause_adjustment'), 't2b recorded-cause (human picks the account) is NOT in the allowlist')

  // 3. a journal that does not foot is not a fix, whatever its kind
  const bad1 = walk({ proposal: { kind: 'interest_reallocation_journal', amount: 5, journal: { ...journal(5), JournalLines: [{ LineAmount: 5, AccountCode: '800' }, { LineAmount: -4.9, AccountCode: '284' }] }, token: 'q', based_on: 'x.' } })
  eq(fixFromWalk(bad1, V).state, 'none', 't3 unbalanced journal → none')
  const bad2 = walk({ proposal: { kind: 'interest_reallocation_journal', amount: 5, journal: { ...journal(5), JournalLines: [{ LineAmount: 5, AccountCode: '800' }, { LineAmount: -5, AccountCode: null }] }, token: 'q', based_on: 'x.' } })
  eq(fixFromWalk(bad2, V).state, 'none', 't3b line with no account → none')
  const bad3 = walk({ proposal: { kind: 'interest_reallocation_journal', amount: 5, journal: journal(5), based_on: 'x.' } })   // no token
  eq(fixFromWalk(bad3, V).state, 'none', 't3c no token → none (nothing to post against)')

  // 4. a true-up is a fix; a write-off is a fix with its own flag; precedence is proposal > exception > write-off
  const tu = fixFromWalk(walk({ proposal: { kind: 'stale_split_trueup', amount: 415.88, journal: journal(415.88), token: 't', based_on: 'Three months carried the old split.', dated_into: '2026-08-31' }, writeoff: { eligible: true, journal: journal(1), token: 'w', amount: 1 } }), V)
  ok(tu.state === 'fix' && tu.kind === 'stale_split_trueup', 't4 true-up wins over write-off')
  const wo = fixFromWalk(walk({ proposal: null, writeoff: { eligible: true, amount: 15.38, dated_into: '2026-08-31', dated_because: 'open month', searched: ['a', 'b'], result_sentence: 'After this, 65,173.94.', journal: journal(15.38), token: 'w1' } }), V)
  ok(wo.state === 'fix' && wo.kind === 'unexplained_difference_writeoff' && wo.post_flag === 'post_writeoff', 't4b write-off → fix via post_writeoff')
  ok(wo.state === 'fix' && wo.working.some(w => w.label === 'Searched' && w.text === 'a; b'), 't4c searched list kept in working')
  const woNo = fixFromWalk(walk({ proposal: null, writeoff: { eligible: false, why: 'material: 3,120.61 is above the floor' } }), V)
  ok(woNo.state === 'none' && /above the floor/.test(woNo.why || ''), 't4d ineligible write-off → none with the engine\'s why')

  // 5. the accountant's own entry: with a prepared correction it is a fix; without, her note is the question
  const ceFix = fixFromWalk(walk({ proposal: null, cpa_exception: { note: 'Her split double-counted June. Reverse 283.07.', token: 'ce', proposed_entry: { amount: 283.07, direction: 'interest_back_to_loan', dated_because: 'July closed', ...journal(283.07) } } }), V)
  ok(ceFix.state === 'fix' && ceFix.kind === 'cpa_exception' && ceFix.post_flag === 'post_exception' && ceFix.amount === 283.07, 't5 exception with entry → fix via post_exception')
  const ceQ = fixFromWalk(walk({ proposal: null, cpa_exception: { note: 'Two journals book the 5 Aug principal — which one should stand? Both are live.', token: null, proposed_entry: null, diagnosis: { shape: 'partly_duplicated' } } }), V)
  ok(ceQ.state === 'accountant' && ceQ.question === 'Two journals book the 5 Aug principal — which one should stand?', 't5b exception without entry → accountant, first sentence')
  ok(ceQ.state === 'accountant' && ceQ.working.some(w => w.text.includes('Both are live')), 't5c the rest of the note survives in working')
  // 5d. undecomposable: the question is built from the diagnosis figures, not the note's first sentence
  const und = fixFromWalk(walk({ proposal: null, cpa_exception: { split_period: '2026-08', note: 'Your accountant split this payment herself, putting $720.59 on Interest Expense. Left for her.', token: null, proposed_entry: null, diagnosis: { shape: 'undecomposable', at_source: 720.59, owed: 283.07 } } }), V)
  ok(und.state === 'accountant' && und.question === 'Her $720.59 interest split on 2026-08 does not match the $283.07 the schedule owes, and the engine cannot say what the extra covers.', 't5d undecomposable → accountant, question from the figures')
  // 5h. an exception inside closed books with nothing to post is history, not a question
  const closedQ = fixFromWalk(walk({ proposal: null, cpa_exception_closed: true, cpa_exception: { split_period: '2026-01-07', note: 'Left for her.', token: null, proposed_entry: null, diagnosis: { shape: 'undecomposable', at_source: 720.59, owed: 707.78 } } }), V)
  ok(closedQ.state === 'none' && /closed books/.test(closedQ.why || ''), 't5h closed-books exception without an entry → none, never accountant')
  const closedFix = fixFromWalk(walk({ proposal: null, cpa_exception_closed: false, cpa_exception: { note: 'x.', token: 'ce', proposed_entry: { amount: 5, ...journal(5) }, diagnosis: { shape: 'partly_duplicated' } } }), V)
  ok(closedFix.state === 'fix', 't5i ...but one WITH a prepared entry is still a fix (the engine re-dates it into an open month)')
  // 5e. no_duplication is NOT a question — examined and found sound. Falls through to none (or a write-off).
  const sound = fixFromWalk(walk({ proposal: null, writeoff: { eligible: false, why: 'material' }, cpa_exception: { note: "Your accountant's $471.42 interest split covers the 1 month below. Nothing to propose.", token: null, proposed_entry: null, diagnosis: { shape: 'no_duplication', at_source: 471.42, owed: 471.42 } } }), V)
  ok(sound.state === 'none', 't5e no_duplication → none, never accountant')
  ok(sound.state === 'none' && /material/.test(sound.why || ''), 't5f ...with the write-off refusal as the why (most specific first)')
  const soundWo = fixFromWalk(walk({ proposal: null, writeoff: { eligible: true, amount: 0.01, journal: journal(0.01), token: 'w', dated_into: '2026-08-31' }, cpa_exception: { note: 'sound.', token: null, proposed_entry: null, diagnosis: { shape: 'no_duplication' } } }), V)
  ok(soundWo.state === 'fix' && soundWo.kind === 'unexplained_difference_writeoff', 't5g no_duplication does not block an eligible write-off')

  // 6. no history, no run, nothing — each says why in the engine's words
  eq(fixFromWalk(walk({ verdict: 'not_enough_history', narrative: 'needs two statements' }), V), { schema: 1, state: 'none', why: 'needs two statements', version: V }, 't6 not enough history')
  eq(fixFromWalk({ ok: false, error: 'boom' }, V).state, 'none', 't6b failed walk → none')
  const quiet = fixFromWalk(walk({ proposal: null, writeoff: null, trueup: { why: 'no stale split' }, no_action_detail: 'nothing to do' }), V)
  ok(quiet.state === 'none' && quiet.why === 'no stale split', 't6c quiet walk → none, most specific why first')

  // 7. deterministic: same input, same bytes
  const w7 = walk({ proposal: { kind: 'interest_reallocation_journal', amount: 1, journal: journal(1), token: 'd', based_on: 'x. y.' } })
  eq(JSON.stringify(fixFromWalk(w7, V)), JSON.stringify(fixFromWalk(JSON.parse(JSON.stringify(w7)), V)), 't7 deterministic')
}

console.log('versionKey')
{
  eq(versionKey({}), null, 'v1 nothing on file → null')
  eq(versionKey({ statements: [{ created_at: '2026-09-01T00:00:00Z' }, { created_at: '2026-09-12T00:00:00Z' }] }), '2026-09-12T00:00:00Z', 'v2 latest statement')
  eq(versionKey({ statements: [{ created_at: '2026-09-12T00:00:00Z' }], splits: [{ computed_at: '2026-09-13T00:00:00Z' }] }), '2026-09-13T00:00:00Z', 'v3 a split computed later wins')
  eq(versionKey({ splits: [{ computed_at: '2026-09-01T00:00:00Z', voided_at: '2026-09-14T00:00:00Z' }] }), '2026-09-14T00:00:00Z', 'v4 a void bumps it')
  eq(versionKey({ splits: [{ computed_at: '2026-09-01T00:00:00Z', xero_posted_at: '2026-09-15T00:00:00Z' }] }), '2026-09-15T00:00:00Z', 'v5 a post bumps it')
  eq(versionKey({ splits: [{ computed_at: '2026-09-01T00:00:00Z', staged_at: '2026-09-16T00:00:00Z' }] }), '2026-09-16T00:00:00Z', 'v6 a stage bumps it')
  eq(versionKey({ runs: [{ finished_at: '2026-09-17T00:00:00Z' }], statements: [{ created_at: '2026-09-01T00:00:00Z' }] }), '2026-09-17T00:00:00Z', 'v7 a finished run bumps it')
  eq(versionKey({ statements: [{ created_at: null }], splits: [{}] }), null, 'v8 nulls ignored')
}

console.log('selectLoans includeImmaterial')
{
  const rows = [
    { id: 'f1', loan_account_id: 'L1', check_key: 'balance_vs_lender', status: 'open', severity: 'warning', last_seen_at: '2026-09-17' },
    { id: 'f2', loan_account_id: 'L2', check_key: 'balance_vs_lender', status: 'open', severity: 'info', last_seen_at: '2026-09-17' },
  ] as any
  eq(selectLoans(rows).map(s => s.loan_account_id), ['L1'], 's1 default still skips immaterial (existing callers unchanged)')
  eq(selectLoans(rows, true).map(s => s.loan_account_id), ['L1', 'L2'], 's2 includeImmaterial walks them for the write-off')
}

console.log(`\n${n} assertions, ${bad} failed`)
process.exit(bad ? 1 : 0)
