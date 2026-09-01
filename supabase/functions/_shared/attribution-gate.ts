// _shared/attribution-gate.ts — THE GATE (session 259)
//
// WHY THIS EXISTS
// ---------------
// On 2026-09-01 three variance diagnoses were made in one day and three were wrong,
// all with the same shape: a figure that matched to the cent, and nobody had opened
// the journals.
//
//   * PCV Good and Green — "August's interest was never split out." The opposite was
//     true: the bank transaction was ALREADY split at source and a second journal
//     split it again. Concluded from a DB row plus arithmetic.
//   * E-Transit E4-9744 — "$182.00 is April's interest ($181.99)." April's payment is
//     correct in Xero; the defect is in MAY's split. One quantity matched, so a
//     "unique or refuse" rule would not have saved it either.
//   * PayPal 2 — "the balance was plugged to the lender's 2026-08-05 figure." An
//     arithmetic identity, presented as a habit and as an intent. The same loan's June
//     journal matches no lender figure at all.
//
// A person forgets to check both halves. A gate cannot. So no verdict in this module's
// care may rise above `unresolved` until it has passed all four rules below — which are
// A1–A4 of DESIGN-VARIANCE-ATTRIBUTION.md §0c, in executable form.
//
//   A1  No decomposition without an attributed ENTRY.
//       An amount match is a coincidence until a specific ledger entry carries it.
//   A2  Every verdict cites the entry's OWN LINES, fetched — never inferred.
//       lines === null means "not read" and is fatal. It is NOT the same as [].
//   A3  A pattern that asserts a HABIT must generalise across the loan's other
//       same-shaped entries, or it is downgraded.
//   A4  The engine never states MOTIVE. What the entry did, what it should have been,
//       what the correction is. Never why, never whose intent.
//
// THE GATE ONLY EVER DOWNGRADES. It cannot make a weak claim strong; it can only
// refuse a strong one. That asymmetry is the whole point — a bug in this file makes
// the product quieter, never more confident.
//
// Pure: no I/O, no clock, no Xero. Unit-tested in attribution-gate.test.ts.

export type Confidence = 'confirmed' | 'probable' | 'unresolved'

export type EntryLine = { account: string; amount: number }

export type LedgerEntry = {
  id: string
  date: string
  kind: 'BankTransaction' | 'ManualJournal'
  /**
   * null  = the line items were NOT READ (fatal under A2)
   * []    = read, and the entry genuinely has no lines
   * Never synthesise this from a DB row. It must be what Xero returned.
   */
  lines: EntryLine[] | null
  narration?: string | null
}

export type Sibling = {
  id: string
  date: string
  /** Does this OTHER entry of the same shape also satisfy the pattern being claimed? */
  satisfiesPattern: boolean
}

export type Claim = {
  /** e.g. 'double_reallocation', 'unsplit_payment', 'plug_to_wrong_date_anchor' */
  pattern: string
  /** The confidence the caller believes it has earned. The gate may only lower it. */
  proposed: Confidence
  /** The dollar amount this verdict holds the entry responsible for. */
  amount: number
  /** The loan's Xero account code the claim is about. */
  code: string
  /** The entry the claim attributes the amount to. Absent => A1 refusal. */
  entry?: LedgerEntry | null
  /** Required for habit patterns (see HABIT_PATTERNS). */
  siblings?: Sibling[]
  sentence: string
  proposedCorrection?: { amount: number; description: string } | null
}

export type GateResult = {
  pattern: string
  confidence: Confidence
  sentence: string
  /** Machine-readable reasons the claim was downgraded. Empty => it passed. */
  refusals: string[]
  /** A4 lint hits. A non-empty list is a BUG IN THE CALLER, not a data condition. */
  violations: string[]
  evidence: {
    entry_id: string | null
    entry_date: string | null
    entry_kind: string | null
    lines_read: boolean
    lines: EntryLine[] | null
    corroboration: 'line_amount' | 'account_net' | null
  }
  proposedCorrection: { amount: number; description: string } | null
}

const TOLERANCE = 0.02 // the same 2-cent tie tolerance computeTieOut already uses
const cents = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(cents(a) - cents(b)) <= TOLERANCE

export const money = (n: number) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Patterns that assert a REPEATED BEHAVIOUR rather than a single event. These are the
 * ones A3 governs: claiming somebody "plugs the balance" is a claim about a practice,
 * and one instance can never establish a practice. Single-event patterns
 * (double_reallocation, unsplit_payment, ...) are exempt — they describe one entry and
 * make no claim beyond it.
 */
export const HABIT_PATTERNS = new Set([
  'plug_to_anchor',
  'plug_to_wrong_date_anchor',
])

