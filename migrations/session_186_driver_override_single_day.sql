-- Session 186: wire the already-built exact-date driver override (route_driver_overrides +
-- resolve_route_driver()) into the three functions that create/move routes on the fly.
-- Today only generate_route_runs() (the nightly 14-day-ahead pre-generation cron) consults
-- route_driver_overrides via resolve_route_driver(). auto_route_order, sync_pickup_stop_on_window_change,
-- and sync_delivery_stop_on_window_change all query route_driver_schedule directly, so a same-day
-- driver override set on a date that materializes a route BEFORE the nightly cron runs (e.g. an
-- order placed today for a date >14 days out, or a same-day reschedule) would be silently ignored.
-- This migration is a pure logic swap: no schema change, no new columns, same function signatures,
-- same SECURITY DEFINER + search_path. route_driver_overrides has 0 rows today, so this is a no-op
-- until the new admin UI (same push) actually writes to it.
--
-- IMPORTANT: resolve_route_driver() is always called with driver_type = 'pickup' at every call site
-- below, matching existing behavior exactly. route_driver_schedule currently has 0 'delivery'-typed
-- rows (all 67 rows are 'pickup') and the surrounding code has always applied that single value to
-- driver_id / pickup_driver_id / delivery_driver_id alike (one driver per route per day, not per leg).
-- Filtering delivery-leg resolution by driver_type='delivery' would silently return NULL for every
-- delivery route (no matching rows) — a severe regression. Using 'pickup' uniformly preserves today's
-- behavior for tiers 2 (weekly schedule) and 3 (template default) while adding tier 1 (exact-date
-- override, also always written as driver_type='pickup' by the admin UI) on top.

