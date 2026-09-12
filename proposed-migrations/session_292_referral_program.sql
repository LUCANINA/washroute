-- session 292 — referral program, database layer
--
-- APPLIED 2026-09-11 in four parts:
--   292a  settings.referral_config, referral_codes, referrals, RLS, helpers
--   292c1 grant lock-down (see the note below — this one caught a real hole)
--   292c  qualify_referral, the payment trigger, staff RPCs, function grants
-- Verified by tests/referral-loop-test.sql: 12 checks, all passing, all rolled back.
--
-- 292c1 exists because the first apply's own assert failed. The public schema
-- still carries default privileges that auto-grant anon and authenticated ALL on
-- any new table (that default flips 2026-10-30), so both referral tables came out
-- of 292a writable by anon, with RLS the only thing in the way. REVOKE ALL, then
-- GRANT SELECT to authenticated only. Worth remembering for every new table
-- until the platform default changes.
--
-- Ships the program OFF: settings.referral_config.enabled = false. Nothing is
-- reachable from any app until the UI phase lands and the switch is flipped.
--
-- Shape:
--   referral_codes   one code per customer
--   referrals        one row per pair, amounts snapshotted at claim time
--   settings.referral_config   editable terms (jsonb, same pattern as invoice_config)
--   claim_referral_code()      friend enters a code        (customer-callable)
--   get_or_create_referral_code()  referrer opens the card (customer-callable)
--   referral_code_preview()    /r/CODE landing page        (anon-callable, name only)
--   qualify_referral()         fired by trigger on payment (postgres/service_role only)
--   release_referral()         staff releases flagged / commercial pairs
--   void_referral()            staff voids a pair
--   set_referral_config()      admin + manager edit the terms
--   trg_referral_on_paid       AFTER UPDATE on orders, billing_status -> 'paid'
--
-- Why a trigger instead of editing charge-order: the trigger catches every path
-- that marks an order paid (Stripe, credits-only, POS, admin mark-paid), needs no
-- edge-function deploy, and cannot get the verify_jwt flag wrong. It is wrapped in
-- an exception handler so a referral bug can never block a payment from being
-- recorded — failures land in _health_alerts instead.

-- ─────────────────────────────────────────────────────────── config

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS referral_config jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.settings SET referral_config = jsonb_build_object(
  'enabled',              false,
  'friend_credit',        25,
  'referrer_credit',      25,
  'qualify_on',           'paid',
  'monthly_cap',          10,
  'credit_expires_days',  null,
  'friend_reminder_days', 7,
  'card_surfaces',        jsonb_build_array('account'),
  'commercial_can_refer', true,
  'share_message',        'I use Family Laundry for pickup & delivery — they pick up at the door and bring it back folded. Use my code {{code}} for $25 off your first order: {{link}}'
) WHERE id = 1 AND COALESCE(referral_config, '{}'::jsonb) = '{}'::jsonb;

COMMENT ON COLUMN public.settings.referral_config IS
  'Referral program terms, edited via set_referral_config(). qualify_on is ''paid'' only in v1.';

-- ─────────────────────────────────────────────────────────── tables

CREATE TABLE IF NOT EXISTS public.referral_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL UNIQUE REFERENCES public.customers(id) ON DELETE CASCADE,
  code         text NOT NULL UNIQUE CHECK (code = upper(code) AND length(code) BETWEEN 4 AND 24),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.referrals (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL,
  referrer_customer_id     uuid NOT NULL REFERENCES public.customers(id),
  referred_customer_id     uuid NOT NULL UNIQUE REFERENCES public.customers(id),
  status                   text NOT NULL DEFAULT 'claimed'
                             CHECK (status IN ('claimed','qualified','awaiting_release','flagged','void')),
  claimed_at               timestamptz NOT NULL DEFAULT now(),
  qualifying_order_id      uuid REFERENCES public.orders(id),
  qualified_at             timestamptz,
  referred_credit_amount   numeric(10,2) NOT NULL,
  referrer_credit_amount   numeric(10,2) NOT NULL,
  referred_credit_method   text,
  referrer_credit_method   text,
  hold_reason              text,
  void_reason              text,
  released_by              text,
  referrer_notified_at     timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_customer_id <> referred_customer_id)
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON public.referrals(referrer_customer_id);
CREATE INDEX IF NOT EXISTS referrals_status_idx   ON public.referrals(status);
CREATE INDEX IF NOT EXISTS referrals_order_idx    ON public.referrals(qualifying_order_id);

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals      ENABLE ROW LEVEL SECURITY;

