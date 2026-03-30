-- Migration: sync_stop_address_on_order_address_change
-- Applied: Mar 29, 2026 (session 79)
--
-- Fixes latent bug: changing an order's pickup/delivery address_id without changing
-- the pickup/delivery window left the corresponding route_stop's address_id stale.
-- Net effect: driver would navigate to the customer's old address.
--
-- Discovered during audit session 79 with 0 current instances, but structurally
-- inevitable since both the customer app edit flow and admin order edit allow
-- changing the address independently from the schedule window.
--
-- The window-change triggers (trg_sync_pickup_stop_on_window_change,
-- trg_sync_delivery_stop_on_window_change) only fire on pickup_window_start /
-- delivery_window_start changes — not on address_id changes. This trigger fills that gap.
--
-- Rollback:
--   DROP TRIGGER trg_sync_stop_address_on_order_address_change ON orders;
--   DROP FUNCTION sync_stop_address_on_order_address_change();

CREATE OR REPLACE FUNCTION sync_stop_address_on_order_address_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Sync pickup stop address if pickup_address_id changed
  IF NEW.pickup_address_id IS DISTINCT FROM OLD.pickup_address_id
     AND NEW.pickup_address_id IS NOT NULL THEN
    UPDATE route_stops
    SET address_id = NEW.pickup_address_id
    WHERE order_id = NEW.id
      AND stop_type = 'pickup'
      AND status = 'pending';
  END IF;

  -- Sync delivery stop address if delivery_address_id changed
  IF NEW.delivery_address_id IS DISTINCT FROM OLD.delivery_address_id
     AND NEW.delivery_address_id IS NOT NULL THEN
    UPDATE route_stops
    SET address_id = NEW.delivery_address_id
    WHERE order_id = NEW.id
      AND stop_type = 'delivery'
      AND status = 'pending';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sync_stop_address_on_order_address_change
  AFTER UPDATE ON orders
  FOR EACH ROW
  WHEN (
    NEW.pickup_address_id IS DISTINCT FROM OLD.pickup_address_id
    OR NEW.delivery_address_id IS DISTINCT FROM OLD.delivery_address_id
  )
  EXECUTE FUNCTION sync_stop_address_on_order_address_change();
