-- session_319d_residential_filter
-- "Residential only" switch for Reports → Delivery KPIs and Registrations → Cohort Analysis.
-- One definition of a business customer (on-account billing, commercial/HCEB type, business/commercial
-- account) in _is_business_customer(); every report function takes p_residential DEFAULT false, so
-- existing callers keep their numbers until they opt in. Driver hours / stops stay route-level (not
-- split by customer). Old signatures are dropped (only caller: admin-dashboard, 2-arg / 1-arg calls
-- still resolve through the defaults).

CREATE OR REPLACE FUNCTION public._is_business_customer(p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = p_customer_id
      AND ( COALESCE(c.billing_type, '') = 'on_account'
         OR lower(COALESCE(c.customer_type, '')) IN ('commercial', 'hceb')
         OR COALESCE(c.account_type, '') IN ('business', 'commercial') )
  );
$function$;

DROP FUNCTION IF EXISTS public.delivery_kpis(date, date);
DROP FUNCTION IF EXISTS public._dk_window(timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public._dk_retention(timestamptz, timestamptz, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public.registration_cohorts(integer);

CREATE FUNCTION public._dk_retention(prev_a timestamptz, prev_b timestamptz, cur_a timestamptz, cur_b timestamptz, p_residential boolean DEFAULT false)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH prevc AS (
    SELECT DISTINCT customer_id FROM orders
    WHERE source IS DISTINCT FROM 'walk_in' AND status <> 'cancelled' AND customer_id IS NOT NULL
      AND created_at >= prev_a AND created_at < prev_b
      AND NOT (p_residential AND public._is_business_customer(customer_id))
  ),
  curc AS (
    SELECT DISTINCT customer_id FROM orders
    WHERE source IS DISTINCT FROM 'walk_in' AND status <> 'cancelled' AND customer_id IS NOT NULL
      AND created_at >= cur_a AND created_at < cur_b
  )
  SELECT CASE WHEN (SELECT COUNT(*) FROM prevc) = 0 THEN NULL
    ELSE (SELECT COUNT(*) FROM prevc WHERE customer_id IN (SELECT customer_id FROM curc))::numeric
         / (SELECT COUNT(*) FROM prevc) END;
$function$;

CREATE FUNCTION public._dk_window(a timestamptz, b timestamptz, p_residential boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH
new_cust AS (
  SELECT id, created_at, total_orders FROM customers
  WHERE referral_source IS DISTINCT FROM 'pos_walkin'
    AND created_at >= a AND created_at < b
    AND NOT (p_residential AND public._is_business_customer(id))
),
delivered AS (
  SELECT o.weight_lbs FROM orders o
  WHERE o.source IS DISTINCT FROM 'walk_in' AND o.status='delivered'
    AND o.actual_delivery_at >= a AND o.actual_delivery_at < b
    AND NOT (p_residential AND public._is_business_customer(o.customer_id))
),
billed AS (
  SELECT (COALESCE(o.total_amount,0)+COALESCE(o.tip_amount,0)) AS rev FROM orders o
  WHERE o.source IS DISTINCT FROM 'walk_in' AND o.billing_status='paid'
    AND o.billed_at >= a AND o.billed_at < b
    AND NOT (p_residential AND public._is_business_customer(o.customer_id))
),
sub_rev AS (
  SELECT COALESCE(SUM(amount),0) AS s FROM customer_transactions
  WHERE type='subscription_invoice' AND created_at >= a AND created_at < b
    AND NOT (p_residential AND public._is_business_customer(customer_id))
),
hrs AS (
  SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at-started_at))/3600.0),0) AS h
  FROM routes WHERE started_at IS NOT NULL AND completed_at IS NOT NULL
    AND completed_at > started_at
    AND completed_at >= a AND completed_at < b
),
stops AS (
  SELECT COUNT(*) AS c FROM route_stops
  WHERE status='complete' AND completed_at >= a AND completed_at < b
),
ordering_cust AS (
  SELECT o.customer_id, MAX(CASE WHEN c.total_orders>=2 THEN 1 ELSE 0 END) AS is_repeat
  FROM orders o JOIN customers c ON c.id=o.customer_id
  WHERE o.source IS DISTINCT FROM 'walk_in'
    AND o.created_at >= a AND o.created_at < b AND o.customer_id IS NOT NULL
    AND NOT (p_residential AND public._is_business_customer(o.customer_id))
  GROUP BY o.customer_id
),
agg AS (
  SELECT
    (SELECT COUNT(*) FROM new_cust)                                   AS nc,
    (SELECT COUNT(*) FILTER (WHERE total_orders>0) FROM new_cust)     AS nc_conv,
    -- reorder within 30 days of signup: 2+ non-cancelled delivery orders in first 30d
    (SELECT COUNT(*) FROM new_cust nc2 WHERE (
        SELECT COUNT(*) FROM orders o2
        WHERE o2.customer_id = nc2.id AND o2.source IS DISTINCT FROM 'walk_in'
          AND o2.status <> 'cancelled'
          AND o2.created_at <= nc2.created_at + interval '30 days'
      ) >= 2)                                                          AS nc_reorder,
    (SELECT COUNT(*) FROM delivered)                                  AS dlv,
    (SELECT COALESCE(SUM(weight_lbs),0) FROM delivered)               AS lbs,
    (SELECT COALESCE(SUM(rev),0) FROM billed)                         AS ordrev,
    (SELECT COUNT(*) FROM billed)                                     AS paidn,
    (SELECT s FROM sub_rev)                                           AS subrev,
    (SELECT h FROM hrs)                                               AS dh,
    (SELECT c FROM stops)                                            AS st,
    (SELECT COUNT(*) FROM ordering_cust)                             AS oc,
    (SELECT COALESCE(SUM(is_repeat),0) FROM ordering_cust)           AS oc_rep,
    -- active = distinct delivery customers who ordered in the 30 days ending at b
    (SELECT COUNT(DISTINCT customer_id) FROM orders
       WHERE source IS DISTINCT FROM 'walk_in' AND status <> 'cancelled' AND customer_id IS NOT NULL
         AND created_at >= b - interval '30 days' AND created_at < b
         AND NOT (p_residential AND public._is_business_customer(customer_id)))  AS active30,
    (SELECT COUNT(*) FROM subscriptions WHERE cancelled_at >= a AND cancelled_at < b
         AND NOT (p_residential AND public._is_business_customer(customer_id))) AS cancels,
    (SELECT COUNT(*) FROM subscriptions WHERE created_at < a AND (cancelled_at IS NULL OR cancelled_at >= a)
         AND NOT (p_residential AND public._is_business_customer(customer_id))) AS active_sub_start,
    (SELECT COUNT(*) FROM subscriptions WHERE created_at < b AND (cancelled_at IS NULL OR cancelled_at >= b)
         AND NOT (p_residential AND public._is_business_customer(customer_id))) AS active_sub_end
)
SELECT jsonb_build_object(
  'new_customers', nc,
  'conversion', CASE WHEN nc>0 THEN nc_conv::numeric/nc END,
  'reorder_new', CASE WHEN nc>0 THEN nc_reorder::numeric/nc END,
  'active_30', active30,
  'delivered_orders', dlv,
  'pounds', lbs,
  'avg_order_weight', CASE WHEN dlv>0 THEN lbs/dlv END,
  'order_revenue', ordrev,
  'sub_revenue', subrev,
  'total_revenue', ordrev + subrev,
  'paid_orders', paidn,
  'spend_per_order', CASE WHEN paidn>0 THEN ordrev/paidn END,
  'rev_per_order_incl_sub', CASE WHEN paidn>0 THEN (ordrev+subrev)/paidn END,
  'driver_hours', dh,
  'stops', st,
  'stops_per_hour', CASE WHEN dh>0 THEN st/dh END,
  'pounds_per_hour', CASE WHEN dh>0 THEN lbs/dh END,
  'repeat_rate', CASE WHEN oc>0 THEN oc_rep::numeric/oc END,
  'sub_cancels', cancels,
  'churn', CASE WHEN active_sub_start>0 THEN cancels::numeric/active_sub_start END,
  'active_subs', active_sub_end
) FROM agg;
$function$;

