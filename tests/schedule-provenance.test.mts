// tests/schedule-provenance.test.mts — the allowlist that replaced a denylist,
// and proof that each half of it discriminates.
//
// Run:  npx tsx tests/schedule-provenance.test.mts
//
// Session 268. `loan-xero-post` asked "is this schedule a projection?" with
// `amort_type.startsWith('derived_')`. That is a denylist, and a denylist fails
// OPEN: anything nobody thought to name walks straight past the guard. It let
// through the one prestaging loan whose schedule is most obviously a projection.

import {
  isContractualSchedule,
  scheduleGoesStale,
  REAL_SCHEDULE_SOURCES,
  SCHEDULE_AMORT_TYPES,
} from '../supabase/functions/_shared/schedule-provenance.ts'

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// The old test, kept so the comparison is on the page rather than in a comment.
const oldDenylist = (r: any) => String(r?.amort_type ?? '').startsWith('derived_')

// ── The real rows, measured against production on 2026-09-04 ────────────────
// Every distinct (source, amort_type) pair on a prestage_enabled loan. Not
// invented shapes: this is `select distinct` output.
const PRODUCTION = [
  { name: 'PayPal A00845102',            source: 'claude_assisted_parse',  amort_type: 'actual_payment_history_from_lender_csv', contractual: false },
  { name: 'Pacific Community Ventures',  source: 'claude_assisted_parse',  amort_type: 'amortization_schedule',                  contractual: true  },
  { name: 'Verdant Capital (verified)',  source: 'client_parsed_verified', amort_type: 'amortization_schedule',                  contractual: true  },
  { name: 'Dexter Financial 103973-SP2', source: 'claude_assisted_parse',  amort_type: 'amortization_schedule',                  contractual: true  },
  { name: 'Ford Pro 61564140',           source: 'derived_from_statements', amort_type: 'derived_daily_actual_365',              contractual: false },
  { name: 'iBusiness / FC Marketplace',  source: 'derived_from_statements', amort_type: 'derived_flat_per_period',               contractual: false },
]

console.log('\n  every production schedule shape gets the right verdict')
for (const r of PRODUCTION) {
  ok(`${r.name} — ${r.contractual ? 'contractual, exempt' : 'a projection, goes stale'}`,
    isContractualSchedule(r) === r.contractual,
    `got ${isContractualSchedule(r)}`)
}

console.log('\n  the case the denylist actually missed')
// THE regression. PayPal 2 is a parse of the lender's payment HISTORY with
// everything past the parse date projected forward (Tech Debt #33), on a loan
// with prestaging live. Its amort_type does not begin with 'derived_', so the
// old guard skipped it entirely and staged a projection that was a penny out.
const paypal = PRODUCTION[0]
ok('the OLD denylist called PayPal 2 exempt — this is the defect, stated',
  oldDenylist(paypal) === false)
ok('...and the allowlist calls it a projection',
  scheduleGoesStale(paypal) === true)
ok('the two rules DISAGREE on exactly this row, which is why the change matters',
  oldDenylist(paypal) !== scheduleGoesStale(paypal))

console.log('\n  ...and the two rules agree everywhere else, so nothing else moves')
for (const r of PRODUCTION.slice(1)) {
  ok(`${r.name} — verdict unchanged by the switch`,
    oldDenylist(r) === scheduleGoesStale(r),
    `old ${oldDenylist(r)} vs new ${scheduleGoesStale(r)}`)
}

console.log('\n  unknown provenance is not permission')
// The whole point of an allowlist. Each of these would have walked past the
// denylist; each must now be treated as a projection.
ok('a source nobody has vetted goes stale',
  scheduleGoesStale({ source: 'some_new_importer', amort_type: 'amortization_schedule' }))
ok('an amort_type nobody has vetted goes stale',
  scheduleGoesStale({ source: 'claude_assisted_parse', amort_type: 'balloon_schedule_v2' }))
ok('a row with NO source goes stale (the exact bug the client hit: source was never loaded)',
  scheduleGoesStale({ amort_type: 'amortization_schedule' }))
ok('a row with no amort_type goes stale',
  scheduleGoesStale({ source: 'claude_assisted_parse' }))
ok('null — a schedule we could not read — goes stale',
  scheduleGoesStale(null))
ok('undefined goes stale',
  scheduleGoesStale(undefined))
ok('an empty object goes stale',
  scheduleGoesStale({}))

console.log('\n  the guard still lets the real thing through')
// A guard that refuses everything is not a guard, it is an outage. Paired with
// every refusal above so neither half can pass on its own.
ok('a genuine contractual schedule is exempt',
  scheduleGoesStale({ source: 'claude_assisted_parse', amort_type: 'amortization_schedule' }) === false)
ok('...on either vetted source',
  scheduleGoesStale({ source: 'client_parsed_verified', amort_type: 'amortization_schedule' }) === false)
ok('both halves are required — right source, wrong artefact still goes stale',
  scheduleGoesStale({ source: 'client_parsed_verified', amort_type: 'actual_payment_history_from_lender_csv' }))
ok('both halves are required — right artefact, unvetted source still goes stale',
  scheduleGoesStale({ source: 'derived_from_statements', amort_type: 'amortization_schedule' }))

console.log('\n  scheduleGoesStale is exactly the inverse, on every shape above')
for (const r of [...PRODUCTION, {}, null, undefined, { source: 'x', amort_type: 'y' }]) {
  ok(`inverse holds for ${JSON.stringify(r)?.slice(0, 46) ?? String(r)}`,
    scheduleGoesStale(r as any) === !isContractualSchedule(r as any))
}

console.log('\n  the SPA copy has not drifted')
// A no-build single-file SPA cannot import from the functions tree, so
// admin-dashboard/index.html carries its own copy of both lists. That copy is
// the reason this module could be changed without the client noticing. Assert
// they are the same, the way recon-window asserts ZERO_CASH_MOVEMENT_SOURCES.
const spa = readFileSync(new URL('../admin-dashboard/index.html', import.meta.url), 'utf-8')
const listFrom = (name: string) => {
  const m = spa.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m) return null
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
}
const spaSources = listFrom('_REAL_SCHEDULE_SOURCES')
const spaTypes = listFrom('_SCHEDULE_AMORT_TYPES')
ok('_REAL_SCHEDULE_SOURCES is still present in the SPA', spaSources !== null)
ok('_SCHEDULE_AMORT_TYPES is still present in the SPA', spaTypes !== null)
ok('_REAL_SCHEDULE_SOURCES matches the shared module',
  JSON.stringify(spaSources) === JSON.stringify([...REAL_SCHEDULE_SOURCES]),
  `SPA ${JSON.stringify(spaSources)} vs shared ${JSON.stringify([...REAL_SCHEDULE_SOURCES])}`)
ok('_SCHEDULE_AMORT_TYPES matches the shared module',
  JSON.stringify(spaTypes) === JSON.stringify([...SCHEDULE_AMORT_TYPES]),
  `SPA ${JSON.stringify(spaTypes)} vs shared ${JSON.stringify([...SCHEDULE_AMORT_TYPES])}`)

console.log(`\n  ${pass} passing, ${fail} failing\n`)
if (fail) process.exit(1)
