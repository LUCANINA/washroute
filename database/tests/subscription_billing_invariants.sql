-- ============================================================================
-- A4 — Subscription billing regression invariants (session 168)
-- ============================================================================
-- A safe, READ-ONLY assertion script that locks in the billing behaviors that
-- today's bugs violated. Run it before/after any change to the subscription
-- billing path (picker, recurring trigger, intake rebuild, overage trigger,
-- charge-order). It RAISES on the first violation and is silent (NOTICE) when
-- everything holds, so it can be wired into the nightly-smoke-test edge function.
--
-- Why invariants instead of synthetic unit tests: the billing math lives inside
-- DB triggers, and this managed Postgres role can't suppress triggers
-- (session_replication_role) or take the locks needed to insert fixtures
-- cleanly. Asserting invariants over real data is safe, catches the bug CLASSES
-- structurally, and composes with database/audits/daily_audit.sql.
--
-- Run:  psql / Supabase SQL editor / execute_sql — just run the whole block.
-- Pass: completes with no error (NOTICE 'All subscription billing invariants PASS').
-- Fail: RAISE EXCEPTION naming the invariant + the offending count.
--
-- NOTE (A1 design constraint discovered while writing this): the orphaned
-- `compute_subscription_residual` RPC double-counts overage on the current
-- (v2) architecture — it sums the trigger-written `lb_overage` line as "other"
-- AND recomputes overage from weight (e.g. order #6533: real total $61, RPC
-- returns card_charge_total $116). Do NOT wire charge-order through it without
-- first reconciling overage ownership. The live, correct path is: the
-- apply_subscription_usage_fn trigger is the SOLE writer of `lb_overage` into
-- line_items + total_amount; charge-order charges total_amount.
-- ============================================================================

DO $$
DECLARE v_bad INT;
BEGIN
  -- INV1 — A subscription order must never carry more than one overage-type line.
  -- (Today's double-charge: intake wrote `overage` while the trigger wrote `lb_overage`.)
  SELECT count(*) INTO v_bad FROM orders o
   WHERE o.subscription_id IS NOT NULL AND jsonb_typeof(o.line_items)='array'
     AND (SELECT count(*) FROM jsonb_array_elements(o.line_items) li
            WHERE li->>'type' IN ('overage','lb_overage')) > 1;
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV1 FAIL: % subscription order(s) carry >1 overage line', v_bad; END IF;

  -- INV2 — A subscription order must never carry BOTH a legacy intake `overage`
  -- line AND a trigger `lb_overage` line (the exact double-charge signature).
  SELECT count(*) INTO v_bad FROM orders o
   WHERE o.subscription_id IS NOT NULL AND jsonb_typeof(o.line_items)='array'
     AND (SELECT bool_or(li->>'type'='overage')    FROM jsonb_array_elements(o.line_items) li)
     AND (SELECT bool_or(li->>'type'='lb_overage') FROM jsonb_array_elements(o.line_items) li);
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV2 FAIL: % subscription order(s) have BOTH overage + lb_overage', v_bad; END IF;

  -- INV3 — total_amount must equal the sum of line_items for subscription orders
  -- (catches drift between the headline total and the itemization; tip lives in
  -- tip_amount, credits/discounts don't appear in subscription line_items).
  SELECT count(*) INTO v_bad FROM orders o
   WHERE o.subscription_id IS NOT NULL AND jsonb_typeof(o.line_items)='array'
     AND abs(COALESCE(o.total_amount,0) - (SELECT COALESCE(SUM((li->>'amount')::numeric),0)
         FROM jsonb_array_elements(o.line_items) li)) > 0.01;
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV3 FAIL: % subscription order(s) total_amount != sum(line_items)', v_bad; END IF;

  -- INV4 — subscription usage can never be negative.
  SELECT count(*) INTO v_bad FROM subscriptions WHERE COALESCE(usage_lbs_this_period,0) < 0;
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV4 FAIL: % subscription(s) have negative usage_lbs_this_period', v_bad; END IF;

  -- INV5 — a base Wash & Fold line on a subscription order must be $0 (the plan
  -- absorbs base). Catches the "$59 instead of $0" pricelist bug at the data level.
  SELECT count(*) INTO v_bad FROM orders o
   WHERE o.subscription_id IS NOT NULL AND jsonb_typeof(o.line_items)='array'
     AND (SELECT bool_or(li->>'type'='base' AND (li->>'amount')::numeric > 0)
            FROM jsonb_array_elements(o.line_items) li);
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV5 FAIL: % subscription order(s) have a non-zero base line (pricelist not applied)', v_bad; END IF;

  -- INV6 — a subscription's previous_pricelist must never be 'Subscription'.
  -- That snapshot is what the cancel→revert restores at period end; if it's
  -- 'Subscription' the restore is self-referential (a no-op) and the customer
  -- stays on $0 free service after cancelling. (Root cause: stripe-webhook
  -- snapshotted the current pricelist without guarding it during a Test 1.1
  -- event resend. Guarded in source; this invariant locks it in.)
  SELECT count(*) INTO v_bad FROM subscriptions WHERE previous_pricelist = 'Subscription';
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV6 FAIL: % subscription(s) have previous_pricelist=''Subscription'' (cancel→revert would be a no-op)', v_bad; END IF;

  -- INV7 — no customer may sit on the $0 'Subscription' pricelist without an
  -- active/past_due/paused subscription paying for it (the cancel→revert
  -- failure surfaced as free service). Mirrors daily_audit CHECK 10.
  SELECT count(*) INTO v_bad FROM customers c
   WHERE c.pricelist = 'Subscription'
     AND NOT EXISTS (SELECT 1 FROM subscriptions s
                      WHERE s.customer_id = c.id AND s.status IN ('active','past_due','paused'));
  IF v_bad > 0 THEN RAISE EXCEPTION 'INV7 FAIL: % customer(s) on Subscription pricelist with no active subscription', v_bad; END IF;

  RAISE NOTICE 'All subscription billing invariants PASS';
END $$;
