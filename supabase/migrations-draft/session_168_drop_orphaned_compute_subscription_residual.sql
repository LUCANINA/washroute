-- A1 (session 168, APPLIED): drop the orphaned compute_subscription_residual RPC.
-- Built for the discarded v1 bill-split architecture. In the live v2 (pricelist)
-- model the apply_subscription_usage_fn trigger writes lb_overage into line_items
-- + total_amount, so this RPC double-counts overage (sums the trigger-written
-- lb_overage line as "other" AND recomputes it from weight — e.g. order #6533:
-- real total $61, RPC returned card_charge_total $116). Zero callers in code or
-- DB (verified). Removing it eliminates a loaded gun. Reversible: the definition
-- is preserved in migrations-draft/session_165_subscription_bill_split.sql.
DROP FUNCTION IF EXISTS public.compute_subscription_residual(uuid);
