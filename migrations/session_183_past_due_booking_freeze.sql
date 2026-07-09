-- Session 183 — Past-due subscription fairness rules (part 1: booking freeze)
--
-- Policy (David, Jul 9 2026): the 7-day dunning grace period is time to fix the
-- payment method, NOT free service. While a subscription is past_due:
--   * NEW subscription-covered bookings are blocked (customer app + admin + any path)
--   * recurring continuations are parked as on_hold (chain preserved, not routed,
--     visible in Issues) instead of created as $0 scheduled orders
--   * already-scheduled orders are honored (they were booked in good standing)
--
-- Companion RPCs (called by stripe-webhook):
--   * release_subscription_held_orders  — payment recovered → release + route held orders
--   * handle_subscription_grace_expiry  — grace expired unpaid → cancel unstarted orders,
--     reprice serviced-but-unsettled orders at pay-per-order Delivery rates
--
-- Why on_hold (not RETURN NULL like enforce_not_frozen): freezing kills the recurring
-- chain permanently. Past-due is usually temporary (card expired), so the chain must
-- survive recovery. on_hold orders are not routed (trg_auto_route_new_order only fires
-- for status='scheduled') and surface in the admin Issues tab.

-- ── 1. Booking freeze trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_sub_not_past_due()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_is_past_due BOOLEAN := FALSE;
BEGIN
  IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;

  -- Only guard subscription-covered orders: the customer is currently on the
  -- Subscription pricelist AND their most recent live subscription is past_due.
  -- (Same "latest live sub" resolution as link_subscription_on_order_fn.)
  SELECT (s.status = 'past_due') INTO v_is_past_due
  FROM customers c
  LEFT JOIN LATERAL (
    SELECT status FROM subscriptions
    WHERE customer_id = c.id AND status IN ('active','past_due','paused')
    ORDER BY created_at DESC LIMIT 1
  ) s ON TRUE
  WHERE c.id = NEW.customer_id AND c.pricelist = 'Subscription';

  IF v_is_past_due IS NOT TRUE THEN RETURN NEW; END IF;

  -- Recurring generation: park as on_hold. Never raise here — an exception would
  -- roll back the parent order's status change (e.g. a driver marking delivered).
  IF NEW.source = 'recurring' THEN
    NEW.status := 'on_hold';
    RETURN NEW;
  END IF;

  -- Customer app / admin / SMS paths: hard block with a customer-readable message.
  RAISE EXCEPTION 'Subscription payment is past due — please update the payment method before booking a new pickup.'
    USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_sub_not_past_due ON public.orders;
CREATE TRIGGER trg_enforce_sub_not_past_due
  BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_sub_not_past_due();

