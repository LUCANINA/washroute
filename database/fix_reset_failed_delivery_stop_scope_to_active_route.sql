-- Migration: fix_reset_failed_delivery_stop_scope_to_active_route
-- Applied: 2026-03-29
-- Problem: reset_failed_delivery_stop() was resetting ALL failed delivery/pickup
--   stops for an order when delivery_run_id or pickup_run_id changed — including
--   old historical stops on past routes. Discovered when rescheduling Level Up
--   Wellness #522: updating delivery_run_id to a Mar 30 route revived the old
--   Mar 25 failed stop to 'pending', which could have sent a driver to the wrong
--   date route.
-- Fix: scope each reset to stops on the specific new route only
--   (route_id = NEW.delivery_run_id / route_id = NEW.pickup_run_id).
--   Old stops on past routes are untouched.
-- Rollback: remove the route_id conditions from both WHERE clauses.

CREATE OR REPLACE FUNCTION public.reset_failed_delivery_stop()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Reset failed delivery stop when delivery is rescheduled,
  -- but ONLY the stop on the new delivery route (not old historical stops).
  IF (
    OLD.delivery_window_start IS DISTINCT FROM NEW.delivery_window_start OR
    OLD.delivery_window_end   IS DISTINCT FROM NEW.delivery_window_end   OR
    OLD.delivery_run_id       IS DISTINCT FROM NEW.delivery_run_id
  ) THEN
    UPDATE route_stops
    SET status = 'pending', updated_at = NOW()
    WHERE order_id   = NEW.id
      AND stop_type  = 'delivery'
      AND status     = 'failed'
      AND route_id   = NEW.delivery_run_id;
  END IF;

  -- Reset failed pickup stop when pickup is rescheduled,
  -- but ONLY the stop on the new pickup route.
  IF (
    OLD.pickup_window_start IS DISTINCT FROM NEW.pickup_window_start OR
    OLD.pickup_window_end   IS DISTINCT FROM NEW.pickup_window_end   OR
    OLD.pickup_run_id       IS DISTINCT FROM NEW.pickup_run_id
  ) THEN
    UPDATE route_stops
    SET status = 'pending', updated_at = NOW()
    WHERE order_id   = NEW.id
      AND stop_type  = 'pickup'
      AND status     = 'failed'
      AND route_id   = NEW.pickup_run_id;
  END IF;

  RETURN NEW;
END;
$function$;
