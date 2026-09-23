-- Session 315 (2026-09-23): log of lifecycle emails WashRoute sends itself (welcome series).
-- UNIQUE (customer_id, kind) makes a second copy of the same email impossible:
-- the welcome-emails function inserts the row BEFORE sending ("log first").
-- Service-role only. Rollback: DROP TABLE public.email_send_log;
CREATE TABLE public.email_send_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('welcome_1', 'welcome_2')),
  email               text NOT NULL,
  status              text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  sendgrid_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  UNIQUE (customer_id, kind)
);
CREATE INDEX email_send_log_kind_sent_idx ON public.email_send_log (kind, sent_at);
ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_send_log FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_send_log TO service_role;
COMMENT ON TABLE public.email_send_log IS 'Welcome-series sends (session 315). One row per customer per email; inserted before sending.';
NOTIFY pgrst, 'reload schema';
