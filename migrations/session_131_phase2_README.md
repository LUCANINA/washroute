# Session 131 — Phase 2 (Safe Overrides) migrations

Phase 2 was applied directly via `apply_migration`. No standalone .sql file in this repo
because the migrations were multiple CREATE OR REPLACE statements plus an ALTER TABLE.
Supabase migration history records them as:

- `session_130_phase2_safe_overrides` (version `20260420161801`)

(The "130" in the name is a mis-label — the work is part of session 131. Kept as-is in
the migration history for stability.)

## What it did

1. `ALTER TABLE public.orders ADD COLUMN overcap_booking BOOLEAN NOT NULL DEFAULT FALSE`
2. `CREATE INDEX idx_orders_overcap_booking ON public.orders (overcap_booking) WHERE overcap_booking = TRUE`
3. Rewrote `auto_route_order(p_order_id UUID)` to introduce `v_sub_ceiling = GREATEST(stop_limit+1, FLOOR(stop_limit*1.25))` and set `overcap_booking = TRUE` in the soft-override range.
4. Rewrote `sync_pickup_stop_on_window_change()` with the same ceiling logic (local var: `v_route_ceiling`).
5. Rewrote `sync_delivery_stop_on_window_change()` with the same ceiling logic.

## How to read the current definitions

```sql
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname IN (
  'auto_route_order',
  'sync_pickup_stop_on_window_change',
  'sync_delivery_stop_on_window_change'
) AND pronamespace = 'public'::regnamespace;
```

## Rollback (if ever needed)

Don't. `overcap_booking = FALSE` on all existing rows is already a no-op.
If a rollback is required, the column can be dropped and the three functions reverted
to their session-98 (sync_*) / session-113 (auto_route_order) forms. See git history of
this repo for prior versions.
