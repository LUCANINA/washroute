-- ============================================================================
-- DRAFT MIGRATION — session_151_rls_initplan_optimization
-- Status: NOT APPLIED. For David's review/approval only.
-- Author: scheduled task washroute-db-optimization-prep (2026-05-26)
-- ============================================================================
--
-- WHY THIS EXISTS
--   On 2026-05-26 the project hit its Supabase compute Disk-IO ceiling and the
--   DB became unresponsive. David upgraded the compute tier as immediate relief.
--   This migration is the DURABLE fix so the upgrade isn't permanently required.
--
-- ROOT CAUSE (measured via pg_stat_statements):
--   The top time-consuming queries (admin dashboard reads of sms_messages,
--   customers, orders, route_stops) run at 600-1900 ms EACH while reading almost
--   nothing from disk (99-100% buffer cache hit). That signature = CPU burned
--   re-evaluating RLS helper functions ONCE PER ROW. Every admin read of a table
--   runs is_admin() for every row scanned; customer/driver reads run auth.uid()
--   / current_driver_id() per row. On a 38k-row table (sms_messages) that is tens
--   of thousands of function calls per query. Under the smaller compute tier this
--   per-row CPU + buffer churn is what exhausted IO.
--
-- THE FIX (this file):
--   Wrap each helper call in a scalar subquery — e.g. is_admin() -> (SELECT is_admin()).
--   Postgres then hoists it to an InitPlan and evaluates it ONCE per query instead
--   of once per row. All helpers (is_admin, is_staff, current_driver_id,
--   current_customer_id, pos_session_active) are STABLE, take no arguments, and
--   depend only on auth.uid() (constant for the whole statement) — so the rewrite
--   is SEMANTICALLY IDENTICAL: same rows visible to the same roles. Only the
--   evaluation count changes.
--
-- NO INDEXES IN THIS MIGRATION — and that is deliberate.
--   Every column on a measured hot path is ALREADY indexed:
--     sms_messages(customer_id), sms_messages(created_at),
--     orders(customer_id, status, created_at), customers(profile_id),
--     route_stops(driver_id, route_id, order_id), addresses(customer_id),
--     email_messages(customer_id, created_at), discount_redemptions(customer_id).
--   The advisor's 11 "unindexed foreign key" findings are all on COLD columns
--   (orders.archived_by, route_stops.moved_from_route_id, voicemails.listened_by,
--   sms_messages.sent_by_driver_id, services.linked_preference_id, etc.) that do
--   not appear in any measured hot query. Indexing them would add write overhead
--   for no measured read benefit, so they are intentionally skipped.
--
-- SAFETY:
--   * Uses ALTER POLICY (not DROP + CREATE) so there is never a window where a
--     table sits unprotected.
--   * Pure DDL on policy expressions; no data is touched.
--   * No table locks of consequence (ALTER POLICY takes a brief lock on the
--     table's catalog entry only). Still: apply during LOW-traffic hours
--     (laundry peak is afternoon/evening; early morning is safest).
--   * Each statement below was produced by taking the LIVE policy expression
--     verbatim and only wrapping the bare helper calls. Diff each against
--     pg_policies before applying if you want to triple-check.
--
-- ROLLBACK:
--   Re-running the same ALTER POLICY statements with the helper calls UN-wrapped
--   restores the originals. The pre-change definitions are preserved in this
--   repo's git history and in pg_policies at apply time.
-- ============================================================================

BEGIN;

-- ============================================================================
-- SECTION A — MEASURED HOT TABLES (highest impact; apply these first)
-- ============================================================================

-- ---- sms_messages (38,208 rows — #1 IO + time offender) --------------------
ALTER POLICY admin_all_sms_messages ON public.sms_messages
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY driver_read_customer_sms ON public.sms_messages
  USING ((((SELECT current_driver_id()) IS NOT NULL) AND (customer_id IN ( SELECT o.customer_id
     FROM ((route_stops rs
       JOIN orders o ON ((o.id = rs.order_id)))
       JOIN routes r ON ((r.id = rs.route_id)))
    WHERE (((r.driver_id = (SELECT current_driver_id())) OR (rs.driver_id = (SELECT current_driver_id()))) AND (r.run_date = CURRENT_DATE))))));

-- ---- customers (5,642 rows — 1273 ms mean) ---------------------------------
ALTER POLICY admin_all_customers ON public.customers
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY customer_read_own ON public.customers
  USING ((profile_id = (SELECT auth.uid())));

ALTER POLICY customer_insert_own ON public.customers
  WITH CHECK ((profile_id = (SELECT auth.uid())));

ALTER POLICY customer_update_own ON public.customers
  USING ((profile_id = (SELECT auth.uid()))) WITH CHECK ((profile_id = (SELECT auth.uid())));

ALTER POLICY driver_read_stop_customers ON public.customers
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND (id IN ( SELECT driver_stop_customer_ids.customer_id
     FROM driver_stop_customer_ids() driver_stop_customer_ids(customer_id)))));

