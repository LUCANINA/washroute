// _shared/order-lookup.ts — resolves a Stripe PaymentIntent back to the
// WashRoute order it paid for, for payout classification.
//
// WHY THIS EXISTS (2026-09-26). classifyPayout (in both xero-payout-sync and
// xero-payout-reallocate) matched a charge to an order with a single query
// against the live `orders` table. A paid order that is later DELETED --
// which happens routinely (an employee cleaning up a duplicate, a mis-entered
// walk-in, etc.) -- simply disappears from that table. The charge already
// happened and the money already arrived in the payout; deleting the order
// afterwards does not undo either. But the lookup returned nothing, so the
// transaction landed in `unclassified`, which fails buildPlan's safety check
// and blocks the ENTIRE payout, not just the one line.
//
// Case in point: order #15801 ($77.95 + $10 tip), paid and picked up, deleted
// 2026-09-23 by an employee. It silently blocked the 2026-09-25 payout
// ($5,743.22) until someone found it three days later and manually added a
// stripe_txn_overrides row -- exactly the kind of one-off patch the Root-Cause
// Rule says must come with a code fix, because the next deleted-after-payment
// order will do this again.
//
// THE FIX. `deleted_orders_log` already keeps a full snapshot of every deleted
// order (`order_row`, written by whatever trigger/RPC performs the delete) --
// it exists for exactly this kind of "the record is gone but the fact isn't"
// situation. So the lookup now falls back to it when the live table has
// nothing, and returns the same shape (`id`, `order_number`, `source`,
// `line_items`) classifyPayout already expects, so no caller needs to
// special-case a recovered order.
//
// This does NOT change what happens once an order IS found: a walk-in split,
// a delivery order, credits/discounts read from line_items -- all identical
// to a live-table order. It only changes whether an order is found at all.
//
// Never widen this to explain away a GENUINELY unclassifiable charge (no
// order ever existed, e.g. a POS-terminal charge with no order row at all).
// deleted_orders_log only ever answers "was there once an order for this
// PaymentIntent" -- if neither table has one, the transaction is still
// unclassified and still blocks the payout, correctly.

export interface ResolvedOrder {
  id: string
  order_number: number | null
  source: string | null
  line_items: unknown
  // Set only when this order came from deleted_orders_log rather than the
  // live table, so a caller that wants to say so (dry-run output, a journal
  // narration) can, without a second query.
  deleted?: { deleted_at: string; deleted_by_name: string | null }
}

export async function getOrderByPaymentIntent(supabase: any, pi: string): Promise<ResolvedOrder | null> {
  const { data: live } = await supabase
    .from('orders')
    .select('id, order_number, source, line_items')
    .eq('stripe_payment_intent_id', pi)
    .maybeSingle()
  if (live) return live as ResolvedOrder

  // Fallback: a paid order that was later deleted. order_row is the full
  // snapshot taken at delete time, so everything classifyPayout needs is in
  // there under the same names the live table uses.
  const { data: deleted } = await supabase
    .from('deleted_orders_log')
    .select('order_row, deleted_at, deleted_by_name')
    .eq('order_row->>stripe_payment_intent_id', pi)
    .order('deleted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!deleted?.order_row) return null

  const row = deleted.order_row as any
  return {
    id: row.id,
    order_number: row.order_number ?? null,
    source: row.source ?? null,
    line_items: row.line_items ?? null,
    deleted: { deleted_at: deleted.deleted_at, deleted_by_name: deleted.deleted_by_name ?? null },
  }
}
