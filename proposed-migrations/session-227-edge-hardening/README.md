# Session 227 — edge functions hardened but NOT deployed

These four functions were hardened during the session 227 security sweep and then
deliberately **held back**, because deploying them as-is would break a live pg_cron
job or a live alerting path. `supabase/functions/<name>/index.ts` has been restored
to the version currently running in production, so **repo == production** and there
is no stale-deploy landmine (cf. PROJECT-NOTES pending item on stripe-webhook).

The blocker in every case is the same: **every pg_cron HTTP job sends the ANON key.**
Verified 2026-08-22:

```sql
SELECT jobname, command FROM cron.job;   -- decode the Bearer JWT: "role":"anon"
```

| file | what it fixes | what must happen first |
|---|---|---|
| `send-scheduled-reminders.index.ts` | Anyone on the internet can POST `{"type":"all"}` and text every customer with an upcoming pickup — and because each reminder burns its one-shot `*_sent_at` flag, the real 6pm run then sends nothing. | `wr-reminder-evening` (jobid 10) and `wr-reminder-morning` (jobid 11) must send the **service-role key**, not the anon key. |
| `bookkeeping-kpis.index.ts` | `{"source":"pg_cron","debug_rows":true}` returns the business's full Xero P&L to an unauthenticated caller — the body flag is treated as a credential. | `wr-bookkeeping-kpis` (jobid 23) must send the service-role key. |
| `health-monitor.index.ts` | The secret check reads `if (MONITOR_SECRET && ...)`, so it fails **open** whenever `HEALTH_MONITOR_SECRET` is unset — which the live cron body (`{"source":"pg_cron"}`, no `secret` field) strongly implies it is. Also removes David's phone number from source. | Set `HEALTH_MONITOR_SECRET` and `ALERT_PHONE` in Supabase Secrets, and add `"secret"` to the `wr-health-monitor` (jobid 17) body. |
| `sync-klaviyo.index.ts` | The only access control is the literal `'wr-klaviyo-sync-9x2'`, committed to source and in git history — anyone with it can dump the whole customer table to Klaviyo on demand. | Generate a new secret (`openssl rand -hex 24`), set `KLAVIYO_SYNC_SECRET` in Supabase Secrets, and update the `wr-klaviyo-nightly-sync` (jobid 16) body, which currently carries the old literal in plaintext. |

## Two ways to unblock

**Option A — put the service-role key in the cron commands.** Fastest. Requires
`cron.alter_job` / `cron.schedule` updates for jobids 10, 11, 23 (and 16, 17 for
the secret-based pair). The service-role key then sits in `cron.job.command` in
plaintext, readable by anyone with DB admin — acceptable, since that role already
has everything, but worth knowing.

**Option B (cleaner) — a DB-held shared secret.** Create a table with RLS on and no
policies and no anon/authenticated grants; `service_role` bypasses RLS, so the edge
function can read it while no app role can. Each cron body then does
`jsonb_build_object(..., 'cron_secret', (SELECT value FROM ... ))`, and each function
compares against the value it reads from the DB. No secret ever lives in
`cron.job.command`, and nothing has to be set by hand in the Supabase dashboard.

Option B is the cleanest-architectural-path choice and is the recommendation.
