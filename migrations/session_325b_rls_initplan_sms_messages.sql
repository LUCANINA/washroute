-- session_325b — RLS InitPlan fix, sms_messages only
-- APPLIED 2026-10-01 via apply_migration (name: session_151_rls_initplan_sms_messages_only)
--
-- WHY: 975 "canceling statement due to statement timeout" errors in 24h, all on
-- the admin texts inbox query
--   SELECT * FROM sms_messages WHERE created_at >= $1 ORDER BY created_at LIMIT/OFFSET
-- Staff saw the inbox spin and fail to load. authenticated has statement_timeout=8s.
--
-- MEASURED CAUSE: the two PERMISSIVE policies on sms_messages are OR'd together.
-- Because the driver branch is row-dependent, Postgres cannot hoist is_admin()
-- out of the OR, so it is evaluated once per row. On a real manager JWT:
--   before: 822 ms for 1000 rows at OFFSET 0 (planning 160 ms)
--   after:    3.2 ms for the same query  (planning 7.8 ms)   ~260x
--   after, worst case (OFFSET 94000, all 95,000 rows): 2.0 s — inside the 8 s budget
-- The table grew from 38,208 rows when this was first diagnosed (session 151)
-- to 95,905 today, which is why it crossed the timeout now.
--
-- SEMANTICALLY IDENTICAL: is_admin() and current_driver_id() are STABLE, take no
-- arguments, and depend only on auth.uid(), which is constant for the statement.
-- Wrapping each in a scalar subquery only changes HOW OFTEN it runs.
-- PROVEN, not assumed: visible-row fingerprints (count + md5 of sorted ids over
-- the last 14 days) captured before and after inside ONE transaction for
-- admin, manager, laundry_tech, attendant, pos_device, cpa, a driver with no
-- stops, two drivers with stops today (142 and 287 rows), a customer, and an
-- unknown uid. All 11 came back IDENTICAL.
--
-- SCOPE: sms_messages only. Expressions were taken from LIVE pg_policies on
-- 2026-10-01, NOT from proposed-migrations/session_151_rls_initplan_optimization.sql
-- (written 2026-05-26), so no 4-month-old policy text can be reintroduced. The
-- remaining ~86 policies in that draft are still pending their own review:
-- several tables have had RLS changed since it was written
-- (session_165, lock_down_archive_tables_rls, enable_rls_on_resync_backup_tables).
--
-- ALTER POLICY is used, so the table is never unprotected. No data is touched.
--
-- ROLLBACK:
--   ALTER POLICY admin_all_sms_messages ON public.sms_messages
--     USING (is_admin()) WITH CHECK (is_admin());
--   ALTER POLICY driver_read_customer_sms ON public.sms_messages
--     USING (((current_driver_id() IS NOT NULL) AND (customer_id IN ( SELECT o.customer_id
--        FROM ((route_stops rs JOIN orders o ON ((o.id = rs.order_id)))
--          JOIN routes r ON ((r.id = rs.route_id)))
--       WHERE (((r.driver_id = current_driver_id()) OR (rs.driver_id = current_driver_id()))
--         AND (r.run_date = CURRENT_DATE))))));

ALTER POLICY admin_all_sms_messages ON public.sms_messages
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY driver_read_customer_sms ON public.sms_messages
  USING ((((SELECT current_driver_id()) IS NOT NULL) AND (customer_id IN ( SELECT o.customer_id
     FROM ((route_stops rs
       JOIN orders o ON ((o.id = rs.order_id)))
       JOIN routes r ON ((r.id = rs.route_id)))
    WHERE (((r.driver_id = (SELECT current_driver_id())) OR (rs.driver_id = (SELECT current_driver_id()))) AND (r.run_date = CURRENT_DATE))))));
