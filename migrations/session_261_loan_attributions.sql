-- session_261_loan_attributions.sql
--
-- WHY THIS TABLE EXISTS
-- --------------------
-- `loan-attribution-run` is a nightly job that walks each loan with an open MATERIAL
-- `balance_vs_lender` finding and stores what it can attribute the gap to. Session 259
-- cont. 14 planned to keep that payload in `loan_tie_outs.detail.attribution`.
--
-- It cannot live there. `loan_tie_outs` is a PER-RUN table -- 1,342 rows across 61 runs,
-- 22 per run, exactly the loan count -- so every `reconciliation-run` inserts a fresh
-- row per loan and the attribution written to the previous newest row is orphaned. The
-- hover would then render nothing, and in this module nothing reads as "no attribution
-- needed" rather than "not computed since you last re-ran". That is the two-numbers-one-
-- screen failure shape in its quietest form. David chose the dedicated table.
--
-- ONE ROW PER LOAN, and the row never outlives its finding: the job deletes rows for
-- loans with no open material finding, so a stale attribution cannot be displayed
-- beside a gap that has since been resolved.

create table if not exists public.loan_attributions (
  loan_account_id   uuid primary key references public.loan_accounts(id) on delete cascade,
  schema_version    integer     not null,
  generated_at      timestamptz not null,
  headline          text,
  payload           jsonb       not null default '{}'::jsonb,
  -- 'ok'    the walk ran and the payload is its answer (which may legitimately be "nothing")
  -- 'error' the walk could not run; `error_message` says why. NOT the same as "nothing found",
  --         and the reader must never render it as a clean result.
  run_status        text        not null default 'ok',
  error_message     text,
  -- the finding this payload was computed for. A reader can confirm it is still open
  -- rather than trusting the row's existence.
  source_finding_id uuid references public.reconciliation_findings(id) on delete set null,
  updated_at        timestamptz not null default now(),
  constraint loan_attributions_run_status_chk check (run_status in ('ok', 'error'))
);

alter table public.loan_attributions enable row level security;

-- Same contract as loan_tie_outs / loan_book_balances / reconciliation_findings:
-- SELECT for admin/manager/cpa, and NO insert/update/delete policy at all. Writes are
-- the service role's alone (it bypasses RLS), which is what keeps the only writer the
-- edge function.
drop policy if exists loan_attributions_read on public.loan_attributions;
create policy loan_attributions_read on public.loan_attributions
  for select using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = any (array['admin'::text, 'manager'::text, 'cpa'::text])
    )
  );

-- Session 162's rule, and it is not optional on a NEW table. This project flips to the
-- no-auto-grant default on 2026-10-30; a table created without explicit grants after
-- that date is INVISIBLE to the dashboard (which reaches PostgREST with the anon key as
-- an `authenticated` user) with no error at create time. Matched to loan_tie_outs'
-- actual grants, checked live: `authenticated` SELECT, and nothing for `anon` -- no
-- customer-facing app reads loan data and none should be able to.
grant select on public.loan_attributions to authenticated;

-- The writer. service_role bypasses RLS, but the GRANT is what makes the table
-- reachable at all once the default ACLs stop applying.
grant select, insert, update, delete on public.loan_attributions to service_role;

-- APPLIED AS A SECOND MIGRATION (session_261_loan_attributions_revoke_default_acl),
-- kept here so this file is the whole story. Verifying the grants after apply showed the
-- public schema's DEFAULT ACLs had auto-granted anon AND authenticated the FULL set --
-- insert, update, delete, TRUNCATE -- on a financial table. RLS refuses all of it (there
-- is no anon policy), but loan_tie_outs carries exactly one grant and a financial table
-- should not rest on RLS alone. The grants above are not enough on their own BEFORE the
-- 2026-10-30 cutover: you must revoke what the default ACL handed out.
revoke all on public.loan_attributions from anon;
revoke all on public.loan_attributions from authenticated;
grant select on public.loan_attributions to authenticated;
grant select, insert, update, delete on public.loan_attributions to service_role;
