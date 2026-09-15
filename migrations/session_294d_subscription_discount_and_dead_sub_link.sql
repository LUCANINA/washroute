-- Session 294d (audit 2026-09-15). Two money bugs, both in triggers.
--
-- A) Discount shown but never deducted on subscription overage (#14685 Raifman -$6.60,
--    #12228 Addington -$3.71). Intake writes a discount line that includes the overage,
--    but persists a total that EXCLUDES the overage (the trigger adds it later).
--    apply_subscription_usage_fn then added the FULL overage and never the discount.
--    Fix: the trigger adds the overage NET of the order's percent discount, and
--    recomputes the single discount line over every discountable item incl. lb_overage.
--    Works for orders already intaken under the old client code (their persisted total
--    is the non-overage net either way).
--
-- B) Cancelled subscription kept on new recurring orders (#14853 Candy RamirezHale,
--    $0 orders since July). trg_create_recurring_order_fn fell back to the previous
--    order's subscription_id without checking it was still alive, and copied the
--    $0 subscription line items. Fix: only carry a subscription that is
--    active/past_due/paused; when a dead link is dropped for a non-subscription
--    customer, re-price base + delivery fee from the customer's current pricelist.

CREATE TABLE IF NOT EXISTS _archive._fn_snapshot_294d (proname text, def text, snapped_at timestamptz DEFAULT now());
INSERT INTO _archive._fn_snapshot_294d (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid) FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('apply_subscription_usage_fn', 'trg_create_recurring_order_fn');

-- ── A ──
CREATE OR REPLACE FUNCTION public.apply_subscription_usage_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_weight              NUMERIC;
  v_sub                 RECORD;
  v_prior_applied       NUMERIC;
  v_weight_delta        NUMERIC;
  v_pickups_delta       INT;
  v_usage_pre_order     NUMERIC;
  v_new_usage           NUMERIC;
  v_remaining_in_plan   NUMERIC;
  v_weight_in_plan      NUMERIC;
  v_weight_over         NUMERIC;
  v_overage_dollars     NUMERIC;
  v_line_items_clean    JSONB;
  v_existing_overage    NUMERIC := 0;
  v_weight_over_label   TEXT;
  v_disc                RECORD;
  v_disc_on_new         NUMERIC := 0;
  v_disc_on_old         NUMERIC := 0;
  v_discountable        NUMERIC := 0;
  v_disc_total          NUMERIC := 0;
