-- session 292g — referral notifications (the last piece of the program)
--
-- APPLIED 2026-09-12. Ships inert on three independent gates.
--
-- Why a new edge function instead of notification_queue: that table is keyed by
-- order_id and send-order-notification resolves the recipient FROM the order, so
-- reusing it would have texted the friend instead of the referrer. Both referral
-- messages go to someone who is not the customer on the triggering order.
--
-- Why not extend send-order-notification: it is on the live pickup/delivery SMS
-- path, and editing it means redeploying it. A new function has no blast radius
-- of its own and its verify_jwt is set at first deploy rather than changed.
--
-- Pieces:
--   referrals.friend_reminded_at        one reminder per pair, never two
--   message_templates                   referral_qualified + referral_reminder,
--                                       both sms_enabled=false, email_enabled=false
--   sweep_referral_notifications()      cron entry point; returns NULL and makes
--                                       no HTTP call at all while the program is off
--   cron job wr-referral-notifications  7,22,37,52 * * * * (off-peak minutes so it
--                                       does not pile onto the :00 sweeps)
--   edge function referral-notify       deployed v2, verify_jwt TRUE
--
-- The gates between this code and a customer's phone:
--   1. settings.referral_config.enabled = true        (SQL side AND function side)
--   2. the template's sms_enabled = true              (per message, independently)
--   3. a referral in the right state, not yet stamped (zero rows today)
-- Plus MAX_PER_RUN = 20 inside the function, so a backlog can never fan out.
--
-- Verified after deploy, through the real cron path (net.http_post with the
-- x-wr-internal secret and the anon bearer, body {"dryRun":true}):
--   200 {"ok":true,"skipped":"program_disabled","sent":0,"schema":{"ok":true}}
-- The schema probe is the session 176/177 check: it proves the data API sees
-- friend_reminded_at and referrer_notified_at BEFORE anything depends on them.
-- A dry run always reports it, so this stays checkable later.
--
-- To go live, after the quiet week:
--   1. Notifications → switch on "Referral Earned (to the referrer)" — test it to
--      your own number first, the way every other template gets tested.
--   2. Referrals → the reminder field is already 7 days; switch on "Referral
--      Credit Reminder (to the friend)" only if you want that second message.
--
-- Rollback: SELECT cron.unschedule('wr-referral-notifications');
--           DROP FUNCTION public.sweep_referral_notifications();
--           the templates can simply stay disabled; the column is additive.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS friend_reminded_at timestamptz;

COMMENT ON COLUMN public.referrals.friend_reminded_at IS
  'When the one reminder to the referred friend was sent. NULL = not sent.';

INSERT INTO public.message_templates
  (trigger_key, trigger_label, category, sort_order, sms_enabled, sms_body, email_enabled, email_subject, email_body)
SELECT 'referral_qualified', 'Referral Earned (to the referrer)', 'payment', 30, false,
       'Nice — {{friend_name}}''s first order is done, so {{amount}} credit is on {{credit_place}}. Thanks for the introduction, {{first_name}}.',
       false, '', ''
WHERE NOT EXISTS (SELECT 1 FROM public.message_templates WHERE trigger_key = 'referral_qualified');

INSERT INTO public.message_templates
  (trigger_key, trigger_label, category, sort_order, sms_enabled, sms_body, email_enabled, email_subject, email_body)
SELECT 'referral_reminder', 'Referral Credit Reminder (to the friend)', 'reminders', 31, false,
       'Hi {{first_name}}, your {{amount}} Family Laundry credit from {{referrer_name}} is still waiting. Book a pickup whenever you''re ready: app.familylaundry.com',
       false, '', ''
WHERE NOT EXISTS (SELECT 1 FROM public.message_templates WHERE trigger_key = 'referral_reminder');

CREATE OR REPLACE FUNCTION public.sweep_referral_notifications()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  -- anon key (already public in all client apps); the function's own
  -- authorization is the x-wr-internal secret, not this.
  v_anon text := '<anon key — see the live function definition>';
  v_req bigint;
BEGIN
  IF COALESCE((public.referral_config()->>'enabled')::boolean, false) = false THEN
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/referral-notify',
    headers := jsonb_build_object('x-wr-internal', public.wr_internal_secret(),
                 'Content-Type', 'application/json',
                 'apikey', v_anon,
                 'Authorization', 'Bearer ' || v_anon),
    body    := '{}'::jsonb
  ) INTO v_req;

  RETURN v_req;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sweep_referral_notifications() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sweep_referral_notifications() TO service_role;

-- SELECT cron.schedule('wr-referral-notifications', '7,22,37,52 * * * *',
--                      'SELECT public.sweep_referral_notifications();');

NOTIFY pgrst, 'reload schema';
