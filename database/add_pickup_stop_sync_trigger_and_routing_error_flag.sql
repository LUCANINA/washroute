-- Migration: add_pickup_stop_sync_trigger_and_routing_error_flag
-- Applied: 2026-03-29
-- Purpose:
--   1. Create sync_pickup_stop_on_window_change() — mirrors the delivery
--      trigger so pickup stops auto-move when the pickup window changes.
--      Previously, pickup stops were always left stranded on the original
--      route when an order was rescheduled (only delivery had a trigger).
--   2. Set routing_error = 'rescheduled_no_capacity' in both pickup and
--      delivery triggers when no eligible route is found. Previously both
--      triggers failed silently — the window would update but the stop
--      would stay on the wrong-date route with no flag. Morning audit
--      Check 1 (routing_error IS NOT NULL) now catches these immediately.
--
-- Root cause this fixes: Heather Gould #808 — order rescheduled by recurring
-- order system from Apr 7 to Mar 30/31, but both stops stayed on Apr 7 routes.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_sync_pickup_stop_on_window_change ON orders;
--   DROP FUNCTION IF EXISTS sync_pickup_stop_on_window_change();
--   -- Restore delivery function from schema.sql or re-apply without the routing_error flag.

-- ── Part 1: Pickup stop sync function ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sync_pickup_stop_on_window_change()
RETURNS trigger
LANGUAGE plpgsql
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
  v_next_stop          INT;
  v_moved              BOOLEAN := FALSE;
