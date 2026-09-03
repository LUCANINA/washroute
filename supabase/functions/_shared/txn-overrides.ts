// _shared/txn-overrides.ts — the one place a human classification is applied.
//
// WHY THIS IS SHARED AND NOT COPIED (session 266)
//
// stripe_txn_overrides was added to xero-payout-sync so a person could classify a
// balance transaction the code cannot match to an order — a card sale typed
// straight into the POS reader, whose PaymentIntent is never written back to any
// order. Within the hour, xero-payout-reallocate refused to prepare a journal for
// the very payout that fix had unblocked: it carries its own copy of
// classifyPayout, that copy had no override lookup, and so the same $18.27 charge
// was still unclassifiable there.
//
// Two functions, one question, two answers. Copying the lookup into the second
// file would have made three the next time. This module is the answer instead:
// both functions import it, and a future classifier gets it by importing rather
// than by remembering.
//
// The real duplication — two near-identical 180-line classifyPayout
// implementations — is NOT fixed by this module and remains live tech debt. This
// removes the part that had already diverged, not the reason it could.

export interface TxnOverride { bucket: string; reason: string }

/**
 * Load every human classification, once per payout. Small table; the callers are
 * already making 100+ Stripe calls, which is the budget that actually matters.
 *
 * Returns an empty Map on error rather than throwing. That is deliberate and it
 * is the safe direction: with no overrides an unclassifiable charge stays
 * unclassified, the plan's safety check fails, and the payout is BLOCKED. The
 * failure mode of losing this table is "refuses to post", never "posts a guess".
 */
export async function loadTxnOverrides(supabase: any): Promise<Map<string, TxnOverride>> {
  try {
    const { data, error } = await supabase
      .from('stripe_txn_overrides')
      .select('stripe_balance_transaction_id, bucket, reason')
    if (error) {
      console.error('[txn-overrides] could not load overrides:', error.message)
      return new Map()
    }
    return new Map((data || []).map((r: any) => [r.stripe_balance_transaction_id, { bucket: r.bucket, reason: r.reason }]))
  } catch (e) {
    console.error('[txn-overrides] threw while loading overrides:', String((e as Error)?.message || e))
    return new Map()
  }
}

/**
 * Apply an override to ONE balance transaction, or leave it exactly as it was.
 *
 * The guard is the whole safety property, and it lives here so neither caller can
 * get it subtly wrong: an override may only ANSWER a question the classifier
 * could not answer. It may never contradict a successful match, or it stops being
 * a classification aid and becomes a way to silently re-route revenue the system
 * had already identified correctly.
 *
 * `buckets` is passed only so an unknown bucket name is refused rather than
 * creating a phantom category — the DB CHECK constraint should make that
 * impossible, but a guard that depends on a constraint in another system is not a
 * guard.
 */
export function applyTxnOverride(
  overrides: Map<string, TxnOverride>,
  btId: string,
  category: string,
  splitOverride: unknown,
  buckets: Record<string, unknown>,
): { category: string; applied: TxnOverride | null } {
  if (category !== 'unclassified' || splitOverride) return { category, applied: null }
  const ov = overrides.get(btId)
  if (!ov) return { category, applied: null }
  if (!Object.prototype.hasOwnProperty.call(buckets, ov.bucket)) {
    console.error(`[txn-overrides] refusing unknown bucket "${ov.bucket}" for ${btId}`)
    return { category, applied: null }
  }
  return { category: ov.bucket, applied: ov }
}
