-- Session 352d (2026-10-20) — APPLIED. Durable rate limit for the public website-contact function.
-- Service-role only: RLS on, no policies, no anon/authenticated grants.
CREATE TABLE IF NOT EXISTS public.website_contact_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip_hash    text NOT NULL,
  email      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS website_contact_log_created_at_idx ON public.website_contact_log (created_at);
CREATE INDEX IF NOT EXISTS website_contact_log_ip_idx ON public.website_contact_log (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS website_contact_log_email_idx ON public.website_contact_log (email, created_at);
ALTER TABLE public.website_contact_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.website_contact_log FROM anon, authenticated;
GRANT ALL ON public.website_contact_log TO service_role;
