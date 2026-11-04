-- Session 368 (2026-11-04): the 2024 convertible note round on the Debt Schedule.
-- Additive only: widens one CHECK, adds one defaulted boolean, inserts 10 rows.
-- Contract facts are from the signed notes (Desktop/Convertible note/*); closing dates
-- are the Xero receipt dates (David: "start with money received date"). Balances are
-- NOT stored here -- they come from Xero via reconciliation-run (xero_rebuild), like
-- every other loan. Xero codes verified against the 2026-10-31 trial balance.
-- Rollback: DELETE FROM loan_accounts WHERE debt_category='notes' AND lender_account_number='NOTE-2024';
--           ALTER TABLE loan_accounts DROP COLUMN related_party; restore the 3-value CHECK.

ALTER TABLE public.loan_accounts DROP CONSTRAINT loan_accounts_debt_category_check;
ALTER TABLE public.loan_accounts ADD CONSTRAINT loan_accounts_debt_category_check
  CHECK (debt_category IS NULL OR debt_category = ANY (ARRAY['long_term','vehicle','other','notes']));
ALTER TABLE public.loan_accounts ADD COLUMN related_party boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.loan_accounts.related_party IS 'Holder is a related party of the owners. Shown on the Debt Schedule.';

INSERT INTO public.loan_accounts
  (lender, lender_account_number, xero_account_code, xero_account_name, status, debt_category,
   original_amount, original_date, interest_rate, maturity_date, security_type,
   ingestion_method, close_basis, close_basis_reason, close_basis_set_at, close_basis_set_by,
   include_in_debt_schedule, related_party, notes)
SELECT v.lender, 'NOTE-2024', v.code, v.xname, 'active', 'notes',
       v.amt, v.closed::date, 15.000, (v.closed::date + interval '36 months')::date, 'subordinated',
       'xero_direct', 'none',
       'Convertible note: no lender statement exists. Balance (principal + accrued interest) is booked monthly in Xero.',
       now(), 'session 368',
       true, v.rp,
       CASE WHEN v.code = '311' THEN 'Funded in two wires: $14,700.00 on 2024-05-29 and $10,300.00 on 2024-06-11 (Xero). Dated from the first. ' ELSE '' END ||
       'Young & Foolish, LLC 2024 convertible subordinated promissory note (purchase agreement 3/14/2024). '
       || '15% simple interest, 365-day year, on principal; accrues until maturity or conversion. '
       || 'Matures 36 months after closing (closing = the date the money was received, per Xero); repayment due within 30 days after maturity. '
       || 'Converts (holder option: units or cash) on a Qualified Financing of $1M+; on a Change of Control before that, repaid at 2x principal plus accrued interest. No prepayment without holder consent.'
FROM (VALUES
  ('Anik Guha',                                  '351', 'Note - Anik Guha',            50000, '2024-04-15', false),
  ('The Eric G. Gimon and Emma S. Gimon Trust',  '316', 'Note - Eric Gimon',           50000, '2024-03-28', false),
  ('Hugues Macquart-Moulin',                     '293', 'Note - Hugues Moulin',        25000, '2024-03-18', true),
  ('Jean Gael and Maria Collomb',                '317', 'Note - JG and Maria Collomb', 20000, '2024-03-26', false),
  ('Majdi Ghozael',                              '311', 'Note - Majdi Ghozael',        25000, '2024-05-29', false),
  ('The Droz Family Trust',                      '312', 'Note - Pierre Yves Droz',     25000, '2024-03-18', false),
  ('Romain Curtis',                              '313', 'Note - Romain Curtis',        25000, '2024-03-21', false),
  ('Salman Zaidi',                               '352', 'Note - Salman Zaidi',         25000, '2024-04-16', false),
  ('Selvaratnam Suthesh Arthur',                 '315', 'Note - Selvaratnam S.',       50000, '2024-03-26', false),
  ('Seth Nemeroff',                              '314', 'Note - Seth Nemeroff',        25000, '2024-03-22', false)
) AS v(lender, code, xname, amt, closed, rp);

DO $$ BEGIN
  IF (SELECT count(*) FROM public.loan_accounts WHERE debt_category='notes') <> 10
     OR (SELECT sum(original_amount) FROM public.loan_accounts WHERE debt_category='notes') <> 320000 THEN
    RAISE EXCEPTION 'notes insert did not land as expected';
  END IF;
END $$;
