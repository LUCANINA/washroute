-- Session 168 — carry the same-day surcharge forward on recurring SUBSCRIPTION cycles.
--
-- The Subscription branch of trg_create_recurring_order_fn rebuilds line_items to
-- [base $0, delivery_fee $0] and sets total_amount=0. A subscriber who set up a
-- recurring same-day pickup still gets same-day delivery (the trigger preserves the
-- pickup->delivery time gap), but the $10 same_day_surcharge line was dropped, so
-- the card was never charged on recurring cycles — a revenue leak.
--
-- Fix: when the parent order carried a same_day_surcharge line, append it to the
-- rebuilt line_items and add its amount to total_amount. Mirrors how the
-- non-subscription branch already preserves the surcharge (it copies line_items).
-- Guarded by IF v_sd_item IS NOT NULL so non-same-day subscription orders are
-- unaffected. Everything else in the function is unchanged.
--
-- Reversibility: re-apply the prior function definition (Subscription branch
-- without the same-day carry-forward block).

CREATE OR REPLACE FUNCTION public.trg_create_recurring_order_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_interval INTERVAL;
  v_next_pickup_start   TIMESTAMPTZ;
  v_next_pickup_end     TIMESTAMPTZ;
  v_next_delivery_start TIMESTAMPTZ;
  v_next_delivery_end   TIMESTAMPTZ;
  v_turnaround INTERVAL;
  v_existing_count INTEGER;
  v_service_id UUID;
  v_pricelist TEXT;
  v_pricing_type TEXT;
  v_line_items JSONB;
  v_total_amount NUMERIC;
  v_tip_amount NUMERIC;
  v_tip_type   TEXT;
  v_cust_default_tip       NUMERIC;
  v_cust_default_tip_type  TEXT;
  v_override_tmpl_id  UUID;
  v_resolved_zone_id  UUID;
  v_snap RECORD;
  v_sub_fee_id UUID;
  v_sub_fee_amount NUMERIC;
  v_active_subscription_id UUID;
  v_final_subscription_id UUID;
  v_sd_item JSONB;
