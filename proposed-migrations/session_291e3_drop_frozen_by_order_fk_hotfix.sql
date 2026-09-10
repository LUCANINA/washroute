-- Session 291e-3 HOTFIX — drop the frozen_by_order_id FOREIGN KEY.
-- APPLIED 2026-09-10, minutes after 291e, to restore production.
--
-- INCIDENT. 291e added:
--     customers.frozen_by_order_id uuid REFERENCES orders(id) ON DELETE SET NULL
-- orders.customer_id -> customers.id already existed, so that made TWO
-- relationships between the same pair of tables. PostgREST resolves embeds by
-- relationship, so every orders<->customers embed in all four apps became
-- ambiguous the moment the migration landed:
--
--     "Could not embed because more than one relationship was found for
--      'orders' and 'customers'"
--
-- The Orders page showed "Failed to load orders". David caught it.
--
-- FIX: keep the COLUMN, drop the CONSTRAINT. The column exists to record which
-- debt caused a freeze, so auto-unfreeze releases only a debt freeze and never a
-- manual one -- a soft reference does that job completely. Referential integrity
-- on it is a nice-to-have; a working Orders page is not.
--
-- Lost: ON DELETE SET NULL. Acceptable -- orders are never hard-deleted here
-- (archive/cancel instead), and a stale id would at worst leave an unfreeze rule
-- with nothing to match. Nothing is corrupted by it.
--
-- ── THE LESSON, for the migration reviewer ──────────────────────────────────
-- Adding a FOREIGN KEY between two tables that ALREADY have one is a BREAKING
-- CHANGE to every PostgREST embed between them -- while dropping nothing,
-- renaming nothing, and touching no existing column. The DROP/RENAME audit does
-- not look for it and did not catch it. Before adding any FK, check whether a
-- relationship between those two tables already exists:
--
--   SELECT conname, conrelid::regclass, confrelid::regclass
--   FROM pg_constraint
--   WHERE contype='f'
--     AND ((conrelid='public.A'::regclass AND confrelid='public.B'::regclass)
--       OR (conrelid='public.B'::regclass AND confrelid='public.A'::regclass));
--
-- If it returns a row, either do not add the FK, or be prepared to disambiguate
-- EVERY embed in all four apps with !constraint_name hints. On this codebase the
-- second option is dozens of call sites; the soft reference is the right trade.

ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_frozen_by_order_id_fkey;

COMMENT ON COLUMN public.customers.frozen_by_order_id IS
  'Order whose write-off caused this freeze, so auto-unfreeze releases only a debt freeze and never a manual one. Deliberately NOT a foreign key: a second FK between customers and orders makes every PostgREST embed between them ambiguous and took the Orders page down in session 291e. Soft reference by design.';

-- Verified after applying (anon REST, 200 = shape resolves; ambiguity is a
-- planning-time error and would fail before RLS):
--   orders?select=id,customers(...)                          -> 200
--   customers?select=id,orders(id)                           -> 200
--   route_stops?select=id,orders(...,customers(...))         -> 200
--   customers?select=id,frozen_at,frozen_by_order_id         -> 200 (column kept)

-- ── RECOVERY, for the record ────────────────────────────────────────────────
-- Dropping the constraint fixed the database instantly, but the dashboard kept
-- failing for ~20 more minutes. What did NOT clear it:
--     NOTIFY pgrst, 'reload schema'          (issued twice)
--     COMMENT ON TABLE orders (DDL nudge)    (fires pgrst_ddl_watch)
-- Meanwhile curl returned 200 on the Orders page's exact select, 20/20, and
-- Processing partially recovered while Orders stayed broken -- some PostgREST
-- workers had reloaded and others had not.
-- WHAT CLEARED IT: Supabase dashboard -> Settings -> General -> Restart project.
-- Same sequence as session 176/177. Budget the restart as part of any schema
-- change that touches relationships.
