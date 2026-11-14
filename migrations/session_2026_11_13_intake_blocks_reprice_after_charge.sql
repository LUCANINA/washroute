-- Session 2026-11-13. record_order_intake now REFUSES to raise the price of an
-- already-charged order. Completes session 334 (which blocked the downward
-- direction) and replaces session 362's "log it, don't block it" on the upward one.
--
-- WHY. David's call 2026-11-13, reversing 2026-10-26. Session 362 relied on the
-- billing_discrepancy event + audit check 26 to get the money collected. It never
-- was. Orders charged since 2026-10-14, re-priced after the charge, still open:
--   #18478 Mark Stradling  -$30   (event logged, never acted on)
--   #17593 Morgan Connolly -$30
--   #18165 Jenny Brandt     -$9
-- plus #8619 Bridget Guerra (Jul 7): charged $145.95, re-intake to $77.95, the
-- $68 difference never refunded.
--
-- WHAT STILL WORKS. Only a save that CHANGES what the card owes is refused:
--   * same-price re-save (re-rack loops through Intake): v_uncollected <= 0 -> passes
--   * refund-first-then-lower (manager refunds, tech re-saves at the lower price):
--     passes the session 334 guard exactly as today
--   * credit-only / $0-card orders: v_card_collected = 0 -> neither guard runs
-- Re-racking itself never calls this function (saveRacking re_rack branch).
--
-- THE TEST is session 362's own v_uncollected (card + forward credit), measured
-- 6/6 real on 2,112 orders. Since 2026-10-26 it has fired exactly once: #18478.
--
-- Callers: admin-dashboard saveIntake() and pos/index.html intake. Both show
-- error.message verbatim and re-enable Save. A RAISE rolls back the whole call,
-- so a refused save changes nothing.
--
-- Method: rewrite from pg_get_functiondef() so signature, defaults, SECURITY
-- DEFINER and search_path survive byte-for-byte; snapshot first; assert after.

DO $mig$
DECLARE
  v_def    text;
  v_anchor text := $a$    v_uncollected := ROUND(v_new_charge - v_card_collected - COALESCE(p_credit_applied, 0), 2);
$a$;
  v_guard  text := $g$    v_uncollected := ROUND(v_new_charge - v_card_collected - COALESCE(p_credit_applied, 0), 2);

    -- Session 2026-11-13: BLOCK the upward re-price (David's call, reversing 2026-10-26).
    IF v_uncollected > 0.01 THEN
      RAISE EXCEPTION
        'Order #% has already been charged $%. This save would raise the price by $%, which the card will never be charged. Save it at the original price, or ask a manager to adjust the bill.',
        v_order.order_number,
        TO_CHAR(v_card_collected, 'FM999990.00'),
        TO_CHAR(v_uncollected, 'FM999990.00')
        USING ERRCODE = 'P0001',
              HINT    = 'Nothing was saved. Re-racking does not need a new weigh-in.';
    END IF;
$g$;
BEGIN
  SELECT pg_get_functiondef('public.record_order_intake(uuid,numeric,integer,numeric,jsonb,uuid,uuid,boolean,text,numeric,uuid,text)'::regprocedure)
    INTO v_def;

  INSERT INTO _archive._backup_function_defs (function_name, definition)
  VALUES ('record_order_intake (before session_2026_11_13 reprice block)', v_def);

  IF strpos(v_def, v_anchor) = 0 THEN
    RAISE EXCEPTION 'anchor line not found in record_order_intake -- function changed since review';
  END IF;
  IF strpos(v_def, 'Session 2026-11-13: BLOCK') > 0 THEN
    RAISE EXCEPTION 'already applied';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_guard);

  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.record_order_intake(uuid,numeric,integer,numeric,jsonb,uuid,uuid,boolean,text,numeric,uuid,text)'::regprocedure),
            'Session 2026-11-13: BLOCK the upward re-price') = 0 THEN
    RAISE EXCEPTION 'post-check failed: guard not present';
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.record_order_intake(uuid,numeric,integer,numeric,jsonb,uuid,uuid,boolean,text,numeric,uuid,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_order_intake(uuid,numeric,integer,numeric,jsonb,uuid,uuid,boolean,text,numeric,uuid,text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_order_intake(uuid,numeric,integer,numeric,jsonb,uuid,uuid,boolean,text,numeric,uuid,text) TO authenticated, service_role;

-- Rollback: re-EXECUTE the newest _archive._backup_function_defs row whose
-- function_name starts 'record_order_intake (before session_2026_11_13'.
