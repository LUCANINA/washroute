// _shared/gap-diagnosis.ts -- self-diagnosis for an unexplained balance_vs_lender
// residual, using data reconciliation-run already has loaded this run (session 253,
// item 13b).
//
// THE PROBLEM (David, on PCV Good and Green Loan): checkBalanceVsLender's fallback
// sentence -- "That remainder is either missing from Xero or recorded twice" -- is a
// coin-flip. The engine already knows the exact number ($1,802.58) and the exact
// transaction that moved it; it just never asked whether the amortization schedule's
// own interest/principal split for that same date explains it, or whether the loan
// already has an open finding about the same event. Funding Circle's root cause
// (a payment booked whole to principal, interest never split out) was exactly this
// shape, and nothing connected the two.
//
// WHAT THIS DOES NOT DO, ON PURPOSE (per David's "cheap check first" decision):
// it does NOT call Xero, and it does NOT run loan-find-difference's full historical
// walk. It only cross-references data already pulled this run -- the amortization
// schedule rows and the loan's other open findings -- which costs nothing extra and
// can never make reconciliation-run slower or risk a timeout. It also does not claim
// certainty: this is evidence a human should look at, not a verdict. Severity and the
// underlying numbers are untouched by this module; it only ever adds a sentence and a
// structured `self_diagnosis` detail field when a lead is found, and returns null
// (changing nothing) when it isn't -- the existing "either missing from Xero or
// recorded twice" wording stays exactly as it was for every gap this module can't
// explain.
//
// PRECEDENCE: schedule match before sibling match. A schedule match names an exact
// dollar figure a document already states; a sibling match only says "look at this
// OTHER finding too" -- weaker, so it only fires when nothing dollar-matches.

export type LaterEntry = { date: string; amount?: number | null }
export type AmortRow = { row_date: string; interest?: number | null; principal?: number | null }
export type SiblingFinding = { check_key: string; title: string; detail?: any }

export type GapDiagnosis =
  | { kind: 'schedule_interest'; date: string; scheduled_amount: number }
  | { kind: 'schedule_principal'; date: string; scheduled_amount: number }
  | { kind: 'sibling_finding'; date: string; check_key: string; title: string }

const TOLERANCE = 0.02 // same 2-cent tolerance computeTieOut already uses for "ties"

function siblingDate(f: SiblingFinding): string | null {
  const d = f.detail?.date ?? f.detail?.anchor_date ?? null
  return typeof d === 'string' ? d : null
}

export function diagnoseUnexplainedGap(
  residual: number,
  laterEntries: LaterEntry[],
  amortRows: AmortRow[],
  siblingFindings: SiblingFinding[],
): GapDiagnosis | null {
  const target = Math.abs(residual)
  if (!(target > 0) || !laterEntries.length) return null

  const laterDates = new Set(laterEntries.map(e => e.date))

  // ── 1. Does a scheduled interest or principal figure, for the SAME date a real
  // ledger entry moved the balance, match the residual to the cent? ──────────────
  // Only rows whose date is one of the actual later entries -- matching against
  // every row on the whole schedule would find coincidental matches on unrelated
  // periods and call that a diagnosis. The date has to be real, not just close.
  for (const row of amortRows) {
    if (!laterDates.has(row.row_date)) continue
    if (row.interest != null && Math.abs(Math.abs(Number(row.interest)) - target) < TOLERANCE) {
      return { kind: 'schedule_interest', date: row.row_date, scheduled_amount: Number(row.interest) }
    }
    if (row.principal != null && Math.abs(Math.abs(Number(row.principal)) - target) < TOLERANCE) {
      return { kind: 'schedule_principal', date: row.row_date, scheduled_amount: Number(row.principal) }
    }
  }

  // ── 2. Failing a dollar match, does the loan already have an OPEN finding dated
  // on one of the same later-entry dates? ─────────────────────────────────────────
  // Weaker evidence than a dollar match (it doesn't explain the number, just points
  // at a plausible shared cause), so it's the fallback, not the first check.
  for (const f of siblingFindings) {
    const d = siblingDate(f)
    if (d && laterDates.has(d)) {
      return { kind: 'sibling_finding', date: d, check_key: f.check_key, title: f.title }
    }
  }

  return null
}
