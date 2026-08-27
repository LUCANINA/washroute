// loan-bundle/candidates.ts — which ledger entries are worth opening.
//
// Split out of index.ts for one reason: index.ts imports `jsr:` and `npm:`
// specifiers, so nothing in it can be reached by a test. The rule this file
// holds is the difference between a 7-second search and a 72-second one, which
// makes it exactly the kind of thing that must be tested.

/**
 * Narration is free — it comes back in the LIST — so use it before spending a
 * request on anything.
 *
 * The real entry reads "Stripe Capital Loan — record Fixed Fee ($20,875.00) per
 * loan agreement", so matching on the loan's name, its lender, or the fee figure
 * turns seventy hydrations into one. This is triage, not a filter: when narration
 * matches nothing we still open entries blind, just a bounded number of them, and
 * say so if we run out of budget before finishing.
 */
export function rankFeeCandidates(
  rows: { id?: string; narration?: string | null; reference?: string | null }[],
  hints: { loanName?: string | null; lender?: string | null; feeAmount: number },
): { likely: string[]; rest: string[] } {
  const norm = (v: unknown) => String(v ?? '').toLowerCase()
  const words = [hints.loanName, hints.lender]
    .map(norm).filter(w => w.length >= 4)
  // "20875", "20,875", "20875.00" — the figure as a human would have typed it.
  const n = Math.round(hints.feeAmount)
  // A figure needs a length floor for the same reason a name does. "1" appears in
  // 2026, in every dollar amount, in half the narrations on the page — a $1 fee
  // used as a needle marks every entry in the window "likely" and the triage
  // becomes the exhaustive scan it exists to avoid. Four characters means the
  // needle is $1,000 or more; below that, the words carry it alone.
  const figures = (String(n).length >= 4
    ? [String(n), n.toLocaleString('en-US'), hints.feeAmount.toFixed(2),
       Number(hints.feeAmount).toLocaleString('en-US', { minimumFractionDigits: 2 })]
    : []).map(norm)
  const likely: string[] = [], rest: string[] = []
  for (const r of rows) {
    const id = String(r.id ?? '')
    if (!id) continue
    const text = norm(r.narration) + ' ' + norm(r.reference)
    const hit = words.some(w => text.includes(w)) || figures.some(f => f && text.includes(f))
    ;(hit ? likely : rest).push(id)
  }
  return { likely, rest }
}