BEGIN
  IF NEW.status <> 'ready_for_delivery' OR OLD.status = 'ready_for_delivery' THEN
    RETURN NEW;
  END IF;
  IF NEW.subscription_id IS NULL THEN RETURN NEW; END IF;

  SELECT s.id, s.usage_lbs_this_period, s.pickups_this_period,
         p.weight_limit_lbs, p.pickup_limit, p.overage_price_per_lb
  INTO v_sub
  FROM subscriptions s
  LEFT JOIN subscription_plans p ON p.id = s.plan_id
  WHERE s.id = NEW.subscription_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_weight        := COALESCE(NEW.weight_lbs, 0);
  v_prior_applied := COALESCE(OLD.subscription_usage_lbs_applied, 0);
  v_weight_delta  := v_weight - v_prior_applied;
  v_pickups_delta := CASE WHEN v_prior_applied = 0 AND v_weight > 0 THEN 1 ELSE 0 END;

  v_usage_pre_order := GREATEST(0, COALESCE(v_sub.usage_lbs_this_period, 0) - v_prior_applied);
  v_new_usage       := v_usage_pre_order + v_weight;

  IF v_sub.weight_limit_lbs IS NOT NULL AND v_sub.overage_price_per_lb IS NOT NULL THEN
    v_remaining_in_plan := GREATEST(0, v_sub.weight_limit_lbs - v_usage_pre_order);
    v_weight_in_plan    := LEAST(v_weight, v_remaining_in_plan);
    v_weight_over       := GREATEST(0, v_weight - v_weight_in_plan);
    v_overage_dollars   := ROUND(v_weight_over * v_sub.overage_price_per_lb, 2);
  ELSE
    v_weight_over     := 0;
    v_overage_dollars := 0;
  END IF;

  IF jsonb_typeof(NEW.line_items) = 'array' THEN
    SELECT COALESCE(SUM((li->>'amount')::NUMERIC), 0)
      INTO v_existing_overage
      FROM jsonb_array_elements(NEW.line_items) li
     WHERE li->>'type' = 'lb_overage';
    SELECT COALESCE(jsonb_agg(li), '[]'::jsonb)
      INTO v_line_items_clean
      FROM jsonb_array_elements(NEW.line_items) li
     WHERE li->>'type' IS DISTINCT FROM 'lb_overage';
  ELSE
    v_line_items_clean := '[]'::jsonb;
  END IF;

  IF v_overage_dollars > 0 THEN
    v_weight_over_label := REGEXP_REPLACE(REGEXP_REPLACE(v_weight_over::TEXT, '0+$', ''), $r$\.$$r$, '');
    v_line_items_clean := v_line_items_clean || jsonb_build_object(
      'type',   'lb_overage',
      'label',  'Subscription overage · ' || v_weight_over_label || ' lbs × $'
                || TO_CHAR(v_sub.overage_price_per_lb, 'FM999990.00') || '/lb',
      'amount', v_overage_dollars
    );
  END IF;

  -- Session 294d: the order's percent discount applies to the overage too.
  SELECT d.name, d.value INTO v_disc
    FROM discounts d
   WHERE d.id = NEW.discount_id AND d.type = 'percent' AND d.active;
  IF FOUND AND COALESCE(v_disc.value, 0) > 0 THEN
    v_disc_on_new := ROUND(COALESCE(v_overage_dollars, 0)  * v_disc.value / 100.0, 2);
    v_disc_on_old := ROUND(COALESCE(v_existing_overage, 0) * v_disc.value / 100.0, 2);

    SELECT COALESCE(SUM((li->>'amount')::NUMERIC), 0) INTO v_discountable
      FROM jsonb_array_elements(v_line_items_clean) li
     WHERE li->>'type' IN ('base','overage','addon','addon_service','pref_service','lb_overage');
    v_disc_total := ROUND(v_discountable * v_disc.value / 100.0, 2);

    SELECT COALESCE(jsonb_agg(li), '[]'::jsonb) INTO v_line_items_clean
      FROM jsonb_array_elements(v_line_items_clean) li
     WHERE li->>'type' IS DISTINCT FROM 'discount';
    IF v_disc_total > 0 THEN
      v_line_items_clean := v_line_items_clean || jsonb_build_object(
        'type',   'discount',
        'label',  v_disc.name || ' (' || trim(to_char(v_disc.value, 'FM999990.##')) || '% off)',
        'amount', -v_disc_total
      );
    END IF;
  END IF;

  NEW.line_items                     := v_line_items_clean;
  NEW.total_amount                   := GREATEST(0, COALESCE(NEW.total_amount, 0)
                                          - (v_existing_overage - v_disc_on_old)
                                          + (v_overage_dollars  - v_disc_on_new));
  NEW.subscription_usage_lbs_applied := v_weight;

  -- session 280: overage_amount_due is what is still OWED, measured from the
  -- orders — never a parallel accrual of what was already charged on them.
  UPDATE subscriptions
  SET usage_lbs_this_period = GREATEST(0, COALESCE(usage_lbs_this_period, 0) + v_weight_delta),
      pickups_this_period   = COALESCE(pickups_this_period, 0) + v_pickups_delta,
      overage_amount_due    = public.uncollected_subscription_overage(NEW.subscription_id, NEW.id)
                              + GREATEST(0, COALESCE(v_overage_dollars, 0)),
      updated_at            = NOW()
  WHERE id = NEW.subscription_id;

  INSERT INTO subscription_usage_log
    (subscription_id, order_id, event_type, weight_delta, pickups_delta, note)
  VALUES
    (NEW.subscription_id, NEW.id, 'order_ready', v_weight_delta, v_pickups_delta,
     'Order #' || COALESCE(NEW.order_number::text, SUBSTRING(NEW.id::text, 1, 8))
       || ' ready for delivery'
       || CASE WHEN v_prior_applied > 0 THEN ' (re-fire, prior=' || v_prior_applied || ')' ELSE '' END
       || CASE WHEN v_overage_dollars > 0
               THEN ' (+$' || TO_CHAR(v_overage_dollars, 'FM999990.00') || ' lb-overage'
                    || CASE WHEN v_disc_on_new > 0 THEN ', -$' || TO_CHAR(v_disc_on_new, 'FM999990.00') || ' discount' ELSE '' END
                    || ')'
               ELSE '' END);

  RETURN NEW;
END;
$function$;

