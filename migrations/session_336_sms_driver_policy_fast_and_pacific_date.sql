-- session_336_sms_driver_policy_fast_and_pacific_date.sql
--
-- REPORT (Oct 7, 2026): drivers stopped seeing customer text replies in the driver app.
-- Inbound texts were arriving in sms_messages normally; the driver app could not READ them.
--
-- CAUSE 1 — evening texts hidden by a UTC date.
--   driver_read_customer_sms compared routes.run_date to CURRENT_DATE. The database runs on
--   UTC, so from 5 PM Pacific (00:00 UTC) "today" became tomorrow and the whole evening shift
--   saw none of tonight's customers. Oct 6 evening: 4 texts to Axel's route never reached him
--   (incl. a gate code).
-- CAUSE 2 — the policy is slow (session 328, fix written as 328b, never applied).
--   Its subquery reads `orders`, so the entire orders RLS stack is inlined. Measured Oct 7
--   15:00 as a real driver (Eve): 3,277 ms, 209,971 buffers, on a quiet afternoon. Under shift
--   load: 80-180 statement timeouts/hour (8s limit) + realtime RLS checks cancelled
--   ("walrus_rls_stmt ... canceling statement"), so live alerts were dropped too.
--
-- FIX: same semantics as 328b (SECURITY DEFINER helper, never re-enters orders RLS), but
-- "today" is the Pacific date — the business day the routes are planned on.
--
-- ROLLBACK (restores the exact previous policy):
--   ALTER POLICY driver_read_customer_sms ON public.sms_messages
--     USING ((((SELECT current_driver_id()) IS NOT NULL) AND (customer_id IN ( SELECT o.customer_id
--        FROM ((route_stops rs JOIN orders o ON ((o.id = rs.order_id))) JOIN routes r ON ((r.id = rs.route_id)))
--       WHERE (((r.driver_id = (SELECT current_driver_id())) OR (rs.driver_id = (SELECT current_driver_id())))
--         AND (r.run_date = CURRENT_DATE))))));
--   DROP FUNCTION public.driver_today_customer_ids();
-- (also snapshotted into _archive.policy_snapshot_session_336 below)

-- 1. Snapshot the current policy
CREATE TABLE IF NOT EXISTS _archive.policy_snapshot_session_336 (
  tablename text NOT NULL, policyname text NOT NULL, cmd text, roles text, qual text,
  snapshot_at timestamptz NOT NULL DEFAULT now());
INSERT INTO _archive.policy_snapshot_session_336 (tablename, policyname, cmd, roles, qual)
SELECT tablename, policyname, cmd, roles::text, qual FROM pg_policies
WHERE schemaname='public' AND tablename='sms_messages' AND policyname='driver_read_customer_sms';

-- 2. Helper: customers on the calling driver's routes for today's Pacific date.
--    SECURITY DEFINER so orders/route_stops/routes RLS is not re-entered.
--    Safe for `authenticated`: current_driver_id() comes from auth.uid(); a non-driver
--    gets NULL and no rows. Returns only customer UUIDs.
CREATE OR REPLACE FUNCTION public.driver_today_customer_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT DISTINCT o.customer_id
  FROM (SELECT public.current_driver_id() AS id) me
  JOIN public.routes r
    ON r.run_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
  JOIN public.route_stops rs
    ON rs.route_id = r.id
   AND (r.driver_id = me.id OR rs.driver_id = me.id)
  JOIN public.orders o ON o.id = rs.order_id
  WHERE me.id IS NOT NULL
    AND o.customer_id IS NOT NULL;
$fn$;

REVOKE EXECUTE ON FUNCTION public.driver_today_customer_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_today_customer_ids() FROM anon;
GRANT  EXECUTE ON FUNCTION public.driver_today_customer_ids() TO authenticated, service_role;

-- 3. Policy now calls the helper (evaluated once per query as a hashed subplan)
ALTER POLICY driver_read_customer_sms ON public.sms_messages
  USING (customer_id IN (SELECT public.driver_today_customer_ids()));

-- 4. Asserts — roll everything back if the result isn't what we expect
DO $chk$
DECLARE v_qual text;
BEGIN
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='sms_messages' AND policyname='driver_read_customer_sms';
  IF v_qual IS NULL OR strpos(v_qual, 'driver_today_customer_ids') = 0 OR strpos(v_qual, 'orders') > 0 THEN
    RAISE EXCEPTION 'policy not rewritten as expected: %', v_qual;
  END IF;
  IF (SELECT count(*) FROM _archive.policy_snapshot_session_336) = 0 THEN
    RAISE EXCEPTION 'policy snapshot missing';
  END IF;
  IF has_function_privilege('anon', 'public.driver_today_customer_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute driver_today_customer_ids';
  END IF;
END $chk$;
