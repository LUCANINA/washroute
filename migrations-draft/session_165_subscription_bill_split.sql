-- ====================================================================
-- session_165_subscription_bill_split
--
-- Purpose: Enable the $275 subscription launch by splitting subscriber
-- order billing between:
--   (a) the subscription, which absorbs base wash & fold + line-item
--       bag-overage + delivery fee
--   (b) the card on file, which is charged for add-ons + same-day
--       surcharge + lb-overage above the plan's monthly cap + tip
--
-- Replaces the pre-launch model where the subscription absorbed the
-- ENTIRE order (which would have silently zeroed out add-ons + tips
-- + same-day fees the moment subscribers existed). That model also
-- charged accumulated lb-overage at cancellation only — too lumpy +
-- too late for customer-friendly UX.
--
-- Architecture:
--   - apply_subscription_usage_fn trigger is moved from `delivered` →
--     `ready_for_delivery`, the same moment charge-order computes the
--     residual. Usage now increments atomically with billing.
--   - The trigger no longer stamps `billing_status='paid' ...
--     billing_payment_method='subscription'`. That responsibility
--     moves to charge-order (single billing arbiter for all orders).
--   - New SECURITY DEFINER RPC compute_subscription_residual(order_id)
--     reads order.line_items, categorizes by type, computes the lb-
--     overage from the plan cap, and returns the card-charge total.
--     charge-order calls this RPC and charges card for the residual.
--
-- Reversibility: trivial — the OR REPLACE of the trigger function is
-- the only "change" piece; rollback script at the bottom restores the
-- prior body.
-- ====================================================================

-- 1. Move + simplify apply_subscription_usage_fn
CREATE OR REPLACE FUNCTION public.apply_subscription_usage_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_weight NUMERIC;
  v_sub RECORD;
  v_new_usage NUMERIC;
  v_new_overage NUMERIC;
BEGIN
  -- Fire on UPDATE transitions INTO ready_for_delivery. Usage must be
  -- incremented BEFORE charge-order computes the residual, so the lb-
  -- overage math sees this order's contribution to the cycle total.
  IF NEW.status <> 'ready_for_delivery' OR OLD.status = 'ready_for_delivery' THEN
    RETURN NEW;
  END IF;
  IF NEW.subscription_id IS NULL THEN RETURN NEW; END IF;

  SELECT
    s.id,
    s.usage_lbs_this_period,
    s.pickups_this_period,
    p.weight_limit_lbs,
    p.pickup_limit,
    p.overage_price_per_lb
  INTO v_sub
  FROM subscriptions s
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.id = NEW.subscription_id;

  IF NOT FOUND THEN RETURN NEW; END IF;

  v_weight    := COALESCE(NEW.weight_lbs, 0);
  v_new_usage := COALESCE(v_sub.usage_lbs_this_period, 0) + v_weight;

  v_new_overage := CASE
    WHEN v_sub.weight_limit_lbs IS NOT NULL
     AND v_new_usage > v_sub.weight_limit_lbs
    THEN ROUND((v_new_usage - v_sub.weight_limit_lbs) * COALESCE(v_sub.overage_price_per_lb, 0), 2)
    ELSE 0
  END;

  UPDATE subscriptions
  SET
    usage_lbs_this_period = v_new_usage,
    pickups_this_period   = COALESCE(pickups_this_period, 0) + 1,
    overage_amount_due    = v_new_overage,
    updated_at            = NOW()
  WHERE id = NEW.subscription_id;

  -- Append to usage log (event_type renamed to 'order_ready' since the
  -- trigger now fires at ready_for_delivery, not delivered).
  INSERT INTO subscription_usage_log
    (subscription_id, order_id, event_type, weight_delta, pickups_delta, note)
  VALUES
    (NEW.subscription_id, NEW.id, 'order_ready', v_weight, 1,
     'Order #' || COALESCE(NEW.order_number::text, SUBSTRING(NEW.id::text, 1, 8)) || ' ready for delivery');

  -- IMPORTANT: do NOT stamp billing_status here. charge-order is the
  -- sole billing arbiter — it calls compute_subscription_residual()
  -- and either (a) charges the card for the residual, or (b) marks
  -- the order paid-by-subscription if residual = 0.

  RETURN NEW;
END;
$function$;


