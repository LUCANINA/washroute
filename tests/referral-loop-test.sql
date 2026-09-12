-- Referral program — end-to-end loop test. Session 292, 2026-09-11.
--
-- Run it in the Supabase SQL editor, or through execute_sql, ANY TIME. It is safe
-- against production by construction: every write happens inside one transaction
-- that ends with RAISE EXCEPTION, so the whole thing rolls back and the test
-- output arrives as the error message. Nothing is left behind and no customer is
-- ever messaged — the notification rows roll back with everything else.
--
-- It temporarily flips referral_config.enabled to true inside that transaction,
-- which is how the payment trigger gets exercised while the program is still off
-- in production.
--
-- Two harmless side effects survive the rollback, because sequences don't roll
-- back: the orders order_number identity advances by two, and the same for any
-- other sequence touched. Order numbers skip. That is all.
--
-- Expected output, all twelve lines:
--   1.  claim: ok=true friend credits=25
--   2.  re-claim refused: already_referred
--   3.  self-referral refused: self_referral
--   4.  after FAILED charge: referrer credits=0, referral still 'claimed'
--   5.  after PAID: referrer credits=25.00, referral 'qualified'
--   6.  credit_add ledger rows for the pair: 2
--   7.  after a SECOND paid order: referrer credits unchanged
--   8.  a customer cannot edit the terms
--   9.  an admin can
--   10. an absurd amount is refused
--   11. an unknown setting key is refused
--   12. referral_qualify_failed alerts: 0

DO $t$
DECLARE
  v_log        text := E'\n=== REFERRAL LOOP TEST (all rolled back) ===\n';
  v_cust_prof  uuid;
  v_admin_prof uuid;
  v_service    uuid;
  v_referrer   uuid;
  v_friend     uuid;
  v_order      uuid;
  v_res        jsonb;
  v_credits    numeric;
  v_status     text;
BEGIN
  -- A profile to act as. Prefer one with no customer row (customers.profile_id is
  -- unique); otherwise borrow one — also rolled back.
  SELECT p.id INTO v_cust_prof FROM public.profiles p
   WHERE p.role = 'customer'
     AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.profile_id = p.id)
   LIMIT 1;
  IF v_cust_prof IS NULL THEN
    SELECT id INTO v_cust_prof FROM public.profiles WHERE role = 'customer' LIMIT 1;
    UPDATE public.customers SET profile_id = NULL WHERE profile_id = v_cust_prof;
  END IF;
  SELECT id INTO v_admin_prof FROM public.profiles WHERE role = 'admin' LIMIT 1;
  SELECT id INTO v_service    FROM public.services LIMIT 1;

  UPDATE public.settings
     SET referral_config = referral_config || '{"enabled":true}'::jsonb
   WHERE id = 1;

  INSERT INTO public.customers (first_name_cache, last_name_cache, phone_cache)
  VALUES ('Testreferrer', 'Zzz', '5105550001') RETURNING id INTO v_referrer;
  INSERT INTO public.customers (first_name_cache, last_name_cache, phone_cache, profile_id)
  VALUES ('Testfriend', 'Zzz', '5105550002', v_cust_prof) RETURNING id INTO v_friend;
  INSERT INTO public.referral_codes (customer_id, code) VALUES (v_referrer, 'TESTREF999');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cust_prof)::text, true);

  v_res := public.claim_referral_code('testref999', v_friend);   -- lower case on purpose
  SELECT credits INTO v_credits FROM public.customers WHERE id = v_friend;
  v_log := v_log || format('1. claim: ok=%s friend credits=%s | %s%s', v_res->>'ok', v_credits, v_res->>'message', E'\n');

  v_res := public.claim_referral_code('TESTREF999', v_friend);
  v_log := v_log || format('2. re-claim refused: ok=%s (%s)%s', v_res->>'ok', v_res->>'error', E'\n');

  INSERT INTO public.referral_codes (customer_id, code) VALUES (v_friend, 'TESTSELF999');
  v_res := public.claim_referral_code('TESTSELF999', v_friend);
  v_log := v_log || format('3. self-referral refused: ok=%s (%s)%s', v_res->>'ok', v_res->>'error', E'\n');

  INSERT INTO public.orders (customer_id, service_id, status, total_amount, billing_status)
  VALUES (v_friend, v_service, 'ready_for_delivery', 80, NULL) RETURNING id INTO v_order;
  UPDATE public.orders SET billing_status = 'failed' WHERE id = v_order;
  SELECT credits INTO v_credits FROM public.customers WHERE id = v_referrer;
  SELECT status  INTO v_status  FROM public.referrals WHERE referred_customer_id = v_friend;
  v_log := v_log || format('4. after FAILED charge: referrer credits=%s referral=%s%s', COALESCE(v_credits,0), v_status, E'\n');

  UPDATE public.orders SET billing_status = 'paid', billed_at = now() WHERE id = v_order;
  SELECT credits INTO v_credits FROM public.customers WHERE id = v_referrer;
  SELECT status  INTO v_status  FROM public.referrals WHERE referred_customer_id = v_friend;
  v_log := v_log || format('5. after PAID: referrer credits=%s referral=%s%s', COALESCE(v_credits,0), v_status, E'\n');

  v_log := v_log || format('6. credit_add ledger rows for the pair: %s%s',
    (SELECT count(*) FROM public.customer_transactions
      WHERE customer_id IN (v_friend, v_referrer) AND type = 'credit_add'), E'\n');

  INSERT INTO public.orders (customer_id, service_id, status, total_amount, billing_status)
  VALUES (v_friend, v_service, 'ready_for_delivery', 90, NULL) RETURNING id INTO v_order;
  UPDATE public.orders SET billing_status = 'paid', billed_at = now() WHERE id = v_order;
  SELECT credits INTO v_credits FROM public.customers WHERE id = v_referrer;
  v_log := v_log || format('7. after a SECOND paid order: referrer credits=%s (unchanged expected)%s', COALESCE(v_credits,0), E'\n');

  v_res := public.set_referral_config('{"friend_credit":40}'::jsonb, 'Test');
  v_log := v_log || format('8. customer edits terms: ok=%s | %s%s', v_res->>'ok', v_res->>'message', E'\n');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_prof)::text, true);
  v_res := public.set_referral_config('{"friend_credit":30}'::jsonb, 'Test Admin');
  v_log := v_log || format('9. admin edits terms: ok=%s friend_credit=%s%s', v_res->>'ok', v_res->'config'->>'friend_credit', E'\n');
  v_res := public.set_referral_config('{"friend_credit":5000}'::jsonb, 'Test Admin');
  v_log := v_log || format('10. absurd amount refused: ok=%s | %s%s', v_res->>'ok', v_res->>'message', E'\n');
  v_res := public.set_referral_config('{"free_laundry":true}'::jsonb, 'Test Admin');
  v_log := v_log || format('11. unknown key refused: ok=%s | %s%s', v_res->>'ok', v_res->>'message', E'\n');

  v_log := v_log || format('12. referral_qualify_failed alerts: %s%s',
    (SELECT count(*) FROM public._health_alerts
      WHERE alert_type = 'referral_qualify_failed' AND created_at > now() - interval '5 minutes'), E'\n');

  RAISE EXCEPTION '%', v_log;   -- rolls the whole test back and prints the report
END
$t$;
