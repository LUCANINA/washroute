-- ═══════════════════════════════════════════════════════════════════════════
-- Session 355 — Free rewash orders
-- David (Oct 21, 2026): when a customer complains about stains/smells we offer a
-- free rewash. Until now the rewash was an ordinary order: launderers couldn't
-- tell, and it was charged like any other order.
--
-- Decisions (David): staff-only creation · whole-order (general note is enough)
-- · pickup + delivery free · must be requested within 14 days of delivery.
--
-- What this does:
--   1. orders.is_rewash / rewash_of_order_id / rewash_reason / rewash_note
--   2. trg_zzz_rewash_is_free — the LAST before-trigger on orders. A rewash row is
--      always $0 (no tip, tax, discount, plan, recurrence), born billing_status
--      'paid' / method 'rewash'. Only admin/manager/laundry_tech (or service
--      role) may insert one. Because it is 'paid', charge-order refuses it
--      (L183), the 5-min auto-charge sweep skips it, rack_order takes the
--      already_charged branch, and trg_referral_on_paid never fires (it is
--      UPDATE-of-billing_status only).
--   3. Guards injected into existing functions (bodies rewritten from
--      pg_get_functiondef, snapshots in _archive first):
--        link_subscription_on_order_fn   — never attach a plan to a rewash
--        apply_subscription_usage_fn     — never use plan pounds
--        trg_create_recurring_order_fn   — never seed a recurring chain
--        update_customer_last_order_at   — a rewash is not a new order (churn stats)
--        apply_customer_credit_to_order  — never spend a customer's credit
--        enforce_protected_order_columns — customers/drivers can't set the flags
--   4. create_rewash_order() RPC — the single door. Enforces delivered-within-14-days
--      and one open rewash per original; logs order_events on both orders.
-- Rollback: session_355_ROLLBACK.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 0. Snapshot every function we touch (the rollback source).
CREATE TABLE IF NOT EXISTS _archive.fn_rewash_355_20261021 (
  proname text PRIMARY KEY, def text NOT NULL, saved_at timestamptz DEFAULT now());
INSERT INTO _archive.fn_rewash_355_20261021 (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid)
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN ('link_subscription_on_order_fn','apply_subscription_usage_fn',
                     'trg_create_recurring_order_fn','update_customer_last_order_at',
                     'apply_customer_credit_to_order','enforce_protected_order_columns')
ON CONFLICT (proname) DO NOTHING;

-- 1. Columns.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_rewash          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rewash_of_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rewash_reason      text,
  ADD COLUMN IF NOT EXISTS rewash_note        text;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_rewash_reason_check
    CHECK (rewash_reason IS NULL OR rewash_reason IN ('stain','smell','damage','other')),
  ADD CONSTRAINT orders_rewash_needs_reason
    CHECK (NOT is_rewash OR rewash_reason IS NOT NULL);

CREATE INDEX IF NOT EXISTS orders_rewash_of_order_id_idx
  ON public.orders (rewash_of_order_id) WHERE rewash_of_order_id IS NOT NULL;

COMMENT ON COLUMN public.orders.is_rewash IS
  'Session 355: free rewash of a delivered order. Always $0, born paid (method rewash). Set only via create_rewash_order().';

-- 2. The free-rewash enforcer (runs last of the BEFORE triggers: trg_zzz_ > trg_zz_).
CREATE OR REPLACE FUNCTION public.enforce_rewash_is_free()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claims text;
  v_orig_no bigint;
