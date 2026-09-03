// _shared/book-balances.ts — WHERE OUR OWN BOOKS ACTUALLY LIVE.
//
// ─── WHY (session 263 cont. 7, David) ───────────────────────────────────────
// The bundle told David, on a loan whose books had been rebuilt from Xero the
// previous night: *"Nothing on file for this loan is a balance rebuilt from your
// own ledger."* He asked the obvious question — "don't we have instant access to
// our ledger?" — and he was right. PayPal 2 had **$49,346.58 at 2026-08-31**,
// basis `xero_rebuild`, sitting in `loan_book_balances`, with two more rows
// behind it going back to June.
//
// The sentence was false because the check looked in ONE table. Balances about
// this business live in two:
//
//   loan_statements       every party's claim — the LENDER's pulls and letters,
//                         our own schedules, AND some books-side rows
//                         (`xero_derived`, `xero_balance_snapshot`).
//   loan_book_balances    purpose-built: our ledger rebuilt from Xero's own
//                         BankTransactions and ManualJournals by
//                         reconciliation-run. Nothing else is in it.
//
// Session 263 cont. 4 fixed "don't call a lender row the books" and never asked
// the second half of the question — where the books DO live. Half a fix reads
// exactly like a whole one until someone asks.
//
// ─── ONE ANSWER, THREE CALLERS ──────────────────────────────────────────────
// `loan-bundle`'s §5, `carrying-basis-drift`'s observation chooser and
// `reconciliation-run` all ask "what do our books hold". They get it from here,
// normalised into one shape, because this module's standing lesson is that two
// lists of the same thing drift — and drift is precisely what produced a screen
// saying no such balance existed while three of them sat in the next table over.

/** A row as `loan_book_balances` stores it. */
export interface BookBalanceRow {
  as_of: string
  balance: number | string
  /** The SOURCE of the rebuild ('xero_rebuild'), not what the balance measures. */
  basis: string
}

/** The shape every balance consumer already speaks. */
export interface NormalisedBalance {
  statement_date: string
  principal_balance: number
  balance_basis: string
  source: string
}

/**
 * `loan_book_balances` rows in the shape the rest of the module expects.
 *
 * TWO FIELD NAMES THAT LOOK LIKE EACH OTHER AND ARE NOT.
 * `loan_book_balances.basis` is where the figure CAME FROM — 'xero_rebuild'.
 * `loan_statements.balance_basis` is what the figure MEASURES — principal only,
 * or the whole payback. They are different questions and this is the one place
 * that translates between them, so nobody has to notice again: `basis` becomes
 * `source`, and `balance_basis` becomes 'unknown', because these rows genuinely
 * do not record what they measure.
 *
 * 'unknown' is not a shrug here. It is the productive case for the carrying-basis
 * check: an unlabelled BOOK balance is tested against both models, and whichever
 * one predicts it names the basis. A row that claimed a basis it does not carry
 * would answer that question by assertion instead.
 */
export function normaliseBookBalances(rows: BookBalanceRow[] | null | undefined): NormalisedBalance[] {
  return (rows || [])
    .filter(r => r && r.as_of && Number.isFinite(Number(r.balance)))
    .map(r => ({
      statement_date: String(r.as_of).slice(0, 10),
      principal_balance: Number(r.balance),
      balance_basis: 'unknown',
      source: String(r.basis || 'xero_rebuild'),
    }))
}

/**
 * Every balance on file for a loan, from both tables, oldest first.
 *
 * On a date carrying rows from both, the purpose-built rebuild wins. It is the
 * only one written for this question, it is recomputed on every reconciliation
 * run, and the alternatives on that date are a sweep snapshot or a derived row.
 * The loser is not discarded silently — it stays in the returned list, one
 * position earlier, so anything auditing the set can still see it; only the
 * "newest row" pick is affected.
 *
 * There is no attempt to reconcile two book rows that DISAGREE on one date.
 * That has not happened — `loan_statements` carries no `xero_rebuild` rows at
 * all — and inventing a tie-break for a case with no examples is how a rule gets
 * written that nobody can check. If it ever happens, it deserves a finding
 * rather than a preference.
 */
export function allBalancesForLoan(
  statements: Array<Record<string, any>> | null | undefined,
  bookBalances: BookBalanceRow[] | null | undefined,
): NormalisedBalance[] {
  const fromStatements: NormalisedBalance[] = (statements || [])
    .filter(s => s && s.statement_date && Number.isFinite(Number(s.principal_balance)))
    .map(s => ({
      statement_date: String(s.statement_date).slice(0, 10),
      principal_balance: Number(s.principal_balance),
      balance_basis: String(s.balance_basis || 'unknown'),
      source: String(s.source || ''),
    }))
  const fromBooks = normaliseBookBalances(bookBalances)
  const rebuiltDates = new Set(fromBooks.map(b => b.statement_date))
  return [...fromStatements, ...fromBooks].sort((a, b) => {
    const d = a.statement_date.localeCompare(b.statement_date)
    if (d !== 0) return d
    // Same date: the rebuild sorts last, so a "newest row" pick lands on it.
    const aWins = a.source === 'xero_rebuild' && rebuiltDates.has(a.statement_date)
    const bWins = b.source === 'xero_rebuild' && rebuiltDates.has(b.statement_date)
    return aWins === bWins ? 0 : aWins ? 1 : -1
  })
}
