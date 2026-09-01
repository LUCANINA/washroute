// _shared/attribution-from-walk.ts — the gate's first caller (session 259)
//
// Turns `loan-find-difference`'s analyze-mode response into GATED verdicts.
//
// WHY IT REBUILDS FROM STRUCTURED DATA, NOT FROM `conclusions`
// -----------------------------------------------------------
// `conclusions` is a prose array capped at FOUR and emitted in a fixed priority order,
// so a real span's finding can be silently dropped. Every conclusion except "no clear
// candidate" has a structured origin in `periods` / `proposal` / `cpa_exception`. So
// claims are built from those, and `conclusions` is used for wording only.
//
// WHAT IT REFUSES TO DO
// ---------------------
//  * It never feeds `proposal.journal.JournalLines` or
//    `cpa_exception.proposed_entry.JournalLines` to the gate. Those are OUR OWN
//    SUGGESTIONS, not ledger reality -- corroborating a claim with the fix we invented
//    for it is circular, and the field names differ (`LineAmount`/`AccountCode`)
//    precisely because they are a different kind of thing.
//  * It never infers a BankTransaction's direction from `effect_on_loan`. The walk
//    computed that field with the same `effect()` math the gate uses, so deriving the
//    type from it and then asking the gate to re-verify would be the gate checking its
//    own input against itself. See KNOWN GAP below.
//  * It never invents an `expected`. Every expected figure comes from a primary field
//    of the walk (`entry.total`, `diagnosis.owed`, `period.diff`), never from the
//    answer it is being used to check.
//
// KNOWN GAP, and it is deliberately left visible
// ----------------------------------------------
// `entryView()` in loan-find-difference (line ~408) does not surface Xero's transaction
// TYPE, although the record carries it (`rec.type`, set in normBT at line ~218) and
// `effect()` at line ~212 depends on it. Without it the gate cannot independently
// verify the direction of a BankTransaction, so every bank-transaction claim built here
// refuses with `entry_direction_unknown` until this one-line change lands:
//
//     src_type: rec.srcType, txn_type: rec.type ?? null, id: rec.srcId, ...
//
// That refusal is the system working. A verdict that cannot be checked should not ship,
// and this is exactly the class of "we did not actually look" that the gate exists for.
// ManualJournal claims are unaffected -- their sign is carried by the line amounts.

import { gate, type GateResult, type LedgerEntry, type Claim, factualSentence, money } from './attribution-gate.ts'

/** The subset of loan-find-difference's response this module reads. */
export type WalkEntryView = {
  src_type: 'BankTransaction' | 'ManualJournal'
  /** Xero's transaction type. NOT emitted by entryView today — see KNOWN GAP. */
  txn_type?: string | null
  id: string
  date: string
  total?: number | null
  effect_on_loan?: number | null
  lines?: Array<{ account_code: string; amount: number; description?: string | null }> | null
}

export type WalkResponse = {
  ok?: boolean
  verdict?: string
  loan?: { id: string; name: string | null; code: string }
  periods?: Array<{
    from: string; to: string; diff: number; verdict: 'clean' | 'divergent'
    timing_pair?: unknown
    explained_by_exception?: boolean
    culprit?: { kind: string; entry?: WalkEntryView | null; twin?: WalkEntryView | null; amount?: number }
  }>
  cpa_exception?: {
    period: { from: string; to: string }
    split_period?: string
    entry: WalkEntryView
    diagnosis?: { shape: string; at_source: number; owed: number; duplicated: number } | null
  } | null
}

export type Skipped = { from: string; to: string; reason: string }

export type WalkAttribution = {
  verdicts: GateResult[]
  skipped: Skipped[]
  /** Set when the response was the short-circuit shape and carries no analysis. */
  notEnoughHistory: boolean
}

/** Map the walk's line shape onto the gate's. `account_code` is authoritative. */
function toLedgerEntry(v: WalkEntryView): LedgerEntry {
  return {
    id: v.id,
    date: v.date,
    kind: v.src_type,
    // Absent today. Left undefined rather than guessed — the gate refuses on it.
    txnType: v.txn_type ?? undefined,
    lines: v.lines ? v.lines.map(l => ({ account: String(l.account_code), amount: Number(l.amount) })) : null,
  }
}

