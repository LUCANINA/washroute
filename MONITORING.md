# WashRoute — Production Monitoring & Testing

Single-page index of every automated check guarding WashRoute in production.
Living document — add a new entry every time we ship a new monitor, audit, or test.

**Owner:** David (alerts go to `+14156085446`)
**Last updated:** June 4, 2026 (Session 167)

---

## How alerts reach you

All critical alerts: SMS to your phone via Twilio (direct call, not through `send-sms` edge function — so the monitor still works if `send-sms` itself is what broke).

All alert history is recorded in the `_health_alerts` table — you can review past alerts even if the SMS was missed:

```sql
SELECT alert_type, severity, message, sent_sms, created_at
FROM _health_alerts
ORDER BY created_at DESC LIMIT 20;
```

---

## 🚨 Live monitors

### 1. `wr-health-monitor` — order-rate anomaly detector

**What it does:** every 15 minutes, counts customer-app orders from the last 60min and compares to the same 60min window 24h prior. Alerts on suspicious drops.

**When it fires:**
- Business hours (8am–9pm PT) + 0 orders + baseline ≥ 3 → **critical** SMS
- Business hours + ≥80% drop + baseline ≥ 5 → **critical** SMS
- Off-hours + 0 orders + baseline ≥ 10 → **warn** SMS

**Dedup:** won't re-alert the same `alert_type` within 60 minutes. Also writes a "heartbeat" row every 6 hours when everything's healthy so you can see the monitor is alive.

**Bug class it would have caught:** the Session 167 HOTFIX (15 customer orders rejected over 7 hours because of the `defaultService` duplicate-row bug). Estimated time-to-detection: 30–60 minutes vs the actual 7 hours.

**To disable:**
```sql
SELECT cron.unschedule('wr-health-monitor');
```

**To pause without removing:**
```sql
UPDATE cron.job SET active = false WHERE jobname = 'wr-health-monitor';
-- Re-enable: SET active = true
```

**Source:** `supabase/functions/health-monitor/index.ts`
**pg_cron job:** id 17, schedule `*/15 * * * *`

**When an alert arrives:**
1. Open admin → check the Orders page. Is anyone placing orders?
2. Open Postgres logs (Supabase Dashboard → Database → Logs). Look for `ERROR:` rows.
3. If errors say "Base line item amount must be > 0" → HOTFIX class again, check `defaultService` filter.
4. If errors say something else → grep the customer-app for the function that throws that error.

---

### 2. `wr-nightly-smoke-test` — end-to-end booking happy-path

**What it does:** every night at 3am PT, exercises the booking flow against the real production DB. Uses your secondary test account (`dmacquart+wrsignup1@gmail.com`). Test orders are marked with `special_instructions='WR-SMOKE-TEST'` and deleted at the end of the run.

**Checks it runs:**
1. Test customer + address still exist (catches accidental deletes)
2. Exactly 1 Delivery W&F service is `is_active=true + show_in_app=true` (catches the HOTFIX class)
3. `audit_duplicate_services()` returns 0 rows (catches new shared-table collisions)
4. Service has `base_price > 0` (catches accidental zeroing)
5. Global Delivery Fee row exists (catches accidental deletion)
6. Order INSERT succeeds with all required columns (catches schema drift)
7. Order total matches sent value (catches trigger interference)
8. Order cleanup deletes successfully (catches policy/permission breaks)

**Run time:** ~800ms

**Last verified passing:** June 4, 2026 (manual test)

**Source:** `supabase/functions/nightly-smoke-test/index.ts`
**pg_cron job:** id 18, schedule `0 10 * * *` (10am UTC = 3am PT year-round)

**When an alert arrives:** SMS will name the failed step. Most common diagnoses:
- "service collision" → run `SELECT * FROM audit_duplicate_services()` to see the dup
- "service price" → someone edited a service to $0/bag in admin
- "order insert" → schema drift, check recent migrations
- "audit_duplicate_services" → new shared-table collision was introduced

**Manual trigger** (no need to wait for 3am):
```sql
SELECT net.http_post(
  'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/nightly-smoke-test',
  '{"source":"manual"}'::jsonb,
  '{"Content-Type":"application/json","Authorization":"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtanBidXhyZHlkd2VqcXRlbnNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NjgzMDQsImV4cCI6MjA4NzU0NDMwNH0.22WyUfBsqPaaza_HiDo1f_tQE3sGUDEJYYyV29XUSeY"}'::jsonb
);
-- Wait 10s, then check:
SELECT alert_type, message, created_at FROM _health_alerts WHERE created_at > NOW() - INTERVAL '1 minute';
```

