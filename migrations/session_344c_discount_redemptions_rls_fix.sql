-- session_344c_discount_redemptions_rls_fix.sql
-- APPLIED 2026-10-13 (verified). Reviewed with `washroute-migration-review`.
-- Recorded in Supabase migration history as THREE entries, in this order:
--   session_344_probe_comment            (the COMMENT below)
--   session_344a_redemptions_staff_policy
--   session_344b_redemptions_customer_policy
--
-- WHY IT IS SPLIT: a single multi-statement migration with DROP POLICY timed out
-- twice at 180s. DROP POLICY needs ACCESS EXCLUSIVE on the table, and it queued
-- behind the very dashboard queries that were themselves timing out (below).
-- ALTER POLICY changes USING in place and applied instantly. If you ever need to
-- redo this, prefer ALTER POLICY over DROP + CREATE on a table under live load.
--
-- PROBLEM (found by the daily audit, 2026-10-13)
-- GET /rest/v1/discount_redemptions?select=discount_id,discount_type_snapshot,
-- discount_value_snapshot,redeemed_at&order=redeemed_at.desc returned HTTP 500
-- twelve times in 24h from admin.familylaundry.com (Admin -> Discounts tab,
-- loadDiscounts()). postgrest_logs showed
-- {"code":"57014","message":"canceling statement due to statement timeout"}.
-- The table holds 67 rows, so the data was never the problem. Both SELECT
-- policies ran an inline sub-SELECT against public.profiles. Reading profiles
-- from inside a policy triggers profiles' OWN rls, whose SELECT policy is
-- is_admin() -- so a SECURITY DEFINER function was evaluated per profiles row
-- (1,962) per discount_redemptions row (67). ~130k nested calls -> timeout.
--
-- SECOND, INDEPENDENT BUG in the same policy. Old definition:
--   customer_id IN (SELECT discount_redemptions.customer_id
--                     FROM profiles
--                    WHERE profiles.id = auth.uid()
--                      AND discount_redemptions.customer_id IS NOT NULL)
-- The sub-SELECT selects the OUTER row's customer_id out of profiles, so the
-- predicate collapsed to "I have a profile AND this row has a customer_id".
-- Any signed-in customer could read EVERY redemption row, not just their own.
--
-- FIX: call the existing SECURITY DEFINER helpers instead of inlining profiles.
-- They bypass profiles' rls and are STABLE, so they are evaluated once per query
-- rather than once per row -- the pattern already used by "Users update own
-- profile" on public.profiles.
--
-- SCOPE CHANGE (deliberate, confirmed with David before applying): the old staff
-- policy tested role = 'admin' only. public.is_admin() returns true for admin,
-- manager and laundry_tech -- the same set that can already read public.discounts
-- and open the Discounts tab.
--
-- VERIFIED AFTER APPLY (as role `authenticated`, with request.jwt.claims set):
--   admin   -> 67 rows, 3.6 ms, current_customer_id() hoisted to an InitPlan
--   manager -> 67 rows (intended widening)
--   driver  -> 0 rows
--   customer 21a3efda-491f-47fc-9ffe-0d10c9cc8398 -> 2 rows, 1 distinct
--              customer_id (was all 67 before)
--
-- NOT AFFECTED
--   * No column added, dropped or renamed -> no PostgREST schema-cache risk
--     (sessions 176/177), no DB-function or client-side column audit needed.
--   * Writes unchanged: this table has no INSERT/UPDATE/DELETE policies. Rows
--     are written by redeem_discount_code() and merge_duplicate_customer(),
--     both SECURITY DEFINER, which bypasses rls.
--   * Grants unchanged: only `authenticated:SELECT`; anon has none. No new
--     table, so the Oct 30 2026 default-grant cutover does not apply.
--   * welcome-emails (cron `wr-welcome-emails`) reads this table with
--     SUPABASE_SERVICE_ROLE_KEY, which bypasses rls -> unaffected.
--   * customer-app no longer reads this table (the currentRedemptions cache was
--     removed; Billing History reads customer_transactions). The corrected
--     customer policy is kept anyway, scoped properly.
--
-- SHIPPED ALONGSIDE (client, not in this file):
--   admin-dashboard/index.html loadDiscounts() -- the three reads were swallowed
--   with `|| []`, which is why a 500 rendered as blank "Redeemed ($)" /
--   "Redeemed (date)" columns instead of an error. Now checks .error and toasts.

COMMENT ON TABLE public.discount_redemptions IS 'Discount claim ledger. RLS: see session_344.';

ALTER POLICY admin_read_all_redemptions
  ON public.discount_redemptions
  USING ( public.is_admin() );

ALTER POLICY customer_read_own_redemptions
  ON public.discount_redemptions
  USING (
    customer_id IS NOT NULL
    AND customer_id = (SELECT public.current_customer_id())
  );

-- ROLLBACK (restores the prior state, INCLUDING the malformed customer policy
-- that lets any signed-in customer read every row -- only for emergency revert):
--
-- ALTER POLICY admin_read_all_redemptions ON public.discount_redemptions
--   USING (EXISTS ( SELECT 1 FROM profiles
--     WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))));
--
-- ALTER POLICY customer_read_own_redemptions ON public.discount_redemptions
--   USING (customer_id IN ( SELECT discount_redemptions.customer_id FROM profiles
--     WHERE ((profiles.id = auth.uid()) AND (discount_redemptions.customer_id IS NOT NULL))));