const r2 = (n: number) => Math.round(Number(n) * 100) / 100

export function attributionFromWalk(walk: WalkResponse): WalkAttribution {
  const verdicts: GateResult[] = []
  const skipped: Skipped[] = []

  // The short-circuit shape has no periods and no conclusions. Branch first.
  if (walk?.verdict === 'not_enough_history' || !walk?.periods) {
    return { verdicts: [], skipped: [], notEnoughHistory: true }
  }
  const code = walk.loan?.code
  if (!code) return { verdicts: [], skipped: [], notEnoughHistory: false }
  const name = walk.loan?.name || `account ${code}`

  // ── 1. The CPA exception: one entry carrying several months of interest ──
  const exc = walk.cpa_exception
  if (exc?.diagnosis && exc.entry) {
    const d = exc.diagnosis
    const entry = toLedgerEntry(exc.entry)
    const moved = Number(exc.entry.effect_on_loan)
    // EXPECTED from primary fields only: the payment total less what this period
    // genuinely owes in interest. Never from `duplicated`, which is the answer.
    const total = Number(exc.entry.total)
    const expected = (Number.isFinite(total) && Number.isFinite(d.owed) && exc.entry.src_type === 'BankTransaction')
      ? r2(-(total - d.owed))
      : NaN
    const claim: Claim = {
      pattern: 'multi_month_interest',
      proposed: d.shape === 'duplicated_reallocation' ? 'confirmed' : 'probable',
      code,
      movedOnAccount: Number.isFinite(moved) ? moved : NaN,
      expectedOnAccount: expected,
      entry,
      sentence: factualSentence({
        entryKind: entry.kind, entryDate: entry.date, accountName: name,
        moved: Number.isFinite(moved) ? moved : 0,
        expected: Number.isFinite(expected) ? expected : 0,
      }) + ` Its interest line of ${money(d.at_source)} covers more than the ${money(d.owed)} this period owes.`,
    }
    verdicts.push(gate(claim))
  }

  // ── 2. Spans ──
  for (const p of walk.periods) {
    if (p.verdict !== 'divergent') { skipped.push({ from: p.from, to: p.to, reason: 'clean' }); continue }
    if (p.timing_pair) { skipped.push({ from: p.from, to: p.to, reason: 'timing, not an error' }); continue }
    if (p.explained_by_exception) { skipped.push({ from: p.from, to: p.to, reason: 'covered by the exception above' }); continue }

    const kind = p.culprit?.kind
    const cEntry = p.culprit?.entry

    if ((kind === 'duplicate_suspected' || kind === 'extra_entry') && cEntry) {
      const entry = toLedgerEntry(cEntry)
      const moved = Number(cEntry.effect_on_loan)
      // The span's own measured gap is what this entry is held responsible for.
      const expected = Number.isFinite(moved) ? r2(moved - Number(p.diff)) : NaN
      verdicts.push(gate({
        pattern: kind === 'duplicate_suspected' ? 'double_reallocation' : 'extra_entry',
        proposed: 'probable',
        code,
        movedOnAccount: Number.isFinite(moved) ? moved : NaN,
        expectedOnAccount: expected,
        entry,
        sentence: factualSentence({
          entryKind: entry.kind, entryDate: entry.date, accountName: name,
          moved: Number.isFinite(moved) ? moved : 0, expected: Number.isFinite(expected) ? expected : 0,
        }) + ` It is the only entry between ${p.from} and ${p.to} whose effect equals the gap.`,
      }))
      continue
    }

    // No entry names this gap. The honest verdict is unresolved, and it is still a
    // deliverable: it states the arithmetic and says what was looked at.
    verdicts.push(gate({
      pattern: 'unexplained_span',
      proposed: 'probable',
      code,
      movedOnAccount: Number(p.diff),
      expectedOnAccount: 0,
      entry: null,
      sentence: `Between ${p.from} and ${p.to} the books moved ${money(Math.abs(Number(p.diff)))} `
        + `${Number(p.diff) > 0 ? 'less' : 'more'} than the lender did, and no single entry in that span accounts for it.`,
    }))
  }

  return { verdicts, skipped, notEnoughHistory: false }
}
