-- session 246 (2026-08-28) — closing evidence: a grade for every month-end balance
--
-- APPLIED 2026-08-28. Written from docs/bookkeeping/DESIGN-CLOSING-EVIDENCE.md, reviewed with
-- washroute-migration-review, applied to the live project, and then VERIFIED
-- against it rather than assumed (see APPLIED STATE below). This file is the file
-- of record: if it and the database ever disagree, one of them is wrong and it
-- must be resolved, not papered over.
--
-- APPLIED STATE — re-verified live 2026-08-28, every item read back from catalog:
--   * loan_accounts.close_basis / _reason / _set_at / _set_by ....... present
--   * loan_accounts_close_basis_chk (3 values) ...................... present
--   * loan_book_balances (table, 4 columns of substance, PK) ........ present
--   * loan_book_balances_slot_uniq UNIQUE (loan, as_of, basis) ...... present
--   * loan_book_balances_loan_basis_asof_idx, _run_idx .............. present
--   * RLS enabled, policy loan_book_balances_read (admin/manager/cpa) present
--   * grants: authenticated = SELECT only; service_role = full;
--     anon = NOTHING AT ALL ......................................... confirmed
--   * section 3: Dexter Loan 2 and Verdant Capital both at
--     close_basis='amortization_schedule', set_by 'david (session 246)' applied
--
-- THE FOLLOW-UP THAT WAS NOT IN THE ORIGINAL FILE, AND WHY IT WAS NEEDED
-- The grants block below originally read GRANT only. After applying, `anon` still
-- held INSERT/UPDATE/DELETE on loan_book_balances — because pg_default_acl grants
-- them at CREATE TABLE time, BEFORE any statement in this file runs, and a GRANT
-- cannot take back what a default ACL already gave. That is exactly what the
-- comment on the grants block predicted, in writing, one screen further down; the
-- prediction was correct and the file still shipped without the statement that
-- would have acted on it. So this was run immediately afterwards and is now part
-- of the grants block itself, first line, ahead of both GRANTs:
--
--     revoke all on public.loan_book_balances from authenticated;
--     revoke all on public.loan_book_balances from anon;
--     grant select on public.loan_book_balances to authenticated;
--
-- The `authenticated` revoke is in there for the same reason: the default ACL had
-- handed it INSERT/UPDATE/DELETE too, and re-granting SELECT alone would have left
-- the other three standing. Verified after: authenticated holds SELECT and nothing
-- else, anon holds no privilege of any kind. RLS was never the thing at risk here
-- — it was doing its job throughout — but a debt book reachable by the public key
-- should not be one policy edit away from being writable, and the file of record
-- should not describe a weaker ACL than the one that is live.
--
-- WHY THIS EXISTS
-- The Loans rollforward has exactly two states today: a loan has a lender document
-- covering the month, or it is "not checkable". For July 2026 that puts three
-- active loans in the second bucket and reports "3 statements outstanding" as
-- though the statements are late. Two of them are not late. They are never coming:
-- Dexter Financial issues no periodic statements at all, and Verdant's monthly
-- notice carries a payment amount with no balance and no principal/interest split.
-- A gate that waits for something that will never arrive is not a gate, it is a
-- queue people learn to ignore — the same failure the close date fixed in session
-- 230, in a different costume.
--
-- The answer is that a closing balance has a GRADE, stated on screen, never
-- inferred from silence: A (confirmed by lender), B (per amortization schedule,
-- under a recorded per-loan policy), C (no evidence). This migration adds the two
-- things the schema does not have and grade B cannot exist without:
--
--   1. loan_accounts.close_basis — the per-loan POLICY saying which kind of
--      evidence establishes this loan's month-end balance when no lender document
--      covers the month. It is a policy, not a grade: the grade is per month,
--      because evidence is per month, and it is computed at read time. A real
--      lender document always wins over the policy; the policy only ever says what
--      to do in the ABSENCE of one. Absence is precisely the thing we are trying to
--      stop reading as a fact, so the admissibility of a schedule has to be an
--      explicit recorded decision with a name and a timestamp on it.
--
--   2. loan_book_balances — an independent books-side balance, per loan, per date.
--      This is the part that matters most and is easy to skip. For Verdant, all 85
--      loan_statements rows ARE the schedule, every split is schedule-generated,
--      and the closing figure would be the schedule: opening, movement and closing
--      would all be the same document, so the variance is identically zero by
--      construction, for every month, forever. That is not a test. Shipping grade B
--      without this table would print a green tick beside Verdant while the books
--      actually disagree with the schedule by -$1,835.75 — a figure loan_tie_outs
--      already holds (verified live, 2026-08-28) and the rollforward is
--      structurally incapable of showing. reconciliation-run's balance_vs_lender
--      already rebuilds each loan's balance from Xero (BankTransactions plus
--      ManualJournals); it just throws it away except for the one anchor date on
--      loan_tie_outs.xero_balance. This table retains it per month end so the
--      opening comes from somewhere the closing does not.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It writes NOTHING to loan_statements, and adds no column to it. That table
--     means "what the LENDER said". Our own arithmetic goes in its own table on
--     purpose: START HERE §2 is blocked right now precisely because Stripe's sweep
--     writes our books into loan_statements and collides with a lender figure on
--     the same date. Do not repeat that.
--   * It does not enforce "close_basis = 'amortization_schedule' on a loan with no
--     schedule is grade C, not grade B" as a CHECK. A stated policy does not
--     conjure a document, but whether a usable schedule exists is a fact about
--     loan_amortization_rows on a given date, not about this row — it belongs in
--     the read-time grader, which must degrade B to C on its own. A constraint here
--     would only stop the policy being recorded, not stop a number being invented.
--   * It puts no CHECK on loan_book_balances.basis. Exactly one value is defined
--     today ('xero_rebuild') and nothing branches on it; an enumeration guessed now
--     would need a migration the moment a second books-side method appears. This is
--     the opposite call from close_basis, which gets a CHECK because three values
--     are defined, readers branch on all three, and a typo there silently changes
--     which grade a loan closes at.
--   * It does not register close_basis with a protected-column guard.
--     session_227_protected_column_guards installs BEFORE UPDATE triggers on
--     `customers` and `orders` ONLY — verified live: loan_accounts has no triggers
--     at all, and no other enforce_protected_* function exists. loan_accounts is
--     already closed to customers by RLS (UPDATE restricted to profiles.role IN
--     (admin, manager); SELECT adds cpa), which is a stricter boundary than the
--     deny-list triggers provide. There is no v_protected array this column could
--     be added to, and creating a third guard trigger for one column would be new
--     machinery, not a registration. Recorded here so the next reader does not have
--     to re-derive it.
--
-- SAFETY: every statement is additive. No existing column is altered, no existing
-- constraint dropped or widened, no existing row is read or written by sections 1-2.
-- Section 3 is the only thing that touches existing data: two UPDATEs, each keyed
-- on one uuid and each guarded so it is a no-op on a second run.
--
-- ORDERING (session 176/177 rule) — WHAT ACTUALLY HAPPENED, kept because the next
-- schema change gets to reuse it. At the time this was written nothing in the repo
-- or in pg_proc referenced close_basis or loan_book_balances, so the migration was
-- safe to apply alone, and it was: DB first, on its own, schema cache reloaded and
-- the columns proved visible through the data API, and only THEN the dashboard and
-- reconciliation-run code that reads them. Never both in one push.
--
-- The second half of that ordering is still in flight, and this is the important
-- part for anyone reading this file to work out what state the system is in: the
-- SCHEMA is live but reconciliation-run is NOT DEPLOYED (still v49, 2026-08-27,
-- byte-identical to HEAD — verified, not assumed). Nothing writes loan_book_balances
-- yet, so the table is EMPTY, and until David deploys the function and clicks Run
-- check, both grade-B loans read "agrees by construction" instead of a real
-- variance. That is the honest reading of an empty table, not a fault — but it is
-- also not yet the thing this migration was for. See START HERE §1 in
-- PROJECT-NOTES-BOOKKEEPING.md.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. The per-loan closing policy on loan_accounts
--    Mirrors the carrying_basis / _evidence / _set_at / _set_by quartet added in
--    session 242, in shape and in idempotency. Same reason for existing, too: a
--    fact about the LOAN that decides how a figure may be established, as opposed
--    to loan_statements.balance_basis, which describes one document.
--
--    'lender_statement'      — the default and the only honest default. This loan
--                              closes on a real lender document or it does not
--                              close. Absence of one is grade C, as today.
--    'amortization_schedule' — a recorded decision that no usable statement exists
--                              for this loan, so the contractual schedule is the
--                              accepted basis in a month with no lender document.
--                              Never suppresses a real document that does arrive.
--    'none'                  — this loan is not expected to produce a month-end
--                              balance at all; do not queue work for it.
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.loan_accounts
  add column if not exists close_basis text not null default 'lender_statement',
  add column if not exists close_basis_reason text,
  add column if not exists close_basis_set_at timestamptz,
  add column if not exists close_basis_set_by text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_accounts_close_basis_chk') then
    alter table public.loan_accounts
      add constraint loan_accounts_close_basis_chk
      check (close_basis in ('lender_statement', 'amortization_schedule', 'none'));
  end if;