---

## 📋 Daily audit (on-demand)

### `database/audits/daily_audit.sql` — 8 integrity checks

**How to run:** Supabase SQL editor → paste the file contents → run. Or `psql -f database/audits/daily_audit.sql`.

**The 8 checks:**
1. Duplicate services (HOTFIX class) — `audit_duplicate_services()`
2. Orphan route_stops (route was deleted)
3. Unpaid delivered orders (customer received service without payment)
4. Recent health alerts that aren't heartbeats (any critical needs investigation)
5. Subscription usage > 0 lbs but no completed orders this cycle (trigger fired but order was cancelled)
6. Credit-ledger imbalance (used > refunded + balance, indicates accounting drift)
7. Recent RPC warnings spike (silent failures we want to surface)
8. Stripe customers with no card + no recent activity (cleanup candidates, informational)

Run weekly. Add new checks every time a bug surfaces that the existing 8 wouldn't have caught.

---

## 🔧 SQL helpers (callable from anywhere)

| Function | What it returns |
|---|---|
| `audit_duplicate_services()` | Rows of (name, sort_order, count, pricelists[], ids[]) for any services collision that could poison client-side `.find()` |

---

## 📊 Heartbeats + dashboards

The `_health_alerts` table is your dashboard. Useful queries:

**Health summary (last 7 days):**
```sql
SELECT
  alert_type,
  severity,
  COUNT(*) AS occurrences,
  MAX(created_at) AS last_seen
FROM _health_alerts
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY alert_type, severity
ORDER BY severity DESC, occurrences DESC;
```

**Is the health monitor itself alive?**
```sql
-- Should show heartbeat rows roughly every 6h when no alerts.
SELECT created_at FROM _health_alerts WHERE alert_type = 'heartbeat'
ORDER BY created_at DESC LIMIT 5;
```

**Was last night's smoke test green?**
```sql
SELECT alert_type, message, context, created_at FROM _health_alerts
WHERE alert_type IN ('smoke_test_pass', 'smoke_test_fail')
  AND created_at > NOW() - INTERVAL '36 hours'
ORDER BY created_at DESC LIMIT 5;
```

---

## 🛑 Emergency stop

If something is firing too many SMS and you need quiet immediately:

```sql
-- Pause both monitors. Re-enable by flipping active = true.
UPDATE cron.job SET active = false WHERE jobname IN ('wr-health-monitor', 'wr-nightly-smoke-test');
```

Or pull the Twilio plug entirely by clearing the env var in Supabase Dashboard → Edge Functions → Settings → `TWILIO_AUTH_TOKEN`. (The monitors will still log to `_health_alerts` but no SMS will fire.)

---

## 📜 Change log

| Date | Change |
|---|---|
| 2026-06-04 | Initial v1: `wr-health-monitor` + `wr-nightly-smoke-test` + `daily_audit.sql` (Session 167 Phase 8 PM) |

Add a row every time you ship a new check, change a threshold, or retire an alert.

---

## 🚀 Ideas for future builds (not yet built)

In rough order of value/effort:

1. **Edge-function error-rate monitor** — count 4xx/5xx from edge function logs per hour, alert on spikes.
2. **Webhook delivery monitor** — if Stripe webhooks stop arriving for >30min, alert. (Catches webhook URL changes, network blips, key rotations.)
3. **Subscription churn alert** — N cancellations in a day signals a regression in the cancel flow.
4. **Severity-aware quiet hours** — critical fires anytime, warn fires business hours only.
5. **Slack webhook destination** — alternative to SMS for non-urgent alerts (no Twilio cost).
6. **Phone-call escalation** for critical alerts via Twilio Voice (in case you're sleeping through SMS).
7. **Per-bug regression tests** — `database/regression-tests/` folder with one SQL test per fixed bug; each test reproduces the bug scenario and asserts the fix holds. Run before any migration.
8. **POS health monitor** — separate cron, catches POS-specific anomalies (e.g., a 4-hour stretch with 0 walk-in sales during business hours).
9. **Driver app heartbeat** — alert if any active driver hasn't pinged GPS in >30min during their shift.

Add to this list as ideas come up. The principle: **every silent failure mode that bites us once should become a permanent monitor.**
