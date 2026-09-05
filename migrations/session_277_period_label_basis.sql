-- session 277 (2026-09-05) — loan_splits.period_label_basis
--
-- WHY: a split's period month was inferred from the STATEMENT's date, in two places
-- in loan-ingest-statement (`statement_date.slice(0, 7)`). BayFirst SBA 2 applies on
-- the last day of its cycle (7/31) and the bank drafts two or three days later (8/3),
-- so its August payment filed as 2026-07 and July's close rollforward counted $858.66
-- of principal that belongs to August. The statement's date is CORRECT; the inference
-- from it is wrong.
--
-- The fix takes the month from the Xero bank transaction that actually carries the
-- money, when one matches the lender's own principal/interest figures. Session 230's
-- rule is that a measured value and an assumed one must be TOLD APART on the row, not
-- reconstructed later by whoever reads it — so which basis was used is recorded here,
-- as a column, rather than left to be inferred from the label's shape.
--
-- Deliberately NO check constraint, and this is the same reasoning as
-- loan_statements.source (session 245): the reading code allowlists the values that
-- mean "the lender's money said so". A basis value nobody has taught the readers about
-- is then treated as an assumption, which is the safe direction. A constraint here
-- would only move that failure to write time and buy nothing.
--
-- Nullable, no default, no backfill. Every existing row was written before the money
-- was consulted, and stamping them all 'statement_date' now would claim a measurement
-- that never happened. NULL means exactly what it should: nobody recorded a basis.

ALTER TABLE public.loan_splits
  ADD COLUMN IF NOT EXISTS period_label_basis text;

COMMENT ON COLUMN public.loan_splits.period_label_basis IS
  'How period_label''s month was decided. ''bank_transaction'' = taken from the date of '
  'the Xero bank transaction carrying this payment (measured). ''statement_date'' = taken '
  'from the lender statement''s own date, because no matching transaction was found '
  '(assumed — the two differ whenever a lender applies at month end and the bank drafts '
  'the following month). NULL = written before session 277, basis unrecorded.';