end $$;

comment on column public.loan_accounts.close_basis is
  'Per-loan POLICY for what establishes this loan''s month-end balance when no lender document covers the month. Never a grade: the grade is per month, computed at read time, and a real lender document always outranks this. ''amortization_schedule'' on a loan with no usable schedule is still grade C — a policy does not conjure a document.';
comment on column public.loan_accounts.close_basis_reason is
  'Why this basis was chosen, in a sentence a CPA would accept. Required in practice for anything other than the default: an unexplained downgrade from lender evidence is the thing this whole mechanism exists to prevent.';
comment on column public.loan_accounts.close_basis_set_at is
  'When the policy was recorded. NULL means nobody has decided and the loan is running on the default.';
comment on column public.loan_accounts.close_basis_set_by is
  'Who recorded the policy. A named human, not a process — this is a judgement call, not a computation.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. loan_book_balances — our own arithmetic, kept apart from the lender's word
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.loan_book_balances (
  id               uuid primary key default gen_random_uuid(),
  loan_account_id  uuid not null references public.loan_accounts(id) on delete cascade,
  as_of            date not null,
  balance          numeric(14,2) not null,
  -- How the figure was arrived at. 'xero_rebuild' = summed from Xero
  -- BankTransactions plus ManualJournals, the way reconciliation-run already does
  -- it for the anchor date.
  basis            text not null default 'xero_rebuild',
  -- Which run produced it. ON DELETE SET NULL, deliberately NOT the CASCADE that
  -- loan_tie_outs.run_id uses: a tie-out is a finding that belongs to its run and
  -- dies with it, whereas this is a retained period figure that the rollforward
  -- reads months later. Losing July's opening balance because a stale run was
  -- pruned would silently put Verdant back to being checked against itself.
  run_id           uuid references public.reconciliation_runs(id) on delete set null,
  detail           jsonb,
  computed_at      timestamptz not null default now()
);

