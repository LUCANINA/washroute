-- session 242 — multi-document loan intake ("bundles")
--
-- WHY THIS EXISTS
-- Until now a loan document was ingested one file at a time, and each file was
-- judged only against itself. David uploads a SET: an agreement, a transaction
-- export, a payment confirmation, a portal screenshot — all about one loan, each
-- carrying a different piece of the truth. Read together they answer questions no
-- single one of them can, and they cross-check each other. This migration adds the
-- three things that reading a SET requires and the schema did not have:
--
--   1. loan_accounts.carrying_basis — how the LIABILITY is carried in the books.
--      This is the fact that decides whether a payment must be split into
--      principal and interest at all, and nothing in the schema recorded it.
--      loan_statements.balance_basis is a property of one statement; this is a
--      property of the loan. Confusing the two is what nearly produced a $20,875
--      phantom liability on Stripe Capital this session — the proposed fee reclass
--      was correct for a NET-booked loan and catastrophic for a GROSS-booked one,
--      and nothing in the schema said which this was.
--
--   2. loan_contract_terms — terms as the LENDER stated them, with the verbatim
--      line they were read from and a link to the document. Deliberately separate
--      from loan_accounts' own columns, which are human notes: the module already
--      learned this with interest_rate (typed 9.000% on four Ford loans whose real
--      rates were 8.29/9.29/9.99/8.99%) and solved it the same way, with
--      fitted_annual_rate beside interest_rate. A typed number is never evidence;
--      a line quoted off a signed agreement is.
--
--   3. intake_bundles — the receipt. What the engine proposed, what the human
--      ticked, and what was actually written. intake_batches does this for the
--      per-file batch flow; a bundle is a different unit of work.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It does not widen loan_splits_source_chk. The bundle engine creates no
--     splits. Establishing facts and creating money entries are separate jobs and
--     stay in separate hands: the existing ingest functions own splits.
--   * It does not add loan_splits.posting_date. That column is a real prerequisite
--     for reclassification entries (loan-xero-post passes period_label verbatim as
--     the Xero journal Date, so a 'YYYY-MM' label would reach Xero as "2026-08"),
--     but wiring it belongs with the change that needs it. An unhonoured column is
--     a trap.
--
-- SAFETY: every statement is additive. No existing column altered, no existing
-- constraint dropped or widened, no existing row read or written.
--
-- ORDERING (session 176/177 rule): loan_accounts.carrying_basis is read through
-- PostgREST. This migration was applied FIRST and the data API was proven to see
-- the column with a REST round-trip (200, no PGRST204) before any dependent code
-- shipped. Never both in one push.

-- 1. How is this loan carried in the books?
--    'net_principal' — liability is cash still owed on the amount BORROWED. Each
--                      payment splits into principal + interest. (Dexter, PCV,
--                      Verdant, Ford, the SBA loans.)
--    'gross_payback' — liability is the whole contractual payback including a fee
--                      capitalised at origination. Each payment reduces it
--                      dollar-for-dollar and carries NO interest component; the
--                      financing cost is dealt with once, at origination.
--                      (Stripe Capital.)
--    'unknown'       — not established. Propose no split either way.
alter table public.loan_accounts
  add column if not exists carrying_basis text not null default 'unknown',
  add column if not exists carrying_basis_evidence text,
  add column if not exists carrying_basis_set_at timestamptz,
  add column if not exists carrying_basis_set_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_accounts_carrying_basis_chk') then
    alter table public.loan_accounts
      add constraint loan_accounts_carrying_basis_chk
      check (carrying_basis in ('net_principal', 'gross_payback', 'unknown'));
  end if;
end $$;

comment on column public.loan_accounts.carrying_basis is
  'How the LIABILITY is carried in the books, which decides whether payments need a principal/interest split. Distinct from loan_statements.balance_basis, which describes one statement. Never propose a split while this is ''unknown''.';
comment on column public.loan_accounts.carrying_basis_evidence is
  'Plain-English statement of how the basis was established, naming the documents or figures that prove it.';

-- 2. Terms as the lender stated them
create table if not exists public.loan_contract_terms (
  id                        uuid primary key default gen_random_uuid(),
  loan_account_id           uuid not null references public.loan_accounts(id) on delete cascade,
  source_document_id        uuid references public.loan_documents(id) on delete set null,
  term_key                  text not null,
  value_numeric             numeric,
  value_date                date,
  value_text                text,
  -- The verbatim line this was read from. Not optional: a term with no quotable
  -- source is an assertion, and assertions do not belong in an evidence table.
  source_text               text not null,
  extracted_by              text not null,
  confidence                text not null default 'high',
  as_of                     date,
  -- Whether this term has been copied onto loan_accounts' display columns. The
  -- evidence row is the truth either way; this records what the human accepted.
  applied_to_loan_account   boolean not null default false,
  applied_at                timestamptz,
  applied_by                text,
  superseded_at             timestamptz,
  created_at                timestamptz not null default now(),
  created_by                text,
  constraint loan_contract_terms_confidence_chk
    check (confidence in ('high', 'medium', 'low')),
  constraint loan_contract_terms_term_key_chk
    check (term_key in (
      'loan_amount', 'fixed_fee', 'total_repayment_amount', 'net_loan_proceeds',
      'repayment_rate_percent', 'interest_rate_percent',
      'origination_date', 'repayment_start_date', 'final_repayment_date',
      'minimum_payment_amount', 'minimum_payment_period_days',
      'scheduled_payment_amount', 'payment_frequency',
      'lender_account_ref', 'borrower_name', 'originating_bank'
    )),
  constraint loan_contract_terms_has_value_chk
    check (value_numeric is not null or value_date is not null or value_text is not null)
);

