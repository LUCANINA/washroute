// _shared/dispute-classify.ts — the one place a disputed charge is recognised.
//
// WHY THIS IS SHARED AND NOT COPIED (session 330)
//
// On 2026-10-07 the $12,234.68 payout refused to post for six hours over a single
// $170.95 chargeback. Stripe delivers a chargeback as a balance transaction of
// type 'adjustment', which matched none of xero-payout-sync's branches and so
// landed in `unclassified` — and an unclassified transaction correctly fails the
// whole payout's safety check. The refusal was right; the gap was that nothing
// could ever answer it, because stripe_txn_overrides only accepts the five
// revenue buckets and a chargeback is not revenue.
//
// This module is shared for exactly the reason _shared/txn-overrides.ts is:
// xero-payout-reallocate carries its own copy of classifyPayout, and in session
// 266 a fix applied to one function was refused by the other within the hour.
// Both import this; a future classifier gets it by importing rather than by
// remembering.
//
// The real duplication — two near-identical classifyPayout implementations —
// is NOT fixed here and remains live tech debt.

// Per David (session 330): chargebacks get their OWN account rather than sitting
// inside 691 Refunds & Replacements. 606 "Chargebacks" ALREADY EXISTED in the
// chart of accounts (DIRECTCOSTS, active, read live from Xero) -- no new account
// was created, and adding a second one would have split the history. It sits
// beside 605 Merchant Fees, which is the right neighbourhood.
//
// The amount posted here is the dispute's `net`, NOT its `amount`: Stripe's net
// is amount - fee, so it already carries the reversed sale AND the $15 dispute
// fee. One line, one account, so "what did chargebacks cost us" is a single
// figure -- which is also why nothing is added to 828 Stripe Fees for a dispute.
export const DISPUTE_ACCOUNT = { code: '606', name: 'Chargebacks' }

/**
 * Is this balance transaction a dispute (or a dispute we later won)?
 *
 * ⚠️ GATED ON `reporting_category`, NEVER ON `type === 'adjustment'`.
 *
 * 'adjustment' is Stripe's catch-all type: it carries chargebacks AND Stripe's
 * own corrections, which have nothing to do with 691 and must keep blocking for
 * a human. Testing the type would silently book the next Stripe correction as a
 * chargeback — the exact "guessing is worse than refusing" failure this
 * pipeline's safety check exists to prevent.
 *
 * Measured on the real transaction (txn_1UNaOgGACgbvEugHqIwYV82f, 2026-10-07):
 *   type 'adjustment', reporting_category 'dispute', source 'du_1UNaNmGACgbvEugHHNvqFHyJ'
 *
 * Note the source prefix is `du_`, not the `dp_` you would expect — which is
 * exactly why this does not sniff the source id either. `reporting_category` is
 * Stripe's own documented classification and the only field asked.
 *
 * 'dispute_reversal' is included so a dispute we WIN (money comes back, positive
 * amount) posts the reversal to 691 instead of blocking the payout all over
 * again — a guard that only handles the loss leaves the win broken.
 *
 * Anything unrecognised returns false and keeps falling through to
 * `unclassified`, which blocks the payout. That is the safe direction and it is
 * deliberate: the failure mode of this module is "refuses to post", never
 * "posts a guess".
 */
export function isDisputeTxn(bt: any): boolean {
  const category = String(bt?.reporting_category || '')
  return category === 'dispute' || category === 'dispute_reversal'
}