-- One balance per loan per date per basis. A REAL CONSTRAINT, NOT A PARTIAL OR
-- EXPRESSION INDEX — session 242's lesson: PostgREST's on_conflict only ever emits
-- column names, so anything Postgres cannot infer from bare column names raises
-- 42P10 and every upsert from reconciliation-run fails, leaving the table
-- permanently empty with no error visible anywhere but a per-action line.
-- Re-running a reconciliation for the same month end must update that month end in
-- place, not stack a second opinion beside the first.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'loan_book_balances_slot_uniq') then
    alter table public.loan_book_balances
      add constraint loan_book_balances_slot_uniq
      unique (loan_account_id, as_of, basis);
  end if;
end $$;

-- "Latest balance for loan L on or before date D", which is the only way the
-- rollforward ever reads this table:
--   where loan_account_id = L and basis = 'xero_rebuild' and as_of <= D
--   order by as_of desc limit 1
-- basis sits in the middle on purpose, which is what stops this being a duplicate
-- of the unique constraint's own index. That index is (loan_account_id, as_of,
-- basis): it serves the basis-agnostic form of this query perfectly, and it can
-- answer the form above only by walking every date for the loan and discarding
-- the rows whose basis does not match. With basis ahead of as_of the scan seeks
-- straight to the right slice and the first row it meets is the answer.
create index if not exists loan_book_balances_loan_basis_asof_idx
  on public.loan_book_balances (loan_account_id, basis, as_of desc);

-- Mirrors loan_tie_outs_run_idx, and earns its keep twice: "what did this run
-- write" is a real question, and without it every delete of a reconciliation_runs
-- row seq-scans this table to satisfy the ON DELETE SET NULL above.
create index if not exists loan_book_balances_run_idx
  on public.loan_book_balances (run_id);

comment on table public.loan_book_balances is
  'OUR OWN ARITHMETIC: each loan''s balance rebuilt from Xero (BankTransactions plus ManualJournals) for a given date. loan_statements holds WHAT THE LENDER SAID. These two must never be merged. The whole point of this table is that it is independent of any schedule or lender document, so that opening minus principal versus closing is a test that can actually fail; folding it into loan_statements would destroy that independence and re-create the collision that has START HERE §2 blocked.';
comment on column public.loan_book_balances.as_of is
  'The date the balance is stated AS OF — normally a month end. Not the date it was computed; that is computed_at.';
comment on column public.loan_book_balances.detail is
  'Working for the figure: the transactions summed, the accounts touched, anything needed to answer "where did this number come from" without re-running.';

