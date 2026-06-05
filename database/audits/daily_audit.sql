-- ════════════════════════════════════════════════════════════════════
-- WashRoute Daily Audit (Session 167)
-- Run this every morning. Each block returns either zero rows (healthy)
-- or a row per issue (investigate).
--
-- Usage from psql or Supabase SQL editor:
--   \i database/audits/daily_audit.sql
-- Or load + execute each block manually.
--
-- See washroute-audit skill for context on each check.
-- ════════════════════════════════════════════════════════════════════


-- 1. Duplicate services that could poison client-side .find() — HOTFIX class (session 167)
-- Expected: 0 rows. Any output = at least one client-side .find() will pick the wrong row.
SELECT 'CHECK 1 — duplicate services' AS check_name;
SELECT * FROM audit_duplicate_services();


-- 2. Orphan route_stops (route_id no longer exists)
-- Expected: 0 rows.
SELECT 'CHECK 2 — orphan route_stops' AS check_name;
SELECT rs.id, rs.order_id, rs.route_id, rs.stop_type, rs.status
FROM route_stops rs
LEFT JOIN routes r ON r.id = rs.route_id
WHERE rs.route_id IS NOT NULL AND r.id IS NULL;


-- 3. Unpaid delivered orders (billing_status not 'paid' but order status is delivered)
-- Expected: 0 rows. Any output = customer received service without payment recorded.
SELECT 'CHECK 3 — unpaid delivered orders' AS check_name;
SELECT id, order_number, customer_id, billing_status, total_amount, actual_delivery_at
FROM orders
WHERE status = 'delivered'
  AND billing_status IS DISTINCT FROM 'paid'
  AND billing_status IS DISTINCT FROM 'refunded'
  AND actual_delivery_at > NOW() - INTERVAL '14 days'
ORDER BY actual_delivery_at DESC;


-- 4. Health alerts in the last 24 hours
-- Expected: heartbeat rows only. Any 'critical' severity = needs investigation.
SELECT 'CHECK 4 — recent health alerts' AS check_name;
SELECT created_at, alert_type, severity, message, sent_sms
FROM _health_alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND alert_type != 'heartbeat'
ORDER BY created_at DESC;


-- 5. Subscriptions where DB usage > 0 lbs but no completed orders this cycle
-- Expected: 0 rows. Indicates trigger may have fired but order was cancelled.
SELECT 'CHECK 5 — subscription usage without orders' AS check_name;
SELECT
  s.id, s.customer_id, s.usage_lbs_this_period, s.pickups_this_period,
  s.current_period_start, s.current_period_end
FROM subscriptions s
WHERE s.status = 'active'
  AND s.usage_lbs_this_period > 0
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.subscription_id = s.id
      AND o.status IN ('ready_for_delivery', 'out_for_delivery', 'delivered')
      AND o.created_at >= s.current_period_start
  );


-- 6. customer_transactions ledger balance check — net = 0 per customer for refunds
-- Expected: 0 rows where credit_use sum > credit_refund sum + credit balance
-- (Catches orphaned credit applications.)
SELECT 'CHECK 6 — credit ledger imbalance' AS check_name;
SELECT
  customer_id,
  SUM(CASE WHEN type = 'credit_use'    THEN amount ELSE 0 END) AS used,
  SUM(CASE WHEN type = 'credit_refund' THEN amount ELSE 0 END) AS refunded,
  SUM(CASE WHEN type = 'credit_add'    THEN amount ELSE 0 END) AS added
FROM customer_transactions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY customer_id
HAVING SUM(CASE WHEN type = 'credit_use' THEN amount ELSE 0 END)
     - SUM(CASE WHEN type = 'credit_refund' THEN amount ELSE 0 END)
     > (SELECT COALESCE(MAX(credits), 0) FROM customers c WHERE c.id = customer_transactions.customer_id) + 0.01;


-- 7. RPC warnings in the last 24h (silent failures we want to surface)
-- Expected: light. Spikes indicate something is silently wrong.
SELECT 'CHECK 7 — recent RPC warnings' AS check_name;
SELECT rpc_name, warning_code, COUNT(*) AS occurrences, MAX(created_at) AS most_recent
FROM _rpc_warnings
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY rpc_name, warning_code
ORDER BY occurrences DESC;


-- 8. Customers with stripe_customer_id but no saved card (and no recent activity)
-- Cleanup candidate. Not necessarily a bug.
SELECT 'CHECK 8 — Stripe customers without cards (informational)' AS check_name;
SELECT id, first_name_cache, email_cache, stripe_customer_id, created_at
FROM customers
WHERE stripe_customer_id IS NOT NULL
  AND stripe_default_payment_method_id IS NULL
  AND last_order_at < NOW() - INTERVAL '60 days'
LIMIT 20;


-- 9. Stripe→DB seam health (session 168, A5)
-- Expected: 0 rows. Any output = an active subscription has NO invoice recorded
-- for its current period — the signature of stripe-webhook signing-secret drift
-- (the class that forced the June 2 backfill). The nightly-smoke-test runs this
-- same check and SMS-alerts on any rows.
SELECT 'CHECK 9 — active subscription missing invoice (Stripe seam)' AS check_name;
SELECT * FROM audit_subscriptions_missing_invoice();