-- One term per (loan, key, document). A re-upload of the same document updates in
-- place instead of stacking duplicates; a DIFFERENT document stating the same
-- term is a separate row on purpose, because two documents disagreeing is exactly
-- the thing worth seeing.
--
-- A REAL CONSTRAINT, NOT A PARTIAL INDEX. The first draft of this file used
-- `... where superseded_at is null`, and Postgres will not infer a partial index
-- as an ON CONFLICT arbiter unless the statement repeats the predicate — which
-- PostgREST's on_conflict cannot do, it only ever emits column names. Every
-- upsert would have raised 42P10, every bundle apply would have failed that one
-- action, and the evidence table would have stayed empty forever. Which in turn
-- would have kept reconciliation-run's carrying-basis check permanently inert,
-- since it returns early for a loan with no terms. Dead on arrival, with no
-- error visible anywhere but a per-action failure line.
--
-- NULLS NOT DISTINCT matters independently: source_document_id is null whenever
-- terms are recorded without attaching the source file, and under the default
-- NULLS DISTINCT every such write stacks another full set instead of updating.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_contract_terms_slot_uniq') then
    alter table public.loan_contract_terms
      add constraint loan_contract_terms_slot_uniq
      unique nulls not distinct (loan_account_id, term_key, source_document_id);
  end if;
end $$;
create index if not exists loan_contract_terms_loan_idx
  on public.loan_contract_terms (loan_account_id) where superseded_at is null;

comment on table public.loan_contract_terms is
  'Loan terms as the LENDER stated them, each with the verbatim line it was read from and a link to the source document. Separate from loan_accounts own term columns, which are human notes and may be wrong.';

-- 3. The bundle receipt
create table if not exists public.intake_bundles (
  id                  uuid primary key default gen_random_uuid(),
  loan_account_id     uuid references public.loan_accounts(id) on delete set null,
  document_count      integer not null,
  documents           jsonb not null default '[]'::jsonb,
  -- The full plan exactly as shown on screen, kept verbatim so that "what did it
  -- say when I clicked yes" is answerable months later.
  plan                jsonb not null,
  corroborations      jsonb not null default '[]'::jsonb,
  conflicts           jsonb not null default '[]'::jsonb,
  decisions           jsonb,
  applied_actions     jsonb,
  status              text not null default 'planned',
  created_by          text,
  created_at          timestamptz not null default now(),
  applied_by          text,
  applied_at          timestamptz,
  -- 'applying' is the claim state. The apply step sets it with an atomic
  -- UPDATE ... WHERE status IN ('planned','partially_applied') before doing any
  -- work, so a second concurrent call matches zero rows and refuses instead of
  -- applying everything a second time.
  constraint intake_bundles_status_chk
    check (status in ('planned', 'applying', 'applied', 'partially_applied', 'abandoned')),
  constraint intake_bundles_document_count_chk check (document_count >= 0)
);

create index if not exists intake_bundles_loan_idx on public.intake_bundles (loan_account_id, created_at desc);
create index if not exists intake_bundles_recent_idx on public.intake_bundles (created_at desc);

comment on table public.intake_bundles is
  'One row per multi-document loan intake. Holds the plan as presented, what the human ticked, and what was written.';

-- 4. Data API grants — MANDATORY for new public tables
-- Supabase is removing the automatic anon/authenticated grant on newly-created
-- public tables; this project flips 2026-10-30. A table created without an
-- explicit grant after that date is invisible to the dashboard through PostgREST,
-- with NO error at create time. Modelled on loan_documents: authenticated and
-- service_role, deliberately NOT anon — nothing signed-out has any business
-- reading a loan agreement's terms. RLS below is still the real boundary.
grant select, insert, update, delete on public.loan_contract_terms to authenticated, service_role;
grant select, insert, update, delete on public.intake_bundles      to authenticated, service_role;

-- 5. RLS — mirrors loan_documents' four-policy shape exactly.
-- Read: admin, manager, cpa (the CPA must be able to see the evidence).
-- Write/update/delete: admin, manager only (the CPA never edits the record).
alter table public.loan_contract_terms enable row level security;
alter table public.intake_bundles      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['loan_contract_terms', 'intake_bundles'] loop
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_read') then
      execute format('create policy %I on public.%I for select to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array[''admin'',''manager'',''cpa''])))', t||'_read', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_write') then
      execute format('create policy %I on public.%I for insert to authenticated with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array[''admin'',''manager''])))', t||'_write', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_update') then
      execute format('create policy %I on public.%I for update to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array[''admin'',''manager'']))) with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array[''admin'',''manager''])))', t||'_update', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_delete') then
      execute format('create policy %I on public.%I for delete to authenticated using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = any (array[''admin'',''manager''])))', t||'_delete', t);
    end if;
  end loop;
end $$;

-- ROLLBACK
--   drop table if exists public.intake_bundles;
--   drop table if exists public.loan_contract_terms;
--   alter table public.loan_accounts
--     drop constraint if exists loan_accounts_carrying_basis_chk,
--     drop column if exists carrying_basis,
--     drop column if exists carrying_basis_evidence,
--     drop column if exists carrying_basis_set_at,
--     drop column if exists carrying_basis_set_by;
