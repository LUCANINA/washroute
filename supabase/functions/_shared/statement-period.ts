// ═══════════════════════════════════════════════════════════════════════════
// statement-period.ts — WHAT DATE IS A STATEMENT'S BALANCE ACTUALLY AS OF?
// (session 273 cont., found by David asking "how do we resolve Funding Circle?")
// ═══════════════════════════════════════════════════════════════════════════
// The walk subtracts one statement's balance from the next and compares that
// against Xero's movement BETWEEN THE SAME TWO DATES. That is only valid if the
// date on a statement is the date its balance was true. On Funding Circle it is
// not: every statement is issued on the 18th of the FOLLOWING month and we file
// it under the 1st of the period it covers. Ten statements, no exceptions:
//
//     our statement_date   filename says issued   balance
//     2026-06-01           2026-07-18             67,240.74
//     2026-07-01           2026-08-18             66,215.03
//     2026-08-01           (manual)               65,173.94
//
// So the row we call "2026-07-01" carries the balance AFTER July's payment --
// the JULY MONTH-END figure. The walk was pairing each lender period against
// the wrong Xero month and reporting ~$30/month of divergence on a loan whose
// real drift is ~$15/month. Aligned properly, Funding Circle foots to the cent:
// 29.64 (closed books) + 15.14 (Jul) + 15.38 (Aug) = 60.16.
//
// ── WHY THIS IS A PER-LOAN FLAG AND NOT A CLEVER GUESS ────────────────────
// Most lenders here date a statement with its balance date -- the Ford E-Transit
// statements (2026-08-23) mean exactly what they say. Shifting every loan's
// dates to month-end would corrupt those, and this module's standing rule is
// that a false ask is worse than a missing one. So the basis is RECORDED on the
// loan by a human who looked at a PDF, defaults to today's behaviour, and is
// never inferred at runtime.
//
// `looksPeriodLabelled` exists to RAISE THE QUESTION, never to answer it: it
// reports a suspicion for a human to check against one PDF. It deliberately
// does not consult Xero -- picking whichever alignment agrees with the books
// would be shopping for the answer, which is the thing this whole engine exists
// to stop.

// ── THE THIRD BASIS: A DUE DATE IS NOT A BALANCE DATE (session 284) ───────
// SBA COVID-EIDL issues a statement about three weeks AHEAD of the payment and
// dates it to the DUE date. The 09/25/2026 document prints its own evidence --
// Last Payment Date 08/24/2026, Applied to Principal $0.00, Outstanding Balance
// $960,005.00 -- so the balance is true on 08/24 and the row says 09/25.
//
// 'due_date' therefore RE-DATES NOTHING BY ARITHMETIC. The tempting version
// subtracts a month, or walks back to the previous month end, and that is a
// derived quantity of exactly the kind sessions 245-247 were spent deleting: it
// happens to be right for a lender whose payment falls on the 25th and is wrong
// for one whose payment falls on the 5th, and nothing on screen would say which
// you had. A DATE IS MEASURED OR ASKED FOR, NEVER INFERRED (session 245).
//
// So the basis does the one honest thing instead: it says the filed date is not
// a balance date, and a row on such a loan may anchor a balance ONLY when the
// document's own date was captured into loan_statements.balance_as_of. Without
// it the row is REFUSED as an anchor -- it keeps its document and stays as
// evidence for its own period, exactly like anchor_exclusion_reason (s282), and
// the reader is asked for the date rather than told a wrong one.
//
// It costs nothing today and that is the reason to do it now: EIDL's principal
// is not moving ($0.00 applied, same balance on both statements), so a misdated
// balance is right on every date. The day it starts amortizing it is a month out
// on the largest loan on the book, silently.

export type StatementDateBasis = 'balance_date' | 'period_start' | 'due_date'

export const STATEMENT_DATE_BASES: StatementDateBasis[] = ['balance_date', 'period_start', 'due_date']

export function normalizeBasis(v: unknown): StatementDateBasis {
  return v === 'period_start' ? 'period_start' : v === 'due_date' ? 'due_date' : 'balance_date'
}

