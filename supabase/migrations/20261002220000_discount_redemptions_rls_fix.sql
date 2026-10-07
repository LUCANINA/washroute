-- Session 329: discount_redemptions read rules (NOT YET APPLIED — needs David's OK)
--
-- Problem 1 (privacy): customer_read_own_redemptions compared customer_id to
--   itself, so ANY signed-in user with a profile — including every customer —
--   could read all redemption rows (customer ids, order ids, who redeemed).
-- Problem 2 (the Discounts page 500): for each redemption row, both old rules
--   scanned the whole profiles table, and profiles' own rules call is_admin()
--   per profile row. 62 rows took 1.7s idle and hit the 8s limit under load →
--   HTTP 500 on Discounts (and a slow promo-code dropdown in the customer panel).
--
-- Fix: one staff rule (is_staff(), evaluated once per query) + a real
-- "own rows" rule for customers via customers.profile_id (indexed).
-- Staff roles keep exactly the access they have today; cpa loses it (no use found).
-- Writes are unchanged (no INSERT/UPDATE/DELETE policies; the RPC and edge
-- functions write as definer/service role).

DROP POLICY IF EXISTS customer_read_own_redemptions ON public.discount_redemptions;
DROP POLICY IF EXISTS admin_read_all_redemptions   ON public.discount_redemptions;

CREATE POLICY staff_read_all_redemptions ON public.discount_redemptions
  FOR SELECT TO authenticated
  USING ((SELECT public.is_staff()));

CREATE POLICY customer_read_own_redemptions ON public.discount_redemptions
  FOR SELECT TO authenticated
  USING (customer_id IN (
    SELECT c.id FROM public.customers c WHERE c.profile_id = (SELECT auth.uid())
  ));

-- Rollback (restores the old, leaky rules exactly):
-- DROP POLICY staff_read_all_redemptions ON public.discount_redemptions;
-- DROP POLICY customer_read_own_redemptions ON public.discount_redemptions;
-- CREATE POLICY admin_read_all_redemptions ON public.discount_redemptions FOR SELECT TO authenticated
--   USING (EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role = 'admin'));
-- CREATE POLICY customer_read_own_redemptions ON public.discount_redemptions FOR SELECT TO authenticated
--   USING (customer_id IN (SELECT discount_redemptions.customer_id FROM profiles
--          WHERE profiles.id = auth.uid() AND discount_redemptions.customer_id IS NOT NULL));
