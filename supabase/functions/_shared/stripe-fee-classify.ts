// _shared/stripe-fee-classify.ts — which Stripe `stripe_fee` lines are PROCESSING fees.
//
// WHY THIS EXISTS (session 373, 2026-11-23)
//
// Until 2026-11-12 Stripe deducted its processing fee from each charge: the
// charge's balance transaction carried it in `fee`, and buildPlan posted the sum
// to 605 (processing fees). From 2026-11-13 the account moved to fees billed
// SEPARATELY: every charge now shows fee = 0 and Stripe debits one daily
// `stripe_fee` balance transaction per product ("Card (2026-11-18)", etc.).
// `stripe_fee` had only ever meant small account fees (Billing usage, CAU) and
// went to 828 Stripe Fees, so ~$1,600 of November card processing landed in 828
// and 605 dropped by the same amount. Total fees stayed at 3.24% of sales — the
// money was right, the account was wrong.
//
// The test is Stripe's own description, which names the product billed.
// Measured on the live account 2026-11-23, every stripe_fee since 2026-10-23:
//   "Card (2026-11-18)"                                   → processing (605)
//   "Card (2026-11-01 - 2026-11-30)"  (+$191.17 credit)   → processing (605)
//   "Card Present (2026-11-01 - 2026-11-30)" (+$5.87)     → processing (605)
//   "Terminal (2026-11-18): Per-authorization Services Fee" → processing (605)
//   "Billing - Usage Fee (2026-11-18)"                    → account fee (828)
//   "Card Account Updater (CAU) (2026-11-01 - ...)"       → account fee (828)
//
// FAIL-SAFE DIRECTION: anything not recognised stays in 828, exactly where every
// stripe_fee went before this file existed. A new product Stripe starts billing
// can only be mis-filed into the account it always went to, never silently
// pulled into processing. Note "Card Account Updater" begins with "Card " — the
// pattern requires "(" straight after the product name so it cannot match.

const PROCESSING_PRODUCTS = /^(Card|Card Present|Terminal) \(/

/** A Stripe-billed fee for processing a payment (card, card-present, Terminal). */
export function isProcessingFeeTxn(bt: any): boolean {
  return bt?.type === 'stripe_fee' && PROCESSING_PRODUCTS.test(String(bt?.description ?? ''))
}
