-- Session 334 (2026-10-06). record_order_intake must not lower an order's total
-- below money already collected on the card.
--
-- THE INCIDENT — order #14859, Morgan Connolly, 2026-09-18:
--   18:26:09  Charged $30.00 incl. tip      (correct: $15.00 service + $15.00 tip)
--   18:49:31  Moved back to Intake
--   18:50:10  Re-intake: Total $15.00 -> $0.00
--   18:58:14  Racked again; already 'paid', so no re-charge and no refund
-- She was charged $30.00 for an order the system then priced at $0.00 service.
-- Nothing warned, nothing reconciled, no billing_discrepancy event. $15.00 sat on
-- her card until today's audit.
--
-- WHY THIS WASN'T ALREADY COVERED. Session 281 built this exact guard and put it on
-- opSaveDetails, the Billing-details Save path. Intake Save is a SECOND branch
-- reaching the same write and never got one. Session 281's own closing line:
-- "a guard is only as good as the branch it sits on; grep every branch that reaches
-- the same write." Session 175 covered the OPPOSITE direction on this same path (a
-- re-intake raising a total after a $0 order was marked paid, so the customer was
-- never charged). The downward direction was never covered.
--
-- SCOPE — downward only, David's call 2026-10-06. An upward re-intake still works:
-- a tech who typed 13 lbs instead of 31 can fix it at the counter and the extra is
-- charged as it is today. Only a re-save that would drop the total BELOW what the
-- card already paid is refused.
--
-- CARD MONEY ONLY, DELIBERATELY. Credit is not counted as collected here, because
-- this function's own first act is refund_order_credits() — returning and re-applying
-- credit is the designed re-intake flow, and counting it would block every re-intake
-- of a credit-paid order. 'charge' rows cover POS cash too (payment_method='cash'
-- charges carry no Stripe intent but are real money, session 281).
--
-- THE TIP TERM IS NOT OPTIONAL. total_amount is pre-tip and post-credit; charge-order
-- adds the tip on top at charge time. A comparison that drops the tip reports a false
-- overcharge on every tipped order — that mistake produced ~100 phantom rows in the
-- session 281 audit and two more on 2026-10-06. The tip is recomputed against the NEW
-- total, which for a percent tip makes the guard slightly stricter. That is the safe
-- direction for a guard.
--
-- A BLOCKED ATTEMPT LEAVES NO TRACE, ON PURPOSE. RAISE rolls back the whole
-- transaction, so an order_event written here would be erased with it. Detection is
-- audit check 30 (added 2026-10-06), which catches the record-level symptom daily.
--
-- Callers: admin-dashboard saveIntake() and pos/index.html POS intake. Both already
-- surface error.message verbatim and re-enable the Save button, so the message below
-- is written to be read by a laundry tech at the counter, not by a developer.
--
-- Rollback: SELECT def FROM _archive._fn_snapshot_334; and EXECUTE it.

CREATE SCHEMA IF NOT EXISTS _archive;

CREATE TABLE IF NOT EXISTS _archive._fn_snapshot_334 (
  proname    text,
  def        text,
  snapped_at timestamptz DEFAULT now()
);

