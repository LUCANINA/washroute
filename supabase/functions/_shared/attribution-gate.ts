// _shared/attribution-gate.ts — THE GATE (session 259, hardened after adversarial review)
//
// WHY THIS EXISTS
// ---------------
// On 2026-09-01 three variance diagnoses were made in one day and three were wrong,
// all with the same shape: a figure that matched to the cent, and nobody had opened
// the journals.
//   * PCV — "August's interest was never split out." The opposite was true: the bank
//     transaction was ALREADY split at source and a journal split it again.
//   * E4-9744 — "$182.00 is April's interest ($181.99)." April is correct in Xero; the
//     defect is in MAY's split. One quantity matched, so "unique or refuse" would not
//     have saved it either.
//   * PayPal — "the balance was plugged to the lender's 08-05 figure." An arithmetic
//     identity, presented as a habit and as an intent.
//
// A person forgets to check both halves. A gate cannot. Rules A1-A4 of
// docs/bookkeeping/DESIGN-VARIANCE-ATTRIBUTION.md §0c, in executable form.
//
// THE v1 GATE WAS BROKEN AND THE REVIEW CAUGHT IT. Recorded here because the bugs are
// instructive and must not come back:
//   * `line_amount` corroboration never compared the account. ANY line of ANY account
//     whose magnitude matched cleared A2 — so a claim about PayPal's account 284 was
//     "corroborated" by a PCV transaction with no 284 line at all. The module's own
//     "discriminating" test passed that way.
//   * Both sides were absolutised, so a claim and its exact opposite both corroborated.
//     Direction was the entire defect on PCV; a sign-blind gate would have blessed it.
//   * A $0.00 claim auto-corroborated against any zero line.
//   * An unregistered habit pattern silently skipped A3 (default-allow).
//
// THE FIX, and the shape to keep: **the gate no longer matches an amount against
// anything. It re-derives the entry's effect on the loan account from the entry's own
// lines and checks the caller measured it correctly, signed.** A coincidence cannot
// survive that, because there is nothing left to coincide with.
//
// THE GATE ONLY EVER LOWERS CONFIDENCE. A bug here makes the product quieter.
//
// Pure: no I/O, no clock, no Xero. Unit-tested in attribution-gate.test.ts.

export type Confidence = 'confirmed' | 'probable' | 'unresolved'
const CONFIDENCES: Confidence[] = ['confirmed', 'probable', 'unresolved']

// ── THE BRAND (v3) ──────────────────────────────────────────────────────────
// v2 marked results with a `gated: true` PROPERTY. That is not a brand: any object
// literal carrying the key passed, and a real verdict laundered through
// JSON.parse(JSON.stringify(v)) kept it. A forged verdict reached storage with motive
// prose as the loan's headline and a $250,000 postable correction (audit 2026-09-01).
//
// Identity cannot be forged and does not survive serialisation, which is exactly the
// property wanted: a verdict that crossed a wire is NO LONGER GATED and must be
// re-gated in the process that consumes it. `gated: true` stays on the object only as
// a human-readable hint; `isGated()` is the check that counts.
const MINTED = new WeakSet<object>()
export function isGated(v: unknown): boolean {
  return typeof v === 'object' && v !== null && MINTED.has(v as object)
}

export type EntryLine = { account: string; amount: number }

export type LedgerEntry = {
  id: string
  date: string
  kind: 'BankTransaction' | 'ManualJournal'
  /**
   * Xero's own transaction type ('SPEND', 'RECEIVE', 'SPEND-OVERPAYMENT', ...).
   * REQUIRED for a BankTransaction, because the sign of its effect depends on it.
   * Absent => refusal, never a default: guessing the direction is the bug this
   * module exists to prevent.
   */
  /** The entry's own total, when it has one. Bounds what `expected` may claim. */
  total?: number | null
  txnType?: string | null
  /**
   * null/undefined = the line items were NOT READ (fatal under A2).
   * []             = read, and the entry genuinely has none.
   * Must be what Xero returned. Never synthesise this from a DB row.
   */
  lines?: EntryLine[] | null
  narration?: string | null
}