-- ── 2. Payment recovered → release held orders ──────────────────────────────
CREATE OR REPLACE FUNCTION public.release_subscription_held_orders(p_subscription_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_order RECORD;
  v_released UUID[] := '{}';
BEGIN
  FOR v_order IN
    SELECT id FROM orders
    WHERE subscription_id = p_subscription_id
      AND status = 'on_hold'
      AND source = 'recurring'
      AND pickup_window_start > now()          -- only future pickups make sense to revive
    FOR UPDATE
  LOOP
    UPDATE orders SET status = 'scheduled', routing_error = NULL, updated_at = now()
    WHERE id = v_order.id;
    -- Route it (insert-time auto-routing was skipped because status was on_hold)
    PERFORM auto_route_order(v_order.id);
    v_released := array_append(v_released, v_order.id);
  END LOOP;

  RETURN jsonb_build_object('released_count', COALESCE(array_length(v_released,1),0),
                            'order_ids', to_jsonb(v_released));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.release_subscription_held_orders(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_subscription_held_orders(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.release_subscription_held_orders(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.release_subscription_held_orders(UUID) TO service_role;

-- ── 3. Grace expired unpaid → cancel unstarted, reprice serviced usage ──────
-- Fairness rule: the voided $275 renewal is forgiven, but laundry actually done
-- during the unpaid period is billed at pay-per-order Delivery rates
-- (bags × base + overage-lbs × rate, read live from the services row).
CREATE OR REPLACE FUNCTION public.handle_subscription_grace_expiry(p_subscription_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_svc RECORD;
  v_order RECORD;
  v_period_start TIMESTAMPTZ;
  v_cancelled UUID[] := '{}';
  v_repriced jsonb := '[]'::jsonb;
  v_bags INT;
  v_base NUMERIC;
  v_overage_lbs NUMERIC;
  v_overage_amt NUMERIC;
  v_new_total NUMERIC;
  v_new_items jsonb;
  v_extra NUMERIC;
BEGIN
  SELECT base_price, lbs_per_bag, overage_rate_per_lb INTO v_svc
  FROM services
  WHERE pricelist = 'Delivery' AND is_active = TRUE AND is_addon = FALSE AND pricing_type = 'per_bag'
  ORDER BY sort_order, name LIMIT 1;
  IF v_svc IS NULL THEN
    RAISE EXCEPTION 'No active Delivery per_bag service found — cannot reprice';
  END IF;

  -- ⚠️ Scope to the UNPAID period only. Subscription orders are $0 and never carry
  -- billed_at, so without this bound the loop would sweep up every HISTORICAL order
  -- of the subscription — including months that were properly paid.
  SELECT current_period_start INTO v_period_start
  FROM subscriptions WHERE id = p_subscription_id;
  IF v_period_start IS NULL THEN
    RAISE EXCEPTION 'Subscription % not found or has no current_period_start', p_subscription_id;
  END IF;

  FOR v_order IN
    SELECT id, status, source, total_bags, weight_lbs, line_items, actual_pickup_at
    FROM orders
    WHERE subscription_id = p_subscription_id
      AND is_subscription_order = TRUE
      AND COALESCE(actual_pickup_at, pickup_window_start) >= v_period_start
      -- unsettled only — same criteria as link_subscription_on_order_fn's guard
      AND COALESCE(billing_status,'') NOT IN ('paid','refunded','written_off')
      AND billed_at IS NULL
      AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = 'credit_applied')
      AND status NOT IN ('cancelled','skipped','pickup_failed','delivery_failed')
    FOR UPDATE
  LOOP
    -- Unstarted orders (never picked up): cancel. Held recurring continuations too.
    IF v_order.status IN ('scheduled','on_hold') AND v_order.actual_pickup_at IS NULL THEN
      UPDATE orders
      SET status = 'cancelled', cancelled_by = 'system', updated_at = now()
      WHERE id = v_order.id;
      v_cancelled := array_append(v_cancelled, v_order.id);
      CONTINUE;
    END IF;

    -- Serviced orders: reprice at Delivery rates.
    v_bags        := GREATEST(1, COALESCE(v_order.total_bags, 1));
    v_base        := v_bags * v_svc.base_price;
    v_overage_lbs := GREATEST(0, COALESCE(v_order.weight_lbs, 0) - v_bags * v_svc.lbs_per_bag);
    v_overage_amt := ROUND(v_overage_lbs * v_svc.overage_rate_per_lb, 2);

    -- Keep addon / pref_service / same_day_surcharge / tip-relevant lines; drop old
    -- $0 base + overage lines; delivery_fee line is re-normalized by the link trigger.
    SELECT COALESCE(jsonb_agg(li), '[]'::jsonb),
           COALESCE(SUM((li->>'amount')::NUMERIC) FILTER (WHERE li->>'type' NOT IN ('base','overage')), 0)
      INTO v_new_items, v_extra
    FROM jsonb_array_elements(COALESCE(v_order.line_items,'[]'::jsonb)) li
    WHERE li->>'type' NOT IN ('base','overage');

    v_new_items := jsonb_build_array(
      jsonb_build_object('type','base',
        'label', 'Wash & Fold · ' || v_bags || ' bag' || CASE WHEN v_bags > 1 THEN 's' ELSE '' END
                 || ' × $' || to_char(v_svc.base_price,'FM999990.00') || ' (rebilled — subscription ended unpaid)',
        'amount', v_base, 'taxable', false)
    )
    || CASE WHEN v_overage_amt > 0 THEN jsonb_build_array(
         jsonb_build_object('type','overage',
           'label', to_char(v_overage_lbs,'FM999990.9') || ' lbs overage × $' || to_char(v_svc.overage_rate_per_lb,'FM999990.00'),
           'amount', v_overage_amt, 'taxable', false))
       ELSE '[]'::jsonb END
    || v_new_items;

    v_new_total := v_base + v_overage_amt + v_extra;

    UPDATE orders
    SET line_items = v_new_items,
        total_amount = v_new_total,
        billing_status = NULL,          -- explicitly unpaid → shows in unpaid machinery
        updated_at = now()
    WHERE id = v_order.id;

    v_repriced := v_repriced || jsonb_build_array(jsonb_build_object('order_id', v_order.id, 'new_total', v_new_total));
  END LOOP;

  RETURN jsonb_build_object(
    'cancelled_count', COALESCE(array_length(v_cancelled,1),0),
    'cancelled_ids', to_jsonb(v_cancelled),
    'repriced', v_repriced
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_subscription_grace_expiry(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.handle_subscription_grace_expiry(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_subscription_grace_expiry(UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.handle_subscription_grace_expiry(UUID) TO service_role;
