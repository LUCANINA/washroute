-- session280_subscription_overage_double_bill
--
-- WHY: subscription weight-overage was billed TWICE.
--   1. apply_subscription_usage_fn adds an `lb_overage` line to the order at
--      ready_for_delivery; charge-order collects it immediately.
--   2. The SAME amount was accrued into subscriptions.overage_amount_due and
--      attached again to the next Stripe renewal invoice by stripe-webhook
--      (invoice.created), or to a final invoice on cancellation.
--   12 customers were double-charged $1,113.75 between 2026-07-06 and 2026-09-07.
--
-- FIX: `overage_amount_due` now means exactly what its name says — overage that
-- is still OWED, i.e. raised on an order that never collected. It is MEASURED
-- from the orders themselves (never accrued in parallel), and any overage that
-- reaches a Stripe invoice is stamped on the order so it can never be billed
-- again. The invoice path survives only as the safety net for an order whose
-- card charge failed. A written-off order is forgiven and never re-billed.

-- 1 ── marker: this order's overage has been billed on a Stripe invoice.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS overage_invoiced_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.overage_invoiced_at IS
  'Set when this order''s lb_overage was billed on a Stripe subscription invoice '
  '(renewal or final). Non-null means it must never be billed again.';

-- 2 ── the single source of truth for "overage still owed".
CREATE OR REPLACE FUNCTION public.uncollected_subscription_overage(
  p_subscription_id  UUID,
  p_exclude_order_id UUID DEFAULT NULL
) RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT COALESCE(ROUND(SUM((li->>'amount')::NUMERIC), 2), 0)
  FROM orders o
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END
  ) li
  WHERE o.subscription_id = p_subscription_id
    AND li->>'type' = 'lb_overage'
    AND o.overage_invoiced_at IS NULL
    -- collected at the order, forgiven, or reversed → never owed on the invoice
    AND COALESCE(o.billing_status, '') NOT IN ('paid', 'refunded', 'written_off')
    AND (p_exclude_order_id IS NULL OR o.id <> p_exclude_order_id);
$fn$;