/** One other entry of the same shape, and whether it also satisfies the pattern. */
export type HabitEvidence = {
  /** How many same-shaped entries were EXAMINED. The denominator. */
  considered: number
  /** How many of them satisfy the pattern. */
  satisfied: number
  ids?: string[]
}

export type Claim = {
  pattern: string
  /** The confidence the caller believes it earned. The gate may only lower it. */
  proposed: Confidence
  /** The loan's Xero account code under examination. */
  code: string
  /**
   * What the caller says this entry DID to `code`, as a signed effect on the
   * outstanding balance, in the ledger's own convention:
   *   NEGATIVE = the balance falls   POSITIVE = the balance rises
   * (Same convention as reconciliation-run's `effect()` and loan-find-difference's
   * `effect_on_loan`.) The gate recomputes this from the entry's lines and refuses
   * if the caller got it wrong — including by sign.
   */
  movedOnAccount: number
  /** What the schedule or lender says should have happened, same convention. */
  expectedOnAccount: number
  entry?: LedgerEntry | null
  /** Required for habit patterns; see PATTERNS. */
  habit?: HabitEvidence
  sentence: string
  /** The span this claim is about. Without it two equal-sized findings are identical. */
  period?: { from: string; to: string } | null
  proposedCorrection?: { amount: number; description: string } | null
}

export type GateResult = {
  pattern: string
  confidence: Confidence
  /** Brand: only this module mints it. A hand-built verdict cannot claim to be gated. */
  readonly gated: true
  sentence: string
  /** The responsibility, DERIVED by the gate — never taken from the caller. */
  amount: number
  period: { from: string; to: string } | null
  refusals: string[]
  /** A4 lint hits. Non-empty = a BUG IN THE CALLER, not a data condition. */
  violations: string[]
  evidence: {
    entry_id: string | null
    entry_date: string | null
    entry_kind: string | null
    lines_read: boolean
    lines: EntryLine[] | null
    /** The effect the gate itself computed from the lines. */
    computed_effect: number | null
    moved_on_account: number
    expected_on_account: number
    habit: HabitEvidence | null
  }
  proposedCorrection: { amount: number; description: string } | null
}

// Integer cents throughout: `Math.abs(0.07-0.09) <= 0.02` is true while
// `Math.abs(0.30-0.32) <= 0.02` is false on doubles — the same nominal gap, opposite
// answers. Never compare money as floats.
const TOL_CENTS = 2
// Math.round is half-up, so +0.025 -> 3c while -0.025 -> -2c: the same nominal gap
// material in one direction and immaterial in the other. Round the magnitude, restore
// the sign. (Audit finding 13 — the very bug class the float comment above warns about.)
const toCents = (n: number) => (n < 0 ? -1 : 1) * Math.round(Math.abs(Number(n)) * 100)
const near = (a: number, b: number) => Math.abs(toCents(a) - toCents(b)) <= TOL_CENTS
// Sign-symmetric, like toCents: Math.round is half-up, so an unguarded r2 turns
// -0.025 into -0.02 and +0.025 into 0.03 — the same gap material one way only.
const r2 = (n: number) => ((n < 0 ? -1 : 1) * Math.round(Math.abs(Number(n)) * 100)) / 100

export const money = (n: number) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * The pattern registry. DEFAULT-DENY: a pattern not listed here is refused outright,
 * so adding a new plug-like verdict and forgetting to classify it fails loudly instead
 * of silently skipping A3 — which is exactly what the v1 Set-of-two allowed.
 */
