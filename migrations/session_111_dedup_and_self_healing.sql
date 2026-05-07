-- Session 111 migration: recurring-order dedup hardening + routing_error self-healing
-- Context: Audit found Olivia Rosaldo-Pratt with duplicate recurring orders
-- (#1987 and #1989 both for 2026-04-15) AND order #1989 carrying a stale
-- 'over_capacity_after_reschedule' flag even though admin had manually
-- moved the stop to a route with capacity.
--
-- Three fixes:
--   1. Expand recurring-order dedup check to all non-terminal statuses.
--   2. Add partial UNIQUE index so duplicates can never be inserted even
--      under transaction races.
--   3. Self-healing trigger: when admin manually changes route_stops.route_id,
--      clear stale sync-set routing_error flags on the order.

-- ═══════════════════════════════════════════════════════════════════════
-- Part 1: Expand recurring-order dedup
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.trg_create_recurring_order_fn()
 RETURNS trigger
 LANGUAGE plpgsql
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

  -- ★ FIX (session 111): Dedup check now covers ALL non-terminal statuses,
  -- not just 'scheduled'. Previously, if the existing recurring occurrence
  -- for the target date was in picked_up/processing/ready_for_delivery/
  -- out_for_delivery, a duplicate would be created. This caused the
  -- Olivia Rosaldo-Pratt duplicate (#1987 + #1989 both for 2026-04-15).
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
  END IF;

  SELECT pricing_type INTO v_pricing_type FROM services WHERE id = v_service_id;
  IF v_pricing_type = 'per_lb' THEN
    v_line_items   := '[]'::jsonb;
    v_total_amount := 0;
  ELSE
    v_line_items   := NEW.line_items;
    v_total_amount := NEW.total_amount;
  END IF;

  IF NEW.tip_amount IS NOT NULL AND NEW.tip_amount > 0 THEN
    v_tip_amount := NEW.tip_amount;
    v_tip_type   := NEW.tip_type;
  ELSE
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
    NEW.zone_id, NEW.pickup_address_id, NEW.delivery_address_id,
    'recurring', NEW.subscription_id, NEW.is_subscription_order,
    v_tip_amount, v_tip_type
  );

  RETURN NEW;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- Part 2: Partial unique index (structural guarantee — survives races)
-- ═══════════════════════════════════════════════════════════════════════
-- Pre-checked: no existing violations in non-terminal statuses as of apply.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_recurring_no_dup
ON orders (
  customer_id,
  ((pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date)
)
WHERE source = 'recurring'
  AND status IN ('scheduled','picked_up','processing','ready_for_delivery','out_for_delivery');

-- ═══════════════════════════════════════════════════════════════════════
-- Part 3: Self-healing routing_error on manual stop moves
-- ═══════════════════════════════════════════════════════════════════════
-- When an admin manually moves a route_stop to a different route, they've
-- taken corrective action. If the order carries a sync-set routing_error
-- flag ('over_capacity_after_reschedule' or 'reschedule_no_matching_template'),
-- clear it — the admin has made a judgment call and the flag is now stale.
-- Non-sync flags (e.g., 'No zone assigned') are left untouched; those
-- represent structural problems the admin may or may not have addressed.

CREATE OR REPLACE FUNCTION public.clear_stale_routing_error_on_manual_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Only fire when route_id actually changed
  IF NEW.route_id IS NOT DISTINCT FROM OLD.route_id THEN
    RETURN NEW;
  END IF;

  -- Clear sync-set flags on the parent order.
  UPDATE orders
  SET routing_error = NULL
  WHERE id = NEW.order_id
    AND routing_error IN (
      'over_capacity_after_reschedule',
      'reschedule_no_matching_template'
    );

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_clear_stale_routing_error ON route_stops;
CREATE TRIGGER trg_clear_stale_routing_error
  AFTER UPDATE OF route_id ON route_stops
  FOR EACH ROW
  EXECUTE FUNCTION clear_stale_routing_error_on_manual_move();