/** A bare YYYY-MM-DD, or null. Anything else is not a measurement. */
export function measuredDate(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

/** Last calendar day of the month containing `iso` (YYYY-MM-DD in, YYYY-MM-DD out). */
export function endOfMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso || ''))
  if (!m) return String(iso || '')
  const y = Number(m[1]), mo = Number(m[2])
  // Day 0 of the NEXT month is the last day of this one; UTC so no zone can shift it.
  const d = new Date(Date.UTC(y, mo, 0))
  return d.toISOString().slice(0, 10)
}

/**
 * The date a statement's balance is actually as of.
 * 'balance_date' (the default, and every loan until one is marked otherwise)
 * returns the stored date untouched, so this is a no-op for them.
 */
export function balanceAsOf(statementDate: string, basis: StatementDateBasis, measured?: unknown): string {
  // A date the DOCUMENT stated outranks any rule about what its filed date
  // means -- the rule is a policy about a lender, the measurement is this page.
  const m = measuredDate(measured)
  if (m) return m
  // 'due_date' deliberately falls through UNCHANGED rather than guessing. The
  // row is refused as an anchor by anchorRefusal() below, so this date is never
  // used to compare anything; returning it keeps the function total and keeps
  // the row sorting where its document was filed.
  return normalizeBasis(basis) === 'period_start' ? endOfMonth(statementDate) : String(statementDate || '')
}

/**
 * Why this row may not be used as a balance anchor, in words for the reader, or
 * null when it may. The ONLY refusal THIS function makes is the due-date one; a
 * human's `anchor_exclusion_reason` is a separate and independent objection,
 * read by `humanAnchorExclusion` below. Both of this file's two entry points
 * (`anchorsByBalanceDate`, `refusedAnchors`) apply the pair together, so a
 * caller never has to know there are two — see the s290 note on that function.
 *
 * ASK, DON'T CLAIM (session 262). The sentence names the document we hold and
 * the field that would settle it, because uploading or reading one date is far
 * cheaper than anybody scrambling to work out whether a gap is real.
 */
export function anchorRefusal(
  statementDate: string, basis: StatementDateBasis, measured?: unknown, today?: string,
): string | null {
  // ⚠️ SESSION 289 — THE FUTURE TEST BELONGS TO THE BALANCE DATE, NOT THE FILED
  // DATE, AND THAT IS THE WHOLE POINT OF THIS FILE.
  //
  // David: "the last statement I uploaded is from Sept", against a card saying
  // August's was not on file. It was, and so was September's. EIDL is a
  // `due_date` lender: its September document is filed under 2026-09-25, its
  // payment due date, and PRINTS that its balance is true as of 2026-08-24.
  //
  // loan-find-difference excluded it with `.lte('statement_date', today)` in the
  // SQL — the s196/s217 rule that a future-dated row is a projection, correctly
  // motivated and applied to the wrong date, one branch upstream of the
  // re-dating that would have placed that balance a fortnight in the PAST. So
  // the newest balance the walk could see was 2026-07-22, August had no span at
  // all, and the card asked a bookkeeper to upload a document filed the day
  // before. That is session 226's "$182 incident" shape, and s231's: the right
  // check on the wrong branch.
  //
  // It lives here now because this is where every caller converges, and the
  // date it tests is the MEASURED one. reconciliation-run and derive-schedule
  // never had the SQL filter, so they were already reading 2026-08-24 — which
  // means two surfaces of this product disagreed about the newest balance on the
  // book until now.
  const measuredOrFiled = measuredDate(measured) && normalizeBasis(basis) === 'due_date'
    ? String(measuredDate(measured))
    : statementDate
  if (today && measuredOrFiled > today) {
    return `this balance is dated ${measuredOrFiled}, which is still in the future — it is a projection until that day arrives, never a live balance (s196/s217).`
  }
  if (normalizeBasis(basis) !== 'due_date') return null
  if (measuredDate(measured)) return null
  return `this lender dates its statement to the PAYMENT DUE DATE (${statementDate}), which says nothing about when the balance was true — the statement is issued weeks ahead of it. The document prints the date itself, usually as "Last Payment Date"; until that is recorded on this row this balance cannot be placed in time, so it is kept as evidence for its period and not used as a balance anchor.`
}

