-- Session 315 (2026-09-23): Klaviyo is being cancelled. SendGrid (sync-sendgrid) replaces it.
-- Restore (only if Klaviyo comes back): see migrations for the original wr-klaviyo-nightly-sync (0 10 * * *).
SELECT cron.unschedule('wr-klaviyo-nightly-sync');