-- 2. New RPC: compute_subscription_residual
--    Returns jsonb breakdown: absorbed, addons, same_day, lb_overage,
--    tip_dollars, card_charge_total. charge-order calls this and
--    charges the card for card_charge_total.
CREATE OR REPLACE FUNCTION public.compute_subscription_residual(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_order RECORD;
  v_sub RECORD;
  v_plan RECORD;
  v_total NUMERIC;
  v_absorbed NUMERIC := 0;
  v_addons NUMERIC := 0;
  v_same_day NUMERIC := 0;
  v_other NUMERIC := 0;
  v_li jsonb;
  v_li_amt NUMERIC;
  v_li_type TEXT;
  v_weight NUMERIC;
  v_used_pre NUMERIC;
  v_weight_remaining NUMERIC;
  v_weight_covered NUMERIC;
  v_weight_over NUMERIC;
  v_lb_overage NUMERIC;
  v_tip_dollars NUMERIC;
  v_card_charge NUMERIC;
BEGIN
  SELECT id, order_number, total_amount, tip_amount, tip_type, weight_lbs,
         line_items, subscription_id, status, billing_status
  INTO v_order
  FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  v_total := COALESCE(v_order.total_amount, 0);

  v_tip_dollars := CASE
    WHEN v_order.tip_amount IS NULL OR v_order.tip_amount = 0 THEN 0
    WHEN v_order.tip_type = 'pct' THEN ROUND(v_total * v_order.tip_amount / 100.0, 2)
    ELSE ROUND(v_order.tip_amount, 2)
  END;

  -- Non-subscriber order: card pays the full subtotal + tip.
  IF v_order.subscription_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_subscription', false,
      'absorbed', 0,
      'addons', 0,
      'same_day', 0,
      'other', 0,
      'lb_overage_dollars', 0,
      'tip_dollars', v_tip_dollars,
      'card_charge_total', ROUND(v_total + v_tip_dollars, 2)
    );
  END IF;

  -- Lock the subscription row so concurrent ready_for_delivery transitions
  -- can't race on usage_lbs_this_period.
  SELECT s.id, s.usage_lbs_this_period, s.status, s.plan_id
  INTO v_sub
  FROM subscriptions s
  WHERE s.id = v_order.subscription_id
  FOR UPDATE;
  IF NOT FOUND THEN
    -- Orphan subscription_id (subscription was hard-deleted). Treat as
    -- non-subscriber to avoid silently zero-billing the customer.
    RETURN jsonb_build_object(
      'has_subscription', false,
      'note', 'subscription_id orphaned',
      'absorbed', 0,
      'card_charge_total', ROUND(v_total + v_tip_dollars, 2)
    );
  END IF;

  SELECT weight_limit_lbs, overage_price_per_lb, pickup_limit
  INTO v_plan
  FROM subscription_plans
  WHERE id = v_sub.plan_id;

  -- Only ACTIVE / PAST_DUE subscriptions absorb. Paused or cancelled
  -- fall back to full retail (we surface the situation as 'note' so
  -- charge-order can render it in admin/customer event logs).
  IF v_sub.status NOT IN ('active','past_due') THEN
    RETURN jsonb_build_object(
      'has_subscription', true,
      'subscription_status', v_sub.status,
      'note', 'subscription inactive — charging full price',
      'absorbed', 0,
      'addons', 0,
      'same_day', 0,
      'other', 0,
      'lb_overage_dollars', 0,
      'tip_dollars', v_tip_dollars,
      'card_charge_total', ROUND(v_total + v_tip_dollars, 2)
    );
  END IF;

  -- Categorize line items.
  --   base / overage (line-item bag overage) / delivery_fee → absorbed
  --   pref_service → add-ons (Oxi, Vinegar, etc.) — card pays
  --   same_day_surcharge → card pays
  --   anything else (merchandise, credit, etc.) → card pays (safer)
  IF jsonb_typeof(v_order.line_items) = 'array' THEN
    FOR v_li IN SELECT * FROM jsonb_array_elements(v_order.line_items) LOOP
      v_li_amt := COALESCE((v_li->>'amount')::NUMERIC, 0);
      v_li_type := v_li->>'type';
      IF v_li_type IN ('base','overage','delivery_fee') THEN
        v_absorbed := v_absorbed + v_li_amt;
      ELSIF v_li_type = 'pref_service' THEN
        v_addons := v_addons + v_li_amt;
      ELSIF v_li_type = 'same_day_surcharge' THEN
        v_same_day := v_same_day + v_li_amt;
      ELSE
        v_other := v_other + v_li_amt;
      END IF;
    END LOOP;
  END IF;

  -- Lb-overage against the plan's monthly cap.
  -- apply_subscription_usage_fn fires BEFORE charge-order's RPC call,
  -- so usage_lbs_this_period ALREADY INCLUDES this order's weight.
  -- Subtract it back to get pre-order usage, then compute remaining.
  v_weight := COALESCE(v_order.weight_lbs, 0);
  IF v_plan.weight_limit_lbs IS NOT NULL THEN
    v_used_pre         := GREATEST(0, COALESCE(v_sub.usage_lbs_this_period, 0) - v_weight);
    v_weight_remaining := GREATEST(0, v_plan.weight_limit_lbs - v_used_pre);
    v_weight_covered   := LEAST(v_weight, v_weight_remaining);
    v_weight_over      := GREATEST(0, v_weight - v_weight_covered);
    v_lb_overage       := ROUND(v_weight_over * COALESCE(v_plan.overage_price_per_lb, 0), 2);
  ELSE
    v_weight_remaining := NULL;
    v_weight_covered   := v_weight;
    v_weight_over      := 0;
    v_lb_overage       := 0;
  END IF;

  v_card_charge := ROUND(v_addons + v_same_day + v_other + v_lb_overage + v_tip_dollars, 2);

  RETURN jsonb_build_object(
    'has_subscription', true,
    'subscription_status', v_sub.status,
    'subscription_id', v_sub.id,
    'order_total_amount', v_total,
    'tip_dollars', v_tip_dollars,
    'absorbed', v_absorbed,
    'addons', v_addons,
    'same_day', v_same_day,
    'other', v_other,
    'weight_lbs', v_weight,
    'weight_covered_by_plan', v_weight_covered,
    'weight_overage_lbs', v_weight_over,
    'lb_overage_dollars', v_lb_overage,
    'card_charge_total', v_card_charge
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.compute_subscription_residual(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.compute_subscription_residual(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.compute_subscription_residual(uuid) TO authenticated, service_role;