export const PATTERNS: Record<string, { habit: boolean; label: string }> = {
  double_reallocation:      { habit: false, label: 'corrected twice' },
  unsplit_payment:          { habit: false, label: 'booked without splitting interest' },
  multi_month_interest:     { habit: false, label: 'one split carrying several months of interest' },
  missing_period:           { habit: false, label: 'a scheduled payment with no ledger entry' },
  extra_entry:              { habit: false, label: 'one entry accounts for the whole gap' },
  unexplained_span:         { habit: false, label: 'a gap no single entry accounts for' },
  plug_to_anchor:           { habit: true,  label: 'balance forced to a lender figure' },
  plug_to_wrong_date_anchor:{ habit: true,  label: 'balance forced to a lender figure dated elsewhere' },
}

// ── A4: the motive lint ─────────────────────────────────────────────────────
// Naming a person FACTUALLY is fine ("posted by Ramona"). What is banned is attributing
// INTENT, PURPOSE or NEGLIGENCE — the class of claim this module cannot evidence.
// A lint is a backstop, not a proof: it cannot catch every phrasing of motive. Prefer
// factualSentence(), which cannot express one.
const PERSONS = `(?:she|he|they|him|her|them|ramona|david|whoever|someone|somebody|the (?:cpa|accountant|bookkeeper|controller|preparer)|(?:the )?(?:previous|former|prior) \\w+|[A-Z][a-z]+)`
const INTENT = `(?:meant|intended|wanted|tried|decided|thought|believed|assumed|guessed|hoped|chose|was (?:reading|looking|trying))`
const NEGLECT = `(?:never (?:checked|noticed|looked|verified)|overlooked|neglected|failed to (?:notice|check|see)|forgot to \\w+|did not (?:realise|realize|notice|check|know)|was not aware|missed the)`
const MOTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  { re: new RegExp(`\\b${PERSONS}\\b[^.;]{0,80}?\\b${INTENT}\\b`, 'i'), why: 'attributes intent or state of mind to a person' },
  { re: new RegExp(`\\b${PERSONS}\\b[^.;]{0,80}?\\b${NEGLECT}\\b`, 'i'), why: 'attributes negligence to a person' },
  { re: new RegExp(`\\b${NEGLECT}\\b`, 'i'), why: 'states that someone failed to do something' },
  // Purpose, however phrased: "to make X agree", "so that X would tie", "in order to ...".
  { re: /\b(?:in order )?to (?:make|force|get|bring)\b[^.;]{0,50}?\b(?:match|agree|tie|equal|balance|reconcile|line up)\b/i, why: 'states a purpose behind an entry' },
  { re: /\bso (?:that )?\b[^.;]{0,50}?\bwould\b[^.;]{0,30}?\b(?:match|agree|tie|equal|balance|reconcile)\b/i, why: 'states a purpose behind an entry' },
  { re: /\b(?:the )?(?:intent|intention|purpose|aim|goal|motive)\b[^.;]{0,20}?\bwas\b/i, why: 'states an intent or purpose as fact' },
  { re: /\b(?:an )?attempt to\b/i, why: 'characterises an entry as an attempt' },
  { re: /\b(intended to|meant to|on purpose|deliberately|carelessly|by mistake)\b/i, why: 'states intent or negligence' },
  // "must have been/intended/known" — but NOT "must have an offsetting credit".
  { re: /\bmust have\s+(?:been|intended|wanted|thought|meant|known|realised|realized|assumed|noticed)\b/i, why: 'speculates about what someone must have done' },
  { re: /\b(?:appears|seems)\s+to\s+have\s+been\s+(?:an?\s+)?(?:attempt|effort|mistake|error|oversight)\b/i, why: 'speculates about motive' },
  { re: /\b(?:probably|presumably|apparently|evidently)\b[^.;]{0,40}?\b(?:wanted|meant|thought|intended|hoped|decided)\b/i, why: 'speculates about motive' },
]

export function lintMotive(text: string | null | undefined): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { re, why } of MOTIVE_PATTERNS) if (re.test(text) && !hits.includes(why)) hits.push(why)
  return hits
}

