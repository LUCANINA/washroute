// _shared/refund-classify.ts — the one place a balance transaction is called a refund.
//
// WHY THIS IS SHARED AND NOT COPIED (session 369)
//
// On 2026-11-04 the $12,133.07 payout refused to post because of one $50
// transaction: `txn_1UXSj0GACgbvEugHNzbLv5yJ`, Stripe type `refund_failure` — a
// refund of ours that could not be delivered, so Stripe returned the money to
// the balance. It matched neither refund branch, fell through to `unclassified`,
// and blocked the whole payout. That refusal is correct behaviour (guessing a
// revenue account is worse than refusing) but it is permanent: the
// `stripe_txn_overrides` escape hatch only accepts the five revenue buckets, so
// no human could answer the question either.
//
// This is the same shape as session 330's chargeback, which blocked $12,234.68
// over one $170.95 dispute, and session 266's POS reader charge, which blocked
// $10,630.05 over one $18.27 charge. Three times now, one unhandled type has
// held an entire payout. The lesson session 266 drew about the override lookup
// applies here too: the refund test lived in TWO near-identical classifyPayout
// copies (xero-payout-sync and xero-payout-reallocate), and a fix applied to one
// and not the other is how the $18.27 charge stayed unclassifiable in the second
// function within an hour of being fixed in the first. Both import this instead.
//
// The 180-line classifyPayout duplication itself is NOT fixed here and remains
// live tech debt. This removes one more part that could diverge, not the reason
// it can.

/**
 * Is this balance transaction a refund, in either direction?
 *
 * All four cases post to the same Xero account (691 Refunds & Replacements), and
 * the sign comes from Stripe: a refund is negative, a failed refund is positive.
 * `buildPlan` passes `refundsBucket.gross` through WITHOUT `-Math.abs()`, exactly
 * as it does for a won dispute, so a positive total is carried correctly.
 *
 * A failed refund is the REVERSAL of a refund we already booked, not a different
 * kind of event, so it belongs in the same bucket rather than a new one — unlike
 * a chargeback, which session 330 split out precisely because it is a different
 * decision (money taken from us, not money we chose to give).
 *
 * DELIBERATELY NOT INCLUDED: `payment_failure_refund`, `payment_reversal`,
 * `transfer_refund`. They have never appeared on this account, so their sign and
 * their right account are unverified here, and an unverified type that keeps
 * blocking is the safe direction. Add one only with a real transaction to check
 * the arithmetic against — that is what made this change provable.
 */
export function isRefundTxn(bt: any): boolean {
  const t = bt?.type
  return t === 'refund' || t === 'payment_refund' || t === 'refund_failure'
}

/** True only for the reversal direction — money coming back to us. */
export function isFailedRefundTxn(bt: any): boolean {
  return bt?.type === 'refund_failure'
}
