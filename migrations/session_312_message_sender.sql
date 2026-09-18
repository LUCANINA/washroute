-- Session 312: record WHO sent every outbound customer message.
-- send-sms / send-email stamp these from the caller's login (JWT), server-side,
-- so the browser cannot claim to be someone else. NULL = sent by the system
-- (automations, cron, service-role callers) or sent before this change.
-- sent_by_name is a snapshot so the name survives staff deletion and does not
-- depend on the viewer being allowed to read other people's profiles.

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS sent_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_by_name    text;

ALTER TABLE public.email_messages
  ADD COLUMN IF NOT EXISTS sent_by_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sent_by_name    text;

CREATE INDEX IF NOT EXISTS sms_messages_sent_by_user_id_idx
  ON public.sms_messages (sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_messages_sent_by_user_id_idx
  ON public.email_messages (sent_by_user_id) WHERE sent_by_user_id IS NOT NULL;

COMMENT ON COLUMN public.sms_messages.sent_by_user_id IS 'Staff login that sent this message (from JWT in send-sms). NULL = system/automated or pre-s312.';
COMMENT ON COLUMN public.email_messages.sent_by_user_id IS 'Staff login that sent this email (from JWT in send-email). NULL = system/automated or pre-s312.';
