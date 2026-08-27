-- session 242, follow-up — repairs a database that already ran the first version
-- of session_242_loan_bundle_intake.sql.
--
-- The original file has since been corrected in place, so a FRESH database needs
-- nothing from here. This exists for one that already has the broken shapes:
-- a partial unique index that cannot serve as a PostgREST upsert arbiter, and a
-- status CHECK with no 'applying' for the atomic claim to land in.
--
-- Both statements are idempotent, so running this against a corrected database,
-- or twice, is a no-op.
--
-- WHY THE PARTIAL INDEX HAD TO GO — proven with EXPLAIN before writing this:
--   ERROR: 42P10: there is no unique or exclusion constraint matching the
--                 ON CONFLICT specification
-- Postgres will not infer a partial index as an ON CONFLICT arbiter unless the
-- statement repeats the index predicate, and PostgREST's on_conflict emits only
-- column names. Every loan_contract_terms write would have failed.

-- No explicit begin/commit. Every runner used on this project wraps a migration
-- in its own transaction (Supabase's apply_migration, and psql -1), and an inner
-- `commit` ends THAT transaction early — so anything the runner meant to do
-- atomically after this file, such as writing its own ledger row, would no longer
-- be in the same unit. Each statement below is idempotent on its own.

drop index if exists public.loan_contract_terms_live_uniq;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_contract_terms_slot_uniq') then
    alter table public.loan_contract_terms
      add constraint loan_contract_terms_slot_uniq
      unique nulls not distinct (loan_account_id, term_key, source_document_id);
  end if;
end $$;

alter table public.intake_bundles drop constraint if exists intake_bundles_status_chk;
alter table public.intake_bundles
  add constraint intake_bundles_status_chk
  check (status in ('planned', 'applying', 'applied', 'partially_applied', 'abandoned'));

-- NOT DONE, deliberately: a unique index on loan_documents (loan_account_id,
-- file_sha256). It is the right structural guard against attaching the same file
-- twice, and it was in the first draft — but it FAILS to create:
--
--   ERROR: 23505: Key (loan_account_id, file_sha256)=
--          (b1008b4a-8a9e-440b-9efc-55a6b831a001, 679ff195...) is duplicated
--
-- E-Transit Loan 4140 already carries the same screenshot three times, uploaded
-- 2026-08-24 within 37 minutes of itself. Deleting two of them is a decision
-- about real documents and belongs to a person, not to a migration written to fix
-- something else. Once David says which to keep:
--
--   create unique index loan_documents_loan_sha_uniq
--     on public.loan_documents (loan_account_id, file_sha256)
--     where file_sha256 is not null;
