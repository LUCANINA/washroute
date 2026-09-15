-- Session 294c (audit 2026-09-15): auto_fail_expired_orders re-failed orders minutes
-- after staff reset them. Claire Tolan #13219: Luis set it back to Ready at 16:23 on
-- 8/31 without moving the window; the 16:30 run failed it again.
--
-- Two changes, both in the candidate query only (the UPDATEs and SMS path are unchanged):
--  1. Skip an order a STAFF member (order_events actor <> 'System') changed status on
--     in the last hour, or moved OUT of a failed status in the last 24 hours — a reset
--     is a human decision to handle it; the job must not overrule it.
--  2. Only look at ACTIVE stops (pending / en_route). Old failed/completed stops from an
--     earlier attempt no longer feed the "window passed" calculation.
--
-- Rollback: re-run the previous definition (pg_get_functiondef captured below).
--   Previous candidate joins were:
--     LEFT JOIN route_stops rs ON rs.order_id = o.id AND rs.stop_type = 'pickup'|'delivery'
--   with no staff-reset exclusion. Everything else identical.

CREATE OR REPLACE FUNCTION public.auto_fail_expired_orders()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec            RECORD;
  v_phone          TEXT;
  v_first          TEXT;
  v_pickup_body    TEXT;
  v_delivery_body  TEXT;
  v_msg            TEXT;
  v_base_url       TEXT := 'https://umjpbuxrdydwejqtensq.supabase.co';
BEGIN
  PERFORM public.assert_staff('auto_fail_expired_orders');
  SELECT sms_body INTO v_pickup_body
  FROM message_templates
  WHERE trigger_key = 'pickup_failed' AND sms_enabled = true;

  SELECT sms_body INTO v_delivery_body
  FROM message_templates
  WHERE trigger_key = 'delivery_failed' AND sms_enabled = true;

  -- ── PICKUP failures ──
  FOR v_rec IN
    SELECT DISTINCT o.id, o.customer_id, c.phone_cache, c.first_name_cache
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN route_stops rs ON rs.order_id = o.id AND rs.stop_type = 'pickup'
                            AND rs.status IN ('pending', 'en_route')
    LEFT JOIN routes r ON r.id = rs.route_id
    LEFT JOIN route_templates rt ON rt.id = r.template_id
    WHERE o.status = 'scheduled'
      AND o.pickup_window_end IS NOT NULL
      AND GREATEST(
            o.pickup_window_end,
            CASE WHEN r.run_date IS NOT NULL AND rt.window_end IS NOT NULL
                 THEN (r.run_date + rt.window_end) AT TIME ZONE 'America/Los_Angeles'
                 ELSE o.pickup_window_end END
          ) + INTERVAL '2 hours' < NOW()
      AND NOT EXISTS (
            SELECT 1 FROM order_events oe
            WHERE oe.order_id = o.id
              AND oe.event_type = 'status_change'
              AND COALESCE(oe.actor_name, 'System') <> 'System'
              AND (oe.created_at > NOW() - INTERVAL '1 hour'
                   OR (oe.old_value IN ('pickup_failed', 'delivery_failed')
                       AND oe.created_at > NOW() - INTERVAL '24 hours')))
  LOOP
    UPDATE orders
    SET status = 'pickup_failed', cancelled_by = 'system', updated_at = NOW()
    WHERE id = v_rec.id;

    UPDATE route_stops SET status = 'failed', updated_at = NOW()
    WHERE order_id = v_rec.id AND stop_type = 'pickup' AND status IN ('pending', 'en_route');

    v_phone := v_rec.phone_cache;
    v_first := COALESCE(v_rec.first_name_cache, 'there');

    IF v_phone IS NOT NULL AND v_phone != '' AND v_pickup_body IS NOT NULL THEN
      v_msg := replace(v_pickup_body, '{{first_name}}', v_first);
      PERFORM net.http_post(
        url     := v_base_url || '/functions/v1/send-sms',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body    := jsonb_build_object('to', v_phone, 'body', v_msg, 'customer_id', v_rec.customer_id)
      );
    END IF;
  END LOOP;

  -- ── DELIVERY failures ──
  FOR v_rec IN
    SELECT DISTINCT o.id, o.customer_id, c.phone_cache, c.first_name_cache
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN route_stops rs ON rs.order_id = o.id AND rs.stop_type = 'delivery'
                            AND rs.status IN ('pending', 'en_route')
    LEFT JOIN routes r ON r.id = rs.route_id
    LEFT JOIN route_templates rt ON rt.id = r.template_id
    WHERE o.status IN ('ready_for_delivery', 'out_for_delivery')
      AND o.delivery_window_end IS NOT NULL
      AND GREATEST(
            o.delivery_window_end,
            CASE WHEN r.run_date IS NOT NULL AND rt.window_end IS NOT NULL
                 THEN (r.run_date + rt.window_end) AT TIME ZONE 'America/Los_Angeles'
                 ELSE o.delivery_window_end END
          ) + INTERVAL '2 hours' < NOW()
      AND NOT EXISTS (
            SELECT 1 FROM order_events oe
            WHERE oe.order_id = o.id
              AND oe.event_type = 'status_change'
              AND COALESCE(oe.actor_name, 'System') <> 'System'
              AND (oe.created_at > NOW() - INTERVAL '1 hour'
                   OR (oe.old_value IN ('pickup_failed', 'delivery_failed')
                       AND oe.created_at > NOW() - INTERVAL '24 hours')))
  LOOP
    UPDATE orders
    SET status = 'delivery_failed', cancelled_by = 'system', updated_at = NOW()
    WHERE id = v_rec.id;

    UPDATE route_stops SET status = 'failed', updated_at = NOW()
    WHERE order_id = v_rec.id AND stop_type = 'delivery' AND status IN ('pending', 'en_route');

    v_phone := v_rec.phone_cache;
    v_first := COALESCE(v_rec.first_name_cache, 'there');

    IF v_phone IS NOT NULL AND v_phone != '' AND v_delivery_body IS NOT NULL THEN
      v_msg := replace(v_delivery_body, '{{first_name}}', v_first);
      PERFORM net.http_post(
        url     := v_base_url || '/functions/v1/send-sms',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body    := jsonb_build_object('to', v_phone, 'body', v_msg, 'customer_id', v_rec.customer_id)
      );
    END IF;
  END LOOP;
END;
$function$;

DO $a$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname = 'auto_fail_expired_orders'), 'pickup_failed'', ''delivery_failed''') = 0
     OR (SELECT count(*) FROM regexp_matches((SELECT prosrc FROM pg_proc WHERE proname = 'auto_fail_expired_orders'), 'NOT EXISTS', 'g')) <> 2 THEN
    RAISE EXCEPTION 'auto_fail_expired_orders: staff-reset guard missing from one loop';
  END IF;
END
$a$;
