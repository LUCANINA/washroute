-- session_328b_sms_messages_driver_policy_no_nested_orders_rls.sql
--
-- PROBLEM: 871 statement timeouts in 24h, all on one query, spread across 352 connections,
-- clustered in driver-shift hours. The query is the driver app's Messages load
-- (driver-app/index.html, loadCustomerSms).
--
-- MEASURED, as a real driver with RLS applied (EXPLAIN ANALYZE, warm cache, no contention):
--   Execution Time: 6,607 ms   against a `authenticated` statement_timeout of 8s
--   Buffers: shared hit=300,141  (~2.3 GB of buffer traffic)
-- Add two or three drivers opening Messages at once and it crosses 8s. That is why it is
-- intermittent, why it tracks shift hours, and why it never reproduced in isolation.
--
-- NOTE FOR ANYONE RE-TESTING: running this query as postgres/service_role takes ~10ms,
-- because RLS is bypassed. The cost IS the RLS. Always reproduce with
--   SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims = '{"sub":"<driver profile_id>",...}'
-- or you will measure nothing and conclude the query is fine. (We did, and we were wrong.)
--
-- ROOT CAUSE — recursive RLS, not a slow query.
-- The driver policy on sms_messages is:
--     customer_id IN (SELECT o.customer_id
--                       FROM route_stops rs
--                       JOIN orders o ON o.id = rs.order_id
--                       JOIN routes r ON r.id = rs.route_id
--                      WHERE (r.driver_id = current_driver_id() OR rs.driver_id = current_driver_id())
--                        AND r.run_date = CURRENT_DATE)
-- That subquery reads `orders`, so Postgres inlines the ENTIRE orders RLS stack into the
-- plan for every candidate sms row. From the measured plan:
--   Seq Scan on orders, with the full orders RLS filter ....... 6,459 ms of the 6,607 ms
--     SubPlan 8  (driver_read_assigned_orders, inline) ........ 2,879 ms
--                 Seq Scan route_stops 26,006 rows + Seq Scan routes 2,161 rows, hashed
--     SubPlan 11 (customer_read_own_orders -> customers RLS) .. 3,070 ms
--                 -> driver_stop_customer_ids() .............. 2,982 ms
--     InitPlan 7 / 9  Seq Scan on profiles, twice ............. ~34 ms each
-- One driver opening Messages seq-scans route_stops, routes and profiles, and calls
-- driver_stop_customer_ids() over ALL history.
--
-- FIX: stop the sms_messages policy from touching `orders` at all. The same set of
-- customer ids is produced by a STABLE SECURITY DEFINER function, which bypasses the
-- nested RLS (the established pattern here — driver_stop_customer_ids and
-- pos_session_active already do exactly this). The policy keeps identical semantics.
--
-- EQUIVALENCE PROVEN BEFORE WRITING THIS, across every driver with a profile:
--   old (driver_id, customer_id) pairs .......... 166
--   new (driver_id, customer_id) pairs .......... 166
--   admitted by old but not new ................. 0
--   admitted by new but not old ................. 0
-- The added `o.customer_id IS NOT NULL` changes nothing (NULL never satisfies IN).
--
-- DELIBERATELY OUT OF SCOPE (flagged, not changed here):
--   * driver_stop_customer_ids() has NO date bound — it scans every stop the driver has
--     ever had (2,982 ms, 790 rows). It backs the `customers` policy, so narrowing it to
--     recent dates would remove a driver's access to historical customers. Real, separate,
--     needs a product decision.
--   * The orders policy `driver_read_assigned_orders` does the same join inline instead of
--     calling the SECURITY DEFINER helper, so every other driver-app query that reads
--     orders pays the 2.9s. Same class of fix, wider blast radius.
--   * sms_messages has two permissive policies for authenticated/SELECT (admin + driver);
--     Supabase's advisor flags this. Both are evaluated on every read.

