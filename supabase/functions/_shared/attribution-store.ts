// _shared/attribution-store.ts — what gets STORED, and what deliberately does not
// (session 259 cont. 11)
//
// Turns gated verdicts into the payload for `loan_tie_outs.detail.attribution`.
// Existing jsonb column, no migration.
//
// THE JOB IS AS MUCH ABOUT REFUSING TO STORE AS ABOUT STORING
// ----------------------------------------------------------
//  * **Nothing ungated gets in — enforced by IDENTITY, not by a property.** v1 checked
//    `v.gated === true`, which any object literal satisfies; a forged verdict reached
//    storage with motive prose as the headline and a $250,000 postable correction. The
//    check is now `isGated(v)`, a WeakSet membership test minted inside the gate.
//    Object identity cannot be forged and does NOT survive JSON — so a verdict that
//    crossed a wire is not gated, and this module must run in the same process as the
//    gate. That is the intended constraint, not a limitation.
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

import { isGated, type GateResult } from './attribution-gate.ts'

export const ATTRIBUTION_SCHEMA = 1
export const MAX_VERDICTS = 12
export const MAX_LINES_PER_VERDICT = 8
export const MAX_SKIPPED = 25

export type StoredVerdict = {
  pattern: string
  confidence: string
  amount: number
  sentence: string
  entry_id: string | null
  entry_date: string | null
  entry_kind: string | null
  period?: { from: string; to: string } | null
  /** The arithmetic behind `amount`. A conclusion without its working is not a workpaper. */
  moved_on_account?: number
  expected_on_account?: number
  computed_effect?: number | null
  habit?: { considered: number; satisfied: number } | null
  refusals?: string[]
  violations?: string[]
  /**
   * Was this gap born before the last closed period?
   *
   * TRUE / FALSE are claims. NULL is the third answer and it is not a formality: with
   * no close date on file we do not KNOW, and reporting `false` there would be a
   * derived fact wearing a measured one's clothes — the exact substitution this
   * pipeline exists to prevent. A verdict with no `period` is null for the same
   * reason: nothing to compare.
   */
  inherited?: boolean | null
  lines?: Array<{ account: string; amount: number }>
  correction?: { amount: number; description: string } | null
}

export type AttributionPayload = {
  schema: number
  generated_at: string
  source: string
  headline: string
  counts: {
    confirmed: number; probable: number; unresolved: number
    omitted: number; ungated: number; malformed: number
    violations: number; skipped_omitted: number
  }
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
export function recordedEntryAmounts(
  splits: Array<{
    xero_manual_journal_id?: string | null
    matched_xero_bank_transaction_id?: string | null
    principal_amount?: number | string | null
    voided_at?: string | null
  }>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of splits ?? []) {
    if (s.voided_at) continue                      // a voided record is not a record
    const amt = Math.abs(Math.round(Number(s.principal_amount ?? 0) * 100) / 100)
    if (s.xero_manual_journal_id) out.set(String(s.xero_manual_journal_id), amt)
    if (s.matched_xero_bank_transaction_id) out.set(String(s.matched_xero_bank_transaction_id), amt)
  }
  return out
}

/**
 * v1's headline read only the three confidence counts, so five ungated verdicts, or a
 * suppressed $5,000 culprit, both rendered as "Nothing on this loan needs attributing."
 * It also called an IMMATERIAL refusal "a difference ... none of which a ledger entry
 * accounts for" — the gate refused precisely because there is no material difference.
 * Both are fixed: defects are always named, and immaterial refusals are not differences.
 */
function headlineFor(kept: StoredVerdict[], all: StoredVerdict[], counts: AttributionPayload['counts'], priorCloseDate?: string | null): string {
  const parts: string[] = []
  const top = kept.find(v => v.confidence !== 'unresolved')
  const realUnresolved = all.filter(v =>
    v.confidence === 'unresolved' && !(v.refusals ?? []).includes('immaterial_claim')).length

  if (top) parts.push(top.sentence)
  else if (realUnresolved > 0) {
    parts.push(`${realUnresolved} difference${realUnresolved === 1 ? '' : 's'} on this loan, `
      + `none of which a specific ledger entry accounts for yet.`)
  } else parts.push('Nothing on this loan needs attributing.')

  if (top && realUnresolved > 0) parts.push(`${realUnresolved} further difference${realUnresolved === 1 ? '' : 's'} unaccounted for.`)
  if (counts.omitted > 0) parts.push(`${counts.omitted} more not listed here.`)
  // Say it in the headline, because it changes what the CPA does next: a gap born
  // inside a closed period is a reopen-or-absorb decision, not a correcting entry.
  // Counted over KEPT verdicts only — those are the ones whose flag is on display.
  const inherited = kept.filter(v => v.inherited === true).length
  if (inherited > 0 && priorCloseDate) {
    parts.push(`${inherited} of these ${inherited === 1 ? 'was' : 'were'} born on or before the ${priorCloseDate} close.`)
  }
  // These are DEFECTS in the pipeline, not findings about the loan. Never silent.
  if (counts.ungated > 0) parts.push(`⚠ ${counts.ungated} verdict(s) were rejected as not gate-issued.`)
  if (counts.malformed > 0) parts.push(`⚠ ${counts.malformed} malformed verdict(s) were discarded.`)
  if (counts.violations > 0) parts.push(`⚠ ${counts.violations} explanation(s) were withheld for attributing motive.`)
  return parts.join(' ')
}

