-- session_328c_driver_stop_customer_ids_same_day_only.sql
--
-- WHAT: bound public.driver_stop_customer_ids() to the CURRENT DAY.
--
-- WHY: the function answers "which customers may this driver look up?" and backs the
-- `driver_read_stop_customers` policy on `customers`. It had no date bound, so it returned
-- every customer the driver had EVER served — 790 for our busiest driver, against 43 actually
-- on today's routes — and cost 2,982 ms in the session-328 plan (it surfaced there because the
-- sms_messages policy dragged the customers RLS in with it).
--
-- David, 2026-10-02, asked directly: "In practice there's no need for any driver to look up
-- anything past that same day." That is the product decision this migration encodes. Without it
-- this stays unfixable-by-inspection, because narrowing the window REMOVES access and only the
-- operator can say whether that access is needed.
--
-- MEASURED IMPACT (all 17 drivers with a profile), before applying:
--   customer-visibility grants now ....... 5,784
--   after this change .................... 167
--   removed .............................. 5,617
--   busiest driver ....................... 790 -> 43
--   drivers with 0 visible customers ..... 10 of 17  (they are not on a route today)
--
-- That last line is intended, not a bug: a driver on a day off can no longer look up customers.
-- Practically invisible in the app, because the driver app reads its routes, stops and addresses
-- through SECURITY DEFINER RPCs (get_driver_route_stops / get_driver_stop_addresses /
-- get_driver_override_stops, session 161) which bypass RLS, and it never queries `customers`
-- directly. This only tightens the boundary; it can never widen it.
--
-- SCOPE DISCIPLINE: the four-way driver match (rs.driver_id, r.driver_id, r.pickup_driver_id,
-- r.delivery_driver_id) and the LEFT JOIN are preserved EXACTLY. The only change is the date
-- bound. Narrowing the OR as well would be a second, unrequested behaviour change hidden inside
-- a performance fix — that is how session 309 reversed a legitimate adjustment.
--
-- NOT MERGED with session_328b's driver_today_customer_ids(): that one mirrors the sms_messages
-- policy's narrower two-way match (rs.driver_id / r.driver_id). Collapsing them would silently
-- widen who a driver can read texts for. Two small honest functions beat one that is subtly wrong
-- for one of its callers.

-- Step 1: snapshot (this IS the rollback script)
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_session_328c (
  proname     text        NOT NULL,
  def         text        NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _archive.fn_snapshot_session_328c (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'driver_stop_customer_ids';

-- Step 2: same-day bound
CREATE OR REPLACE FUNCTION public.driver_stop_customer_ids()
RETURNS TABLE(customer_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT o.customer_id
  FROM orders o
  JOIN route_stops rs ON rs.order_id = o.id
  LEFT JOIN routes r ON r.id = rs.route_id
  WHERE (
    rs.driver_id = current_driver_id()
    OR r.driver_id             = current_driver_id()
    OR r.pickup_driver_id      = current_driver_id()
    OR r.delivery_driver_id    = current_driver_id()
  )
  -- session 328c: same day only. See header for the measured impact.
  AND r.run_date = CURRENT_DATE
  AND o.customer_id IS NOT NULL;
$function$;

-- Step 3: grants unchanged from before (authenticated, service_role; never anon)
REVOKE EXECUTE ON FUNCTION public.driver_stop_customer_ids() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_stop_customer_ids() FROM anon;
GRANT  EXECUTE ON FUNCTION public.driver_stop_customer_ids() TO authenticated, service_role;

-- Step 4: assertions — roll back rather than ship a broken boundary
DO $chk$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
  WHERE pronamespace='public'::regnamespace AND proname='driver_stop_customer_ids';

  IF strpos(v_src, 'r.run_date = CURRENT_DATE') = 0 THEN
    RAISE EXCEPTION 'assert failed: date bound not installed';
  END IF;
  -- all four driver columns must survive
  IF strpos(v_src, 'rs.driver_id = current_driver_id()') = 0
     OR strpos(v_src, 'r.driver_id             = current_driver_id()') = 0
     OR strpos(v_src, 'r.pickup_driver_id      = current_driver_id()') = 0
     OR strpos(v_src, 'r.delivery_driver_id    = current_driver_id()') = 0 THEN
    RAISE EXCEPTION 'assert failed: the four-way driver match was altered';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname='driver_stop_customer_ids' AND prosecdef AND provolatile='s'
  ) THEN
    RAISE EXCEPTION 'assert failed: no longer STABLE SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon','public.driver_stop_customer_ids()','EXECUTE') THEN
    RAISE EXCEPTION 'assert failed: anon can execute';
  END IF;
  IF NOT has_function_privilege('authenticated','public.driver_stop_customer_ids()','EXECUTE') THEN
    RAISE EXCEPTION 'assert failed: authenticated cannot execute';
  END IF;
END
$chk$;

-- ROLLBACK
--   DO $$ DECLARE d text; BEGIN
--     SELECT def INTO d FROM _archive.fn_snapshot_session_328c
--      WHERE proname='driver_stop_customer_ids' ORDER BY snapshot_at DESC LIMIT 1;
--     EXECUTE d;
--   END $$;
