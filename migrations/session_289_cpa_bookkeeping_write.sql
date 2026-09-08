-- session_289_cpa_bookkeeping_write.sql
--
-- David, session 289: "remove the read-only part. The CPA needs to be able to
-- post from the Bookkeeping section."
--
-- WHAT THIS DOES
-- Adds public.can_write_bookkeeping() and repoints all 34 write policies on the
-- Bookkeeping tables at it, so the list of roles allowed to write is ONE fact in
-- the database instead of 34 copies of an inline EXISTS.
--
-- WHY A FUNCTION RATHER THAN 34 EDITED ARRAYS
-- Before this migration the same expression was written out 34 times, verified
-- byte-identical. Session 231's rule -- "a guard is only as good as the branch it
-- sits on" -- is unenforceable at 34 copies: the next permission change means
-- auditing all of them again, and a single missed policy is a silent hole that
-- only shows up as a 403 nobody can explain. It now reads the same way is_staff()
-- already does, which is the established pattern in this database.
--
-- THIS IS ONE OF THREE LAYERS. The dashboard's BK_WRITE_ROLES / _bkCanWrite() and
-- the edge functions' _shared/bk-write-roles.ts carry the same list. Change one,
-- change all three.
--
-- SCOPE / SAFETY
--   * No table, column, constraint or index is touched. Policies only.
--   * SELECT policies are untouched -- cpa could already read all of these.
--   * The 34 policies were confirmed byte-identical to the canonical expression
--     before rewriting, so nothing with an extra condition is being widened.
--   * Each policy keeps its own name, command and TO clause (some are TO public,
--     loan_contract_terms and loan_documents are TO authenticated).
--   * reconciliation_runs / reconciliation_findings / loan_book_balances /
--     loan_tie_outs / loan_attributions / payroll_notices / payroll_fix_status
--     have NO write policies at all (service-role writes only). Deliberately
--     left that way -- those are engine outputs, not human-edited records.
--
-- ROLLBACK: see the bottom of this file.

BEGIN;

-- 1. The one list. Mirrors public.is_staff() exactly in shape: STABLE,
--    SECURITY DEFINER (so it reads profiles without depending on the caller's
--    own RLS), explicit search_path.
CREATE OR REPLACE FUNCTION public.can_write_bookkeeping()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'manager', 'cpa')
  );
$function$;

-- GRANT discipline (session 148): REVOKE PUBLIC is not enough on its own,
-- Supabase grants anon separately.
REVOKE EXECUTE ON FUNCTION public.can_write_bookkeeping() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.can_write_bookkeeping() FROM anon;
GRANT  EXECUTE ON FUNCTION public.can_write_bookkeeping() TO authenticated, service_role;

-- 2. Repoint every Bookkeeping write policy at it.
DO $do$
DECLARE
  r        record;
  v_canon  text := '(EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY[''admin''::text, ''manager''::text])))))';
  v_roles  text;
  v_sql    text;
  v_count  int := 0;
BEGIN
  FOR r IN
    SELECT tablename, policyname, cmd, roles, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd IN ('INSERT','UPDATE','DELETE')
      AND (tablename LIKE 'loan%' OR tablename LIKE 'payroll%')
      AND (coalesce(qual,'') = v_canon OR coalesce(with_check,'') = v_canon)
    ORDER BY tablename, policyname
  LOOP
    -- Refuse rather than corrupt: only rewrite a policy whose every present
    -- clause is EXACTLY the canonical expression. Anything else is a policy
    -- doing something extra and must be looked at by a person.
    IF (r.qual       IS NOT NULL AND r.qual       <> v_canon)
    OR (r.with_check IS NOT NULL AND r.with_check <> v_canon) THEN
      RAISE EXCEPTION 'policy %.% has a non-canonical clause; refusing to rewrite',
        r.tablename, r.policyname;
    END IF;

    SELECT string_agg(quote_ident(x), ', ') INTO v_roles
    FROM unnest(r.roles::text[]) AS x;

    v_sql := format('DROP POLICY %I ON public.%I;', r.policyname, r.tablename);
    EXECUTE v_sql;

    v_sql := format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR %s TO %s',
                    r.policyname, r.tablename, r.cmd, v_roles);
    IF r.qual       IS NOT NULL THEN v_sql := v_sql || ' USING (public.can_write_bookkeeping())'; END IF;
    IF r.with_check IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK (public.can_write_bookkeeping())'; END IF;
    EXECUTE v_sql || ';';

    v_count := v_count + 1;
  END LOOP;

  IF v_count <> 34 THEN
    RAISE EXCEPTION 'expected to rewrite 34 policies, rewrote %', v_count;
  END IF;
  RAISE NOTICE 'rewrote % Bookkeeping write policies', v_count;
