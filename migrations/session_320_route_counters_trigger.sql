-- Session 320 — Issue #414: route stop counters derived from the real stop list.
--
-- routes.total_stops / completed_stops were hand-maintained (+1/-1 in ~6 functions and
-- the admin client). Any path that forgot to bump them drifted: 148 of 312 routes in the
-- last 30 days had the wrong total, 22 had every stop done but were never marked complete.
--
-- After this migration the counters are ALWAYS recomputed from route_stops:
--   total_stops     = stops the route actually has to run (excludes stops cancelled
--                     before the driver got there: status 'skipped' with no driver skip)
--   completed_stops = status 'complete'
--   skipped_stops   = NEW — driver couldn't complete: skip_route_stop (driver_skipped_at set)
--                     or status 'failed' (admin marked pickup/delivery failed)
-- and route status / started_at / completed_at follow from those counts.
--
-- Pieces:
--   1. route_stops.driver_skipped_at — set by skip_route_stop, cleared when a stop reopens.
--   2. routes.skipped_stops.
--   3. _route_stop_tally(route) + recompute_route_counters(route).
--   4. AFTER trigger on route_stops (insert/delete/status/route_id/completed_at) → recompute.
--   5. BEFORE trigger on routes: any write to a counter column is replaced by the real count,
--      so the legacy "+1" writes in auto_route_order etc. and the admin client can't drift it.
--   6. skip_route_stop stamps driver_skipped_at.
--   7. reconcile_order_stops no longer REUSES a driver-skipped/failed stop on reschedule
--      (it moved the stop — and the skip — off the route it happened on). Inserts a new stop.
--   8. Backfill driver_skipped_at on historical driver skips (route_stops only — no route
--      rows touched here; the route recount is a separate, preflighted step).

BEGIN;

-- 0. Rollback snapshots
INSERT INTO _archive._backup_function_defs (saved_at, function_name, definition)
SELECT now(), 'session_320:' || p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('skip_route_stop', 'reconcile_order_stops');

-- 1 + 2. Columns
ALTER TABLE public.route_stops ADD COLUMN IF NOT EXISTS driver_skipped_at timestamptz;
ALTER TABLE public.routes      ADD COLUMN IF NOT EXISTS skipped_stops integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.route_stops.driver_skipped_at IS
  'Set when the driver could not complete the stop (skip_route_stop). NULL on a skipped stop = cancelled, not a driver skip.';
COMMENT ON COLUMN public.routes.skipped_stops IS
  'Stops the driver could not complete (driver skip or failed). Maintained by trigger — do not write.';

-- 3a. Tally (pure read)
CREATE OR REPLACE FUNCTION public._route_stop_tally(p_route_id uuid)
RETURNS TABLE (total int, completed int, skipped int, open int,
               first_done_at timestamptz, last_done_at timestamptz)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $f$
  WITH s AS (
    SELECT status,
           (status = 'skipped' AND driver_skipped_at IS NULL) AS cancelled,
           CASE status
             WHEN 'complete' THEN completed_at
             WHEN 'failed'   THEN updated_at
             WHEN 'skipped'  THEN driver_skipped_at
           END AS done_at
    FROM route_stops WHERE route_id = p_route_id
  )
  SELECT
    (COUNT(*) FILTER (WHERE NOT cancelled))::int,
    (COUNT(*) FILTER (WHERE status = 'complete'))::int,
    (COUNT(*) FILTER (WHERE status IN ('skipped','failed') AND NOT cancelled))::int,
    (COUNT(*) FILTER (WHERE status IN ('pending','en_route')))::int,
    MIN(done_at) FILTER (WHERE NOT cancelled),
    MAX(done_at) FILTER (WHERE NOT cancelled)
  FROM s;
$f$;