CREATE FUNCTION public.delivery_kpis(p_from date, p_to date, p_residential boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH m AS (
  SELECT n,
    ((p_from - (n||' months')::interval)::date::timestamp AT TIME ZONE 'America/Los_Angeles')        AS a,
    (((p_to - (n||' months')::interval)::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles')     AS b
  FROM generate_series(0,7) n
)
SELECT jsonb_build_object(
  'current',  _dk_window((SELECT a FROM m WHERE n=0),(SELECT b FROM m WHERE n=0), p_residential)
    || jsonb_build_object(
       'retention_1', _dk_retention((SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1),(SELECT a FROM m WHERE n=0),(SELECT b FROM m WHERE n=0), p_residential),
       'retention_2', _dk_retention((SELECT a FROM m WHERE n=2),(SELECT b FROM m WHERE n=2),(SELECT a FROM m WHERE n=0),(SELECT b FROM m WHERE n=0), p_residential),
       'retention_3', _dk_retention((SELECT a FROM m WHERE n=3),(SELECT b FROM m WHERE n=3),(SELECT a FROM m WHERE n=0),(SELECT b FROM m WHERE n=0), p_residential),
       'retention_6', _dk_retention((SELECT a FROM m WHERE n=6),(SELECT b FROM m WHERE n=6),(SELECT a FROM m WHERE n=0),(SELECT b FROM m WHERE n=0), p_residential)
    ),
  'previous', _dk_window((SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1), p_residential)
    || jsonb_build_object(
       'retention_1', _dk_retention((SELECT a FROM m WHERE n=2),(SELECT b FROM m WHERE n=2),(SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1), p_residential),
       'retention_2', _dk_retention((SELECT a FROM m WHERE n=3),(SELECT b FROM m WHERE n=3),(SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1), p_residential),
       'retention_3', _dk_retention((SELECT a FROM m WHERE n=4),(SELECT b FROM m WHERE n=4),(SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1), p_residential),
       'retention_6', _dk_retention((SELECT a FROM m WHERE n=7),(SELECT b FROM m WHERE n=7),(SELECT a FROM m WHERE n=1),(SELECT b FROM m WHERE n=1), p_residential)
    ),
  'avg_ltv_to_date', (SELECT COALESCE(AVG(lifetime_value),0)
                      FROM customers
                      WHERE referral_source IS DISTINCT FROM 'pos_walkin' AND total_orders>0
                        AND NOT (p_residential AND public._is_business_customer(id))),
  'period', jsonb_build_object('from', p_from, 'to', p_to, 'days', (p_to-p_from)+1, 'residential', p_residential)
);
$function$;

CREATE FUNCTION public.registration_cohorts(p_months integer DEFAULT 12, p_residential boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH lim AS (
  SELECT g.golive,
         GREATEST(date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles')
                    - make_interval(months => LEAST(GREATEST(COALESCE(p_months, 12), 1), 60) - 1),
                  g.golive) AS start_m
  FROM (SELECT date_trunc('month', min(created_at) AT TIME ZONE 'America/Los_Angeles') AS golive FROM orders) g
),
c AS (
  SELECT cu.id,
         date_trunc('month', cu.created_at AT TIME ZONE 'America/Los_Angeles') AS m,
         CASE WHEN cu.referral_source = 'pos_walkin' THEN 'retail' ELSE 'delivery' END AS ch,
         CASE
           WHEN COALESCE(btrim(cu.referral_source), '') = '' THEN 'unknown'
           WHEN lower(btrim(cu.referral_source)) IN ('google', 'google search') THEN 'google'
           WHEN regexp_replace(lower(cu.referral_source), '[^a-z]', '', 'g') = 'friendfamily' THEN 'friend_family'
           WHEN regexp_replace(lower(cu.referral_source), '[^a-z]', '', 'g') IN ('sawvan', 'isawyourvan') THEN 'saw_van'
           WHEN lower(cu.referral_source) IN ('starchup_migration', 'import') THEN 'imported'
           ELSE lower(btrim(cu.referral_source))
         END AS src
  FROM customers cu, lim
  WHERE cu.created_at >= (lim.start_m AT TIME ZONE 'America/Los_Angeles')
    AND NOT (p_residential AND public._is_business_customer(cu.id))
),
f AS (
  SELECT c.*,
         (SELECT min(o.created_at) AT TIME ZONE 'America/Los_Angeles' FROM orders o WHERE o.customer_id = c.id) AS fo,
         (SELECT COALESCE(sum(COALESCE(o.total_amount, 0) + COALESCE(o.tip_amount, 0)), 0)
            FROM orders o WHERE o.customer_id = c.id AND o.billing_status = 'paid')
         + (SELECT COALESCE(sum(t.amount), 0) FROM customer_transactions t
             WHERE t.customer_id = c.id AND t.type = 'subscription_invoice') AS spend,
         (SELECT COALESCE(sum(COALESCE(o.total_amount, 0) + COALESCE(o.tip_amount, 0)), 0)
            FROM orders o WHERE o.customer_id = c.id AND o.billing_status = 'paid'
              AND o.created_at < ((c.m + interval '4 months') AT TIME ZONE 'America/Los_Angeles'))
         + (SELECT COALESCE(sum(t.amount), 0) FROM customer_transactions t
             WHERE t.customer_id = c.id AND t.type = 'subscription_invoice'
               AND t.created_at < ((c.m + interval '4 months') AT TIME ZONE 'America/Los_Angeles')) AS spend3,
         EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id
                   AND o.created_at >= ((c.m + interval '3 months') AT TIME ZONE 'America/Los_Angeles')
                   AND o.created_at <  ((c.m + interval '4 months') AT TIME ZONE 'America/Los_Angeles')) AS ret3
  FROM c
),
cohorts AS (
  SELECT to_char(m, 'YYYY-MM') AS month, ch AS channel, count(*) AS regs,
         count(*) FILTER (WHERE fo < m + interval '1 month')  AS m0,
         count(*) FILTER (WHERE fo < m + interval '2 months') AS m1,
         count(*) FILTER (WHERE fo < m + interval '4 months') AS m3,
         count(*) FILTER (WHERE ret3) AS ret3,
         count(fo) AS ever,
         round(sum(spend)::numeric, 2) AS spend,
         round(sum(spend3)::numeric, 2) AS spend3
  FROM f GROUP BY m, ch
),
sources AS (
  SELECT to_char(m, 'YYYY-MM') AS month, ch AS channel, src AS source, count(*) AS regs,
         count(*) FILTER (WHERE fo < m + interval '2 months') AS m1,
         count(fo) AS ever,
         round(sum(spend)::numeric, 2) AS spend
  FROM f GROUP BY m, ch, src
),
active AS (
  SELECT to_char(date_trunc('month', o.created_at AT TIME ZONE 'America/Los_Angeles'), 'YYYY-MM') AS month,
         CASE WHEN cu.referral_source = 'pos_walkin' THEN 'retail' ELSE 'delivery' END AS channel,
         count(DISTINCT o.customer_id) AS customers
  FROM orders o JOIN customers cu ON cu.id = o.customer_id, lim
  WHERE o.created_at >= (lim.start_m AT TIME ZONE 'America/Los_Angeles')
    AND NOT (p_residential AND public._is_business_customer(o.customer_id))
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'go_live', (SELECT to_char(golive, 'YYYY-MM') FROM lim),
  'start',   (SELECT to_char(start_m, 'YYYY-MM') FROM lim),
  'cohorts', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.month, x.channel) FROM cohorts x), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.month, x.channel, x.source) FROM sources x), '[]'::jsonb),
  'active',  COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.month, x.channel) FROM active x), '[]'::jsonb)
)
;
$function$;

DO $g$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._is_business_customer(uuid)',
    'public._dk_retention(timestamptz,timestamptz,timestamptz,timestamptz,boolean)',
    'public._dk_window(timestamptz,timestamptz,boolean)',
    'public.delivery_kpis(date,date,boolean)',
    'public.registration_cohorts(integer,boolean)']
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $g$;
