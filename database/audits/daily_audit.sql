-- WashRoute daily health audit — detection queries
--
-- SINGLE SOURCE OF TRUTH for the audit's SQL. The `washroute-audit` skill used to
-- inline all of these (26,742 chars, ~6,700 tokens read every session just to be
-- retyped into execute_sql). They live here now; the skill runs them and keeps only
-- the judgment prose.
--
-- Each check is delimited by a metadata line:
--   -- @check id=<id> name="<name>" priority=<P0|P1|P2|P3>
--
-- Classification (from the skill, unchanged):
--   0 rows            -> ✅ clear
--   rows + P0         -> 🔴 fix now
--   rows + P1         -> ⚠️  investigate
--   rows + P2/P3      -> 📋 count only
--
-- Check 24 (Critical Driver-App RPC Call Sites) is a filesystem check, not SQL:
--   scripts/audit-rpc-call-sites.sh
--
-- Generated 2026-09-02 by extracting the queries VERBATIM from washroute-audit.
-- Do not hand-edit a query here and in the skill; this file is the only copy.


-- @check id=1 name="Unrouted Orders" priority=P0
SELECT o.id, o.order_number, o.status, o.routing_error,
       c.first_name_cache || ' ' || c.last_name_cache AS customer,
       (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::text AS pickup_pt
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status IN ('scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery')
  AND (o.routing_error IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.stop_type = 'pickup'))
ORDER BY o.pickup_window_start;


-- @check id=2 name="Wrong-Date Stops" priority=P0
SELECT rs.id AS stop_id, o.order_number, rs.stop_type, rs.status AS stop_status,
       r.run_date AS route_date,
       (CASE WHEN rs.stop_type = 'pickup'
             THEN o.pickup_window_start
             ELSE o.delivery_window_start
        END AT TIME ZONE 'America/Los_Angeles')::date AS correct_date,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
JOIN routes r ON rs.route_id = r.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE rs.status IN ('pending', 'en_route')
  AND r.run_date != (CASE WHEN rs.stop_type = 'pickup'
                          THEN o.pickup_window_start
                          ELSE o.delivery_window_start
                     END AT TIME ZONE 'America/Los_Angeles')::date;


-- @check id=3 name="Outstanding Orders" priority=P0
-- 3a. Chaseable debt: card customers. Expect 0 rows; investigate anything here.
SELECT order_number, status, bucket, '$' || amount_due AS amount, age_days,
       first_name_cache || ' ' || last_name_cache AS customer
FROM v_outstanding_orders
WHERE counts_as_due
  AND bucket IN ('card_declined', 'awaiting_payment')
ORDER BY amount_due DESC;


-- @check id=3b name="Charged But billing_status Missing" priority=P1
SELECT o.order_number, o.status, '$' || o.total_amount AS amount,
       o.billing_status, o.billed_at AT TIME ZONE 'America/Los_Angeles' AS billed_pt,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.stripe_payment_intent_id IS NOT NULL
  AND o.billed_at IS NOT NULL
  AND o.charge_failed_at IS NULL
  AND (o.billing_status IS NULL OR o.billing_status NOT IN ('paid', 'refunded', 'written_off'))
  AND o.archived_at IS NULL
ORDER BY o.billed_at DESC;


-- @check id=4 name="Stop / Order Status Desync" priority=P1
SELECT rs.id AS stop_id, o.order_number,
       o.status AS order_status, rs.status AS stop_status, rs.stop_type,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE
  (o.status IN ('delivered','cancelled','skipped','pickup_failed','delivery_failed')
   AND rs.status IN ('pending','en_route'))
  OR (o.status IN ('picked_up','processing','folding','ready_for_delivery','out_for_delivery','delivered')
      AND rs.stop_type = 'pickup' AND rs.status NOT IN ('complete','skipped','failed'))
ORDER BY o.order_number;


-- @check id=5 name="Duplicate Customers" priority=P1
WITH phone_dups AS (
  SELECT RIGHT(REGEXP_REPLACE(phone_cache,'[^0-9]','','g'),10) AS match_key,
         'phone' AS match_type, COUNT(*) AS cnt,
         ARRAY_AGG(first_name_cache||' '||last_name_cache ORDER BY created_at) AS names,
         ARRAY_AGG(id ORDER BY created_at) AS ids
  FROM customers
  WHERE phone_cache IS NOT NULL
    AND LENGTH(REGEXP_REPLACE(phone_cache,'[^0-9]','','g')) >= 10
  GROUP BY match_key HAVING COUNT(*) > 1
),
email_dups AS (
  SELECT email_cache AS match_key, 'email' AS match_type, COUNT(*) AS cnt,
         ARRAY_AGG(first_name_cache||' '||last_name_cache ORDER BY created_at) AS names,
         ARRAY_AGG(id ORDER BY created_at) AS ids
  FROM customers
  WHERE email_cache IS NOT NULL AND email_cache != ''
  GROUP BY email_cache HAVING COUNT(*) > 1
)
SELECT * FROM phone_dups
UNION ALL
SELECT * FROM email_dups
ORDER BY cnt DESC;


