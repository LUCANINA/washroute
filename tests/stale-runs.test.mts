// tests/stale-runs.test.mts — the reaper for runs that died mid-flight, and
// proof it cannot reap a live one.
//
// Run:  node --experimental-strip-types tests/stale-runs.test.mts

import { staleRunIds, STALE_RUN_MS } from '../supabase/functions/_shared/stale-runs.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const NOW = Date.parse('2026-09-04T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000

// ── The eight real rows, read from production on 2026-09-04 ────────────────
const PRODUCTION = [
  { id: 'a8bcb21f', status: 'running', started_at: '2026-09-02T13:45:46.713Z', finished_at: null },
  { id: '1522d89f', status: 'running', started_at: '2026-09-02T00:09:11.780Z', finished_at: null },
  { id: '0dac0072', status: 'running', started_at: '2026-09-01T21:57:52.821Z', finished_at: null },
  { id: '1d1c1f9f', status: 'running', started_at: '2026-09-01T15:35:07.423Z', finished_at: null },
  { id: 'e9d3942b', status: 'running', started_at: '2026-09-01T14:51:14.463Z', finished_at: null },
  // ...and the three the notes never counted, which is the point of measuring.
  { id: 'older-1', status: 'running', started_at: '2026-08-27T04:15:46.158Z', finished_at: null },
  { id: 'older-2', status: 'running', started_at: '2026-08-28T04:15:46.158Z', finished_at: null },
  { id: 'older-3', status: 'running', started_at: '2026-08-29T04:15:46.158Z', finished_at: null },
  // The healthy rows that must survive untouched.
  { id: '46f52aa5', status: 'complete', started_at: '2026-09-03T17:58:20.369Z', finished_at: '2026-09-03T17:58:37.960Z' },
  { id: '2c12dec2', status: 'complete', started_at: '2026-09-02T20:50:54.765Z', finished_at: '2026-09-02T20:51:14.257Z' },
]

console.log('\n  the rows that are actually stuck')
const dead = staleRunIds(PRODUCTION, NOW)
ok('all eight stuck rows are reaped', dead.length === 8, `got ${dead.length}`)
ok('...including the three older than the note recorded', dead.includes('older-1') && dead.includes('older-3'))
ok('no completed row is touched', !dead.includes('46f52aa5') && !dead.includes('2c12dec2'))

console.log('\n  it cannot reap a live run — the property that makes it safe')
// The longest run that ever COMPLETED took 77 seconds, across all 81 complete
// rows. Each of these is a run that is plausibly still going.
ok('a run started one second ago survives',
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(1_000), finished_at: null }], NOW).length === 0)
ok('a run at 77s — the longest ever recorded — survives',
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(77_000), finished_at: null }], NOW).length === 0)
ok('a run at 5 minutes, far beyond any real one, still survives',
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(5 * MIN), finished_at: null }], NOW).length === 0)

console.log('\n  the boundary, from both sides')
ok(`exactly ${STALE_RUN_MS / MIN} minutes is NOT yet stale`,
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(STALE_RUN_MS), finished_at: null }], NOW).length === 0)
ok('one millisecond past it is',
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(STALE_RUN_MS + 1), finished_at: null }], NOW).length === 1)

console.log('\n  it refuses to touch anything it has not measured')
ok('a settled row is left alone even if ancient — re-settling rewrites history',
  staleRunIds([{ id: 'x', status: 'complete', started_at: ago(30 * 24 * 60 * MIN), finished_at: ago(1) }], NOW).length === 0)
ok('an already-failed row is not re-failed',
  staleRunIds([{ id: 'x', status: 'failed', started_at: ago(99 * MIN), finished_at: ago(98 * MIN) }], NOW).length === 0)
ok('a row that IS finished but still says running is left alone — different bug, not this one',
  staleRunIds([{ id: 'x', status: 'running', started_at: ago(99 * MIN), finished_at: ago(98 * MIN) }], NOW).length === 0)
ok('no started_at means no age, and no age means no reaping',
  staleRunIds([{ id: 'x', status: 'running', started_at: null, finished_at: null }], NOW).length === 0)
ok('an unparseable started_at is the same — fail open, one stale row beats a killed live one',
  staleRunIds([{ id: 'x', status: 'running', started_at: 'not a date', finished_at: null }], NOW).length === 0)
ok('a row with no id cannot be addressed, so it is not returned',
  staleRunIds([{ status: 'running', started_at: ago(99 * MIN), finished_at: null }], NOW).length === 0)
ok('an unknown status is not running and is left alone',
  staleRunIds([{ id: 'x', status: 'queued', started_at: ago(99 * MIN), finished_at: null }] as any, NOW).length === 0)

console.log('\n  the empties')
ok('no rows returns nothing', staleRunIds([], NOW).length === 0)
ok('null returns nothing', staleRunIds(null, NOW).length === 0)
ok('undefined returns nothing', staleRunIds(undefined, NOW).length === 0)
ok('a null entry in the list does not throw', staleRunIds([null as any], NOW).length === 0)

console.log(`\n  ${pass} passing, ${fail} failing\n`)
if (fail) process.exit(1)