// ── SESSION 290: A HUMAN'S EXCLUSION IS A REFUSAL, AND IT BELONGS HERE ────
//
// `anchorRefusal` above says, in its own doc, that `anchor_exclusion_reason` is
// "a separate and independent objection and is not read here". That was a
// deliberate choice and it was wrong in exactly the way session 231 describes:
// it made every caller responsible for remembering a rule, and THREE of them
// forgot.
//
// The row that proved it is Funding Circle's 2026-08-03 — byte-identical to the
// 2026-07-01 statement, carrying JULY's closing balance under an August date. A
// human opened both PDFs, established that, and wrote it into
// `anchor_exclusion_reason`. Then:
//
//   * `reconciliation-run` dropped it (its own filter, line ~1943) and measured
//     Funding Circle's variance at $60.16 — correct.
//   * `loan-find-difference` never read the column at all. Under 'period_start'
//     both the 08-01 and the 08-03 rows re-date to 2026-08-31, so the walk built
//     a span FROM A DATE TO ITSELF and reported "Aug 31 → Aug 31, off by
//     $1,041.09" — which is just July's balance minus August's, stated twice.
//     That phantom then tripped the write-off's `totalPeriodDiff` fence, so the
//     card refused to propose anything and told the reader to go and attribute a
//     difference that does not exist.
//   * `loan-xero-post`'s staleness guard (~line 1485) still asks SQL directly.
//     Session 275 fixed it by adding the `principal_only` filter, which excluded
//     this row THEN because its basis was 'unknown'; session 281 relabelled the
//     row 'principal_only' in good faith and silently re-broke it.
//
// Two surfaces of one product disagreeing about which documents are admissible
// is the same defect as disagreeing about the newest balance, and it gets the
// same fix: ONE convergence point. A caller inherits the exclusion without
// knowing the rule exists, including the one somebody writes tomorrow.
//
// The row is NOT lost and NOT truncated. `refusedAnchors` returns it with the
// human's sentence intact, because an exclusion nobody can see is evidence
// deleted (s245) — and the human's own words are the whole value of the field.
export function humanAnchorExclusion(row: any): string | null {
  const why = String(row?.anchor_exclusion_reason ?? '').replace(/\s+/g, ' ').trim()
  if (!why) return null
  return `a person ruled this document out as a balance anchor: ${why}`
}

/**
 * The rows `anchorsByBalanceDate` REFUSED, each carrying `anchor_refusal` in
 * words. Session 245: an exclusion nobody can see is evidence deleted — so the
 * two functions are a PAIR, and a caller that reports why it has no anchor
 * calls this one. It never returns a row that the other one returned.
 */
export function refusedAnchors<T extends { statement_date: string; balance_as_of?: unknown }>(
  anchors: T[], basis: StatementDateBasis, today?: string,
): (T & { anchor_refusal: string })[] {
  const b = normalizeBasis(basis)
  const out: (T & { anchor_refusal: string })[] = []
  for (const s of anchors || []) {
    // The human's objection is tested FIRST and reported in their words. It is
    // the stronger claim: somebody opened the PDF.
    const r = humanAnchorExclusion(s) ?? anchorRefusal(s.statement_date, b, (s as any).balance_as_of, today)
    if (r) out.push({ ...s, anchor_refusal: r })
  }
  return out
}

/**
 * Re-dates anchors to the date their balances are true, keeping the filed date
 * in `filed_date` so nothing is lost. Returns a NEW array of new objects; the
 * inputs are not mutated. Re-sorted, because re-dating can reorder: a mid-month
 * pull filed on the 3rd and a period-start row filed on the 1st of the same
 * month land in the opposite order once the latter moves to month end.
 */
