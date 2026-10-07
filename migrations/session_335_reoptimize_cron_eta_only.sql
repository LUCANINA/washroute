-- Session 335 (Oct 7, 2026): the 5-minute background job must stop re-ordering
-- routes while drivers are driving.
--
-- WHY. cron job `reoptimize-active-routes` (*/5) calls reoptimize_active_routes(),
-- which POSTs every live route (driver GPS < 15 min old) to optimize-route. Until
-- now that was a FULL re-optimization: every 5 minutes the stop numbers could be
-- rewritten from wherever the van happened to be. Driver Andres Higuera reported
-- it 2026-10-03 ("the numbers kept reshuffling while I was driving").
--
-- CHANGE. One key added to the request body: 'mode' = 'eta_only'. optimize-route
-- (session 335 version) then recomputes ETAs along the CURRENT order and does not
-- write stop_number. Re-ordering still happens on stop complete/skip (driver app),
-- on stop assignment and on the admin Optimize button.
--
-- SAFE IN EITHER DEPLOY ORDER. The pre-335 optimize-route ignores unknown keys,
-- so applying this first changes nothing until the new function is live.
--
-- Rewritten from pg_get_functiondef() so the signature, SECURITY DEFINER,
-- search_path, the assert_staff() guard and the grants survive byte-for-byte.
-- Rollback: EXECUTE the def saved in _archive.fn_reoptimize_active_routes_20261007.

CREATE TABLE IF NOT EXISTS _archive.fn_reoptimize_active_routes_20261007 AS
  SELECT now() AS saved_at, pg_get_functiondef('public.reoptimize_active_routes'::regproc) AS def;
ALTER TABLE _archive.fn_reoptimize_active_routes_20261007 ENABLE ROW LEVEL SECURITY;

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.reoptimize_active_routes'::regproc);
  v_old text := $s$jsonb_build_object('route_id', rec.route_id, 'driver_lat', rec.driver_lat, 'driver_lng', rec.driver_lng)$s$;
  v_new text := $s$jsonb_build_object('route_id', rec.route_id, 'driver_lat', rec.driver_lat, 'driver_lng', rec.driver_lng, 'mode', 'eta_only')$s$;
  v_hits int;
BEGIN
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'session 335: expected exactly 1 request body in reoptimize_active_routes, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.reoptimize_active_routes'::regproc),
            $s$'mode', 'eta_only'$s$) = 0 THEN
    RAISE EXCEPTION 'session 335: eta_only not present after rewrite';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.reoptimize_active_routes'::regproc),
            $s$assert_staff('reoptimize_active_routes')$s$) = 0 THEN
    RAISE EXCEPTION 'session 335: assert_staff guard lost in rewrite';
  END IF;
END
$mig$;
