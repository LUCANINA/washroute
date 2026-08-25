-- Session 231 (2026-08-25). Applied to production.
--
-- The stage sweep on a schedule. It existed and worked, but ran ONLY when a human
-- clicked refresh in Bookkeeping -- so 11 staged transactions were unwatched, which
-- was tolerable only because they were visible in the Approvals queue. They have now
-- moved to their own quieter tab, so the sweep has to be the thing that watches them.
--
-- 16:00 UTC = 9am Pacific: bank feeds import overnight, so a morning run works on
-- fresh data and the outcome is there when David starts the day.
--
-- AUTH: x-wr-internal, not a bearer token. handleStageSweep accepted only the
-- service-role key or an admin/manager JWT, and every scheduled HTTP job in this
-- project posts the ANON key -- the obvious cron would have 403'd on every run with
-- nothing surfacing anywhere (the session 227 failure). loan-xero-post gained
-- isInternalCall() in the same session; secret comes from public.wr_internal_secret()
-- so it never appears in cron.job.command.
--
-- timeout_milliseconds := 120000 is load-bearing. pg_net's default is 5000ms and the
-- sweep makes one Xero API call per staged split -- 11 stages took ~7s and the first
-- test timed out client-side. The function had actually SUCCEEDED (all 11 rows carried
-- a fresh stage_sweep_checked_at); only pg_net gave up waiting. Left at the default,
-- every successful run would log an error and the job would look broken.
--
-- Verified before shipping: the exact command below returned HTTP 200 with
-- {checked: 11, matched: 0, flagged: 0} -- correct, since the earliest stage
-- (PayPal 2) is not due until 2026-08-26.
--
-- Rollback: SELECT cron.unschedule('wr-loan-stage-sweep');

SELECT cron.schedule(
  'wr-loan-stage-sweep',
  '0 16 * * *',
  $job$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/loan-xero-post',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-wr-internal', public.wr_internal_secret()),
    body    := '{"sweep_stages":true,"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 120000
  )
  $job$
);
