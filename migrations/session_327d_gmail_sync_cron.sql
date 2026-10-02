-- Session 327d — run gmail-sync every 5 minutes (applied 2026-10-02 via execute_sql, jobid 36).
-- Internal auth via x-wr-internal (same as health-monitor / reminders). gmail-sync
-- writes ONLY email_messages + gmail_sync; the only message it can send is the
-- failure-alert SMS to ALERT_PHONE. Preflight 2026-10-02: no triggers or jobs read
-- email_messages; customers contactable = 0.
-- Undo: SELECT cron.unschedule('wr-gmail-sync');
select cron.schedule('wr-gmail-sync', '*/5 * * * *', $c$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/gmail-sync',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-wr-internal', public.wr_internal_secret()),
    body    := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 120000
  )
$c$);
