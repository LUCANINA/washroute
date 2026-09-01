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
// WHAT THE FIRST LIVE RUN CHANGED (session 259 cont. 9)
// -----------------------------------------------------
// Run over all 14 active loans' real walk output, two false-positive classes appeared
// that no unit fixture had shown:
//
//  1. `extra_entry` accused ENTRIES WE OURSELVES HAVE ON FILE. PayPal 2's seven
//     month-end `-adj` journals each land as a culprit whose effect equals its span's
//     gap -- which is true, and yet every one is already recorded in `loan_splits` as
//     `already_in_xero` precisely so our close matches Xero. Calling them "extra" would
//     have put eight confident accusations in front of the CPA about entries the
//     product had itself filed. So the adapter now takes `recordedEntryIds` and SKIPS
//     any culprit already linked to one of our splits. Note the direction: an app-written
//     link is used only to SUPPRESS an accusation, never to enable one -- the mistake
//     `checkDoubleReallocation` makes in reverse (session 259 cont. 5).
//
//  2. A `no_duplication` diagnosis is NOT a finding. PCV's exception reports
//     `duplicated: 0` -- the entry was examined and found sound. Building a claim from
//     it produced an `immaterial_claim` refusal, which is the right outcome by accident;
//     it is now skipped explicitly, because relying on the arithmetic to come out at
//     zero is not the same as deciding not to accuse.
//
// A LIMIT WORTH KNOWING: the walk's spans run between LENDER ANCHORS, so anything after
// the last statement on file is outside every span. PCV's real August defect (a payment
// on 08-03 and a journal on 08-31, against a last anchor of 08-01) is therefore invisible
// here. The open month is `reconciliation-run`'s territory (`net_after_anchor`,
// `later_entry_dates`), not the walk's. Do not expect this module to see it.
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

export type Skipped = { from: string; to: string; reason: string; entryId?: string }

export type WalkOptions = {
  /**
   * Xero entry id -> the PRINCIPAL amount our own split records against it. A culprit is
   * suppressed only when the recorded amount agrees with what the entry actually moved;
   * an entry we have on file at a DIFFERENT amount is precisely the PCV shape and is
   * still reported. Build it with `recordedEntryAmounts()` in attribution-store.ts.
   */
  recordedEntryIds?: Map<string, number>
}

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
    total: v.total ?? null,
    // Absent today. Left undefined rather than guessed — the gate refuses on it.
    txnType: v.txn_type ?? undefined,
    lines: v.lines ? v.lines.map(l => ({ account: String(l.account_code), amount: Number(l.amount) })) : null,
  }
}

// Sign-symmetric, like toCents: Math.round is half-up, so an unguarded r2 turns
// -0.025 into -0.02 and +0.025 into 0.03 — the same gap material one way only.
const INTEREST_CODE = '800'

const r2 = (n: number) => ((n < 0 ? -1 : 1) * Math.round(Math.abs(Number(n)) * 100)) / 100

export function attributionFromWalk(walk: WalkResponse, opts: WalkOptions = {}): WalkAttribution {
  const recorded: Map<string, number> = opts.recordedEntryIds ?? new Map()
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
  // `no_duplication` means the entry was examined and found sound. That is not a
  // finding, and deciding not to accuse is different from an accusation that happens
  // to arithmetic out at zero.
  if (exc?.diagnosis && exc.entry && exc.diagnosis.shape !== 'no_duplication') {
    const d = exc.diagnosis
    const entry = toLedgerEntry(exc.entry)
    const moved = Number(exc.entry.effect_on_loan)
    // EXPECTED from primary fields only: the payment total less what this period
    // genuinely owes in interest. Never from `duplicated`, which is the answer.
    const total = Number(exc.entry.total)
    // `-(total - owed)` assumes the payment is exactly [loan line, interest line]. Add a
    // third line — a bank fee, say — and that fee is reported as duplicated interest
    // ($181.97 became $231.97 with a $50 fee, at `confirmed`). So the shape is CHECKED:
    // the lines must sum to the total, or no expected is derivable and the gate refuses.
    // The guard has to be the SHAPE, not the sum: a fee line is inside `total` too, so
    // "lines add up to the total" is satisfied by exactly the case it was meant to
    // reject. `-(total - owed)` is only principal if the payment is precisely
    // [loan account, interest] and nothing else.
    const lines = exc.entry.lines ?? null
    const onLoan = (lines ?? []).filter(l => String(l.account_code) === String(code))
    const onInterest = (lines ?? []).filter(l => String(l.account_code) === INTEREST_CODE)
    const shapeOk = lines != null && lines.length === 2
      && onLoan.length === 1 && onInterest.length === 1
    const expected = (Number.isFinite(total) && Number.isFinite(d.owed)
                      && exc.entry.src_type === 'BankTransaction' && shapeOk)
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
      }) + (d.at_source > d.owed
        // Only stated when it is true. v2 appended it unconditionally, producing
        // "$0.00 covers more than the $500.00 this period owes" at `confirmed`.
        ? ` Its interest line of ${money(d.at_source)} covers more than the ${money(d.owed)} this period owes.`
        : ''),
      period: { from: exc.period.from, to: exc.period.to },
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
      // An entry we have on file is recorded, not extra — but "we matched this
      // transaction to a split" is evidence we SAW it, not that its effect is right.
      // PCV's defect was an entry that was both on file AND wrong. So suppression now
      // requires the recorded amount to MATCH what the entry actually moved; a
      // disagreement is the interesting case and must still be reported.
      const rec = recorded.get(String(cEntry.id))
      if (rec !== undefined && Math.abs(r2(rec) - Math.abs(r2(Number(cEntry.effect_on_loan)))) <= 0.02) {
        skipped.push({ from: p.from, to: p.to, entryId: cEntry.id,
          reason: 'already recorded in our own splits, at the same amount' })
        continue
      }
      const entry = toLedgerEntry(cEntry)
      const moved = Number(cEntry.effect_on_loan)
      // v2 set `expected = moved - p.diff`, which made the "derived" amount identical to
      // the walk's own diff BY CONSTRUCTION, and then asserted "the only entry whose
      // effect equals the gap" without ever comparing them. Both are fixed here:
      //   * an entry the walk calls EXTRA should not have been there at all, so the
      //     expected effect is ZERO — a real quantity, not a rearrangement;
      //   * the equality the sentence claims is TESTED, and the claim is dropped when
      //     it does not hold, which also stops a mismatched culprit shipping as probable.
      const equalsGap = Number.isFinite(moved) && Math.abs(r2(moved) - r2(Number(p.diff))) <= 0.02
      if (!equalsGap) {
        skipped.push({ from: p.from, to: p.to, entryId: cEntry.id,
          reason: `the culprit's effect (${money(moved)}) does not equal the span's gap (${money(Number(p.diff))})` })
        continue
      }
      verdicts.push(gate({
        pattern: kind === 'duplicate_suspected' ? 'double_reallocation' : 'extra_entry',
        proposed: 'probable',
        code,
        movedOnAccount: moved,
        expectedOnAccount: 0,
        entry,
        period: { from: p.from, to: p.to },
        sentence: factualSentence({
          entryKind: entry.kind, entryDate: entry.date, accountName: name,
          moved, expected: 0,
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
