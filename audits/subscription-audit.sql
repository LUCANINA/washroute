-- Subscription audit — billing correctness and trends. Session 291q (2026-09-10).
-- Re-runnable, read-only.
--
-- THE TRAP THAT ALMOST PRODUCED A FALSE FINDING, read this before writing any
-- overage check: subscriptions.overage_amount_due is ALWAYS 0.00. It is vestigial.
-- Overage is NOT accrued on the subscription — it is billed on the ORDER as a line
-- item of type 'lb_overage' at the plan's $2.75/lb. A check that reads
-- overage_amount_due will report every over-allowance subscriber as uncharged: at the
-- time of this audit that would have been 16 subscribers, 422 lbs, a $1,160.50
-- "leak" that does not exist. Verified the other way instead — per-subscriber charges
-- this period matched lbs-over-100 x $2.75 almost to the cent.
--
-- Second gotcha: the two past_due subscriptions show a 7-day current_period. That is
-- Stripe's dunning/retry window, not a billing period. Active subs are all 30-31 days.

-- 1. Health of the subscriber base
SELECT s.status, count(*) n,
       count(*) FILTER (WHERE s.stripe_subscription_id IS NULL) no_stripe_sub,
       count(*) FILTER (WHERE s.dunning_started_at IS NOT NULL) in_dunning,
       count(*) FILTER (WHERE s.cancel_at_period_end) cancel_at_end
FROM subscriptions s GROUP BY 1 ORDER BY 2 DESC;

-- 2. Pricelist vs subscription state — a customer on the Subscription pricelist with
--    no active subscription is priced at $0/bag while paying nothing monthly.
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust, c.pricelist,
       (SELECT string_agg(s.status, ', ') FROM subscriptions s WHERE s.customer_id = c.id) subs
FROM customers c
WHERE COALESCE(c.pricelist,'') = 'Subscription'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.customer_id = c.id AND s.status = 'active');

-- 3. Subscription orders priced per-bag. A subscriber's base must be $0 — the plan
--    covers it. Anything else is the session-196 double-billing class.
SELECT o.order_number, c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
       o.status, o.billing_status, o.created_at::date, o.weight_lbs, o.total_amount
FROM orders o
JOIN customers c ON c.id = o.customer_id,
     jsonb_array_elements(o.line_items) li
WHERE o.subscription_id IS NOT NULL
  AND li->>'type' = 'base' AND (li->>'amount')::numeric > 0
  AND o.status NOT IN ('cancelled','skipped');

-- 4. Overage actually charged, per subscriber over the allowance, this period.
--    Compare `charged_this_period` against (usage - 100) * 2.75.
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
       round(s.usage_lbs_this_period,1) lbs,
       round(greatest(s.usage_lbs_this_period - p.weight_limit_lbs, 0) * p.overage_price_per_lb, 2) expected_overage,
       (SELECT round(COALESCE(sum(o.total_amount),0),2) FROM orders o
         WHERE o.subscription_id = s.id AND o.created_at >= s.current_period_start
           AND o.status NOT IN ('cancelled','skipped')) charged_this_period
FROM subscriptions s
JOIN customers c ON c.id = s.customer_id
JOIN subscription_plans p ON p.id = s.plan_id
WHERE s.status = 'active' AND s.usage_lbs_this_period > p.weight_limit_lbs
ORDER BY s.usage_lbs_this_period DESC;

-- 5. Billing hygiene — all four returned zero at the time of this audit.
SELECT
 (SELECT count(*) FROM orders o WHERE o.subscription_id IS NOT NULL
    AND o.billing_status = 'failed' AND o.created_at > now() - interval '90 days') failed_charges_90d,
 (SELECT count(*) FROM orders o WHERE o.subscription_id IS NOT NULL AND o.billing_status IS NULL
    AND o.status IN ('delivered','ready_for_delivery','out_for_delivery')
    AND COALESCE(o.total_amount,0) > 0 AND o.archived_at IS NULL) unpaid_sub_orders,
 (SELECT count(*) FROM subscriptions s JOIN customers c ON c.id = s.customer_id
   WHERE s.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM customer_payment_methods pm WHERE pm.customer_id = c.id)
     AND c.stripe_default_payment_method_id IS NULL) active_subs_no_card;

