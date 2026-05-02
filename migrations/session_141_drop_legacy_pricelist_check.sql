-- Migration: session_141_drop_legacy_pricelist_check
-- Purpose: Both services_pricelist_check and customers_pricelist_check were
--   hardcoded enums (Delivery/Commercial/[Retail]) from before the
--   service_categories table existed. service_categories is now the source of
--   truth and the admin Price Lists tab writes new entries there. The
--   constraints were rejecting any new admin-created price list (e.g. 'HCEB',
--   reported May 2 2026: "new row for relation 'services' violates check
--   constraint 'services_pricelist_check'").
--
--   Bonus: customers_pricelist_check was missing 'Retail' anyway (would have
--   rejected any customer pricelist='Retail'), an unrelated vestige.
--
-- Future-clean direction (separate session): convert services.pricelist and
-- customers.pricelist to FKs to service_categories.id (or unique-name lookups)
-- so renaming a price list ripples instead of orphaning rows.
--
-- Reversal (paste into SQL editor if ever needed):
--   ALTER TABLE services  ADD CONSTRAINT services_pricelist_check
--     CHECK (pricelist = ANY (ARRAY['Delivery'::text,'Commercial'::text,'Retail'::text]));
--   ALTER TABLE customers ADD CONSTRAINT customers_pricelist_check
--     CHECK (pricelist = ANY (ARRAY['Delivery'::text,'Commercial'::text]));

ALTER TABLE public.services  DROP CONSTRAINT IF EXISTS services_pricelist_check;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_pricelist_check;
