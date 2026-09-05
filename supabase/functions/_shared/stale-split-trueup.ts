// ═══════════════════════════════════════════════════════════════════════════
// stale-split-trueup.ts — THE BOOKS BOOKED LAST PERIOD'S SPLIT (session 275)
// ═══════════════════════════════════════════════════════════════════════════
// One calculation, two callers, per START HERE §0k: the one-time journal that
// clears the accumulated backlog and the recurring true-up that runs when a new
// statement lands are THE SAME SUM — the lender's stated principal move for a
// period, less what Xero actually moved, corrected between the loan account and
// Interest Expense. Written once here so the two can never drift apart, the same
// reason staging-next.ts owns "which period stages next".
//
// ── WHY THIS IS A PROPOSAL AND NOT A WITCH HUNT ────────────────────────────
// David, session 272: "what should be a straightforward 'here's a suggested
// adjustment' becomes a 12 month witchhunt." Booking a difference to make the
// books agree HIDES the reason instead of finding it, and the close band says so
// in as many words on rows it deliberately refuses to offer a button for.
//
// So this does not fire on a difference. It fires on a SIGNATURE, and the
// signature is falsifiable: **Xero's movement equals the PREVIOUS period's lender
// figure to the cent, and does not equal this period's.** That is the fingerprint
// of a split taken from a statement one period stale, and it is not something an
// ordinary error produces — a mis-keyed amount, a missing payment, a duplicate or
// a fee lands nowhere near the previous period's principal to the cent.
//
// Measured on Funding Circle, 2026-09-05 (the loan this was written for):
//
//     period   Xero moved   prev lender   this lender   verdict
//     2026-07    1,010.57      1,010.57      1,025.71    stale → correct 15.14
//     2026-08    1,025.71      1,025.71      1,041.09    stale → correct 15.38
//
// Both halves are load-bearing and the second is the one that makes it a test.
// Without "does not equal this period's", a loan whose books are RIGHT and whose
// principal happens to be flat month to month would match on the first half alone
// and be offered a $0.00 correction for ever. Requiring the mismatch means a loan
// that is correct produces no signature and therefore no button — which is the
// behaviour that matters, because the cost of a false proposal here is a wrong
// journal in a real ledger.
//
// ── AND THE CAUSE IS NOT THE ONE §0e AND §0k RECORDED ──────────────────────
// Both blamed the statement arriving a month late. The real cause is that
// derive-schedule anchored its projection on the wrong statement (session 275;
// see selectAnchorEvidence). That fix stops the drift RECURRING. It moves not one
// cent of what is already misposted, because re-anchoring changes what we book
// NEXT and never touches a journal already in Xero. This module is the other
// half, and shipping either alone leaves the job half done.
//
// Pure: no Supabase, no Xero, no Deno.env. Everything it needs is passed in.

export const r2 = (n: number) => Math.round(n * 100) / 100

/** Default materiality. A cent or two of rounding is not a correction. */
export const TRUEUP_TOL = 0.02

export type PeriodMovement = {
  /** The label the split carries, e.g. '2026-08'. */
  period_label: string
  /** Reduction the LENDER's own two balances state for this period, positive. */
  lender_principal: number
  /** Reduction XERO actually made on the loan account in this period, positive. */
  xero_principal: number
  /** Our own split's principal for this period, when one exists. Corroboration
   *  only — never the sole evidence, because it is our record, not the lender's. */
  booked_principal?: number | null
  /** True when this period sits inside books the CPA has closed. */
  closed?: boolean
}

export type TrueUp = {
  period_label: string
  /** What to move, positive, between the loan account and Interest Expense. */
  amount: number
  /** 'interest_back_to_loan' — Xero under-reduced the loan, so DR loan / CR 800.
   *  'interest_out_of_loan' — the mirror image. Same vocabulary as
   *  loan-find-difference's existing proposal so one journal builder serves both. */
  direction: 'interest_back_to_loan' | 'interest_out_of_loan'
  lender_principal: number
  xero_principal: number
  matched_period_label: string
  booked_principal: number | null
  /** Did our own split agree with what Xero did? Two independent routes to the
   *  same figure is the difference between a measurement and a coincidence. */
  corroborated_by_split: boolean
  closed: boolean
}

