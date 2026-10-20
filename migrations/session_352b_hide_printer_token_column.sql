-- Session 352b (2026-10-20). Apply ONLY after the admin dashboard that uses
-- get_printer_token() (session 352) is live — the old loadSettings() selects
-- printer_token directly and would fail as a whole once this runs.
--
-- Swap the table-wide SELECT for a column list without printer_token.
-- ⚠️ From now on a NEW settings column is not readable by logged-in users until it
-- is added to this grant (anon already worked this way).
REVOKE SELECT ON public.settings FROM authenticated;
GRANT SELECT (id, timezone, created_at, updated_at, review_link, print_transport, invoice_config,
              sales_tax_rate, brand_email_domain, wr_environment, books_closed_through,
              books_closed_through_note, xero_period_lock_date, xero_lock_date_synced_at,
              loan_writeoff_account_code, loan_writeoff_set_by, loan_writeoff_set_at, referral_config)
  ON public.settings TO authenticated;
-- Rollback: GRANT SELECT ON public.settings TO authenticated;
