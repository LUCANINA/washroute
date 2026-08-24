-- Session 230 (2026-08-24) — per-loan "How this loan is structured" narrative.
-- APPLIED to production 2026-08-24 via apply_migration (same name). Kept here for
-- the record. Reviewed with washroute-migration-review: nullable, no default, no
-- index (never filtered on), no FK, no RLS change (loan_accounts' existing
-- admin/manager UPDATE policy governs it). Rollback is the DROP at the bottom.
--
-- The companion "Where the accounting can be better" list is computed live in the
-- client and deliberately NOT stored: a stored improvement list goes stale
-- silently, which is the failure this session opened with.
ALTER TABLE public.loan_accounts
  ADD COLUMN IF NOT EXISTS structure_note text,
  ADD COLUMN IF NOT EXISTS structure_note_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS structure_note_updated_by text;

COMMENT ON COLUMN public.loan_accounts.structure_note IS
  'Plain-English description of how this loan is actually structured (principal vs fee, cadence, how it is booked). Authored by a human/CPA from the contract; never auto-generated. Rendered in the loan detail panel.';

NOTIFY pgrst, 'reload schema';

-- Rollback:
-- ALTER TABLE public.loan_accounts
--   DROP COLUMN IF EXISTS structure_note,
--   DROP COLUMN IF EXISTS structure_note_updated_at,
--   DROP COLUMN IF EXISTS structure_note_updated_by;