-- ── B ── (programmatic patch of one statement, signature preserved)
DO $b$
DECLARE
  v_def  text;
  v_old  text := $o$  v_final_subscription_id := COALESCE(v_active_subscription_id, NEW.subscription_id);$o$;
  v_new  text := $n$  -- Session 294d: never carry forward a dead subscription.
  v_final_subscription_id := COALESCE(
    v_active_subscription_id,
    (SELECT s.id FROM subscriptions s
      WHERE s.id = NEW.subscription_id AND s.status IN ('active','past_due','paused')));

  -- The previous order was a subscription order but this customer is no longer on
  -- one: its $0 lines must not ride forward. Re-price from the current pricelist.
  IF v_final_subscription_id IS NULL AND NEW.subscription_id IS NOT NULL
     AND COALESCE(v_pricelist, '') <> 'Subscription' THEN
    DECLARE
      v_svc   RECORD;
      v_fee   NUMERIC;
      v_exempt BOOLEAN;
      v_keep  JSONB;
      v_pct   NUMERIC;
      v_dname TEXT;
      v_discb NUMERIC;
    BEGIN
      SELECT id, name, base_price, pricing_type INTO v_svc FROM services
       WHERE pricelist = COALESCE(v_pricelist, 'Delivery') AND is_active AND NOT is_addon
       ORDER BY sort_order, name LIMIT 1;
      IF v_svc.id IS NOT NULL THEN v_service_id := v_svc.id; END IF;

      SELECT COALESCE(fee_exempt, false) INTO v_exempt FROM customers WHERE id = NEW.customer_id;

      v_keep := COALESCE((SELECT jsonb_agg(elem)
                            FROM jsonb_array_elements(COALESCE(NEW.line_items, '[]'::jsonb)) t(elem)
                           WHERE elem->>'type' IN ('addon','addon_service','pref_service','same_day_surcharge')), '[]'::jsonb);

      IF v_svc.id IS NULL OR v_svc.pricing_type = 'per_lb' THEN
        v_line_items := v_keep;                -- priced at weigh-in, like Commercial
      ELSE
        v_line_items := jsonb_build_array(jsonb_build_object(
          'type', 'base',
          'label', v_svc.name || ' · ' || NEW.total_bags || ' bag' || CASE WHEN NEW.total_bags > 1 THEN 's' ELSE '' END
                   || ' × $' || TO_CHAR(v_svc.base_price, 'FM999990.00'),
          'amount', NEW.total_bags * v_svc.base_price,
          'taxable', false)) || v_keep;
        IF NOT v_exempt THEN
          SELECT amount INTO v_fee FROM service_fees
           WHERE name = 'Delivery Fee' AND is_active
             AND (pricelist = v_pricelist OR pricelist IS NULL)
           ORDER BY (pricelist = v_pricelist) DESC NULLS LAST LIMIT 1;
          IF COALESCE(v_fee, 0) > 0 THEN
            v_line_items := v_line_items || jsonb_build_array(jsonb_build_object(
              'type', 'delivery_fee', 'label', 'Delivery fee', 'amount', v_fee, 'taxable', false));
          END IF;
        END IF;
      END IF;

      SELECT d.value, d.name INTO v_pct, v_dname
        FROM customers c2 JOIN discounts d ON d.id = c2.discount_id AND d.active AND d.type = 'percent'
       WHERE c2.id = NEW.customer_id;
      SELECT COALESCE(sum((elem->>'amount')::numeric), 0) INTO v_discb
        FROM jsonb_array_elements(v_line_items) t(elem)
       WHERE elem->>'type' IN ('base','overage','addon','addon_service','pref_service');
      IF COALESCE(v_pct, 0) > 0 AND v_discb > 0 THEN
        v_line_items := v_line_items || jsonb_build_array(jsonb_build_object(
          'type', 'discount',
          'label', v_dname || ' (' || trim(to_char(v_pct, 'FM999990.##')) || '% off)',
          'amount', -round(v_discb * v_pct / 100.0, 2)));
      END IF;

      SELECT COALESCE(sum((elem->>'amount')::numeric), 0) INTO v_total_amount
        FROM jsonb_array_elements(v_line_items) t(elem);
    END;
  END IF;$n$;
BEGIN
  SELECT pg_get_functiondef('public.trg_create_recurring_order_fn'::regproc) INTO v_def;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'anchor statement not found exactly once in trg_create_recurring_order_fn';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$b$;

DO $a$
DECLARE s text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc WHERE proname = 'trg_create_recurring_order_fn';
  IF strpos(s, 'Session 294d: never carry forward a dead subscription') = 0 THEN
    RAISE EXCEPTION 'recurring patch missing';
  END IF;
  SELECT prosrc INTO s FROM pg_proc WHERE proname = 'apply_subscription_usage_fn';
  IF strpos(s, 'v_disc_on_new') = 0 OR strpos(s, '0+$') = 0 THEN
    RAISE EXCEPTION 'subscription usage patch missing';
  END IF;
END
$a$;

-- Rollback: SELECT def FROM _archive._fn_snapshot_294d; and EXECUTE each.
