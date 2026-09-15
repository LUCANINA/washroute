-- Session 294 (audit 2026-09-15): stop self-service sign-ups from creating a
-- second account for a returning customer.
--
-- claim_existing_customer only matches on contact details the caller has PROVEN
-- (session 290 hardening). A returning customer who signs in with a new phone
-- number therefore gets "no match", and the customer app used to insert a fresh,
-- empty account carrying her old email (Katie Steele, 2026-09-15 15:28 UTC).
--
-- Rule: a customer-role insert (not staff, not service role) is refused when its
-- email (case/space-insensitive) or phone (last 10 digits) already belongs to
-- another customer. The app shows "please call us" (customer-app
-- _insertNewCustomer, error hint 'duplicate_contact'). Staff can still create
-- shared-phone accounts (shelters, households) from the admin dashboard.

CREATE OR REPLACE FUNCTION public.block_duplicate_customer_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_email  text := nullif(lower(btrim(coalesce(NEW.email_cache, ''))), '');
  v_digits text := right(regexp_replace(coalesce(NEW.phone_cache, ''), $r$\D$r$, '', 'g'), 10);
  v_hit    uuid;
BEGIN
  -- service role, cron, imports, SQL console: no JWT user -> allowed
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- staff (admin dashboard, POS, drivers) -> allowed
  IF public.is_staff() THEN RETURN NEW; END IF;

  IF length(v_digits) < 10 THEN v_digits := NULL; END IF;
  IF v_email IS NULL AND v_digits IS NULL THEN RETURN NEW; END IF;

  SELECT c.id INTO v_hit
  FROM customers c
  WHERE c.id <> NEW.id
    AND c.profile_id IS DISTINCT FROM NEW.profile_id
    AND (
         (v_email  IS NOT NULL AND lower(btrim(c.email_cache)) = v_email)
      OR (v_digits IS NOT NULL AND right(regexp_replace(coalesce(c.phone_cache, ''), $r$\D$r$, '', 'g'), 10) = v_digits)
    )
  LIMIT 1;

  IF v_hit IS NOT NULL THEN
    RAISE EXCEPTION 'DUPLICATE_CONTACT: an account with this email or phone already exists'
      USING ERRCODE = 'P0001', HINT = 'duplicate_contact';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.block_duplicate_customer_signup() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.block_duplicate_customer_signup() FROM anon;

DROP TRIGGER IF EXISTS trg_block_duplicate_customer_signup ON public.customers;
CREATE TRIGGER trg_block_duplicate_customer_signup
  BEFORE INSERT ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.block_duplicate_customer_signup();

-- Assert the regex survived quoting (session 227 trap)
DO $a$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname = 'block_duplicate_customer_signup'), $n$\D$n$) = 0 THEN
    RAISE EXCEPTION 'regex escaping broken in block_duplicate_customer_signup';
  END IF;
END
$a$;

-- Rollback:
--   DROP TRIGGER IF EXISTS trg_block_duplicate_customer_signup ON public.customers;
--   DROP FUNCTION IF EXISTS public.block_duplicate_customer_signup();

-- ── session_294b (applied same day): the exception message now names which
-- contact matched — 'DUPLICATE_CONTACT:email', ':phone' or ':email,phone' — so the
-- customer app can offer the right self-serve recovery (email sign-in link or SMS
-- code) instead of "please call us". Body identical otherwise; see
-- pg_get_functiondef('public.block_duplicate_customer_signup'::regproc).
