-- ============================================================================
-- session_227h_internal_call_secret
-- APPLIED 2026-08-22. Regression fix for session 227's edge-function hardening.
--
-- WHAT WENT WRONG: the caller audit behind session 227 grepped the repo — the
-- four apps and the edge functions — for every `fetch('.../functions/v1/<name>')`.
-- It did NOT grep `pg_proc`. Five DB functions call the hardened edge functions
-- over `net.http_post` carrying the ANON key, and began 401-ing the moment those
-- functions were deployed:
--
--   sweep_autocharge_ready_orders  (pg_cron, */5)  -> charge-order
--   flush_notification_queue       (pg_cron, */1)  -> send-order-notification
--   advance_order_status                           -> send-order-notification
--   reschedule_order                               -> send-order-notification
--   apply_signup_promo_credit      (trigger)       -> send-email
--
-- flush_notification_queue is the dangerous one: every picked_up / delivered
-- customer SMS goes through it, and it stamps `sent_at` BEFORE posting — so each
-- 401 permanently burns that notification. Same failure shape as session 194.
--
-- Actual impact this time: NONE. Verified after the fix — the last queued
-- notification was 17:28:59Z, the first hardened deploy was 17:29:44Z, the one
-- inline pickup_failed at 17:29:47Z did send its SMS, and the autocharge sweep
-- is self-healing (it re-selects the same orders every 5 minutes). Confirmed
-- zero pending autocharges and no 401s in net._http_response other than a
-- deliberate wrong-secret probe.
--
-- WHY A SHARED SECRET AND NOT THE SERVICE-ROLE KEY: the DB cannot present the
-- service-role key — it is not stored anywhere reachable from SQL, and the vault
-- is empty. Putting it inline in `cron.job.command` / `pg_proc.prosrc` would also
-- mean the most powerful credential in the project sits in plaintext in two more
-- places. Instead the secret lives in a table only `service_role` can read, and
-- the edge functions read the same row with their own service-role client.
--
-- ⚠️ THE SECRET IS EQUIVALENT TO STAFF AUTHORITY on charge-order, send-email and
-- send-order-notification. `apply_signup_promo_credit` -> send-email in particular
-- resolves to `mode: 'staff'`, i.e. arbitrary-recipient send rights. That is
-- correct for a promo email, but be deliberate about it. Rotate with:
--   UPDATE public.wr_internal_auth
--      SET secret = encode(gen_random_bytes(32),'hex'), rotated_at = now();
-- No redeploy needed — both sides read the row at call time.
--
-- REVERSIBILITY: restore the five function definitions from
-- _archive._backup_defs_session227 and drop the table + wr_internal_secret().
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.wr_internal_auth (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  secret     text NOT NULL,
  rotated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.wr_internal_auth ENABLE ROW LEVEL SECURITY;
-- No policies at all, and no grants: invisible through PostgREST to anon and
-- authenticated. service_role bypasses RLS, which is exactly the access wanted.
REVOKE ALL ON public.wr_internal_auth FROM PUBLIC;
REVOKE ALL ON public.wr_internal_auth FROM anon;
REVOKE ALL ON public.wr_internal_auth FROM authenticated;

INSERT INTO public.wr_internal_auth (id, secret)
VALUES (true, encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.wr_internal_secret()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$ SELECT secret FROM public.wr_internal_auth WHERE id; $fn$;

REVOKE EXECUTE ON FUNCTION public.wr_internal_secret() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.wr_internal_secret() FROM anon;
REVOKE EXECUTE ON FUNCTION public.wr_internal_secret() FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.wr_internal_secret() TO service_role;

INSERT INTO _archive._backup_defs_session227 (proname, identity, def)
SELECT p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('sweep_autocharge_ready_orders','flush_notification_queue',
                    'advance_order_status','reschedule_order','apply_signup_promo_credit');

-- Prepend the internal header to every `headers := jsonb_build_object(` in those
-- five functions. jsonb_build_object is variadic, so adding a leading pair is safe.
DO $do$
DECLARE
  r     record;
  v_def text;
  v_n   int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('sweep_autocharge_ready_orders','flush_notification_queue',
                        'advance_order_status','reschedule_order','apply_signup_promo_credit')
  LOOP
    IF r.prosrc ~ 'wr_internal_secret' THEN
      RAISE NOTICE 'skip (already carries the header): %', r.proname;
      CONTINUE;
    END IF;
    IF r.prosrc !~ 'headers\s*:=\s*jsonb_build_object\(' THEN
      RAISE EXCEPTION 'no headers := jsonb_build_object( found in % — refusing to guess', r.proname;
    END IF;

    v_def := regexp_replace(
      r.def,
      '(headers\s*:=\s*jsonb_build_object\()',
      '\1' || $q$'x-wr-internal', public.wr_internal_secret(), $q$,
      'g'
    );
    EXECUTE v_def;
    v_n := v_n + 1;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('sweep_autocharge_ready_orders','flush_notification_queue',
                        'advance_order_status','reschedule_order','apply_signup_promo_credit')
      AND p.prosrc !~ 'wr_internal_secret'
  ) THEN
    RAISE EXCEPTION 'header injection did not take on every function';
  END IF;

  RAISE NOTICE 'x-wr-internal header added to % function(s)', v_n;
END
$do$;

-- Verified live after applying, via net.http_post + net._http_response:
--   correct secret -> 404 "Order not found"  (auth passed, reached business logic)
--   wrong secret   -> 401 "Missing Authorization header"
