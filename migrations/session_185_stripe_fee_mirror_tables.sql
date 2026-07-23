-- session_185_stripe_fee_mirror_tables.sql
-- Applied via Supabase apply_migration (name: stripe_fee_mirror_tables) on 2026-07-22.
--
-- Server-side mirror of Stripe balance-transaction fees so the Daily Revenue + POS
-- Sales reports read fees from Postgres instead of paginating the Stripe API live
-- (~2.5s+, measured) on every load. Populated by get-stripe-fees v11 (incremental
-- forward sync + bounded backward backfill). Settled balance transactions are
-- immutable, so a mirrored window is answered instantly and permanently.
--
-- Touched ONLY by the get-stripe-fees edge function (service_role, bypasses RLS).
-- RLS enabled + anon/authenticated REVOKED -> invisible to the Data API (financial).

CREATE TABLE IF NOT EXISTS public.stripe_fee_cache (
  payment_intent_id text PRIMARY KEY,
  fee_cents    integer NOT NULL,
  net_cents    integer NOT NULL,
  charge_cents integer NOT NULL,
  bt_id        text,
  bt_created   timestamptz NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_fee_cache_bt_created ON public.stripe_fee_cache (bt_created);
ALTER TABLE public.stripe_fee_cache ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.stripe_fee_sync (
  id              integer PRIMARY KEY DEFAULT 1,
  forward_cursor  timestamptz,
  backward_cursor timestamptz,
  backfill_done   boolean NOT NULL DEFAULT false,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_fee_sync_singleton CHECK (id = 1)
);
ALTER TABLE public.stripe_fee_sync ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.stripe_fee_cache TO service_role;
GRANT ALL ON public.stripe_fee_sync  TO service_role;

-- WashRoute's public schema still auto-grants anon/authenticated on new tables
-- (pre-Oct-2026 cutover default ACL), so revoke them explicitly for these
-- financial tables. RLS already denies them (no policies), this also hides them
-- from the Data API entirely.
REVOKE ALL ON public.stripe_fee_cache FROM anon, authenticated;
REVOKE ALL ON public.stripe_fee_sync  FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.stripe_fee_cache;
-- DROP TABLE IF EXISTS public.stripe_fee_sync;
-- (and redeploy get-stripe-fees v10 — the pre-mirror version paginates Stripe live)
