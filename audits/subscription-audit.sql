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

-- 7. TREND — churn shape.
WITH c AS (
  SELECT s.id,
    round(extract(epoch FROM (s.cancelled_at - s.signup_date))/86400.0) days_lasted,
    (SELECT count(*) FROM orders o WHERE o.subscription_id = s.id AND o.status = 'delivered') delivered
  FROM subscriptions s WHERE s.status = 'cancelled'
)
SELECT count(*) cancelled, round(avg(days_lasted)) avg_days,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_lasted)) median_days,
       count(*) FILTER (WHERE days_lasted <= 35) churned_in_first_period,
       count(*) FILTER (WHERE delivered = 0) never_used_it
FROM c;