/** The A4-safe way to describe an entry: what it did, what was expected, the difference. */
export function factualSentence(o: {
  entryKind: 'BankTransaction' | 'ManualJournal'
  entryDate: string
  accountName: string
  moved: number
  expected: number
}): string {
  const kind = o.entryKind === 'ManualJournal' ? 'A journal' : 'A payment'
  const dir = (n: number) => n < 0 ? 'reduced' : n > 0 ? 'increased' : 'did not change'
  const diff = r2(o.moved - o.expected)
  return `${kind} dated ${o.entryDate} ${dir(o.moved)} ${o.accountName} by ${money(Math.abs(o.moved))}. `
    + `The schedule supports ${money(Math.abs(o.expected))} — a difference of ${money(Math.abs(diff))}.`
}

/**
 * Re-derive the entry's signed effect on `code` from its own lines.
 * SPEND pays a liability down; RECEIVE draws more. A ManualJournal's LineAmount is
 * already signed (debit +, credit −) and a debit to a liability reduces it. Same math
 * as reconciliation-run's effect() and loan-find-difference's effect_on_loan.
 */
export function computeEffect(entry: LedgerEntry, code: string): number | null {
  const lines = entry.lines
  if (!lines) return null
  const onCode = lines.filter(l => String(l.account) === String(code))
  if (!onCode.length) return null
  const net = onCode.reduce((s, l) => s + Number(l.amount ?? 0), 0)
  if (entry.kind === 'BankTransaction') {
    const t = String(entry.txnType ?? '')
    if (!t) return null                                   // direction unknown => refuse
    return r2(t.toUpperCase().startsWith('RECEIVE') ? net : -net)
  }
  return r2(-net)
}

const WEAKER = (c: Confidence): Confidence =>
  c === 'confirmed' ? 'probable' : 'unresolved'

