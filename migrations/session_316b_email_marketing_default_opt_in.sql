-- Session 316b (2026-09-24): everyone who has not opted out is on the email marketing list.
-- APPLIED via apply_migration. A customer row can no longer be "not opted out" with a NULL
-- consent timestamp (what kept 207 customers out of SendGrid while admin showed "Opted in").
-- Covers every path: app signup with the box unticked, admin/POS-created customers, and an
-- admin re-enabling email for someone who had opted out.
CREATE OR REPLACE FUNCTION public.default_email_marketing_consent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.email_marketing_opt_out_at IS NULL AND NEW.email_marketing_consent_at IS NULL THEN
    NEW.email_marketing_consent_at := now();
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.default_email_marketing_consent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.default_email_marketing_consent() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_default_email_marketing_consent ON public.customers;
CREATE TRIGGER trg_default_email_marketing_consent
  BEFORE INSERT OR UPDATE OF email_marketing_opt_out_at, email_marketing_consent_at ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.default_email_marketing_consent();

DO $a$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customers
             WHERE coalesce(trim(email_cache),'') <> '' AND email_marketing_opt_out_at IS NULL
               AND email_marketing_consent_at IS NULL) THEN
    RAISE EXCEPTION 'unexpected rows with no consent and no opt-out';
  END IF;
END $a$;

-- Tested (rolled back): clearing opt-out on an opted-out customer with no consent sets consent.
-- UNDO:
-- DROP TRIGGER IF EXISTS trg_default_email_marketing_consent ON public.customers;
-- DROP FUNCTION IF EXISTS public.default_email_marketing_consent();