-- 6. TREND — subscription revenue vs the same volume billed pay-as-you-go.
WITH p AS (
  SELECT s.id,
    (SELECT COALESCE(sum(o.total_bags),0) FROM orders o WHERE o.subscription_id = s.id
       AND o.created_at >= s.current_period_start AND o.status NOT IN ('cancelled','skipped')) bags,
    (SELECT round(COALESCE(sum(o.total_amount),0),2) FROM orders o WHERE o.subscription_id = s.id
       AND o.created_at >= s.current_period_start AND o.status NOT IN ('cancelled','skipped')) extra
  FROM subscriptions s WHERE s.status = 'active'
)
SELECT count(*) subs,
       round(sum(275 + extra),2) subscription_revenue,
       round(sum(bags * 65),2) payg_equivalent,
       round(sum(275 + extra) - sum(bags * 65),2) delta
FROM p;

-- 7. TREND — churn shape, and whether churners kept buying by the bag.
--
-- THE BUG THIS QUERY WAS WRITTEN TO AVOID. The first version built its churn set as
--   FROM subscriptions s WHERE s.status = 'cancelled'
-- and then tried to detect re-subscribers with bool_or(s.status = 'active') over that
-- same set. The WHERE runs before the aggregate, so the active row is never in scope
-- and the flag can only ever be false. It reported "0 resubscribed" and counted
-- Olivia Rosaldo-Pratt as churned — she had in fact cancelled one subscription and
-- started another the SAME DAY (2026-07-30) and is a current paying subscriber. Her
-- "6 orders, $32" was ordinary subscription billing: $0 base, $3 Oxi each time.
--
-- A churned CUSTOMER is one with a cancelled subscription and NO active one. Group by
-- customer over ALL their subscriptions, then filter.
WITH cust AS (
  SELECT c.id, c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
         bool_or(s.status = 'active') has_active,
         max(s.cancelled_at) FILTER (WHERE s.status = 'cancelled') last_cancel
  FROM subscriptions s
  JOIN customers c ON c.id = s.customer_id
  GROUP BY 1, 2
), churned AS (
  SELECT * FROM cust WHERE NOT has_active AND last_cancel IS NOT NULL
), post AS (
  SELECT ch.*,
    round(extract(epoch FROM (now() - ch.last_cancel))/86400.0) days_since,
    (SELECT count(*) FROM orders o WHERE o.customer_id = ch.id
       AND o.status = 'delivered' AND o.created_at > ch.last_cancel) orders_after,
    (SELECT round(COALESCE(sum(o.total_amount),0),2) FROM orders o WHERE o.customer_id = ch.id
       AND o.status = 'delivered' AND o.created_at > ch.last_cancel) rev_after
  FROM churned ch
)
SELECT
 (SELECT count(*) FROM cust WHERE has_active AND last_cancel IS NOT NULL) resubscribed_same_customer,
 (SELECT count(*) FROM churned) truly_churned,
 count(*) FILTER (WHERE orders_after > 0) returned_payg,
 count(*) FILTER (WHERE orders_after = 0) silent,
 round(sum(rev_after),2) payg_revenue,
 -- Most cancellations here are only days old. Segment before drawing conclusions.
 count(*) FILTER (WHERE days_since >= 45) had_45d_to_return,
 count(*) FILTER (WHERE days_since >= 45 AND orders_after > 0) returned_of_those
FROM post;

-- ───────────────────────────────────────────────────────────────────────────
-- Added 2026-09-22 (subscription audit). Three checks that would have caught
-- what session 280's sweep missed. All three returned rows on the day they
-- were written — see the notes against each.

-- 8. Subscription invoices above the plan price where the extra was ALREADY
--    paid on an order. Any subscription invoice > plan price is suspicious:
--    since session 280 overage belongs on the ORDER. The invoice path is only a
--    safety net for an order whose own charge failed, so extra on an invoice
--    alongside a PAID lb_overage order = double charge.
--    Found 2026-09-22: Lisa Sturges (Jul 23, +$41.25) and Joshua DeLuca MacKay
--    (Sep 13, +$49.50) — both RE-SIGNUP invoices that swept up a leftover
--    "Final overage" item from their previous cancelled plan.
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
       t.created_at::date, t.amount, t.description,
       t.amount - p.price_monthly extra,
       (SELECT COALESCE(sum(r.amount),0) FROM customer_transactions r
         WHERE r.customer_id = t.customer_id AND r.type = 'refund'
           AND r.description ILIKE '%' || t.description || '%') refunded