-- 3b. Recompute one route (locks the route row first so concurrent stop changes serialize)
CREATE OR REPLACE FUNCTION public.recompute_route_counters(p_route_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  r      routes%ROWTYPE;
  c      record;
  v_done int;
  v_status text;
  v_started timestamptz;
  v_completed timestamptz;
BEGIN
  IF p_route_id IS NULL THEN RETURN; END IF;
  SELECT * INTO r FROM routes WHERE id = p_route_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO c FROM public._route_stop_tally(p_route_id);
  v_done := c.completed + c.skipped;

  v_status := CASE
    WHEN r.status = 'cancelled'            THEN r.status
    WHEN c.total > 0 AND c.open = 0        THEN 'complete'
    WHEN r.status = 'complete' AND v_done > 0 THEN 'in_progress'   -- reopened
    WHEN r.status = 'complete'             THEN 'scheduled'
    ELSE r.status                                                  -- never demote in_progress/scheduled
  END;

  v_started := CASE WHEN v_done > 0 THEN COALESCE(r.started_at, c.first_done_at) ELSE r.started_at END;
  v_completed := CASE
    WHEN r.status = 'cancelled'  THEN r.completed_at
    WHEN v_status = 'complete'   THEN COALESCE(r.completed_at, c.last_done_at, now())
    ELSE NULL
  END;

  UPDATE routes SET
    total_stops     = c.total,
    completed_stops = c.completed,
    skipped_stops   = c.skipped,
    status          = v_status,
    started_at      = v_started,
    completed_at    = v_completed
  WHERE id = p_route_id
    AND (total_stops, completed_stops, skipped_stops, status, started_at, completed_at)
        IS DISTINCT FROM (c.total, c.completed, c.skipped, v_status, v_started, v_completed);
END;
$f$;

-- 4. route_stops → recompute affected route(s), ascending id order
CREATE OR REPLACE FUNCTION public.trg_route_stops_recompute_route()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_old uuid; v_new uuid; v_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := OLD.route_id; END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN v_new := NEW.route_id; END IF;
  FOR v_id IN SELECT DISTINCT x FROM unnest(ARRAY[v_old, v_new]) x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM public.recompute_route_counters(v_id);
  END LOOP;
  RETURN NULL;
END;
$f$;

DROP TRIGGER IF EXISTS trg_recompute_route_counters ON public.route_stops;
CREATE TRIGGER trg_recompute_route_counters
  AFTER INSERT OR DELETE OR UPDATE OF status, route_id, completed_at ON public.route_stops
  FOR EACH ROW EXECUTE FUNCTION public.trg_route_stops_recompute_route();

-- 1b. Reopened stop is no longer a driver skip
CREATE OR REPLACE FUNCTION public.trg_clear_driver_skip_on_reopen()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $f$
BEGIN
  NEW.driver_skipped_at := NULL;
  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS trg_clear_driver_skip_on_reopen ON public.route_stops;
CREATE TRIGGER trg_clear_driver_skip_on_reopen
  BEFORE UPDATE OF status ON public.route_stops
  FOR EACH ROW
  WHEN (NEW.status NOT IN ('skipped','failed') AND NEW.driver_skipped_at IS NOT NULL)
  EXECUTE FUNCTION public.trg_clear_driver_skip_on_reopen();

-- 5. routes: counter columns can't be written by hand
CREATE OR REPLACE FUNCTION public.trg_routes_enforce_counters()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE c record;
BEGIN
  SELECT * INTO c FROM public._route_stop_tally(NEW.id);
  NEW.total_stops     := c.total;
  NEW.completed_stops := c.completed;
  NEW.skipped_stops   := c.skipped;
  RETURN NEW;
END;
$f$;

DROP TRIGGER IF EXISTS trg_routes_enforce_counters ON public.routes;
CREATE TRIGGER trg_routes_enforce_counters
  BEFORE INSERT OR UPDATE OF total_stops, completed_stops, skipped_stops ON public.routes
  FOR EACH ROW EXECUTE FUNCTION public.trg_routes_enforce_counters();

-- 6 + 7. Patch existing functions in place (signature/defaults preserved byte-for-byte)
DO $do$
DECLARE
  v_def text; v_new text;
  v_needle text; v_repl text;
BEGIN
  -- skip_route_stop: stamp driver_skipped_at
  SELECT pg_get_functiondef('public.skip_route_stop'::regproc) INTO v_def;
  v_needle := $n$    status       = 'skipped',
    driver_notes = v_new_notes,$n$;
  v_repl   := $n$    status            = 'skipped',
    driver_skipped_at = NOW(),
    driver_notes      = v_new_notes,$n$;
  IF (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle) <> 1 THEN
    RAISE EXCEPTION 'skip_route_stop: needle not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_needle, v_repl);

  -- reconcile_order_stops: only reuse CANCELLED stops, never driver skips / failures
  SELECT pg_get_functiondef('public.reconcile_order_stops'::regproc) INTO v_def;
  v_needle := $n$WHERE order_id = p_order_id AND stop_type = p_leg AND status IN ('skipped','failed')
    ORDER BY (route_id = v_run_id) DESC, created_at DESC$n$;
  v_repl   := $n$WHERE order_id = p_order_id AND stop_type = p_leg
      AND status = 'skipped' AND driver_skipped_at IS NULL   -- session 320: keep driver skips/failures on the route they happened on
    ORDER BY (route_id = v_run_id) DESC, created_at DESC$n$;
  IF (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle) <> 1 THEN
    RAISE EXCEPTION 'reconcile_order_stops: needle not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_needle, v_repl);
END
$do$;

-- Assert the patches landed
DO $do$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid='public.skip_route_stop'::regproc), 'driver_skipped_at = NOW()') = 0 THEN
    RAISE EXCEPTION 'skip_route_stop patch missing';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid='public.reconcile_order_stops'::regproc), 'AND status = ''skipped'' AND driver_skipped_at IS NULL') = 0 THEN
    RAISE EXCEPTION 'reconcile_order_stops patch missing';
  END IF;