-- Reads only. Every write goes through a guarded SECURITY DEFINER function.
REVOKE ALL  ON public.referral_codes FROM anon, authenticated;
REVOKE ALL  ON public.referrals      FROM anon, authenticated;
GRANT SELECT ON public.referral_codes TO authenticated;
GRANT SELECT ON public.referrals      TO authenticated;

DROP POLICY IF EXISTS referral_codes_read ON public.referral_codes;
CREATE POLICY referral_codes_read ON public.referral_codes FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR EXISTS (SELECT 1 FROM public.customers c
               WHERE c.id = referral_codes.customer_id AND c.profile_id = auth.uid())
  );

DROP POLICY IF EXISTS referrals_read ON public.referrals;
CREATE POLICY referrals_read ON public.referrals FOR SELECT TO authenticated
  USING (
    public.is_staff()
    OR EXISTS (SELECT 1 FROM public.customers c
               WHERE c.id = referrals.referrer_customer_id AND c.profile_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────── helpers

CREATE OR REPLACE FUNCTION public.referral_config()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT jsonb_build_object(
    'enabled', false, 'friend_credit', 25, 'referrer_credit', 25,
    'qualify_on', 'paid', 'monthly_cap', 10, 'credit_expires_days', null,
    'friend_reminder_days', 7, 'card_surfaces', jsonb_build_array('account'),
    'commercial_can_refer', true, 'share_message', ''
  ) || COALESCE((SELECT referral_config FROM public.settings WHERE id = 1), '{}'::jsonb);
$$;

-- Digits only, last 10, for comparing two phone numbers written differently.
CREATE OR REPLACE FUNCTION public.referral_phone_key(p_phone text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT NULLIF(right(regexp_replace(COALESCE(p_phone, ''), $g$\D$g$, '', 'g'), 10), '');
$$;

-- ─────────────────────────────────────────────────────────── referrer's code

CREATE OR REPLACE FUNCTION public.get_or_create_referral_code(p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_cfg        jsonb := public.referral_config();
  v_caller     uuid  := auth.uid();
  v_cust       RECORD;
  v_code       text;
  v_stem       text;
  v_try        int := 0;
  v_claimed    int;
  v_qualified  int;
  v_earned     numeric;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No customer specified.');
  END IF;
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'You must be signed in.');
  END IF;

  SELECT id, profile_id, first_name_cache, billing_type
    INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF v_cust.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Customer not found.');
  END IF;
  IF v_cust.profile_id IS DISTINCT FROM v_caller AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Not authorized.');
  END IF;

  IF v_cust.billing_type = 'on_account'
     AND COALESCE((v_cfg->>'commercial_can_refer')::boolean, true) = false THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Referrals are not available on commercial accounts.');
  END IF;

  SELECT code INTO v_code FROM public.referral_codes WHERE customer_id = p_customer_id;

  IF v_code IS NULL THEN
    v_stem := upper(regexp_replace(COALESCE(v_cust.first_name_cache, ''), '[^A-Za-z]', '', 'g'));
    v_stem := left(NULLIF(v_stem, ''), 10);
    IF v_stem IS NULL OR length(v_stem) < 2 THEN v_stem := 'WASH'; END IF;

    LOOP
      v_try := v_try + 1;
      v_code := v_stem || lpad((floor(random() * 900) + 100)::int::text, 3, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.referral_codes WHERE code = v_code);
      IF v_try >= 25 THEN
        RETURN jsonb_build_object('ok', false, 'message', 'Could not allocate a code. Try again.');
      END IF;
    END LOOP;

    -- DO NOTHING, then re-read: if two tabs raced, the first code wins.
    INSERT INTO public.referral_codes (customer_id, code) VALUES (p_customer_id, v_code)
    ON CONFLICT (customer_id) DO NOTHING;
    SELECT code INTO v_code FROM public.referral_codes WHERE customer_id = p_customer_id;
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('claimed','flagged','awaiting_release')),
         count(*) FILTER (WHERE status = 'qualified'),
         COALESCE(sum(referrer_credit_amount) FILTER (WHERE status = 'qualified'), 0)
    INTO v_claimed, v_qualified, v_earned
    FROM public.referrals WHERE referrer_customer_id = p_customer_id;

  RETURN jsonb_build_object(
    'ok', true,
    'enabled',         COALESCE((v_cfg->>'enabled')::boolean, false),
    'code',            v_code,
    'link',            'https://app.familylaundry.com/r/' || v_code,
    'friend_credit',   (v_cfg->>'friend_credit')::numeric,
    'referrer_credit', (v_cfg->>'referrer_credit')::numeric,
    'share_message',   replace(replace(COALESCE(v_cfg->>'share_message', ''),
                         '{{code}}', v_code),
                         '{{link}}', 'https://app.familylaundry.com/r/' || v_code),
    'invited',         v_claimed,
    'qualified',       v_qualified,
    'credit_earned',   v_earned
  );
END;
$$;

-- ─────────────────────────────────────────────────────────── landing page

CREATE OR REPLACE FUNCTION public.referral_code_preview(p_code text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_cfg  jsonb := public.referral_config();
  v_name text;
BEGIN
  IF COALESCE((v_cfg->>'enabled')::boolean, false) = false THEN
    RETURN jsonb_build_object('valid', false);
  END IF;

  SELECT NULLIF(TRIM(c.first_name_cache), '')
    INTO v_name
    FROM public.referral_codes rc
    JOIN public.customers c ON c.id = rc.customer_id
   WHERE rc.code = upper(TRIM(COALESCE(p_code, ''))) AND rc.active;

  IF NOT FOUND THEN RETURN jsonb_build_object('valid', false); END IF;

  RETURN jsonb_build_object(
    'valid', true,
    'referrer_first_name', COALESCE(v_name, 'A neighbor'),
    'friend_credit', (v_cfg->>'friend_credit')::numeric
  );
END;
$$;

-- ─────────────────────────────────────────────────────────── claim

CREATE OR REPLACE FUNCTION public.claim_referral_code(p_code text, p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_cfg      jsonb := public.referral_config();
  v_caller   uuid  := auth.uid();
  v_code     text  := upper(TRIM(COALESCE(p_code, '')));
  v_friend   RECORD;
  v_referrer RECORD;
  v_amt      numeric := (v_cfg->>'friend_credit')::numeric;
  v_exp_days int     := NULLIF(v_cfg->>'credit_expires_days', '')::int;
  v_status   text    := 'claimed';
  v_method   text    := 'credits';
  v_hold     text;
BEGIN
  PERFORM public.wr_allow_protected_write();

  IF COALESCE((v_cfg->>'enabled')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'disabled',
      'message', 'Referral codes are not active right now.');
  END IF;
  IF v_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_code', 'message', 'Please enter a code.');
  END IF;
  IF p_customer_id IS NULL OR v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated', 'message', 'You must be signed in.');
  END IF;

  SELECT id, profile_id, phone_cache, billing_type
    INTO v_friend FROM public.customers WHERE id = p_customer_id;
  IF v_friend.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'customer_not_found', 'message', 'Customer not found.');
  END IF;
  IF v_friend.profile_id IS DISTINCT FROM v_caller AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Not authorized.');
  END IF;

  SELECT c.id, c.phone_cache, c.profile_id, c.billing_type, rc.active
    INTO v_referrer
    FROM public.referral_codes rc
    JOIN public.customers c ON c.id = rc.customer_id
   WHERE rc.code = v_code;

  IF v_referrer.id IS NULL OR v_referrer.active = false THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_code',
      'message', 'That code isn''t valid.');
  END IF;

  -- Self-referral: same customer, same login, or same phone number.
  IF v_referrer.id = v_friend.id
     OR (v_referrer.profile_id IS NOT NULL AND v_referrer.profile_id = v_friend.profile_id)
     OR (public.referral_phone_key(v_referrer.phone_cache) IS NOT NULL
         AND public.referral_phone_key(v_referrer.phone_cache) = public.referral_phone_key(v_friend.phone_cache)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self_referral',
      'message', 'A referral code can''t be used on your own account.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.referrals WHERE referred_customer_id = v_friend.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_referred',
      'message', 'A referral code has already been used on this account.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.orders
              WHERE customer_id = v_friend.id AND billing_status = 'paid') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_new',
      'message', 'Referral codes are for a first order only.');
  END IF;

  -- Commercial accounts are invoiced, so their credit is applied by hand.
  IF v_friend.billing_type = 'on_account' THEN
    v_status := 'awaiting_release';
    v_method := 'invoice_adjustment';
    v_hold   := 'Referred account is on invoice terms — apply both credits by hand.';
    v_amt    := (v_cfg->>'friend_credit')::numeric;
  END IF;

  INSERT INTO public.referrals (
    code, referrer_customer_id, referred_customer_id, status,
    referred_credit_amount, referrer_credit_amount,
    referred_credit_method, referrer_credit_method, hold_reason
  ) VALUES (
    v_code, v_referrer.id, v_friend.id, v_status,
    (v_cfg->>'friend_credit')::numeric, (v_cfg->>'referrer_credit')::numeric,
    v_method,
    CASE WHEN v_referrer.billing_type = 'on_account' THEN 'invoice_adjustment' ELSE 'credits' END,
    v_hold
  );

  IF v_method = 'credits' THEN
    UPDATE public.customers
       SET credits = COALESCE(credits, 0) + v_amt,
           credit_expires_at = CASE
             WHEN v_exp_days IS NULL THEN credit_expires_at
             ELSE GREATEST(COALESCE(credit_expires_at, now()), now() + make_interval(days => v_exp_days))
           END,
           updated_at = now()
     WHERE id = v_friend.id;

    INSERT INTO public.customer_transactions (customer_id, type, amount, description, note)
    VALUES (v_friend.id, 'credit_add', v_amt, 'Referral credit — welcome to Family Laundry',
            'Referral code ' || v_code);

    RETURN jsonb_build_object('ok', true, 'credit', v_amt,
      'message', '$' || to_char(v_amt, 'FM999990.00') || ' credit added — it comes off your first order.');
  END IF;

  RETURN jsonb_build_object('ok', true, 'credit', 0,
    'message', 'Code accepted. Because this account is billed by invoice, we''ll apply the credit to your next one.');
END;
$$;

-- ─────────────────────────────────────────────────────────── qualify

CREATE OR REPLACE FUNCTION public.qualify_referral(p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_cfg       jsonb := public.referral_config();
  v_order     RECORD;
  v_ref       RECORD;
  v_referrer  RECORD;
  v_cap       int := COALESCE((v_cfg->>'monthly_cap')::int, 10);
  v_recent    int;
  v_exp_days  int := NULLIF(v_cfg->>'credit_expires_days', '')::int;
  v_amt       numeric;
BEGIN
  IF p_order_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_order'); END IF;

  SELECT id, customer_id, billing_status, billed_at
    INTO v_order FROM public.orders WHERE id = p_order_id;
  IF v_order.id IS NULL OR v_order.billing_status <> 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_paid');
  END IF;

  SELECT * INTO v_ref FROM public.referrals
   WHERE referred_customer_id = v_order.customer_id AND status = 'claimed'
   FOR UPDATE;
  IF v_ref.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_open_referral'); END IF;

  -- Must be the referred customer's FIRST paid order.
  IF EXISTS (SELECT 1 FROM public.orders o
              WHERE o.customer_id = v_order.customer_id
                AND o.billing_status = 'paid'
                AND o.id <> v_order.id
                AND COALESCE(o.billed_at, o.created_at) < COALESCE(v_order.billed_at, now())) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_first_order');
  END IF;

  SELECT id, billing_type INTO v_referrer FROM public.customers WHERE id = v_ref.referrer_customer_id;
  v_amt := v_ref.referrer_credit_amount;

  SELECT count(*) INTO v_recent FROM public.referrals
   WHERE referrer_customer_id = v_ref.referrer_customer_id
     AND status = 'qualified'
     AND qualified_at > now() - interval '30 days';

  IF v_recent >= v_cap THEN
    UPDATE public.referrals
       SET status = 'flagged', qualifying_order_id = v_order.id,
           hold_reason = format('Over the %s-per-30-days cap — release by hand.', v_cap)
     WHERE id = v_ref.id;
    RETURN jsonb_build_object('ok', true, 'status', 'flagged');
  END IF;

  IF v_referrer.billing_type = 'on_account' THEN
    UPDATE public.referrals
       SET status = 'awaiting_release', qualifying_order_id = v_order.id,
           hold_reason = 'Referrer is on invoice terms — credit goes on their next invoice.'
     WHERE id = v_ref.id;
    RETURN jsonb_build_object('ok', true, 'status', 'awaiting_release');
  END IF;

  UPDATE public.customers
     SET credits = COALESCE(credits, 0) + v_amt,
         credit_expires_at = CASE
           WHEN v_exp_days IS NULL THEN credit_expires_at
           ELSE GREATEST(COALESCE(credit_expires_at, now()), now() + make_interval(days => v_exp_days))
         END,
         updated_at = now()
   WHERE id = v_ref.referrer_customer_id;

  INSERT INTO public.customer_transactions (customer_id, type, amount, description, order_id, note)
  VALUES (v_ref.referrer_customer_id, 'credit_add', v_amt,
          'Referral credit — thank you for the introduction', v_order.id,
          'Referral code ' || v_ref.code);

  UPDATE public.referrals
     SET status = 'qualified', qualified_at = now(), qualifying_order_id = v_order.id,
         referrer_credit_method = 'credits'
   WHERE id = v_ref.id;

  RETURN jsonb_build_object('ok', true, 'status', 'qualified', 'credit', v_amt);
END;
$$;

-- ─────────────────────────────────────────────────────────── trigger

CREATE OR REPLACE FUNCTION public.trg_referral_on_paid()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF COALESCE((public.referral_config()->>'enabled')::boolean, false) = false THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public.qualify_referral(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- A referral bug must never stop an order being recorded as paid.
    INSERT INTO public._health_alerts (alert_type, severity, message, context)
    VALUES ('referral_qualify_failed', 'warning', SQLERRM,
            jsonb_build_object('order_id', NEW.id, 'sqlstate', SQLSTATE));
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_referral_on_paid ON public.orders;
CREATE TRIGGER trg_referral_on_paid
AFTER UPDATE OF billing_status ON public.orders
FOR EACH ROW
WHEN (NEW.billing_status = 'paid' AND OLD.billing_status IS DISTINCT FROM NEW.billing_status)
EXECUTE FUNCTION public.trg_referral_on_paid();

-- ─────────────────────────────────────────────────────────── staff actions

CREATE OR REPLACE FUNCTION public.release_referral(p_referral_id uuid, p_actor_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_ref  RECORD;
  v_cust RECORD;
  v_actor text;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Only an admin or manager can release a referral.');
  END IF;
  v_actor := COALESCE(NULLIF(TRIM(p_actor_name), ''), v_role);

  SELECT * INTO v_ref FROM public.referrals WHERE id = p_referral_id FOR UPDATE;
  IF v_ref.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Referral not found.');
  END IF;
  IF v_ref.status NOT IN ('flagged','awaiting_release') THEN
    RETURN jsonb_build_object('ok', false, 'message', format('This referral is %s — nothing to release.', v_ref.status));
  END IF;

  SELECT id, billing_type INTO v_cust FROM public.customers WHERE id = v_ref.referrer_customer_id;

  IF v_cust.billing_type = 'on_account' THEN
    PERFORM public.add_invoice_adjustment(
      p_customer_id => v_ref.referrer_customer_id,
      p_label       => 'Referral credit — thank you for the introduction',
      p_amount      => -1 * v_ref.referrer_credit_amount,
      p_reason      => 'Referral ' || v_ref.code,
      p_actor_name  => v_actor);
    UPDATE public.referrals
       SET status = 'qualified', qualified_at = now(), released_by = v_actor,
           referrer_credit_method = 'invoice_adjustment', hold_reason = NULL
     WHERE id = v_ref.id;
    RETURN jsonb_build_object('ok', true, 'message', 'Credit added to their next invoice.');
  END IF;

  UPDATE public.customers
     SET credits = COALESCE(credits, 0) + v_ref.referrer_credit_amount, updated_at = now()
   WHERE id = v_ref.referrer_customer_id;

  INSERT INTO public.customer_transactions (customer_id, type, amount, description, note)
  VALUES (v_ref.referrer_customer_id, 'credit_add', v_ref.referrer_credit_amount,
          'Referral credit — thank you for the introduction',
          'Referral ' || v_ref.code || ' released by ' || v_actor);

  UPDATE public.referrals
     SET status = 'qualified', qualified_at = now(), released_by = v_actor,
         referrer_credit_method = 'credits', hold_reason = NULL
   WHERE id = v_ref.id;

  RETURN jsonb_build_object('ok', true, 'message', 'Credit added to their account.');
END;
$$;

CREATE OR REPLACE FUNCTION public.void_referral(p_referral_id uuid, p_reason text, p_actor_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role text;
  v_ref  RECORD;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Only an admin or manager can void a referral.');
  END IF;
  IF COALESCE(TRIM(p_reason), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Give a reason — it is the only record of why.');
  END IF;

  SELECT * INTO v_ref FROM public.referrals WHERE id = p_referral_id FOR UPDATE;
  IF v_ref.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Referral not found.');
  END IF;
  IF v_ref.status = 'qualified' THEN
    RETURN jsonb_build_object('ok', false,
      'message', 'This one already paid out. Adjust the customer''s credit directly instead.');
  END IF;

  UPDATE public.referrals
     SET status = 'void', void_reason = TRIM(p_reason),
         released_by = COALESCE(NULLIF(TRIM(p_actor_name), ''), v_role)
   WHERE id = v_ref.id;

  RETURN jsonb_build_object('ok', true, 'message', 'Referral voided.');
END;
$$;

-- ─────────────────────────────────────────────────────────── terms editing

CREATE OR REPLACE FUNCTION public.set_referral_config(p_config jsonb, p_actor_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_role  text;
  v_cur   jsonb := public.referral_config();
  v_new   jsonb;
  v_key   text;
  v_allowed text[] := ARRAY['enabled','friend_credit','referrer_credit','qualify_on','monthly_cap',
                            'credit_expires_days','friend_reminder_days','card_surfaces',
                            'commercial_can_refer','share_message'];
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('admin','manager') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Only an admin or manager can change the referral terms.');
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No settings supplied.');
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_config) LOOP
    IF NOT (v_key = ANY(v_allowed)) THEN
      RETURN jsonb_build_object('ok', false, 'message', format('%s is not a referral setting.', v_key));
    END IF;
  END LOOP;

  v_new := v_cur || p_config;

  IF (v_new->>'friend_credit')::numeric < 0 OR (v_new->>'friend_credit')::numeric > 100
     OR (v_new->>'referrer_credit')::numeric < 0 OR (v_new->>'referrer_credit')::numeric > 100 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Credits must be between $0 and $100.');
  END IF;
  IF (v_new->>'qualify_on') <> 'paid' THEN
    RETURN jsonb_build_object('ok', false,
      'message', 'Only "first order delivered and paid" is supported today.');
  END IF;
  IF (v_new->>'monthly_cap')::int < 1 OR (v_new->>'monthly_cap')::int > 500 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'The cap must be between 1 and 500.');
  END IF;

  v_new := v_new || jsonb_build_object(
    'updated_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'updated_by', COALESCE(NULLIF(TRIM(p_actor_name), ''), v_role));

  UPDATE public.settings SET referral_config = v_new, updated_at = now() WHERE id = 1;

  RETURN jsonb_build_object('ok', true, 'config', v_new, 'message', 'Referral terms saved.');
END;
$$;

-- ─────────────────────────────────────────────────────────── grants

REVOKE EXECUTE ON FUNCTION public.referral_config()                         FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_or_create_referral_code(uuid)         FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.claim_referral_code(text, uuid)           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.referral_code_preview(text)               FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.qualify_referral(uuid)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_referral(uuid, text)              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.void_referral(uuid, text, text)           FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_referral_config(jsonb, text)          FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.trg_referral_on_paid()                    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.referral_config()                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_or_create_referral_code(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_referral_code(text, uuid)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.referral_code_preview(text)        TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.qualify_referral(uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION public.release_referral(uuid, text)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_referral(uuid, text, text)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_referral_config(jsonb, text)   TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────── asserts

DO $chk$
DECLARE v_cfg jsonb := public.referral_config();
BEGIN
  IF COALESCE((v_cfg->>'enabled')::boolean, true) <> false THEN
    RAISE EXCEPTION '292: program must ship disabled';
  END IF;
  IF (v_cfg->>'friend_credit')::numeric <> 25 OR (v_cfg->>'referrer_credit')::numeric <> 25 THEN
    RAISE EXCEPTION '292: opening credits should be 25/25';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_referral_on_paid' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '292: payment trigger missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('referrals','referral_codes')
      AND grantee = 'anon'
  ) THEN
    RAISE EXCEPTION '292: anon still has grants on the referral tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('referrals','referral_codes')
      AND grantee = 'authenticated' AND privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION '292: authenticated should have SELECT only on the referral tables';
  END IF;
END
$chk$;
