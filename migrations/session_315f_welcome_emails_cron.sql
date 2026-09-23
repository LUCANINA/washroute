-- Session 315 (2026-09-23): WashRoute welcome series, every 15 min.
-- go_live = the moment customer-app build 20260923232357 (Klaviyo subscribe retired) went live.
-- Customers created before it are never emailed by welcome-emails.
-- Rollback / pause: SELECT cron.unschedule('wr-welcome-emails');
SELECT cron.schedule('wr-welcome-emails', '*/15 * * * *', $cmd$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/welcome-emails',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-wr-internal', public.wr_internal_secret()),
    body    := jsonb_build_object('mode','run','go_live','2026-09-23T23:26:28Z'),
    timeout_milliseconds := 120000
  )$cmd$);
