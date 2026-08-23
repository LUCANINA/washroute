# Session 227 — edge hardening — ✅ RESOLVED IN SESSION 228

**All four functions are deployed and their crons are working. This directory is
kept for history only; the live source is in `supabase/functions/<name>/index.ts`.**

## What blocked them, and how it was unblocked

Session 227 hardened these four and held them back, because every pg_cron HTTP job
sends the **anon key**, so requiring the service-role key would have killed the job
**silently** — no error anywhere.

Session 228 unblocked them with the mechanism session 227 had already built for the
DB→edge problem: `public.wr_internal_auth` (RLS on, no policies, no anon/authenticated
grants, so only a service-role client can read it), exposed as
`public.wr_internal_secret()` and sent as the **`x-wr-internal`** header. This is
Option B from the original write-up — no secret in `cron.job.command`, and nothing to
set by hand in the Supabase dashboard.

| function | version | cron | status |
|---|---|---|---|
| `send-scheduled-reminders` | 42 | jobids 10, 11 | anon → 401. Cron authenticates. |
| `bookkeeping-kpis` | 8 | jobid 23 | anon → 403 (Xero P&L leak closed). Staff JWT still allowed for the dashboard's Refresh. |
| `health-monitor` | 16 | jobid 17 | anon → 403; now fails CLOSED (was `if (MONITOR_SECRET && …)`, which failed OPEN with the secret unset). |
| `sync-klaviyo` | 18 | jobid 16 | anon → 403, and the leaked literal `wr-klaviyo-sync-9x2` is no longer accepted anywhere. |

All five cron commands now carry **only** `x-wr-internal` — the anon bearer and the
leaked Klaviyo literal were removed after the deploy was verified.

## How it was verified without side effects

The dangerous one is `send-scheduled-reminders`: a single unauthenticated
`{"type":"all"}` would mass-text every customer with an upcoming pickup AND burn the
one-shot `*_sent_at` flags, silencing the real 6pm run. So **every probe used
`{"type":"__probe_noop__"}`** — an unrecognised type matches no branch, so even a
hypothetical fail-open could not have sent anything. The internal-secret probe
returned `{"ok":true,"sent":{}}`: auth passed, zero SMS. The other three were then
verified by executing each job's **actual stored `cron.job.command`**, not a
hand-typed equivalent.

## Deploy ordering used (worth reusing)

The cron commands got the new header **first, while keeping the old anon bearer** —
the un-hardened functions ignored the unknown header, so nothing changed. Only then
were the hardened versions deployed. At no point was there a window where the cron
could not authenticate, so nothing had to be disabled and no reminder was missed.

## Still open

- **`ALERT_PHONE` is not set in Supabase Secrets**, so `health-monitor` retains the
  hardcoded fallback to David's number. Session 227's draft removed it, which would
  have silently disabled every health alert. Set `ALERT_PHONE` in the dashboard, then
  delete the fallback at `health-monitor/index.ts` line ~24.
- `KLAVIYO_SYNC_SECRET` / `HEALTH_MONITOR_SECRET` are still unset. Neither is needed
  any more — both functions authenticate the cron via `x-wr-internal`. They remain
  supported for a manual call if you ever set them.
