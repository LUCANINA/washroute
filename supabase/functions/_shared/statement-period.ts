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

export type StatementDateBasis = 'balance_date' | 'period_start'

export const STATEMENT_DATE_BASES: StatementDateBasis[] = ['balance_date', 'period_start']

export function normalizeBasis(v: unknown): StatementDateBasis {
  return v === 'period_start' ? 'period_start' : 'balance_date'
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
export function balanceAsOf(statementDate: string, basis: StatementDateBasis): string {
  return normalizeBasis(basis) === 'period_start' ? endOfMonth(statementDate) : String(statementDate || '')
}

/**
 * Re-dates anchors to the date their balances are true, keeping the filed date
 * in `filed_date` so nothing is lost. Returns a NEW array of new objects; the
 * inputs are not mutated. Re-sorted, because re-dating can reorder: a mid-month
 * pull filed on the 3rd and a period-start row filed on the 1st of the same
 * month land in the opposite order once the latter moves to month end.
 */
export function anchorsByBalanceDate<T extends { statement_date: string }>(
  anchors: T[], basis: StatementDateBasis,
): (T & { statement_date: string; filed_date: string })[] {
  const b = normalizeBasis(basis)
  return (anchors || [])
    .map(s => ({ ...s, filed_date: s.statement_date, statement_date: balanceAsOf(s.statement_date, b) }))
    .sort((x, y) => (x.statement_date < y.statement_date ? -1 : x.statement_date > y.statement_date ? 1 : 0))
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
  if (normalizeBasis(basis) === 'period_start') return null
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