export function anchorsByBalanceDate<T extends { statement_date: string; balance_as_of?: unknown }>(
  anchors: T[], basis: StatementDateBasis, today?: string,
): (T & { statement_date: string; filed_date: string; anchor_refusal: string | null })[] {
  const b = normalizeBasis(basis)
  return (anchors || [])
    .map(s => ({
      ...s,
      filed_date: s.statement_date,
      statement_date: balanceAsOf(s.statement_date, b, (s as any).balance_as_of),
      // Session 284: computed HERE, once, at load, for the same reason the
      // re-dating is -- every branch that picks a balance inherits it without
      // knowing the rule exists, including the one somebody adds tomorrow.
      // s290: the human's exclusion is checked at the SAME point and in the
      // same field, so the `.filter` below drops it without a second branch --
      // which is the entire point (s231). Theirs is tested first: a person who
      // opened the document outranks a rule about what a filed date means.
      anchor_refusal: humanAnchorExclusion(s) ?? anchorRefusal(s.statement_date, b, (s as any).balance_as_of, today),
    }))
    // Session 284: a REFUSED row never reaches a caller as an anchor. Filtering
    // here rather than in each caller is the same choice as re-dating here --
    // every branch that picks a balance inherits the refusal without knowing the
    // rule exists (session 231). The rows are not lost: refusedAnchors() above
    // returns them with the reason, for the surface that tells the reader.
    .filter(s => !s.anchor_refusal)
    // Session 282: ties are REAL under 'period_start' -- every document issued in
    // one month re-dates to that month's end, so the period statement filed on the
    // 1st and an off-cycle notice filed on the 3rd land on the same date. Ordering
    // by filed_date within a tie makes the result deterministic and puts the row
    // filed under the loan's own convention first. Without it the winner was the
    // query's return order, which is how iBusiness/FC read a payment-due notice as
    // its August closing balance.
    .sort((x, y) => (x.statement_date < y.statement_date ? -1 : x.statement_date > y.statement_date ? 1 :
                     x.filed_date < y.filed_date ? -1 : x.filed_date > y.filed_date ? 1 : 0))
}

/**
 * A SUSPICION, for a human to check -- never an action. Returns null when there
 * is nothing to say, so callers can push the note unconditionally.
 *
 * The tell is not "dated the 1st" on its own; a lender may legitimately report
 * on the 1st. It is the pair of facts that a statement filed on the 1st of a
 * month is followed, LATER IN THAT SAME MONTH, by another document showing a
 * DIFFERENT balance -- which is impossible if both dates mean what they say and
 * the earlier one is later in value. That is exactly the Funding Circle shape
 * (2026-08-01 at 65,173.94, then 2026-08-03 at 66,215.03).
 */
export function looksPeriodLabelled(
  statements: { statement_date: string; principal_balance: number | string | null }[],
  basis: StatementDateBasis,
): string | null {
  // A due-date loan cannot show this shape (its rows are refused, not re-dated),
  // and a period_start loan is already answered.
  if (normalizeBasis(basis) !== 'balance_date') return null
  const rows = (statements || [])
    .filter(s => s.principal_balance != null && /^\d{4}-\d{2}-\d{2}$/.test(String(s.statement_date)))
    .sort((a, b) => String(a.statement_date).localeCompare(String(b.statement_date)))
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]
    if (!a.statement_date.endsWith('-01')) continue
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j]
      if (b.statement_date.slice(0, 7) !== a.statement_date.slice(0, 7)) break
      if (Number(b.principal_balance) > Number(a.principal_balance) + 0.005) {
        return `the ${a.statement_date} statement reads $${Number(a.principal_balance).toFixed(2)} but the ${b.statement_date} one, later the same month, reads a HIGHER $${Number(b.principal_balance).toFixed(2)}. On a loan that only pays down, that means the ${a.statement_date} figure is not a balance as of that date — it is almost certainly the balance for the PERIOD BEGINNING then, filed under its first day. Open either PDF and check the issue date. If that is what it is, set this loan's statement_date_basis to 'period_start'; until then this walk is comparing each lender period against the wrong month.`
      }
    }
  }
  return null
}