CREATE OR REPLACE FUNCTION public.auto_route_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order            RECORD;
  v_pickup_date      DATE;
  v_pickup_time      TIME;
  v_pickup_day       INT;
  v_delivery_date    DATE;
  v_delivery_time    TIME;
  v_delivery_day     INT;
  v_tmpl             RECORD;
  v_route_id         UUID;
  v_driver_id        UUID;
  v_stop_count       INT;
  v_next_stop        INT;
  v_pickup_done      BOOLEAN := FALSE;
  v_delivery_done    BOOLEAN := FALSE;
  v_turnaround       INT;
  v_step_mins        INT;
  v_total_hours      NUMERIC;
  v_num_subs         INT;
  v_sub_limit        INT;
  v_sub_ceiling      INT;
  v_pickup_overcap   BOOLEAN := FALSE;
  v_delivery_overcap BOOLEAN := FALSE;
  v_sw_start         TIME;
  v_sw_end           TIME;
  v_pm_window        TIME;
  v_subwindow_ok     BOOLEAN;
  v_existing_stop    INT;
  v_override_tmpl_id UUID;
  v_snap_start       TIME;
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

  -- ============================================================
  -- PICKUP
  -- ============================================================
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

        v_driver_id := public.resolve_route_driver(v_tmpl.id, v_pickup_date, 'pickup');

        IF v_route_id IS NULL THEN
          INSERT INTO routes (id, name, template_id, run_date, status, color, driver_id, pickup_driver_id, delivery_driver_id, total_stops)
          VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_pickup_date, 'scheduled', v_tmpl.color, v_driver_id, v_driver_id, v_driver_id, 0)
          RETURNING id INTO v_route_id;
        ELSE
          UPDATE routes SET
            pickup_driver_id   = COALESCE(pickup_driver_id, v_driver_id),
            delivery_driver_id = COALESCE(delivery_driver_id, v_driver_id),
            driver_id          = COALESCE(driver_id, v_driver_id)
          WHERE id = v_route_id
            AND (pickup_driver_id IS NULL OR delivery_driver_id IS NULL OR driver_id IS NULL);
        END IF;

        v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
        IF v_step_mins <= 0 THEN v_step_mins := 60; END IF;

        IF v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN
          v_total_hours := EXTRACT(EPOCH FROM (v_tmpl.window_end - v_tmpl.window_start)) / 3600;
          v_num_subs    := GREATEST(1, FLOOR(v_total_hours * 60 / v_step_mins)::INT);
          v_sub_limit   := FLOOR(v_tmpl.stop_limit::NUMERIC / v_num_subs)::INT;
          v_sub_ceiling := GREATEST(v_sub_limit + 1, FLOOR(v_sub_limit::NUMERIC * 1.25)::INT);

          v_sw_start := v_tmpl.window_start
            + (FLOOR((EXTRACT(EPOCH FROM (v_pickup_time - v_tmpl.window_start)) / 60) / v_step_mins) * v_step_mins) * INTERVAL '1 minute';
          v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';

          v_subwindow_ok   := FALSE;
          v_pickup_overcap := FALSE;
          WHILE v_sw_start < v_tmpl.window_end LOOP
            SELECT COUNT(*) INTO v_stop_count
            FROM route_stops rs
            JOIN orders o ON rs.order_id = o.id
            WHERE rs.route_id = v_route_id
              AND rs.status IN ('pending', 'en_route')
              AND rs.stop_type = 'pickup'
              AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
              AND (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME <  v_sw_end;

            IF v_stop_count < v_sub_ceiling THEN
              v_subwindow_ok   := TRUE;
              v_pickup_overcap := (v_stop_count >= v_sub_limit);
              EXIT;
            END IF;
            v_sw_start := v_sw_end;
            v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';
          END LOOP;

          IF NOT v_subwindow_ok THEN CONTINUE; END IF;
        END IF;

        -- Compute snap_start: nearest sub-window boundary at-or-before v_pickup_time,
        -- bounded to the template window.
        v_snap_start := v_tmpl.window_start
          + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_pickup_time - v_tmpl.window_start)) / (v_step_mins * 60)))::INT
            * (v_step_mins * INTERVAL '1 minute');
        IF v_snap_start >= v_tmpl.window_end THEN
          v_snap_start := v_tmpl.window_start;
        END IF;

        SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop FROM route_stops WHERE route_id = v_route_id;

        INSERT INTO route_stops (id, route_id, order_id, stop_type, stop_number, address_id, status)
        VALUES (gen_random_uuid(), v_route_id, p_order_id, 'pickup', v_next_stop, v_order.pickup_address_id, 'pending');

        -- Single combined UPDATE: run_id + aligned window in one shot.
        UPDATE orders SET
          pickup_run_id       = v_route_id,
          pickup_window_start = (v_pickup_date::timestamp + v_snap_start)
                                AT TIME ZONE 'America/Los_Angeles',
          pickup_window_end   = (v_pickup_date::timestamp + v_snap_start
                                  + v_step_mins * INTERVAL '1 minute')
                                AT TIME ZONE 'America/Los_Angeles'
        WHERE id = p_order_id;

        UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1 WHERE id = v_route_id;

        v_pickup_done := TRUE;
        EXIT;
      END LOOP;

      IF NOT v_pickup_done THEN
        UPDATE orders SET routing_error = 'No matching pickup route with capacity for this time window'
        WHERE id = p_order_id;
      END IF;
    END IF;
  END IF;

  -- ============================================================
  -- DELIVERY
  -- ============================================================
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

        v_driver_id := public.resolve_route_driver(v_tmpl.id, v_delivery_date, 'pickup');

        IF v_route_id IS NULL THEN
          INSERT INTO routes (id, name, template_id, run_date, status, color, driver_id, pickup_driver_id, delivery_driver_id, total_stops)
          VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_delivery_date, 'scheduled', v_tmpl.color, v_driver_id, v_driver_id, v_driver_id, 0)
          RETURNING id INTO v_route_id;
        ELSE
          UPDATE routes SET
            pickup_driver_id   = COALESCE(pickup_driver_id, v_driver_id),
            delivery_driver_id = COALESCE(delivery_driver_id, v_driver_id),
            driver_id          = COALESCE(driver_id, v_driver_id)
          WHERE id = v_route_id
            AND (pickup_driver_id IS NULL OR delivery_driver_id IS NULL OR driver_id IS NULL);
        END IF;

        v_step_mins := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
        IF v_step_mins <= 0 THEN v_step_mins := 60; END IF;

        IF v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN
          v_total_hours := EXTRACT(EPOCH FROM (v_tmpl.window_end - v_tmpl.window_start)) / 3600;
          v_num_subs    := GREATEST(1, FLOOR(v_total_hours * 60 / v_step_mins)::INT);
          v_sub_limit   := FLOOR(v_tmpl.stop_limit::NUMERIC / v_num_subs)::INT;
          v_sub_ceiling := GREATEST(v_sub_limit + 1, FLOOR(v_sub_limit::NUMERIC * 1.25)::INT);

          v_sw_start := v_tmpl.window_start
            + (FLOOR((EXTRACT(EPOCH FROM (v_delivery_time - v_tmpl.window_start)) / 60) / v_step_mins) * v_step_mins) * INTERVAL '1 minute';
          v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';

          v_subwindow_ok     := FALSE;
          v_delivery_overcap := FALSE;
          WHILE v_sw_start < v_tmpl.window_end LOOP
            SELECT COUNT(*) INTO v_stop_count
            FROM route_stops rs
            JOIN orders o ON rs.order_id = o.id
            WHERE rs.route_id = v_route_id
              AND rs.status IN ('pending', 'en_route')
              AND rs.stop_type = 'delivery'
              AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME >= v_sw_start
              AND (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME <  v_sw_end;

            IF v_stop_count < v_sub_ceiling THEN
              v_subwindow_ok     := TRUE;
              v_delivery_overcap := (v_stop_count >= v_sub_limit);
              EXIT;
            END IF;
            v_sw_start := v_sw_end;
            v_sw_end   := v_sw_start + v_step_mins * INTERVAL '1 minute';
          END LOOP;

          IF NOT v_subwindow_ok THEN CONTINUE; END IF;
        END IF;

        v_snap_start := v_tmpl.window_start
          + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_delivery_time - v_tmpl.window_start)) / (v_step_mins * 60)))::INT
            * (v_step_mins * INTERVAL '1 minute');
        IF v_snap_start >= v_tmpl.window_end THEN
          v_snap_start := v_tmpl.window_start;
        END IF;

        SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop FROM route_stops WHERE route_id = v_route_id;

        INSERT INTO route_stops (id, route_id, order_id, stop_type, stop_number, address_id, status)
        VALUES (gen_random_uuid(), v_route_id, p_order_id, 'delivery', v_next_stop,
                COALESCE(v_order.delivery_address_id, v_order.pickup_address_id), 'pending');

        UPDATE orders SET
          delivery_run_id       = v_route_id,
          delivery_window_start = (v_delivery_date::timestamp + v_snap_start)
                                  AT TIME ZONE 'America/Los_Angeles',
          delivery_window_end   = (v_delivery_date::timestamp + v_snap_start
                                    + v_step_mins * INTERVAL '1 minute')
                                  AT TIME ZONE 'America/Los_Angeles'
        WHERE id = p_order_id;

        UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1 WHERE id = v_route_id;

        v_delivery_done := TRUE;
        EXIT;
      END LOOP;

      IF NOT v_delivery_done AND NOT v_pickup_done THEN
        UPDATE orders SET routing_error = COALESCE(routing_error, '') || ' No matching delivery route template'
        WHERE id = p_order_id;
      ELSIF NOT v_delivery_done THEN
        UPDATE orders SET routing_error = 'No matching delivery route with capacity for this time window'
        WHERE id = p_order_id;
      END IF;
    END IF;
  END IF;

  IF v_pickup_overcap OR v_delivery_overcap THEN
    UPDATE orders SET overcap_booking = TRUE WHERE id = p_order_id;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_pickup_stop_on_window_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_pickup_date    DATE;
  v_new_pickup_time    TIME;
  v_new_pickup_day     INT;
  v_current_route_date DATE;
  v_stop_rec           RECORD;
  v_tmpl               RECORD;
  v_new_route_id       UUID;
  v_driver_id          UUID;
  v_stop_count         INT;
  v_route_ceiling      INT;
  v_next_stop          INT;
  v_moved              BOOLEAN := FALSE;
  v_override_tmpl_id   UUID;
