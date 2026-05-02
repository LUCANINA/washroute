-- Migration: session_141_pickup_failed_recovery_fix
-- Purpose: When an order recovers from pickup_failed (admin manually intakes
--   after a driver pickup_failed event, or status is reverted), the
--   corresponding route_stops were never restored from 'skipped'/'failed' back
--   to 'pending'. The order proceeded through the system but the stop record
--   stayed orphaned, making the eventual delivery invisible to drivers + admin.
--   Surfaced by Linda vonHoene #3523 reported May 2 2026.
--
-- Fix:
--   (a) sync_stops_on_order_status_advance trigger now overwrites stop status
--       regardless of prior 'skipped'/'failed' on forward advance, AND restores
--       delivery stop to 'pending' when order moves back into the active flow
--       before out_for_delivery.
--   (b) advance_order_status RPC now treats fail-state → active-state as a
--       forward advance (a "recovery") and clears stale cancelled_by +
--       driver_skip_reason on forward advance, mirroring the existing
--       routing_error clearing.

CREATE OR REPLACE FUNCTION public.sync_stops_on_order_status_advance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Pickup stop: if order advanced past pickup phase, mark pickup stop complete.
  -- Session 141: now overwrites prior 'skipped'/'failed' so admin-recovered
  -- pickups (manual intake after a driver pickup_failed) heal the stop record.
  -- The historical fail is preserved in order_events.
  IF NEW.status IN ('picked_up','processing','folding','ready_for_delivery','out_for_delivery','delivered') THEN
    UPDATE route_stops SET
      status       = 'complete',
      completed_at = COALESCE(completed_at, now()),
      updated_at   = now()
    WHERE order_id = NEW.id
      AND stop_type = 'pickup'
      AND status   <> 'complete';
  END IF;

  -- Session 141 NEW BRANCH: when order is back on active flow but delivery
  -- hasn't started, restore any 'skipped'/'failed' delivery stop to 'pending'
  -- so the driver app surfaces it. The terminal trigger marks delivery stops
  -- 'skipped' on pickup_failed; this branch heals that on recovery. Bounded
  -- to before out_for_delivery so the normal route_stop state machine owns
  -- the stop once a driver has started the delivery.
  IF NEW.status IN ('picked_up','processing','folding','ready_for_delivery') THEN
    UPDATE route_stops SET
      status     = 'pending',
      updated_at = now()
    WHERE order_id  = NEW.id
      AND stop_type = 'delivery'
      AND status IN ('skipped','failed');
  END IF;

  -- Delivery stop: order delivered → mark delivery stop complete (now also
  -- overwrites any prior skipped/failed left over from a recovered cycle).
  IF NEW.status = 'delivered' THEN
    UPDATE route_stops SET
      status       = 'complete',
      completed_at = COALESCE(completed_at, now()),
      updated_at   = now()
    WHERE order_id  = NEW.id
      AND stop_type = 'delivery'
      AND status   <> 'complete';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.advance_order_status(
  p_order_id uuid,
  p_new_status text,
  p_actor_name text DEFAULT 'System'::text,
  p_cancelled_by text DEFAULT NULL::text,
  p_driver_skip_reason text DEFAULT NULL::text,
  p_adjusted_bags integer DEFAULT NULL::integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order              orders%ROWTYPE;
  v_old_status         text;
  v_is_forward         bool := false;
  v_needs_pickup_ts    bool := false;
  v_needs_delivery_ts  bool := false;
  v_needs_cancelled_by bool := false;
  v_valid_statuses text[] := ARRAY[
    'scheduled','picked_up','processing','folding','ready_for_delivery',
    'out_for_delivery','delivered',
    'skipped','cancelled','pickup_failed','delivery_failed','on_hold'
  ];
  v_status_order text[] := ARRAY[
    'scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery','delivered'
  ];
  v_cancel_statuses text[] := ARRAY['skipped','cancelled','pickup_failed','delivery_failed'];
  v_old_idx int;
  v_new_idx int;
BEGIN
  IF p_new_status IS NULL OR NOT (p_new_status = ANY(v_valid_statuses)) THEN
    RAISE EXCEPTION 'Invalid p_new_status: % (allowed: %)', p_new_status, v_valid_statuses
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE = 'no_data_found';
  END IF;

  v_old_status := v_order.status;

  IF v_old_status = p_new_status AND p_adjusted_bags IS NULL THEN
    RETURN jsonb_build_object(
      'order_id', p_order_id, 'old_status', v_old_status, 'new_status', p_new_status,
      'changed', false, 'note', 'already in target status'
    );
  END IF;

  IF v_old_status IN ('delivered','cancelled','skipped') AND p_new_status <> 'on_hold' THEN
    RAISE EXCEPTION 'Cannot advance order % from terminal status % to %. Roll back to on_hold first.',
      p_order_id, v_old_status, p_new_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_needs_pickup_ts    := (p_new_status = 'picked_up'  AND v_order.actual_pickup_at   IS NULL);
  v_needs_delivery_ts  := (p_new_status = 'delivered' AND v_order.actual_delivery_at IS NULL);
  v_needs_cancelled_by := (p_new_status = ANY(v_cancel_statuses));

  IF v_needs_cancelled_by AND p_cancelled_by IS NULL THEN
    RAISE EXCEPTION 'Status % requires p_cancelled_by (''customer''|''driver''|''admin''|''system'')',
      p_new_status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_cancelled_by IS NOT NULL
     AND p_cancelled_by NOT IN ('customer','driver','admin','system') THEN
    RAISE EXCEPTION 'p_cancelled_by must be one of customer|driver|admin|system (got: %)',
      p_cancelled_by USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_old_idx := array_position(v_status_order, v_old_status);
  v_new_idx := array_position(v_status_order, p_new_status);
  v_is_forward := (v_old_idx IS NOT NULL AND v_new_idx IS NOT NULL AND v_new_idx > v_old_idx);

  -- Session 141: treat any move FROM a fail/skip/hold status TO an active
  -- status as forward (a "recovery"). Without this, recovering from
  -- pickup_failed → scheduled wouldn't clear cancelled_by/routing_error.
  IF NOT v_is_forward
     AND v_old_status IN ('pickup_failed','delivery_failed','skipped','cancelled','on_hold')
     AND p_new_status = ANY(v_status_order) THEN
    v_is_forward := true;
  END IF;

  INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
  VALUES (
    p_order_id, 'status_change', initcap(replace(p_new_status, '_', ' ')),
    v_old_status, p_new_status, p_actor_name
  );

  UPDATE orders SET
    status             = p_new_status,
    actual_pickup_at   = CASE WHEN v_needs_pickup_ts   THEN NOW() ELSE actual_pickup_at   END,
    actual_delivery_at = CASE WHEN v_needs_delivery_ts THEN NOW() ELSE actual_delivery_at END,
    cancelled_by       = CASE
                           WHEN v_needs_cancelled_by THEN p_cancelled_by
                           WHEN v_is_forward          THEN NULL  -- session 141: clear stale on recovery
                           ELSE cancelled_by
                         END,
    driver_skip_reason = CASE
                           WHEN p_driver_skip_reason IS NOT NULL THEN p_driver_skip_reason
                           WHEN v_is_forward                     THEN NULL  -- session 141
                           ELSE driver_skip_reason
                         END,
    routing_error      = CASE
                           WHEN v_is_forward THEN NULL
                           ELSE routing_error
                         END,
    total_bags         = CASE
                           WHEN p_adjusted_bags IS NOT NULL AND p_adjusted_bags > 0
                             THEN p_adjusted_bags
                           ELSE total_bags
                         END,
    updated_at         = NOW()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'order_id',             p_order_id,
    'old_status',           v_old_status,
    'new_status',           p_new_status,
    'changed',              true,
    'stamped_pickup_at',    v_needs_pickup_ts,
    'stamped_delivery_at',  v_needs_delivery_ts,
    'stamped_cancelled_by', v_needs_cancelled_by,
    'cleared_routing_error', (v_is_forward AND v_order.routing_error IS NOT NULL),
    'cleared_cancelled_by',  (v_is_forward AND NOT v_needs_cancelled_by AND v_order.cancelled_by IS NOT NULL),
    'bags_adjusted',        (p_adjusted_bags IS NOT NULL AND p_adjusted_bags <> v_order.total_bags),
    'is_forward',           v_is_forward
  );
END;
$function$;
