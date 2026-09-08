-- session_289_statement_applied_split.sql
-- APPLIED 2026-09-08 via apply_migration; visibility PROVEN by REST round-trip
-- (200 naming both columns) with a control (42703 on a bogus column), per the
-- session 176/177 stale-cache rule.
--
-- The lender's own "Applied to Principal / Applied to Interest" line, persisted
-- on the STATEMENT rather than only on a split.
--
-- Why this is not already covered: loan-ingest-statement v21 captures the
-- lender's stated split verbatim, but lands it as loan_splits.source =
-- 'explicit_split'. Inside a CLOSED period no split is raised at all -- the
-- statement is stored as evidence and nothing else -- so on exactly the months a
-- difference is most likely to have arisen, the lender's own figure is read and
-- then dropped on the floor. EIDL SBA's April and May 2026 are that case: the
-- $5.00 arose between them, both sit in closed books, and both statements state
-- "Applied to Principal $0.00".
--
-- NULLABLE, NO DEFAULT, and that is load-bearing. NULL means "the document did
-- not say" -- the same discipline as balance_as_of (session 284). A DEFAULT 0
-- would assert that all 920 existing statements stated $0.00 applied to
-- principal, which is precisely the claim deriveIncreaseCause() keys on: it
-- would manufacture an outside witness for every loan on the book.
--
-- NO INDEX, deliberately: these are read on a row already fetched by
-- loan_account_id/statement_date and will never be a WHERE predicate.
-- NO GRANTS: loan_statements is an existing table whose explicit grants already
-- survive the Oct 30 2026 cutover -- the new-table rule does not apply here.
ALTER TABLE public.loan_statements
  ADD COLUMN applied_to_principal numeric,
  ADD COLUMN applied_to_interest  numeric;

COMMENT ON COLUMN public.loan_statements.applied_to_principal IS
  'What the DOCUMENT states was applied to principal, verbatim. NULL = the document did not say. Never computed and never a balance delta — a value here is the LENDER speaking, which is the entire reason the column exists (see derive-cause.ts LENDER_STATED, and s246: a check whose inputs share a source cannot fail).';

COMMENT ON COLUMN public.loan_statements.applied_to_interest IS
  'What the DOCUMENT states was applied to interest, verbatim. NULL = the document did not say.';

-- ROLLBACK:
--   ALTER TABLE public.loan_statements
--     DROP COLUMN applied_to_principal,
--     DROP COLUMN applied_to_interest;
