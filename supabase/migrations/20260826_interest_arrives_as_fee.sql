-- Session 241 (David): "learn how to ingest Rapid once and for all. The
-- interest is show as a fee. To calculate the principal, deduct the
-- interest/fee portion from the PAYMENT."
--
-- loan-ingest-statement has computed exactly that since v20 -- principal =
-- payment - fee, interest = fee -- and it has never run for Rapid, because it
-- was gated on direct_split_enabled, which is false on Rapid Credit Line.
--
-- The gate was the wrong question. direct_split_enabled decides how we POST to
-- Xero. Whether a fee and a payment are one economic event is a fact about how
-- the LENDER works, true regardless of what we do downstream. Rapid capitalises
-- the weekly fee into the balance and then takes the full payment against it --
-- confirmed against its own portal figures:
--
--     2026-07-07  61,962.76
--     2026-07-13  62,516.85   (+554.09, the fee capitalised)
--     2026-07-14  60,447.96   (-2,068.89, the payment)
--     net = 2,068.89 - 554.09 = 1,514.80, to the cent
--
-- So the fact gets its own column and the posting preference keeps its own.

alter table public.loan_accounts
  add column if not exists interest_arrives_as_fee boolean not null default false;

comment on column public.loan_accounts.interest_arrives_as_fee is
  'True when this lender bills interest as a separate fee that capitalises into the balance, rather than embedding it in the payment. loan-ingest-statement then pairs each fee with its nearest payment (+/-2 days) into ONE split: principal = payment - fee, interest = fee. Independent of direct_split_enabled, which governs only the Xero posting shape.';

update public.loan_accounts
   set interest_arrives_as_fee = true
 where lender_account_number in (
   select lender_account_number from public.loan_accounts
    where xero_account_name = 'Rapid Credit Line'
 );
