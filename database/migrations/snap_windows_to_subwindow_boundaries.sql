-- Migration: snap_windows_to_subwindow_boundaries
-- Session 122: Fix two gaps in auto_route_order
--
-- Gap 1: Session 113 delivery-window sync only corrected outside-template
--         values. Windows inside the range but not at a valid sub-window
--         boundary (e.g. 8pm on a 7-10pm route with 3h sub-windows) were
--         preserved as "legitimate customer sub-windows" — but they aren't.
--
-- Gap 2: No equivalent pickup-window sync existed at all.
--
-- This patch adds sub-window boundary snapping for BOTH pickup and delivery
-- after each stop is placed. The logic:
--   1. Compute step_mins from arrival_window_hours
--   2. Compute the floor sub-window start: window_start + floor((stored_time - window_start) / step) * step
--   3. If stored_time != floor_start OR stored_date != route_date → snap to floor_start
--
-- For outside-template cases (stored_time < window_start), the floor formula
-- produces window_start automatically — matching session 113 behavior.

CREATE OR REPLACE FUNCTION public.auto_route_order(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order          RECORD;
  v_pickup_date    DATE;
  v_pickup_time    TIME;
  v_pickup_day     INT;
  v_delivery_date  DATE;
  v_delivery_time  TIME;
  v_delivery_day   INT;
  v_tmpl           RECORD;
  v_route_id       UUID;
  v_driver_id      UUID;
  v_stop_count     INT;
  v_next_stop      INT;
  v_pickup_done    BOOLEAN := FALSE;
  v_delivery_done  BOOLEAN := FALSE;
  v_turnaround     INT;
  v_step_mins      INT;
  v_total_hours    NUMERIC;
  v_num_subs       INT;
  v_sub_limit      INT;
  v_sw_start       TIME;
  v_sw_end         TIME;
  v_pm_window      TIME;
  v_subwindow_ok   BOOLEAN;
  v_existing_stop  INT;
  v_override_tmpl_id UUID;
  v_stored_dt      TIME;
  v_stored_dd      DATE;
  v_snap_start     TIME;  -- ★ NEW: computed sub-window boundary
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT route_template_override_id INTO v_override_tmpl_id
  FROM customers WHERE id = v_order.customer_id;

  IF v_override_tmpl_id IS NULL AND v_order.zone_id IS NULL THEN
    UPDATE orders SET routing_error = 'No zone assigned' WHERE id = p_order_id;
    RETURN;
  END IF;

  UPDATE orders SET routing_error = NULL WHERE id = p_order_id;

  -- ═══════════════════════════════════════════════════════════════
  -- PICKUP ROUTING
  -- ═══════════════════════════════════════════════════════════════
  IF v_order.pickup_run_id IS NULL AND v_order.pickup_window_start IS NOT NULL THEN
    SELECT COUNT(*) INTO v_existing_stop
    FROM route_stops
    WHERE order_id = p_order_id AND stop_type = 'pickup'
      AND status NOT IN ('skipped', 'failed');
    IF v_existing_stop > 0 THEN
      v_pickup_done := TRUE;
    END IF;

    IF NOT v_pickup_done THEN
    v_pickup_date := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
    v_pickup_time := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;
    v_pickup_day  := (EXTRACT(ISODOW FROM v_pickup_date)::INT - 1);

    FOR v_tmpl IN
      SELECT * FROM route_templates
      WHERE is_active = TRUE
        AND v_pickup_day = ANY(schedule_days)
        AND v_pickup_time >= window_start AND v_pickup_time < window_end
        AND (
          (v_override_tmpl_id IS NOT NULL AND id = v_override_tmpl_id)
          OR
          (v_override_tmpl_id IS NULL AND zone_id = v_order.zone_id)
        )
      ORDER BY window_start
    LOOP
      SELECT id INTO v_route_id FROM routes
      WHERE template_id = v_tmpl.id AND run_date = v_pickup_date AND status != 'cancelled' LIMIT 1;

      SELECT rds.driver_id INTO v_driver_id FROM route_driver_schedule rds
      WHERE rds.template_id = v_tmpl.id AND rds.day_of_week = v_pickup_day LIMIT 1;

      IF v_route_id IS NULL THEN
        INSERT INTO routes (id, name, template_id, run_date, date, status, color, driver_id, pickup_driver_id, delivery_driver_id, total_stops)
        VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_pickup_date, v_pickup_date, 'scheduled', v_tmpl.color, v_driver_id, v_driver_id, v_driver_id, 0)
        RETURNING id INTO v_route_id;
      ELSE
        UPDATE routes SET
          pickup_driver_id = COALESCE(pickup_driver_id, v_driver_id),
          delivery_driver_id = COALESCE(delivery_driver_id, v_driver_id),
          driver_id = COALESCE(driver_id, v_driver_id)
        WHERE id = v_route_id AND (pickup_driver_id IS NULL OR delivery_driver_id IS NULL OR driver_id IS NULL);
      END IF;

      IF v_tmpl.stop_limit IS NOT NULL THEN
        v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
        v_total_hours := EXTRACT(EPOCH FROM (v_tmpl.window_end - v_tmpl.window_start)) / 3600;
        v_num_subs := GREATEST(1, FLOOR(v_total_hours * 60 / v_step_mins)::INT);
        v_sub_limit := FLOOR(v_tmpl.stop_limit::NUMERIC / v_num_subs)::INT;

        v_sw_start := v_tmpl.window_start + (FLOOR((EXTRACT(EPOCH FROM (v_pickup_time - v_tmpl.window_start)) / 60) / v_step_mins) * v_step_mins) * INTERVAL '1 minute';
        v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';

        v_subwindow_ok := FALSE;
        WHILE v_sw_start < v_tmpl.window_end LOOP
          SELECT COUNT(*) INTO v_stop_count
          FROM route_stops rs
          JOIN orders o ON rs.order_id = o.id
          WHERE rs.route_id = v_route_id
            AND rs.status IN ('pending', 'en_route')
            AND rs.stop_type = 'pickup'
            AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
            AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME < v_sw_end;

          IF v_stop_count < v_sub_limit THEN
            v_subwindow_ok := TRUE;
            EXIT;
          END IF;
          v_sw_start := v_sw_end;
          v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';
        END LOOP;

        IF NOT v_subwindow_ok THEN CONTINUE; END IF;
      END IF;

      SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop FROM route_stops WHERE route_id = v_route_id;

      INSERT INTO route_stops (id, route_id, order_id, stop_type, stop_number, address_id, status)
      VALUES (gen_random_uuid(), v_route_id, p_order_id, 'pickup', v_next_stop, v_order.pickup_address_id, 'pending');

      UPDATE orders SET pickup_run_id = v_route_id WHERE id = p_order_id;
      UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1 WHERE id = v_route_id;

      -- ★ NEW (session 122): Snap pickup window to valid sub-window boundary.
      -- Computes the floor boundary from the matched template. Corrects both
      -- outside-template times AND misaligned-inside times in one pass.
      v_stored_dt := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;
      v_stored_dd := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
      v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;

      -- Floor snap: window_start + floor((stored - start) / step) * step
      -- For outside-template (stored < start), EPOCH is negative → floor → 0 → snaps to window_start
      v_snap_start := v_tmpl.window_start
        + GREATEST(0,
            FLOOR(EXTRACT(EPOCH FROM (v_stored_dt - v_tmpl.window_start)) / (v_step_mins * 60))
          )::INT * (v_step_mins * INTERVAL '1 minute');

      -- Clamp: if snap somehow >= window_end, fall back to window_start
      IF v_snap_start >= v_tmpl.window_end THEN
        v_snap_start := v_tmpl.window_start;
      END IF;

      IF v_stored_dt != v_snap_start OR v_stored_dd != v_pickup_date THEN
        UPDATE orders SET
          pickup_window_start = (v_pickup_date::timestamp + v_snap_start) AT TIME ZONE 'America/Los_Angeles',
          pickup_window_end   = (v_pickup_date::timestamp + v_snap_start + v_step_mins * INTERVAL '1 minute') AT TIME ZONE 'America/Los_Angeles'
        WHERE id = p_order_id;
      END IF;

      v_pickup_done := TRUE;
      EXIT;
    END LOOP;

    IF NOT v_pickup_done THEN
      UPDATE orders SET routing_error = 'No matching pickup route with capacity for this time window' WHERE id = p_order_id;
    END IF;
    END IF;
  END IF;

  -- ═══════════════════════════════════════════════════════════════
  -- DELIVERY ROUTING
  -- ═══════════════════════════════════════════════════════════════
  IF v_order.delivery_run_id IS NULL THEN
    SELECT COUNT(*) INTO v_existing_stop
    FROM route_stops
    WHERE order_id = p_order_id AND stop_type = 'delivery'
      AND status NOT IN ('skipped', 'failed');
    IF v_existing_stop > 0 THEN
      v_delivery_done := TRUE;
    END IF;

    IF NOT v_delivery_done THEN
    IF v_order.delivery_window_start IS NOT NULL THEN
      v_delivery_date := (v_order.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
      v_delivery_time := (v_order.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;
    ELSIF v_pickup_date IS NOT NULL THEN
      SELECT turnaround_days INTO v_turnaround FROM route_templates WHERE zone_id = v_order.zone_id AND is_active = TRUE LIMIT 1;
      v_delivery_date := v_pickup_date + COALESCE(v_turnaround, 1);
      v_delivery_time := v_pickup_time;
    ELSE
      RETURN;
    END IF;

    IF v_pickup_time IS NULL AND v_order.pickup_window_start IS NOT NULL THEN
      v_pickup_time := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;
      v_pickup_date := (v_order.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
    END IF;

    -- Residential PM-bridging (Apr 8, 2026)
    IF v_override_tmpl_id IS NULL
       AND v_pickup_time IS NOT NULL
       AND v_pickup_time >= '12:00:00'::TIME
       AND v_delivery_time < '12:00:00'::TIME
       AND v_delivery_date <= (v_pickup_date + 1) THEN
      SELECT window_start INTO v_pm_window
      FROM route_templates
      WHERE zone_id = v_order.zone_id AND is_active = TRUE AND window_start >= '12:00:00'::TIME
      ORDER BY window_start LIMIT 1;

      IF v_pm_window IS NOT NULL THEN
        v_delivery_time := v_pm_window;
      ELSE
        v_delivery_date := v_delivery_date + 1;
      END IF;
    END IF;

    v_delivery_day := (EXTRACT(ISODOW FROM v_delivery_date)::INT - 1);

    FOR v_tmpl IN
      SELECT * FROM route_templates
      WHERE is_active = TRUE
        AND v_delivery_day = ANY(schedule_days)
        AND v_delivery_time >= window_start AND v_delivery_time < window_end
        AND (
          (v_override_tmpl_id IS NOT NULL AND id = v_override_tmpl_id)
          OR
          (v_override_tmpl_id IS NULL AND zone_id = v_order.zone_id)
        )
      ORDER BY window_start
    LOOP
      SELECT id INTO v_route_id FROM routes
      WHERE template_id = v_tmpl.id AND run_date = v_delivery_date AND status != 'cancelled' LIMIT 1;

      SELECT rds.driver_id INTO v_driver_id FROM route_driver_schedule rds
      WHERE rds.template_id = v_tmpl.id AND rds.day_of_week = v_delivery_day LIMIT 1;

      IF v_route_id IS NULL THEN
        INSERT INTO routes (id, name, template_id, run_date, date, status, color, driver_id, pickup_driver_id, delivery_driver_id, total_stops)
        VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_delivery_date, v_delivery_date, 'scheduled', v_tmpl.color, v_driver_id, v_driver_id, v_driver_id, 0)
        RETURNING id INTO v_route_id;
      ELSE
        UPDATE routes SET
          pickup_driver_id = COALESCE(pickup_driver_id, v_driver_id),
          delivery_driver_id = COALESCE(delivery_driver_id, v_driver_id),
          driver_id = COALESCE(driver_id, v_driver_id)
        WHERE id = v_route_id AND (pickup_driver_id IS NULL OR delivery_driver_id IS NULL OR driver_id IS NULL);
      END IF;

      IF v_tmpl.stop_limit IS NOT NULL THEN
        v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
        v_total_hours := EXTRACT(EPOCH FROM (v_tmpl.window_end - v_tmpl.window_start)) / 3600;
        v_num_subs := GREATEST(1, FLOOR(v_total_hours * 60 / v_step_mins)::INT);
        v_sub_limit := FLOOR(v_tmpl.stop_limit::NUMERIC / v_num_subs)::INT;

        v_sw_start := v_tmpl.window_start + (FLOOR((EXTRACT(EPOCH FROM (v_delivery_time - v_tmpl.window_start)) / 60) / v_step_mins) * v_step_mins) * INTERVAL '1 minute';
        v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';

        v_subwindow_ok := FALSE;
        WHILE v_sw_start < v_tmpl.window_end LOOP
          SELECT COUNT(*) INTO v_stop_count
          FROM route_stops rs
          JOIN orders o ON rs.order_id = o.id
          WHERE rs.route_id = v_route_id
            AND rs.status IN ('pending', 'en_route')
            AND rs.stop_type = 'delivery'
            AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
            AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME < v_sw_end;

          IF v_stop_count < v_sub_limit THEN
            v_subwindow_ok := TRUE;
            EXIT;
          END IF;
          v_sw_start := v_sw_end;
          v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';
        END LOOP;

        IF NOT v_subwindow_ok THEN CONTINUE; END IF;
      END IF;

      SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop FROM route_stops WHERE route_id = v_route_id;

      INSERT INTO route_stops (id, route_id, order_id, stop_type, stop_number, address_id, status)
      VALUES (gen_random_uuid(), v_route_id, p_order_id, 'delivery', v_next_stop, COALESCE(v_order.delivery_address_id, v_order.pickup_address_id), 'pending');

      UPDATE orders SET delivery_run_id = v_route_id WHERE id = p_order_id;
      UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1 WHERE id = v_route_id;

      -- ★ Session 122 FIX: Replaces session 113's outside-only check with
      -- full sub-window boundary snapping. Corrects BOTH outside-template
      -- AND misaligned-inside-template delivery windows.
      v_stored_dt := (v_order.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;
      v_stored_dd := (v_order.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
      v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;

      v_snap_start := v_tmpl.window_start
        + GREATEST(0,
            FLOOR(EXTRACT(EPOCH FROM (v_stored_dt - v_tmpl.window_start)) / (v_step_mins * 60))
          )::INT * (v_step_mins * INTERVAL '1 minute');

      IF v_snap_start >= v_tmpl.window_end THEN
        v_snap_start := v_tmpl.window_start;
      END IF;

      IF v_order.delivery_window_start IS NULL
         OR v_stored_dt != v_snap_start
         OR v_stored_dd != v_delivery_date
      THEN
        UPDATE orders SET
          delivery_window_start = (v_delivery_date::timestamp + v_snap_start) AT TIME ZONE 'America/Los_Angeles',
          delivery_window_end   = (v_delivery_date::timestamp + v_snap_start + v_step_mins * INTERVAL '1 minute') AT TIME ZONE 'America/Los_Angeles'
        WHERE id = p_order_id;
      END IF;

      v_delivery_done := TRUE;
      EXIT;
    END LOOP;

    IF NOT v_delivery_done AND NOT v_pickup_done THEN
      UPDATE orders SET routing_error = COALESCE(routing_error, '') || ' No matching delivery route template' WHERE id = p_order_id;
    ELSIF NOT v_delivery_done THEN
      UPDATE orders SET routing_error = 'No matching delivery route with capacity for this time window' WHERE id = p_order_id;
    END IF;
    END IF;
  END IF;
END;
$$;