-- ---- orders (5,062 rows — 700-810 ms; 4 permissive policies stack) ----------
ALTER POLICY admin_all_orders ON public.orders
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY customer_read_own_orders ON public.orders
  USING ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))));

ALTER POLICY customer_insert_own_orders ON public.orders
  WITH CHECK ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))));

ALTER POLICY customer_update_own_orders ON public.orders
  USING ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))))
  WITH CHECK ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))));

ALTER POLICY driver_read_assigned_orders ON public.orders
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND (id IN ( SELECT rs.order_id
     FROM (route_stops rs
       LEFT JOIN routes r ON ((r.id = rs.route_id)))
    WHERE (((rs.driver_id = (SELECT current_driver_id())) OR ((rs.driver_id IS NULL) AND (r.driver_id = (SELECT current_driver_id()))) OR (r.pickup_driver_id = (SELECT current_driver_id())) OR (r.delivery_driver_id = (SELECT current_driver_id()))) AND (rs.order_id IS NOT NULL))))));

ALTER POLICY driver_update_assigned_orders ON public.orders
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND (id IN ( SELECT rs.order_id
     FROM (route_stops rs
       LEFT JOIN routes r ON ((r.id = rs.route_id)))
    WHERE (((rs.driver_id = (SELECT current_driver_id())) OR ((rs.driver_id IS NULL) AND (r.driver_id = (SELECT current_driver_id()))) OR (r.pickup_driver_id = (SELECT current_driver_id())) OR (r.delivery_driver_id = (SELECT current_driver_id()))) AND (rs.order_id IS NOT NULL))))));

ALTER POLICY pos_order_insert ON public.orders
  WITH CHECK (((SELECT pos_session_active()) AND (source = 'walk_in'::text) AND (pos_shift_id IN ( SELECT s.id
     FROM (pos_shifts s
       JOIN pos_devices d ON ((d.id = s.device_id)))
    WHERE (d.auth_user_id = (SELECT auth.uid()))))));

ALTER POLICY pos_order_read ON public.orders
  USING (((SELECT pos_session_active()) AND (((source = 'walk_in'::text) AND (pos_shift_id IN ( SELECT s.id
     FROM (pos_shifts s
       JOIN pos_devices d ON ((d.id = s.device_id)))
    WHERE (d.auth_user_id = (SELECT auth.uid()))))) OR ((site_id IN ( SELECT d.site_id
     FROM pos_devices d
    WHERE (d.auth_user_id = (SELECT auth.uid())))) AND (status = ANY (ARRAY['picked_up'::text, 'processing'::text, 'folding'::text, 'ready_for_delivery'::text]))))));

-- ---- route_stops (9,778 rows — 373 ms) -------------------------------------
ALTER POLICY admin_write_route_stops ON public.route_stops
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY driver_update_assigned_stops ON public.route_stops
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND ((driver_id = (SELECT current_driver_id())) OR ((driver_id IS NULL) AND (route_id IN ( SELECT routes.id
     FROM routes
    WHERE (routes.driver_id = (SELECT current_driver_id()))))) OR (route_id IN ( SELECT routes.id
     FROM routes
    WHERE ((routes.pickup_driver_id = (SELECT current_driver_id())) OR (routes.delivery_driver_id = (SELECT current_driver_id()))))))));

-- ---- addresses (102 ms; customer policies were already wrapped) -------------
ALTER POLICY admin_all_addresses ON public.addresses USING ((SELECT is_admin()));
ALTER POLICY admin_delete_addresses ON public.addresses USING ((SELECT is_admin()));
ALTER POLICY admin_insert_addresses ON public.addresses WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_update_addresses ON public.addresses USING ((SELECT is_admin()));

ALTER POLICY driver_read_stop_addresses ON public.addresses
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND (customer_id IN ( SELECT DISTINCT o.customer_id
     FROM ((route_stops rs
       JOIN routes r ON ((r.id = rs.route_id)))
       JOIN orders o ON ((o.id = rs.order_id)))
    WHERE (((rs.driver_id = (SELECT current_driver_id())) OR (r.driver_id = (SELECT current_driver_id())) OR (r.pickup_driver_id = (SELECT current_driver_id())) OR (r.delivery_driver_id = (SELECT current_driver_id()))) AND (o.customer_id IS NOT NULL))))));

