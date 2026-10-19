-- Session 350c (2026-10-19): same RLS once-per-query rewrite as 350b, for all remaining public
-- tables (175 policies, 96 tables). APPLIED to production via apply_migration.
-- Verified in a rolled-back REPEATABLE READ transaction: 936 visibility checks (every role +
-- anon, every affected table) identical before/after; rewritten policy text equivalent to the
-- original once the (SELECT ...) wrappers are removed. Snapshot: _archive.rls_policies_20261019_all.
CREATE TABLE IF NOT EXISTS _archive.rls_policies_20261019_all AS
  SELECT now() AS snapshot_at, * FROM pg_policies WHERE schemaname = 'public';

DO $d$
DECLARE p record; nq text; nc text;
  re text := '(?<!SELECT )(\m(is_admin|is_staff|pos_session_active|can_write_bookkeeping|is_content_editor|is_cs_team|current_driver_id|current_customer_id)\(\)|auth\.uid\(\))';
BEGIN
  FOR p IN SELECT * FROM pg_policies WHERE schemaname = 'public' LOOP
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