BEGIN
  IF NOT COALESCE(NEW.is_rewash, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    v_claims := current_setting('request.jwt.claims', true);
    IF NOT (v_claims IS NULL OR v_claims = ''
            OR COALESCE(auth.role(), '') = 'service_role'
            OR public.is_admin()) THEN
      RAISE EXCEPTION 'Only staff can create a rewash order'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT order_number INTO v_orig_no FROM orders WHERE id = NEW.rewash_of_order_id;

  NEW.total_amount   := 0;
  NEW.tip_amount     := 0;
  NEW.tax_amount     := 0;
  NEW.discount_id    := NULL;
  NEW.subscription_id       := NULL;
  NEW.is_subscription_order := false;
  NEW.recurring_interval           := NULL;
  NEW.recurring_anchor_at          := NULL;
  NEW.recurring_delivery_anchor_at := NULL;
  NEW.line_items := jsonb_build_array(jsonb_build_object(
    'type', 'base',
    'label', 'Rewash'
             || CASE WHEN v_orig_no IS NOT NULL THEN ' of order #' || v_orig_no ELSE '' END
             || CASE WHEN COALESCE(NEW.weight_lbs, 0) > 0
                     THEN ' · ' || trim(to_char(NEW.weight_lbs, 'FM999990.##')) || ' lbs' ELSE '' END
             || ' — no charge',
    'amount', 0,
    'taxable', false));

  IF COALESCE(NEW.billing_status, '') NOT IN ('paid','refunded','written_off') THEN
    NEW.billing_status := 'paid';
  END IF;
  NEW.billing_payment_method := 'rewash';
  NEW.billed_at     := COALESCE(NEW.billed_at, now());
  NEW.billing_notes := COALESCE(NEW.billing_notes, 'Free rewash — no charge');
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.enforce_rewash_is_free() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_rewash_is_free() FROM anon;

DROP TRIGGER IF EXISTS trg_zzz_rewash_is_free ON public.orders;
CREATE TRIGGER trg_zzz_rewash_is_free
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rewash_is_free();

-- 3. Guards in existing functions (rewritten from their live definitions).
DO $do$
DECLARE
  r      record;
  v_def  text;
  v_pos  int;
  v_guard text;
  v_trig_guard CONSTANT text := $g$
BEGIN
  -- Session 355: a free rewash never touches plans, recurrence or order counts.
  IF COALESCE(NEW.is_rewash, false) THEN
    RETURN NEW;
  END IF;
$g$;
  v_link_guard CONSTANT text := $g$
BEGIN
  -- Session 355: a free rewash is never attached to a subscription plan.
  IF COALESCE(NEW.is_rewash, false) THEN
    NEW.subscription_id := NULL;
    NEW.is_subscription_order := false;
    RETURN NEW;
  END IF;
$g$;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('link_subscription_on_order_fn','apply_subscription_usage_fn',
                         'trg_create_recurring_order_fn','update_customer_last_order_at')
  LOOP
    v_guard := CASE WHEN r.proname = 'link_subscription_on_order_fn' THEN v_link_guard ELSE v_trig_guard END;
    v_pos := position(E'\nBEGIN\n' IN r.def);
    IF v_pos = 0 THEN RAISE EXCEPTION 'no top-level BEGIN in %', r.proname; END IF;
    v_def := overlay(r.def PLACING E'\n' || ltrim(v_guard, E'\n') FROM v_pos FOR length(E'\nBEGIN\n'));
    EXECUTE v_def;
  END LOOP;

  -- apply_customer_credit_to_order: no-op for a rewash, AFTER the staff check.
  SELECT pg_get_functiondef('public.apply_customer_credit_to_order'::regproc) INTO v_def;
  IF strpos(v_def, $s$PERFORM public.assert_staff('apply_customer_credit_to_order');$s$) = 0 THEN
    RAISE EXCEPTION 'apply_customer_credit_to_order: assert_staff anchor not found';
  END IF;
  v_def := replace(v_def,
    $s$PERFORM public.assert_staff('apply_customer_credit_to_order');$s$,
    $s$PERFORM public.assert_staff('apply_customer_credit_to_order');
  -- Session 355: a free rewash never spends the customer's credit.
  IF p_order_id IS NOT NULL AND EXISTS (SELECT 1 FROM orders WHERE id = p_order_id AND is_rewash) THEN
    RETURN QUERY SELECT COALESCE((SELECT credits FROM customers WHERE id = p_customer_id), 0)::numeric, 0::numeric;
    RETURN;
  END IF;$s$);
  EXECUTE v_def;

  -- enforce_protected_order_columns: add the rewash columns to the deny-list.
  SELECT pg_get_functiondef('public.enforce_protected_order_columns'::regproc) INTO v_def;
  IF strpos(v_def, $s$'processed_site_id',$s$) = 0 THEN
    RAISE EXCEPTION 'enforce_protected_order_columns: anchor not found';
  END IF;
  v_def := replace(v_def, $s$'processed_site_id',$s$,
                          $s$'processed_site_id',
    'is_rewash','rewash_of_order_id','rewash_reason','rewash_note',$s$);
  EXECUTE v_def;
END
$do$;

-- 4. The one door: create_rewash_order().
CREATE OR REPLACE FUNCTION public.create_rewash_order(
  p_original_order_id     uuid,
  p_reason                text,
  p_note                  text,
  p_total_bags            integer,
  p_address_id            uuid,
  p_pickup_window_start   timestamptz,
  p_pickup_window_end     timestamptz,
  p_delivery_window_start timestamptz DEFAULT NULL,
  p_delivery_window_end   timestamptz DEFAULT NULL,
  p_zone_id               uuid DEFAULT NULL,
  p_pickup_run_id         uuid DEFAULT NULL,
  p_delivery_run_id       uuid DEFAULT NULL,
  p_special_instructions  text DEFAULT NULL,
  p_actor_name            text DEFAULT 'Admin'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_orig      orders%ROWTYPE;
  v_delivered timestamptz;
  v_open_no   bigint;
  v_new_id    uuid;
  v_new_no    bigint;
  v_reason_label text;
BEGIN
  IF NOT (COALESCE(auth.role(), '') = 'service_role' OR public.is_admin()) THEN
    RAISE EXCEPTION 'Only staff can create a rewash' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_original_order_id IS NULL THEN RAISE EXCEPTION 'Original order is required'; END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('stain','smell','damage','other') THEN
    RAISE EXCEPTION 'Pick a reason for the rewash (stain, smell, damage or other)';
  END IF;
  IF p_pickup_window_start IS NULL OR p_pickup_window_end IS NULL THEN
    RAISE EXCEPTION 'Please select a pickup slot';
  END IF;

  SELECT * INTO v_orig FROM orders WHERE id = p_original_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Original order not found'; END IF;
  IF v_orig.status <> 'delivered' THEN
    RAISE EXCEPTION 'Order #% is not delivered yet — only delivered orders can be rewashed', v_orig.order_number;
  END IF;

  v_delivered := COALESCE(v_orig.actual_delivery_at, v_orig.delivery_window_end, v_orig.updated_at);
  IF v_delivered < now() - interval '14 days' THEN
    RAISE EXCEPTION 'Order #% was delivered on % — rewashes must be requested within 14 days of delivery',
      v_orig.order_number, to_char(v_delivered AT TIME ZONE 'America/Los_Angeles', 'Mon FMDD');
  END IF;

  SELECT order_number INTO v_open_no FROM orders
   WHERE rewash_of_order_id = p_original_order_id
     AND status NOT IN ('delivered','cancelled','skipped','pickup_failed')
   LIMIT 1;
  IF v_open_no IS NOT NULL THEN
    RAISE EXCEPTION 'Order #% already has an open rewash (#%)', v_orig.order_number, v_open_no;
  END IF;

  INSERT INTO orders (
    customer_id, service_id, status, source,
    total_bags, total_amount, tax_amount, tip_amount,
    pickup_address_id, delivery_address_id,
    pickup_window_start, pickup_window_end,
    delivery_window_start, delivery_window_end,
    pickup_run_id, delivery_run_id, zone_id,
    special_instructions, line_items,
    is_rewash, rewash_of_order_id, rewash_reason, rewash_note,
    billing_status, billing_payment_method, billed_at, billing_notes
  ) VALUES (
    v_orig.customer_id, v_orig.service_id, 'scheduled', 'scheduled',
    GREATEST(COALESCE(p_total_bags, v_orig.total_bags, 1), 1), 0, 0, 0,
    COALESCE(p_address_id, v_orig.pickup_address_id),
    COALESCE(p_address_id, v_orig.delivery_address_id, v_orig.pickup_address_id),
    p_pickup_window_start, p_pickup_window_end,
    p_delivery_window_start, p_delivery_window_end,
    p_pickup_run_id, p_delivery_run_id, COALESCE(p_zone_id, v_orig.zone_id),
    COALESCE(NULLIF(trim(p_special_instructions), ''), v_orig.special_instructions), '[]'::jsonb,
    true, p_original_order_id, p_reason, NULLIF(trim(p_note), ''),
    'paid', 'rewash', now(), 'Free rewash of order #' || v_orig.order_number
  ) RETURNING id, order_number INTO v_new_id, v_new_no;

  v_reason_label := initcap(p_reason) || COALESCE(' — ' || NULLIF(trim(p_note), ''), '');

  INSERT INTO order_events (order_id, event_type, description, actor_name)
  VALUES (v_new_id, 'rewash_created',
          'Free rewash of order #' || v_orig.order_number || ': ' || v_reason_label,
          COALESCE(p_actor_name, 'Admin')),
         (p_original_order_id, 'rewash_created',
          'Rewash order #' || v_new_no || ' created: ' || v_reason_label,
          COALESCE(p_actor_name, 'Admin'));

  RETURN jsonb_build_object('order_id', v_new_id, 'order_number', v_new_no,
                            'original_order_number', v_orig.order_number);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.create_rewash_order(uuid,text,text,integer,uuid,timestamptz,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_rewash_order(uuid,text,text,integer,uuid,timestamptz,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.create_rewash_order(uuid,text,text,integer,uuid,timestamptz,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text) TO authenticated, service_role;

-- 5. Assert every guard landed (any failure rolls the whole migration back).
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT proname, prosrc FROM pg_proc
            WHERE pronamespace = 'public'::regnamespace
              AND proname IN ('link_subscription_on_order_fn','apply_subscription_usage_fn',
                              'trg_create_recurring_order_fn','update_customer_last_order_at',
                              'apply_customer_credit_to_order')
  LOOP
    IF strpos(r.prosrc, 'Session 355') = 0 THEN RAISE EXCEPTION 'guard missing in %', r.proname; END IF;
  END LOOP;
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname = 'enforce_protected_order_columns'
              AND pronamespace = 'public'::regnamespace), $s$'is_rewash'$s$) = 0 THEN
    RAISE EXCEPTION 'is_rewash not protected';
  END IF;
END
$do$;
