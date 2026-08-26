-- Session 241: applied 2026-08-26 23:06:40 UTC, recorded as 20260826230640.
--
-- ORDERING NOTE, and it is the important part of this file: loan-ingest-statement
-- v35 was ALREADY DEPLOYED (23:05:07 UTC) and selects this column, so the function
-- was broken for the ~90 seconds until this landed. That is the exact shape that
-- cost session 176/177 fifteen hours of dead card charging, and the rule from it
-- stands: add the column, PROVE the data API sees it, and only then deploy the
-- code that reads it. Here the two got separated for a mundane reason -- `psql`
-- was not installed on the machine running the deploy, so half a two-step
-- instruction ran and the half that ran was the dangerous half.
--
-- Verified after applying, rather than assumed:
--   control  select=id,this_column_does_not_exist -> HTTP 400, 42703
--   real     select=id,interest_arrives_as_fee    -> HTTP 200
-- The control is the point: a 200 only means something once a genuinely missing
-- column has been shown to return 400 on the same table. No restart was needed.
--
-- WHY THE COLUMN EXISTS. loan-ingest-statement has paired a lender's fee with its
-- payment into ONE split -- principal = payment - fee, interest = fee -- since
-- v20, gated on direct_split_enabled. Rapid Credit Line has that flag false, so
-- machinery written for this lender, and tested against this lender's own PDF,
-- never ran for it.
--
-- The gate was the wrong question. direct_split_enabled decides how we POST to
-- Xero. Whether a fee and a payment are one economic event is a fact about how
-- the LENDER works, true whatever we do downstream. Rapid capitalises the weekly
-- fee into the balance and then takes the full payment against it, which its own
-- portal figures show plainly:
--
--     2026-07-07   61,962.76
--     2026-07-13   62,516.85    + 554.09   the fee, capitalised
--     2026-07-14   60,447.96    - 2,068.89 the payment
--     net for the week = 2,068.89 - 554.09 = 1,514.80, to the cent

alter table public.loan_accounts
  add column if not exists interest_arrives_as_fee boolean not null default false;

comment on column public.loan_accounts.interest_arrives_as_fee is
  'True when this lender bills interest as a separate fee that capitalises into the balance, rather than embedding it in the payment. loan-ingest-statement then pairs each fee with its nearest payment (+/-2 days) into ONE split: principal = payment - fee, interest = fee. Independent of direct_split_enabled, which governs only the Xero posting shape.';

update public.loan_accounts
   set interest_arrives_as_fee = true
 where xero_account_name = 'Rapid Credit Line';

-- Assert rather than hope. apply_migration runs in a transaction, so a wrong
-- count rolls the whole thing back instead of leaving a half-applied flag.
do $$
declare n int;
begin
  select count(*) into n from public.loan_accounts where interest_arrives_as_fee;
  if n <> 1 then
    raise exception 'expected exactly 1 loan flagged interest_arrives_as_fee, got %', n;
  end if;
end $$;

-- The data API serves a cached schema snapshot and the dependent function is
-- already live, so nudge it rather than waiting on the DDL watch.
notify pgrst, 'reload schema';

-- Rollback:  alter table public.loan_accounts drop column interest_arrives_as_fee;