INSERT INTO _archive._fn_snapshot_334 (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'record_order_intake';

CREATE OR REPLACE FUNCTION public.record_order_intake(p_order_id uuid, p_weight_lbs numeric, p_bags integer, p_total_amount numeric, p_line_items jsonb, p_service_id uuid DEFAULT NULL::uuid, p_discount_id uuid DEFAULT NULL::uuid, p_is_same_day boolean DEFAULT false, p_notes text DEFAULT NULL::text, p_credit_applied numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL::uuid, p_actor_name text DEFAULT 'Admin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order            orders%ROWTYPE;
  v_old_status       text;
  v_customer_id      uuid;
  v_refund_res       jsonb;
  v_credit_res       RECORD;
  v_credit_deducted  numeric := 0;
  v_new_balance      numeric;
  v_now              timestamptz := NOW();
  v_card_collected   numeric := 0;
  v_new_tip          numeric := 0;
  v_new_charge       numeric := 0;
BEGIN
  PERFORM public.assert_staff('record_order_intake');
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'p_order_id is required' USING ERRCODE='invalid_parameter_value'; END IF;
  IF p_weight_lbs IS NULL OR p_weight_lbs <= 0 THEN RAISE EXCEPTION 'p_weight_lbs must be > 0' USING ERRCODE='invalid_parameter_value'; END IF;
  IF p_bags IS NULL OR p_bags <= 0 THEN RAISE EXCEPTION 'p_bags must be > 0' USING ERRCODE='invalid_parameter_value'; END IF;
  IF p_total_amount IS NULL OR p_total_amount < 0 THEN RAISE EXCEPTION 'p_total_amount must be >= 0' USING ERRCODE='invalid_parameter_value'; END IF;
  IF p_credit_applied IS NULL OR p_credit_applied < 0 THEN RAISE EXCEPTION 'p_credit_applied must be >= 0' USING ERRCODE='invalid_parameter_value'; END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order % not found', p_order_id USING ERRCODE='no_data_found'; END IF;

  -- Session 334: refuse to re-price an already-charged order DOWNWARD. Runs before
  -- refund_order_credits and before any write, so a refusal changes nothing.
  SELECT COALESCE(SUM(CASE WHEN type = 'refund' THEN -amount ELSE amount END), 0)
    INTO v_card_collected
    FROM customer_transactions
   WHERE order_id = p_order_id
     AND type IN ('charge', 'refund');

  IF v_card_collected > 0 THEN
    v_new_tip := CASE WHEN v_order.tip_type = 'pct'
                      THEN ROUND(p_total_amount * COALESCE(v_order.tip_amount, 0) / 100, 2)
                      ELSE COALESCE(v_order.tip_amount, 0) END;
    v_new_charge := p_total_amount + v_new_tip;

    IF v_card_collected > v_new_charge + 0.01 THEN
      RAISE EXCEPTION
        'Order #% has already been paid. $% was charged to the card, and saving this would drop the order to $% (including tip). Refund the difference first, then save the intake again.',
        v_order.order_number,
        TO_CHAR(v_card_collected, 'FM999990.00'),
        TO_CHAR(v_new_charge, 'FM999990.00')
        USING ERRCODE = 'P0001',
              HINT    = 'Admin -> the order -> Billing -> Refund. Nothing was saved.';
    END IF;
  END IF;

  v_old_status  := v_order.status;
  v_customer_id := COALESCE(p_customer_id, v_order.customer_id);

  v_refund_res := refund_order_credits(p_order_id, p_actor_name);

  INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
  VALUES (p_order_id, 'weight_updated', 'Weight recorded: ' || p_weight_lbs || ' lbs', NULL, p_weight_lbs::text, p_actor_name);

  INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
  VALUES (p_order_id, 'bags_updated', 'Bags: ' || p_bags, NULL, p_bags::text, p_actor_name);

  IF p_total_amount > 0 THEN
    INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
    VALUES (p_order_id, 'total_changed', 'Total calculated: $' || p_total_amount, NULL, p_total_amount::text, p_actor_name);
  END IF;

  IF v_old_status IS DISTINCT FROM 'processing' THEN
    INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
    VALUES (p_order_id, 'status_change', 'Processing', v_old_status, 'processing', p_actor_name);
  END IF;

  -- Session 148: is_same_day removed from UPDATE. The column is now generated.
  -- p_is_same_day parameter retained for back-compat (silently ignored).
  UPDATE orders SET
    status               = 'processing',
    weight_lbs           = p_weight_lbs,
    total_bags           = p_bags,
    total_amount         = p_total_amount,
    line_items           = p_line_items,
    service_id           = COALESCE(p_service_id, service_id),
    discount_id          = p_discount_id,
    special_instructions = COALESCE(p_notes, special_instructions),
    updated_at           = v_now
  WHERE id = p_order_id;

  IF p_credit_applied > 0 AND v_customer_id IS NOT NULL THEN
    SELECT * INTO v_credit_res FROM apply_customer_credit_to_order(
      v_customer_id, p_credit_applied,
      'Applied to order #' || v_order.order_number || ' at Intake',
      p_order_id, 'credit'
    );
    v_credit_deducted := v_credit_res.actual_deducted;
    v_new_balance     := v_credit_res.new_balance;
  ELSE
    SELECT COALESCE(credits, 0) INTO v_new_balance FROM customers WHERE id = v_customer_id;
  END IF;

  RETURN jsonb_build_object(
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'old_status', v_old_status,
    'new_status', 'processing',
    'total_amount', p_total_amount,
    'credit_applied', v_credit_deducted,
    'credit_refunded_from_prior_intake', COALESCE((v_refund_res->>'refunded')::numeric, 0),
    'new_balance', v_new_balance,
    'updated_at', v_now
  );
END;
$function$;

-- Grants: restore exactly what was there (postgres / authenticated / service_role; no anon, no PUBLIC).
REVOKE EXECUTE ON FUNCTION public.record_order_intake(uuid, numeric, integer, numeric, jsonb, uuid, uuid, boolean, text, numeric, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_order_intake(uuid, numeric, integer, numeric, jsonb, uuid, uuid, boolean, text, numeric, uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_order_intake(uuid, numeric, integer, numeric, jsonb, uuid, uuid, boolean, text, numeric, uuid, text) TO authenticated, service_role;

-- Assert the guard actually landed. apply_migration wraps this file in a transaction,
-- so a failed assert rolls the whole migration back. strpos, not LIKE (LIKE eats backslashes).
DO $assert$
DECLARE s text;
BEGIN
  SELECT p.prosrc INTO s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_order_intake';
  IF strpos(s, 'Session 334: refuse to re-price an already-charged order DOWNWARD') = 0 THEN
    RAISE EXCEPTION 'session 334 guard comment missing from record_order_intake';
  END IF;
  IF strpos(s, 'has already been paid. $% was charged to the card') = 0 THEN
    RAISE EXCEPTION 'session 334 guard message missing from record_order_intake';
  END IF;
  IF strpos(s, 'v_card_collected > v_new_charge + 0.01') = 0 THEN
    RAISE EXCEPTION 'session 334 guard condition missing from record_order_intake';
  END IF;
  IF (SELECT count(*) FROM _archive._fn_snapshot_334) = 0 THEN
    RAISE EXCEPTION 'session 334 rollback snapshot was not taken';
  END IF;
END
$assert$;
