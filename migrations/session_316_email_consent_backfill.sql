-- Session 316 (2026-09-24) — opt in customers with no email-consent timestamp.
-- ALREADY APPLIED via execute_sql. Kept as a record.
--
-- Why: 207 customers (all created since May 2026) had email_marketing_consent_at NULL and
-- email_marketing_opt_out_at NULL. The admin screen showed them as "Opted in", but the SendGrid
-- sync requires consent_at, so they were never added to the newsletter list. David chose to
-- opt them in (US CAN-SPAM: existing customers may be emailed with a working unsubscribe).

begin;
create table if not exists public._archive_email_consent_backfill_316 as
  select id, email_cache, email_marketing_consent_at, email_marketing_opt_out_at, now() as archived_at
  from customers
  where coalesce(trim(email_cache),'')<>'' and email_marketing_opt_out_at is null and email_marketing_consent_at is null;
alter table public._archive_email_consent_backfill_316 enable row level security;
revoke all on public._archive_email_consent_backfill_316 from anon, authenticated;

update customers c set email_marketing_consent_at = now()
  from public._archive_email_consent_backfill_316 a
  where a.id = c.id and c.email_marketing_consent_at is null and c.email_marketing_opt_out_at is null;
commit;
-- Result: 207 archived, 207 opted in. Manual sync-sendgrid fullsync afterwards: list 5,142 -> 5,348.

-- UNDO (restores NULL consent for exactly these rows; the next nightly sync then removes them
-- from SendGrid):
-- update customers c set email_marketing_consent_at = null
--   from public._archive_email_consent_backfill_316 a
--   where a.id = c.id and a.email_marketing_consent_at is null;