BEGIN
  IF NEW.status = 'delivered' THEN NULL;
  ELSIF NEW.status = 'skipped' THEN NULL;
  ELSIF NEW.status = 'pickup_failed' THEN NULL;
  ELSE RETURN NEW;
  END IF;

  IF OLD.status IN ('delivered', 'skipped', 'pickup_failed') THEN RETURN NEW; END IF;
  IF NEW.recurring_interval IS NULL OR NEW.recurring_interval = '' THEN RETURN NEW; END IF;

  CASE NEW.recurring_interval
    WHEN 'weekly'   THEN v_interval := INTERVAL '7 days';
    WHEN 'biweekly' THEN v_interval := INTERVAL '14 days';
    WHEN 'monthly'  THEN v_interval := INTERVAL '1 month';
    ELSE RETURN NEW;
  END CASE;

  v_next_pickup_start := NEW.pickup_window_start + v_interval;
  v_next_pickup_end   := NEW.pickup_window_end   + v_interval;

  IF EXTRACT(DOW FROM v_next_pickup_start AT TIME ZONE 'America/Los_Angeles') = 0 THEN
    v_next_pickup_start := v_next_pickup_start + INTERVAL '1 day';
    v_next_pickup_end   := v_next_pickup_end   + INTERVAL '1 day';
  END IF;

  -- Session 111: dedup check across all non-terminal statuses.
  SELECT COUNT(*) INTO v_existing_count
  FROM orders
  WHERE customer_id = NEW.customer_id
    AND status IN ('scheduled','picked_up','processing','ready_for_delivery','out_for_delivery')
    AND (pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date
      = (v_next_pickup_start AT TIME ZONE 'America/Los_Angeles')::date;

  IF v_existing_count > 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.delivery_window_start IS NOT NULL AND NEW.pickup_window_start IS NOT NULL THEN
    v_turnaround          := NEW.delivery_window_start - NEW.pickup_window_start;
    v_next_delivery_start := v_next_pickup_start + v_turnaround;
    v_next_delivery_end   := v_next_pickup_end   + v_turnaround;
  ELSE
    v_next_delivery_start := NULL;
    v_next_delivery_end   := NULL;
  END IF;

  IF v_next_delivery_start IS NOT NULL
     AND EXTRACT(DOW FROM v_next_delivery_start AT TIME ZONE 'America/Los_Angeles') = 0 THEN
    v_next_delivery_start := v_next_delivery_start + INTERVAL '1 day';
    v_next_delivery_end   := v_next_delivery_end   + INTERVAL '1 day';
  END IF;

  v_service_id := NEW.service_id;
  SELECT pricelist INTO v_pricelist FROM customers WHERE id = NEW.customer_id;

  IF v_pricelist = 'Commercial' THEN
    SELECT id INTO v_service_id FROM services
    WHERE pricelist = 'Commercial' AND is_active = true AND is_addon = false
    LIMIT 1;
    IF v_service_id IS NULL THEN v_service_id := NEW.service_id; END IF;

    SELECT pricing_type INTO v_pricing_type FROM services WHERE id = v_service_id;
    IF v_pricing_type = 'per_lb' THEN
      v_line_items   := '[]'::jsonb;
      v_total_amount := 0;
    ELSE
      v_line_items   := NEW.line_items;
      v_total_amount := NEW.total_amount;
    END IF;

  ELSIF v_pricelist = 'Subscription' THEN
    -- Session 167: Subscription branch — rebuild line_items from Subscription pricelist
    SELECT id INTO v_service_id FROM services
    WHERE pricelist = 'Subscription' AND is_active = true AND is_addon = false
    ORDER BY sort_order, name LIMIT 1;
    IF v_service_id IS NULL THEN v_service_id := NEW.service_id; END IF;

    -- Look up Delivery Fee for Subscription pricelist, fallback to global
    SELECT id, amount INTO v_sub_fee_id, v_sub_fee_amount
    FROM service_fees
    WHERE name = 'Delivery Fee'
      AND (pricelist = 'Subscription' OR pricelist IS NULL)
    ORDER BY (pricelist = 'Subscription') DESC NULLS LAST
    LIMIT 1;

    -- Rebuild line_items: base $0 + delivery fee (matches existing shape)
    v_line_items := jsonb_build_array(
      jsonb_build_object(
        'type', 'base',
        'label', 'Wash & Fold · ' || NEW.total_bags || ' bag' || CASE WHEN NEW.total_bags > 1 THEN 's' ELSE '' END || ' × $0.00',
        'amount', 0,
        'taxable', false
      )
    );
    IF v_sub_fee_id IS NOT NULL THEN
      v_line_items := v_line_items || jsonb_build_array(
        jsonb_build_object(
          'type', 'delivery_fee',
          'label', 'Delivery fee',
          'amount', COALESCE(v_sub_fee_amount, 0),
          'taxable', false
        )
      );
    END IF;
    v_total_amount := 0;

    -- Session 168: carry forward the same-day surcharge if the parent order had
    -- one, so recurring subscription same-day pickups keep billing the surcharge
    -- (the same-day delivery window itself is already preserved via the
    -- pickup->delivery turnaround interval above). Charged to the card by
    -- charge-order, which bills total_amount regardless of subscription.
    SELECT elem INTO v_sd_item
    FROM jsonb_array_elements(COALESCE(NEW.line_items, '[]'::jsonb)) elem
    WHERE elem->>'type' = 'same_day_surcharge'
    LIMIT 1;
    IF v_sd_item IS NOT NULL THEN
      v_line_items   := v_line_items || jsonb_build_array(v_sd_item);
      v_total_amount := v_total_amount + COALESCE((v_sd_item->>'amount')::numeric, 0);
    END IF;

    -- If parent didn't have subscription_id (customer just subscribed mid-chain), look it up
    IF NEW.subscription_id IS NULL THEN
      SELECT id INTO v_active_subscription_id
      FROM subscriptions
      WHERE customer_id = NEW.customer_id AND status = 'active'
      ORDER BY created_at DESC LIMIT 1;
    END IF;

  ELSE
    v_line_items   := NEW.line_items;
    v_total_amount := NEW.total_amount;
  END IF;

  v_final_subscription_id := COALESCE(v_active_subscription_id, NEW.subscription_id);

  -- Session 137: source the tip exclusively from the customer's profile default.
  SELECT default_tip, default_tip_type
    INTO v_cust_default_tip, v_cust_default_tip_type
  FROM customers WHERE id = NEW.customer_id;

  IF v_cust_default_tip IS NOT NULL AND v_cust_default_tip > 0 THEN
    v_tip_amount := v_cust_default_tip;
    v_tip_type   := CASE v_cust_default_tip_type
                      WHEN '%' THEN 'pct'
                      ELSE 'dollar'
                    END;
  ELSE
    v_tip_amount := 0;
    v_tip_type   := NULL;
  END IF;

  -- Session 129: resolve zone_id via override template if set.
  SELECT c.route_template_override_id INTO v_override_tmpl_id
  FROM customers c
  WHERE c.id = NEW.customer_id;

  IF v_override_tmpl_id IS NOT NULL THEN
    SELECT zone_id INTO v_resolved_zone_id
    FROM route_templates
    WHERE id = v_override_tmpl_id;

    IF v_resolved_zone_id IS NULL THEN
      v_resolved_zone_id := NEW.zone_id;
    END IF;
  ELSE
    v_resolved_zone_id := NEW.zone_id;
  END IF;

  -- ===================================================================
  -- Session 143: snap projected windows to the customer's home zone's
  -- nearest valid sub-window.
  -- ===================================================================
  IF v_resolved_zone_id IS NOT NULL THEN
    SELECT * INTO v_snap
    FROM public.snap_window_to_template(v_resolved_zone_id, v_next_pickup_start, v_override_tmpl_id);

    IF v_snap.snapped_start IS NOT NULL THEN
      v_next_pickup_start := v_snap.snapped_start;
      v_next_pickup_end   := v_snap.snapped_end;
    END IF;

    IF v_next_delivery_start IS NOT NULL THEN
      SELECT * INTO v_snap
      FROM public.snap_window_to_template(v_resolved_zone_id, v_next_delivery_start, v_override_tmpl_id);

      IF v_snap.snapped_start IS NOT NULL THEN
        v_next_delivery_start := v_snap.snapped_start;
        v_next_delivery_end   := v_snap.snapped_end;
      END IF;
    END IF;
  END IF;

  INSERT INTO orders (
    customer_id, service_id, status,
    total_bags, total_amount,
    pickup_window_start, pickup_window_end,
    delivery_window_start, delivery_window_end,
    recurring_interval, line_items, special_instructions,
    zone_id, pickup_address_id, delivery_address_id,
    source, subscription_id, is_subscription_order,
    tip_amount, tip_type
  ) VALUES (
    NEW.customer_id, v_service_id, 'scheduled',
    NEW.total_bags, v_total_amount,
    v_next_pickup_start, v_next_pickup_end,
    v_next_delivery_start, v_next_delivery_end,
    NEW.recurring_interval, v_line_items, NEW.special_instructions,
    v_resolved_zone_id, NEW.pickup_address_id, NEW.delivery_address_id,
    'recurring', v_final_subscription_id,
    CASE WHEN v_final_subscription_id IS NOT NULL THEN true ELSE COALESCE(NEW.is_subscription_order, false) END,
    v_tip_amount, v_tip_type
  );

  RETURN NEW;
END;
$function$;
