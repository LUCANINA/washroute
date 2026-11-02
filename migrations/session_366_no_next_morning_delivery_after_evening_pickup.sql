-- Session 366 (2026-11-02): block "evening pickup → next-morning delivery".
-- Bug: customer Edit Order (and admin order panel) offered 7–10am delivery the
-- morning after a 7–10pm pickup. Both screens are fixed; this is the DB backstop.
--
-- Rule: pickup starting at/after 5pm Pacific → a delivery on the NEXT calendar
-- day must start at/after noon. Same-day service and deliveries 2+ days out are
-- untouched. Measured before shipping: 0 open orders violate it; 1 in the last
-- 90 days (#16918, pickup_failed); 131 in the last year, almost all
-- March–April 2026 Starchup-era recurring orders.
--
-- Scope, deliberately narrow:
--   * UPDATE only, and only when pickup_window_start or delivery_window_start
--     actually changes (re-saving an old order with unchanged times never trips).
--   * pg_trigger_depth() = 1 only: a direct reschedule (reschedule_order /
--     reschedule_order_leg / recall_delivered_order / direct .update()).
--     Automatic follow-on updates from other triggers (auto-routing a freshly
--     created recurring order inside the "mark delivered" chain) are exempt, so
--     this can never block a driver marking an order delivered.
--   * INSERTs are not checked (new-order screens already filter).
--
-- ROLLBACK: re-run the original body (kept at the bottom of this file).

CREATE OR REPLACE FUNCTION public.enforce_pickup_before_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_p timestamp;
  v_d timestamp;
BEGIN
  IF NEW.pickup_window_end IS NOT NULL
     AND NEW.delivery_window_start IS NOT NULL
     AND NEW.delivery_window_start <= NEW.pickup_window_end
  THEN
    RAISE EXCEPTION
      'Order %: delivery window (start: %) must begin strictly after pickup window (end: %). Adjust delivery before saving, or call reschedule_order() with both legs together.',
      COALESCE(NEW.order_number::text, NEW.id::text),
      NEW.delivery_window_start,
      NEW.pickup_window_end
      USING ERRCODE = 'check_violation';
  END IF;

  -- Session 366: evening pickup → next-morning delivery is not enough time.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() = 1
     AND NEW.pickup_window_start IS NOT NULL
     AND NEW.delivery_window_start IS NOT NULL
     AND (NEW.pickup_window_start   IS DISTINCT FROM OLD.pickup_window_start
       OR NEW.delivery_window_start IS DISTINCT FROM OLD.delivery_window_start)
  THEN
    v_p := NEW.pickup_window_start   AT TIME ZONE 'America/Los_Angeles';
    v_d := NEW.delivery_window_start AT TIME ZONE 'America/Los_Angeles';
    IF v_p::time >= time '17:00'
       AND v_d::date = v_p::date + 1
       AND v_d::time < time '12:00'
    THEN
      RAISE EXCEPTION
        'That delivery time is too soon after an evening pickup — next-day delivery must be noon or later.'
        USING ERRCODE = 'check_violation',
              DETAIL  = format('Order %s: pickup %s, delivery %s (Pacific)',
                               COALESCE(NEW.order_number::text, NEW.id::text), v_p, v_d);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ── Original body, for rollback ──────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION public.enforce_pickup_before_delivery()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SET search_path TO 'public', 'pg_temp'
-- AS $function$
-- BEGIN
--   IF NEW.pickup_window_end IS NOT NULL
--      AND NEW.delivery_window_start IS NOT NULL
--      AND NEW.delivery_window_start <= NEW.pickup_window_end
--   THEN
--     RAISE EXCEPTION
--       'Order %: delivery window (start: %) must begin strictly after pickup window (end: %). Adjust delivery before saving, or call reschedule_order() with both legs together.',
--       COALESCE(NEW.order_number::text, NEW.id::text),
--       NEW.delivery_window_start,
--       NEW.pickup_window_end
--       USING ERRCODE = 'check_violation';
--   END IF;
--   RETURN NEW;
-- END;
-- $function$;