-- ---- email_messages (12.7 ms but 64 calls; admin inbox) --------------------
ALTER POLICY admin_all_email_messages ON public.email_messages
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

-- ---- discount_redemptions (838 ms mean) ------------------------------------
ALTER POLICY admin_read_all_redemptions ON public.discount_redemptions
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

ALTER POLICY customer_read_own_redemptions ON public.discount_redemptions
  USING ((customer_id IN ( SELECT discount_redemptions.customer_id FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (discount_redemptions.customer_id IS NOT NULL)))));

-- ---- order_items, subscriptions, notifications (customer-app reads) ---------
ALTER POLICY admin_all_order_items ON public.order_items
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY customer_read_own_order_items ON public.order_items
  USING ((order_id IN ( SELECT o.id FROM (orders o JOIN customers c ON ((c.id = o.customer_id))) WHERE (c.profile_id = (SELECT auth.uid())))));

ALTER POLICY admin_all_subscriptions ON public.subscriptions
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY customer_read_own_subscriptions ON public.subscriptions
  USING ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))));

ALTER POLICY admin_all_notifications ON public.notifications
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

ALTER POLICY customer_read_own_notifications ON public.notifications
  USING ((customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))));

-- ============================================================================
-- SECTION B — REMAINING TABLES (completeness sweep; lower traffic today but
--             prevents the next table from becoming the next hot spot)
-- ============================================================================

-- ---- profiles --------------------------------------------------------------
ALTER POLICY admin_read_all_profiles ON public.profiles USING ((SELECT is_admin()));
ALTER POLICY "Admin update any profile" ON public.profiles
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY user_read_own_profile ON public.profiles USING ((id = (SELECT auth.uid())));

-- ---- drivers ---------------------------------------------------------------
ALTER POLICY "Admin insert drivers" ON public.drivers
  WITH CHECK ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
ALTER POLICY "Admin update drivers" ON public.drivers
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));
ALTER POLICY "Admin delete drivers" ON public.drivers
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = 'admin'::text)))));

-- ---- driver_messages -------------------------------------------------------
ALTER POLICY admin_all_driver_messages ON public.driver_messages
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY driver_own_messages ON public.driver_messages
  USING ((driver_id IN ( SELECT drivers.id FROM drivers WHERE (drivers.profile_id = (SELECT auth.uid())))))
  WITH CHECK ((driver_id IN ( SELECT drivers.id FROM drivers WHERE (drivers.profile_id = (SELECT auth.uid())))));

-- ---- driver_locations ------------------------------------------------------
ALTER POLICY driver_insert_own_location ON public.driver_locations
  WITH CHECK ((driver_id IN ( SELECT drivers.id FROM drivers WHERE (drivers.profile_id = (SELECT auth.uid())))));
ALTER POLICY driver_update_own_location ON public.driver_locations
  USING ((driver_id IN ( SELECT drivers.id FROM drivers WHERE (drivers.profile_id = (SELECT auth.uid())))));

-- ---- route_driver_schedule -------------------------------------------------
ALTER POLICY admin_all_route_driver_schedule ON public.route_driver_schedule
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY driver_read_own_schedule ON public.route_driver_schedule
  USING ((driver_id IN ( SELECT drivers.id FROM drivers WHERE (drivers.profile_id = (SELECT auth.uid())))));

-- ---- routes ----------------------------------------------------------------
ALTER POLICY admin_write_routes ON public.routes
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY driver_update_assigned_routes ON public.routes
  USING ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND ((pickup_driver_id = (SELECT current_driver_id())) OR (delivery_driver_id = (SELECT current_driver_id())))))
  WITH CHECK ((((SELECT profiles.role FROM profiles WHERE (profiles.id = (SELECT auth.uid()))) = 'driver'::text) AND ((pickup_driver_id = (SELECT current_driver_id())) OR (delivery_driver_id = (SELECT current_driver_id())))));

-- ---- route_templates / route_driver_overrides ------------------------------
ALTER POLICY admin_write_route_templates ON public.route_templates
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_route_driver_overrides ON public.route_driver_overrides
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));

-- ---- order_events ----------------------------------------------------------
ALTER POLICY order_events_admin_read ON public.order_events USING ((SELECT is_admin()));
ALTER POLICY order_events_authenticated_insert ON public.order_events
  WITH CHECK (((SELECT auth.uid()) IS NOT NULL));