export function gate(claim: Claim): GateResult {
  const refusals: string[] = []
  const entry = claim.entry ?? null

  // Runtime validation — TypeScript is erased at the edge-function boundary and this
  // may arrive as JSON. An unrecognised confidence is treated as no confidence.
  const proposed: Confidence = CONFIDENCES.includes(claim.proposed) ? claim.proposed : 'unresolved'
  if (!CONFIDENCES.includes(claim.proposed)) refusals.push('invalid_proposed_confidence')

  // Default-deny on the pattern registry.
  const spec = PATTERNS[claim.pattern]
  if (!spec) refusals.push('unregistered_pattern')

  const moved = Number(claim.movedOnAccount)
  const expected = Number(claim.expectedOnAccount)
  const amount = (Number.isFinite(moved) && Number.isFinite(expected)) ? r2(moved - expected) : NaN

  // Audit finding 7: `amount_not_finite` reads as "the numbers were garbage" when the
  // truth is usually "no expected figure is derivable for this entry's shape". Say which.
  if (!Number.isFinite(amount)) {
    refusals.push(Number.isFinite(moved) && !Number.isFinite(expected)
      ? 'expected_not_derivable' : 'amount_not_finite')
  }
  else if (Math.abs(toCents(amount)) <= TOL_CENTS) refusals.push('immaterial_claim')

  // ── A1 ── an amount is a coincidence until an entry carries it.
  if (!entry) refusals.push('no_attributed_entry')

  // ── A2 ── the entry's own lines, fetched, on THIS account, with the RIGHT SIGN.
  let computed: number | null = null
  if (entry) {
    if (entry.lines === null || entry.lines === undefined) {
      refusals.push('entry_lines_unread')
    } else if (!entry.lines.some(l => String(l.account) === String(claim.code))) {
      refusals.push('account_not_on_entry')
    } else if (entry.kind === 'BankTransaction' && !entry.txnType) {
      refusals.push('entry_direction_unknown')
    } else {
      computed = computeEffect(entry, claim.code)
      if (computed === null) refusals.push('effect_not_computable')
      else if (!near(computed, moved)) refusals.push('measurement_disagrees_with_entry')
    }
  }

  // ── A2b ── `expected` was never checked in v2, so a wrong expected became the whole
  // reported responsibility at full confidence. It cannot be verified against the entry
  // the way `moved` can — nothing in the ledger states what SHOULD have happened — but
  // it can be held to what is physically possible for the entry's own direction.
  if (entry && Number.isFinite(expected) && Number.isFinite(moved)) {
    const kind = entry.kind === 'BankTransaction' ? String(entry.txnType ?? '').toUpperCase() : null
    // A SPEND cannot be expected to RAISE a liability, and a RECEIVE cannot lower it.
    if (kind && kind.startsWith('SPEND') && toCents(expected) > TOL_CENTS) refusals.push('expected_wrong_direction')
    if (kind && kind.startsWith('RECEIVE') && toCents(expected) < -TOL_CENTS) refusals.push('expected_wrong_direction')
    // And no entry can be expected to move more than it is worth.
    const total = Number(entry.total)
    if (Number.isFinite(total) && total > 0 && Math.abs(toCents(expected)) > toCents(total) + TOL_CENTS) {
      refusals.push('expected_exceeds_entry_total')
    }
  }

  // ── A3 ── a habit must generalise, over a stated denominator.
  if (spec?.habit) {
    const h = claim.habit
    if (!h || !Number.isFinite(h.considered) || h.considered < 2) refusals.push('habit_untested')
    else if (h.satisfied < 2) refusals.push('habit_single_instance')
    else if (h.satisfied / h.considered < 0.5) refusals.push('habit_does_not_generalise')
  }

  // ── A4 ── never motive. Lint the sentence AND the correction description: a
  // correction people read is just as much a channel for a story as a sentence is.
  const violations = [
    ...lintMotive(claim.sentence),
    ...lintMotive(claim.proposedCorrection?.description),
  ].filter((v, i, a) => a.indexOf(v) === i)

  const refused = refusals.length > 0

  // A refused verdict must not assert the attribution it just refused. v1's fallback
  // said "A journal dated X accounts for $Y against account Z" even when the lines
  // were never read — fabricating, in prose, the corroboration the gate had denied.
  let sentence: string
  if (refused) {
    sentence = `${Number.isFinite(amount) ? money(Math.abs(amount)) : 'A difference'} on account `
      + `${claim.code} is not explained. (${refusals.join(', ')})`
  } else if (violations.length) {
    sentence = entry
      ? `A ${entry.kind === 'ManualJournal' ? 'journal' : 'payment'} dated ${entry.date} `
        + `accounts for ${money(Math.abs(amount))} against account ${claim.code}. `
        + `(The generated explanation was withheld: it ${violations[0]}.)`
      : `${money(Math.abs(amount))} against account ${claim.code}. `
        + `(The generated explanation was withheld: it ${violations[0]}.)`
  } else {
    sentence = claim.sentence
  }

  const confidence: Confidence = refused ? 'unresolved'
    : violations.length ? WEAKER(proposed)
    : proposed

  const result: GateResult = {
    pattern: refused ? `unresolved:${refusals[0]}` : claim.pattern,
    confidence,
    gated: true,
    sentence,
    amount: Number.isFinite(amount) ? amount : 0,
    period: claim.period ?? null,
    refusals,
    violations,
    evidence: {
      entry_id: entry?.id ?? null,
      entry_date: entry?.date ?? null,
      entry_kind: entry?.kind ?? null,
      lines_read: !!entry && entry.lines !== null && entry.lines !== undefined,
      lines: entry?.lines ?? null,
      computed_effect: computed,
      moved_on_account: Number.isFinite(moved) ? r2(moved) : 0,
      expected_on_account: Number.isFinite(expected) ? r2(expected) : 0,
      habit: claim.habit ?? null,
    },
    // A refused verdict never hands anyone something to post. A violation is a caller
    // bug, and a caller that fabricates motive does not get to ship a correction either.
    proposedCorrection: (refused || violations.length) ? null : (claim.proposedCorrection ?? null),
  }
  MINTED.add(result)
  return result
}
