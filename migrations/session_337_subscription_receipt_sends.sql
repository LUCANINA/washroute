-- session_337_subscription_receipt_sends.sql
--
-- Subscription receipts (customers asked for them, like order receipts).
-- One row per receipt EMAIL for a subscription payment (customer_transactions
-- type 'subscription_invoice'). Written by the `subscription-receipt` edge function
-- (service role) BEFORE the send ("claim"), then marked sent/failed.
--
-- The partial unique index is the once-per-payment guarantee for AUTOMATIC sends:
-- a retried Stripe webhook can never email the same renewal twice. Staff resends
-- (source 'manual') are deliberately not limited.
--
-- PDF downloads are not logged (nothing is sent).
--
-- ROLLBACK: DROP TABLE public.subscription_receipt_sends;  (log only; nothing depends on it
--           except the edge function, which then fails closed — no auto emails)

CREATE TABLE public.subscription_receipt_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid NOT NULL REFERENCES public.customer_transactions(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('auto', 'manual')),
  email           text NOT NULL,
  status          text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  error           text,
  sent_by         uuid,            -- profiles.id of the staff member for manual sends
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE UNIQUE INDEX subscription_receipt_sends_one_auto_per_txn
  ON public.subscription_receipt_sends (transaction_id) WHERE source = 'auto';
CREATE INDEX subscription_receipt_sends_txn_idx
  ON public.subscription_receipt_sends (transaction_id, created_at DESC);
CREATE INDEX subscription_receipt_sends_customer_idx
  ON public.subscription_receipt_sends (customer_id, created_at DESC);

ALTER TABLE public.subscription_receipt_sends ENABLE ROW LEVEL SECURITY;

-- Staff who can see the customer panel can see when a receipt went out.
-- Writes come only from the edge function (service_role bypasses RLS).
CREATE POLICY staff_read_subscription_receipt_sends ON public.subscription_receipt_sends
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

REVOKE ALL ON public.subscription_receipt_sends FROM anon, authenticated;
GRANT SELECT ON public.subscription_receipt_sends TO authenticated;
GRANT ALL ON public.subscription_receipt_sends TO service_role;

DO $chk$
BEGIN
  IF has_table_privilege('anon', 'public.subscription_receipt_sends', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read subscription_receipt_sends';
  END IF;
  IF has_table_privilege('authenticated', 'public.subscription_receipt_sends', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated can insert subscription_receipt_sends';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.subscription_receipt_sends'::regclass) THEN
    RAISE EXCEPTION 'RLS not enabled';
  END IF;
END $chk$;
