-- Session 346b — schedule the monthly savings emails (run after savings-summary is deployed).
-- Subscribers: fires 22:05 and 23:05 UTC; the function only acts when it is 3 pm in Oakland
-- (so PDT and PST both work) and claims each customer+renewal once, so a double fire is harmless.
-- Pay-per-bag pilot: 17:10 UTC every day; the function only acts on the 1st (Pacific).
SELECT cron.schedule('wr-savings-subscribers', '5 22,23 * * *', $c$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/savings-summary',
    headers := jsonb_build_object('Content-Type','application/json','x-wr-internal', public.wr_internal_secret()),
    body    := '{"mode":"subscribers","scheduled":true}'::jsonb,
    timeout_milliseconds := 120000)
$c$);
SELECT cron.schedule('wr-savings-perbag', '10 17 * * *', $c$
  SELECT net.http_post(
    url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/savings-summary',
    headers := jsonb_build_object('Content-Type','application/json','x-wr-internal', public.wr_internal_secret()),
    body    := '{"mode":"perbag","scheduled":true}'::jsonb,
    timeout_milliseconds := 120000)
$c$);
-- Undo: SELECT cron.unschedule('wr-savings-subscribers'); SELECT cron.unschedule('wr-savings-perbag');
