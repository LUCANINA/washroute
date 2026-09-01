// ⛔ NOT FIT TO WIRE — adversarial audit 2026-09-01 found 14 defects, 3 of them
// severe, ALL REPRODUCED INDEPENDENTLY. Do not call this module from
// `reconciliation-run` or any other caller until the fix list in
// PROJECT-NOTES-BOOKKEEPING.md (session 259 cont. 12) is worked through. The
// headline claims below about what "cannot" happen were wrong; treat every
// reassuring sentence in this header as unverified until its test exists.
//
// _shared/attribution-store.ts — what gets STORED, and what deliberately does not
// (session 259 cont. 11)
//
// Turns gated verdicts into the payload for `loan_tie_outs.detail.attribution`.
// Existing jsonb column, no migration.
//
// THE JOB IS AS MUCH ABOUT REFUSING TO STORE AS ABOUT STORING
// ----------------------------------------------------------
//  * ~~**Nothing ungated gets in.**~~ **THIS CLAIM IS FALSE — see the banner above.**
//    `gated: true` is a plain data property, so any object literal carrying it passes
//    the filter. A forged verdict was stored with its motive prose as the loan's
//    headline and a $250,000 postable correction attached (verified 2026-09-01).
//    The brand must become a runtime registry (WeakSet minted inside the gate) or the
//    store must re-derive confidence from refusals rather than trusting the field.
//  * **Bounded by construction.** A loan can produce a dozen spans; PayPal 2 produced
//    ten. Storing every verdict with every line item would bloat a jsonb column that
//    `reconciliation-run` rewrites on every run. So: `MAX_VERDICTS` kept, the rest
//    counted in `omitted` — **never silently truncated**, because a count that
//    disappears is how a real finding vanishes.
//  * **Evidence only where it can be acted on.** Line items are kept for verdicts that
//    PASSED the gate (those are the ones a person works from, and a workpaper needs the
//    lines). A refused verdict stores its refusal codes and no lines — either it had
//    none, or the lines were the problem.
//  * **Deterministic.** Same input, same bytes: verdicts sort by a fixed key, so a
//    re-run that changes nothing writes the same value and the row does not churn.
//    `generated_at` is passed IN, never read from the clock, so the payload is a pure
//    function of its inputs and can be unit-tested.
//
// WHAT A SQL READER GETS WITHOUT PARSING ANYTHING
// -----------------------------------------------
//   detail->'attribution'->>'headline'          one sentence, or the honest silence
//   detail->'attribution'->'counts'             {confirmed, probable, unresolved, omitted}
//   detail->'attribution'->'verdicts'           the list, richest first
// That is the phase-1 surface: read it in SQL, check it by hand, no UI.

import type { GateResult } from './attribution-gate.ts'

export const ATTRIBUTION_SCHEMA = 1
export const MAX_VERDICTS = 12
export const MAX_LINES_PER_VERDICT = 8

export type StoredVerdict = {
  pattern: string
  confidence: string
  amount: number
  sentence: string
  entry_id: string | null
  entry_date: string | null
  entry_kind: string | null
  refusals?: string[]
  violations?: string[]
  lines?: Array<{ account: string; amount: number }>
  correction?: { amount: number; description: string } | null
}

export type AttributionPayload = {
  schema: number
  generated_at: string
  source: string
  headline: string
  counts: { confirmed: number; probable: number; unresolved: number; omitted: number; ungated: number }
  verdicts: StoredVerdict[]
  skipped: Array<{ from: string; to: string; reason: string; entryId?: string }>
  /** Set when the walk could not run at all. */
  note?: string
}

const RANK: Record<string, number> = { confirmed: 0, probable: 1, unresolved: 2 }

/**
 * The id set the adapter needs so it never accuses an entry we filed ourselves.
 * Voided splits are excluded — a voided record is not a record.
 */
export function recordedEntryIdsFromSplits(
  splits: Array<{ xero_manual_journal_id?: string | null; matched_xero_bank_transaction_id?: string | null; voided_at?: string | null }>,
): string[] {
  const out = new Set<string>()
  for (const s of splits ?? []) {
    if (s.voided_at) continue
    if (s.xero_manual_journal_id) out.add(String(s.xero_manual_journal_id))
    if (s.matched_xero_bank_transaction_id) out.add(String(s.matched_xero_bank_transaction_id))
  }
  return [...out].sort()
}

function headlineFor(kept: StoredVerdict[], counts: AttributionPayload['counts']): string {
  const top = kept.find(v => v.confidence !== 'unresolved')
  if (top) return top.sentence
  if (counts.unresolved > 0) {
    return `${counts.unresolved} difference${counts.unresolved === 1 ? '' : 's'} on this loan, `
      + `none of which a specific ledger entry accounts for yet.`
  }
  return 'Nothing on this loan needs attributing.'
}

export function buildAttributionPayload(input: {
  verdicts: GateResult[]
  skipped?: Array<{ from: string; to: string; reason: string; entryId?: string }>
  /** Pass the run's timestamp. Never read the clock in here — it must stay pure. */
  generatedAt: string
  source?: string
  notEnoughHistory?: boolean
}): AttributionPayload {
  const counts = { confirmed: 0, probable: 0, unresolved: 0, omitted: 0, ungated: 0 }

  // Anything not branded by the gate never reaches storage.
  const gated = (input.verdicts ?? []).filter(v => {
    if (v && (v as GateResult).gated === true) return true
    counts.ungated++
    return false
  })

  for (const v of gated) {
    if (v.confidence === 'confirmed') counts.confirmed++
    else if (v.confidence === 'probable') counts.probable++
    else counts.unresolved++
  }

  // Deterministic: strongest first, then biggest money, then a stable tiebreak so two
  // identical runs produce identical bytes.
  const sorted = [...gated].sort((a, b) =>
    (RANK[a.confidence] ?? 9) - (RANK[b.confidence] ?? 9)
    || Math.abs(b.amount) - Math.abs(a.amount)
    || String(a.evidence.entry_id ?? '').localeCompare(String(b.evidence.entry_id ?? ''))
    || a.pattern.localeCompare(b.pattern))

  const keep = sorted.slice(0, MAX_VERDICTS)
  counts.omitted = sorted.length - keep.length

  const verdicts: StoredVerdict[] = keep.map(v => {
    const passed = v.refusals.length === 0
    const row: StoredVerdict = {
      pattern: v.pattern,
      confidence: v.confidence,
      amount: v.amount,
      sentence: v.sentence,
      entry_id: v.evidence.entry_id,
      entry_date: v.evidence.entry_date,
      entry_kind: v.evidence.entry_kind,
    }
    if (v.refusals.length) row.refusals = v.refusals
    if (v.violations.length) row.violations = v.violations
    // Lines are the workpaper. Keep them only where someone can act on the verdict.
    if (passed && v.evidence.lines) row.lines = v.evidence.lines.slice(0, MAX_LINES_PER_VERDICT)
    if (v.proposedCorrection) row.correction = v.proposedCorrection
    return row
  })

  const payload: AttributionPayload = {
    schema: ATTRIBUTION_SCHEMA,
    generated_at: input.generatedAt,
    source: input.source ?? 'loan-find-difference',
    headline: input.notEnoughHistory
      ? 'Not enough lender history on file to walk this loan.'
      : headlineFor(verdicts, counts),
    counts,
    verdicts,
    skipped: input.skipped ?? [],
  }
  if (input.notEnoughHistory) payload.note = 'not_enough_history'
  return payload
}