-- ── Data API grants — MANDATORY for new public tables (session 162) ──────────
-- Supabase removes the automatic anon/authenticated grant on newly-created public
-- tables; this project flips 2026-10-30, and a table created after that with no
-- grant is invisible through PostgREST with NO error at create time.
-- Modelled on loan_tie_outs, the closest sibling (machine-written, human-read),
-- whose live grants are: authenticated = SELECT only, service_role = full, anon =
-- nothing. Same shape here. reconciliation-run writes with the service role;
-- nothing in any app should ever write our own balance history by hand, and
-- nothing signed-out has any business reading the debt book at all.
--
-- THE REVOKE IS NOT DECORATION. Verified live 2026-08-28: pg_default_acl still
-- carries `anon=arwdDxtm` for tables in `public`, so CREATE TABLE hands anon full
-- privileges before this file gets a say, and a GRANT cannot take that back. This
-- is not hypothetical — loan_contract_terms and intake_bundles both sit in
-- production today with anon holding INSERT/UPDATE/DELETE, because session 242
-- said "deliberately NOT anon" and only wrote grants. RLS is what actually saves
-- those two (no policy an anon caller can satisfy), which is why nothing has gone
-- wrong yet, but a table reachable by the public key on a debt book should not be
-- one policy edit away from being readable. loan_tie_outs has no anon entry at
-- all; match that, explicitly.
-- APPLIED AS A FOLLOW-UP, not in the original file — see the header. The default
-- ACL had already granted BOTH roles everything by the time the file ran, and a
-- GRANT cannot take that back, so the revokes have to come first and have to name
-- authenticated as well as anon.
revoke all                           on public.loan_book_balances from authenticated;
revoke all                           on public.loan_book_balances from anon;
grant select                         on public.loan_book_balances to authenticated;
grant select, insert, update, delete on public.loan_book_balances to service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Mirrors loan_tie_outs exactly (verified live): RLS on, one SELECT policy for
-- admin / manager / cpa, and no INSERT/UPDATE/DELETE policies at all — writes
-- arrive only through the service role, which bypasses RLS. The CPA must be able
-- to read this; the CPA never edits it, and neither does anyone else through the
-- data API. Policy left at the default role like its siblings rather than the
-- `to authenticated` session 242 used: immaterial here, since anon holds no grant
-- and the qual requires a profiles row for auth.uid() regardless.
alter table public.loan_book_balances enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='loan_book_balances'
                   and policyname='loan_book_balances_read') then
    create policy loan_book_balances_read on public.loan_book_balances
      for select using (exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and p.role = any (array['admin','manager','cpa'])));
  end if;
end $$;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. POLICY DATA — David's decisions of 2026-08-28
--
-- These two statements are separate and self-contained ON PURPOSE. Sections 1 and
-- 2 are structure and are safe to apply on their own; these two are a judgement
-- about two specific loans and can be run, skipped, or run one at a time.
--
-- Each is guarded on `close_basis_set_at is null`, which makes a second run a
-- no-op AND — more importantly — means neither statement can ever overwrite a
-- later human decision. Once anyone has recorded a policy for a loan, this file
-- stops having an opinion about it. If a Dexter statement ever does arrive, Dexter
-- closes at grade A that month regardless of what is written here; the policy
-- speaks only to the absence of lender evidence.
--
-- Every other loan keeps the 'lender_statement' default. EIDL SBA in particular
-- must NOT be given this policy: it has no schedule, so the policy would conjure
-- nothing and the loan would still be grade C. It closes at grade A by rolling its
-- 8/25 statement back to month end, which is arithmetic on lender evidence.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 3a. Dexter Loan 2 (Dexter Financial, acct 103973-SP2) ───────────────────
update public.loan_accounts
set close_basis        = 'amortization_schedule',
    close_basis_reason = 'Dexter Financial issues no periodic statements. The contractual amortization schedule (PDF on file, generated 2021-10-13) is the accepted basis.',
    close_basis_set_at = now(),
    close_basis_set_by = 'david (session 246)'
where id = 'cba4240f-08cc-43d7-9d32-d37d695b5e2c'
  and close_basis_set_at is null;

-- ── 3b. Verdant Capital Loan (Verdant Capital, acct 11867000) ───────────────
update public.loan_accounts
set close_basis        = 'amortization_schedule',
    close_basis_reason = 'Verdant''s monthly notice carries the payment amount only — no balance and no principal/interest split. The contractual schedule is the accepted basis.',
    close_basis_set_at = now(),
    close_basis_set_by = 'david (session 246)'
where id = '2927c59e-1af4-4a60-84dc-cda0819558a3'
  and close_basis_set_at is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
--   drop table if exists public.loan_book_balances;
--   alter table public.loan_accounts
--     drop constraint if exists loan_accounts_close_basis_chk,
--     drop column if exists close_basis,
--     drop column if exists close_basis_reason,
--     drop column if exists close_basis_set_at,
--     drop column if exists close_basis_set_by;
--   notify pgrst, 'reload schema';
--
-- Section 3 alone, without dropping the columns:
--   update public.loan_accounts
--   set close_basis = 'lender_statement', close_basis_reason = null,
--       close_basis_set_at = null, close_basis_set_by = null
--   where close_basis_set_by = 'david (session 246)';
-- ═══════════════════════════════════════════════════════════════════════════
