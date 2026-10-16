-- session_322_run_daily_audit.sql
--
-- Moves the 42 detection queries in database/audits/daily_audit.sql into a single
-- read-only database function, so the daily bug check no longer needs a shell on
-- David's Mac to read that file. Cloud-only scheduled runs can now call:
--
--     SELECT * FROM public.run_daily_audit();
--
-- and get one row per check: check_id, check_name, priority, row_count, error.
-- row_count = 0 means clear. A non-null `error` means that one check failed to
-- run (its own EXCEPTION block) — the other 41 still report.
--
-- The queries below are copied VERBATIM from daily_audit.sql by
-- proposed-migrations/session-322-daily-audit-function/gen_audit_fn.py.
-- daily_audit.sql remains the source of truth: change it there, re-run the
-- generator, and apply a new migration. Do not hand-edit the bodies here.
--
-- Checks that are NOT SQL are not included (check 24, the driver-app RPC
-- call-site scan, is a filesystem check: scripts/audit-rpc-call-sites.sh).
--
-- SECURITY: SECURITY DEFINER because the audit must see every row regardless of
-- RLS, exactly as David's admin session does today. It is read-only (no INSERT,
-- UPDATE, DELETE anywhere in the body) and gated on assert_staff(), so a
-- customer JWT cannot call it. anon and PUBLIC are revoked explicitly — per the
-- session 148 lesson, REVOKE PUBLIC alone is not enough on Supabase.

