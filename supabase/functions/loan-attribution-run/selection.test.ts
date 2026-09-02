// Tests for loan-attribution-run's pure half.
//
// These import the SHIPPED functions. Session 245 found this suite carrying copies of
// dashboard functions with "transcribed from admin-dashboard/index.html" in the comments
// — 52 green assertions proving a copy agreed with itself. Nothing here is transcribed;
// if `selection.ts` changes, these break.
//
// Every assertion below was proved to DISCRIMINATE: the inverse of the behaviour it
// claims was applied to selection.ts and the assertion confirmed red before being
// committed green. The mutation table is in the session 261 notes entry.

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  selectLoans, orderByStaleness, bankEntryIds, isGuid, xeroIdWhereChunks, typeMapFromRows,
} from './selection.ts'

// HEX LETTERS ARE LOAD-BEARING IN THESE FIXTURES. The first version of this file used
// all-digit GUIDs, so `.toUpperCase()` in t2 returned the identical string and the
// case-mismatch test exercised no case mismatch -- it passed against the broken code as
// happily as the fixed. A mutation caught it (m11 survived); the assertion never would
// have. Session 245's rule about tests that cannot fail applies to their DATA too.
const G1 = 'aaaaaaaa-1111-4111-8111-1111111111ab'
const G2 = 'bbbbbbbb-2222-4222-8222-2222222222cd'
const G3 = 'cccccccc-3333-4333-8333-3333333333ef'

const finding = (o: Record<string, unknown> = {}) => ({
  id: 'f1', loan_account_id: 'L1', check_key: 'balance_vs_lender',
  status: 'open', severity: 'error', last_seen_at: '2026-09-01T00:00:00Z', ...o,
})

// ── selectLoans ─────────────────────────────────────────────────────────────

Deno.test('s1 selects an open material balance_vs_lender finding', () => {
  assertEquals(selectLoans([finding()]), [{ loan_account_id: 'L1', finding_id: 'f1' }])
})

Deno.test('s2 the engine\'s own severity decides materiality: info is skipped', () => {
  // EIDL's -$5.00 today. The floor is NOT recomputed here -- a second threshold in a
  // second file is how two numbers on one screen start disagreeing.
  assertEquals(selectLoans([finding({ severity: 'info' })]), [])
  // ...but warn is material. A rule written as `severity === 'error'` would drop this,
  // and balance_vs_lender has no open warn row today to notice it with.
  assertEquals(selectLoans([finding({ severity: 'warn' })]).length, 1)
})

Deno.test('s3 a resolved finding, or another check type, is not attribution work', () => {
  assertEquals(selectLoans([finding({ status: 'resolved' })]), [])
  assertEquals(selectLoans([finding({ check_key: 'derived_drift' })]), [])
})

Deno.test('s4 two open findings on one loan collapse to the NEWEST, deterministically', () => {
  const out = selectLoans([
    finding({ id: 'old', last_seen_at: '2026-08-01T00:00:00Z' }),
    finding({ id: 'new', last_seen_at: '2026-09-01T00:00:00Z' }),
  ])
  assertEquals(out, [{ loan_account_id: 'L1', finding_id: 'new' }])
  // and the same answer whichever order the rows arrive in
  const rev = selectLoans([
    finding({ id: 'new', last_seen_at: '2026-09-01T00:00:00Z' }),
    finding({ id: 'old', last_seen_at: '2026-08-01T00:00:00Z' }),
  ])
  assertEquals(rev, out)
})

Deno.test('s5 malformed rows are dropped rather than crashing the pass', () => {
  assertEquals(selectLoans([null as any, {} as any, finding({ loan_account_id: '' })]), [])
})

// ── orderByStaleness ────────────────────────────────────────────────────────

Deno.test('o1 a never-computed loan goes before every computed one', () => {
  const sel = [{ loan_account_id: 'A', finding_id: 'f' }, { loan_account_id: 'B', finding_id: 'f' }]
  // B has a stored answer, A has none -- A leads even though B sorts first by id.
  const out = orderByStaleness(sel, [{ loan_account_id: 'B', generated_at: '2020-01-01T00:00:00Z' }])
  assertEquals(out.map(x => x.loan_account_id), ['A', 'B'])
})

Deno.test('o2 among computed loans the OLDEST answer goes first', () => {
  const sel = [{ loan_account_id: 'A', finding_id: 'f' }, { loan_account_id: 'B', finding_id: 'f' }]
  const out = orderByStaleness(sel, [
    { loan_account_id: 'A', generated_at: '2026-09-01T00:00:00Z' },
    { loan_account_id: 'B', generated_at: '2026-08-01T00:00:00Z' },
  ])
  assertEquals(out.map(x => x.loan_account_id), ['B', 'A'])
})

Deno.test('o3 STARVATION BECOMES ROTATION: the loan cut off by the budget leads next pass', () => {
  // This is the property the ordering exists for, so it is asserted as a property and
  // not as one sorted list. Two loans, a budget of one: run, store, run again, and the
  // loan that missed out must be the one that goes first.
  const sel = [{ loan_account_id: 'A', finding_id: 'f' }, { loan_account_id: 'B', finding_id: 'f' }]
  const stored: Array<{ loan_account_id: string; generated_at: string }> = []
  const seen: string[] = []
  for (let pass = 1; pass <= 4; pass++) {
    const first = orderByStaleness(sel, stored)[0].loan_account_id
    seen.push(first)
    const at = `2026-09-0${pass}T00:00:00Z`
    const row = stored.find(r => r.loan_account_id === first)
    if (row) row.generated_at = at
    else stored.push({ loan_account_id: first, generated_at: at })
  }
  assertEquals(seen, ['A', 'B', 'A', 'B'])
  // and nobody is starved: both loans were reached
  assert(new Set(seen).size === 2)
})