END
$do$;

-- Grants (internal helpers; triggers fire regardless of EXECUTE grants)
REVOKE EXECUTE ON FUNCTION public._route_stop_tally(uuid)             FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recompute_route_counters(uuid)      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_route_stops_recompute_route()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_clear_driver_skip_on_reopen()   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_routes_enforce_counters()       FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public._route_stop_tally(uuid)             TO service_role;
GRANT  EXECUTE ON FUNCTION public.recompute_route_counters(uuid)      TO service_role;
GRANT  EXECUTE ON FUNCTION public.trg_route_stops_recompute_route()   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.trg_clear_driver_skip_on_reopen()   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.trg_routes_enforce_counters()       TO authenticated, service_role;

-- 8. Backfill driver_skipped_at on historical driver skips.
--    Signal: a pickup_failed/delivery_failed order event on the route's run date (matching leg),
--    or the driver app's "Can't complete:" note. updated_at trigger paused so the original
--    timestamps survive (they date the skip).
--    TODAY'S ROUTES ONLY here: these stops are in drivers' live lists, so the realtime echo
--    is patched in place. Historical stops are backfilled after hours in session_320b —
--    a daytime burst of past-stop events makes the driver app reload mid-route.
ALTER TABLE public.route_stops DISABLE TRIGGER trg_route_stops_updated_at;
UPDATE public.route_stops s
   SET driver_skipped_at = s.updated_at
  FROM public.routes r
 WHERE r.id = s.route_id
   AND r.run_date = (now() AT TIME ZONE 'America/Los_Angeles')::date
   AND s.status = 'skipped'
   AND s.driver_skipped_at IS NULL
   AND (
     COALESCE(s.driver_notes, '') ILIKE '%can''t complete%'
     OR EXISTS (
       SELECT 1 FROM public.order_events e
        WHERE e.order_id = s.order_id
          AND e.new_value = CASE WHEN s.stop_type = 'pickup' THEN 'pickup_failed' ELSE 'delivery_failed' END
          AND (e.created_at AT TIME ZONE 'America/Los_Angeles')::date = r.run_date)
   );
ALTER TABLE public.route_stops ENABLE TRIGGER trg_route_stops_updated_at;

COMMIT;

-- ROLLBACK (if ever needed):
--   DROP TRIGGER trg_recompute_route_counters   ON public.route_stops;
--   DROP TRIGGER trg_clear_driver_skip_on_reopen ON public.route_stops;
--   DROP TRIGGER trg_routes_enforce_counters     ON public.routes;
--   -- restore the two patched functions:
--   --   SELECT definition FROM _archive._backup_function_defs
--   --    WHERE function_name IN ('session_320:skip_route_stop','session_320:reconcile_order_stops');
--   --   and EXECUTE each.
--   DROP FUNCTION public.trg_route_stops_recompute_route(), public.trg_clear_driver_skip_on_reopen(),
--                 public.trg_routes_enforce_counters(), public.recompute_route_counters(uuid),
--                 public._route_stop_tally(uuid);
--   ALTER TABLE public.routes DROP COLUMN skipped_stops;         -- only after admin UI no longer selects it
--   ALTER TABLE public.route_stops DROP COLUMN driver_skipped_at;
