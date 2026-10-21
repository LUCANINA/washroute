-- 2026-10-21 — Smoke test false alarm: "stripe seam — subscription invoice missing"
-- A scheduled-start subscription (create-subscription, session 190) is a Stripe trial
-- from signup until Pacific midnight on the chosen date: $0 invoice, nothing recorded.
-- Our DB stores it as 'active', so the smoke test false-alarmed (Arthur Middleton, sub 3ac1c47c).
-- Fix: skip a sub while it is still in its FIRST period (period_start ~ signup) AND that
-- period is not a normal one-month span. Once the trial converts, period_start moves off
-- signup and the check resumes. Tested against all 146 subs: matches only the 2 scheduled-start ones.
-- Review: LOW / clear. Body-only; signature, SECURITY DEFINER, search_path, assert_staff, grants unchanged.
-- Rollback: re-run this file with the "AND NOT ( ... )" block removed.
CREATE OR REPLACE FUNCTION public.audit_subscriptions_missing_invoice()
 RETURNS TABLE(subscription_id uuid, customer_id uuid, stripe_subscription_id text, status text, current_period_start timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM public.assert_staff('audit_subscriptions_missing_invoice');
  RETURN QUERY
  SELECT s.id, s.customer_id, s.stripe_subscription_id, s.status, s.current_period_start
  FROM subscriptions s
  WHERE s.status = 'active'
    AND s.current_period_start < NOW() - INTERVAL '2 hours'
    AND NOT (
      s.signup_date IS NOT NULL
      AND s.current_period_end IS NOT NULL
      AND abs(extract(epoch FROM s.current_period_start - s.signup_date)) < 600
      AND abs(extract(epoch FROM s.current_period_end - (s.current_period_start + INTERVAL '1 month'))) > 3600
    )
    AND NOT EXISTS (
      SELECT 1 FROM customer_transactions ct
      WHERE ct.customer_id = s.customer_id
        AND ct.type = 'subscription_invoice'
        AND ct.created_at >= s.current_period_start - INTERVAL '1 day'
    );
END
$function$;

REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() FROM anon;
GRANT  EXECUTE ON FUNCTION public.audit_subscriptions_missing_invoice() TO authenticated, service_role;

-- Verify after applying (expect 0 rows today):
-- SELECT * FROM public.audit_subscriptions_missing_invoice();
