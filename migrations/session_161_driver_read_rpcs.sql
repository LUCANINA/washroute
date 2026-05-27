-- Session 161 — Driver route/stop reads via SECURITY DEFINER RPC
-- ============================================================================
-- WHY: The driver app's stop fetches embed orders(*, customers(*), services(*)).
-- route_stops itself has an open SELECT policy (USING true), but `orders`,
-- `customers`, and `addresses` carry COMPLEX driver-specific RLS policies
-- (driver_read_assigned_orders, driver_read_stop_customers,
-- driver_read_stop_addresses) that re-derive the driver through auth.uid() and
-- correlated subqueries. When that policy evaluation transiently races (the same
-- edge case get_driver_stop_addresses was created to dodge — "could not reproduce
-- in the SQL editor"), the embedded `orders`/`customers` come back NULL while the
-- route_stops row returns fine. The driver app then filters out every stop whose
-- `.orders` is null (driver-app/index.html ~line 2109) → the route silently
-- empties with no error and no sign-out. Angel Rodriguez, recurring.
--
-- FIX: return the driver's stops WITH order/customer/service data joined
-- server-side as JSONB (same shape PostgREST embeds produce), authorized once via
-- the simple, robust current_driver_id() (SELECT id FROM drivers WHERE
-- profile_id = auth.uid()). This bypasses the fragile per-table driver policies
-- exactly like get_driver_stop_addresses already does for addresses.
--
-- SECURITY: SECURITY DEFINER, but every row is gated on current_driver_id()
-- ownership, so a driver cannot read another driver's stops even by passing
-- arbitrary route_ids. addresses are still resolved separately via the existing
-- get_driver_stop_addresses RPC — unchanged.
--
-- No schema change. No trigger. No data write. Read-only functions.
-- ============================================================================

-- ── RPC 1: stops on a set of the caller's own routes (main / carry / upcoming) ──
-- Mirrors the client predicate: route_id IN (set) AND (rs.driver_id = me OR NULL),
-- plus a route-ownership gate so passing someone else's route_ids returns nothing.
CREATE OR REPLACE FUNCTION public.get_driver_route_stops(p_route_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH d AS (SELECT current_driver_id() AS driver_id)
  SELECT COALESCE(jsonb_agg(elem ORDER BY sortnum NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT
      rs.stop_number AS sortnum,
      to_jsonb(rs)
      || jsonb_build_object(
           'orders',
           CASE WHEN o.id IS NULL THEN NULL
                ELSE to_jsonb(o)
                     || jsonb_build_object(
                          'customers', CASE WHEN c.id  IS NULL THEN NULL ELSE to_jsonb(c)  END,
                          'services',  CASE WHEN sv.id IS NULL THEN NULL ELSE to_jsonb(sv) END
                        )
           END
         ) AS elem
    FROM route_stops rs
    JOIN routes r       ON r.id  = rs.route_id
    LEFT JOIN orders o    ON o.id  = rs.order_id
    LEFT JOIN customers c ON c.id  = o.customer_id
    LEFT JOIN services sv ON sv.id = o.service_id
    WHERE rs.route_id = ANY(p_route_ids)
      AND ( rs.driver_id = (SELECT driver_id FROM d) OR rs.driver_id IS NULL )
      AND ( r.driver_id          = (SELECT driver_id FROM d)
         OR r.pickup_driver_id   = (SELECT driver_id FROM d)
         OR r.delivery_driver_id = (SELECT driver_id FROM d) )
  ) sub;
$function$;

-- ── RPC 2: override stops — explicitly assigned to me on OTHER drivers' routes ──
-- Mirrors the client predicate: rs.driver_id = me AND routes.run_date = p_run_date
-- AND route_id NOT IN (my route ids). Includes the parent route {id,name,run_date}
-- to match the prior `routes!inner(id, name, run_date)` embed shape.
CREATE OR REPLACE FUNCTION public.get_driver_override_stops(p_run_date date, p_exclude_route_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH d AS (SELECT current_driver_id() AS driver_id)
  SELECT COALESCE(jsonb_agg(elem ORDER BY sortnum NULLS LAST), '[]'::jsonb)
  FROM (
    SELECT
      rs.stop_number AS sortnum,
      to_jsonb(rs)
      || jsonb_build_object(
           'orders',
           CASE WHEN o.id IS NULL THEN NULL
                ELSE to_jsonb(o)
                     || jsonb_build_object(
                          'customers', CASE WHEN c.id  IS NULL THEN NULL ELSE to_jsonb(c)  END,
                          'services',  CASE WHEN sv.id IS NULL THEN NULL ELSE to_jsonb(sv) END
                        )
           END,
           'routes',
           jsonb_build_object('id', r.id, 'name', r.name, 'run_date', r.run_date)
         ) AS elem
    FROM route_stops rs
    JOIN routes r       ON r.id  = rs.route_id
    LEFT JOIN orders o    ON o.id  = rs.order_id
    LEFT JOIN customers c ON c.id  = o.customer_id
    LEFT JOIN services sv ON sv.id = o.service_id
    WHERE rs.driver_id = (SELECT driver_id FROM d)
      AND r.run_date   = p_run_date
      AND NOT (rs.route_id = ANY(p_exclude_route_ids))
  ) sub;
$function$;

-- ── Grants (lesson F: REVOKE PUBLIC *and* anon, then grant the real roles) ──
REVOKE ALL ON FUNCTION public.get_driver_route_stops(uuid[])        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_route_stops(uuid[])        FROM anon;
GRANT EXECUTE ON FUNCTION public.get_driver_route_stops(uuid[])     TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_driver_override_stops(date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_override_stops(date, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_driver_override_stops(date, uuid[]) TO authenticated, service_role;