CREATE OR REPLACE FUNCTION public.run_daily_audit()
RETURNS TABLE (
  check_id    text,
  check_name  text,
  priority    text,
  row_count   bigint,
  error       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_n bigint;
BEGIN
  PERFORM assert_staff();

  -- ── check 1: Unrouted Orders
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT o.id, o.order_number, o.status, o.routing_error,
             c.first_name_cache || ' ' || c.last_name_cache AS customer,
             (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::text AS pickup_pt
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status IN ('scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery')
        AND (o.routing_error IS NOT NULL
             OR (
               
               
               
               
               
               
               
               COALESCE(o.source, '') <> 'walk_in'
               AND NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.stop_type = 'pickup')
             ))
      ORDER BY o.pickup_window_start
    ) q;
    RETURN QUERY SELECT '1'::text, 'Unrouted Orders'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '1'::text, 'Unrouted Orders'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 2: Wrong-Date Stops
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
                           END AT TIME ZONE 'America/Los_Angeles')::date
    ) q;
    RETURN QUERY SELECT '2'::text, 'Wrong-Date Stops'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '2'::text, 'Wrong-Date Stops'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 3: Outstanding Orders
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT order_number, status, bucket, '$' || amount_due AS amount, age_days,
             first_name_cache || ' ' || last_name_cache AS customer
      FROM v_outstanding_orders
      WHERE counts_as_due
        AND bucket IN ('card_declined', 'awaiting_payment')
      ORDER BY amount_due DESC
    ) q;
    RETURN QUERY SELECT '3'::text, 'Outstanding Orders'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '3'::text, 'Outstanding Orders'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 3b: Charged But billing_status Missing
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY o.billed_at DESC
    ) q;
    RETURN QUERY SELECT '3b'::text, 'Charged But billing_status Missing'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '3b'::text, 'Charged But billing_status Missing'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 4: Stop / Order Status Desync
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY o.order_number
    ) q;
    RETURN QUERY SELECT '4'::text, 'Stop / Order Status Desync'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '4'::text, 'Stop / Order Status Desync'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 5: Duplicate Customers
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY cnt DESC
    ) q;
    RETURN QUERY SELECT '5'::text, 'Duplicate Customers'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '5'::text, 'Duplicate Customers'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 6: Duplicate Orders
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY pickup_date
    ) q;
    RETURN QUERY SELECT '6'::text, 'Duplicate Orders'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '6'::text, 'Duplicate Orders'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 7: Over-Capacity Routes
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
        AND rt.stop_limit > 0      
      GROUP BY r.id, rt.name, r.run_date, rt.stop_limit
      HAVING COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) > rt.stop_limit
      ORDER BY r.run_date, rt.name
    ) q;
    RETURN QUERY SELECT '7'::text, 'Over-Capacity Routes'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '7'::text, 'Over-Capacity Routes'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 8: Driverless Routes
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY r.run_date, rt.name
    ) q;
    RETURN QUERY SELECT '8'::text, 'Driverless Routes'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '8'::text, 'Driverless Routes'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 9: SMS Opt-Out Sync
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT COUNT(*) AS out_of_sync_count
      FROM customers
      WHERE phone_cache IS NOT NULL
        AND sms_consent_at IS NULL
        AND sms_marketing_opt_out_at IS NULL
    ) q;
    RETURN QUERY SELECT '9'::text, 'SMS Opt-Out Sync'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '9'::text, 'SMS Opt-Out Sync'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 10: Orphaned Records
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT COUNT(*) AS duplicate_address_count FROM (
        SELECT customer_id, line1, city
        FROM addresses WHERE customer_id IS NOT NULL
        GROUP BY customer_id, line1, city HAVING COUNT(*) > 1
      ) t
    ) q;
    RETURN QUERY SELECT '10'::text, 'Orphaned Records'::text, 'P3'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '10'::text, 'Orphaned Records'::text, 'P3'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 11: Ghost Delivery Stops
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY r.run_date, rt.name
    ) q;
    RETURN QUERY SELECT '11'::text, 'Ghost Delivery Stops'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '11'::text, 'Ghost Delivery Stops'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 12: Orphan Auth Users
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT au.id AS orphan_auth_id,
             au.email,
             au.created_at,
             au.last_sign_in_at,
             
             
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
        
        
        AND au.id NOT IN (
          '1671939b-3100-426a-a741-0ef8792591a3'::uuid,  
          '7586a51e-2200-485a-944b-2ec2479f9115'::uuid,  
          'd0bc0bf0-f887-4679-aa8a-cb2c9522b024'::uuid,  
          '9372180b-047e-426b-ad38-a45813192918'::uuid,  
          '9dda1a43-063e-4d6f-96af-56652d24c7e3'::uuid,  
          'ef27235a-40e7-4a2a-b9aa-fe1f043af69e'::uuid   
        )
        AND au.email NOT LIKE '%@washroute.test'
        AND au.email NOT LIKE 'attendant-%@familylaundry.local'  
      ORDER BY au.created_at DESC
    ) q;
    RETURN QUERY SELECT '12'::text, 'Orphan Auth Users'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '12'::text, 'Orphan Auth Users'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 13: Stuck Phone-OTP Attempts
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY c.total_orders DESC NULLS LAST, s.token_at DESC
    ) q;
    RETURN QUERY SELECT '13'::text, 'Stuck Phone-OTP Attempts'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '13'::text, 'Stuck Phone-OTP Attempts'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 14: Window / Sub-Window Alignment
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY r.run_date, rt.name
    ) q;
    RETURN QUERY SELECT '14'::text, 'Window / Sub-Window Alignment'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '14'::text, 'Window / Sub-Window Alignment'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 15: Stale Subscription Overage
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY s.current_period_end
    ) q;
    RETURN QUERY SELECT '15'::text, 'Stale Subscription Overage'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '15'::text, 'Stale Subscription Overage'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 16a: Service-Zone Polygon Integrity (a)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT id, name, ST_IsValidReason(polygon) AS reason
      FROM service_zones
      WHERE polygon IS NOT NULL AND NOT ST_IsValid(polygon)
    ) q;
    RETURN QUERY SELECT '16a'::text, 'Service-Zone Polygon Integrity (a)'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '16a'::text, 'Service-Zone Polygon Integrity (a)'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 16b: Service-Zone Polygon Integrity (b)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT a.name AS zone_a, b.name AS zone_b,
             ROUND((ST_Area(ST_Intersection(a.polygon, b.polygon)::geography) / 1000000.0)::numeric, 4) AS overlap_sq_km
      FROM service_zones a JOIN service_zones b ON a.id < b.id
       AND a.polygon IS NOT NULL AND b.polygon IS NOT NULL
       AND ST_IsValid(a.polygon) AND ST_IsValid(b.polygon)
       AND ST_Intersects(a.polygon, b.polygon)
      WHERE ST_Area(ST_Intersection(a.polygon, b.polygon)::geography) > 10000
      ORDER BY overlap_sq_km DESC
    ) q;
    RETURN QUERY SELECT '16b'::text, 'Service-Zone Polygon Integrity (b)'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '16b'::text, 'Service-Zone Polygon Integrity (b)'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 17: Cron Job Failures (Last 24h)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT j.jobname,
             COUNT(*)             AS failures_24h,
             MAX(d.start_time AT TIME ZONE 'America/Los_Angeles') AS last_failure_pt,
             (ARRAY_AGG(d.return_message ORDER BY d.start_time DESC))[1] AS latest_error
      FROM cron.job_run_details d
      JOIN cron.job j ON j.jobid = d.jobid
      WHERE d.status = 'failed'
        AND d.start_time > now() - interval '24 hours'
      GROUP BY j.jobname
      ORDER BY failures_24h DESC
    ) q;
    RETURN QUERY SELECT '17'::text, 'Cron Job Failures (Last 24h)'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '17'::text, 'Cron Job Failures (Last 24h)'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 18: Silent Customer-Facing Reschedules
  BEGIN
    SELECT count(*) INTO v_n FROM (
      WITH first_event AS (
        
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
        
        
        
        
        SELECT created_at
        FROM first_event
        GROUP BY created_at
        HAVING COUNT(*) >= 3
      ),
      first_known AS (
        
        
        
        
        SELECT fe.order_id, fe.original_window
        FROM first_event fe
        WHERE fe.created_at NOT IN (SELECT created_at FROM bulk_sweep_timestamps)
      ),
      last_reschedule AS (
        
        
        SELECT order_id, MAX(created_at) AS last_reschedule_at
        FROM order_events
        WHERE event_type = 'rescheduled' AND description ILIKE '%delivery%'
        GROUP BY order_id
      ),
      last_delivery_sms AS (
        
        
        
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
        
        AND ABS(EXTRACT(EPOCH FROM (o.delivery_window_start - fk.original_window))/3600) >= 4
        
        AND (ls.last_sms_at IS NULL OR ls.last_sms_at < lr.last_reschedule_at)
        
        
        AND o.delivery_window_start > NOW() - INTERVAL '2 hours'
      ORDER BY o.delivery_window_start
    ) q;
    RETURN QUERY SELECT '18'::text, 'Silent Customer-Facing Reschedules'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '18'::text, 'Silent Customer-Facing Reschedules'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 19: Photo Capture Rate Anomaly
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
          - (SELECT pct_with_photo FROM stats WHERE bucket = 'last_24h') AS drop_pp
    ) q;
    RETURN QUERY SELECT '19'::text, 'Photo Capture Rate Anomaly'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '19'::text, 'Photo Capture Rate Anomaly'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 20: POS Walk-In Without Launderer Assignment
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
        
        
        
        
        AND (
          COALESCE(o.weight_lbs, 0) > 0
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(o.line_items) li
            WHERE li->>'kind' IN ('service','addon') OR li->>'type' = 'service'
          )
        )
      ORDER BY o.created_at DESC
    ) q;
    RETURN QUERY SELECT '20'::text, 'POS Walk-In Without Launderer Assignment'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '20'::text, 'POS Walk-In Without Launderer Assignment'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 21: Active Order with Skipped/Failed Route Stop
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY o.created_at DESC
    ) q;
    RETURN QUERY SELECT '21'::text, 'Active Order with Skipped/Failed Route Stop'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '21'::text, 'Active Order with Skipped/Failed Route Stop'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 22: Cron Jobs With Inline Critical-Table Writes
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY classification, j.jobname
    ) q;
    RETURN QUERY SELECT '22'::text, 'Cron Jobs With Inline Critical-Table Writes'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '22'::text, 'Cron Jobs With Inline Critical-Table Writes'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 23: Active Subscription Plan Not Billable in Stripe
  -- Replaced 2026-10-01, in step with database/audits/daily_audit.sql. The old
  -- P0 ("Chargeable Subscription Plan While Subscriptions Pre-Launch") flagged any
  -- active plan that HAD a stripe_price_id; subscriptions are now launched, so that
  -- fired daily on the healthy state. The inverse is what matters: an active plan
  -- with NO price cannot be charged, so its subscribers get free service.
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT id, name, price_monthly, is_active, stripe_price_id
      FROM subscription_plans
      WHERE is_active = true AND stripe_price_id IS NULL
    ) q;
    RETURN QUERY SELECT '23'::text, 'Active Subscription Plan Not Billable in Stripe'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '23'::text, 'Active Subscription Plan Not Billable in Stripe'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 24b: Account-Credit Over-Application / Double Charge
  BEGIN
    SELECT count(*) INTO v_n FROM (
      WITH o2 AS (
        SELECT o.id, o.order_number, o.customer_id,
               o.total_amount
               + ABS(COALESCE((SELECT SUM((li->>'amount')::numeric)
                   FROM jsonb_array_elements(o.line_items) li WHERE li->>'type'='credit'),0))
               + CASE WHEN o.tip_type='pct' THEN ROUND(o.total_amount*COALESCE(o.tip_amount,0)/100,2)
                      ELSE COALESCE(o.tip_amount,0) END AS gross_owed
        FROM orders o
        WHERE jsonb_typeof(o.line_items)='array' AND jsonb_array_length(o.line_items) > 0  
          AND o.created_at > now() - interval '45 days'
      ),
      tx AS (
        SELECT order_id,
          COALESCE(SUM(amount) FILTER (WHERE type='charge'),0)
            - COALESCE(SUM(amount) FILTER (WHERE type='refund'),0)
            + COALESCE(SUM(amount) FILTER (WHERE type='subscription_invoice'),0) AS card_net,
          
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
      ORDER BY overpaid DESC
    ) q;
    RETURN QUERY SELECT '24b'::text, 'Account-Credit Over-Application / Double Charge'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '24b'::text, 'Account-Credit Over-Application / Double Charge'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 25: Receipt Total Drift: line items that don't sum to the charge
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
      ORDER BY (auth_pretax - li_sum) DESC
    ) q;
    RETURN QUERY SELECT '25'::text, 'Receipt Total Drift: line items that don''t sum to the charge'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '25'::text, 'Receipt Total Drift: line items that don''t sum to the charge'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L1: Duplicate services that could poison client-side .find() — HOTFIX clas
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT * FROM audit_duplicate_services()
    ) q;
    RETURN QUERY SELECT 'L1'::text, 'Duplicate services that could poison client-side .find() — HOTFIX class (session 167)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L1'::text, 'Duplicate services that could poison client-side .find() — HOTFIX class (session 167)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L2: Orphan route_stops (route_id no longer exists)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT rs.id, rs.order_id, rs.route_id, rs.stop_type, rs.status
      FROM route_stops rs
      LEFT JOIN routes r ON r.id = rs.route_id
      WHERE rs.route_id IS NOT NULL AND r.id IS NULL
    ) q;
    RETURN QUERY SELECT 'L2'::text, 'Orphan route_stops (route_id no longer exists)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L2'::text, 'Orphan route_stops (route_id no longer exists)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L3: Unpaid delivered orders (billing_status not 'paid' but order status is
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT id, order_number, customer_id, billing_status, total_amount, actual_delivery_at
      FROM orders
      WHERE status = 'delivered'
        AND billing_status IS DISTINCT FROM 'paid'
        AND billing_status IS DISTINCT FROM 'refunded'
        AND actual_delivery_at > NOW() - INTERVAL '14 days'
      ORDER BY actual_delivery_at DESC
    ) q;
    RETURN QUERY SELECT 'L3'::text, 'Unpaid delivered orders (billing_status not ''paid'' but order status is delivered)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L3'::text, 'Unpaid delivered orders (billing_status not ''paid'' but order status is delivered)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L4: Health alerts in the last 24 hours
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT created_at, alert_type, severity, message, sent_sms
      FROM _health_alerts
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND alert_type != 'heartbeat'
      ORDER BY created_at DESC
    ) q;
    RETURN QUERY SELECT 'L4'::text, 'Health alerts in the last 24 hours'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L4'::text, 'Health alerts in the last 24 hours'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L5: Subscriptions where DB usage > 0 lbs but no completed orders this cycl
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
        )
    ) q;
    RETURN QUERY SELECT 'L5'::text, 'Subscriptions where DB usage > 0 lbs but no completed orders this cycle'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L5'::text, 'Subscriptions where DB usage > 0 lbs but no completed orders this cycle'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L6: customer_transactions ledger balance check — net = 0 per customer for 
  BEGIN
    SELECT count(*) INTO v_n FROM (
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
           > (SELECT COALESCE(MAX(credits), 0) FROM customers c WHERE c.id = customer_transactions.customer_id) + 0.01
    ) q;
    RETURN QUERY SELECT 'L6'::text, 'customer_transactions ledger balance check — net = 0 per customer for refunds'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L6'::text, 'customer_transactions ledger balance check — net = 0 per customer for refunds'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L7: RPC warnings in the last 24h (silent failures we want to surface)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT rpc_name, warning_code, COUNT(*) AS occurrences, MAX(created_at) AS most_recent
      FROM _rpc_warnings
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY rpc_name, warning_code
      ORDER BY occurrences DESC
    ) q;
    RETURN QUERY SELECT 'L7'::text, 'RPC warnings in the last 24h (silent failures we want to surface)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L7'::text, 'RPC warnings in the last 24h (silent failures we want to surface)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L8: Customers with stripe_customer_id but no saved card (and no recent act
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT id, first_name_cache, email_cache, stripe_customer_id, created_at
      FROM customers
      WHERE stripe_customer_id IS NOT NULL
        AND stripe_default_payment_method_id IS NULL
        AND last_order_at < NOW() - INTERVAL '60 days'
      LIMIT 20
    ) q;
    RETURN QUERY SELECT 'L8'::text, 'Customers with stripe_customer_id but no saved card (and no recent activity)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L8'::text, 'Customers with stripe_customer_id but no saved card (and no recent activity)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L9: Stripe→DB seam health (session 168, A5)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT * FROM audit_subscriptions_missing_invoice()
    ) q;
    RETURN QUERY SELECT 'L9'::text, 'Stripe→DB seam health (session 168, A5)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L9'::text, 'Stripe→DB seam health (session 168, A5)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check L10: Subscription-pricelist orphans — cancel→revert health (session 168)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT * FROM audit_subscription_pricelist_orphans()
    ) q;
    RETURN QUERY SELECT 'L10'::text, 'Subscription-pricelist orphans — cancel→revert health (session 168)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'L10'::text, 'Subscription-pricelist orphans — cancel→revert health (session 168)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 3c: On-account receivables (informational)
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT first_name_cache || ' ' || last_name_cache AS customer,
             count(*) AS orders, '$' || round(sum(amount_due), 2) AS outstanding,
             max(age_days) AS oldest_days,
             count(*) FILTER (WHERE on_account_card_error) AS card_charged_in_error
      FROM v_outstanding_orders
      WHERE counts_as_due AND bucket = 'on_account'
      GROUP BY 1 ORDER BY sum(amount_due) DESC LIMIT 20
    ) q;
    RETURN QUERY SELECT '3c'::text, 'On-account receivables (informational)'::text, 'P2'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '3c'::text, 'On-account receivables (informational)'::text, 'P2'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 3d: Stalled in process
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT order_number, status, age_days, '$' || amount_due AS value,
             first_name_cache || ' ' || last_name_cache AS customer
      FROM v_outstanding_orders
      WHERE bucket = 'stuck_in_process'
      ORDER BY age_days DESC
    ) q;
    RETURN QUERY SELECT '3d'::text, 'Stalled in process'::text, 'P1'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '3d'::text, 'Stalled in process'::text, 'P1'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 10b: Orphaned customer profiles
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT COUNT(*) AS orphan_profile_count FROM (
        SELECT p.id FROM profiles p
        LEFT JOIN customers c ON c.profile_id = p.id
        WHERE c.id IS NULL AND p.role = 'customer'
      ) t
    ) q;
    RETURN QUERY SELECT '10b'::text, 'Orphaned customer profiles'::text, 'P3'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '10b'::text, 'Orphaned customer profiles'::text, 'P3'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 26: Order/Payment Reconciliation — money collected vs what the order itemi
  BEGIN
    SELECT count(*) INTO v_n FROM (
      WITH owed AS (
        SELECT o.id, o.order_number, o.customer_id, o.created_at, o.source,
               ROUND(COALESCE((SELECT SUM((li->>'amount')::numeric)
                               FROM jsonb_array_elements(o.line_items) li
                               WHERE li->>'type' NOT IN ('credit','tax')),0)
                   + COALESCE(o.tax_amount,0)
                   + CASE WHEN o.tip_type='pct'
                          THEN ROUND(o.total_amount*COALESCE(o.tip_amount,0)/100,2)
                          ELSE COALESCE(o.tip_amount,0) END, 2) AS amount_owed
        FROM orders o
        WHERE o.created_at > now() - interval '45 days'
          AND o.billing_status = 'paid'
          
          AND jsonb_typeof(o.line_items)='array' AND jsonb_array_length(o.line_items) > 0
      ), coll AS (
        SELECT order_id,
               SUM(CASE WHEN type IN ('refund','credit_refund') THEN -amount ELSE amount END) AS collected,
               SUM(CASE WHEN type='refund' THEN amount ELSE 0 END)                            AS cash_refunded
        FROM customer_transactions
        WHERE type IN ('charge','credit_use','refund','credit_refund')
        GROUP BY order_id
      )
      SELECT c.first_name_cache || ' ' || c.last_name_cache AS customer,
             owed.order_number, owed.created_at::date, owed.source,
             owed.amount_owed, coll.collected, coll.cash_refunded,
             ROUND(coll.collected - owed.amount_owed, 2) AS gap,
             CASE WHEN coll.collected - owed.amount_owed > 0.01 THEN 'OVERCHARGED — refund owed'
                  ELSE 'UNDERCHARGED — money uncollected' END AS verdict
      FROM owed JOIN coll ON coll.order_id = owed.id
      JOIN customers c ON c.id = owed.customer_id
      WHERE coll.collected > 0.01
        AND ABS(coll.collected - owed.amount_owed) > 0.01
        
        AND NOT (coll.cash_refunded > 0.01
                 AND ABS((coll.collected - owed.amount_owed) + coll.cash_refunded) < 0.01)
      ORDER BY ABS(coll.collected - owed.amount_owed) DESC
    ) q;
    RETURN QUERY SELECT '26'::text, 'Order/Payment Reconciliation — money collected vs what the order itemises'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '26'::text, 'Order/Payment Reconciliation — money collected vs what the order itemises'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

  -- ── check 27: Delivered but never charged
  BEGIN
    SELECT count(*) INTO v_n FROM (
      SELECT c.first_name_cache || ' ' || c.last_name_cache AS customer,
             o.order_number, o.created_at::date, o.status, o.billing_status, o.total_amount
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.created_at > now() - interval '45 days'
        AND o.status = 'delivered'
        AND COALESCE(o.billing_status,'') NOT IN ('paid','refunded','written_off')
        AND COALESCE(o.total_amount,0) > 0
        AND COALESCE(c.billing_type,'') <> 'on_account'
      ORDER BY o.total_amount DESC
    ) q;
    RETURN QUERY SELECT '27'::text, 'Delivered but never charged'::text, 'P0'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '27'::text, 'Delivered but never charged'::text, 'P0'::text, NULL::bigint, SQLERRM::text;
  END;

END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_daily_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.run_daily_audit() FROM anon;
GRANT  EXECUTE ON FUNCTION public.run_daily_audit() TO authenticated, service_role;

COMMENT ON FUNCTION public.run_daily_audit() IS
  'Read-only daily health audit: one row per check from database/audits/daily_audit.sql. Staff only. Generated by session-322 generator — edit daily_audit.sql, not this function.';
