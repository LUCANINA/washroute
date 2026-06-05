-- A5 (session 168, APPLIED): Stripe→DB seam health monitor.
-- Returns active/past_due subscriptions with NO subscription_invoice recorded for
-- their current period (>2h grace) — the signature of stripe-webhook signing-secret
-- drift (the class that forced the June 2 backfill). Called by nightly-smoke-test
-- (SMS-alerts) and daily_audit.sql Check 9. Reversible: DROP FUNCTION.
CREATE OR REPLACE FUNCTION public.audit_subscriptions_missing_invoice()
RETURNS TABLE(subscription_id uuid, customer_id uuid, stripe_subscription_id text, status text, current_period_start timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.id, s.customer_id, s.stripe_subscription_id, s.status, s.current_period_start
  FROM subscriptions s
  WHERE s.status IN ('active','past_due')
    AND s.current_period_start < NOW() - INTERVAL '2 hours'
    AND NOT EXISTS (
      SELECT 1 FROM customer_transactions ct
      WHERE ct.customer_id = s.customer_id
        AND ct.type = 'subscription_invoice'
        AND ct.created_at >= s.current_period_start - INTERVAL '1 day'
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM anon;
GRANT EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() TO authenticated, service_role;
