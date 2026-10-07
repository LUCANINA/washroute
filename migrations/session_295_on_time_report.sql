-- Session 295: On-Time Rate report (Reports → Operations → On-Time).
-- Read-only. SECURITY INVOKER (same as delivery_kpis) — RLS decides what the caller sees;
-- only staff can read all orders. No tables, columns or writes.
--
-- Rule (David, 2026-09-16):
--   ON TIME  = window_start <= actual time <= window_end + 5 minutes
--   EARLY    = actual time <  window_start          (counts as a miss)
--   LATE     = actual time >  window_end + 5 minutes (a miss)
--   One combined score = on-time stops / all stops (pickups + deliveries).
-- A stop = an order leg with an actual_*_at stamp and a window end.
-- Period bucketing uses the actual stop time (America/Los_Angeles).

-- Mirrors idx_orders_actual_delivery_at (pickup side had no index). orders ~14k rows: brief lock.
CREATE INDEX IF NOT EXISTS idx_orders_actual_pickup_at ON public.orders (actual_pickup_at)
  WHERE actual_pickup_at IS NOT NULL;

-- Rollback:
--   DROP FUNCTION public.on_time_report(date, date);
--   DROP FUNCTION public._otr_summary(timestamptz, timestamptz);
--   DROP FUNCTION public._otr_events(timestamptz, timestamptz);
--   DROP INDEX public.idx_orders_actual_pickup_at;

