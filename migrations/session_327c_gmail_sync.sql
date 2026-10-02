-- Session 327c — Gmail (info@familylaundry.com) → customer email history.
--
-- 1. email_messages gains the Gmail ids of messages copied in from the info@
--    mailbox. gmail_message_id is UNIQUE so a re-run, an overlapping backfill
--    or a retry can never save the same email twice. A plain (non-partial)
--    unique constraint on purpose: PostgREST's on_conflict cannot target a
--    partial index, and NULLs (every app-sent row) never collide.
-- 2. gmail_sync: ONE row holding the Google OAuth client, the Gmail connection
--    (refresh token) and the
--    sync cursor. Service-role only — RLS on, no policies, no anon/authenticated
--    grants (same posture as wr_internal_auth). Staff read its status through
--    the gmail-sync edge function, which never returns the token.
--
-- Additive only. Rollback at the bottom.

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS gmail_message_id text,
  ADD COLUMN IF NOT EXISTS gmail_thread_id  text;

ALTER TABLE public.email_messages
  ADD CONSTRAINT email_messages_gmail_message_id_key UNIQUE (gmail_message_id);

COMMENT ON COLUMN public.email_messages.gmail_message_id IS
  'Session 327c: Gmail message id when the row was copied from the info@ mailbox by gmail-sync. NULL = sent by the app via SendGrid.';

CREATE TABLE IF NOT EXISTS public.gmail_sync (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id             text,        -- Google OAuth client (pasted in Admin → Settings)
  client_secret         text,
  account_email         text,
  refresh_token         text,
  history_id            text,
  connected_at          timestamptz,
  connected_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  last_run_at           timestamptz,
  last_success_at       timestamptz,
  last_error            text,
  consecutive_failures  int NOT NULL DEFAULT 0,
  alerted_at            timestamptz,
  saved_total           int NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gmail_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gmail_sync FROM PUBLIC;
REVOKE ALL ON public.gmail_sync FROM anon;
REVOKE ALL ON public.gmail_sync FROM authenticated;
GRANT ALL ON public.gmail_sync TO service_role;

INSERT INTO public.gmail_sync (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ROLLBACK:
--   DROP TABLE public.gmail_sync;
--   ALTER TABLE public.email_messages DROP CONSTRAINT email_messages_gmail_message_id_key;
--   ALTER TABLE public.email_messages DROP COLUMN gmail_thread_id, DROP COLUMN gmail_message_id;
--   (Deleting the copied rows first, if wanted: DELETE FROM email_messages WHERE gmail_message_id IS NOT NULL;)