BEGIN
  IF NEW.pickup_run_id IS DISTINCT FROM OLD.pickup_run_id THEN RETURN NEW; END IF;
  IF NEW.pickup_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.pickup_window_start IS NULL THEN RETURN NEW; END IF;

  SELECT run_date INTO v_current_route_date
  FROM routes WHERE id = NEW.pickup_run_id;

  v_new_pickup_date := (NEW.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
  v_new_pickup_time := (NEW.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;

  IF v_current_route_date = v_new_pickup_date THEN RETURN NEW; END IF;

  SELECT * INTO v_stop_rec FROM route_stops
  WHERE order_id = NEW.id AND stop_type = 'pickup' AND status = 'pending'
  LIMIT 1;

  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT route_template_override_id INTO v_override_tmpl_id
  FROM customers WHERE id = NEW.customer_id;

  v_new_pickup_day := (EXTRACT(ISODOW FROM v_new_pickup_date)::INT - 1);

  FOR v_tmpl IN
    SELECT * FROM route_templates
    WHERE is_active = TRUE
      AND v_new_pickup_day = ANY(schedule_days)
      AND v_new_pickup_time >= window_start
      AND v_new_pickup_time <  window_end
      AND (
        (v_override_tmpl_id IS NOT NULL AND id = v_override_tmpl_id)
        OR
        (v_override_tmpl_id IS NULL AND zone_id = NEW.zone_id)
      )
    ORDER BY window_start
  LOOP
    SELECT id INTO v_new_route_id FROM routes
    WHERE template_id = v_tmpl.id AND run_date = v_new_pickup_date AND status != 'cancelled'
    LIMIT 1;

    v_driver_id := public.resolve_route_driver(v_tmpl.id, v_new_pickup_date, 'pickup');

    IF v_new_route_id IS NULL THEN
      INSERT INTO routes (id, name, template_id, run_date, date, status, color,
                          driver_id, pickup_driver_id, delivery_driver_id, total_stops)
      VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_new_pickup_date,
              v_new_pickup_date, 'scheduled', v_tmpl.color,
              v_driver_id, v_driver_id, v_driver_id, 0)
      RETURNING id INTO v_new_route_id;
    END IF;

    IF v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN
      SELECT COUNT(*) INTO v_stop_count
      FROM route_stops
      WHERE route_id = v_new_route_id
        AND status IN ('pending','en_route');
      v_route_ceiling := GREATEST(v_tmpl.stop_limit + 1, FLOOR(v_tmpl.stop_limit::NUMERIC * 1.25)::INT);

      IF v_stop_count >= v_route_ceiling THEN
        NEW.routing_error    := 'over_capacity_severe_after_reschedule';
        NEW.overcap_booking  := TRUE;
      ELSIF v_stop_count >= v_tmpl.stop_limit THEN
        NEW.routing_error    := NULL;
        NEW.overcap_booking  := TRUE;
      ELSE
        NEW.routing_error    := NULL;
        NEW.overcap_booking  := FALSE;
      END IF;
    ELSE
      NEW.routing_error    := NULL;
      NEW.overcap_booking  := FALSE;
    END IF;

    SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop
    FROM route_stops WHERE route_id = v_new_route_id;

    UPDATE route_stops SET
      route_id             = v_new_route_id,
      stop_number          = v_next_stop,
      moved_from_route_id  = v_stop_rec.route_id,
      estimated_arrival    = NULL
    WHERE id = v_stop_rec.id;

    UPDATE routes SET total_stops = GREATEST(COALESCE(total_stops, 1) - 1, 0)
    WHERE id = v_stop_rec.route_id;

    UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1
    WHERE id = v_new_route_id;

    NEW.pickup_run_id := v_new_route_id;
    v_moved := TRUE;

    EXIT;
  END LOOP;

  IF NOT v_moved THEN
    NEW.pickup_window_start := OLD.pickup_window_start;
    NEW.pickup_window_end   := OLD.pickup_window_end;
    NEW.routing_error       := 'reschedule_no_matching_template';
    RAISE WARNING 'Pickup reschedule for order % reverted: no matching route template for day=% time=%',
      NEW.id, v_new_pickup_date, v_new_pickup_time;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_delivery_stop_on_window_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_new_delivery_date  DATE;
  v_new_delivery_time  TIME;
  v_new_delivery_day   INT;
  v_current_route_date DATE;
  v_stop_rec           RECORD;
  v_tmpl               RECORD;
  v_new_route_id       UUID;
  v_driver_id          UUID;
  v_stop_count         INT;
  v_route_ceiling      INT;
  v_next_stop          INT;
  v_moved              BOOLEAN := FALSE;
  v_override_tmpl_id   UUID;
BEGIN
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id THEN RETURN NEW; END IF;
  IF NEW.delivery_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.delivery_window_start IS NULL THEN RETURN NEW; END IF;

  SELECT run_date INTO v_current_route_date
  FROM routes WHERE id = NEW.delivery_run_id;

  v_new_delivery_date := (NEW.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
  v_new_delivery_time := (NEW.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;

  IF v_current_route_date = v_new_delivery_date THEN RETURN NEW; END IF;

  SELECT * INTO v_stop_rec FROM route_stops
  WHERE order_id = NEW.id AND stop_type = 'delivery' AND status = 'pending'
  LIMIT 1;

  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT route_template_override_id INTO v_override_tmpl_id
  FROM customers WHERE id = NEW.customer_id;

  v_new_delivery_day := (EXTRACT(ISODOW FROM v_new_delivery_date)::INT - 1);

  FOR v_tmpl IN
    SELECT * FROM route_templates
    WHERE is_active = TRUE
      AND v_new_delivery_day = ANY(schedule_days)
      AND v_new_delivery_time >= window_start
      AND v_new_delivery_time <  window_end
      AND (
        (v_override_tmpl_id IS NOT NULL AND id = v_override_tmpl_id)
        OR
        (v_override_tmpl_id IS NULL AND zone_id = NEW.zone_id)
      )
    ORDER BY window_start
  LOOP
    SELECT id INTO v_new_route_id FROM routes
    WHERE template_id = v_tmpl.id AND run_date = v_new_delivery_date AND status != 'cancelled'
    LIMIT 1;

    v_driver_id := public.resolve_route_driver(v_tmpl.id, v_new_delivery_date, 'pickup');

    IF v_new_route_id IS NULL THEN
      INSERT INTO routes (id, name, template_id, run_date, date, status, color,
                          driver_id, pickup_driver_id, delivery_driver_id, total_stops)
      VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_new_delivery_date,
              v_new_delivery_date, 'scheduled', v_tmpl.color,
              v_driver_id, v_driver_id, v_driver_id, 0)
      RETURNING id INTO v_new_route_id;
    END IF;

    IF v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN
      SELECT COUNT(*) INTO v_stop_count
      FROM route_stops
      WHERE route_id = v_new_route_id
        AND status IN ('pending','en_route');
      v_route_ceiling := GREATEST(v_tmpl.stop_limit + 1, FLOOR(v_tmpl.stop_limit::NUMERIC * 1.25)::INT);

      IF v_stop_count >= v_route_ceiling THEN
        NEW.routing_error    := 'over_capacity_severe_after_reschedule';
        NEW.overcap_booking  := TRUE;
      ELSIF v_stop_count >= v_tmpl.stop_limit THEN
        NEW.routing_error    := NULL;
        NEW.overcap_booking  := TRUE;
      ELSE
        NEW.routing_error    := NULL;
        NEW.overcap_booking  := FALSE;
      END IF;
    ELSE
      NEW.routing_error    := NULL;
      NEW.overcap_booking  := FALSE;
    END IF;

    SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next_stop
    FROM route_stops WHERE route_id = v_new_route_id;

    UPDATE route_stops SET
      route_id             = v_new_route_id,
      stop_number          = v_next_stop,
      moved_from_route_id  = v_stop_rec.route_id,
      estimated_arrival    = NULL
    WHERE id = v_stop_rec.id;

    UPDATE routes SET total_stops = GREATEST(COALESCE(total_stops, 1) - 1, 0)
    WHERE id = v_stop_rec.route_id;

    UPDATE routes SET total_stops = COALESCE(total_stops, 0) + 1
    WHERE id = v_new_route_id;

    NEW.delivery_run_id := v_new_route_id;
    v_moved := TRUE;

    EXIT;
  END LOOP;

  IF NOT v_moved THEN
    NEW.delivery_window_start := OLD.delivery_window_start;
    NEW.delivery_window_end   := OLD.delivery_window_end;
    NEW.routing_error         := 'reschedule_no_matching_template';
    RAISE WARNING 'Delivery reschedule for order % reverted: no matching route template for day=% time=%',
      NEW.id, v_new_delivery_date, v_new_delivery_time;
  END IF;

  RETURN NEW;
END;
$function$;
