-- Migration: session_141_redeem_discount_code_rpc
-- Purpose: One trusted entry point for every coupon redemption.
--
-- Used by:
--   * customer-app (payment settings entry, booking-flow entry)   → caller = self
--   * admin-dashboard (Apply Promo Code section on Billing tab)   → caller = admin
--
-- Behavior:
--   - Normalizes code (UPPER + TRIM), case-insensitive name match against discounts.name.
--   - Authorizes caller: must be the customer themselves OR a profiles.role='admin'.
--   - $ codes (type='fixed'):
--       * Single-use globally — first redemption wins, second returns 'already_redeemed'.
--       * Adds value to customers.credits.
--       * Logs a 'credit_add' row in customer_transactions (description includes code name).
--       * Logs the redemption in discount_redemptions.
--   - % codes (type='percent'):
--       * One redemption per customer per code — second attempt returns 'already_redeemed'.
--       * "Highest wins" — refuses if customer already has an equal-or-better % discount.
--       * Updates customers.discount_id.
--       * Logs the redemption in discount_redemptions.
--
-- Returns jsonb { ok, error?, message, kind?, value?, ... }.
-- Single transaction; on any failure, all writes roll back.

CREATE OR REPLACE FUNCTION public.redeem_discount_code(
  p_code        TEXT,
  p_customer_id UUID,
  p_order_id    UUID DEFAULT NULL,
  p_actor_name  TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid             UUID := auth.uid();
  v_caller_role            TEXT;
  v_target_profile_id      UUID;
  v_target_credits         NUMERIC;
  v_target_discount_id     UUID;
  v_actor                  TEXT;
  v_normalized_code        TEXT;
  v_discount               RECORD;
  v_existing_redemption    UUID;
  v_current_pct            NUMERIC;
  v_current_name           TEXT;
  v_redemption_id          UUID;
BEGIN
  ---------- 0. Validate inputs ----------
  v_normalized_code := UPPER(TRIM(COALESCE(p_code, '')));
  IF v_normalized_code = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'empty_code',
      'message', 'Please enter a code.');
  END IF;

  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_customer',
      'message', 'No customer specified.');
  END IF;

  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated',
      'message', 'You must be signed in.');
  END IF;

  ---------- 1. Authorize caller ----------
  SELECT role INTO v_caller_role FROM public.profiles WHERE id = v_caller_uid;
  SELECT profile_id, COALESCE(credits, 0), discount_id
    INTO v_target_profile_id, v_target_credits, v_target_discount_id
    FROM public.customers WHERE id = p_customer_id;

  IF v_target_profile_id IS NULL AND v_caller_role <> 'admin' THEN
    -- Customer record exists but has no profile_id — only admin can act on it
    RETURN jsonb_build_object('ok', false, 'error', 'customer_not_found',
      'message', 'Customer not found.');
  END IF;

  IF v_caller_role = 'admin' THEN
    -- Admin acting on behalf of a customer
    v_actor := 'admin:' || COALESCE(NULLIF(TRIM(p_actor_name), ''), 'Admin');
  ELSIF v_caller_uid = v_target_profile_id THEN
    -- Customer redeeming for themselves
    v_actor := 'self';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', 'Not authorized.');
  END IF;

  ---------- 2. Look up + validate the discount ----------
  SELECT id, name, type, value, active, deleted_at
    INTO v_discount
    FROM public.discounts
   WHERE UPPER(name) = v_normalized_code
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'That code doesn''t exist.');
  END IF;

  IF v_discount.active IS NOT TRUE OR v_discount.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'inactive',
      'message', 'This code is no longer valid.');
  END IF;

  IF v_discount.type NOT IN ('fixed','percent') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_type',
      'message', 'This code has an unsupported type.');
  END IF;

  IF p_order_id IS NOT NULL THEN
    PERFORM 1 FROM public.orders WHERE id = p_order_id AND customer_id = p_customer_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'order_mismatch',
        'message', 'Order does not belong to this customer.');
    END IF;
  END IF;

  ---------- 3. Type-specific paths ----------
  IF v_discount.type = 'fixed' THEN
    -- $ code: single-use globally
    SELECT id INTO v_existing_redemption
      FROM public.discount_redemptions
     WHERE discount_id = v_discount.id
       AND discount_type_snapshot = 'fixed'
     LIMIT 1;

    IF v_existing_redemption IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_redeemed',
        'message', 'This code has already been used.');
    END IF;

    -- All-or-nothing: redemption + credit add + ledger entry
    INSERT INTO public.discount_redemptions (
      discount_id, customer_id, order_id, redeemed_by,
      discount_type_snapshot, discount_value_snapshot, discount_name_snapshot
    ) VALUES (
      v_discount.id, p_customer_id, p_order_id, v_actor,
      'fixed', v_discount.value, v_discount.name
    ) RETURNING id INTO v_redemption_id;

    UPDATE public.customers
       SET credits    = COALESCE(credits, 0) + v_discount.value,
           updated_at = now()
     WHERE id = p_customer_id;

    INSERT INTO public.customer_transactions (
      customer_id, type, amount, description, order_id
    ) VALUES (
      p_customer_id,
      'credit_add',
      v_discount.value,
      'Coupon ' || v_discount.name || ' redeemed' ||
        CASE WHEN v_actor LIKE 'admin:%' THEN ' (' || v_actor || ')' ELSE '' END,
      p_order_id
    );

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'fixed',
      'discount_id',   v_discount.id,
      'discount_name', v_discount.name,
      'value',         v_discount.value,
      'redemption_id', v_redemption_id,
      'message', '$' || v_discount.value::text || ' credit added to your account.'
    );

  ELSIF v_discount.type = 'percent' THEN
    -- % code: one per customer per code
    SELECT id INTO v_existing_redemption
      FROM public.discount_redemptions
     WHERE discount_id = v_discount.id
       AND customer_id = p_customer_id
       AND discount_type_snapshot = 'percent'
     LIMIT 1;

    IF v_existing_redemption IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_redeemed',
        'message', 'You''ve already used this code.');
    END IF;

    -- "Highest wins" — refuse if customer already has an equal-or-better % discount
    IF v_target_discount_id IS NOT NULL THEN
      SELECT name, value
        INTO v_current_name, v_current_pct
        FROM public.discounts
       WHERE id = v_target_discount_id AND type = 'percent'
       LIMIT 1;

      IF v_current_pct IS NOT NULL AND v_current_pct >= v_discount.value THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'lower_value',
          'current_discount_name',  v_current_name,
          'current_discount_value', v_current_pct,
          'message', 'You already have ' || v_current_name || ' (' ||
                     v_current_pct::text || '% off) — that''s the same or better than ' ||
                     v_discount.name || '.'
        );
      END IF;
    END IF;

    INSERT INTO public.discount_redemptions (
      discount_id, customer_id, order_id, redeemed_by,
      discount_type_snapshot, discount_value_snapshot, discount_name_snapshot
    ) VALUES (
      v_discount.id, p_customer_id, p_order_id, v_actor,
      'percent', v_discount.value, v_discount.name
    ) RETURNING id INTO v_redemption_id;

    UPDATE public.customers
       SET discount_id = v_discount.id,
           updated_at  = now()
     WHERE id = p_customer_id;

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'percent',
      'discount_id',           v_discount.id,
      'discount_name',         v_discount.name,
      'value',                 v_discount.value,
      'previous_discount_name', v_current_name,
      'redemption_id',         v_redemption_id,
      'message', v_discount.name || ' (' || v_discount.value::text ||
                 '% off) is now active on your account.'
    );

  END IF;

EXCEPTION
  WHEN unique_violation THEN
    -- Race: someone else slipped in between our check and our insert
    RETURN jsonb_build_object('ok', false, 'error', 'race_already_redeemed',
      'message', 'This code was just used by someone else.');
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_discount_code(TEXT, UUID, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.redeem_discount_code(TEXT, UUID, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.redeem_discount_code(TEXT, UUID, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.redeem_discount_code(TEXT, UUID, UUID, TEXT) IS
  'Atomic coupon redemption. Single trusted door for both customer self-service and admin-applied. Authorizes caller = customer-self OR profiles.role=admin.';
