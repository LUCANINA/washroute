-- Session 251: loan_statements was UNIQUE (loan_account_id, statement_date) --
-- one balance per loan per day, whatever said it. That is the blocker behind
-- Tech Debt item "Stripe's lender anchor still blocked" (see START HERE,
-- PROJECT-NOTES-BOOKKEEPING.md, sessions 241-250): xero-payout-sync writes a
-- daily xero_balance_snapshot row for Stripe Capital, and it occupies the only
-- slot available for that date, so a real Stripe-sourced balance (portal pull,
-- statement, or a screenshot dated via ledger-dating.ts) can never be filed
-- alongside it -- loan-bundle-apply.ts's statementRowWrite() refuses it with
-- verdict 'date_taken' rather than overwrite the books' own figure.
--
-- This makes the constraint source-scoped: one balance per loan, per day, PER
-- SOURCE. Our own daily sweep and a genuine lender figure can now both be filed
-- for the same date -- which is the whole point, since the two of them together
-- are what the Loans rollforward's Variance column needs to compare.
--
-- Verified safe before applying (session 251):
--   * 899 existing rows, 0 with a null source (source is NOT NULL, default
--     'portal_manual_pull') -- no NULL-uniqueness surprises.
--   * Zero existing (loan_account_id, statement_date) pairs with more than one
--     row -- the old constraint already enforced that, so every existing row
--     trivially satisfies the new, less restrictive constraint. This migration
--     cannot fail on existing data.
--   * idx_loan_statements_account (loan_account_id, statement_date DESC)
--     already exists as a plain index and keeps "latest row for this loan"
--     lookups fast independent of the unique constraint change.
--
-- Companion code changes (same session, applied separately via deploy):
--   * loan-ingest-statement/index.ts and loan-ingest-amortization/index.ts:
--     their upsert() onConflict target updated from 'loan_account_id,
--     statement_date' to 'loan_account_id,statement_date,source' to match.
--   * _shared/loan-bundle-apply.ts statementRowWrite(): the refusal for a
--     different-source row on the same date ('date_taken') is removed --
--     that shape is no longer a conflict, only a same-source disagreement is.
--
-- Reversible: DROP the new constraint and recreate the old one. Rollback is
-- only safe if no two rows for the same (loan_account_id, statement_date)
-- with different sources have been inserted since this applied -- check first:
--   select loan_account_id, statement_date, count(*) from loan_statements
--   group by 1,2 having count(*) > 1;
-- If that returns any rows, the old constraint cannot be restored without
-- first deleting or merging one of each pair.

ALTER TABLE public.loan_statements
  DROP CONSTRAINT loan_statements_loan_account_id_statement_date_key;

ALTER TABLE public.loan_statements
  ADD CONSTRAINT loan_statements_loan_account_id_statement_date_source_key
  UNIQUE (loan_account_id, statement_date, source);
