-- Supabase security alert (security_definer_view), 2026-09-16.
-- The view ran with its owner's rights, so any logged-in customer could read every unpaid order
-- (names, phones, amounts). It now obeys the caller's RLS. Verified: admin/manager/laundry_tech
-- see identical rows (278) and totals before/after; customers, cpa and attendant now see none.
-- Rollback: ALTER VIEW public.v_outstanding_orders RESET (security_invoker);
ALTER VIEW public.v_outstanding_orders SET (security_invoker = true);
REVOKE ALL ON public.v_outstanding_orders FROM anon;
