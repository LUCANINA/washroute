-- Migration: session_141_discount_redemptions_table
-- Purpose: Audit log of every discount/coupon redemption.
--   Source of truth for "who used what."
--   Partial unique indexes enforce the type-specific reuse rules:
--     fixed codes  → single-use globally
--     percent codes → one-per-customer
--   Snapshot columns preserve immutable history so admin edits to a
--   discount don't rewrite the past.

CREATE TABLE public.discount_redemptions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discount_id              UUID NOT NULL REFERENCES public.discounts(id) ON DELETE RESTRICT,
  customer_id              UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  order_id                 UUID NULL REFERENCES public.orders(id) ON DELETE SET NULL,
  redeemed_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  redeemed_by              TEXT NOT NULL DEFAULT 'self',
  -- 'self' (customer self-service) or 'admin:Name' (admin-applied) — actor attribution

  discount_type_snapshot   TEXT NOT NULL CHECK (discount_type_snapshot IN ('percent','fixed')),
  discount_value_snapshot  NUMERIC(10,2) NOT NULL CHECK (discount_value_snapshot > 0),
  discount_name_snapshot   TEXT NOT NULL
);

CREATE INDEX idx_discount_redemptions_customer_recent
  ON public.discount_redemptions (customer_id, redeemed_at DESC);

CREATE INDEX idx_discount_redemptions_order
  ON public.discount_redemptions (order_id) WHERE order_id IS NOT NULL;

-- $ codes: single-use globally
CREATE UNIQUE INDEX uniq_fixed_discount_redemption
  ON public.discount_redemptions (discount_id)
  WHERE discount_type_snapshot = 'fixed';

-- % codes: one per customer per code
CREATE UNIQUE INDEX uniq_percent_discount_redemption
  ON public.discount_redemptions (discount_id, customer_id)
  WHERE discount_type_snapshot = 'percent';

ALTER TABLE public.discount_redemptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_read_own_redemptions"
  ON public.discount_redemptions FOR SELECT TO authenticated
  USING (
    customer_id IN (
      SELECT customer_id FROM public.profiles
      WHERE id = auth.uid() AND customer_id IS NOT NULL
    )
  );

CREATE POLICY "admin_read_all_redemptions"
  ON public.discount_redemptions FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin')
  );

REVOKE ALL ON public.discount_redemptions FROM anon, authenticated;
GRANT SELECT ON public.discount_redemptions TO authenticated;
-- All writes go through the redeem_discount_code RPC (SECURITY DEFINER + service role).

COMMENT ON TABLE public.discount_redemptions IS
  'Audit log of every discount/coupon redemption. Source of truth for who used what.';
