-- session_325c — counter sales are RETAIL: no plan overage, no plan usage.
-- APPLIED 2026-10-01 via apply_migration (same name)
--
-- DECISION (David, 2026-10-01): the subscription plan covers pickup & delivery.
-- A customer who drops laundry at the counter pays retail. So a walk-in order
-- must not receive a plan-rate `lb_overage` line, and its weight must not consume
-- the plan's pooled allowance.
--
-- WHAT WENT WRONG: order #16064 (2026-09-26, Olivia Ferguson) was rung up at the
-- POS on the RETAIL Wash & Fold service (11c2ceb7…, $2.00/lb → $138.00 for 69 lbs)
-- because pos/index.html:4341 only re-prices onto the customer's pricelist when
-- pricing_type matches, and Retail is per_lb while Subscription is per_bag — so it
-- silently kept retail pricing. apply_subscription_usage_fn then ALSO added a plan
-- overage line (69 lbs × $2.75 = $189.75), billing the same 69 lbs twice at an
-- effective $4.75/lb and inflating total_amount to $327.75. Her card was correctly
-- charged only the retail base + tip ($162.84).
--
-- Under this decision the $162.84 charge was right and the overage line was wrong.
-- The POS retail pricing is LEFT AS-IS: it is now the intended behaviour.
--
-- The guard is an early RETURN so it also skips the subscriptions usage/pickups
-- UPDATE and the subscription_usage_log row — a retail counter sale must not
-- consume plan allowance either.
--
-- DELIVERY ORDERS ARE UNAFFECTED (checked because a delivery order can be
-- processed at the Foothill site): "processed at a site" shows up as site_id being
-- set, while source stays customer_app/recurring/scheduled and pos_shift_id stays
-- NULL. All 2,328 counter sales have pos_shift_id; 0 of 12,914 delivery orders
-- have source='walk_in', and source has never been changed to 'walk_in' (0
-- order_events). So the guard cannot fire on a delivery order wherever it is
-- physically processed. The 209 subscription delivery orders carrying plan overage
-- keep it.
--
-- BLAST RADIUS: #16064 is the ONLY walk-in order ever linked to a subscription,
-- the only one carrying lb_overage, and the only one that consumed plan usage
-- (69 lbs). Verified all-time. No backfill needed for any other customer.
--
-- NOTE (not changed here): link_subscription_on_order_fn still links walk-in
-- orders of Subscription-pricelist customers and sets is_subscription_order.
-- Cosmetic for counter sales (a walk-in has no delivery fee to zero, and Retail
-- Wash & Fold has has_weight_overage=false so no pay-as-you-go 'overage' line is
-- produced). Left alone deliberately to keep this change small.
--
-- Rewritten from pg_get_functiondef() rather than retyping the body, so signature,
-- volatility, SECURITY DEFINER and search_path survive byte-for-byte (session 227
-- lesson). Dollar-quoted literals only. Asserted below; apply_migration runs in a
-- transaction so a failed assert rolls back.
--
-- ROLLBACK: re-apply the definition without the added line
--   IF COALESCE(NEW.source, '') = 'walk_in' THEN RETURN NEW; END IF;

DO $do$
DECLARE
  v_def    text;
  v_n      int;
  v_anchor text := $a$  IF NEW.subscription_id IS NULL THEN RETURN NEW; END IF;$a$;
  v_repl   text := $g$  IF NEW.subscription_id IS NULL THEN RETURN NEW; END IF;

  -- session 325c: counter sales are retail. A walk-in never receives a plan-rate
  -- overage line and never consumes the plan's pooled allowance.
  IF COALESCE(NEW.source, '') = 'walk_in' THEN RETURN NEW; END IF;$g$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'apply_subscription_usage_fn';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'apply_subscription_usage_fn not found';
  END IF;

  IF strpos(v_def, $w$'walk_in'$w$) <> 0 THEN
    RAISE EXCEPTION 'function already references walk_in — refusing to double-patch';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'anchor matched % times, expected exactly 1', v_n;
  END IF;

  EXECUTE replace(v_def, v_anchor, v_repl);
END
$do$;

-- Assert the rewrite landed. strpos, not LIKE (LIKE treats backslash as escape).
DO $do$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src
  FROM pg_proc
  WHERE pronamespace = 'public'::regnamespace
    AND proname = 'apply_subscription_usage_fn';

  IF strpos(v_src, $n$IF COALESCE(NEW.source, '') = 'walk_in' THEN RETURN NEW; END IF;$n$) = 0 THEN
    RAISE EXCEPTION 'guard missing after rewrite — rolling back';
  END IF;

  IF strpos(v_src, $n$v_overage_dollars   := ROUND(v_weight_over * v_sub.overage_price_per_lb, 2);$n$) = 0 THEN
    RAISE EXCEPTION 'original overage maths missing after rewrite — rolling back';
  END IF;
END
$do$;
