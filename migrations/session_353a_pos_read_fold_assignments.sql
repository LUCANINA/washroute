-- Session 353a — Oct 20, 2026
-- POS saved launderer splits (assign_order_launderers is SECURITY DEFINER) but could
-- not READ them back: the only policy on order_folding_assignments was is_admin()
-- (admin/manager/laundry_tech). The queue card fell back to orders.folded_by_id and
-- showed one name, so attendants believed the split had failed.
-- Read-only, ops staff only (same helper session 351 introduced). Writes still go
-- only through assign_order_launderers.
CREATE POLICY ops_staff_read_fold_assignments
  ON public.order_folding_assignments
  FOR SELECT TO authenticated
  USING ((SELECT public.is_ops_staff()));

-- Rollback:
-- DROP POLICY ops_staff_read_fold_assignments ON public.order_folding_assignments;