export type TrueUpResult = {
  /** Periods whose cause is ESTABLISHED and which sit in open books. */
  correctable: TrueUp[]
  /** Established, but inside closed books — stated, never proposed. The CPA
   *  settled those months (session 230); chasing them is the witch hunt. */
  closed_periods: TrueUp[]
  /** Total of `correctable`, signed by direction (positive = back to the loan). */
  total: number
  /** Why nothing was proposed, in words a person can act on. Never null when
   *  `correctable` is empty, because a silent refusal and a feature that did not
   *  run look identical on screen — which is what hid this for 274 sessions. */
  refusal: string | null
}

/**
 * Walk consecutive periods and find the ones whose books carry the PREVIOUS
 * period's principal split.
 *
 * `periods` must be in ascending period order and consecutive. A gap in the
 * sequence is not an error — it simply means the pair either side of the gap is
 * not evidence of anything, and it is skipped rather than compared across it.
 */
export function findStaleSplits(periods: PeriodMovement[], tol = TRUEUP_TOL): TrueUpResult {
  const rows = (periods || []).filter(p => p && p.period_label != null)
  if (rows.length < 2) {
    return {
      correctable: [], closed_periods: [], total: 0,
      refusal: `Two consecutive periods of lender figures are needed to tell a stale split from an ordinary difference; ${rows.length} ${rows.length === 1 ? 'is' : 'are'} on file.`,
    }
  }

  const correctable: TrueUp[] = []
  const closed_periods: TrueUp[] = []
  let examined = 0, matchedPrev = 0, alreadyRight = 0

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i]
    if (![prev.lender_principal, cur.lender_principal, cur.xero_principal].every(Number.isFinite)) continue
    examined++

    const gap = r2(cur.lender_principal - cur.xero_principal)
    if (Math.abs(gap) < tol) { alreadyRight++; continue }

    // THE SIGNATURE. Both halves required — see the header.
    const looksLikePrevious = Math.abs(r2(cur.xero_principal - prev.lender_principal)) < tol
    if (!looksLikePrevious) continue
    matchedPrev++

    const booked = Number.isFinite(Number(cur.booked_principal)) ? Number(cur.booked_principal) : null
    const row: TrueUp = {
      period_label: cur.period_label,
      amount: Math.abs(gap),
      // gap > 0: the lender reduced MORE than Xero did, so the loan account is
      // carrying too much and interest was over-expensed. Debit the loan, credit
      // Interest Expense — 'interest_back_to_loan' in the existing vocabulary.
      direction: gap > 0 ? 'interest_back_to_loan' : 'interest_out_of_loan',
      lender_principal: r2(cur.lender_principal),
      xero_principal: r2(cur.xero_principal),
      matched_period_label: prev.period_label,
      booked_principal: booked === null ? null : r2(booked),
      corroborated_by_split: booked !== null && Math.abs(r2(booked - cur.xero_principal)) < tol,
      closed: !!cur.closed,
    }
    ;(row.closed ? closed_periods : correctable).push(row)
  }

  const total = r2(correctable.reduce((s, r) => s + (r.direction === 'interest_back_to_loan' ? r.amount : -r.amount), 0))

  let refusal: string | null = null
  if (!correctable.length) {
    // Name the reason and what would change it. A row that cannot say WHY it has
    // no button cannot be told apart from a feature that failed to run.
    if (closed_periods.length) {
      refusal = `${closed_periods.length} period${closed_periods.length === 1 ? '' : 's'} carry the previous period's split, but ${closed_periods.length === 1 ? 'it sits' : 'they sit'} inside books your accountant has closed (${closed_periods.map(r => r.period_label).join(', ')}). Those months were settled at close; nothing is proposed for them.`
    } else if (!examined) {
      refusal = 'No pair of consecutive periods has both a lender figure and a measured Xero movement, so there is nothing to compare.'
    } else if (alreadyRight === examined) {
      refusal = `All ${examined} periods agree with the lender's own figures. Nothing to correct.`
    } else if (!matchedPrev) {
      refusal = `The difference here is not a stale split: Xero's movement does not match the previous period's lender figure in any of the ${examined} periods checked, so the cause is something else and no correction can be prepared mechanically. This one needs judgement.`
    }
  }
  return { correctable, closed_periods, total, refusal }
}