CREATE OR REPLACE FUNCTION public._otr_events(p_a timestamptz, p_b timestamptz)
RETURNS TABLE (
  order_id uuid, order_number text, customer text, leg text,
  win_start timestamptz, win_end timestamptz, actual_at timestamptz,
  result text, minutes_off numeric, driver text, route text
)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH legs AS (
    SELECT o.id, o.order_number::text AS order_number, o.customer_id,
           'pickup'::text AS leg, o.pickup_window_start AS ws, o.pickup_window_end AS we, o.actual_pickup_at AS at
    FROM orders o
    WHERE o.actual_pickup_at >= p_a AND o.actual_pickup_at < p_b AND o.pickup_window_end IS NOT NULL
    UNION ALL
    SELECT o.id, o.order_number::text, o.customer_id,
           'delivery', o.delivery_window_start, o.delivery_window_end, o.actual_delivery_at
    FROM orders o
    WHERE o.actual_delivery_at >= p_a AND o.actual_delivery_at < p_b AND o.delivery_window_end IS NOT NULL
  )
  SELECT l.id, l.order_number,
         NULLIF(TRIM(COALESCE(c.first_name_cache,'') || ' ' || COALESCE(c.last_name_cache,'')), ''),
         l.leg, l.ws, l.we, l.at,
         CASE WHEN l.ws IS NOT NULL AND l.at < l.ws THEN 'early'
              WHEN l.at > l.we + INTERVAL '5 minutes' THEN 'late'
              ELSE 'on_time' END,
         ROUND(CASE WHEN l.ws IS NOT NULL AND l.at < l.ws THEN EXTRACT(EPOCH FROM (l.ws - l.at)) / 60
                    WHEN l.at > l.we THEN EXTRACT(EPOCH FROM (l.at - l.we)) / 60
                    ELSE 0 END),
         COALESCE(NULLIF(TRIM(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')), ''), 'Unassigned'),
         s.route_name
  FROM legs l
  LEFT JOIN customers c ON c.id = l.customer_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(rs.driver_id,
                    CASE WHEN l.leg = 'pickup' THEN r.pickup_driver_id ELSE r.delivery_driver_id END,
                    r.driver_id) AS driver_id,
           r.name AS route_name
    FROM route_stops rs
    LEFT JOIN routes r ON r.id = rs.route_id
    WHERE rs.order_id = l.id AND rs.stop_type = l.leg
    ORDER BY (rs.status = 'complete') DESC, rs.completed_at DESC NULLS LAST, rs.created_at DESC
    LIMIT 1
  ) s ON TRUE
  LEFT JOIN drivers d ON d.id = s.driver_id
  LEFT JOIN profiles p ON p.id = d.profile_id;
$$;

CREATE OR REPLACE FUNCTION public._otr_summary(p_a timestamptz, p_b timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'stops',            COUNT(*),
    'on_time',          COUNT(*) FILTER (WHERE result = 'on_time'),
    'early',            COUNT(*) FILTER (WHERE result = 'early'),
    'late',             COUNT(*) FILTER (WHERE result = 'late'),
    'late_5_15',        COUNT(*) FILTER (WHERE result = 'late' AND minutes_off <= 15),
    'late_15_60',       COUNT(*) FILTER (WHERE result = 'late' AND minutes_off > 15 AND minutes_off <= 60),
    'late_60_plus',     COUNT(*) FILTER (WHERE result = 'late' AND minutes_off > 60),
    'pickups',          COUNT(*) FILTER (WHERE leg = 'pickup'),
    'pickups_on_time',  COUNT(*) FILTER (WHERE leg = 'pickup' AND result = 'on_time'),
    'deliveries',       COUNT(*) FILTER (WHERE leg = 'delivery'),
    'deliveries_on_time', COUNT(*) FILTER (WHERE leg = 'delivery' AND result = 'on_time')
  )
  FROM _otr_events(p_a, p_b);
$$;

CREATE OR REPLACE FUNCTION public.on_time_report(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
WITH b AS (
  SELECT (p_from::timestamp AT TIME ZONE 'America/Los_Angeles') AS a,
         ((p_to + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS z,
         (((p_from - INTERVAL '1 month')::date)::timestamp AT TIME ZONE 'America/Los_Angeles') AS pa,
         ((((p_to - INTERVAL '1 month')::date) + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS pz,
         ((date_trunc('month', p_to) - INTERVAL '11 months')::timestamp AT TIME ZONE 'America/Los_Angeles') AS ta,
         ((p_to + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS tz
),
ev AS (SELECT e.* FROM b, _otr_events(b.a, b.z) e),
tr AS (SELECT e.* FROM b, _otr_events(b.ta, b.tz) e),
grp AS (
  SELECT 'driver' AS dim, driver AS label, result, leg FROM ev
  UNION ALL SELECT 'route', COALESCE(route, 'No route'), result, leg FROM ev
  UNION ALL SELECT 'window',
         CASE WHEN EXTRACT(HOUR FROM win_end AT TIME ZONE 'America/Los_Angeles') <= 12 THEN 'Morning' ELSE 'Afternoon / evening' END,
         result, leg FROM ev
  UNION ALL SELECT 'weekday', to_char(actual_at AT TIME ZONE 'America/Los_Angeles', 'ID Dy'), result, leg FROM ev
)
SELECT jsonb_build_object(
  'period',   jsonb_build_object('from', p_from, 'to', p_to, 'grace_minutes', 5),
  'current',  (SELECT _otr_summary(a, z) FROM b),
  'previous', (SELECT _otr_summary(pa, pz) FROM b),
  'trend', COALESCE((
     SELECT jsonb_agg(jsonb_build_object('month', m, 'stops', n, 'on_time', ok) ORDER BY m)
     FROM (SELECT to_char(actual_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM') m,
                  COUNT(*) n, COUNT(*) FILTER (WHERE result = 'on_time') ok
           FROM tr GROUP BY 1) t), '[]'::jsonb),
  'breakdowns', COALESCE((
     SELECT jsonb_agg(jsonb_build_object('dim', dim, 'label', label, 'stops', n, 'on_time', ok,
                                         'early', er, 'late', lt) ORDER BY dim, label)
     FROM (SELECT dim, label, COUNT(*) n,
                  COUNT(*) FILTER (WHERE result = 'on_time') ok,
                  COUNT(*) FILTER (WHERE result = 'early') er,
                  COUNT(*) FILTER (WHERE result = 'late') lt
           FROM grp GROUP BY 1, 2) g), '[]'::jsonb),
  'misses', COALESCE((
     SELECT jsonb_agg(to_jsonb(x) ORDER BY x.minutes_off DESC)
     FROM (SELECT order_id, order_number, customer, leg, win_start, win_end, actual_at,
                  result, minutes_off, driver, route
           FROM ev WHERE result <> 'on_time'
           ORDER BY minutes_off DESC LIMIT 300) x), '[]'::jsonb)
);
$$;

REVOKE ALL ON FUNCTION public._otr_events(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public._otr_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.on_time_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._otr_events(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._otr_summary(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.on_time_report(date, date) TO authenticated, service_role;
