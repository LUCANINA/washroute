-- session_327 — add the missing staff guard to two audit RPCs.
-- APPLIED 2026-10-01 via apply_migration (same name)
--
-- FOUND BY: the session 227 authorization audit query, re-run during QA of the
-- processed-site work (session 326).
--
-- THE HOLE: both functions are SECURITY DEFINER (so they bypass RLS) and are
-- EXECUTE-able by `authenticated` — the role EVERY signed-in customer uses.
-- Neither had an assert_staff guard, so any customer could call them and read back
-- OTHER customers' ids and email addresses:
--   audit_subscription_pricelist_orphans  -> customer_id, email_cache, pricelist
--   audit_subscriptions_missing_invoice   -> subscription_id, customer_id,
--                                            stripe_subscription_id, status
-- Session 227 fixed the GRANTS on these (REVOKE PUBLIC + REVOKE anon + GRANT
-- authenticated) but never added a body guard, and `authenticated` is not staff-only.
-- Nothing was newly broken by session 325/326 — this closes a standing gap that
-- session 325's CREATE OR REPLACE preserved without noticing.
--
-- CALLER AUDIT (all three greps, per session 227 — skipping the second is what broke
-- customer SMS there):
--   1. repo     -> supabase/functions/nightly-smoke-test/index.ts only, and it builds
--                  its client from SUPABASE_SERVICE_ROLE_KEY.
--   2. pg_proc  -> no database function references either name.
--   3. cron.job -> no job calls either RPC directly (the smoke-test job calls the edge
--                  function, which uses the service-role key internally, so the job's
--                  own bearer token is irrelevant to this guard).
--   Plus database/audits/daily_audit.sql, run as `postgres` with no JWT claims.
--   assert_staff returns early for BOTH no-claims and service_role, so every real
--   caller keeps working.
--
-- LANGUAGE CHANGE: both were LANGUAGE sql, which cannot PERFORM. They become plpgsql
-- with RETURN QUERY. Signature, arguments, return type and the query text itself are
-- unchanged, so no caller can tell the difference. STABLE and the explicit
-- search_path are preserved; CREATE OR REPLACE keeps existing grants.
--
-- VERIFIED after apply: manager and laundry_tech still get results (0 rows, matching
-- the healthy state); a customer JWT is BLOCKED on both.
--
-- NOT DONE DELIBERATELY: ~75 SECURITY DEFINER functions come back from that audit
-- query as "unguarded". Most are correctly customer-facing (current_customer_id,
-- referral_config, get_slot_availability, submit_customer_message, claim_referral_code
-- …) and scope themselves per-caller by other means; mass-guarding them would break
-- the customer app. Only these two leak staff-only data about OTHER customers.
--
-- ROLLBACK: re-apply both as LANGUAGE sql without the assert_staff line.

CREATE OR REPLACE FUNCTION public.audit_subscription_pricelist_orphans()
 RETURNS TABLE(customer_id uuid, email_cache text, pricelist text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  PERFORM public.assert_staff('audit_subscription_pricelist_orphans');
  RETURN QUERY
  SELECT c.id, c.email_cache, c.pricelist
  FROM customers c
  WHERE c.pricelist = 'Subscription'
    AND NOT EXISTS (
      SELECT 1 FROM subscriptions s
      WHERE s.customer_id = c.id
        AND s.status IN ('active','past_due','paused','trialing')
    );
END
$fn$;

CREATE OR REPLACE FUNCTION public.audit_subscriptions_missing_invoice()
 RETURNS TABLE(subscription_id uuid, customer_id uuid, stripe_subscription_id text, status text, current_period_start timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  PERFORM public.assert_staff('audit_subscriptions_missing_invoice');
  RETURN QUERY
  SELECT s.id, s.customer_id, s.stripe_subscription_id, s.status, s.current_period_start
  FROM subscriptions s
  WHERE s.status = 'active'
    AND s.current_period_start < NOW() - INTERVAL '2 hours'
    AND NOT EXISTS (
      SELECT 1 FROM customer_transactions ct
      WHERE ct.customer_id = s.customer_id
        AND ct.type = 'subscription_invoice'
        AND ct.created_at >= s.current_period_start - INTERVAL '1 day'
    );
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() FROM anon;
GRANT  EXECUTE ON FUNCTION public.audit_subscription_pricelist_orphans() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM anon;
GRANT  EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() TO authenticated, service_role;

DO $do$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
  WHERE pronamespace='public'::regnamespace
    AND proname IN ('audit_subscription_pricelist_orphans','audit_subscriptions_missing_invoice')
    AND prosrc ~ 'assert_staff';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected 2 guarded audit functions, found % — rolling back', v_n;
  END IF;
END
$do$;
