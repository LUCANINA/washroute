-- Session 351 (2026-10-19): close "any logged-in user can read everything" policies.
--
-- Found: SELECT policies with USING (true) for role authenticated — so every CUSTOMER
-- account could read, straight from the API:
--   route_stops   28k rows: driver notes, delivery proof-photo URLs (public bucket), order/address ids
--   routes        every route run, driver assignments
--   drivers       license numbers + expiry, plates, last GPS position
--   driver_locations  live driver GPS
--   billing_groups    B2B invoice contacts
--   route_driver_overrides, loan_settled_write_attempts (bookkeeping)
-- None of the customer app's direct queries need these except `routes` (reschedule looks
-- up a run by template + date, and an order's current runs). All route-touching RPCs the
-- customer and driver apps call are SECURITY DEFINER, so they are unaffected.
--
-- New access:
--   ops staff (admin, manager, laundry_tech, attendant, pos_device) — read all, as before
--   drivers   — their own routes/stops, own drivers row, own GPS row
--   customers — routes for their own orders + upcoming runs (no customer data in routes);
--               nothing else on this list
--   bookkeeping log — admin/manager/cpa, like every other loan table

CREATE OR REPLACE FUNCTION public.is_ops_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid()
                     AND role IN ('admin','manager','laundry_tech','attendant','pos_device')); $$;

-- Definer helpers so policies don't reference each other's tables (routes → orders →
-- route_stops → routes is infinite policy recursion).
CREATE OR REPLACE FUNCTION public.current_customer_run_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT pickup_run_id FROM public.orders WHERE customer_id = public.current_customer_id() AND pickup_run_id IS NOT NULL
      UNION SELECT delivery_run_id FROM public.orders WHERE customer_id = public.current_customer_id() AND delivery_run_id IS NOT NULL; $$;
CREATE OR REPLACE FUNCTION public.current_driver_route_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT id FROM public.routes WHERE public.current_driver_id() IN (driver_id, pickup_driver_id, delivery_driver_id); $$;
-- Routes where the driver has at least one stop reassigned to them (the route itself is
-- someone else's). Needed so the addresses/orders driver policies, which join through
-- routes, keep returning exactly what they did before.
CREATE OR REPLACE FUNCTION public.current_driver_stop_route_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$ SELECT DISTINCT route_id FROM public.route_stops WHERE driver_id = public.current_driver_id() AND route_id IS NOT NULL; $$;

REVOKE EXECUTE ON FUNCTION public.is_ops_staff(), public.current_customer_run_ids(), public.current_driver_route_ids(), public.current_driver_stop_route_ids() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_ops_staff(), public.current_customer_run_ids(), public.current_driver_route_ids(), public.current_driver_stop_route_ids() TO authenticated, service_role;

DROP POLICY "Auth read routes" ON public.routes;
CREATE POLICY routes_read ON public.routes FOR SELECT TO authenticated USING (
  (SELECT is_ops_staff())
  OR driver_id = (SELECT current_driver_id()) OR pickup_driver_id = (SELECT current_driver_id()) OR delivery_driver_id = (SELECT current_driver_id())
  OR ((SELECT current_driver_id()) IS NOT NULL AND id IN (SELECT current_driver_stop_route_ids()))
  OR ((SELECT current_customer_id()) IS NOT NULL AND (run_date >= CURRENT_DATE - 1 OR id IN (SELECT current_customer_run_ids())))
);

DROP POLICY "Auth read route_stops" ON public.route_stops;
CREATE POLICY route_stops_read ON public.route_stops FOR SELECT TO authenticated USING (
  (SELECT is_ops_staff())
  OR ((SELECT current_driver_id()) IS NOT NULL AND (driver_id = (SELECT current_driver_id()) OR route_id IN (SELECT current_driver_route_ids())))
);

DROP POLICY "Auth read drivers" ON public.drivers;
CREATE POLICY drivers_read ON public.drivers FOR SELECT TO authenticated USING ((SELECT is_ops_staff()) OR profile_id = (SELECT auth.uid()));

DROP POLICY authenticated_read_driver_locations ON public.driver_locations;
CREATE POLICY driver_locations_read ON public.driver_locations FOR SELECT TO authenticated USING ((SELECT is_ops_staff()) OR driver_id = (SELECT current_driver_id()));

DROP POLICY authenticated_read_billing_groups ON public.billing_groups;
CREATE POLICY billing_groups_read ON public.billing_groups FOR SELECT TO authenticated USING ((SELECT is_ops_staff()));

DROP POLICY auth_read_route_driver_overrides ON public.route_driver_overrides;
CREATE POLICY route_driver_overrides_read ON public.route_driver_overrides FOR SELECT TO authenticated USING ((SELECT is_ops_staff()) OR (SELECT current_driver_id()) IS NOT NULL);

DROP POLICY lswa_staff_read ON public.loan_settled_write_attempts;
CREATE POLICY lswa_read ON public.loan_settled_write_attempts FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM profiles p WHERE p.id = (SELECT auth.uid()) AND p.role IN ('admin','manager','cpa')));

-- Verified in a rolled-back transaction: admin/manager/laundry_tech/attendant/pos_device see
-- the same rows as before on all 10 tables checked; 7 drivers keep identical addresses /
-- orders / customers and see only their own routes and stops; a customer sees 0 stops,
-- 0 drivers, 0 GPS, and only their own + upcoming route runs.

-- Rollback: recreate each dropped policy as  CREATE POLICY "<name>" ON <table> FOR SELECT TO authenticated USING (true);
-- and drop the new *_read policies above.
