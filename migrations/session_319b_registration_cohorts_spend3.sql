-- session_319b_registration_cohorts_spend3
-- Adds spend3 = paid spend in the signup month + next 3 (fixed-age, comparable across months).
-- Reports → Customers → Registrations → Cohort Analysis.
-- One read-only call that returns, per signup month and channel (delivery/retail):
--   regs, first-order conversion within the month / by +1 / by +3 months,
--   ret3 (ordered during calendar month signup+3), lifetime paid spend, spend3,
--   a normalized "how did you find us" breakdown, and distinct ordering
--   customers per calendar month ("active customers").
-- Window starts at the WashRoute go-live month (first order) at the earliest —
-- Starchup order history was never imported, so earlier cohorts read as 0%.
-- SECURITY INVOKER: RLS still applies (staff see all; a customer sees only self).
CREATE OR REPLACE FUNCTION public.registration_cohorts(p_months integer DEFAULT 12)
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
),
f AS (
  SELECT c.*,
         (SELECT min(o.created_at) AT TIME ZONE 'America/Los_Angeles' FROM orders o WHERE o.customer_id = c.id) AS fo,
         (SELECT COALESCE(sum(COALESCE(o.total_amount, 0) + COALESCE(o.tip_amount, 0)), 0)
            FROM orders o WHERE o.customer_id = c.id AND o.billing_status = 'paid') AS spend,
         (SELECT COALESCE(sum(COALESCE(o.total_amount, 0) + COALESCE(o.tip_amount, 0)), 0)
            FROM orders o WHERE o.customer_id = c.id AND o.billing_status = 'paid'
              AND o.created_at < ((c.m + interval '4 months') AT TIME ZONE 'America/Los_Angeles')) AS spend3,
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

REVOKE EXECUTE ON FUNCTION public.registration_cohorts(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.registration_cohorts(integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.registration_cohorts(integer) TO authenticated, service_role;
