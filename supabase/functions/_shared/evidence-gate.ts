// _shared/evidence-gate.ts — a check may not print a variance it cannot justify,
// and a check that declines to run must say so out loud.
//
// ─── WHY (session 263 cont. 8, David) ───────────────────────────────────────
// David: "There's no need to show a 12,000 variance on Paypal if we know it will
// probably be resolved when the statements are uploaded. Instead, only ONCE
// everything is in (statements, loan agreement for new loans, amortization
// schedule for new loans), does the system do its calculations."
//
// He is describing a real cost. A variance measured against evidence we do not
// have yet is not a finding — it is a report about our own inbox, wearing a
// dollar sign. Print enough of those and the panel becomes something a
// bookkeeper scrolls past, which is this module's oldest and most expensive
// failure mode (see the close-date work in session 230, and the settlement-lag
// work in 242 — both are this same lesson in different costumes).
//
// ─── THE TWO RULES THAT MAKE A GATE SAFE ────────────────────────────────────
// A gate that merely hides things is worse than the noise it removes, because
// noise is visible and silence is not. So:
//
//   1. NOT CALCULATED IS A STATE, NOT A BLANK. Every check this module pauses
//      is named, on the loan, with the document that would start it. A loan
//      whose agreement never arrives must get LOUDER over time, not quieter.
//
//   2. THE GATE IS PER CHECK, NOT PER LOAN. "The screen's own balances add up"
//      needs one screenshot and is valid on its own; "does our balance match the
//      lender's" needs a lender document for the period. Gating the first
//      because the second is unsatisfiable throws away a free, correct answer.
//
// ─── WHAT THIS MODULE WILL NOT DO ───────────────────────────────────────────
// It never suppresses a check whose evidence IS present, and it never decides a
// variance is acceptable. "We expect this to close when the statement arrives"
// is a PREDICTION, and predictions belong in front of a human with the document
// named, not in a filter that quietly drops the row.
//
// PURE MODULE. No I/O. Callable from reconciliation-run, from loan-bundle, and
// from a test.

export type EvidenceKind =
  | 'lender_document'
  | 'contract_terms'
  | 'amortization_schedule'
  | 'book_balance'

export interface EvidenceKindState {
  have: boolean
  /** Newest date on file for this kind, or null. Used for coverage, not presence. */
  newest?: string | null
}

export type LoanEvidence = Record<EvidenceKind, EvidenceKindState>

export interface GateVerdict {
  ready: boolean
  missing: EvidenceKind[]
  /** Present and dated, but older than the period being reported on. */
  stale: EvidenceKind[]
}

/**
 * What each check actually consumes.
 *
 * A check that is NOT in this table is never gated. That direction is
 * deliberate: an unregistered check keeps running and may produce noise, which
 * somebody notices and fixes. The other direction — an unregistered check
 * silently gated — is a finding that disappears with nobody to miss it. Noise
 * is recoverable; silence is not.
 */
export const CHECK_NEEDS: Readonly<Record<string, readonly EvidenceKind[]>> = Object.freeze({
  balance_vs_lender: ['lender_document'],
  carrying_basis: ['contract_terms', 'book_balance'],
  derived_drift: ['book_balance'],
  lumped_payment: ['lender_document'],
})

/**
 * Checks whose missing document is ALREADY the subject of a dedicated, better
 * worded finding. The gate still pauses them; it just does not ask a second
 * time. Two rows asking for the same statement is the noise this module exists
 * to remove, arriving by a different door.
 */
export const ASK_OWNED_ELSEWHERE: Readonly<Record<EvidenceKind, string>> = Object.freeze({
  lender_document: 'stale_anchor',
  contract_terms: '',
  amortization_schedule: '',
  book_balance: '',
})

const KIND_LABEL: Record<EvidenceKind, string> = {
  lender_document: 'a lender statement covering the period',
  contract_terms: "the loan agreement's figures",
  amortization_schedule: 'an amortization schedule',
  book_balance: 'a balance rebuilt from your own ledger',
}

const KIND_ASK: Record<EvidenceKind, string> = {
  lender_document: 'Upload the lender statement for this period.',
  contract_terms: "Record the loan's figures — what was advanced and what is repayable in total.",
  amortization_schedule: 'Upload or generate this loan’s schedule.',
  book_balance: 'Run a reconciliation to rebuild this account from Xero.',
}

export function emptyEvidence(): LoanEvidence {
  return {
    lender_document: { have: false, newest: null },
    contract_terms: { have: false },
    amortization_schedule: { have: false },
    book_balance: { have: false, newest: null },
  }
}

