-- Supabase advisors (anon_security_definer_function_executable, function_search_path_mutable), 2026-09-16.
-- These SECURITY DEFINER functions are only ever called by logged-in users or by other
-- SECURITY DEFINER functions/triggers, so anon no longer needs EXECUTE.
-- Intentionally left anon-callable: signup/zone/slot/referral lookups and the RLS helpers
-- (is_admin, current_customer_id, current_driver_id, pos_session_active), which anon policies use.
REVOKE EXECUTE ON FUNCTION public.auto_route_order(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.auto_route_order(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.claim_existing_customer(uuid, text, text, text, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.claim_existing_customer(uuid, text, text, text, text, text, boolean, boolean) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.start_pos_shift(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.start_pos_shift(uuid, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_active_pos_shift(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_active_pos_shift(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.resync_subscription_overage_on_order_fn() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.resync_subscription_overage_on_order_fn() TO authenticated, service_role;

ALTER FUNCTION public.sync_stop_address_on_order_address_change() SET search_path = public, pg_temp;
