-- Session 170 — Subscription orders always show a single "Delivery — included" $0 line.
--
-- Extends link_subscription_on_order_fn (the session-169 BEFORE INSERT/UPDATE
-- trigger that links subscriptions + zeroes delivery fees) so that EVERY
-- subscription order carries exactly one delivery_fee line at $0 labeled
-- "Delivery — included":
--   * sum any nonzero delivery_fee lines and subtract from total (existing)
--   * relabel + zero every existing delivery_fee line
--   * if no delivery_fee line exists, append one at $0
--
-- Why: orders booked via a path that never added a delivery line (admin intake)
-- showed nothing, while customer-app orders showed a $0 line — inconsistent
-- receipts. Now the line is guaranteed and consistently labeled. Idempotent.
--
-- Applied via apply_migration on 2026-06-08. Backfill of existing subscription
-- orders done separately:  UPDATE orders SET line_items = line_items
--                          WHERE is_subscription_order = true;  -- re-fires the trigger

CREATE OR REPLACE FUNCTION public.link_subscription_on_order_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pricelist TEXT;
  v_sub_id    UUID;
  v_deliv     NUMERIC;
  v_has_deliv BOOLEAN;
BEGIN
  IF NEW.subscription_id IS NULL AND NEW.customer_id IS NOT NULL THEN
    SELECT pricelist INTO v_pricelist FROM customers WHERE id = NEW.customer_id;
    IF v_pricelist = 'Subscription' THEN
      SELECT id INTO v_sub_id
      FROM subscriptions
      WHERE customer_id = NEW.customer_id
        AND status IN ('active','past_due','paused')
      ORDER BY created_at DESC
      LIMIT 1;
      IF v_sub_id IS NOT NULL THEN
        NEW.subscription_id := v_sub_id;
      END IF;
    END IF;
  END IF;

  -- Invariant: is_subscription_order mirrors whether the order is linked.
  NEW.is_subscription_order := (NEW.subscription_id IS NOT NULL);

  IF NEW.is_subscription_order AND jsonb_typeof(NEW.line_items) = 'array' THEN
    SELECT COALESCE(SUM((li->>'amount')::NUMERIC), 0) INTO v_deliv
    FROM jsonb_array_elements(NEW.line_items) li
    WHERE li->>'type' = 'delivery_fee'
      AND COALESCE((li->>'amount')::NUMERIC, 0) <> 0;

    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.line_items) li
      WHERE li->>'type' = 'delivery_fee'
    ) INTO v_has_deliv;

    IF v_has_deliv THEN
      SELECT jsonb_agg(
        CASE WHEN li->>'type' = 'delivery_fee'
             THEN jsonb_set(jsonb_set(li, '{amount}', '0'::jsonb), '{label}', '"Delivery — included"'::jsonb)
             ELSE li END
        ORDER BY ord
      ) INTO NEW.line_items
      FROM jsonb_array_elements(NEW.line_items) WITH ORDINALITY AS t(li, ord);
    ELSE
      NEW.line_items := NEW.line_items || jsonb_build_array(
        jsonb_build_object('type','delivery_fee','label','Delivery — included','amount',0)
      );
    END IF;

    IF v_deliv <> 0 THEN
      NEW.total_amount := GREATEST(0, COALESCE(NEW.total_amount, 0) - v_deliv);
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
