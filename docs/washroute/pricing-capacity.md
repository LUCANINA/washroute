# WashRoute — Pricing, Discounts & Capacity

*Split out of the `washroute` skill 2026-09-02.*

## ⚠️ Subscription vs pay-as-you-go pricing — NEVER mix the two models (session 213)

There are two weight-pricing models and an order gets exactly ONE of them:

| | Included weight | Overage rate | line_items type | Applied by |
|---|---|---|---|---|
| **Pay-as-you-go** (Delivery pricelist) | `lbs_per_bag` × bags (25/bag) | `overage_rate_per_lb` ($3.00) | `overage` | the intake screen (app code) |
| **Subscription** | plan's POOLED `weight_limit_lbs` (100/month) | `overage_price_per_lb` ($2.75) | `lb_overage` | DB trigger `apply_subscription_usage_fn` at `ready_for_delivery` |

A subscription order priced with the per-bag rule gets a $0/bag base AND a
pay-as-you-go overage — the worst of both. This shipped twice: session 168 fixed it in
the admin intake panel, and it came straight back through the POS intake panel in
session 213 (Amy Cummings #10580 double-charged $90; Sani Bee #12465 charged $21 on an
order fully inside her allowance).

**The invariant now lives in the DB.** `link_subscription_on_order_fn` strips any
`type='overage'` line from a subscription order and deducts it from `total_amount`.
`lb_overage` is deliberately NOT matched. So app code can no longer cause this — but:

1. **Resolve the plan from `orders.subscription_id`, never from `customers.pricelist`.**
   A plan that cancels at period end flips the pricelist back to `Delivery` and the
   status to `cancelled`, so an order booked while the plan was live prices as
   pay-as-you-go once it lapses. The order carries the authoritative link.
2. **Any status filter on `subscriptions` must be `IN ('active','past_due','paused')`**
   — that is what `link_subscription_on_order_fn` accepts. `.eq('status','active')`
   silently mis-prices past-due and paused subscribers.
3. Staff read access to `subscriptions` is via the `staff_read_subscriptions` RLS policy
   (`is_staff()`), so the POS device account can see the plan.

---

## ⚠️ Capacity Model — two distinct states + the commercial-route convention

**There are TWO overcap states. Do not conflate them.**

1. **Soft override (advisory).** `active_stops > stop_limit` but still ≤ `GREATEST(stop_limit+1, FLOOR(stop_limit*1.25))`. `auto_route_order` books the stop, sets `orders.overcap_booking = TRUE`, and routing proceeds normally. This flag is **purely cosmetic** — it drives the Routes-tab "+N over" badge and nothing else. It never gates billing, triggers SMS, or changes driver behaviour.
2. **Hard block.** `active_stops > ceiling`. `auto_route_order` refuses to place the stop and writes `routing_error` on the order so it shows up in the Issues tab. Customer-app bookings that would hit this state hit `get_nearest_available_slots` first and pick an alternative slot — they never see a failure.

**`stop_limit = 0` means "no cap — this is a dedicated commercial route."** Kidango is the live example: David assigns stops manually and normal capacity math doesn't apply. The three Phase-2 functions (`auto_route_order`, `sync_pickup_stop_on_window_change`, `sync_delivery_stop_on_window_change`) gate their overcap logic on `v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0`. Any new function that reads `stop_limit` MUST use the same guard — otherwise `FLOOR(0 / num_subs) = 0` → every stop looks overcap and the commercial route gets false-flagged. The audit skill's Check 7 also filters `stop_limit > 0` for the same reason.

**Never add a code path that treats `stop_limit = 0` as "limit of zero stops."** It means the opposite.

---

## Pricing & Discounts (reference — session 177)

**Delivery Wash & Fold pricing model.** The `services` row (pricelist `Delivery`,
`pricing_type='per_bag'`) is the source of truth: `base_price` per bag (currently
**$65**; was **$59** in May 2026), `lbs_per_bag` included **per bag** (25),
`overage_rate_per_lb` ($3), `has_weight_overage=true`. Order economics =
`bags*base + max(0, weight_lbs − bags*lbs_per_bag)*overage`. `orders.line_items`
carries `type:'base'`, `type:'overage'` ("N lbs overage × $3"), add-ons
(`pref_service`/`addon`), `delivery_fee`, and discounts as a **negative
`type:'discount'`** line. Other pricelists: Commercial W&F `per_lb` $1.75 (Kidango
etc., on_account), Retail `per_lb` $2.00 (POS), Subscription `per_bag` $0 (plan
covers base, lb-overage appended at ready-for-delivery). To scope "Delivery
price-list" orders, filter `orders.service_id = '<Delivery W&F id>'` (or
`customers.pricelist='Delivery'`); `orders` has NO `pricelist` column.

**Discount usage vs claims (don't conflate).** `discount_redemptions` is a **CLAIM
ledger** — a customer typed a code into the customer app (`redeem_discount_code`
RPC), which also enforces single-use (1/customer for %, 1 global for fixed).
Its `order_id` is **always NULL**; it is NOT an order-usage ledger. Real per-order
usage = **`orders.discount_id`** (set by `record_order_intake` / order placement;
no redemption row created). The admin Discounts page (session 177) therefore counts
**% discount** usage from `orders.discount_id` (Count = orders, Value = Σ |discount
line|), and **fixed coupons** from the claim ledger (Count = claims, Value = Σ
credited). **Never backfill `discount_redemptions` from orders** — it would break
the single-use checks. Pricing-scenario deliverable: `WashRoute-Delivery-Pricing-Model-May.xlsx` (repo root).