FROM customer_transactions t
JOIN customers c ON c.id = t.customer_id
JOIN subscriptions s ON s.customer_id = t.customer_id
JOIN subscription_plans p ON p.id = s.plan_id
WHERE t.type = 'subscription_invoice' AND t.amount > p.price_monthly
GROUP BY c.id, t.id, p.price_monthly
ORDER BY t.created_at DESC;

-- 9. Usage drift — usage_lbs_this_period must equal what the usage log says
--    ORDERS added since the period started (order events only — resets and
--    manual_adjustment rows are bookkeeping, not pounds). Drift means an order's pounds were
--    counted twice (or dropped), which moves the point where overage starts.
--    Found 2026-09-22: Liz Morris, 55 vs 25 (order #14382 counted in two
--    periods). Corrected with a 'manual_adjustment' log row.
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
       s.usage_lbs_this_period,
       (SELECT COALESCE(sum(ul.weight_delta),0) FROM subscription_usage_log ul
         WHERE ul.subscription_id = s.id AND ul.created_at >= s.current_period_start
           AND ul.event_type IN ('order_ready','order_delivered')) logged
FROM subscriptions s JOIN customers c ON c.id = s.customer_id
WHERE s.status = 'active'
  AND abs(s.usage_lbs_this_period - (SELECT COALESCE(sum(ul.weight_delta),0)
        FROM subscription_usage_log ul WHERE ul.subscription_id = s.id
         AND ul.created_at >= s.current_period_start AND ul.event_type IN ('order_ready','order_delivered'))) > 0.5;

-- 10. Cancelled under the OLD webhook with overage on the books and no
--     'final_overage_invoiced' log = a "Final overage" item MAY still be sitting
--     in Stripe, waiting for their next invoice. Check each in Stripe (pending
--     invoice items) and delete any you find. Fixed in stripe-webhook on
--     2026-09-22 so no new ones are made.
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust,
       r.old_overage_amount_due, s.cancelled_at::date,
       EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.customer_id = r.customer_id
                AND s2.created_at > s.cancelled_at) resubscribed
FROM _resync_subscription_overage_20260908 r
JOIN subscriptions s ON s.id = r.id
JOIN customers c ON c.id = r.customer_id
WHERE r.status = 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM subscription_usage_log l
                   WHERE l.subscription_id = r.id AND l.event_type = 'final_overage_invoiced');

-- 11. UNLOGGED usage changes in CLOSED periods. At each period_reset the trigger logs
--     -OLD.usage; that must equal everything logged since the previous reset. A gap
--     means usage changed with no log row. Root cause found 2026-09-22: the admin
--     "Adjust usage" button inserted event_type 'adjustment' (not allowed by the CHECK
--     constraint) and ignored the error, so every staff adjustment was invisible.
--     Fixed in admin-dashboard the same day. At the time of writing: only Jenn
--     Holloway, 1 lb, 2026-07-06 (first period — pre-dates the log). Liz Morris's
--     Sep 8 adjustment was still in an OPEN period and is caught by check 9 instead.
WITH l AS (
  SELECT ul.*, sum(CASE WHEN ul.event_type = 'period_reset' THEN 1 ELSE 0 END)
           OVER (PARTITION BY ul.subscription_id ORDER BY ul.created_at, ul.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) seg
  FROM subscription_usage_log ul
)
SELECT c.first_name_cache||' '||COALESCE(c.last_name_cache,'') cust, r.created_at::date reset_at,
       -r.weight_delta usage_at_reset,
       (SELECT COALESCE(sum(x.weight_delta),0) FROM l x WHERE x.subscription_id = r.subscription_id
         AND COALESCE(x.seg,0) = COALESCE(r.seg,0) AND x.event_type <> 'period_reset') logged
FROM l r
JOIN subscriptions s ON s.id = r.subscription_id
JOIN customers c ON c.id = s.customer_id
WHERE r.event_type = 'period_reset'
  AND abs(-r.weight_delta - (SELECT COALESCE(sum(x.weight_delta),0) FROM l x
        WHERE x.subscription_id = r.subscription_id AND COALESCE(x.seg,0) = COALESCE(r.seg,0)
          AND x.event_type <> 'period_reset')) > 0.5
ORDER BY r.created_at;
