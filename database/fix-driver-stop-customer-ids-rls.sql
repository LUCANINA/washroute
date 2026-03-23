-- Fix: driver_stop_customer_ids() was missing r.driver_id check
-- Bug: when stops were reassigned between routes, driver_id on route_stops was set to NULL
-- (meaning "inherit from route's default driver"). But the RLS function only checked
-- rs.driver_id, r.pickup_driver_id, and r.delivery_driver_id — NOT r.driver_id.
-- This caused the driver to see "Customer" with no name/address for reassigned stops.
-- Applied: 2026-03-23

CREATE OR REPLACE FUNCTION driver_stop_customer_ids()
RETURNS TABLE(customer_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT DISTINCT o.customer_id
  FROM orders o
  JOIN route_stops rs ON rs.order_id = o.id
  LEFT JOIN routes r ON r.id = rs.route_id
  WHERE (
    rs.driver_id = current_driver_id()
    OR r.driver_id             = current_driver_id()
    OR r.pickup_driver_id      = current_driver_id()
    OR r.delivery_driver_id    = current_driver_id()
  )
  AND o.customer_id IS NOT NULL;
$$;
