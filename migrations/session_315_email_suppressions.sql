-- Session 315 (2026-09-23): addresses that must never receive marketing email because they
-- are undeliverable (hard bounce) or blocked. Separate from
-- customers.email_marketing_opt_out_at, which records a PERSON's choice.
-- Read/written only by the sync-sendgrid edge function (service role).
-- Seeded with 142 Klaviyo hard bounces (source='klaviyo').
-- Rollback: DROP TABLE public.email_suppressions;
CREATE TABLE public.email_suppressions (
  email         text PRIMARY KEY
                CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  reason        text NOT NULL CHECK (reason IN ('hard_bounce','spam_report','invalid','blocked')),
  source        text NOT NULL CHECK (source IN ('klaviyo','sendgrid','manual')),
  first_seen_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_suppressions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_suppressions TO service_role;
COMMENT ON TABLE public.email_suppressions IS
  'Undeliverable/blocked addresses excluded from the SendGrid marketing list. Service-role only. Session 315.';
NOTIFY pgrst, 'reload schema';