/**
 * The correcting journal, in the shape loan-find-difference's post_fix already
 * posts. Deliberately NOT a new write path: it hands back lines for the existing
 * approval → token → server-side re-verify → close-date → duplicate-check
 * machinery to carry. §0k: "Do not invent a new write path to Xero."
 *
 * LineAmount positive = DEBIT in Xero. The loan account is a liability, so
 * debiting it REDUCES the balance — which is what 'interest_back_to_loan' must do.
 */
export function trueUpJournalLines(o: {
  amount: number
  direction: TrueUp['direction']
  loanAccountCode: string
  interestAccountCode: string
  loanName: string
}) {
  const amt = r2(Math.abs(o.amount))
  return o.direction === 'interest_back_to_loan'
    ? [
      { LineAmount: amt, AccountCode: o.loanAccountCode, Description: `${o.loanName} principal correction`, TaxType: 'NONE' },
      { LineAmount: -amt, AccountCode: o.interestAccountCode, Description: 'Interest correction', TaxType: 'NONE' },
    ]
    : [
      { LineAmount: -amt, AccountCode: o.loanAccountCode, Description: `${o.loanName} principal correction`, TaxType: 'NONE' },
      { LineAmount: amt, AccountCode: o.interestAccountCode, Description: 'Interest', TaxType: 'NONE' },
    ]
}

/**
 * The card a person reads before approving, inside the 40-word budget the design
 * rules set for an action card (session 263). Three things in order: what gets
 * written, the one check that would have failed if it were wrong, and — only when
 * it changes the answer — what would change it. Everything else goes in `working`.
 */
export function trueUpCard(rows: TrueUp[], loanName: string): { plain_english: string, working: string } {
  const money = (n: number) => `$${Math.abs(n).toFixed(2)}`
  const total = r2(rows.reduce((s, r) => s + (r.direction === 'interest_back_to_loan' ? r.amount : -r.amount), 0))
  const periods = rows.map(r => r.period_label).join(' and ')
  const plain_english = rows.length === 1
    ? `Moves ${money(total)} from Interest Expense back to ${loanName} for ${periods}. The lender's statement says ${money(rows[0].lender_principal)} of principal; Xero moved ${money(rows[0].xero_principal)} — last period's figure, to the cent.`
    : `Moves ${money(total)} from Interest Expense back to ${loanName} across ${periods}. Each month Xero moved the PREVIOUS period's principal, to the cent.`
  const working = rows.map(r => [
    `${r.period_label}: lender ${money(r.lender_principal)} · Xero ${money(r.xero_principal)} · difference ${money(r.amount)}`,
    `  Xero's movement equals ${r.matched_period_label}'s lender figure exactly, which is the signature of a split taken one period stale.`,
    r.booked_principal === null
      ? `  No split on file for this period, so the figure rests on Xero and the lender alone.`
      : r.corroborated_by_split
        ? `  Our own split records ${money(r.booked_principal)}, agreeing with Xero independently.`
        : `  ⚠ Our split records ${money(r.booked_principal)}, which does NOT agree with what Xero moved — check that before approving.`,
  ].join('\n')).join('\n\n')
  return { plain_english, working }
}