REVOKE EXECUTE ON FUNCTION public.uncollected_subscription_overage(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.uncollected_subscription_overage(UUID, UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.uncollected_subscription_overage(UUID, UUID) TO authenticated, service_role;

-- 3 ── keep subscriptions.overage_amount_due in step with the orders.
CREATE OR REPLACE FUNCTION public.resync_subscription_overage_due(p_subscription_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_due NUMERIC;
BEGIN
  IF p_subscription_id IS NULL THEN RETURN 0; END IF;
  v_due := public.uncollected_subscription_overage(p_subscription_id, NULL);
  UPDATE subscriptions
     SET overage_amount_due = v_due, updated_at = NOW()
   WHERE id = p_subscription_id
     AND overage_amount_due IS DISTINCT FROM v_due;
  RETURN v_due;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.resync_subscription_overage_due(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resync_subscription_overage_due(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.resync_subscription_overage_due(UUID) TO authenticated, service_role;

-- 4 ── claim + stamp, atomically. Replaces the webhook's old
--      `update overage_amount_due=0 where >0` race guard. Returns what may be
--      billed and which orders it covered, so a Stripe failure can release them.
CREATE OR REPLACE FUNCTION public.claim_subscription_overage(p_subscription_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ids    UUID[];
  v_amount NUMERIC := 0;
BEGIN
  IF p_subscription_id IS NULL THEN
    RETURN jsonb_build_object('amount', 0, 'order_ids', '[]'::jsonb);
  END IF;

  WITH claimable AS (
    SELECT DISTINCT o.id
    FROM orders o
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(o.line_items) = 'array' THEN o.line_items ELSE '[]'::jsonb END
    ) li
    WHERE o.subscription_id = p_subscription_id
      AND li->>'type' = 'lb_overage'
      AND o.overage_invoiced_at IS NULL
      AND COALESCE(o.billing_status, '') NOT IN ('paid', 'refunded', 'written_off')
  ), stamped AS (
    UPDATE orders o
       SET overage_invoiced_at = NOW()
      FROM claimable c
     -- the NULL check is repeated HERE on purpose: under READ COMMITTED a
     -- concurrent claim re-evaluates this predicate after the row lock is
     -- released, so the same overage can never be claimed twice.
     WHERE o.id = c.id
       AND o.overage_invoiced_at IS NULL
    RETURNING o.id, o.line_items
  ), per_order AS (
    SELECT st.id, ROUND(SUM((li->>'amount')::NUMERIC), 2) AS ovg
    FROM stamped st
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(st.line_items) = 'array' THEN st.line_items ELSE '[]'::jsonb END
    ) li
    WHERE li->>'type' = 'lb_overage'
    GROUP BY st.id
  )
  SELECT COALESCE(array_agg(id), '{}'::UUID[]), COALESCE(SUM(ovg), 0)
    INTO v_ids, v_amount
  FROM per_order;

  PERFORM public.resync_subscription_overage_due(p_subscription_id);

  RETURN jsonb_build_object(
    'amount',    COALESCE(v_amount, 0),
    'order_ids', to_jsonb(v_ids)
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.claim_subscription_overage(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_subscription_overage(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.claim_subscription_overage(UUID) TO service_role;

-- 5 ── release a claim when Stripe rejected the invoice item.
CREATE OR REPLACE FUNCTION public.release_subscription_overage(
  p_subscription_id UUID,
  p_order_ids       UUID[]
) RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN RETURN 0; END IF;
  UPDATE orders SET overage_invoiced_at = NULL WHERE id = ANY (p_order_ids);
  RETURN public.resync_subscription_overage_due(p_subscription_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.release_subscription_overage(UUID, UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_subscription_overage(UUID, UUID[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.release_subscription_overage(UUID, UUID[]) TO service_role;

-- 6 ── the order trigger stops ACCRUING overage and starts MEASURING it.
--      Only the final UPDATE ... overage_amount_due block changes; everything
--      else is byte-identical to the shipped function.
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
    v_weight_over_label := REGEXP_REPLACE(REGEXP_REPLACE(v_weight_over::TEXT, '0+$', ''), '\.$', '');
    v_line_items_clean := v_line_items_clean || jsonb_build_object(
      'type',   'lb_overage',
      'label',  'Subscription overage · ' || v_weight_over_label || ' lbs × $'
                || TO_CHAR(v_sub.overage_price_per_lb, 'FM999990.00') || '/lb',
      'amount', v_overage_dollars
    );
  END IF;

  NEW.line_items                     := v_line_items_clean;
  NEW.total_amount                   := GREATEST(0, COALESCE(NEW.total_amount, 0) - v_existing_overage + v_overage_dollars);
  NEW.subscription_usage_lbs_applied := v_weight;

  -- session 280: overage_amount_due is what is still OWED, measured from the
  -- orders — never a parallel accrual of what was already charged on them.
  -- This order is not yet collected, so its own overage counts until
  -- trg_orders_resync_subscription_overage sees the charge land.
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
               THEN ' (+$' || TO_CHAR(v_overage_dollars, 'FM999990.00') || ' lb-overage)'
               ELSE '' END);

  RETURN NEW;
END;
$function$;

-- 7 ── when an order's billing outcome lands, re-measure what is owed.
CREATE OR REPLACE FUNCTION public.resync_subscription_overage_on_order_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.subscription_id IS NOT NULL THEN
    PERFORM public.resync_subscription_overage_due(NEW.subscription_id);
  END IF;
  IF OLD.subscription_id IS NOT NULL AND OLD.subscription_id IS DISTINCT FROM NEW.subscription_id THEN
    PERFORM public.resync_subscription_overage_due(OLD.subscription_id);
  END IF;
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_orders_resync_subscription_overage ON public.orders;
CREATE TRIGGER trg_orders_resync_subscription_overage
AFTER UPDATE OF billing_status, billed_at, overage_invoiced_at, line_items, subscription_id
ON public.orders
FOR EACH ROW
WHEN (
  (OLD.billing_status      IS DISTINCT FROM NEW.billing_status)
  OR (OLD.billed_at        IS DISTINCT FROM NEW.billed_at)
  OR (OLD.overage_invoiced_at IS DISTINCT FROM NEW.overage_invoiced_at)
  OR (OLD.line_items       IS DISTINCT FROM NEW.line_items)
  OR (OLD.subscription_id  IS DISTINCT FROM NEW.subscription_id)
)
EXECUTE FUNCTION public.resync_subscription_overage_on_order_fn();

-- 8 ── a period roll no longer forgives genuinely-uncollected overage.
--      (It used to zero it, which was safe only because the webhook read the
--      column; the webhook now measures, so zeroing here would hide a real debt.)
CREATE OR REPLACE FUNCTION public.reset_subscription_usage_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
     AND NEW.current_period_end > OLD.current_period_end
  THEN
    INSERT INTO subscription_usage_log
      (subscription_id, order_id, event_type, weight_delta, pickups_delta, note)
    VALUES
      (NEW.id, NULL, 'period_reset',
       -COALESCE(OLD.usage_lbs_this_period, 0),
       -COALESCE(OLD.pickups_this_period, 0),
       'Billing period rolled to ' || NEW.current_period_end::date);
    NEW.usage_lbs_this_period := 0;
    NEW.pickups_this_period   := 0;
    -- session 280: overage_amount_due is measured from the orders and is NOT
    -- reset here. Anything still owed is still owed after the roll; anything
    -- collected already reads as 0.
  END IF;
  RETURN NEW;
END;
$function$;

-- 9 ── overage_invoiced_at is a money field: customers must not set it.
CREATE OR REPLACE FUNCTION public.enforce_protected_order_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims  text;
  v_blocked text;
  v_protected text[] := ARRAY[
    'billing_status','billed_at','billing_payment_method','billing_notes',
    'amount_refunded','stripe_payment_intent_id','payment_id','discount_id',
    'customer_id','order_number','subscription_id','is_subscription_order',
    'status','cancelled_by','driver_skip_reason','routing_error',
    'archived_at','archived_by','archived_reason',
    'weight_lbs','tax_amount','tip_amount','tip_type',
    'charge_failed_at','charge_in_progress_at','card_brand','card_last4',
    'rack_id','racked_at','folded_by_id','folded_at','site_id','pos_shift_id',
    'ready_for_delivery_at','subscription_usage_lbs_applied',
    'actual_pickup_at','actual_delivery_at','source',
    'overage_invoiced_at',
    -- priced fields: editable by the customer only while still `scheduled`
    -- (that is the only state the customer app's edit sheet offers), never after
    'total_amount','line_items'
  ];
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN RETURN NEW; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('washroute.trusted_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF public.is_staff() THEN RETURN NEW; END IF;
  IF public.pos_session_active() THEN RETURN NEW; END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key)
    INTO v_blocked
  FROM jsonb_each(to_jsonb(NEW)) n
  JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
  WHERE n.value IS DISTINCT FROM o.value
    AND n.key = ANY (v_protected)
    AND NOT (n.key IN ('total_amount','line_items')
             AND OLD.status = 'scheduled' AND NEW.status = 'scheduled');

  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'Not permitted to change order field(s): %', v_blocked
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

-- 10 ── backfill: bring every subscription's overage_amount_due onto the
--       measured basis. Snapshot already taken in
--       _resync_subscription_overage_20260908.
UPDATE subscriptions s
   SET overage_amount_due = public.uncollected_subscription_overage(s.id, NULL),
       updated_at = NOW()
 WHERE s.overage_amount_due IS DISTINCT FROM public.uncollected_subscription_overage(s.id, NULL);

-- 11 ── assert the shape we just installed.
DO $assert$
BEGIN
  IF (SELECT COUNT(*) FROM pg_proc WHERE proname = 'uncollected_subscription_overage') = 0 THEN
    RAISE EXCEPTION 'uncollected_subscription_overage missing';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname = 'apply_subscription_usage_fn'),
            'uncollected_subscription_overage') = 0 THEN
    RAISE EXCEPTION 'apply_subscription_usage_fn was not rewritten';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname = 'reset_subscription_usage_fn'),
            'overage_amount_due    := 0') > 0 THEN
    RAISE EXCEPTION 'reset_subscription_usage_fn still zeroes overage_amount_due';
  END IF;
  IF strpos((SELECT p.prosrc FROM pg_proc p
               JOIN pg_trigger t ON t.tgfoid = p.oid
               JOIN pg_class  c ON c.oid = t.tgrelid
              WHERE c.relname = 'orders'
                AND t.tgname = 'trg_enforce_protected_order_columns'),
            'overage_invoiced_at') = 0 THEN
    RAISE EXCEPTION 'overage_invoiced_at not added to the LIVE protected column list';
  END IF;
END
$assert$;
