import { assert, assertEquals } from "jsr:@std/assert"
import { gate, type GateResult } from "./attribution-gate.ts"
import {
  buildAttributionPayload, recordedEntryIdsFromSplits, MAX_VERDICTS, ATTRIBUTION_SCHEMA,
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

Deno.test("recordedEntryIds: both id columns, deduped, sorted, voided splits excluded", () => {
  const ids = recordedEntryIdsFromSplits([
    { xero_manual_journal_id: 'b0b4a203', matched_xero_bank_transaction_id: null },
    { xero_manual_journal_id: null, matched_xero_bank_transaction_id: 'ec50f278' },
    { xero_manual_journal_id: 'b0b4a203', matched_xero_bank_transaction_id: null },
    { xero_manual_journal_id: 'voided-one', matched_xero_bank_transaction_id: null, voided_at: '2026-08-01' },
  ])
  assertEquals(ids, ['b0b4a203', 'ec50f278'])
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

Deno.test("with nothing at all, the headline says nothing needs attributing", () => {
  const p = buildAttributionPayload({ verdicts: [], generatedAt: AT })
  assertEquals(p.headline, 'Nothing on this loan needs attributing.')
  assertEquals(p.counts, { confirmed: 0, probable: 0, unresolved: 0, omitted: 0, ungated: 0 })
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
