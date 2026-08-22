-- APPLIED 2026-08-22 as five Supabase migrations, in this order:
--   session_227a_assert_staff_helper_and_backup
--   session_227b_install_staff_guard_on_mutation_rpcs
--   session_227c_fix2_phone_link_guard_dollar_quoted   (supersedes two earlier
--       attempts whose E'' escaping mangled the \D character class)
--   session_227d_grant_hardening
--   session_227e_unguard_address_cache_refresh         (see note at section 2)
-- This file is the consolidated, corrected record. The DB is the source of truth.
--
-- ⚠ SECTION 2 CORRECTION: _refresh_customer_address_cache was initially given the
-- assert_staff guard and then REVERTED, because the transitive-PERFORM audit found
-- it is called by the trigger function sync_customer_address_cache, which fires on
-- `addresses` — a table customers write themselves. Guarding it would have blocked
-- every customer from saving an address. It is excluded from the list below.
--
-- ============================================================================
-- session_227_rpc_authorization_guards
--
-- WHY: Every architectural mutation RPC (session 134–136 "one door" pattern) is
-- SECURITY DEFINER — which bypasses RLS — and carries EXECUTE for the
-- `authenticated` role. Only 4 of them (advance_order_status, reschedule_order,
-- save_order_address, skip_route_stop) actually check WHO is calling. The rest
-- are callable by ANY signed-in customer against ANY row.
--
-- Concretely, before this migration a logged-in customer could run:
--     db.rpc('adjust_customer_credits', {p_customer_id: <self>, p_amount: 10000, ...})
--     db.rpc('mark_orders_paid',       {p_order_ids: [<own unpaid orders>], ...})
--     db.rpc('cleanup_orphan_email_auth_users')            -- deletes auth users
--     db.rpc('record_order_intake',    {<any order>, <any price>})
-- ...from the browser console, with the public anon key.
--
-- The lock already existed (`enforce_caller_owns_order`, session 148) — it just
-- was never installed on most of the doors. This migration installs it.
--
-- WHAT:
--   1. New `assert_staff(text)` helper — the staff-only counterpart to the
--      existing order-scoped `enforce_caller_owns_order(uuid)`.
--   2. Injects `PERFORM assert_staff('<fn>')` at the top of 20 staff-only
--      mutation RPCs, programmatically from pg_get_functiondef so signatures,
--      defaults, volatility and search_path are preserved byte-for-byte
--      (migration-review checklist item 5).
--   3. Binds `link_phone_auth_account` / `link_phone_auth_driver` to the
--      caller's own auth.uid() AND their own OTP-verified phone number.
--      Before this, either was a one-call account takeover, and the driver
--      variant additionally copied the matched profile's `role` — so knowing an
--      admin's phone number was a one-call privilege escalation to admin.
--   4. Revokes `anon` EXECUTE from every mutation RPC and from all
--      trigger-returning SECURITY DEFINER functions (PostgreSQL checks EXECUTE
--      on a trigger function at CREATE TRIGGER time, not at fire time, so this
--      cannot break a firing trigger).
--
-- BYPASSES (all three deliberate, all verified):
--   * no PostgREST JWT context  -> pg_cron, psql, and internal SECURITY DEFINER
--                                  call chains started by them
--   * jwt role = service_role   -> edge functions
--   * is_staff()                -> admin / manager / laundry_tech / driver /
--                                  attendant / pos_device
--
-- REVERSIBILITY: full. `_archive._backup_defs_session227` holds every original
-- pg_get_functiondef; replaying those statements restores the prior behaviour.
-- ============================================================================

-- ── 0. Snapshot every definition we are about to rewrite ────────────────────
CREATE SCHEMA IF NOT EXISTS _archive;

CREATE TABLE IF NOT EXISTS _archive._backup_defs_session227 (
  proname     text,
  identity    text,
  def         text,
  captured_at timestamptz DEFAULT now()
);

INSERT INTO _archive._backup_defs_session227 (proname, identity, def)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid),
       pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = ANY (ARRAY[
    'adjust_customer_credits','mark_orders_paid','apply_customer_credit_to_order',
    'refund_order_credits','recall_delivered_order','record_order_intake','rack_order',
    'complete_route_stop','undo_stop_completion','reoptimize_active_routes',
    'assign_order_launderers','clear_shift_bag_check','rollback_order_to_on_hold',
    'cleanup_orphan_email_auth_users','snapshot_staff_counts',
    '_refresh_customer_address_cache','auto_fail_expired_orders',
    'flag_delivery_orphaned_orders','record_sms_delivery_status','reschedule_order_leg',
    'link_phone_auth_account','link_phone_auth_driver'
  ]);


