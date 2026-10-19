-- Session 347: photos (and other attachments) on emails copied from Gmail.
-- NULL  = not yet checked by gmail-sync (rows synced before this session; filled a
--         few per cron run, newest first).
-- []    = checked, nothing worth keeping.
-- [{url, path, name, content_type, size}] = copied to storage bucket sms-media
--         under email/<gmail_message_id>/. An entry with "missing": true means
--         Gmail had it but the copy failed — open the email in Gmail.
-- Rollback: ALTER TABLE public.email_messages DROP COLUMN attachments;
ALTER TABLE public.email_messages ADD COLUMN IF NOT EXISTS attachments jsonb;
COMMENT ON COLUMN public.email_messages.attachments IS
  'Session 347: attachments copied from Gmail (NULL = not checked yet). See migrations/session_347_email_attachments.sql';
