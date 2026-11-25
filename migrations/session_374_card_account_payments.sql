-- Session 374 — On-account customers can pay by card on file.
-- (Applied to the DB under the migration name session_373_card_account_payments — numbered before we saw s373 was already used by Bookkeeping.)
-- (Institute on Aging-Geary asked to pay their invoice by card.)
--
-- 1. payments.method accepts 'card'.
-- 2. record_account_payment accepts 'card' — but ONLY from the trusted backend
--    (charge-account-payment edge function, service role). A staff member can't
--    "record" a card payment by hand without a real Stripe charge behind it.
-- 3. One payments row per Stripe PaymentIntent (reference) for card payments —
--    a retried request can never record the same charge twice.
-- No new columns, no new tables. Function body rewritten from pg_get_functiondef
-- so signature/defaults/search_path survive byte-for-byte; old def snapshotted.

INSERT INTO _archive._backup_function_defs (saved_at, function_name, definition)
SELECT now(), 'record_account_payment (pre session 373)', pg_get_functiondef('public.record_account_payment(uuid[],numeric,text,text,date,text,text,uuid,uuid)'::regprocedure);

ALTER TABLE public.payments DROP CONSTRAINT payments_method_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check
  CHECK (method = ANY (ARRAY['check'::text, 'ach'::text, 'wire'::text, 'other'::text, 'card'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS payments_card_reference_uniq
  ON public.payments (reference) WHERE method = 'card';

DO $mig$
DECLARE
  v_def  text := pg_get_functiondef('public.record_account_payment(uuid[],numeric,text,text,date,text,text,uuid,uuid)'::regprocedure);
  v_old  text := $o$  IF p_method IS NULL OR p_method NOT IN ('check','ach','wire','other') THEN
    RAISE EXCEPTION 'p_method must be one of check, ach, wire, other' USING ERRCODE = 'invalid_parameter_value';
  END IF;$o$;
  v_new  text := $n$  IF p_method IS NULL OR p_method NOT IN ('check','ach','wire','other','card') THEN
    RAISE EXCEPTION 'p_method must be one of check, ach, wire, other, card' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Session 373: a 'card' payment must have a real Stripe charge behind it, so only
  -- the charge-account-payment edge function (service role, auth.uid() NULL) may record one.
  IF p_method = 'card' AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'Card payments are recorded by the card charge itself, not by hand' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_method = 'card' AND NULLIF(trim(p_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Card payments need the Stripe payment id as reference' USING ERRCODE = 'invalid_parameter_value';
  END IF;$n$;
BEGIN
  IF strpos(v_def, v_old) = 0 THEN
    RAISE EXCEPTION 'record_account_payment body not in the expected shape — aborting';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF strpos(pg_get_functiondef('public.record_account_payment(uuid[],numeric,text,text,date,text,text,uuid,uuid)'::regprocedure),
            $c$p_method = 'card' AND auth.uid() IS NOT NULL$c$) = 0 THEN
    RAISE EXCEPTION 'rewrite did not land';
  END IF;
END
$mig$;

-- Rollback:
--   DROP INDEX public.payments_card_reference_uniq;
--   (only if no card rows exist) ALTER TABLE payments DROP CONSTRAINT payments_method_check;
--     ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (method = ANY (ARRAY['check','ach','wire','other']));
--   Re-run the definition saved in _archive._backup_function_defs
--     WHERE function_name = 'record_account_payment (pre session 373)'.
