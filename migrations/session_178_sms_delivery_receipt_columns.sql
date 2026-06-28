-- Delivery-receipt tracking for SMS (Twilio status callbacks).
-- Additive, nullable columns + lookup index. No drops/renames/backfill.

ALTER TABLE public.sms_messages
  ADD COLUMN IF NOT EXISTS error_code        TEXT,
  ADD COLUMN IF NOT EXISTS error_message     TEXT,
  ADD COLUMN IF NOT EXISTS delivered_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ;

-- The status callback looks up rows by twilio_sid on every status transition.
-- Without this index that is a full table scan per callback (~47k rows, growing).
CREATE INDEX IF NOT EXISTS idx_sms_messages_twilio_sid
  ON public.sms_messages (twilio_sid)
  WHERE twilio_sid IS NOT NULL;

-- Support a "recent failures" view / future alert efficiently.
CREATE INDEX IF NOT EXISTS idx_sms_messages_failed
  ON public.sms_messages (created_at DESC)
  WHERE status IN ('failed', 'undelivered');
