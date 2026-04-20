-- Session 131 — Phase 3: Booking Alternatives
-- Adds an RPC that returns the N nearest AVAILABLE booking slots around a preferred
-- (date, time) for a given zone and stop_type. Used by the customer app when the
-- customer's first-pick slot is full: instead of hiding it or silently overriding,
-- show them 3 real options they can tap.
--
-- Rules (mirrors get_slot_availability so the numbers stay consistent):
--   - Iterate route_templates active in the zone AND scheduled for the candidate day
--   - Compute each sub-window by arrival_window_hours
--   - sub_window_limit = FLOOR(stop_limit / num_subs)
--   - active_stops counted for the requested stop_type only
--   - Only return rows where active_stops < sub_window_limit (i.e. still open)
--   - Order by abs minute-distance to (preferred_date + preferred_time)
--   - Limit to p_limit rows
--
-- Reversibility:
--   DROP FUNCTION IF EXISTS public.get_nearest_available_slots(uuid, date, time, text, int, int);

CREATE OR REPLACE FUNCTION public.get_nearest_available_slots(
  p_zone_id UUID,
  p_preferred_date DATE,
  p_preferred_time TIME,
  p_stop_type TEXT,             -- 'pickup' or 'delivery'
  p_limit INT DEFAULT 3,
  p_day_radius INT DEFAULT 2    -- search ±N days around preferred_date
)
RETURNS TABLE(
  run_date DATE,
  template_id UUID,
  template_name TEXT,
  sub_window_start TIME,
  sub_window_end TIME,
  sub_window_limit INT,
  active_stops BIGINT,
  distance_minutes INT
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
AS $function$
DECLARE
  v_day DATE;
  v_tmpl RECORD;
  v_step_mins INT;
  v_total_hours NUMERIC;
  v_num_subs INT;
  v_sub_limit INT;
  v_from_mins INT;
  v_to_mins INT;
  v_sw_start TIME;
  v_sw_end TIME;
  v_count BIGINT;
  v_preferred_total_mins INT;
  v_candidate_total_mins INT;
  v_distance INT;
BEGIN
  -- Guard against bad input
  IF p_stop_type NOT IN ('pickup','delivery') THEN
    RAISE EXCEPTION 'p_stop_type must be ''pickup'' or ''delivery''';
  END IF;
  IF p_limit <= 0 OR p_limit > 20 THEN
    p_limit := 3;
  END IF;
  IF p_day_radius < 0 OR p_day_radius > 7 THEN
    p_day_radius := 2;
  END IF;

  v_preferred_total_mins :=
    (EXTRACT(EPOCH FROM p_preferred_time)::INT / 60)
    + 0;  -- day offset added per candidate below

  -- Build a working set table so we can sort and limit after.
  CREATE TEMP TABLE IF NOT EXISTS _nearest_slots_tmp (
    run_date DATE,
    template_id UUID,
    template_name TEXT,
    sub_window_start TIME,
    sub_window_end TIME,
    sub_window_limit INT,
    active_stops BIGINT,
    distance_minutes INT
  ) ON COMMIT DROP;
  TRUNCATE _nearest_slots_tmp;

  FOR v_day IN
    SELECT generate_series(
      p_preferred_date - p_day_radius,
      p_preferred_date + p_day_radius,
      INTERVAL '1 day'
    )::DATE
  LOOP
    FOR v_tmpl IN
      SELECT rt.id, rt.name, rt.window_start AS ws, rt.window_end AS we,
             rt.arrival_window_hours, rt.stop_limit
      FROM route_templates rt
      WHERE rt.zone_id = p_zone_id
        AND rt.is_active = TRUE
        AND (EXTRACT(ISODOW FROM v_day)::INT - 1) = ANY(rt.schedule_days)
    LOOP
      v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
      v_total_hours := EXTRACT(EPOCH FROM (v_tmpl.we - v_tmpl.ws)) / 3600;
      v_num_subs := GREATEST(1, FLOOR(v_total_hours * 60 / v_step_mins)::INT);
      v_sub_limit := CASE WHEN v_tmpl.stop_limit IS NOT NULL
                          THEN FLOOR(v_tmpl.stop_limit::NUMERIC / v_num_subs)::INT
                          ELSE NULL END;

      -- If there's no limit on this template we can't say it's "full" either —
      -- skip it for the alternatives flow.
      IF v_sub_limit IS NULL THEN
        CONTINUE;
      END IF;

      v_from_mins := EXTRACT(EPOCH FROM v_tmpl.ws)::INT / 60;

      WHILE v_from_mins + v_step_mins <= EXTRACT(EPOCH FROM v_tmpl.we)::INT / 60 LOOP
        v_to_mins := v_from_mins + v_step_mins;
        v_sw_start := make_time(v_from_mins / 60, v_from_mins % 60, 0);
        v_sw_end   := make_time(v_to_mins / 60, v_to_mins % 60, 0);

        -- Count stops of the requested type in this sub-window
        IF p_stop_type = 'pickup' THEN
          SELECT COUNT(*) INTO v_count
          FROM route_stops rs
          JOIN routes r ON rs.route_id = r.id
          JOIN orders o ON rs.order_id = o.id
          WHERE r.template_id = v_tmpl.id
            AND r.run_date = v_day
            AND r.status != 'cancelled'
            AND rs.status IN ('pending', 'en_route')
            AND rs.stop_type = 'pickup'
            AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
            AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME <  v_sw_end;
        ELSE
          SELECT COUNT(*) INTO v_count
          FROM route_stops rs
          JOIN routes r ON rs.route_id = r.id
          JOIN orders o ON rs.order_id = o.id
          WHERE r.template_id = v_tmpl.id
            AND r.run_date = v_day
            AND r.status != 'cancelled'
            AND rs.status IN ('pending', 'en_route')
            AND rs.stop_type = 'delivery'
            AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
            AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME <  v_sw_end;
        END IF;

        -- Skip full slots — we only return open options
        IF v_count >= v_sub_limit THEN
          v_from_mins := v_to_mins;
          CONTINUE;
        END IF;

        -- Distance = abs minute-difference between (v_day, v_sw_start)
        -- and (p_preferred_date, p_preferred_time)
        v_candidate_total_mins :=
          (v_day - p_preferred_date) * 24 * 60
          + (EXTRACT(EPOCH FROM v_sw_start)::INT / 60);
        v_distance := ABS(v_candidate_total_mins - v_preferred_total_mins);

        INSERT INTO _nearest_slots_tmp(
          run_date, template_id, template_name,
          sub_window_start, sub_window_end, sub_window_limit, active_stops,
          distance_minutes
        ) VALUES (
          v_day, v_tmpl.id, v_tmpl.name,
          v_sw_start, v_sw_end, v_sub_limit, v_count,
          v_distance
        );

        v_from_mins := v_to_mins;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN QUERY
  SELECT t.run_date, t.template_id, t.template_name,
         t.sub_window_start, t.sub_window_end, t.sub_window_limit, t.active_stops,
         t.distance_minutes
  FROM _nearest_slots_tmp t
  ORDER BY t.distance_minutes ASC, t.run_date ASC, t.sub_window_start ASC
  LIMIT p_limit;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_nearest_available_slots(UUID, DATE, TIME, TEXT, INT, INT) TO anon, authenticated;
