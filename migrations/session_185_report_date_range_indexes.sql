-- session_185_report_date_range_indexes.sql
-- Applied via Supabase apply_migration (name: report_date_range_indexes) on 2026-07-22.
--
-- Speeds up the analytics reports. These orders columns are range-filtered on every
-- report load but were unindexed, forcing full seq scans of the ~9,700-row orders table:
--   actual_delivery_at, billed_at  → delivery_kpis RPC (_dk_window), scanned ~12+ times/load
--   racked_at                      → Daily Revenue report
--   delivery_window_start          → Launderers report + Orders>Map fetches
--
-- Verified: Revenue racked_at query 868→440 buffers (5.8ms→2.1ms, now Bitmap Index Scan);
-- Launderers delivery_window_start query now Index Scan (2.7ms). Partial WHERE ... IS NOT NULL
-- keeps the timestamp indexes small (many rows have NULL for these columns).
-- (The bigger report lag was uncached external API calls — Square hours + Stripe fees —
-- fixed client-side with per-window caches; not part of this migration.)

CREATE INDEX IF NOT EXISTS idx_orders_actual_delivery_at
  ON public.orders (actual_delivery_at) WHERE actual_delivery_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_billed_at
  ON public.orders (billed_at) WHERE billed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_racked_at
  ON public.orders (racked_at) WHERE racked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_delivery_window_start
  ON public.orders (delivery_window_start);

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_orders_actual_delivery_at;
-- DROP INDEX IF EXISTS public.idx_orders_billed_at;
-- DROP INDEX IF EXISTS public.idx_orders_racked_at;
-- DROP INDEX IF EXISTS public.idx_orders_delivery_window_start;