-- ---------------------------------------------------------------------------
-- Step 1: snapshot the current policy (this IS the rollback script)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _archive.policy_snapshot_session_328b (
  tablename   text        NOT NULL,
  policyname  text        NOT NULL,
  cmd         text,
  roles       text,
  qual        text,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _archive.policy_snapshot_session_328b (tablename, policyname, cmd, roles, qual)
SELECT tablename, policyname, cmd, roles::text, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'sms_messages'
  AND policyname = 'driver_read_customer_sms';

-- ---------------------------------------------------------------------------
-- Step 2: the SECURITY DEFINER helper — today's customers for the calling driver
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the orders/route_stops/routes RLS stack is NOT re-entered.
-- Safe to expose to `authenticated`: current_driver_id() is derived from auth.uid(),
-- so a non-driver gets NULL and the function returns no rows. Same shape and exposure
-- as the existing driver_stop_customer_ids().
CREATE OR REPLACE FUNCTION public.driver_today_customer_ids()
RETURNS TABLE(customer_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT o.customer_id
  FROM route_stops rs
  JOIN orders o ON o.id = rs.order_id
  JOIN routes r ON r.id = rs.route_id
  WHERE (
        r.driver_id  = public.current_driver_id()
     OR rs.driver_id = public.current_driver_id()
  )
    AND r.run_date = CURRENT_DATE
    AND o.customer_id IS NOT NULL;
$function$;

REVOKE EXECUTE ON FUNCTION public.driver_today_customer_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_today_customer_ids() FROM anon;
GRANT  EXECUTE ON FUNCTION public.driver_today_customer_ids() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Step 3: swap the policy (atomic — this migration runs in one transaction)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS driver_read_customer_sms ON public.sms_messages;

CREATE POLICY driver_read_customer_sms ON public.sms_messages
  FOR SELECT TO authenticated
  USING (
    (SELECT public.current_driver_id()) IS NOT NULL
    AND customer_id IN (SELECT public.driver_today_customer_ids())
  );

-- ---------------------------------------------------------------------------
-- Step 4: assertions — fail (and roll back) rather than ship a broken boundary
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  v_qual text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = 'driver_today_customer_ids'
      AND p.prosecdef
      AND p.provolatile = 's'
  ) THEN
    RAISE EXCEPTION 'assert failed: driver_today_customer_ids missing or not STABLE SECURITY DEFINER';
  END IF;

  IF has_function_privilege('anon', 'public.driver_today_customer_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert failed: anon can execute driver_today_customer_ids';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.driver_today_customer_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert failed: authenticated cannot execute driver_today_customer_ids';
  END IF;

  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname='public' AND tablename='sms_messages' AND policyname='driver_read_customer_sms';

  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'assert failed: driver_read_customer_sms policy is missing';
  END IF;
  IF strpos(v_qual, 'driver_today_customer_ids') = 0 THEN
    RAISE EXCEPTION 'assert failed: policy does not use the new helper';
  END IF;
  -- the whole point: the policy must no longer reference orders/route_stops directly
  IF strpos(v_qual, 'route_stops') > 0 OR strpos(v_qual, 'FROM orders') > 0 THEN
    RAISE EXCEPTION 'assert failed: policy still joins orders/route_stops inline';
  END IF;

  -- the admin policy must survive untouched
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='sms_messages' AND policyname='admin_all_sms_messages'
  ) THEN
    RAISE EXCEPTION 'assert failed: admin_all_sms_messages policy disappeared';
  END IF;
END
$chk$;

-- ---------------------------------------------------------------------------
-- ROLLBACK
--   DROP POLICY IF EXISTS driver_read_customer_sms ON public.sms_messages;
--   CREATE POLICY driver_read_customer_sms ON public.sms_messages
--     FOR SELECT TO authenticated
--     USING ( <qual from _archive.policy_snapshot_session_328b> );
--   DROP FUNCTION IF EXISTS public.driver_today_customer_ids();
-- ---------------------------------------------------------------------------
