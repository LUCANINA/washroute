-- Session 350 (2026-10-19): customer risk status moves from the admin page to the database.
--
-- Why: the admin Customers page recalculated risk_status on EVERY load from
-- `orders where status='delivered'` — an unpaged PostgREST select capped at
-- 1,000 rows (the oldest 1,000 of ~13,800). It then wrote the wrong answers back
-- one row at a time. Result: 6,066 of 6,334 customers marked 'churned',
-- including 489 who had a delivery in the previous 14 days.
--
-- Definition (unchanged from the old client code, plus the CLAUDE.md rule that
-- pre-migration history lives in customers.last_order_at):
--   days_since = now - LATER OF (newest delivered order, customers.last_order_at),
--                falling back to account creation
--   2+ delivered app orders with an average gap >= 7 days → relative:
--       > 3.0 × avg gap = churned, > 1.5 × avg gap = at_risk, else active
--   otherwise → absolute: > 60 days churned, > 30 days at_risk, else active
--
-- Side effects checked (preflight): no trigger, cron job, DB function or edge
-- function sends anything based on risk_status; customers is not in the
-- realtime publication. The protected-column trigger allows it (no JWT = DB job).

CREATE OR REPLACE FUNCTION public.compute_customer_risk_status()
RETURNS TABLE(customer_id uuid, new_status text)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH d AS (
    SELECT o.customer_id, o.created_at,
           lag(o.created_at) OVER (PARTITION BY o.customer_id ORDER BY o.created_at) AS prev
    FROM orders o
    WHERE o.status = 'delivered' AND o.customer_id IS NOT NULL
  ), agg AS (
    SELECT d.customer_id, count(*) AS n, max(d.created_at) AS last_delivered,
           avg(extract(epoch FROM d.created_at - d.prev)) / 86400.0 AS avg_gap_days
    FROM d GROUP BY d.customer_id
  ), base AS (
    SELECT c.id,
           extract(epoch FROM now() - coalesce(greatest(a.last_delivered, c.last_order_at), c.created_at)) / 86400.0 AS days_since,
           coalesce(a.n, 0) AS n, a.avg_gap_days
    FROM customers c LEFT JOIN agg a ON a.customer_id = c.id
  )
  SELECT b.id,
         CASE
           WHEN b.n >= 2 AND b.avg_gap_days >= 7 THEN
             CASE WHEN b.days_since > b.avg_gap_days * 3.0 THEN 'churned'
                  WHEN b.days_since > b.avg_gap_days * 1.5 THEN 'at_risk'
                  ELSE 'active' END
           ELSE
             CASE WHEN b.days_since > 60 THEN 'churned'
                  WHEN b.days_since > 30 THEN 'at_risk'
                  ELSE 'active' END
         END
  FROM base b;
$$;

CREATE OR REPLACE FUNCTION public.refresh_customer_risk_status()
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE customers c
     SET risk_status = r.new_status
    FROM compute_customer_risk_status() r
   WHERE r.customer_id = c.id
     AND c.risk_status IS DISTINCT FROM r.new_status;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Not callable from the apps: only the nightly job (postgres) and service_role.
REVOKE EXECUTE ON FUNCTION public.compute_customer_risk_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compute_customer_risk_status() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.compute_customer_risk_status() TO service_role;
REVOKE EXECUTE ON FUNCTION public.refresh_customer_risk_status() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refresh_customer_risk_status() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.refresh_customer_risk_status() TO service_role;

-- Rollback snapshot of every customer's risk_status before the first correction.
CREATE TABLE IF NOT EXISTS _archive.customers_risk_status_20261019 AS
  SELECT id, risk_status, now() AS snapshot_at FROM public.customers;

-- Nightly at 10:17 UTC (3:17 am Pacific, after the 10:00/10:05 jobs).
SELECT cron.schedule('wr-customer-risk-status', '17 10 * * *', 'SELECT public.refresh_customer_risk_status();');

-- One-time correction.
SELECT public.refresh_customer_risk_status();

-- Rollback:
--   SELECT cron.unschedule('wr-customer-risk-status');
--   UPDATE public.customers c SET risk_status = s.risk_status
--     FROM _archive.customers_risk_status_20261019 s WHERE s.id = c.id;
--   DROP FUNCTION public.refresh_customer_risk_status(); DROP FUNCTION public.compute_customer_risk_status();
