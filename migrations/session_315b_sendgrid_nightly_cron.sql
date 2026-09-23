-- Session 315 (2026-09-23): nightly SendGrid marketing sync, 10:30 UTC (3:30am PT),
-- 30 min after wr-klaviyo-nightly-sync. Auth: x-wr-internal (same as every pg_cron HTTP job).
-- sync-sendgrid never sends email; it edits contacts, the list and suppressions only.
-- Rollback: SELECT cron.unschedule('wr-sendgrid-nightly-sync');
SELECT cron.schedule('wr-sendgrid-nightly-sync', '30 10 * * *', $cmd$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/sync-sendgrid',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-wr-internal', public.wr_internal_secret()),
    body    := jsonb_build_object('mode','fullsync'),
    timeout_milliseconds := 120000
  )$cmd$);
