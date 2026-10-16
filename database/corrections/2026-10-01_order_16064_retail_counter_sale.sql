-- 2026-10-01 — one-off data correction, order #16064 (Olivia Ferguson)
-- APPLIED. Records only — NO money moved: no card charged, no refund issued,
-- no message sent to the customer. David's explicit instruction.
--
-- Context: see migrations/session_325c_no_plan_overage_on_walk_in_orders.sql.
-- Counter sales are retail, so the $189.75 plan-overage line that
-- apply_subscription_usage_fn added on top of the retail $2.00/lb base for the
-- same 69 lbs should never have existed. The card charge of $162.84
-- ($138.00 base + $24.84 tip) was correct all along.
--
-- BEFORE: total_amount 327.75, lb_overage line 189.75, collected 162.84,
--         subscription_usage_lbs_applied 69, sub usage 215 lbs, pickups 2,
--         overage_amount_due 189.75 (stale — uncollected_subscription_overage
--         already returned 0 because the order is billing_status='paid', so the
--         next resync would have silently zeroed it anyway)
-- AFTER:  total_amount 138.00, no lb_overage line, collected 162.84,
--         owed incl. tip 162.84 → gap $0.00,
--         subscription_usage_lbs_applied 0, sub usage 146 lbs, pickups 1,
--         overage_amount_due 0.00 (recomputed from the ledger, not assumed)
-- Daily audit check 26 dropped from 16 rows to 15 and no longer flags #16064.
--
-- The $0.00 "Delivery — included" line was left in place: it is written by
-- link_subscription_on_order_fn, is harmless at zero, and removing it was out of
-- scope for this correction.
--
-- Guarded on the exact pre-state so it cannot be replayed against a changed row.
-- Logged to order_events ('price_correction') and subscription_usage_log
-- ('manual_adjustment') BEFORE mutating, per the project rule.

BEGIN;

DO $g$
DECLARE v_total numeric; v_ovg numeric; v_applied numeric;
BEGIN
  SELECT o.total_amount, o.subscription_usage_lbs_applied,
         COALESCE((SELECT SUM((li->>'amount')::numeric)
                   FROM jsonb_array_elements(o.line_items) li
                   WHERE li->>'type'='lb_overage'),0)
    INTO v_total, v_applied, v_ovg
  FROM orders o WHERE o.order_number = 16064;
  IF v_total IS NULL THEN RAISE EXCEPTION 'order 16064 not found'; END IF;
  IF v_total <> 327.75 OR v_ovg <> 189.75 OR v_applied <> 69.00 THEN
    RAISE EXCEPTION 'order 16064 is not in the expected state (total=%, overage=%, applied=%) — aborting',
      v_total, v_ovg, v_applied;
  END IF;
END
$g$;

INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
SELECT o.id, 'price_correction',
       'Counter sales are retail (decision 2026-10-01): removed the $189.75 plan-overage line '
       || 'that apply_subscription_usage_fn added on top of the retail $2.00/lb base for the same '
       || '69 lbs. Card charge of $162.84 ($138.00 base + $24.84 tip) was correct and is unchanged. '
       || 'Plan allowance credited back 69 lbs. Cause fixed in migration session_325c.',
       '327.75', '138.00', 'Claude (daily bug check)'
FROM orders o WHERE o.order_number = 16064;

INSERT INTO subscription_usage_log
  (subscription_id, order_id, event_type, weight_delta, pickups_delta, note)
SELECT o.subscription_id, o.id, 'manual_adjustment', -69.00, -1,
       'Reversing plan usage from walk-in order #16064 — counter sales are retail, so a '
       || 'counter drop-off does not consume the plan allowance (see migration session_325c).'
FROM orders o WHERE o.order_number = 16064;

UPDATE orders o SET
  line_items = COALESCE((
    SELECT jsonb_agg(li ORDER BY ord)
    FROM jsonb_array_elements(o.line_items) WITH ORDINALITY AS t(li, ord)
    WHERE li->>'type' IS DISTINCT FROM 'lb_overage'
  ), '[]'::jsonb),
  total_amount = 138.00,
  subscription_usage_lbs_applied = 0,
  updated_at = NOW()
WHERE o.order_number = 16064;

UPDATE subscriptions s SET
  usage_lbs_this_period = GREATEST(0, COALESCE(s.usage_lbs_this_period,0) - 69.00),
  pickups_this_period   = GREATEST(0, COALESCE(s.pickups_this_period,0) - 1),
  updated_at            = NOW()
WHERE s.id = (SELECT subscription_id FROM orders WHERE order_number = 16064);

SELECT public.resync_subscription_overage_due(
  (SELECT subscription_id FROM orders WHERE order_number = 16064));

COMMIT;
