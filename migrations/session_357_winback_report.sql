-- Session 357 — Oct 22, 2026
-- Admin → Reports → Retention gets a "Win-back credits" card. One row per batch.
--
-- Why an RPC and not a client-side computation: the Retention tab already pages
-- thousands of orders into the browser, and this would add winback_grants, orders
-- and customer_transactions on top. More importantly, the daily win-back report
-- and this card must agree on what "came back" means — one definition, one place.
--
-- Definitions, fixed here so nothing downstream can drift:
--   came_back   = customers with at least one post-grant order that was really
--                 picked up. cancelled / skipped / pickup_failed do not count.
--   repeat      = of those, the ones with 2+ such orders. This is the number that
--                 says whether a win-back is a save or a one-off.
--   credit_used = net credit (use - refund) spent on post-grant orders that have
--                 been DELIVERED. Deliberately the same set of orders as
--                 gross_delivered: credit is applied at billing, so counting all
--                 credit spent against delivered-only revenue made net_cash swing
--                 negative purely because orders were mid-route (WB-2026-W43 read
--                 -$60 on the first draft with nothing actually wrong).
--   credit_committed = the same, on post-grant orders not yet delivered. Spent,
--                 but its revenue hasn't landed yet. Shown so the gap is visible
--                 rather than silently missing.
--   credit_left = granted - (used + committed) - expired. Money still available.
--   subscription_revenue = subscription_invoice transactions after the grant,
--                 reported SEPARATELY and never folded into net_cash. Subscription
--                 orders bill $0 per order, so a customer who converts otherwise
--                 looks like $0 of gross. Two have converted so far ($275 each),
--                 and the delivered-order figure cannot see either of them.
--
-- Read-only. No DDL on existing objects, no writes.
CREATE OR REPLACE FUNCTION public.winback_report()
RETURNS TABLE (
  batch                text,
  pool                 text,
  first_grant_on       date,
  last_grant_on        date,
  sent                 integer,
  still_pending        integer,
  granted_amount       numeric,
  came_back            integer,
  repeat_customers     integer,
  delivered_orders     integer,
  in_flight_orders     integer,
  gross_delivered      numeric,
  credit_used          numeric,
  net_cash             numeric,
  credit_committed     numeric,
  credit_left          numeric,
  subscription_revenue numeric,
  stuck_rows           integer,
  sms_failed           integer,
  email_failed         integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Deliberately NOT assert_staff(): that admits drivers, and this function is
  -- SECURITY DEFINER, so a driver calling it directly would see the whole
  -- programme's money — more than RLS lets them see on the Retention tab today.
  -- Reports are an admin/manager surface (same bar as AC_ROLES in the dashboard).
  -- No JWT claims at all means a direct Postgres connection (pg_cron, psql, the
  -- daily win-back report over MCP). Those are already fully privileged and carry
  -- no auth.uid() to check, so let them through — same first branch as
  -- assert_staff(). Without this the daily report cannot call its own RPC, which
  -- defeats the point of having one shared definition.
  IF COALESCE(current_setting('request.jwt.claims', true), '') <> ''
     AND COALESCE(auth.role(), '') <> 'service_role'
     AND NOT EXISTS (SELECT 1 FROM public.profiles
                      WHERE id = auth.uid() AND role IN ('admin','manager')) THEN
    RAISE EXCEPTION 'Not authorized to call winback_report'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH per_grant AS (
    SELECT g.batch,
           g.customer_id,
           g.amount,
           g.granted_at,
           g.grant_status,
           g.email_status,
           COALESCE(g.expired_amount, 0) AS expired_amount,
           (SELECT count(*) FROM orders o
             WHERE o.customer_id = g.customer_id AND o.created_at > g.granted_at
               AND o.status NOT IN ('cancelled','skipped','pickup_failed')) AS real_orders,
           (SELECT count(*) FROM orders o
             WHERE o.customer_id = g.customer_id AND o.created_at > g.granted_at
               AND o.status = 'delivered') AS del_orders,
           (SELECT count(*) FROM orders o
             WHERE o.customer_id = g.customer_id AND o.created_at > g.granted_at
               AND o.status IN ('scheduled','picked_up','processing','folding',
                                'ready_for_delivery','on_hold')) AS flight_orders,
           (SELECT COALESCE(sum(o.total_amount - COALESCE(o.amount_refunded,0)),0) FROM orders o
             WHERE o.customer_id = g.customer_id AND o.created_at > g.granted_at
               AND o.status = 'delivered') AS del_gross,
           -- credit spent on the delivered orders (same set as del_gross)
           (SELECT COALESCE(sum(CASE WHEN t.type='credit_use' THEN t.amount ELSE -t.amount END),0)
              FROM customer_transactions t
              JOIN orders o ON o.id = t.order_id
             WHERE t.customer_id = g.customer_id
               AND t.type IN ('credit_use','credit_refund')
               AND o.created_at > g.granted_at
               AND o.status = 'delivered') AS used_delivered,
           -- credit spent on post-grant orders still in flight
           (SELECT COALESCE(sum(CASE WHEN t.type='credit_use' THEN t.amount ELSE -t.amount END),0)
              FROM customer_transactions t
              JOIN orders o ON o.id = t.order_id
             WHERE t.customer_id = g.customer_id
               AND t.type IN ('credit_use','credit_refund')
               AND o.created_at > g.granted_at
               AND o.status <> 'delivered') AS used_flight,
           (SELECT COALESCE(sum(t.amount),0) FROM customer_transactions t
             WHERE t.customer_id = g.customer_id AND t.created_at >= g.granted_at
               AND t.type = 'subscription_invoice') AS sub_rev,
           (SELECT count(*) FROM sms_messages s
             WHERE s.customer_id = g.customer_id AND s.direction = 'outbound'
               AND s.created_at >= g.granted_at - interval '5 minutes'
               AND s.status IN ('failed','undelivered')) AS sms_bad
      FROM winback_grants g
  ),
  capped AS (
    -- never let an unrelated later credit report more spend than this programme gave
    SELECT p.*,
           LEAST(GREATEST(p.used_delivered, 0), p.amount) AS used_del_c,
           LEAST(GREATEST(p.used_flight, 0), GREATEST(p.amount - GREATEST(p.used_delivered,0), 0)) AS used_fl_c
      FROM per_grant p
  )
  SELECT c.batch,
         CASE WHEN c.batch = 'WB-2026-10-A'   THEN 'first batch'
              WHEN c.batch LIKE 'WB-____-W__' THEN 'app'
              WHEN c.batch LIKE 'WBS-%'       THEN 'Starchup'
              ELSE 'unrecognised' END::text,
         min(c.granted_at AT TIME ZONE 'America/Los_Angeles')::date,
         max(c.granted_at AT TIME ZONE 'America/Los_Angeles')::date,
         count(*) FILTER (WHERE c.grant_status = 'granted')::integer,
         count(*) FILTER (WHERE c.grant_status = 'pending')::integer,
         -- the real total handed out. Never let the UI assume $20: the amount is a
         -- winback_enroll parameter, and a hardcoded figure is the referral-amount
         -- bug (session 293) waiting to happen again.
         ROUND(COALESCE(sum(c.amount) FILTER (WHERE c.grant_status = 'granted'),0), 2),
         count(*) FILTER (WHERE c.grant_status = 'granted' AND c.real_orders > 0)::integer,
         count(*) FILTER (WHERE c.grant_status = 'granted' AND c.real_orders >= 2)::integer,
         COALESCE(sum(c.del_orders)    FILTER (WHERE c.grant_status = 'granted'),0)::integer,
         COALESCE(sum(c.flight_orders) FILTER (WHERE c.grant_status = 'granted'),0)::integer,
         ROUND(COALESCE(sum(c.del_gross)   FILTER (WHERE c.grant_status = 'granted'),0), 2),
         ROUND(COALESCE(sum(c.used_del_c)  FILTER (WHERE c.grant_status = 'granted'),0), 2),
         ROUND(COALESCE(sum(c.del_gross - c.used_del_c) FILTER (WHERE c.grant_status = 'granted'),0), 2),
         ROUND(COALESCE(sum(c.used_fl_c)   FILTER (WHERE c.grant_status = 'granted'),0), 2),
         ROUND(COALESCE(sum(c.amount - c.used_del_c - c.used_fl_c - c.expired_amount)
                          FILTER (WHERE c.grant_status = 'granted'),0), 2),
         ROUND(COALESCE(sum(c.sub_rev)     FILTER (WHERE c.grant_status = 'granted'),0), 2),
         (SELECT count(*) FROM winback_grants w
           WHERE w.batch = c.batch
             AND ( (w.grant_status = 'granting' AND COALESCE(w.granted_at, w.created_at) < now() - interval '1 hour')
                OR (w.sms_status  = 'sending'  AND COALESCE(w.granted_at, w.created_at) < now() - interval '1 hour')
                OR (w.grant_status = 'pending' AND w.release_at IS NOT NULL
                    AND w.release_at < now() - interval '1 day') ))::integer,
         count(*) FILTER (WHERE c.grant_status = 'granted' AND c.sms_bad > 0)::integer,
         count(*) FILTER (WHERE c.grant_status = 'granted' AND c.email_status = 'failed')::integer
    FROM capped c
   GROUP BY c.batch
   ORDER BY max(c.granted_at) DESC NULLS LAST, c.batch DESC;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.winback_report() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.winback_report() FROM anon;
GRANT  EXECUTE ON FUNCTION public.winback_report() TO authenticated, service_role;

-- Rollback:
-- DROP FUNCTION public.winback_report();