END
$do$;

-- 3. Assert the result inside the transaction, so a wrong outcome rolls back
--    rather than shipping. (apply_migration wraps this whole file.)
DO $assert$
DECLARE
  v_left int;
  v_new  int;
BEGIN
  SELECT count(*) INTO v_left FROM pg_policies
  WHERE schemaname='public' AND cmd IN ('INSERT','UPDATE','DELETE')
    AND (tablename LIKE 'loan%' OR tablename LIKE 'payroll%')
    AND (coalesce(qual,'') ~ 'ARRAY\[''admin''::text, ''manager''::text\]'
      OR coalesce(with_check,'') ~ 'ARRAY\[''admin''::text, ''manager''::text\]');
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'still % admin/manager-only Bookkeeping write policies', v_left;
  END IF;

  SELECT count(*) INTO v_new FROM pg_policies
  WHERE schemaname='public' AND cmd IN ('INSERT','UPDATE','DELETE')
    AND (tablename LIKE 'loan%' OR tablename LIKE 'payroll%')
    AND (coalesce(qual,'') LIKE '%can_write_bookkeeping%'
      OR coalesce(with_check,'') LIKE '%can_write_bookkeeping%');
  -- 34 rewritten here + 2 payroll_employees policies that already carried cpa
  -- inline are NOT included (they still use their own array) -- see note below.
  IF v_new <> 34 THEN
    RAISE EXCEPTION 'expected 34 policies on can_write_bookkeeping(), found %', v_new;
  END IF;
END
$assert$;

COMMIT;

-- NOTE on payroll_employees_write / payroll_employees_update: these already
-- listed cpa inline (widened in an earlier session so CPAs could fix employee
-- department mapping), so they did not match the canonical admin/manager
-- expression and are deliberately left alone by this migration. They grant the
-- same three roles by a different spelling. Folding them into
-- can_write_bookkeeping() is tidying, not a behaviour change -- Tech Debt.
--
-- ============================ ROLLBACK ============================
-- Restores the previous admin/manager-only behaviour. Safe to run as-is.
--
-- DO $rb$
-- DECLARE r record; v_roles text; v_sql text;
--         v_old text := '(EXISTS ( SELECT 1 FROM public.profiles p
--                        WHERE p.id = auth.uid()
--                          AND p.role = ANY (ARRAY[''admin''::text, ''manager''::text])))';
-- BEGIN
--   FOR r IN SELECT tablename, policyname, cmd, roles, qual, with_check
--            FROM pg_policies
--            WHERE schemaname='public' AND cmd IN ('INSERT','UPDATE','DELETE')
--              AND (tablename LIKE 'loan%' OR tablename LIKE 'payroll%')
--              AND (coalesce(qual,'') LIKE '%can_write_bookkeeping%'
--                OR coalesce(with_check,'') LIKE '%can_write_bookkeeping%')
--   LOOP
--     SELECT string_agg(quote_ident(x), ', ') INTO v_roles FROM unnest(r.roles::text[]) AS x;
--     EXECUTE format('DROP POLICY %I ON public.%I;', r.policyname, r.tablename);
--     v_sql := format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR %s TO %s',
--                     r.policyname, r.tablename, r.cmd, v_roles);
--     IF r.qual       IS NOT NULL THEN v_sql := v_sql || ' USING ' || v_old; END IF;
--     IF r.with_check IS NOT NULL THEN v_sql := v_sql || ' WITH CHECK ' || v_old; END IF;
--     EXECUTE v_sql || ';';
--   END LOOP;
-- END $rb$;
-- DROP FUNCTION IF EXISTS public.can_write_bookkeeping();