/**
 * Is this check's evidence in?
 *
 * `coversFrom` is the FIRST DAY of the period being reported on, and a dated
 * document counts when it falls on or after it. That boundary is deliberate and
 * it is the one that took a second pass to get right.
 *
 * Using the period's END would have been wrong in the expensive direction: on an
 * August close it would reject PayPal 2's own 5 August statement as "stale" and
 * silently pause the balance check on a loan we have perfectly good evidence
 * for. A lender document dated inside the month is evidence FOR that month; it
 * simply speaks as at its own date, which is what the tie-out already records.
 *
 * What must still be rejected is a document from BEFORE the month — the
 * difference between "we checked August" and "we checked July and called it
 * August", which is the half of David's close-gate rule (session 262 cont. 3)
 * that nothing measured for a year.
 */
export function gateFor(checkKey: string, ev: LoanEvidence, coversFrom?: string | null): GateVerdict {
  const needs = CHECK_NEEDS[checkKey]
  if (!needs) return { ready: true, missing: [], stale: [] }

  const missing: EvidenceKind[] = []
  const stale: EvidenceKind[] = []

  for (const kind of needs) {
    const st = ev[kind]
    if (!st || !st.have) { missing.push(kind); continue }
    // Only kinds that carry a date can be stale. A kind with `newest`
    // undefined is a presence question, not a coverage one.
    if (coversFrom && st.newest !== undefined && st.newest !== null && st.newest < coversFrom) stale.push(kind)
  }

  return { ready: missing.length === 0 && stale.length === 0, missing, stale }
}

export interface WaitingFinding {
  fingerprint: string
  check_key: 'awaiting_evidence'
  severity: 'info' | 'warn'
  loan_account_id: string | null
  title: string
  plain_english: string
  detail: any
  proposed_action?: any
}

export interface GatedCheck {
  check_key: string
  verdict: GateVerdict
}

/**
 * The loud half. One row per loan, never one per paused check — a list of four
 * rows all saying "waiting on the August statement" is the same failure this
 * module removes.
 *
 * Returns null only when NOTHING is paused. A paused check with no row anywhere
 * is the state this module must never produce.
 */
export function awaitingEvidenceFinding(
  loan: { id: string; xero_account_code?: string | null; xero_account_name?: string | null },
  gated: GatedCheck[],
  opts: { periodClosed?: boolean; label?: string } = {},
): WaitingFinding | null {
  const paused = gated.filter(g => !g.verdict.ready)
  if (paused.length === 0) return null

  const kinds: EvidenceKind[] = []
  for (const g of paused) {
    for (const k of [...g.verdict.missing, ...g.verdict.stale]) {
      if (!kinds.includes(k)) kinds.push(k)
    }
  }

  // Do not ask twice for a document another check already asks for, in its own
  // words, with its own action attached.
  const toAsk = kinds.filter(k => !ASK_OWNED_ELSEWHERE[k])
  const name = opts.label || loan.xero_account_name || loan.xero_account_code || 'This loan'
  const checkList = paused.map(g => g.check_key).sort()

  const needList = kinds.map(k => KIND_LABEL[k])
  const needSentence = needList.length === 1
    ? needList[0]
    : `${needList.slice(0, -1).join(', ')} and ${needList[needList.length - 1]}`

  // Severity says whether this is BLOCKING something, not whether anything is
  // wrong. Nothing is wrong here — that is the point. But a month somebody is
  // trying to close, with evidence still outstanding, is not an FYI.
  const severity: 'info' | 'warn' = opts.periodClosed ? 'warn' : 'info'

  return {
    fingerprint: `awaiting_evidence:${loan.xero_account_code ?? loan.id}:${checkList.join(',')}`,
    check_key: 'awaiting_evidence',
    severity,
    loan_account_id: loan.id,
    title: `${name} — waiting on ${needSentence}`,
    plain_english:
      `${checkList.length === 1 ? 'One check on this loan is' : `${checkList.length} checks on this loan are`} ` +
      `not being calculated yet, because ${needSentence} ${needList.length === 1 ? 'is' : 'are'} not on file. ` +
      `Nothing here says the books are wrong — it says we cannot tell yet, and a figure produced without ` +
      `${needList.length === 1 ? 'it' : 'them'} would measure our own inbox rather than this loan. ` +
      (toAsk.length ? toAsk.map(k => KIND_ASK[k]).join(' ') + ' ' : '') +
      `The ${checkList.length === 1 ? 'check resumes' : 'checks resume'} on the next run once it is.`,
    detail: {
      code: loan.xero_account_code ?? null,
      paused_checks: checkList,
      missing: kinds,
      asked_here: toAsk,
      asked_elsewhere: kinds.filter(k => ASK_OWNED_ELSEWHERE[k]).map(k => ({ kind: k, check_key: ASK_OWNED_ELSEWHERE[k] })),
    },
    ...(toAsk.length === 1 && toAsk[0] === 'contract_terms'
      ? { proposed_action: { kind: 'record_contract_terms', note: KIND_ASK.contract_terms } }
      : {}),
  }
}