-- @check id=6 name="Duplicate Orders" priority=P1
SELECT o.customer_id,
       c.first_name_cache || ' ' || c.last_name_cache AS customer,
       (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date AS pickup_date,
       COUNT(*) AS order_count,
       ARRAY_AGG(o.order_number ORDER BY o.created_at) AS order_numbers,
       ARRAY_AGG(o.status ORDER BY o.created_at) AS statuses
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status IN ('scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery')
  AND o.pickup_window_start IS NOT NULL
GROUP BY o.customer_id, c.first_name_cache, c.last_name_cache,
         (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date
HAVING COUNT(*) > 1
ORDER BY pickup_date;


-- @check id=7 name="Over-Capacity Routes" priority=P1
SELECT r.id, rt.name, r.run_date, rt.stop_limit,
       COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) AS active_stops,
       COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) - rt.stop_limit
         AS over_by,
       GREATEST(rt.stop_limit + 1, FLOOR(rt.stop_limit * 1.25)::INT) AS ceiling,
       CASE
         WHEN r.run_date = (NOW() AT TIME ZONE 'America/Los_Angeles')::date THEN 'today_busy'
         WHEN COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route'))
              > GREATEST(rt.stop_limit + 1, FLOOR(rt.stop_limit * 1.25)::INT)
           THEN 'future_hard_block'
         ELSE 'future_soft_override'
       END AS state
FROM routes r
JOIN route_templates rt ON r.template_id = rt.id
LEFT JOIN route_stops rs ON r.id = rs.route_id
WHERE r.run_date >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date
  AND rt.stop_limit IS NOT NULL
  AND rt.stop_limit > 0      -- excludes dedicated commercial routes (Kidango, etc.)
GROUP BY r.id, rt.name, r.run_date, rt.stop_limit
HAVING COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) > rt.stop_limit
ORDER BY r.run_date, rt.name;


-- @check id=8 name="Driverless Routes" priority=P2
SELECT r.id, rt.name, r.run_date
FROM routes r
JOIN route_templates rt ON r.template_id = rt.id
WHERE r.run_date >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date
  AND r.run_date <= (NOW() AT TIME ZONE 'America/Los_Angeles')::date + INTERVAL '7 days'
  AND r.driver_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM route_driver_schedule rds
    WHERE rds.template_id = r.template_id
      AND rds.day_of_week = (EXTRACT(ISODOW FROM r.run_date)::int - 1)
      AND rds.driver_id IS NOT NULL
  )
ORDER BY r.run_date, rt.name;


-- @check id=9 name="SMS Opt-Out Sync" priority=P2
SELECT COUNT(*) AS out_of_sync_count
FROM customers
WHERE phone_cache IS NOT NULL
  AND sms_consent_at IS NULL
  AND sms_marketing_opt_out_at IS NULL;


-- @check id=10 name="Orphaned Records" priority=P3
-- Duplicate addresses
SELECT COUNT(*) AS duplicate_address_count FROM (
  SELECT customer_id, line1, city
  FROM addresses WHERE customer_id IS NOT NULL
  GROUP BY customer_id, line1, city HAVING COUNT(*) > 1
) t;


-- @check id=11 name="Ghost Delivery Stops" priority=P1
-- NOTE: restricted to PAST run_dates (strictly before today). Same-day
-- delivery stops whose parent order is still processing are legitimately
-- in-flight and should NOT be flagged here — the driver-app/admin RCC
-- filters hide them at the UI layer so no one acts on them prematurely.
SELECT rs.id AS stop_id, o.order_number, o.status AS order_status,
       rt.name AS route_name, r.run_date,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
JOIN routes r ON rs.route_id = r.id
JOIN route_templates rt ON r.template_id = rt.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE rs.stop_type = 'delivery'
  AND rs.status IN ('pending', 'en_route')
  AND r.run_date < (NOW() AT TIME ZONE 'America/Los_Angeles')::date
  AND o.status IN ('picked_up', 'processing', 'folding')
ORDER BY r.run_date, rt.name;


