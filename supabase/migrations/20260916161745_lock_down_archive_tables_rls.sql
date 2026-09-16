-- Supabase security alert (rls_disabled_in_public), 2026-09-16.
-- Eight _archive_ backup tables had no RLS. Nothing in the apps, DB functions or cron reads them.
-- Rollback: ALTER TABLE ... DISABLE ROW LEVEL SECURITY; GRANT ... TO anon, authenticated;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_archive_sweep_autocharge_291g','_archive_kidango_ondemand_291j','_archive_kidango_discount_291k',
    '_archive_recurring_fn_291o','_archive_discount_fix_291p','_archive_advance_order_status_291t',
    '_archive_racked_at_backfill_291t','_archive_sweep_autocharge_291j'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;
