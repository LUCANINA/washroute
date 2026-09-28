-- Session 320b — AFTER-HOURS backfill (run ~11:30pm PT, when no driver is mid-route).
-- 1. Mark historical driver skips (driver_skipped_at) — same signal as 320 step 8, all dates.
-- 2. Recount every route not already recounted in the daytime pass.
-- Preflight (2026-09-28): no trigger/cron on routes or route_stops reaches SMS/email; the only
-- route cron (reoptimize_active_routes) ignores status/counters. Customers contacted: 0.
-- Rollback: _archive.routes_counters_s320 holds every route's prior counters/status/timestamps.

ALTER TABLE public.route_stops DISABLE TRIGGER trg_route_stops_updated_at;
UPDATE public.route_stops s
   SET driver_skipped_at = s.updated_at
  FROM public.routes r
 WHERE r.id = s.route_id
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

SELECT count(*) FROM (SELECT public.recompute_route_counters(id) FROM public.routes) x;