-- @check id=12 name="Orphan Auth Users" priority=P1
-- Orphan = auth.users with an email but no customer in profiles.id linkage,
-- restricted to profile.role='customer'. Drivers, admins, and pos_device
-- accounts legitimately have no customer row and would otherwise be flagged
-- as orphans every morning. The role filter (added session 144) does most
-- of the heavy lifting. The UUID exclusion list below (session 148 — was
-- previously email-based) is the belt-and-suspenders guard for any future
-- staff onboarded with role NULL or role='customer' by mistake. UUIDs are
-- rename-proof — when the Foothill device email was renamed in session 139,
-- the old email-based list would have leaked the rename through.
SELECT au.id AS orphan_auth_id,
       au.email,
       au.created_at,
       au.last_sign_in_at,
       -- Is there a customer with this email_cache linked to a different
       -- (phone-only) auth user? That customer is currently STUCK.
       (SELECT c.id FROM customers c
          WHERE c.email_cache = au.email
            AND c.profile_id IS NOT NULL
            AND c.profile_id != au.id
          LIMIT 1) AS shadowed_customer_id,
       (SELECT c.first_name_cache || ' ' || c.last_name_cache FROM customers c
          WHERE c.email_cache = au.email
            AND c.profile_id IS NOT NULL
            AND c.profile_id != au.id
          LIMIT 1) AS shadowed_name
FROM auth.users au
JOIN profiles p ON p.id = au.id AND p.role = 'customer'
LEFT JOIN customers c ON c.profile_id = au.id
WHERE au.email IS NOT NULL
  AND au.email != ''
  AND c.id IS NULL
  -- Skip known staff / internal accounts by UUID (rename-proof). When a new
  -- staff member is onboarded, fetch their auth.users.id and add it here.
  AND au.id NOT IN (
    '1671939b-3100-426a-a741-0ef8792591a3'::uuid,  -- lili@familylaundry.com (manager)
    '7586a51e-2200-485a-944b-2ec2479f9115'::uuid,  -- info@familylaundry.com (laundry_tech)
    'd0bc0bf0-f887-4679-aa8a-cb2c9522b024'::uuid,  -- john@familylaundry.com (manager)
    '9372180b-047e-426b-ad38-a45813192918'::uuid,  -- blanca@familylaundry.com (manager)
    '9dda1a43-063e-4d6f-96af-56652d24c7e3'::uuid,  -- foothill@familylaundry.com (pos_device)
    'ef27235a-40e7-4a2a-b9aa-fe1f043af69e'::uuid   -- preeandrew@gmail.com (driver)
  )
  AND au.email NOT LIKE '%@washroute.test'
  AND au.email NOT LIKE 'attendant-%@familylaundry.local'  -- POS attendant accounts (session 132)
ORDER BY au.created_at DESC;


-- @check id=13 name="Stuck Phone-OTP Attempts" priority=P1
WITH stuck AS (
  SELECT u.id AS attempted_auth_id, u.phone, t.created_at AS token_at,
         u.last_sign_in_at
  FROM auth.one_time_tokens t
  JOIN auth.users u ON u.id = t.user_id
  WHERE t.token_type = 'confirmation_token'
    AND u.email IS NULL
    AND u.phone IS NOT NULL
)
SELECT s.attempted_auth_id, s.token_at, s.last_sign_in_at,
       c.id AS real_customer_id,
       c.first_name_cache || ' ' || c.last_name_cache AS customer_name,
       c.total_orders
FROM stuck s
JOIN customers c
  ON RIGHT(REGEXP_REPLACE(c.phone_cache,'[^0-9]','','g'),10) = RIGHT(s.phone,10)
WHERE c.profile_id IS NOT NULL
  AND c.profile_id != s.attempted_auth_id
ORDER BY c.total_orders DESC NULLS LAST, s.token_at DESC;


-- @check id=14 name="Window / Sub-Window Alignment" priority=P1
SELECT
  CASE WHEN rs.stop_type = 'pickup' THEN 'pickup' ELSE 'delivery' END AS side,
  o.order_number, o.status, o.source, o.recurring_interval,
  (CASE WHEN rs.stop_type = 'pickup'
        THEN o.pickup_window_start ELSE o.delivery_window_start END
    AT TIME ZONE 'America/Los_Angeles')::text AS stored_window_pt,
  rt.name AS assigned_route, r.run_date,
  rt.window_start || '–' || rt.window_end AS template_window,
  rt.arrival_window_hours || 'h' AS sub_window_size
