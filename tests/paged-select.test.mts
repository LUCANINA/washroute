// tests/paged-select.test.mts — read every row, or refuse (s321)
//
// Run:  node --experimental-strip-types tests/paged-select.test.mts
//
// THE CASE THIS PINS IS LIVE. On 2026-09-22 the daily check found
// reconciliation-run's amortization read returning 1,081 anchor rows against
// PostgREST's 1,000-row cap — so for days the nightly run chose which schedule
// wins, and which balance answers a date, from a set with ~81 rows missing.
// PostgREST reports no error when it truncates: the only visible difference
// between a complete answer and a partial one is a number nobody was reading.
//
// The stub below IS that cap: it never returns more than `cap` rows for one
// request, exactly as the server does.

import { fetchAllPaged } from '../supabase/functions/_shared/paged-select.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// A table of `total` rows behind a server that caps every response at `cap`.
const table = (total: number, cap = 1000) => {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }))
  const calls: Array<[number, number]> = []
  return {
    calls,
    read: (from: number, to: number) => {
      calls.push([from, to])
      return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null })
    },
  }
}

section('the live defect, reproduced and fixed')
{
  const t = table(1081)
  // What the old code did: ONE request, no range. The server hands back 1,000
  // rows and says nothing. This assertion is the bug, pinned.
  const single = await t.read(0, 100000)
  ok('one request returns 1,000 of 1,081 rows, silently', single.data.length === 1000,
    `got ${single.data.length}`)

  const t2 = table(1081)
  const all = await fetchAllPaged('amort', t2.read)
  ok('paged returns all 1,081', all.length === 1081, `got ${all.length}`)
  ok('...every row exactly once', new Set(all.map(r => r.id)).size === 1081)
  ok('...in two requests', t2.calls.length === 2, JSON.stringify(t2.calls))
}

section('the boundaries')
{
  const t = table(2000)
  const all = await fetchAllPaged('exact-multiple', t.read)
  ok('an exact multiple of the page size is complete', all.length === 2000, `got ${all.length}`)
  ok('...and costs one extra empty read to prove it', t.calls.length === 3, JSON.stringify(t.calls))

  ok('an empty table is an empty array', (await fetchAllPaged('empty', table(0).read)).length === 0)
  ok('a short table is one request', (await fetchAllPaged('short', table(7).read)).length === 7)
}

section('A FAILED PAGE IS NEVER A SHORTER ANSWER')
{
  // The property that matters most: 1,000 good rows plus a failure is not a
  // 1,000-row answer, it is no answer. Returning the good half is precisely the
  // silent-truncation failure this module exists to end.
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }))
  let threw = ''
  try {
    await fetchAllPaged('flaky', (from, to) => Promise.resolve(
      from === 0 ? { data: rows.slice(from, to + 1), error: null }
                 : { data: null, error: { message: 'connection reset' } }))
  } catch (e: any) { threw = String(e?.message || e) }
  ok('a mid-walk error throws', threw !== '')
  ok('...naming the read and the rows already held', threw.includes('flaky') && threw.includes('1000'), threw)
  ok('...and saying it refuses a partial read', threw.includes('partial read'), threw)
}

section('the runaway guard')
{
  // A query whose order is not unique can page forever. Ten pages of a table
  // that never ends: the guard throws rather than looping.
  let threw = ''
  try {
    await fetchAllPaged('endless', (from, to) => Promise.resolve(
      { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: i })), error: null }),
      { maxPages: 10 })
  } catch (e: any) { threw = String(e?.message || e) }
  ok('an endless walk throws', threw.includes('10 pages'), threw)
  ok('...and points at the likely cause', threw.includes('not unique'), threw)
}

section('IT DISCRIMINATES — the inverse of the fix goes red')
{
  // The fix is the loop. A version that keeps only the first page is what the
  // code did before, and every assertion above must be able to see the
  // difference — otherwise this file is decoration.
  const firstPageOnly = async (read: (f: number, t: number) => Promise<{ data: any[]; error: any }>) =>
    (await read(0, 999)).data
  const broken = await firstPageOnly(table(1081).read)
  ok('the un-looped version stops at 1,000', broken.length === 1000, `got ${broken.length}`)
  ok('...which the 1,081 assertion above would catch', broken.length !== 1081)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
if (fail) process.exit(1)