-- ---- order_folding_assignments ---------------------------------------------
ALTER POLICY "Admin full access" ON public.order_folding_assignments USING ((SELECT is_admin()));

-- ---- POS: pos_devices / pos_shifts / print_jobs / merchandise --------------
ALTER POLICY pos_devices_admin_all ON public.pos_devices
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY pos_devices_self_select ON public.pos_devices
  USING ((auth_user_id = (SELECT auth.uid())));

ALTER POLICY pos_shifts_admin_all ON public.pos_shifts
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY pos_shifts_self_select ON public.pos_shifts
  USING ((device_id IN ( SELECT pos_devices.id FROM pos_devices WHERE (pos_devices.auth_user_id = (SELECT auth.uid())))));

ALTER POLICY admin_all_print_jobs ON public.print_jobs
  USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY pos_print_insert ON public.print_jobs
  WITH CHECK (((SELECT pos_session_active()) AND (printer_token IN ( SELECT d.printer_token FROM pos_devices d WHERE (d.auth_user_id = (SELECT auth.uid()))))));

ALTER POLICY admin_manage_merchandise ON public.merchandise
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text, 'laundry_tech'::text]))))));

-- ---- draft_events ----------------------------------------------------------
ALTER POLICY "Admins can read draft events" ON public.draft_events
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text, 'laundry_tech'::text]))))));

-- ---- subscription_usage_log ------------------------------------------------
ALTER POLICY sub_usage_log_admin_all ON public.subscription_usage_log
  USING ((EXISTS ( SELECT 1 FROM profiles WHERE ((profiles.id = (SELECT auth.uid())) AND (profiles.role = ANY (ARRAY['admin'::text, 'manager'::text]))))));
ALTER POLICY sub_usage_log_customer_read ON public.subscription_usage_log
  USING ((subscription_id IN ( SELECT subscriptions.id FROM subscriptions WHERE (subscriptions.customer_id IN ( SELECT customers.id FROM customers WHERE (customers.profile_id = (SELECT auth.uid())))))));

-- ---- Pure-admin tables (is_admin() only; one line each) --------------------
ALTER POLICY rpc_warnings_admin_read ON public._rpc_warnings USING ((SELECT is_admin()));
ALTER POLICY admin_all_billing_groups ON public.billing_groups USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY conversations_admin_all ON public.conversations USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY cs_issue_comments_admin_all ON public.cs_issue_comments USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_cs_issues ON public.cs_issues USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY cpm_admin_all ON public.customer_payment_methods USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY cpm_customer_read_own ON public.customer_payment_methods USING ((customer_id = (SELECT current_customer_id())));
ALTER POLICY ct_admin_all ON public.customer_transactions USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY ct_customer_read_own ON public.customer_transactions USING ((customer_id = (SELECT current_customer_id())));
ALTER POLICY admin_all_daily_stats ON public.daily_stats USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_discounts ON public.discounts USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_launderers ON public.launderers USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_message_templates ON public.message_templates USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_payments ON public.payments USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_write_preferences ON public.preferences USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_racks ON public.racks USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY role_permissions_admin_write ON public.role_permissions USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_write_service_categories ON public.service_categories USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_write_service_fees ON public.service_fees USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_write_service_zones ON public.service_zones USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_write_services ON public.services USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_all_settings ON public.settings USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY sites_admin_write ON public.sites USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_read_sms_optout_restore_log ON public.sms_optout_restore_log USING ((SELECT is_admin()));
ALTER POLICY "Admin read/write staff_count_snapshots" ON public.staff_count_snapshots USING ((SELECT is_admin())) WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_insert_voicemails ON public.voicemails WITH CHECK ((SELECT is_admin()));
ALTER POLICY admin_update_voicemails ON public.voicemails USING ((SELECT is_admin()));
ALTER POLICY admin_view_voicemails ON public.voicemails USING ((SELECT is_admin()));

COMMIT;

-- ============================================================================
-- POST-APPLY VERIFICATION (run after applying, low-traffic window):
--   1. Re-run pg_stat_statements ordered by mean_exec_time — the sms_messages,
--      customers, and orders reads should drop from 600-1900 ms to tens of ms.
--   2. Smoke test EACH role end-to-end (admin / manager / laundry_tech / driver /
--      attendant / pos_device / customer): each must still see exactly the rows
--      it saw before. (Project lesson G: test every distinct profiles.role.)
--   3. Re-run get_advisors(performance) — auth_rls_initplan findings should clear.
-- ============================================================================
