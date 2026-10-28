-- Session 364: driver_add_pickup — a driver delivering an order can add a pickup
-- for the same customer when more bags are waiting at the door.
--
-- Creates a new order for the customer on the driver's CURRENT route, with a
-- pending pickup stop that the driver then completes through the normal pickup
-- flow (photo, bag count, "picked up" text via complete_route_stop). Delivery is
-- scheduled the same way the recurring generator does it: pickup day + zone
-- turnaround, skipping Sundays/holidays, snapped to the zone's template grid,
-- then auto_route_order() places the delivery stop. If no delivery slot is found
-- the order still exists with routing_error set, so the office can schedule it.
--
-- Pricing mirrors trg_create_recurring_order_fn's re-price block (session 294d):
-- customer's current pricelist service × bags, delivery fee unless fee_exempt,
-- the customer's percent discount, pref_service lines scaled from the delivery
-- order, and the customer's default tip. Intake re-prices on weigh-in anyway.
--
-- Auth: assert_staff, then caller must be an admin OR a driver on this route.
-- No new tables/columns. Reversible: DROP FUNCTION public.driver_add_pickup(uuid, integer, text);

CREATE OR REPLACE FUNCTION public.driver_add_pickup(
  p_from_stop_id uuid,
  p_bags         integer,
  p_actor_name   text DEFAULT 'Driver'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stop      route_stops%ROWTYPE;
  v_route     routes%ROWTYPE;
  v_tmpl      route_templates%ROWTYPE;
  v_src       orders%ROWTYPE;
  v_cust      customers%ROWTYPE;
  v_svc       RECORD;
  v_existing  RECORD;
  v_snap      RECORD;
  v_actor     text := COALESCE(NULLIF(trim(p_actor_name), ''), 'Driver');
  v_claims    text := current_setting('request.jwt.claims', true);
  v_pricelist text;
  v_fee       numeric;
  v_li        jsonb := '[]'::jsonb;
  v_total     numeric;
  v_pct       numeric;
  v_dname     text;
  v_discb     numeric;
  v_old_bags  int;
  v_tip       numeric := 0;
  v_tip_type  text;
  v_step      int;
  v_pu_start  timestamptz;
  v_pu_end    timestamptz;
  v_override  uuid;
  v_zone      uuid;
  v_turn      int;
  v_del_tgt   timestamptz;
  v_del_start timestamptz;
  v_del_end   timestamptz;
  v_guard     int := 0;
  v_new_id    uuid;
  v_new_no    bigint;
  v_new_stop  uuid;
  v_next      int;
  v_rt_err    text;
BEGIN
  PERFORM public.assert_staff('driver_add_pickup');

  IF p_bags IS NULL OR p_bags < 1 OR p_bags > 30 THEN
    RAISE EXCEPTION 'Bag count must be between 1 and 30' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_stop FROM route_stops WHERE id = p_from_stop_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stop not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_stop.stop_type <> 'delivery' OR v_stop.order_id IS NULL OR v_stop.route_id IS NULL THEN
    RAISE EXCEPTION 'A pickup can only be added from a delivery stop on a route' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Caller must be an admin, or a driver assigned to this route. (Direct SQL /
  -- service_role pass, matching assert_staff.)
  IF NOT (
       v_claims IS NULL OR v_claims = ''
       OR COALESCE(auth.role(), '') = 'service_role'
       OR public.is_admin()
       OR v_stop.route_id IN (SELECT public.current_driver_route_ids())
     ) THEN
    RAISE EXCEPTION 'Not authorized — this stop is not on your route' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Lock the route row: serializes double-taps and stop_number allocation.
  SELECT * INTO v_route FROM routes WHERE id = v_stop.route_id FOR UPDATE;
  SELECT * INTO v_src   FROM orders WHERE id = v_stop.order_id;
  SELECT * INTO v_cust  FROM customers WHERE id = v_src.customer_id;
  IF v_cust.id IS NULL THEN
    RAISE EXCEPTION 'Customer not found for this stop' USING ERRCODE = 'no_data_found';
  END IF;

  -- Double-tap / retry guard: a driver-added pickup for this customer + address on
  -- this route in the last 30 minutes is returned instead of creating a second one.
  SELECT o.id AS order_id, o.order_number, rs.id AS stop_id INTO v_existing
  FROM orders o
  JOIN route_stops rs ON rs.order_id = o.id AND rs.stop_type = 'pickup' AND rs.route_id = v_stop.route_id
  WHERE o.customer_id = v_src.customer_id
    AND o.pickup_address_id IS NOT DISTINCT FROM v_stop.address_id
    AND o.created_at > now() - interval '30 minutes'
    AND o.status IN ('scheduled', 'picked_up')
    AND EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.event_type = 'driver_added_pickup')
  ORDER BY o.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('order_id', v_existing.order_id, 'order_number', v_existing.order_number,
                              'stop_id', v_existing.stop_id, 'already_existed', true);
  END IF;

  -- ── Pickup window: the delivery's own window when it is on this route's day
  -- (already aligned to this route's grid), else the route template's first slot.
  SELECT * INTO v_tmpl FROM route_templates WHERE id = v_route.template_id;
  v_step := COALESCE(v_tmpl.arrival_window_hours, 2) * 60;
  IF v_step <= 0 THEN v_step := 60; END IF;
  IF v_src.delivery_window_start IS NOT NULL AND v_src.delivery_window_end IS NOT NULL
     AND (v_src.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::date = v_route.run_date THEN
    v_pu_start := v_src.delivery_window_start;
    v_pu_end   := v_src.delivery_window_end;
  ELSIF v_tmpl.id IS NOT NULL THEN
    v_pu_start := (v_route.run_date::timestamp + v_tmpl.window_start) AT TIME ZONE 'America/Los_Angeles';
    v_pu_end   := v_pu_start + v_step * interval '1 minute';
  ELSE
    v_pu_start := date_trunc('hour', now());
    v_pu_end   := v_pu_start + interval '2 hours';
  END IF;

  -- ── Pricing (mirrors trg_create_recurring_order_fn re-price, session 294d) ──
  v_pricelist := COALESCE(v_cust.pricelist, 'Delivery');
  SELECT id, name, base_price, pricing_type INTO v_svc FROM services
   WHERE pricelist = v_pricelist AND is_active AND NOT is_addon
   ORDER BY sort_order, name LIMIT 1;
  IF v_svc.id IS NULL THEN
    SELECT id, name, base_price, pricing_type INTO v_svc FROM services WHERE id = v_src.service_id;
  END IF;
  IF v_svc.id IS NULL THEN
    RAISE EXCEPTION 'No active service for pricelist % — cannot price this pickup', v_pricelist;
  END IF;

  IF v_svc.pricing_type <> 'per_lb' THEN
    v_li := jsonb_build_array(jsonb_build_object(
      'type', 'base',
      'label', v_svc.name || ' · ' || p_bags || ' bag' || CASE WHEN p_bags > 1 THEN 's' ELSE '' END
               || ' × $' || TO_CHAR(v_svc.base_price, 'FM999990.00'),
      'amount', p_bags * v_svc.base_price,
      'taxable', false));
  END IF;

  -- Customer preference services (e.g. "Oxi × 1 bag") — per bag, scaled to the new count.
  v_old_bags := COALESCE(v_src.total_bags, 0);
  IF v_old_bags > 0 THEN
    v_li := v_li || COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'type',   'pref_service',
                 'label',  split_part(e->>'label', ' × ', 1) || ' × ' || p_bags || ' bag' || CASE WHEN p_bags > 1 THEN 's' ELSE '' END,
                 'amount', round((e->>'amount')::numeric / v_old_bags * p_bags, 2))
               || CASE WHEN e ? 'service_id' THEN jsonb_build_object('service_id', e->'service_id') ELSE '{}'::jsonb END)
        FROM jsonb_array_elements(COALESCE(v_src.line_items, '[]'::jsonb)) t(e)
       WHERE e->>'type' = 'pref_service'), '[]'::jsonb);
  END IF;

  IF v_svc.pricing_type <> 'per_lb' AND NOT COALESCE(v_cust.fee_exempt, false) THEN
    SELECT amount INTO v_fee FROM service_fees
     WHERE name = 'Delivery Fee' AND is_active
       AND (pricelist = v_pricelist OR pricelist IS NULL)
     ORDER BY (pricelist = v_pricelist) DESC NULLS LAST LIMIT 1;
    IF COALESCE(v_fee, 0) > 0 OR v_pricelist = 'Subscription' THEN
      v_li := v_li || jsonb_build_array(jsonb_build_object(
        'type', 'delivery_fee', 'label', 'Delivery fee', 'amount', COALESCE(v_fee, 0), 'taxable', false));
    END IF;
  END IF;

  SELECT d.value, d.name INTO v_pct, v_dname
    FROM discounts d WHERE d.id = v_cust.discount_id AND d.active AND d.type = 'percent';
  SELECT COALESCE(sum((e->>'amount')::numeric), 0) INTO v_discb
    FROM jsonb_array_elements(v_li) t(e)
   WHERE e->>'type' IN ('base', 'overage', 'addon', 'addon_service', 'pref_service');
  IF COALESCE(v_pct, 0) > 0 AND v_discb > 0 THEN
    v_li := v_li || jsonb_build_array(jsonb_build_object(
      'type', 'discount',
      'label', v_dname || ' (' || trim(to_char(v_pct, 'FM999990.##')) || '% off)',
      'amount', -round(v_discb * v_pct / 100.0, 2)));
  END IF;

  SELECT COALESCE(sum((e->>'amount')::numeric), 0) INTO v_total FROM jsonb_array_elements(v_li) t(e);
  v_total := GREATEST(v_total, 0);

  IF COALESCE(v_cust.default_tip, 0) > 0 THEN
    v_tip      := v_cust.default_tip;
    v_tip_type := CASE v_cust.default_tip_type WHEN '%' THEN 'pct' ELSE 'dollar' END;
  END IF;

  -- ── Delivery window (mirrors recurring generator + auto_route_order turnaround) ──
  v_override := public.route_override_for(v_src.customer_id, v_stop.address_id);
  IF v_override IS NOT NULL THEN
    SELECT zone_id INTO v_zone FROM route_templates WHERE id = v_override;
  END IF;
  v_zone := COALESCE(v_zone, v_src.zone_id);

  IF v_zone IS NOT NULL THEN
    SELECT turnaround_days INTO v_turn FROM route_templates WHERE zone_id = v_zone AND is_active = TRUE LIMIT 1;
    v_del_tgt := v_pu_start + (GREATEST(COALESCE(v_turn, 1), 1) || ' days')::interval;
    WHILE (EXTRACT(DOW FROM v_del_tgt AT TIME ZONE 'America/Los_Angeles') = 0
           OR public.is_holiday((v_del_tgt AT TIME ZONE 'America/Los_Angeles')::date))
          AND v_guard < 10 LOOP
      v_del_tgt := v_del_tgt + interval '1 day';
      v_guard := v_guard + 1;
    END LOOP;
    SELECT * INTO v_snap FROM public.snap_window_to_template(v_zone, v_del_tgt, v_override);
    IF v_snap.snapped_start IS NOT NULL AND v_snap.snapped_start > v_pu_end THEN
      v_del_start := v_snap.snapped_start;
      v_del_end   := v_snap.snapped_end;
    END IF;
  END IF;

  -- ── Create the order. pickup_run_id is set, so auto_route_on_insert skips it. ──
  INSERT INTO orders (
    customer_id, service_id, status, source,
    total_bags, total_amount, tip_amount, tip_type,
    pickup_address_id, delivery_address_id,
    pickup_window_start, pickup_window_end,
    delivery_window_start, delivery_window_end,
    pickup_run_id, zone_id, special_instructions, line_items
  ) VALUES (
    v_src.customer_id, v_svc.id, 'scheduled', 'scheduled',
    p_bags, v_total, v_tip, v_tip_type,
    v_stop.address_id, v_stop.address_id,
    v_pu_start, v_pu_end,
    v_del_start, v_del_end,
    v_stop.route_id, v_zone, v_src.special_instructions, v_li
  ) RETURNING id, order_number INTO v_new_id, v_new_no;

  SELECT COALESCE(MAX(stop_number), 0) + 1 INTO v_next FROM route_stops WHERE route_id = v_stop.route_id;
  INSERT INTO route_stops (id, route_id, order_id, stop_type, stop_number, address_id, status, driver_id)
  VALUES (gen_random_uuid(), v_stop.route_id, v_new_id, 'pickup', v_next, v_stop.address_id, 'pending', v_stop.driver_id)
  RETURNING id INTO v_new_stop;

  INSERT INTO order_events (order_id, event_type, description, actor_name, new_value)
  VALUES (v_new_id, 'driver_added_pickup',
          'Pickup added by driver while delivering #' || v_src.order_number || ' — ' || p_bags || ' bag' || CASE WHEN p_bags > 1 THEN 's' ELSE '' END,
          v_actor, v_src.id::text);

  -- ── Place the delivery stop. Never let a routing problem undo the pickup. ──
  IF v_del_start IS NULL THEN
    UPDATE orders SET routing_error = 'Added by driver — no delivery slot found, schedule delivery manually'
     WHERE id = v_new_id;
  ELSE
    BEGIN
      PERFORM public.auto_route_order(v_new_id);
    EXCEPTION WHEN OTHERS THEN
      UPDATE orders SET routing_error = 'Added by driver — delivery not scheduled: ' || left(SQLERRM, 200)
       WHERE id = v_new_id;
    END;
  END IF;

  SELECT routing_error, delivery_window_start INTO v_rt_err, v_del_start FROM orders WHERE id = v_new_id;

  RETURN jsonb_build_object(
    'order_id',              v_new_id,
    'order_number',          v_new_no,
    'stop_id',               v_new_stop,
    'total_amount',          v_total,
    'delivery_window_start', v_del_start,
    'routing_error',         v_rt_err,
    'already_existed',       false
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.driver_add_pickup(uuid, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.driver_add_pickup(uuid, integer, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.driver_add_pickup(uuid, integer, text) TO authenticated, service_role;
