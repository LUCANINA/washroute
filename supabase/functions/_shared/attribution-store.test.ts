import { assert, assertEquals } from "jsr:@std/assert"
import { gate, type GateResult } from "./attribution-gate.ts"
import {
  buildAttributionPayload, recordedEntryAmounts, MAX_VERDICTS, ATTRIBUTION_SCHEMA,
} from "./attribution-store.ts"

const AT = '2026-09-01T20:00:00.000Z'

/** A real passing verdict: PCV's 2026-08-31 double-reallocation journal. */
const passing = (): GateResult => gate({
  pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
  movedOnAccount: 1802.58, expectedOnAccount: 0,
  entry: { id: 'd1347f7c', date: '2026-08-31', kind: 'ManualJournal',
    lines: [{ account: '800', amount: 1802.58 }, { account: '254', amount: -1802.58 }] },
  sentence: 'A journal dated 2026-08-31 increased the loan by $1,802.58.',
  proposedCorrection: { amount: 1802.58, description: 'Reverse journal d1347f7c.' },
})

/** A real refused verdict: a span with no entry behind it. */
const refused = (amount = 858.66): GateResult => gate({
  pattern: 'unexplained_span', proposed: 'probable', code: '251',
  movedOnAccount: amount, expectedOnAccount: 0, entry: null,
  sentence: 'No single entry accounts for this gap.',
  proposedCorrection: { amount, description: 'do not post this' },
})

Deno.test("recordedEntryAmounts: both id columns, voided splits excluded, amount carried", () => {
  const m = recordedEntryAmounts([
    { xero_manual_journal_id: 'b0b4a203', matched_xero_bank_transaction_id: null, principal_amount: 2544.96 },
    { xero_manual_journal_id: null, matched_xero_bank_transaction_id: 'ec50f278', principal_amount: '5335.52' },
    { xero_manual_journal_id: 'voided-one', matched_xero_bank_transaction_id: null, principal_amount: 1, voided_at: '2026-08-01' },
  ])
  assertEquals(m.get('b0b4a203'), 2544.96)
  assertEquals(m.get('ec50f278'), 5335.52)
  assertEquals(m.has('voided-one'), false)
})

Deno.test("an UNGATED verdict never reaches storage, and is counted", () => {
  const fake = { pattern: 'double_reallocation', confidence: 'confirmed', amount: 999, sentence: 'trust me',
    refusals: [], violations: [], evidence: { entry_id: null, entry_date: null, entry_kind: null,
      lines_read: true, lines: null, computed_effect: null, moved_on_account: 0, expected_on_account: 0, habit: null },
    proposedCorrection: null } as unknown as GateResult
  const p = buildAttributionPayload({ verdicts: [fake, passing()], generatedAt: AT })
  assertEquals(p.counts.ungated, 1)
  assertEquals(p.verdicts.length, 1)
  assertEquals(p.verdicts[0].entry_id, 'd1347f7c')
})

Deno.test("lines are kept for a PASSED verdict and withheld from a REFUSED one", () => {
  const p = buildAttributionPayload({ verdicts: [passing(), refused()], generatedAt: AT })
  const [first, second] = p.verdicts
  assertEquals(first.confidence, 'confirmed')
  assertEquals(first.lines?.length, 2)
  assertEquals(second.confidence, 'unresolved')
  assertEquals(second.lines, undefined)
  assert(Array.isArray(second.refusals) && second.refusals.includes('no_attributed_entry'))
})

/**
 * A verdict that is REFUSED even though the entry's lines were read — the gate rejects
 * the measurement, not the evidence. This is the case that actually exercises the
 * "lines only on passed verdicts" rule; a refusal with `entry: null` has no lines to
 * withhold, so asserting on it proves nothing. (Caught by mutation M2, which survived
 * the first version of this suite.)
 */
const refusedWithLines = (): GateResult => gate({
  pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
  movedOnAccount: -1802.58, expectedOnAccount: 0,   // wrong SIGN: the journal raises 254
  entry: { id: 'd1347f7c', date: '2026-08-31', kind: 'ManualJournal',
    lines: [{ account: '800', amount: 1802.58 }, { account: '254', amount: -1802.58 }] },
  sentence: 'x',
})

Deno.test("lines are withheld even when the REFUSED verdict's entry had lines read", () => {
  const v = refusedWithLines()
  assert(v.refusals.includes('measurement_disagrees_with_entry'))
  assert(v.evidence.lines !== null, 'fixture must actually carry lines, or this proves nothing')
  const p = buildAttributionPayload({ verdicts: [v], generatedAt: AT })
  assertEquals(p.verdicts[0].lines, undefined)
  assertEquals(p.verdicts[0].confidence, 'unresolved')
})

