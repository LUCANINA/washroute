// _shared/existing-deposit.ts — "is this payout already in Xero under someone
// else's shape?" — session 266.
//
// WHY THIS IS A PURE FUNCTION AND NOT FOUR LINES INSIDE xero-payout-sync
//
// On 2026-09-03 this project posted $10,630.05 into the books twice. The July
// payout was booked as a NEW bank transaction while the bank feed's own deposit
// for the same money was already sitting there, coded in full to 403. The
// idempotency pre-check ran and saw nothing, because it asked whether Xero held a
// transaction carrying OUR reference — and a bank-feed deposit carries none.
//
// The replacement asks about the money instead of the label. That decision is the
// only thing standing between a historical catch-up and a duplicate, so it is
// written where a test can drive it directly, with every rejection reason its own
// branch. A guard buried in a fetch callback can only be tested by mocking Xero,
// which in practice means it never is.

export interface XeroBankTxnLike {
  BankTransactionID?: string
  Status?: string
  Total?: number | string
  Reference?: string | null
  IsReconciled?: boolean
  BankAccount?: { AccountID?: string }
  Contact?: { Name?: string }
}

export interface DepositMatchOpts {
  /** The Xero bank account the payouts land in. */
  bankAccountId: string
  /** The payout amount in dollars. */
  amount: number
  /** `Stripe payout <id>` — a transaction carrying this is OURS, not a conflict. */
  ourReference: string
  /** Cents of tolerance. Xero returns Total as a number, but a string sneaks through. */
  toleranceDollars?: number
}

/**
 * Return the first live transaction that represents this same money under a
 * different shape, or null when there is none.
 *
 * Every condition is a separate rejection so that none can be accidentally
 * dropped, and so a test can prove each one discriminates:
 *
 *  - not AUTHORISED   → a DELETED twin is not a conflict. This matters: after a
 *                       double-post is removed, Xero keeps the deleted record and
 *                       still returns it, and treating it as live would block the
 *                       repair forever.
 *  - wrong account    → a same-amount transaction on another account is unrelated.
 *  - wrong amount     → outside tolerance is a different payment.
 *  - our reference    → that is this pipeline's own transaction, handled by the
 *                       reference pre-check; calling it a conflict would make the
 *                       refusal message a lie.
 */
export function findConflictingDeposit(
  transactions: XeroBankTxnLike[] | null | undefined,
  opts: DepositMatchOpts,
): XeroBankTxnLike | null {
  const tol = opts.toleranceDollars ?? 0.02
  const ref = String(opts.ourReference || '').trim()
  for (const t of transactions || []) {
    if (String(t?.Status || '').toUpperCase() !== 'AUTHORISED') continue
    if (String(t?.BankAccount?.AccountID || '').toLowerCase() !== String(opts.bankAccountId || '').toLowerCase()) continue
    const total = Number(t?.Total)
    if (!Number.isFinite(total)) continue
    if (Math.abs(total - opts.amount) >= tol) continue
    if (ref && String(t?.Reference || '').trim() === ref) continue
    return t
  }
  return null
}
