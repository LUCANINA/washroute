-- Migration: session_141_customer_invoice_template_columns
-- Purpose: Per-customer invoice template fields. Mirrors billing_groups.{contacts,
--   email_subject_template, email_body_template} so standalone (non-grouped)
--   on-account customers can have their invoice modal pre-filled with last
--   session's edits. NULL means "use modal defaults" (current behaviour).
--
-- Used by openStandaloneInvoiceModal + sendInvoiceEmail in admin-dashboard.
-- See PROJECT-NOTES Session 141 pt 11 for context.

ALTER TABLE public.customers
  ADD COLUMN invoice_to_email         text,
  ADD COLUMN invoice_cc_emails        text,
  ADD COLUMN invoice_subject_template text,
  ADD COLUMN invoice_body_template    text;

COMMENT ON COLUMN public.customers.invoice_to_email IS
  'Last To recipient on a sent invoice. NULL → fall back to email_cache. Session 141.';
COMMENT ON COLUMN public.customers.invoice_cc_emails IS
  'Last comma-separated CC list on a sent invoice. Session 141.';
COMMENT ON COLUMN public.customers.invoice_subject_template IS
  'Last subject saved with {{period}} placeholder unwrapped. Session 141.';
COMMENT ON COLUMN public.customers.invoice_body_template IS
  'Last body saved with {{period}} placeholder unwrapped. Session 141.';