Deno.test("a refused verdict carries no correction into storage", () => {
  const p = buildAttributionPayload({ verdicts: [refused()], generatedAt: AT })
  assertEquals(p.verdicts[0].correction, undefined)
})

Deno.test("more than MAX_VERDICTS: the excess is COUNTED, never silently dropped", () => {
  const many = Array.from({ length: MAX_VERDICTS + 5 }, (_, i) => refused(100 + i))
  const p = buildAttributionPayload({ verdicts: many, generatedAt: AT })
  assertEquals(p.verdicts.length, MAX_VERDICTS)
  assertEquals(p.counts.omitted, 5)
  assertEquals(p.counts.unresolved, MAX_VERDICTS + 5)   // the COUNT still sees them all
})

Deno.test("ordering is deterministic — the same input twice produces identical bytes", () => {
  const vs = [refused(500), passing(), refused(900)]
  const a = JSON.stringify(buildAttributionPayload({ verdicts: vs, generatedAt: AT }))
  const b = JSON.stringify(buildAttributionPayload({ verdicts: [...vs].reverse(), generatedAt: AT }))
  assertEquals(a, b)
})

Deno.test("strongest verdict first, then the largest amount", () => {
  const p = buildAttributionPayload({ verdicts: [refused(9999), passing(), refused(100)], generatedAt: AT })
  assertEquals(p.verdicts.map(v => v.confidence), ['confirmed', 'unresolved', 'unresolved'])
  assertEquals(p.verdicts[1].amount, 9999)
})

Deno.test("the headline is the top actionable sentence when there is one", () => {
  const p = buildAttributionPayload({ verdicts: [refused(), passing()], generatedAt: AT })
  assert(p.headline.includes('$1,802.58'))
})

Deno.test("with only refusals, the headline says so plainly rather than going quiet", () => {
  const p = buildAttributionPayload({ verdicts: [refused(), refused(200)], generatedAt: AT })
  assert(p.headline.includes('2 differences'))
  assert(p.headline.includes('none of which'))
})

Deno.test("an IMMATERIAL refusal is not reported as a difference", () => {
  // The gate refused because there is no material difference; v1's headline turned that
  // into "1 difference ... none of which a ledger entry accounts for."
  const tiny = gate({ pattern: 'unexplained_span', proposed: 'probable', code: '1',
    movedOnAccount: 0.01, expectedOnAccount: 0, entry: null, sentence: 'x' })
  const p = buildAttributionPayload({ verdicts: [tiny], generatedAt: AT })
  assertEquals(p.headline, 'Nothing on this loan needs attributing.')
})

Deno.test("the headline never goes silent about pipeline defects", () => {
  const forged = { gated: true, confidence: 'confirmed', amount: 9, pattern: 'x',
    sentence: 'trust me', refusals: [], violations: [], evidence: {}, proposedCorrection: null } as never
  const p = buildAttributionPayload({ verdicts: [forged], generatedAt: AT })
  assertEquals(p.counts.ungated, 1)
  assert(p.headline.includes('not gate-issued'), p.headline)
})

Deno.test("a malformed branded verdict is discarded and counted, not crashed on", () => {
  const g = gate({ pattern: 'unexplained_span', proposed: 'probable', code: '1',
    movedOnAccount: -50, expectedOnAccount: 0, entry: null, sentence: 'x' })
  delete (g as unknown as Record<string, unknown>).refusals
  const p = buildAttributionPayload({ verdicts: [g], generatedAt: AT })
  assertEquals(p.counts.malformed, 1)
  assertEquals(p.verdicts.length, 0)
})

Deno.test("skipped is bounded and the remainder counted", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ from: 'a' + i, to: 'b', reason: 'clean' }))
  const p = buildAttributionPayload({ verdicts: [], skipped: many, generatedAt: AT })
  assertEquals(p.skipped.length, 25)
  assertEquals(p.counts.skipped_omitted, 15)
})

Deno.test("the sort is TOTAL — equal-magnitude opposite-sign refusals order identically", () => {
  const a = gate({ pattern: 'unexplained_span', proposed: 'probable', code: '1',
    movedOnAccount: 500, expectedOnAccount: 0, entry: null, sentence: 'plus', period: { from: 'a', to: 'b' } })
  // SAME period on both: otherwise the period tiebreak masks the amount tiebreak and
  // the assertion passes even with the signed-amount comparator removed (mutation M12).
  const b = gate({ pattern: 'unexplained_span', proposed: 'probable', code: '1',
    movedOnAccount: -500, expectedOnAccount: 0, entry: null, sentence: 'minus', period: { from: 'a', to: 'b' } })
  const f = JSON.stringify(buildAttributionPayload({ verdicts: [a, b], generatedAt: AT }))
  const r = JSON.stringify(buildAttributionPayload({ verdicts: [b, a], generatedAt: AT }))
  assertEquals(f, r)
  // and prove the fixture can actually distinguish them
  assert(a.amount !== b.amount)
})

