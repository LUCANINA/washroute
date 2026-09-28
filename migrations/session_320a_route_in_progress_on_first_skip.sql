-- Session 320a — recompute_route_counters: a route whose first finished stop is a driver
-- skip moves scheduled -> in_progress (was left 'scheduled'). Otherwise identical to 320.
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
    WHEN r.status = 'cancelled'                               THEN r.status
    WHEN c.total > 0 AND c.open = 0                           THEN 'complete'
    WHEN v_done > 0 AND r.status IN ('scheduled','complete')  THEN 'in_progress'
    WHEN r.status = 'complete'                                THEN 'scheduled'
    ELSE r.status
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
REVOKE EXECUTE ON FUNCTION public.recompute_route_counters(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.recompute_route_counters(uuid) TO service_role;