BEGIN
  -- Skip if pickup_run_id is also being changed in this same UPDATE
  -- (admin explicitly chose a route — trust their choice)
  IF NEW.pickup_run_id IS DISTINCT FROM OLD.pickup_run_id THEN
    RETURN NEW;
  END IF;

  -- Skip if no pickup_run_id (no pickup stop to move)
  IF NEW.pickup_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if pickup_window_start was cleared
  IF NEW.pickup_window_start IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get current route date
  SELECT run_date INTO v_current_route_date
  FROM routes WHERE id = NEW.pickup_run_id;

  -- Calculate new pickup date/time in Pacific timezone
  v_new_pickup_date := (NEW.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
  v_new_pickup_time := (NEW.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;

  -- If dates already match, nothing to do
  IF v_current_route_date = v_new_pickup_date THEN
    RETURN NEW;
  END IF;

  -- Find the pending pickup stop for this order
  SELECT * INTO v_stop_rec FROM route_stops
  WHERE order_id = NEW.id AND stop_type = 'pickup' AND status = 'pending'
  LIMIT 1;

  -- No pending pickup stop to move
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Day of week for new pickup date (0 = Monday … 6 = Sunday, ISODOW style)
  v_new_pickup_day := (EXTRACT(ISODOW FROM v_new_pickup_date)::INT - 1);

  FOR v_tmpl IN
    SELECT * FROM route_templates
    WHERE zone_id = NEW.zone_id
      AND is_active = TRUE
      AND v_new_pickup_day = ANY(schedule_days)
    ORDER BY
      CASE WHEN v_new_pickup_time >= window_start
                AND v_new_pickup_time < window_end THEN 0 ELSE 1 END,
      window_start
  LOOP
    -- Find or create the route for the new date
    SELECT id INTO v_new_route_id FROM routes
    WHERE template_id = v_tmpl.id
      AND run_date = v_new_pickup_date
      AND status != 'cancelled'
    LIMIT 1;

    SELECT rds.driver_id INTO v_driver_id FROM route_driver_schedule rds
    WHERE rds.template_id = v_tmpl.id
      AND rds.day_of_week = v_new_pickup_day
    LIMIT 1;

    IF v_new_route_id IS NULL THEN
      INSERT INTO routes (id, name, template_id, run_date, date, status, color,
                          driver_id, pickup_driver_id, delivery_driver_id, total_stops)
      VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_new_pickup_date,
              v_new_pickup_date, 'scheduled', v_tmpl.color,
              v_driver_id, v_driver_id, v_driver_id, 0)
      RETURNING id INTO v_new_route_id;
    END IF;

    -- Check capacity
    IF v_tmpl.stop_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_stop_count FROM route_stops WHERE route_id = v_new_route_id;
      IF v_stop_count >= v_tmpl.stop_limit THEN CONTINUE; END IF;
    END IF;

    -- Move the stop to the new route
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

    NEW.pickup_run_id  := v_new_route_id;
    NEW.routing_error  := NULL;   -- clear any previous routing error
    v_moved := TRUE;

    EXIT;
  END LOOP;

  -- If loop exhausted without moving, flag for the morning audit
  IF NOT v_moved THEN
    NEW.routing_error := 'rescheduled_no_capacity';
  END IF;

  RETURN NEW;
END;
$function$;

-- ── Part 1b: Attach pickup trigger ──────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_sync_pickup_stop_on_window_change ON orders;

CREATE TRIGGER trg_sync_pickup_stop_on_window_change
BEFORE UPDATE ON orders
FOR EACH ROW
WHEN (OLD.pickup_window_start IS DISTINCT FROM NEW.pickup_window_start)
EXECUTE FUNCTION sync_pickup_stop_on_window_change();


-- ── Part 2: Update delivery trigger to flag routing_error ───────────────────

CREATE OR REPLACE FUNCTION public.sync_delivery_stop_on_window_change()
RETURNS trigger
LANGUAGE plpgsql
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
  v_next_stop          INT;
  v_moved              BOOLEAN := FALSE;
BEGIN
  -- Skip if delivery_run_id is also being changed in this same UPDATE
  IF NEW.delivery_run_id IS DISTINCT FROM OLD.delivery_run_id THEN
    RETURN NEW;
  END IF;

  -- Skip if no delivery_run_id (no delivery stop to move)
  IF NEW.delivery_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Skip if delivery_window_start was cleared
  IF NEW.delivery_window_start IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get current route date
  SELECT run_date INTO v_current_route_date
  FROM routes WHERE id = NEW.delivery_run_id;

  -- Calculate new delivery date/time in Pacific timezone
  v_new_delivery_date := (NEW.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::DATE;
  v_new_delivery_time := (NEW.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::TIME;

  -- If dates already match, nothing to do
  IF v_current_route_date = v_new_delivery_date THEN
    RETURN NEW;
  END IF;

  -- Find the pending delivery stop for this order
  SELECT * INTO v_stop_rec FROM route_stops
  WHERE order_id = NEW.id AND stop_type = 'delivery' AND status = 'pending'
  LIMIT 1;

  -- No pending delivery stop to move
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_new_delivery_day := (EXTRACT(ISODOW FROM v_new_delivery_date)::INT - 1);

  FOR v_tmpl IN
    SELECT * FROM route_templates
    WHERE zone_id = NEW.zone_id AND is_active = TRUE
      AND v_new_delivery_day = ANY(schedule_days)
    ORDER BY
      CASE WHEN v_new_delivery_time >= window_start
                AND v_new_delivery_time < window_end THEN 0 ELSE 1 END,
      window_start
  LOOP
    SELECT id INTO v_new_route_id FROM routes
    WHERE template_id = v_tmpl.id
      AND run_date = v_new_delivery_date
      AND status != 'cancelled'
    LIMIT 1;

    SELECT rds.driver_id INTO v_driver_id FROM route_driver_schedule rds
    WHERE rds.template_id = v_tmpl.id
      AND rds.day_of_week = v_new_delivery_day
    LIMIT 1;

    IF v_new_route_id IS NULL THEN
      INSERT INTO routes (id, name, template_id, run_date, date, status, color,
                          driver_id, pickup_driver_id, delivery_driver_id, total_stops)
      VALUES (gen_random_uuid(), v_tmpl.name, v_tmpl.id, v_new_delivery_date,
              v_new_delivery_date, 'scheduled', v_tmpl.color,
              v_driver_id, v_driver_id, v_driver_id, 0)
      RETURNING id INTO v_new_route_id;
    END IF;

    IF v_tmpl.stop_limit IS NOT NULL THEN
      SELECT COUNT(*) INTO v_stop_count FROM route_stops WHERE route_id = v_new_route_id;
      IF v_stop_count >= v_tmpl.stop_limit THEN CONTINUE; END IF;
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
    NEW.routing_error   := NULL;   -- clear any previous routing error
    v_moved := TRUE;

    EXIT;
  END LOOP;

  -- If loop exhausted without moving, flag for the morning audit
  IF NOT v_moved THEN
    NEW.routing_error := 'rescheduled_no_capacity';
  END IF;

  RETURN NEW;
END;
$function$;
