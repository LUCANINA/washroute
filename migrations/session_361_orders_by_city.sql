-- Session 361: Orders by City report (Reports → Customers → Cities).
-- Read-only. SECURITY INVOKER (same as on_time_report / delivery_kpis) — RLS decides
-- what the caller sees; only staff can read all orders. No tables, columns or writes.
--
-- One row per (city, month). The dashboard pivots it into a table: cities down,
-- months across, so the trend is visible at a glance.
--
-- Rules:
--   * Delivery orders only (source <> 'walk_in'); POS counter sales have no city.
--   * cancelled / skipped / pickup_failed and archived orders are excluded — the
--     same exclusions the Daily Revenue report uses for "an order that happened".
--   * Month = the month of the pickup window start (America/Los_Angeles); orders
--     with no window yet fall back to created_at.
--   * City = the pickup address (delivery address if there is none), trimmed and
--     title-cased so "oakland" and "OAKLAND" are one row.
--   * Window = the last p_months calendar months, current month-to-date included;
--     orders already booked for next month are left out (they are not a trend yet).
--
-- Rollback:
--   DROP FUNCTION public.orders_by_city_report(int);

CREATE OR REPLACE FUNCTION public.orders_by_city_report(p_months int DEFAULT 12)
RETURNS TABLE (city text, month text, orders bigint, customers bigint)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
WITH b AS (
  SELECT ((date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles'))
           - make_interval(months => GREATEST(COALESCE(p_months, 12), 1) - 1))::timestamp
          AT TIME ZONE 'America/Los_Angeles') AS a,
         ((date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')) + interval '1 month')::timestamp
          AT TIME ZONE 'America/Los_Angeles') AS z
)
SELECT
  COALESCE(NULLIF(initcap(trim(a.city)), ''), 'No address') AS city,
  to_char(COALESCE(o.pickup_window_start, o.created_at) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM') AS month,
  COUNT(*)::bigint AS orders,
  COUNT(DISTINCT o.customer_id)::bigint AS customers
FROM b, public.orders o
LEFT JOIN public.addresses a ON a.id = COALESCE(o.pickup_address_id, o.delivery_address_id)
WHERE o.source IS DISTINCT FROM 'walk_in'
  AND o.status NOT IN ('cancelled', 'skipped', 'pickup_failed')
  AND o.archived_at IS NULL
  AND COALESCE(o.pickup_window_start, o.created_at) >= b.a
  AND COALESCE(o.pickup_window_start, o.created_at) <  b.z
GROUP BY 1, 2;
$$;

REVOKE ALL ON FUNCTION public.orders_by_city_report(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.orders_by_city_report(int) TO authenticated, service_role;
