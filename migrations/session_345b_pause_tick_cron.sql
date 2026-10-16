-- Session 345b — schedule subscription-pause-tick hourly (at :12).
-- Run ONLY after: (1) session_345 migration is applied and the data API sees the new columns,
-- (2) subscription-pause-tick is deployed with --no-verify-jwt, (3) a dry run returned cleanly.
-- Fan-out: acts only on subscriptions with a pause (0 today). Emails: one restart reminder per pause.
SELECT cron.schedule(
  'wr-subscription-pause-tick',
  '12 * * * *',
  $c$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/subscription-pause-tick',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-wr-internal', public.wr_internal_secret()),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  $c$
);
-- Undo:  SELECT cron.unschedule('wr-subscription-pause-tick');
