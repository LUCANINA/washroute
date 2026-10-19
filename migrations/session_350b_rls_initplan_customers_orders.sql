-- Session 350b (2026-10-19): make the RLS checks on the Customers/Orders read path run once
-- per query instead of once per row.
--
-- Why: policies like `USING (is_admin())` call a SECURITY DEFINER function (not inlinable)
-- for EVERY row. Loading 1,000 customers with addresses + profiles ran is_admin() /
-- pos_session_active() / auth.uid() thousands of times: 398 ms of DB time per page.
-- Wrapping the zero-argument call as `(SELECT is_admin())` makes Postgres evaluate it once
-- (an InitPlan). Same page: 38 ms. Same result — the functions are STABLE and argument-free,
-- so their value cannot change within a statement.
--
-- Verified before applying (in a rolled-back transaction): row counts visible on all 7 tables
-- for one user of every role (admin, manager, laundry_tech, attendant, driver, cpa,
-- pos_device, a customer with orders) plus anon — identical before and after.
--
-- Scope: only these 7 tables. ~200 other policies on ~120 tables have the same pattern —
-- left for a separate, reviewed change.

CREATE TABLE IF NOT EXISTS _archive.rls_policies_20261019 AS
  SELECT now() AS snapshot_at, * FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('customers','addresses','profiles','orders','customer_payment_methods','sms_messages','email_messages');

DO $d$
DECLARE p record; nq text; nc text;
  re text := '(?<!SELECT )(\m(is_admin|is_staff|pos_session_active|can_write_bookkeeping|is_content_editor|is_cs_team|current_driver_id|current_customer_id)\(\)|auth\.uid\(\))';
BEGIN
  FOR p IN SELECT * FROM pg_policies WHERE schemaname = 'public'
           AND tablename IN ('customers','addresses','profiles','orders','customer_payment_methods','sms_messages','email_messages')
  LOOP
    nq := regexp_replace(p.qual, re, '(SELECT \1)', 'g');
    nc := regexp_replace(p.with_check, re, '(SELECT \1)', 'g');
    IF nq IS DISTINCT FROM p.qual THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', p.policyname, p.tablename, nq);
    END IF;
    IF nc IS DISTINCT FROM p.with_check THEN
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', p.policyname, p.tablename, nc);
    END IF;
  END LOOP;
END $d$;

-- Rollback: for each row in _archive.rls_policies_20261019,
--   ALTER POLICY <policyname> ON public.<tablename> USING (<qual>) [WITH CHECK (<with_check>)];