/**
 * David's rule, session 259: a gap is INHERITED when it was born older than the prior
 * close. `period.from` is the earliest date the gap could have been born — the span
 * opens there — so a span opening on or before the close date is inherited.
 *
 * The boundary is deliberately INCLUSIVE. A gap born ON the close date is inside the
 * closed period, not after it; `<` would hand the CPA a gap dated the day of the close
 * and call it current, which is the one date she is most likely to be asked about.
 */
export function inheritedFlag(
  period: { from: string; to: string } | null | undefined,
  priorCloseDate: string | null | undefined,
): boolean | null {
  if (!priorCloseDate || !period?.from) return null
  return period.from <= priorCloseDate
}

export function buildAttributionPayload(input: {
  verdicts: GateResult[]
  skipped?: Array<{ from: string; to: string; reason: string; entryId?: string }>
  /** Pass the run's timestamp. Never read the clock in here — it must stay pure. */
  generatedAt: string
  source?: string
  notEnoughHistory?: boolean
  /**
   * The last closed period's end date, from the caller's own read of the close
   * table. Never read in here — same discipline as `generatedAt`. Omit or pass
   * null when no close is on file and every verdict's `inherited` becomes null.
   */
  priorCloseDate?: string | null
}): AttributionPayload {
  const counts = { confirmed: 0, probable: 0, unresolved: 0, omitted: 0, ungated: 0,
                   malformed: 0, violations: 0, skipped_omitted: 0 }

  // Identity, not a property. And a shape check: v1 admitted a branded object with no
  // `refusals` array and then CRASHED the whole reconciliation run dereferencing it.
  const gated = (input.verdicts ?? []).filter(v => {
    if (!isGated(v)) { counts.ungated++; return false }
    const ok = Array.isArray(v.refusals) && Array.isArray(v.violations)
      && v.evidence && typeof v.evidence === 'object' && typeof v.confidence === 'string'
    if (!ok) { counts.malformed++; return false }
    return true
  })

  for (const v of gated) {
    if (v.confidence === 'confirmed') counts.confirmed++
    else if (v.confidence === 'probable') counts.probable++
    else counts.unresolved++
    if (v.violations.length) counts.violations++
  }

  // Deterministic: strongest first, then biggest money, then a stable tiebreak so two
  // identical runs produce identical bytes.
  // v1's comparator tied on every key for a +500 and a -500 unexplained span, so stored
  // bytes depended on the order the walk happened to emit periods. Signed amount, then
  // the span, then the sentence — the last is a total tiebreak in practice.
  const sorted = [...gated].sort((a, b) =>
    (RANK[a.confidence] ?? 9) - (RANK[b.confidence] ?? 9)
    || Math.abs(b.amount) - Math.abs(a.amount)
    || (a.amount - b.amount)
    || String(a.evidence.entry_id ?? '').localeCompare(String(b.evidence.entry_id ?? ''))
    || String(a.period?.from ?? '').localeCompare(String(b.period?.from ?? ''))
    || String(a.period?.to ?? '').localeCompare(String(b.period?.to ?? ''))
    || a.pattern.localeCompare(b.pattern)
    || a.sentence.localeCompare(b.sentence))

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
      period: v.period ?? null,
      moved_on_account: v.evidence.moved_on_account,
      expected_on_account: v.evidence.expected_on_account,
      computed_effect: v.evidence.computed_effect,
      habit: v.evidence.habit,
      inherited: inheritedFlag(v.period, input.priorCloseDate),
    }
    if (v.refusals.length) row.refusals = v.refusals
    if (v.violations.length) row.violations = v.violations
    // Lines are the workpaper. Keep them only where someone can act on the verdict.
    if (passed && v.evidence.lines) row.lines = v.evidence.lines.slice(0, MAX_LINES_PER_VERDICT)
    if (v.proposedCorrection) row.correction = v.proposedCorrection
    return row
  })

  const skippedAll = input.skipped ?? []
  counts.skipped_omitted = Math.max(0, skippedAll.length - MAX_SKIPPED)
  // The headline must see EVERY verdict's refusals, not just the kept ones.
  const allStored: StoredVerdict[] = sorted.map(v => ({
    pattern: v.pattern, confidence: v.confidence, amount: v.amount, sentence: v.sentence,
    entry_id: v.evidence.entry_id, entry_date: v.evidence.entry_date,
    entry_kind: v.evidence.entry_kind, refusals: v.refusals.length ? v.refusals : undefined,
  }))

  const payload: AttributionPayload = {
    schema: ATTRIBUTION_SCHEMA,
    generated_at: input.generatedAt,
    source: input.source ?? 'loan-find-difference',
    headline: input.notEnoughHistory
      ? 'Not enough lender history on file to walk this loan.'
      : headlineFor(verdicts, allStored, counts, input.priorCloseDate),
    counts,
    verdicts,
    // v1 stored `skipped` wholesale — 400 entries was a 23KB payload, ~2x this module's
    // own size assertion, in a column rewritten every run. Bounded, and counted.
    skipped: skippedAll.slice(0, MAX_SKIPPED),
  }
  if (input.notEnoughHistory) payload.note = 'not_enough_history'
  return payload
}
