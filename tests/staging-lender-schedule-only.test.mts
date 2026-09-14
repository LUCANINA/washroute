// tests/staging-lender-schedule-only.test.mts — session 293.
//
// DAVID'S RULE: "staging only applies to Loans with amortization schedules",
// where an amortization schedule means one the LENDER ISSUED.
//
// The predicate was already right (session 268's allowlist). What was wrong was
// WHERE it was asked: it gated a staleness check and nothing gated PERMISSION,
// so `prestage_enabled` — a flag two functions set automatically whenever a
// schedule appeared — was the whole authority for writing a forecast into Xero.
//
// This file proves three things, and the third is the one that matters:
//   1. the predicate sorts every production shape correctly,
//   2. every refusal SAYS something a person can act on,
//   3. each of the four enforcement points actually calls it — asserted against
//      the shipped source, by REGION and by COUNT (session 289's rule: a string
//      is not a location).
//
// Run:  npx tsx tests/staging-lender-schedule-only.test.mts

import { mayPrestage, prestageRefusal } from '../supabase/functions/_shared/schedule-provenance.ts'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

// ── 1. The eleven loans that carried prestage_enabled on 2026-09-14 ──────────
// Measured from production, not invented: `select distinct source, amort_type`
// over the schedule behind each staging loan. `stages` is the verdict AFTER the
// rule. Three true, eight false — which is the audit's finding restated as a
// test, so a change that quietly re-widens it has to argue with this table.
const LOANS = [
  { code: '233', name: 'Dexter Financial',   source: 'claude_assisted_parse',   amort_type: 'amortization_schedule',                  stages: true  },
  { code: '254', name: 'Pacific Community',  source: 'client_parsed_verified',  amort_type: 'amortization_schedule',                  stages: true  },
  { code: '394', name: 'Verdant Capital',    source: 'claude_assisted_parse',   amort_type: 'amortization_schedule',                  stages: true  },
  { code: '284', name: 'PayPal 2',           source: 'claude_assisted_parse',   amort_type: 'actual_payment_history_from_lender_csv', stages: false },
  { code: '242', name: 'Ford Pro 242',       source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
  { code: '243', name: 'BayFirst SBA 1',     source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
  { code: '244', name: 'Ford Pro E4-9744',   source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
  { code: '251', name: 'BayFirst SBA 2',     source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
  { code: '253', name: 'Funding Circle',     source: 'derived_from_statements', amort_type: 'derived_flat_per_period',                stages: false },
  { code: '332', name: 'Ford Pro 332',       source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
  { code: '338', name: 'Ford Pro 338',       source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',               stages: false },
]

console.log('\n  1. every staging loan, as it stood on 2026-09-14')
for (const l of LOANS) {
  ok(`${l.code} ${l.name} — ${l.stages ? 'may stage' : 'may NOT stage'}`,
    mayPrestage(l) === l.stages, `got ${mayPrestage(l)}`)
}
ok('exactly three of the eleven may stage',
  LOANS.filter(l => mayPrestage(l)).length === 3,
  `got ${LOANS.filter(l => mayPrestage(l)).length}`)

// THE CONTROL. Without this the table above is satisfied by `() => false`, which
// would "pass" while breaking the three loans that work. A rule that refuses
// everything is not the rule David asked for.
ok('CONTROL — a blanket refusal fails this suite',
  LOANS.some(l => mayPrestage(l)), 'nothing may stage; the predicate has broken')

console.log('\n  2. unknown provenance is not permission')
ok('null schedule', mayPrestage(null) === false)
ok('undefined schedule', mayPrestage(undefined) === false)
ok('empty row', mayPrestage({} as any) === false)
ok('right type, source nobody has vetted',
  mayPrestage({ source: 'some_new_importer', amort_type: 'amortization_schedule' }) === false)
ok('right source, artefact is not a schedule',
  mayPrestage({ source: 'claude_assisted_parse', amort_type: 'payoff_quote' }) === false)
// Both halves have to be load-bearing, or one of them is decoration.
ok('MUTATION — dropping the amort_type half would let PayPal 2 stage',
  LOANS.find(l => l.code === '284')!.source === 'claude_assisted_parse')

console.log('\n  3. every refusal names the artefact and the way forward')
for (const l of LOANS.filter(x => !x.stages)) {
  const msg = prestageRefusal(l)
  ok(`${l.code} — says what we hold`, msg.length > 60 && !/undefined|null/.test(msg), msg)
  ok(`${l.code} — says nothing is blocked`, /normal way|Nothing is blocked/i.test(msg), msg)
}
ok('a derived schedule is described as ours, not as missing',
  /derived by us/.test(prestageRefusal(LOANS.find(l => l.code === '242')!)))
ok('a payment history is described as a history, not as a contract',
  /payment HISTORY/.test(prestageRefusal(LOANS.find(l => l.code === '284')!)))
ok('no schedule at all is its own sentence',
  /no readable amortization schedule/.test(prestageRefusal(null)))

// ── 4. THE ENFORCEMENT POINTS ────────────────────────────────────────────────
// A predicate nothing calls is a predicate that does nothing. Session 289: name
// the REGION and the COUNT, because these files also DISCUSS the rule in prose
// and `includes()` cannot tell a comment from a call.
console.log('\n  4. all four enforcement points call it')

const xeroPost = read('../supabase/functions/loan-xero-post/index.ts')
const stageBranch = xeroPost.slice(
  xeroPost.indexOf('--- stage: preview, then create the pre-split SPEND transaction ---'),
  xeroPost.indexOf('ALLOWLIST, not a denylist'))
ok('the stage branch was located', stageBranch.length > 500, `${stageBranch.length} chars`)
ok('loan-xero-post refuses inside the stage branch, exactly once',
  (stageBranch.match(/if \(!mayPrestage\(guardSched\)\)/g) || []).length === 1)
// ORDER MATTERS AND HAS TO BE MEASURED. The three guards below this one all
// presuppose that projecting forward was allowed at all; reaching them first
// returns a true refusal carrying the wrong reason, and the reason is the only
// part the reader acts on. (The first cut of this assertion compared an index
// against the region's own length, which is true for any string that contains
// the word at all — decoration wearing a test's clothes.)
{
  const permission = stageBranch.indexOf('mayPrestage(guardSched)')
  const superseded = stageBranch.indexOf('IS THIS ROW STILL ON THE LOAN\'S CURRENT SCHEDULE?')
  ok('...and it is asked BEFORE the superseded-schedule guard',
    permission > -1 && superseded > -1 && permission < superseded,
    `permission at ${permission}, superseded at ${superseded}`)
}

const ingest = read('../supabase/functions/loan-ingest-amortization/index.ts')
const hook = ingest.slice(ingest.indexOf('5. Staging Engine hook'), ingest.indexOf('The upsert conflict key'))
ok('the auto-enable hook was located', hook.length > 400, `${hook.length} chars`)
ok('the hook requires lender provenance before flipping the flag',
  /const lenderIssued = mayPrestage\(/.test(hook) && /hasFuturePayment && lenderIssued/.test(hook))
ok('MUTATION — future rows alone no longer grant it',
  !/if \(hasFuturePayment\) \{\n\s+if \(!loanAcct\.prestage_enabled\)/.test(hook))

const derive = read('../supabase/functions/_shared/derive-schedule.ts')
ok('derive-schedule never patches prestage_enabled on, at any of its sites',
  (derive.match(/if \(enableStaging\) (patch|acctPatch)\.prestage_enabled = true/g) || []).length === 0)
ok('...and reports the refusal rather than skipping in silence',
  (derive.match(/derived_schedule_cannot_stage/g) || []).length === 2,
  `${(derive.match(/derived_schedule_cannot_stage/g) || []).length} occurrences`)

const client = read('../admin-dashboard/index.html')
// ⚠️ THE REGION IS THE FUNCTION BODY, AND THIS BIT IS THE SESSION-289 LESSON
// ARRIVING ON ITS OWN TEST. The first cut sliced to the next comment block, so
// the region swallowed `_bkScheduleIsContractual` — whose own comment explains
// why `_bkRealSchedulesFor` is the WRONG question here, by naming it. The
// assertion went red on prose about the rule it was enforcing. It was right and
// the slice was wrong: a string is not a location.
// ...AND THE REGION IS ITS CODE, NOT ITS PROSE. Scoping to the function body
// was still not enough: the body's own comment explains why the loan-level
// helper is wrong, BY NAMING IT, so `!includes` went red on the sentence
// arguing for the rule. Twice in one file, which is the point — `includes()`
// cannot tell a call from an explanation, so the region has to exclude the
// explanations before anything is asserted about what the code calls.
const eligible = (() => {
  const start = client.indexOf('function _bkStageEligible(s)')
  const end = client.indexOf('\n  }', start) + 4
  return client.slice(start, end)
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')
})()
ok('the client gate was located, and stripping comments left real code',
  eligible.length > 200 && /return String\(row\.row_date\)/.test(eligible),
  `${eligible.length} chars`)
ok('the Stage button is withheld on a non-contractual schedule',
  /if \(!_bkScheduleIsContractual\(row\.schedule_id\)\) return false;/.test(eligible))
ok('the client asks about THIS split\'s schedule, exactly once',
  (eligible.match(/_bkScheduleIsContractual\(row\.schedule_id\)/g) || []).length === 1,
  eligible.slice(0, 120))
ok('...and never falls back to the loan-level question',
  !/_bkRealSchedulesFor\(/.test(eligible),
  'the loan-level helper would let a derived row stage beside a contract')

// ── 5. THE SECOND BRANCH: A FORECAST IS NOT AN APPROVAL ──────────────────────
// Found by David within the hour, looking at "Approve · October" on a payment
// due 2026-10-09. Turning staging OFF pushed four future-dated cards into the
// `stageable ? 'Stage' : 'Approve'` else-branch, which assumed a non-stageable
// schedule card is a payment that already happened. §231, with the twist that
// the new path was created by DISABLING a feature rather than adding one.
console.log('\n  5. a future-dated schedule card can be neither staged nor posted')

const postGuard = xeroPost.slice(
  xeroPost.indexOf('NEVER POST A SCHEDULED PAYMENT THAT HAS NOT HAPPENED'),
  xeroPost.indexOf('const principal = Number(split.principal_amount)'))
ok('the post guard was located', postGuard.length > 400, `${postGuard.length} chars`)
ok('it refuses on confirm', /confirm === true/.test(postGuard))
// THE CONTROL, and it is the half that matters: without `stage !== true` this
// guard would break the three loans that are still allowed to stage, since
// staging is BY DEFINITION a future-dated write. A guard that refuses
// everything is not the rule.
ok('CONTROL — staging is explicitly exempt, or the rule breaks 233/254/394',
  /stage !== true/.test(postGuard))
ok('it compares against Pacific today, not UTC',
  /pacificToday\(\)/.test(postGuard))
ok('the refusal says the payment has not happened',
  /has not happened yet/.test(postGuard))

const approvalQueue = (() => {
  const start = client.indexOf('function _bkApprovalQueueItems()')
  const end = client.indexOf('\n  }', client.indexOf('awaitingPayment', start)) + 4
  return client.slice(start, end).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
})()
ok('the approval queue region was located', approvalQueue.length > 300 && /awaitingPayment/.test(approvalQueue))
ok('a future-dated non-stageable card gets NO action',
  /action: null, onclick: null/.test(approvalQueue))
ok('...and its reason no longer claims the money moved',
  !/went to the loan[\s\S]*awaitingPayment/.test(approvalQueue)
  && /has not happened yet/.test(approvalQueue))
// The sentence the old branch printed over a payment that had not happened.
// Kept as a named string so a future edit that reintroduces it goes red here
// rather than on a CPA's screen (§247: grep the words, not just the numbers).
ok('MUTATION — the old unconditional claim is gone from the future-dated path',
  approvalQueue.indexOf('awaitingPayment') < approvalQueue.indexOf('Split worked out'))

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