// ── A4: the motive lint ─────────────────────────────────────────────────────
//
// Naming a person FACTUALLY is fine and often necessary ("the CPA's own split",
// "posted by Ramona"). What is banned is attributing INTENT, STATE OF MIND or
// CARELESSNESS to anyone — that is the class of claim this module cannot evidence and
// got wrong on PayPal. Each rule therefore needs an intent verb, not just a name.
const MOTIVE_PATTERNS: { re: RegExp; why: string }[] = [
  {
    re: /\b(she|he|they|ramona|david|the cpa|the accountant|the bookkeeper)\b[^.;]{0,60}?\b(meant|intended|wanted|tried|decided|thought|believed|assumed|was reading|was looking|plugged|forced|guessed)\b/i,
    why: 'attributes intent or state of mind to a person',
  },
  { re: /\b(?:in order )?to (?:make|force) the (?:books|balance|account) (?:match|agree|tie)\b/i, why: 'states a purpose behind an entry' },
  { re: /\b(intended to|meant to|on purpose|deliberately|by mistake|carelessly|forgot to|failed to notice|did not realise|did not realize)\b/i, why: 'states intent or negligence' },
  { re: /\bmust have\b/i, why: 'speculates about what someone must have done' },
  { re: /\b(?:probably|presumably|apparently|evidently)\b[^.;]{0,40}?\b(?:wanted|meant|thought|intended|was)\b/i, why: 'speculates about motive' },
]

export function lintMotive(sentence: string): string[] {
  const hits: string[] = []
  for (const { re, why } of MOTIVE_PATTERNS) if (re.test(sentence)) hits.push(why)
  return hits
}

/**
 * The A4-safe way to describe an entry: what it did, what was expected, and the
 * difference. Never why. Use this instead of hand-writing a sentence wherever possible.
 */
export function factualSentence(o: {
  entryKind: 'BankTransaction' | 'ManualJournal'
  entryDate: string
  accountName: string
  moved: number
  expected: number
}): string {
  const kind = o.entryKind === 'ManualJournal' ? 'A journal' : 'A payment'
  const diff = cents(o.moved - o.expected)
  return `${kind} dated ${o.entryDate} moved ${money(o.moved)} against ${o.accountName}. `
    + `The schedule supports ${money(o.expected)} for this period — a difference of ${money(Math.abs(diff))}.`
}

/** Does the entry's own line detail actually carry the amount being claimed? */
function corroborate(entry: LedgerEntry, amount: number, code: string):
  'line_amount' | 'account_net' | null {
  const lines = entry.lines
  if (!lines) return null
  const target = Math.abs(cents(amount))
  for (const l of lines) if (near(Math.abs(Number(l.amount || 0)), target)) return 'line_amount'
  const net = lines
    .filter(l => String(l.account) === String(code))
    .reduce((t, l) => t + Number(l.amount || 0), 0)
  if (lines.some(l => String(l.account) === String(code)) && near(Math.abs(net), target)) return 'account_net'
  return null
}

const WEAKER: Record<Confidence, Confidence> = {
  confirmed: 'probable',
  probable: 'unresolved',
  unresolved: 'unresolved',
}

export function gate(claim: Claim): GateResult {
  const refusals: string[] = []
  const entry = claim.entry ?? null

  // ── A1 ── an amount match is a coincidence until an entry carries it.
  if (!entry) refusals.push('no_attributed_entry')

  // ── A2 ── the entry's own lines, fetched. null means NOT READ and is fatal.
  let corroboration: 'line_amount' | 'account_net' | null = null
  if (entry) {
    if (entry.lines === null) {
      refusals.push('entry_lines_unread')
    } else {
      corroboration = corroborate(entry, claim.amount, claim.code)
      if (!corroboration) refusals.push('amount_not_in_entry')
    }
  }

  // ── A3 ── a habit must generalise.
  if (HABIT_PATTERNS.has(claim.pattern)) {
    const sibs = claim.siblings
    if (!sibs || sibs.length === 0) refusals.push('habit_untested')
    else if (!sibs.some(s => s.satisfiesPattern)) refusals.push('habit_does_not_generalise')
  }

  // ── A4 ── never motive. A hit here is a caller bug, so it is reported separately
  // from `refusals` AND the offending sentence is replaced rather than shipped.
  const violations = lintMotive(claim.sentence)
  const sentence = violations.length
    ? (entry
        ? `A ${entry.kind === 'ManualJournal' ? 'journal' : 'payment'} dated ${entry.date} `
          + `accounts for ${money(Math.abs(claim.amount))} against account ${claim.code}. `
          + `(The generated explanation was withheld: it ${violations[0]}.)`
        : `${money(Math.abs(claim.amount))} against account ${claim.code} is not explained. `
          + `(The generated explanation was withheld: it ${violations[0]}.)`)
    : claim.sentence

  // The gate only ever LOWERS confidence.
  let confidence: Confidence = claim.proposed
  if (refusals.length) confidence = 'unresolved'
  else if (violations.length) confidence = WEAKER[claim.proposed]

  return {
    pattern: refusals.length ? `unresolved:${refusals[0]}` : claim.pattern,
    confidence,
    sentence,
    refusals,
    violations,
    evidence: {
      entry_id: entry?.id ?? null,
      entry_date: entry?.date ?? null,
      entry_kind: entry?.kind ?? null,
      lines_read: !!entry && entry.lines !== null,
      lines: entry?.lines ?? null,
      corroboration,
    },
    // A refused verdict must never hand anyone a correction to post.
    proposedCorrection: refusals.length ? null : (claim.proposedCorrection ?? null),
  }
}
