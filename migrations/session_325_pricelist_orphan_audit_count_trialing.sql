-- session_325 — audit_subscription_pricelist_orphans() must count 'trialing'
-- APPLIED 2026-10-01 via apply_migration (name: fix_pricelist_orphan_audit_count_trialing)
--
-- WHY: the nightly smoke test raised a CRITICAL alert and sent David an SMS on
-- 2026-10-01 10:00 UTC claiming 1 customer was on the $0 Subscription pricelist
-- with no active subscription ("free service"). She was not: customer
-- ad32ae3f-f394-47a3-ab92-5b8fc1ae9500 signed up 2026-09-30 and is 'trialing'
-- until 2026-10-05. The function's status list omitted 'trialing', so every
-- scheduled/not-yet-started subscriber reads as an orphan and the alert would
-- have fired every night.
--
-- 'trialing' has been part of the app's active-subscription set since session 190
-- (customer-app and admin-dashboard both use
-- ['active','paused','past_due','trialing']). This function was simply missed.
--
-- VERIFIED: 102 customers on the Subscription pricelist = 101 'active' + 1
-- 'trialing'. Function returns 0 rows after apply. Grants unchanged
-- (authenticated, postgres, service_role — no anon).
--
-- ROLLBACK: re-apply with s.status IN ('active','past_due','paused').

CREATE OR REPLACE FUNCTION public.audit_subscription_pricelist_orphans()
 RETURNS TABLE(customer_id uuid, email_cache text, pricelist text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT c.id, c.email_cache, c.pricelist
  FROM customers c
  WHERE c.pricelist = 'Subscription'
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.customer_id = c.id
        AND s.status IN ('active','past_due','paused','trialing')
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() FROM anon;
GRANT  EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() TO authenticated, service_role;