-- ── 1. The staff guard ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_staff(p_fn text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_claims text;
BEGIN
  v_claims := current_setting('request.jwt.claims', true);

  -- No PostgREST context at all: pg_cron, a psql session, or an internal
  -- SECURITY DEFINER chain started by one of those. Allow.
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  -- Edge functions authenticate with the service role key.
  IF COALESCE(auth.role(), '') = 'service_role' THEN
    RETURN;
  END IF;

  -- admin / manager / laundry_tech / driver / attendant / pos_device
  IF public.is_staff() THEN
    RETURN;
  END IF;

  RAISE EXCEPTION 'Not authorized to call %', COALESCE(p_fn, 'this function')
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.assert_staff(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assert_staff(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.assert_staff(text) TO authenticated, service_role;


-- ── 2. Install the guard on the staff-only mutation RPCs ────────────────────
-- Deliberately NOT in this list, and why:
--   advance_order_status / reschedule_order / save_order_address /
--     skip_route_stop          -> already call enforce_caller_owns_order
--                                 (owner-or-staff; customers legitimately use them)
--   reconcile_order_stops      -> PERFORMed by reschedule_order on a customer's
--                                 own reschedule; guarded separately below
--   auto_route_order, snap_window_to_template, trg_* and other trigger fns
--                              -> fire on customer booking paths
--   customers_in_zone, audit_* -> LANGUAGE sql, cannot host a PERFORM;
--                                 handled by the anon/authenticated revoke below
DO $do$
DECLARE
  r     record;
  v_def text;
  v_pos int;
  v_n   int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      AND p.proname = ANY (ARRAY[
        'adjust_customer_credits','mark_orders_paid','apply_customer_credit_to_order',
        'refund_order_credits','recall_delivered_order','record_order_intake','rack_order',
        'complete_route_stop','undo_stop_completion','reoptimize_active_routes',
        'assign_order_launderers','clear_shift_bag_check','rollback_order_to_on_hold',
        'cleanup_orphan_email_auth_users','snapshot_staff_counts',
        'auto_fail_expired_orders',
        'flag_delivery_orphaned_orders','record_sms_delivery_status','reschedule_order_leg'
      ])
    ORDER BY p.proname
  LOOP
    IF r.prosrc ~ 'assert_staff' THEN
      RAISE NOTICE 'skip (already guarded): %', r.proname;
      CONTINUE;
    END IF;

    v_pos := position(E'\nBEGIN\n' IN r.def);
    IF v_pos = 0 THEN
      RAISE EXCEPTION 'guard-inject: no top-level BEGIN found in %', r.proname;
    END IF;

    -- Safety: everything before the body's BEGIN must be a DECLARE block only.
    -- If a nested BEGIN ever came first, this refuses rather than corrupting.
    IF substring(r.prosrc FROM 1 FOR position(E'\nBEGIN\n' IN r.prosrc))
       !~* '^[[:space:]]*(DECLARE[[:space:]])?[^;]*(;[^;]*)*$' THEN
      RAISE EXCEPTION 'guard-inject: unexpected body shape in %', r.proname;
    END IF;

    v_def := overlay(
      r.def
      PLACING E'\nBEGIN\n  PERFORM public.assert_staff(''' || r.proname || E''');\n'
      FROM v_pos
      FOR  length(E'\nBEGIN\n')
    );

    EXECUTE v_def;
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'assert_staff guard injected into % function(s)', v_n;
END
$do$;


-- ── 2b. reconcile_order_stops: owner-or-staff, not staff-only ───────────────
-- reschedule_order (a legitimate customer action) PERFORMs it, so the caller's
-- auth context is the customer's. enforce_caller_owns_order is the right lock.
DO $do$
DECLARE
  r     record;
  v_def text;
  v_pos int;
BEGIN
  SELECT p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) AS def
    INTO r
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'reconcile_order_stops'
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql');

  IF NOT FOUND THEN
    RAISE NOTICE 'reconcile_order_stops not found — skipping';
    RETURN;
  END IF;
  IF r.prosrc ~ 'enforce_caller_owns_order' THEN
    RAISE NOTICE 'reconcile_order_stops already guarded';
    RETURN;
  END IF;

  v_pos := position(E'\nBEGIN\n' IN r.def);
  IF v_pos = 0 THEN
    RAISE EXCEPTION 'guard-inject: no top-level BEGIN in reconcile_order_stops';
  END IF;

  v_def := overlay(
    r.def
    PLACING E'\nBEGIN\n  PERFORM public.enforce_caller_owns_order(p_order_id);\n'
    FROM v_pos
    FOR  length(E'\nBEGIN\n')
  );
  EXECUTE v_def;
END
$do$;


-- ── 3. Bind the phone-link RPCs to the caller's own verified identity ───────
-- Before: link_phone_auth_account(p_phone_digits, p_new_profile_id) repointed
-- customers.profile_id to ANY profile id supplied by ANY caller, including anon.
-- link_phone_auth_driver additionally copied the matched profile's `role` into
-- the new profile — so an attacker who knew a manager's or admin's phone number
-- could hand themselves that role.
-- After: the caller must be the profile being linked, AND the phone must be the
-- one their own auth user has already confirmed via OTP.
DO $do$
DECLARE
  r     record;
  v_def text;
  v_pos int;
  -- Dollar-quoted, NOT an E'' string: E-string escape processing silently
  -- collapses the \D character class (first attempt produced 'D', a retry with
  -- doubled backslashes produced '\\D'). Both were caught by asserting on the
  -- resulting prosrc; keep this dollar-quoted.
  v_guard text := $g$
BEGIN
  IF p_new_profile_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You may only link your own account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u
    WHERE u.id = auth.uid()
      AND u.phone_confirmed_at IS NOT NULL
      AND RIGHT(regexp_replace(u.phone, '\D', '', 'g'), 10)
        = RIGHT(regexp_replace(p_phone_digits, '\D', '', 'g'), 10)
  ) THEN
    RAISE EXCEPTION 'phone does not match the verified caller'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
$g$;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosrc, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('link_phone_auth_account', 'link_phone_auth_driver')
  LOOP
    IF r.prosrc ~ 'phone does not match' THEN
      RAISE NOTICE 'skip (already bound): %', r.proname;
      CONTINUE;
    END IF;

    v_pos := position(E'\nBEGIN\n' IN r.def);
    IF v_pos = 0 THEN
      RAISE EXCEPTION 'guard-inject: no top-level BEGIN in %', r.proname;
    END IF;

    v_def := overlay(r.def PLACING v_guard FROM v_pos FOR length(E'\nBEGIN\n'));
    EXECUTE v_def;
  END LOOP;
END
$do$;


-- ── 4. Grant hardening ──────────────────────────────────────────────────────
-- 4a. No mutation RPC needs the anon role. (Session 148 lesson F: REVOKE PUBLIC
--     alone is not sufficient in Supabase — anon is a separate grant.)
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname = ANY (ARRAY[
        'adjust_customer_credits','mark_orders_paid','apply_customer_credit_to_order',
        'refund_order_credits','recall_delivered_order','record_order_intake','rack_order',
        'complete_route_stop','undo_stop_completion','reoptimize_active_routes',
        'assign_order_launderers','clear_shift_bag_check','rollback_order_to_on_hold',
        'cleanup_orphan_email_auth_users','snapshot_staff_counts',
        '_refresh_customer_address_cache','auto_fail_expired_orders',
        'flag_delivery_orphaned_orders','record_sms_delivery_status','reschedule_order_leg',
        'reconcile_order_stops','advance_order_status','reschedule_order','save_order_address',
        'skip_route_stop','create_order_for_customer','customers_in_zone',
        'driver_stop_customer_ids','find_orphan_email_auth_user','end_pos_shift',
        'audit_subscription_pricelist_orphans','audit_subscriptions_missing_invoice',
        'delete_orders','delete_address','admin_reset_driver_password'
      ])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END
$do$;

-- 4b. Trigger functions are never called through /rest/v1/rpc — PostgREST
--     refuses a `trigger` return type — and PostgreSQL checks EXECUTE on a
--     trigger function at CREATE TRIGGER time, not at fire time. Revoking here
--     is therefore inert at runtime and clears ~120 Supabase advisor warnings.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prosecdef
      AND pg_get_function_result(p.oid) = 'trigger'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
  END LOOP;
END
$do$;

-- 4c. link_phone_auth_* stay anon-callable ONLY if the app needs them pre-auth.
--     It does not: both call sites run after a successful OTP sign-in, so the
--     caller is `authenticated`. Revoke anon.
DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('link_phone_auth_account', 'link_phone_auth_driver')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon',   r.sig);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
  END LOOP;
END
$do$;


-- ── 5. search_path hardening for the 8 functions the advisor flagged ────────
ALTER FUNCTION public._dk_retention(timestamptz, timestamptz, timestamptz, timestamptz) SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public._dk_window(timestamptz, timestamptz) SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.audit_duplicate_services()                     SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.clear_payroll_attention_when_not_actionable()  SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.delivery_kpis(date, date)                      SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.enforce_no_holiday_orders()                    SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.enforce_pickup_before_delivery()               SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.is_holiday(date)                               SET search_path TO 'public', 'pg_temp';
