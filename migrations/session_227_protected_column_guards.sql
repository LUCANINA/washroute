-- ============================================================================
-- session_227_protected_column_guards
-- APPLIED 2026-08-22 as: session_227f_trusted_write_flag,
--                        session_227g_protected_column_guards
--
-- WHY: session 227 locked the RPC layer, but `customers` and `orders` also carry
-- a plain table-level UPDATE grant to `authenticated`, with RLS policies of
-- USING (profile_id = auth.uid()) / (customer_id IN own customers). So a
-- logged-in customer could skip the RPC layer entirely and run, from the browser
-- console with the public anon key:
--     db.from('customers').update({credits: 99999}).eq('id', myId)
--     db.from('customers').update({subscription_plan_id: '<premium>'})...
--     db.from('orders').update({billing_status: 'paid'}).eq('id', myOrderId)
--     db.from('orders').update({total_amount: 0.01})   // after delivery
-- All four were verified exploitable against production before this migration,
-- and verified blocked after.
--
-- WHY A TRIGGER AND NOT COLUMN GRANTS: every app user — admin, driver, POS
-- device and customer alike — authenticates as the single Postgres role
-- `authenticated`, so a column-level GRANT cannot tell them apart. A trigger can.
--
-- ALLOWED PATHS (any one of these lets a protected column change):
--   * no PostgREST JWT context   -> pg_cron, psql
--   * jwt role = service_role    -> edge functions
--   * is_staff()                 -> admin/manager/laundry_tech/driver/attendant/pos_device
--   * washroute.trusted_write    -> set transaction-locally by assert_staff() and
--                                   enforce_caller_owns_order() once they have
--                                   authorised the caller, plus the four audited
--                                   customer-context writers listed in 212a.
--     A client cannot set this GUC: it is only ever written by SECURITY DEFINER
--     functions, and wr_allow_protected_write() is revoked from anon+authenticated.
--     It is transaction-local, and every PostgREST request is its own transaction,
--     so it cannot leak from an RPC call into a subsequent raw table write.
--
-- REVERSIBILITY: DROP the two triggers. Nothing else changes behaviour.
--   DROP TRIGGER trg_enforce_protected_customer_columns ON public.customers;
--   DROP TRIGGER trg_enforce_protected_order_columns    ON public.orders;
-- ============================================================================

-- ── 212a ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wr_allow_protected_write()
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$ SELECT set_config('washroute.trusted_write', 'on', true); $fn$;

REVOKE EXECUTE ON FUNCTION public.wr_allow_protected_write() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.wr_allow_protected_write() TO service_role;

-- assert_staff() and enforce_caller_owns_order() were re-created to call
-- wr_allow_protected_write() on every ALLOWED path (see 212a migration in the
-- Supabase migration history for the full bodies).
--
-- The four remaining legitimate writers of protected columns that run in a
-- *customer's* auth context, found by a pg_proc write-site audit rather than
-- guessed, each got `PERFORM public.wr_allow_protected_write();` injected at the
-- top of their body:
--   apply_signup_promo_credit      TRIGGER — writes customers.credits on signup
--   redeem_discount_code           customer RPC — credits a fixed-value coupon
--   update_customer_last_order_at  TRIGGER — bumps customers.total_orders on booking
--   record_pos_sale_ltv_fn         TRIGGER — bumps customers.lifetime_value at POS

-- ── 212b ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_protected_customer_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claims text; v_blocked text;
  v_protected text[] := ARRAY[
    'credits','lifetime_value','total_orders','pricelist','billing_type',
    'subscription_plan_id','subscription_plan','frozen_at','frozen_reason',
    'profile_id','route_template_override_id','sms_notifications_opt_out_at',
    'billing_group_id','default_site_id','fee_exempt','discount_id','risk_status',
    'stripe_customer_id','credit_expires_at','signup_promo_credit_at',
    'account_type','customer_type','is_retail','notes','ambassador_code',
    'cancelled_at','cancelled_by','cancelled_reason',
    'invoice_to_email','invoice_cc_emails','invoice_subject_template','invoice_body_template'
  ];
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN RETURN NEW; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('washroute.trusted_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF public.is_staff() THEN RETURN NEW; END IF;
  IF public.pos_session_active() THEN RETURN NEW; END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO v_blocked
  FROM jsonb_each(to_jsonb(NEW)) n
  JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
  WHERE n.value IS DISTINCT FROM o.value
    AND n.key = ANY (v_protected)
    -- Deliberate exception: the customer app's "switch to Pay As You Go" button
    -- clears the plan. Downgrading stays self-service; upgrading to a paid plan
    -- without paying does not.
    AND NOT (n.key = 'subscription_plan_id' AND NEW.subscription_plan_id IS NULL)
    AND NOT (n.key = 'subscription_plan'    AND NEW.subscription_plan = 'paygo');

  IF v_blocked IS NOT NULL THEN
    RAISE EXCEPTION 'Not permitted to change customer field(s): %', v_blocked
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.enforce_protected_customer_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_protected_customer_columns ON public.customers;
CREATE TRIGGER trg_enforce_protected_customer_columns
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_protected_customer_columns();


CREATE OR REPLACE FUNCTION public.enforce_protected_order_columns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claims text; v_blocked text;
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
    -- priced fields: editable by the customer only while still `scheduled`
    -- (the only state the customer app's edit sheet offers), never after
    'total_amount','line_items'
  ];
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN RETURN NEW; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('washroute.trusted_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF public.is_staff() THEN RETURN NEW; END IF;
  IF public.pos_session_active() THEN RETURN NEW; END IF;

  SELECT string_agg(n.key, ', ' ORDER BY n.key) INTO v_blocked
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.enforce_protected_order_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_protected_order_columns ON public.orders;
CREATE TRIGGER trg_enforce_protected_order_columns
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_protected_order_columns();
