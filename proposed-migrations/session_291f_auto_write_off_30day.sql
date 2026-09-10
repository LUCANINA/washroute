-- Session 291f — the nightly 30-day auto write-off.
--
-- RULE (David): an order delivered and unpaid for more than 30 days is written
-- off automatically. On-account excluded.
--
-- WHY 30 AND NOT 14. David asked for 14. Measured over the trailing 12 months
-- (non-on-account, delivered): 20 orders totalling $2,158.50 were paid MORE than
-- 14 days after delivery, most in the 15-21 day band -- that is the chase working
-- (text sent, card updated, charge goes through). A write-off is not a passive
-- label: written_off orders never grow a Charge button, so an auto write-off
-- actively BLOCKS the later collection. At 30 days only 3 orders / ~$450 of
-- later-paying money is caught, about 80% less damage. David agreed to 30.
--
-- THREE SAFETY RULES, none of them optional:
--
-- 1. A CHARGE MUST HAVE BEEN ATTEMPTED AND FAILED. An order sitting unpaid
--    because the autocharge sweep broke is a SYSTEM OUTAGE, not bad debt.
--    Without this guard an outage becomes permanent revenue loss plus a mass
--    customer freeze. Today 0 delivered-unpaid orders are in that state, so the
--    guard costs nothing and prevents a very bad day.
--
-- 2. A DAILY CAP THAT REFUSES AND ALERTS. If a run wants more than p_max orders,
--    something upstream broke -- customers did not all go bad overnight. It
--    writes a critical row to _health_alerts and does nothing else.
--
-- 3. p_dry_run DEFAULTS TO TRUE. A misconfigured cron job that forgets the
--    argument reports instead of destroying. Live mode must be asked for.
--
-- Delivered orders with no actual_delivery_at are skipped: unknown delivery time
-- fails safe, exactly like in_building_since in 291c.
--
-- Archived orders ARE included. Archiving files an order away, it does not settle
-- it (291d), so an archived unpaid order is still debt aging past 30 days.

CREATE OR REPLACE FUNCTION public.auto_write_off_stale_orders(
  p_dry_run boolean DEFAULT true,
  p_max     integer DEFAULT 5,
  p_days    integer DEFAULT 30
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claims   text := current_setting('request.jwt.claims', true);
  v_internal boolean := (v_claims IS NULL OR v_claims = '')
                        OR COALESCE(auth.role(), '') = 'service_role';
  r          record;
  v_count    integer := 0;
  v_total    numeric := 0;
  v_done     jsonb   := '[]'::jsonb;
  v_list     jsonb   := '[]'::jsonb;
BEGIN
  -- pg_cron reaches Postgres directly and has no JWT (see 291e-2). A human
  -- running this by hand must be admin/manager.
  IF NOT v_internal AND NOT EXISTS (
       SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role IN ('admin','manager')
     ) THEN
    RAISE EXCEPTION 'Only an admin or manager can run the auto write-off.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _awo_cand (
    id uuid, order_number integer, amount numeric, customer_id uuid,
    cust text, days integer
  ) ON COMMIT DROP;
  DELETE FROM _awo_cand;

  INSERT INTO _awo_cand
  SELECT o.id, o.order_number, COALESCE(o.total_amount,0), o.customer_id,
         COALESCE(c.first_name_cache,'') || ' ' || COALESCE(c.last_name_cache,''),
         (now()::date - o.actual_delivery_at::date)
  FROM public.orders o
  JOIN public.customers c ON c.id = o.customer_id
  WHERE o.status = 'delivered'
    AND COALESCE(o.billing_status,'') NOT IN ('paid','refunded','written_off')
    AND COALESCE(c.billing_type,'') <> 'on_account'
    AND o.actual_delivery_at IS NOT NULL
    AND o.actual_delivery_at < now() - make_interval(days => p_days)
    -- Guard 1: a charge was actually attempted and failed.
    AND (COALESCE(o.billing_status,'') = 'failed' OR o.charge_failed_at IS NOT NULL);

  SELECT count(*), COALESCE(sum(amount),0) INTO v_count, v_total FROM _awo_cand;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_number', order_number, 'amount', amount,
           'customer', btrim(cust), 'days_since_delivery', days)), '[]'::jsonb)
    INTO v_list FROM _awo_cand;

  IF v_count = 0 THEN
    RETURN jsonb_build_object('dry_run', p_dry_run, 'candidates', 0, 'written_off', 0);
  END IF;

  -- Guard 2: a spike means something upstream broke, not that customers went bad.
  IF v_count > p_max THEN
    INSERT INTO public._health_alerts (alert_type, severity, message, context)
    VALUES ('auto_writeoff_cap_exceeded', 'critical',
            format('Auto write-off REFUSED: %s orders (%s) would be written off, cap is %s. Something upstream probably broke — check the autocharge sweep before releasing this.',
                   v_count, to_char(v_total,'FM$999,999.00'), p_max),
            jsonb_build_object('candidates', v_list, 'cap', p_max, 'days', p_days));
    RETURN jsonb_build_object('refused', true, 'reason', 'cap exceeded',
                              'candidates', v_count, 'amount', v_total,
                              'cap', p_max, 'list', v_list);
  END IF;

  -- Guard 3: report-only unless explicitly told otherwise.
  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'candidates', v_count,
                              'amount', v_total, 'would_write_off', v_list);
  END IF;

  FOR r IN SELECT * FROM _awo_cand LOOP
    -- write_off_order is the ONLY path that writes off, so the order update and
    -- the customer freeze can never drift apart. It re-checks every rule itself.
    v_done := v_done || jsonb_build_array(
      public.write_off_order(
        r.id,
        format('Auto: delivered %s days ago, charge failed, uncollectible', r.days),
        'auto (30-day rule)')
    );
  END LOOP;

  INSERT INTO public._health_alerts (alert_type, severity, message, context)
  VALUES ('auto_writeoff_ran', 'warn',
          format('Auto write-off: %s order(s), %s, written off and %s account(s) frozen.',
                 v_count, to_char(v_total,'FM$999,999.00'), v_count),
          jsonb_build_object('written_off', v_done));

  RETURN jsonb_build_object('dry_run', false, 'candidates', v_count,
                            'amount', v_total, 'written_off', v_done);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.auto_write_off_stale_orders(boolean, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_write_off_stale_orders(boolean, integer, integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.auto_write_off_stale_orders(boolean, integer, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.auto_write_off_stale_orders(boolean, integer, integer) IS
  'Nightly bad-debt sweep. Writes off delivered orders unpaid for more than p_days (default 30) where a charge was attempted and FAILED, excluding on-account. Refuses and raises a critical _health_alerts row if more than p_max would go at once. Dry-run by default. Session 291f.';
