-- Session 346 — Oct 16, 2026: monthly savings emails
--
-- David's design (Oct 15): subscribers get a summary at 3 pm PT the day before each renewal
-- (what they used, what pay-per-bag would have cost, "charged tomorrow"), with honest variants
-- for light months, 3-month-negative ("switch to pay-per-bag") and no-order months ("pause").
-- Pay-per-bag customers who'd have saved on the plan every month for 3 months get the reverse
-- email on the 1st — a pilot of 20, the rest kept as a comparison group.
-- Sent by edge function savings-summary; info@ is BCC'd on every send.
--
-- Two new tables, service-role writes only, admins can read.

CREATE TABLE IF NOT EXISTS public.savings_email_sends (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.subscriptions(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('subscriber_cycle', 'perbag_monthly')),
  period_key      text NOT NULL,          -- subscriber: renewal date (PT, YYYY-MM-DD); per-bag: YYYY-MM
  variant         text NOT NULL,          -- saved | light_month | switch | no_orders | perbag_save
  figures         jsonb NOT NULL DEFAULT '{}'::jsonb,
  to_email        text,
  is_test         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
-- One real email per customer per period, ever (the claim row is written before sending).
CREATE UNIQUE INDEX IF NOT EXISTS savings_email_sends_once
  ON public.savings_email_sends (kind, customer_id, period_key) WHERE NOT is_test;
CREATE INDEX IF NOT EXISTS savings_email_sends_customer ON public.savings_email_sends (customer_id);

CREATE TABLE IF NOT EXISTS public.savings_email_pilot (
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  pilot       text NOT NULL,                                   -- e.g. 'perbag-2026-11'
  cohort      text NOT NULL CHECK (cohort IN ('email', 'control')),
  figures     jsonb NOT NULL DEFAULT '{}'::jsonb,              -- 3-month numbers at selection time
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pilot, customer_id)
);

ALTER TABLE public.savings_email_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.savings_email_pilot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_read_savings_email_sends ON public.savings_email_sends;
CREATE POLICY admin_read_savings_email_sends ON public.savings_email_sends
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS admin_read_savings_email_pilot ON public.savings_email_pilot;
CREATE POLICY admin_read_savings_email_pilot ON public.savings_email_pilot
  FOR SELECT TO authenticated USING (public.is_admin());

-- Explicit grants (Data API default-grant cutover Oct 30). No anon.
REVOKE ALL ON public.savings_email_sends FROM anon, authenticated;
REVOKE ALL ON public.savings_email_pilot FROM anon, authenticated;
GRANT SELECT ON public.savings_email_sends TO authenticated;
GRANT SELECT ON public.savings_email_pilot TO authenticated;
GRANT ALL ON public.savings_email_sends TO service_role;
GRANT ALL ON public.savings_email_pilot TO service_role;

-- Rollback: DROP TABLE public.savings_email_sends; DROP TABLE public.savings_email_pilot;