FROM orders o
JOIN route_stops rs ON rs.order_id = o.id AND rs.status IN ('pending','en_route')
JOIN routes r ON r.id = rs.route_id
JOIN route_templates rt ON rt.id = r.template_id
WHERE o.status IN ('scheduled','picked_up','processing','folding',
                   'ready_for_delivery','out_for_delivery')
  AND rt.arrival_window_hours > 0
  AND (
    (rs.stop_type = 'pickup' AND (
      (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time <  rt.window_start
      OR (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time >= rt.window_end
      OR (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date <> r.run_date
      OR MOD(
           EXTRACT(EPOCH FROM ((o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))::int / 60,
           rt.arrival_window_hours * 60
         ) <> 0
    ))
    OR
    (rs.stop_type = 'delivery' AND (
      (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time <  rt.window_start
      OR (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time >= rt.window_end
      OR (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::date <> r.run_date
      OR MOD(
           EXTRACT(EPOCH FROM ((o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))::int / 60,
           rt.arrival_window_hours * 60
         ) <> 0
    ))
  )
ORDER BY r.run_date, rt.name;


-- @check id=15 name="Stale Subscription Overage" priority=P1
SELECT s.id AS subscription_id,
       c.first_name_cache || ' ' || c.last_name_cache AS customer,
       s.status,
       s.overage_amount_due,
       s.current_period_start,
       s.current_period_end,
       (NOW() - s.current_period_end) AS overdue_by,
       s.stripe_subscription_id
FROM subscriptions s
LEFT JOIN customers c ON c.id = s.customer_id
WHERE s.overage_amount_due > 0
  AND s.current_period_end < NOW() - INTERVAL '3 days'
ORDER BY s.current_period_end;


-- @check id=16 name="Service-Zone Polygon Integrity" priority=P1
-- (a) invalid polygons
SELECT id, name, ST_IsValidReason(polygon) AS reason
FROM service_zones
WHERE polygon IS NOT NULL AND NOT ST_IsValid(polygon);

-- (b) overlapping zones (any pair with intersection area > 0.01 sq km)
SELECT a.name AS zone_a, b.name AS zone_b,
       ROUND((ST_Area(ST_Intersection(a.polygon, b.polygon)::geography) / 1000000.0)::numeric, 4) AS overlap_sq_km
FROM service_zones a JOIN service_zones b ON a.id < b.id
 AND a.polygon IS NOT NULL AND b.polygon IS NOT NULL
 AND ST_IsValid(a.polygon) AND ST_IsValid(b.polygon)
 AND ST_Intersects(a.polygon, b.polygon)
WHERE ST_Area(ST_Intersection(a.polygon, b.polygon)::geography) > 10000
ORDER BY overlap_sq_km DESC;


-- @check id=17 name="Cron Job Failures (Last 24h)" priority=P1
SELECT j.jobname,
       COUNT(*)             AS failures_24h,
       MAX(d.start_time AT TIME ZONE 'America/Los_Angeles') AS last_failure_pt,
       (ARRAY_AGG(d.return_message ORDER BY d.start_time DESC))[1] AS latest_error
FROM cron.job_run_details d
JOIN cron.job j ON j.jobid = d.jobid
WHERE d.status = 'failed'
  AND d.start_time > now() - interval '24 hours'
GROUP BY j.jobname
ORDER BY failures_24h DESC;


-- @check id=18 name="Silent Customer-Facing Reschedules" priority=P1
WITH first_event AS (
  -- Per order: the earliest 'rescheduled' event with a delivery old_value.
  SELECT DISTINCT ON (oe.order_id)
    oe.order_id,
    oe.created_at,
    (oe.old_value::timestamptz) AS original_window
  FROM order_events oe
  WHERE oe.event_type = 'rescheduled'
    AND oe.description ILIKE '%delivery%'
    AND oe.old_value ~ '^[0-9]{4}-'
    AND oe.old_value <> ''
  ORDER BY oe.order_id, oe.created_at ASC
),
bulk_sweep_timestamps AS (
  -- Any created_at value shared by 3+ orders' first rescheduled event is a
  -- bulk corrective sweep, not a customer-facing change. Threshold of 3 is
  -- well above coincidence — real human/customer moves never share exact
  -- microsecond timestamps; only batch UPDATEs do.
  SELECT created_at
  FROM first_event
  GROUP BY created_at
  HAVING COUNT(*) >= 3
),
first_known AS (
  -- Excludes any order whose first-known state was set by a bulk sweep.
  -- We deliberately drop these rather than fall back to a later event,
  -- because once a sweep has rewritten the stored value, we no longer
  -- know what the customer was originally told.
  SELECT fe.order_id, fe.original_window
  FROM first_event fe
  WHERE fe.created_at NOT IN (SELECT created_at FROM bulk_sweep_timestamps)
),
last_reschedule AS (
  -- The most recent delivery reschedule event per order — defines the cutoff
  -- for "did the customer get an SMS confirming the new time?"
  SELECT order_id, MAX(created_at) AS last_reschedule_at
  FROM order_events
  WHERE event_type = 'rescheduled' AND description ILIKE '%delivery%'
  GROUP BY order_id
),
last_delivery_sms AS (
  -- Most recent outbound SMS per customer that uses the delivery_rescheduled
  -- template wording. Per-customer rather than per-order is fine here because
  -- the template names the date so multiple orders won't collide visually.
  SELECT customer_id, MAX(created_at) AS last_sms_at
  FROM sms_messages
  WHERE direction = 'outbound'
    AND body ILIKE '%delivery has been updated%'
  GROUP BY customer_id
)
SELECT
  o.order_number,
  c.first_name_cache || ' ' || c.last_name_cache AS customer,
  c.phone_cache,
  (fk.original_window AT TIME ZONE 'America/Los_Angeles')::text AS original_pt,
  (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::text AS current_pt,
  ROUND((EXTRACT(EPOCH FROM (o.delivery_window_start - fk.original_window))/3600)::numeric, 1) AS net_hours_shifted
FROM orders o
JOIN first_known fk ON fk.order_id = o.id
JOIN last_reschedule lr ON lr.order_id = o.id
LEFT JOIN customers c ON c.id = o.customer_id
LEFT JOIN last_delivery_sms ls ON ls.customer_id = o.customer_id
WHERE o.status IN ('scheduled','picked_up','processing','folding',
                   'ready_for_delivery','out_for_delivery')
  -- Net change of at least 4 hours — small reshuffles aren't customer-facing
  AND ABS(EXTRACT(EPOCH FROM (o.delivery_window_start - fk.original_window))/3600) >= 4
  -- Customer hasn't gotten a delivery_rescheduled SMS since the last reschedule
  AND (ls.last_sms_at IS NULL OR ls.last_sms_at < lr.last_reschedule_at)
  -- Don't flag deliveries already in the past — customer either got it or didn't,
  -- and an SMS now would be confusing
  AND o.delivery_window_start > NOW() - INTERVAL '2 hours'
ORDER BY o.delivery_window_start;


-- @check id=19 name="Photo Capture Rate Anomaly" priority=P0
WITH windows AS (
  SELECT
    rs.id,
    rs.proof_photo_url,
    rs.photo_skipped_at,
    rs.completed_at,
    CASE
      WHEN rs.completed_at >= NOW() - INTERVAL '24 hours' THEN 'last_24h'
      WHEN rs.completed_at >= NOW() - INTERVAL '8 days'
       AND rs.completed_at <  NOW() - INTERVAL '24 hours' THEN 'prior_7d'
      ELSE NULL
    END AS bucket
  FROM route_stops rs
  WHERE rs.status = 'complete'
    AND rs.completed_at >= NOW() - INTERVAL '8 days'
),
stats AS (
  SELECT
    bucket,
    COUNT(*) AS total,
    COUNT(*) FILTER (
      WHERE proof_photo_url IS NOT NULL AND proof_photo_url <> ''
    ) AS with_photo,
    COUNT(*) FILTER (WHERE photo_skipped_at IS NOT NULL) AS skipped,
    ROUND(100.0 * COUNT(*) FILTER (
      WHERE proof_photo_url IS NOT NULL AND proof_photo_url <> ''
    ) / NULLIF(COUNT(*), 0), 1) AS pct_with_photo
  FROM windows
  WHERE bucket IS NOT NULL
  GROUP BY bucket
)
SELECT
  (SELECT pct_with_photo FROM stats WHERE bucket = 'last_24h') AS last_24h_pct,
  (SELECT pct_with_photo FROM stats WHERE bucket = 'prior_7d') AS baseline_pct,
  (SELECT total          FROM stats WHERE bucket = 'last_24h') AS last_24h_stops,
  (SELECT skipped        FROM stats WHERE bucket = 'last_24h') AS last_24h_explicit_skips,
  (SELECT pct_with_photo FROM stats WHERE bucket = 'prior_7d')
    - (SELECT pct_with_photo FROM stats WHERE bucket = 'last_24h') AS drop_pp;


-- @check id=20 name="POS Walk-In Without Launderer Assignment" priority=P1
SELECT
  o.order_number,
  o.status,
  (o.created_at AT TIME ZONE 'America/Los_Angeles')::date AS created_pt,
  o.weight_lbs,
  o.total_bags
FROM orders o
WHERE o.source = 'walk_in'
  AND o.status IN ('ready_for_delivery', 'delivered')
  AND o.folded_by_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM order_folding_assignments ofa
    WHERE ofa.order_id = o.id
  )
  -- session 169: only flag orders that ACTUALLY involved laundering.
  -- Merchandise-only sales (no weight, no service line) are legitimately
  -- created as 'delivered' with no launderer. total_bags is NOT a valid
  -- signal here (it's always >= 1 due to `.length || 1` in createPosOrder).
  AND (
    COALESCE(o.weight_lbs, 0) > 0
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(o.line_items) li
      WHERE li->>'kind' IN ('service','addon') OR li->>'type' = 'service'
    )
  )
ORDER BY o.created_at DESC;


-- @check id=21 name="Active Order with Skipped/Failed Route Stop" priority=P1
SELECT
  o.order_number,
  o.status                                          AS order_status,
  rs.stop_type,
  rs.status                                         AS stop_status,
  c.first_name_cache || ' ' || c.last_name_cache    AS customer,
  (rs.created_at AT TIME ZONE 'America/Los_Angeles')::date AS stop_created_pt
FROM route_stops rs
JOIN orders    o ON o.id = rs.order_id
JOIN customers c ON c.id = o.customer_id
WHERE rs.status IN ('skipped','failed')
  AND o.status IN ('picked_up','processing','folding','ready_for_delivery')
ORDER BY o.created_at DESC;


-- @check id=22 name="Cron Jobs With Inline Critical-Table Writes" priority=P1
SELECT j.jobname,
       j.schedule,
       j.active,
       j.command,
       CASE
         WHEN j.command ~* '\m(UPDATE|DELETE FROM|INSERT INTO)\M.{0,80}\m(orders|customers|route_stops|addresses|routes)\M'
           THEN '🚨 inline write on critical table'
         WHEN j.command ~* '\m(UPDATE|DELETE FROM|INSERT INTO)\M'
           THEN '⚠️ inline write on non-critical table'
         WHEN j.command ~* 'http_post|http_get'
           THEN '✓ edge-function call (safe)'
         WHEN j.command ~* '^\s*SELECT\s+(public\.)?\w+\s*\('
           THEN '✓ single RPC call'
         ELSE '? unclassified — inspect manually'
       END AS classification
FROM cron.job j
ORDER BY classification, j.jobname;


-- @check id=23 name="Chargeable Subscription Plan While Subscriptions Pre-Launch" priority=P0
SELECT id, name, price_monthly, is_active, stripe_price_id
FROM subscription_plans
WHERE is_active = true AND stripe_price_id IS NOT NULL;


-- @check id=24b name="Account-Credit Over-Application / Double Charge" priority=P1
WITH o2 AS (
  SELECT o.id, o.order_number, o.customer_id,
         o.total_amount
         + ABS(COALESCE((SELECT SUM((li->>'amount')::numeric)
             FROM jsonb_array_elements(o.line_items) li WHERE li->>'type'='credit'),0))
         + CASE WHEN o.tip_type='pct' THEN ROUND(o.total_amount*COALESCE(o.tip_amount,0)/100,2)
                ELSE COALESCE(o.tip_amount,0) END AS gross_owed
  FROM orders o
  WHERE jsonb_typeof(o.line_items)='array' AND jsonb_array_length(o.line_items) > 0  -- skip un-itemized commercial charges
    AND o.created_at > now() - interval '45 days'
),
tx AS (
  SELECT order_id,
    COALESCE(SUM(amount) FILTER (WHERE type='charge'),0)
      - COALESCE(SUM(amount) FILTER (WHERE type='refund'),0)
      + COALESCE(SUM(amount) FILTER (WHERE type='subscription_invoice'),0) AS card_net,
    -- EXCLUDE '(backfill)' credit_use rows — phantom session-128 reconstructions
    COALESCE(SUM(amount) FILTER (WHERE type='credit_use' AND description NOT ILIKE '%backfill%'),0)
      - COALESCE(SUM(amount) FILTER (WHERE type='credit_refund'),0) AS credit_net,
    COUNT(DISTINCT stripe_payment_intent_id) FILTER (WHERE type='charge') AS charge_pis
  FROM customer_transactions GROUP BY order_id
)
SELECT c.first_name_cache||' '||c.last_name_cache AS name, o2.order_number,
       o2.gross_owed, tx.card_net, tx.credit_net,
       ROUND((tx.card_net+tx.credit_net)-o2.gross_owed,2) AS overpaid,
       tx.charge_pis,
       CASE WHEN tx.charge_pis>1 THEN 'Double card charge' ELSE 'Credit deducted, not applied' END AS likely_cause
FROM o2 JOIN tx ON tx.order_id=o2.id JOIN customers c ON c.id=o2.customer_id
WHERE (tx.card_net+tx.credit_net)-o2.gross_owed > 0.01
ORDER BY overpaid DESC;


-- @check id=25 name="Receipt Total Drift: line items that don't sum to the charge" priority=P0
WITH agg AS (
  SELECT o.id, o.order_number, o.source, o.status, o.created_at,
         ROUND(o.total_amount - COALESCE(o.tax_amount,0), 2) AS auth_pretax,
         ROUND(COALESCE(SUM(CASE WHEN (x->>'type') NOT IN ('credit','tax')
                                 THEN (x->>'amount')::numeric END),0),2) AS li_sum
  FROM orders o, LATERAL jsonb_array_elements(COALESCE(o.line_items,'[]'::jsonb)) x
  WHERE o.line_items IS NOT NULL
    AND jsonb_array_length(o.line_items) > 0
    AND o.billing_status = 'paid'
    AND o.created_at > now() - interval '90 days'
  GROUP BY 1,2,3,4,5
)
SELECT order_number, source, status, created_at::date,
       auth_pretax, li_sum, ROUND(auth_pretax - li_sum, 2) AS unexplained
FROM agg
WHERE auth_pretax - li_sum > 0.01
ORDER BY (auth_pretax - li_sum) DESC;


-- ===========================================================================
-- LEGACY CHECKS (from the pre-2026-09-02 daily_audit.sql)
--
-- These 10 were in this file but NOT in the washroute-audit skill — the two
-- artifacts had diverged, with only ~2 checks overlapping. Preserved verbatim
-- so nothing is lost. Some are also run by the nightly smoke test.
--
-- Prefixed L to keep them distinct from the skill's numbered checks. Several
-- may duplicate a skill check under a different name; reconcile deliberately,
-- do not delete on sight.
-- ===========================================================================

-- @check id=L1 name="Duplicate services that could poison client-side .find() — HOTFIX class (session 167)" priority=P2
-- 1. Duplicate services that could poison client-side .find() — HOTFIX class (session 167)
-- Expected: 0 rows. Any output = at least one client-side .find() will pick the wrong row.
SELECT 'CHECK 1 — duplicate services' AS check_name;
SELECT * FROM audit_duplicate_services();

-- @check id=L2 name="Orphan route_stops (route_id no longer exists)" priority=P2
-- 2. Orphan route_stops (route_id no longer exists)
-- Expected: 0 rows.
SELECT 'CHECK 2 — orphan route_stops' AS check_name;
SELECT rs.id, rs.order_id, rs.route_id, rs.stop_type, rs.status
FROM route_stops rs
LEFT JOIN routes r ON r.id = rs.route_id
WHERE rs.route_id IS NOT NULL AND r.id IS NULL;

-- @check id=L3 name="Unpaid delivered orders (billing_status not 'paid' but order status is delivered)" priority=P2
-- 3. Unpaid delivered orders (billing_status not 'paid' but order status is delivered)
-- Expected: 0 rows. Any output = customer received service without payment recorded.
SELECT 'CHECK 3 — unpaid delivered orders' AS check_name;
SELECT id, order_number, customer_id, billing_status, total_amount, actual_delivery_at
FROM orders
WHERE status = 'delivered'
  AND billing_status IS DISTINCT FROM 'paid'
  AND billing_status IS DISTINCT FROM 'refunded'
  AND actual_delivery_at > NOW() - INTERVAL '14 days'
ORDER BY actual_delivery_at DESC;

-- @check id=L4 name="Health alerts in the last 24 hours" priority=P2
-- 4. Health alerts in the last 24 hours
-- Expected: heartbeat rows only. Any 'critical' severity = needs investigation.
SELECT 'CHECK 4 — recent health alerts' AS check_name;
SELECT created_at, alert_type, severity, message, sent_sms
FROM _health_alerts
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND alert_type != 'heartbeat'
ORDER BY created_at DESC;

-- @check id=L5 name="Subscriptions where DB usage > 0 lbs but no completed orders this cycle" priority=P2
-- 5. Subscriptions where DB usage > 0 lbs but no completed orders this cycle
-- Expected: 0 rows. Indicates trigger may have fired but order was cancelled.
SELECT 'CHECK 5 — subscription usage without orders' AS check_name;
SELECT
  s.id, s.customer_id, s.usage_lbs_this_period, s.pickups_this_period,
  s.current_period_start, s.current_period_end
FROM subscriptions s
WHERE s.status = 'active'
  AND s.usage_lbs_this_period > 0
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.subscription_id = s.id
      AND o.status IN ('ready_for_delivery', 'out_for_delivery', 'delivered')
      AND o.created_at >= s.current_period_start
  );

-- @check id=L6 name="customer_transactions ledger balance check — net = 0 per customer for refunds" priority=P2
-- 6. customer_transactions ledger balance check — net = 0 per customer for refunds
-- Expected: 0 rows where credit_use sum > credit_refund sum + credit balance
-- (Catches orphaned credit applications.)
SELECT 'CHECK 6 — credit ledger imbalance' AS check_name;
SELECT
  customer_id,
  SUM(CASE WHEN type = 'credit_use'    THEN amount ELSE 0 END) AS used,
  SUM(CASE WHEN type = 'credit_refund' THEN amount ELSE 0 END) AS refunded,
  SUM(CASE WHEN type = 'credit_add'    THEN amount ELSE 0 END) AS added
FROM customer_transactions
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY customer_id
HAVING SUM(CASE WHEN type = 'credit_use' THEN amount ELSE 0 END)
     - SUM(CASE WHEN type = 'credit_refund' THEN amount ELSE 0 END)
     > (SELECT COALESCE(MAX(credits), 0) FROM customers c WHERE c.id = customer_transactions.customer_id) + 0.01;

-- @check id=L7 name="RPC warnings in the last 24h (silent failures we want to surface)" priority=P2
-- 7. RPC warnings in the last 24h (silent failures we want to surface)
-- Expected: light. Spikes indicate something is silently wrong.
SELECT 'CHECK 7 — recent RPC warnings' AS check_name;
SELECT rpc_name, warning_code, COUNT(*) AS occurrences, MAX(created_at) AS most_recent
FROM _rpc_warnings
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY rpc_name, warning_code
ORDER BY occurrences DESC;

-- @check id=L8 name="Customers with stripe_customer_id but no saved card (and no recent activity)" priority=P2
-- 8. Customers with stripe_customer_id but no saved card (and no recent activity)
-- Cleanup candidate. Not necessarily a bug.
SELECT 'CHECK 8 — Stripe customers without cards (informational)' AS check_name;
SELECT id, first_name_cache, email_cache, stripe_customer_id, created_at
FROM customers
WHERE stripe_customer_id IS NOT NULL
  AND stripe_default_payment_method_id IS NULL
  AND last_order_at < NOW() - INTERVAL '60 days'
LIMIT 20;

-- @check id=L9 name="Stripe→DB seam health (session 168, A5)" priority=P2
-- 9. Stripe→DB seam health (session 168, A5)
-- Expected: 0 rows. Any output = an active subscription has NO invoice recorded
-- for its current period — the signature of stripe-webhook signing-secret drift
-- (the class that forced the June 2 backfill). The nightly-smoke-test runs this
-- same check and SMS-alerts on any rows.
SELECT 'CHECK 9 — active subscription missing invoice (Stripe seam)' AS check_name;
SELECT * FROM audit_subscriptions_missing_invoice();

-- @check id=L10 name="Subscription-pricelist orphans — cancel→revert health (session 168)" priority=P2
-- 10. Subscription-pricelist orphans — cancel→revert health (session 168)
-- Expected: 0 rows. Any output = a customer is on the $0 'Subscription' pricelist
-- with NO active/past_due/paused subscription paying for it. Signature of a
-- cancel→revert failure: either the customer.subscription.deleted webhook was
-- missed at period end, or previous_pricelist was wrongly snapshotted as
-- 'Subscription' (self-referential restore → no-op → stuck on free service).
-- The nightly-smoke-test runs this same check and SMS-alerts on any rows.
SELECT 'CHECK 10 — subscription-pricelist orphans (free service, no sub)' AS check_name;
SELECT * FROM audit_subscription_pricelist_orphans();


-- --- moved out of the skill 2026-09-02 (were detection queries still inlined) ---

-- @check id=3c name="On-account receivables (informational)" priority=P2
-- 3c. On-account receivables (informational, NOT P0). Invoiced customers are
-- settled by recording an account payment, never by retrying a card. ~300 open
-- orders is normal. Watch the age, not the count.
SELECT first_name_cache || ' ' || last_name_cache AS customer,
       count(*) AS orders, '$' || round(sum(amount_due), 2) AS outstanding,
       max(age_days) AS oldest_days,
       count(*) FILTER (WHERE on_account_card_error) AS card_charged_in_error
FROM v_outstanding_orders
WHERE counts_as_due AND bucket = 'on_account'
GROUP BY 1 ORDER BY sum(amount_due) DESC LIMIT 20;

-- @check id=3d name="Stalled in process" priority=P1
-- 3d. Stalled in process (P1). Unpaid, 7+ days, hasn't reached ready-for-delivery.
-- Not debt — no charge is due yet — but the order has stopped moving.
-- Surfaced in the admin at Overview -> "For your review" -> "Stalled in process".
SELECT order_number, status, age_days, '$' || amount_due AS value,
       first_name_cache || ' ' || last_name_cache AS customer
FROM v_outstanding_orders
WHERE bucket = 'stuck_in_process'
ORDER BY age_days DESC;

-- @check id=10b name="Orphaned customer profiles" priority=P3
-- Orphaned customer profiles
SELECT COUNT(*) AS orphan_profile_count FROM (
  SELECT p.id FROM profiles p
  LEFT JOIN customers c ON c.profile_id = p.id
  WHERE c.id IS NULL AND p.role = 'customer'
) t;