Deno.test("the arithmetic behind the conclusion is stored, not just the conclusion", () => {
  const p = buildAttributionPayload({ verdicts: [passing()], generatedAt: AT })
  assertEquals(p.verdicts[0].moved_on_account, 1802.58)
  assertEquals(p.verdicts[0].expected_on_account, 0)
  assertEquals(p.verdicts[0].computed_effect, 1802.58)
})

Deno.test("with nothing at all, the headline says nothing needs attributing", () => {
  const p = buildAttributionPayload({ verdicts: [], generatedAt: AT })
  assertEquals(p.headline, 'Nothing on this loan needs attributing.')
  assertEquals(p.counts, { confirmed: 0, probable: 0, unresolved: 0, omitted: 0, ungated: 0,
                           malformed: 0, violations: 0, skipped_omitted: 0 })
})

Deno.test("not_enough_history is stated, not disguised as a clean result", () => {
  const p = buildAttributionPayload({ verdicts: [], generatedAt: AT, notEnoughHistory: true })
  assertEquals(p.note, 'not_enough_history')
  assert(p.headline.includes('Not enough lender history'))
})

Deno.test("the payload is a pure function of its inputs — no clock is read", () => {
  const p = buildAttributionPayload({ verdicts: [passing()], generatedAt: AT })
  assertEquals(p.generated_at, AT)
  assertEquals(p.schema, ATTRIBUTION_SCHEMA)
})

Deno.test("the stored payload stays small enough for a column rewritten every run", () => {
  const many = Array.from({ length: 30 }, () => passing())
  const bytes = JSON.stringify(buildAttributionPayload({ verdicts: many, generatedAt: AT })).length
  assert(bytes < 12000, `payload was ${bytes} bytes`)
})

// ── INHERITED: was the gap born inside a closed period? (session 259) ──────────
// David's rule: older than the prior close = inherited. The flag exists so Ramona
// can tell a reopen-or-absorb decision from a correcting entry.

/** The same passing verdict, but carrying the span the gap was born in. */
const passingInSpan = (from: string, to: string): GateResult => gate({
  pattern: 'double_reallocation', proposed: 'confirmed', code: '254',
  movedOnAccount: 1802.58, expectedOnAccount: 0,
  period: { from, to },
  entry: { id: 'd1347f7c', date: '2026-08-31', kind: 'ManualJournal',
    lines: [{ account: '800', amount: 1802.58 }, { account: '254', amount: -1802.58 }] },
  sentence: 'A journal dated 2026-08-31 increased the loan by $1,802.58.',
})

Deno.test("a gap born before the close is marked INHERITED", () => {
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-04-19', '2026-05-09')],
    generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assertEquals(p.verdicts[0].inherited, true)
})

Deno.test("a gap born after the close is NOT inherited", () => {
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-08-01', '2026-08-31')],
    generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assertEquals(p.verdicts[0].inherited, false)
})

Deno.test("the boundary is INCLUSIVE — a gap born ON the close date is inside it", () => {
  // The one date the CPA is most likely to be asked about. `<` would call it current.
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-07-31', '2026-08-15')],
    generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assertEquals(p.verdicts[0].inherited, true)
})

Deno.test("with NO close on file the answer is null, never a confident false", () => {
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-04-19', '2026-05-09')],
    generatedAt: AT,
  })
  assertEquals(p.verdicts[0].inherited, null)
  assert(!p.headline.includes('born on or before'), p.headline)
})

Deno.test("a verdict with no span is null too — there is nothing to compare", () => {
  const p = buildAttributionPayload({
    verdicts: [passing()], generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assertEquals(p.verdicts[0].period, null)
  assertEquals(p.verdicts[0].inherited, null)
})

Deno.test("the headline says how many were inherited, and names the close it used", () => {
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-04-19', '2026-05-09')],
    generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assert(p.headline.includes('1 of these was born on or before the 2026-07-31 close.'), p.headline)
})

Deno.test("DISCRIMINATES — a post-close gap produces no inherited clause at all", () => {
  const p = buildAttributionPayload({
    verdicts: [passingInSpan('2026-08-01', '2026-08-31')],
    generatedAt: AT, priorCloseDate: '2026-07-31',
  })
  assert(!p.headline.includes('born on or before'), p.headline)
})