// ── bankEntryIds ────────────────────────────────────────────────────────────

const bt = (id: string) => ({ src_type: 'BankTransaction', id })
const mj = (id: string) => ({ src_type: 'ManualJournal', id })

Deno.test('b1 collects the culprit entry, its TWIN, and the cpa exception', () => {
  const walk = {
    periods: [
      { culprit: { entry: bt(G1), twin: bt(G2) } },
      { culprit: { entry: bt(G3) } },
    ],
  cpa_exception: { entry: bt('dddddddd-4444-4444-8444-4444444444ff') },
  }
  const ids = bankEntryIds(walk)
  assertEquals(ids.length, 4)
  // the twin specifically: omit it and a duplicate_suspected claim refuses for want of a
  // type, which reads as "we could not tell" rather than "we did not ask"
  assert(ids.includes(G2))
})

Deno.test('b2 ManualJournals are excluded -- their direction is in the line signs', () => {
  const walk = { periods: [{ culprit: { entry: mj(G1), twin: bt(G2) } }] }
  assertEquals(bankEntryIds(walk), [G2])
})

Deno.test('b3 deduplicates, and survives a walk with no periods at all', () => {
  assertEquals(bankEntryIds({ periods: [{ culprit: { entry: bt(G1) } }, { culprit: { entry: bt(G1) } }] }), [G1])
  assertEquals(bankEntryIds({}), [])
  assertEquals(bankEntryIds(null), [])
  assertEquals(bankEntryIds({ periods: [{ culprit: null }, {}] }), [])
})

// ── the where clause ────────────────────────────────────────────────────────

Deno.test('g1 only a real GUID is a GUID', () => {
  assert(isGuid(G1))
  assert(!isGuid('not-a-guid'))
  assert(!isGuid(''))
  assert(!isGuid(null))
  assert(!isGuid(`${G1}") OR Type=="SPEND`))
})

Deno.test('w1 a non-GUID id is REJECTED, never interpolated into the query', () => {
  // Xero's `where` has no parameter binding; the clause is concatenated into a URL. An
  // id that is not a GUID cannot be made safe by quoting and cannot be a real entry.
  const evil = `${G1}") OR Type=="SPEND`
  const { chunks, rejected } = xeroIdWhereChunks([G1, evil])
  assertEquals(rejected, [evil])
  assertEquals(chunks.length, 1)
  assert(!chunks[0].includes('OR Type'))
  assertEquals(chunks[0], `BankTransactionID==Guid("${G1}")`)
})

Deno.test('w2 rejects are RETURNED, not silently dropped', () => {
  // An id we declined to ask about is a hole in the answer; the run report has to be
  // able to say so. A version that filtered quietly would pass every other assertion.
  const { rejected } = xeroIdWhereChunks(['nope', 'also-nope'])
  assertEquals(rejected.length, 2)
})

Deno.test('w3 chunks at the stated size', () => {
  const ids = Array.from({ length: 7 }, (_, i) =>
    `${String(i).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36))
  const { chunks } = xeroIdWhereChunks(ids.filter(isGuid), 3)
  assertEquals(chunks.length, 3)                       // 3 + 3 + 1
  assertEquals(chunks[0].split('||').length, 3)
  assertEquals(chunks[2].split('||').length, 1)
})

// ── typeMapFromRows ─────────────────────────────────────────────────────────

Deno.test('t1 maps a type onto the walk\'s id', () => {
  const { map, missing } = typeMapFromRows([{ id: G1, type: 'SPEND' }], [G1])
  assertEquals(map.get(G1), 'SPEND')
  assertEquals(missing, [])
})

Deno.test('t2 A CASE MISMATCH DOES NOT SILENTLY REFUSE EVERY CLAIM', () => {
  // toLedgerEntry looks the type up with an exact-string Map.get(String(v.id)). Xero is
  // not consistent about GUID case between endpoints. Keyed naively, the lookup misses,
  // the type is undefined, and every claim refuses with entry_direction_unknown -- the
  // job reporting "we could not determine the direction" for a fetch that succeeded.
  const upper = G1.toUpperCase()
  const { map, missing } = typeMapFromRows([{ id: upper, type: 'SPEND' }], [G1])
  assertEquals(missing, [])
  // keyed by the WALK's spelling, which is the one attributionFromWalk will look up
  assertEquals(map.get(G1), 'SPEND')
})

Deno.test('t3 an id Xero did not return is OMITTED, never mapped to null', () => {
  // Absent means "Xero did not tell us" and the caller counts those. null would look the
  // same to the gate but lose the count.
  const { map, missing } = typeMapFromRows([{ id: G1, type: 'SPEND' }], [G1, G2])
  assertEquals(missing, [G2])
  assertEquals(map.has(G2), false)
  assertEquals(map.size, 1)
})

Deno.test('t4 a row Xero returned with no type maps to null, and is not "missing"', () => {
  // We asked and Xero answered; it just had nothing to say. That is a different fact
  // from never having asked, and the gate refuses on both -- but the report should not
  // conflate them.
  const { map, missing } = typeMapFromRows([{ id: G1, type: null }], [G1])
  assertEquals(missing, [])
  assertEquals(map.has(G1), true)
  assertEquals(map.get(G1), null)
})

Deno.test('t5 does not invent entries the walk never accused', () => {
  const { map } = typeMapFromRows([{ id: G1, type: 'SPEND' }, { id: G2, type: 'RECEIVE' }], [G1])
  assertEquals(map.size, 1)
})
