-- Session 321 (2026-09-28): win-back credit campaign tracking.
-- One row per customer per batch. The winback edge function (x-wr-internal only) reads/writes it
-- with the service role; staff can read it in the dashboard. No customer or anon access.
-- Money never moves through this table: credits go through adjust_customer_credits (ledger).
-- Rollback:  DROP TABLE IF EXISTS public.winback_grants;
CREATE TABLE public.winback_grants (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch           text        NOT NULL,
  customer_id     uuid        NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,  -- merge_duplicate_customer deletes rows; RESTRICT would block merges
  amount          numeric(10,2) NOT NULL CHECK (amount > 0 AND amount <= 100),
  release_at      timestamptz,             -- NULL = held; the function only touches released rows
  grant_status    text        NOT NULL DEFAULT 'pending'
                  CHECK (grant_status IN ('pending','granting','granted','skipped','failed')),
  grant_note      text,
  granted_at      timestamptz,
  expires_at      timestamptz,
  email_status    text        NOT NULL DEFAULT 'pending'
                  CHECK (email_status IN ('pending','sending','sent','skipped','failed')),
  email_sent_at   timestamptz,
  email_error     text,
  sms_status      text        NOT NULL DEFAULT 'pending'
                  CHECK (sms_status IN ('pending','sending','sent','skipped','failed')),
  sms_sent_at     timestamptz,
  sms_error       text,
  expired_at      timestamptz,
  expired_amount  numeric(10,2),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch, customer_id)
);
CREATE INDEX idx_winback_grants_customer ON public.winback_grants (customer_id);
CREATE INDEX idx_winback_grants_work ON public.winback_grants (batch, grant_status, release_at);
COMMENT ON TABLE public.winback_grants IS
  'Session 321. Win-back credit campaign: who got a credit, when, email/SMS status, expiry. Written only by the winback edge function; credits themselves go through adjust_customer_credits.';

ALTER TABLE public.winback_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.winback_grants FROM anon;
GRANT SELECT ON public.winback_grants TO authenticated;
GRANT ALL ON public.winback_grants TO service_role;
CREATE POLICY winback_grants_staff_read ON public.winback_grants
  FOR SELECT TO authenticated USING (public.is_staff());

NOTIFY pgrst, 'reload schema';

-- session_321a_winback_grants_tighten (applied separately): default privileges gave authenticated
-- full rights; RLS blocks writes but not TRUNCATE, so staff get read-only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.winback_grants FROM authenticated;

-- Operational steps run 2026-09-28 (not DDL; recorded here for history):
--  1. Enrolled batch WB-2026-10-A: 415 individual customers, ordered in WashRoute, none delivered in 60+ days,
--     no open order, no frozen/cancelled flag, $0 credit. amount=20, release_at=NULL (held).
--  2. Pilot: 10 random rows (email + SMS reachable) released at 2026-09-29 16:45 UTC.
--  3. Cron: SELECT cron.schedule('wr-winback-tick', '*/15 17 * * *', <net.http_post winback {mode:'tick'} with x-wr-internal>);
--     = 10:00-10:45 AM PDT daily. Only released rows are ever touched.
-- Release the rest after the pilot checks out:
--   UPDATE winback_grants SET release_at = now() WHERE batch='WB-2026-10-A' AND release_at IS NULL;
-- Stop everything:  SELECT cron.unschedule('wr-winback-tick');

-- session_321b_marketing_sms_log (applied 2026-09-28): log for automated marketing texts (signup nudges).
CREATE TABLE public.marketing_sms_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('signup_d2','signup_d7')),
  status       text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','sent','skipped','failed')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  UNIQUE (customer_id, kind)
);
ALTER TABLE public.marketing_sms_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.marketing_sms_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.marketing_sms_log FROM authenticated;
GRANT SELECT ON public.marketing_sms_log TO authenticated;
GRANT ALL ON public.marketing_sms_log TO service_role;
CREATE POLICY marketing_sms_log_staff_read ON public.marketing_sms_log FOR SELECT TO authenticated USING (public.is_staff());
-- Rollback: DROP TABLE IF EXISTS public.marketing_sms_log;
-- Cron (2026-09-28): SELECT cron.schedule('wr-signup-texts', '5 17 * * *', <net.http_post signup-texts {mode:'run'} with x-wr-internal>);
--   = 10:05 AM PDT daily. Stop: SELECT cron.unschedule('wr-signup-texts');
