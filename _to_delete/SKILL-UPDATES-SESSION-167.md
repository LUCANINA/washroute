# Skill updates from Session 167

Three lesson-driven updates to existing WashRoute skills. Skill files live at
`~/.claude/skills/<skill-name>/SKILL.md` on your laptop (read-only from this session's
sandbox, so I can't edit them directly — paste these in manually, or load the
`cowork-plugin-management:cowork-plugin-customizer` skill in a future session and
ask me to apply them).

---

## 1. `washroute-migration-review` — add Duplicate Row Hazards check

**Where to add:** Inside Step 2, right BEFORE the existing `### 🧼 Replace-semantics sanitizer` section.

```markdown
### 🪞 Duplicate row hazards in shared tables (MANDATORY when INSERT-ing into services / service_fees / preferences)
When a migration adds a NEW row to a shared lookup table — especially `services`, `service_fees`,
`preferences`, or any table consumed by `.find()` calls across the apps — check whether the new
row's `(name, sort_order)` pair (or equivalent identifying fields) collides with an existing row.
If yes, the client-side `.find()` call's filter must be specific enough to disambiguate, OR the
new row's identifying fields must be made distinct.

**Lesson from session 167 (HOTFIX):** A new "Wash & Fold (Subscription)" service was added with
`is_addon=false, show_in_app=true, sort_order=1, base_price=$0` — identical fields to the existing
"Wash & Fold (Delivery)" except for pricelist + base_price. The customer-app's
`defaultService = allServices.find(s => !s.is_addon)` then picked WHICHEVER row Postgres returned
first (the query had no secondary sort, so ordering was implementation-defined). In sessions where
Subscription came first, every Delivery customer's app saw basePrice=$0 → baseTotal=0 → the RPC
guard rejected their orders with "Base line item amount must be > 0". Production outage:
7 hours of zero customer-app orders, ~15 attempted bookings rejected, customer complaints by SMS.

**Audit when INSERT-ing services:**
\`\`\`sql
-- Find existing rows that collide with the new row on identifying fields
SELECT id, name, pricelist, sort_order, is_addon, show_in_app, base_price
FROM services
WHERE name = '<new-service-name>'
  AND is_addon = <new-row-is-addon>
  AND show_in_app = <new-row-show-in-app>;
\`\`\`
If 2+ rows come back: ALSO audit `.find()` callers in customer-app + admin + driver + POS:
\`\`\`bash
grep -nE "allServices\.find|services\.find" \
  admin-dashboard/index.html driver-app/index.html customer-app/index.html pos/index.html
\`\`\`
For each match, classify:
- **Filters by explicit `s.id ===`** → ✓ Safe (looks up by primary key)
- **Filters by pricelist or category** → ✓ Safe (only one row matches that filter)
- **Filters only by `!s.is_addon` or similar generic predicate** → ❌ AT RISK — the new row could win the `.find()` and produce wrong defaults

**Audit when INSERT-ing service_fees:** same pattern, but for fees the customer-app's
`getCustomerFees()` helper (session 167) already deduplicates by name preferring the pricelist-specific
row over global. If the new fee row matches that pattern (name + pricelist scoping), it's safe.

**Structural prevention (post-launch tech debt):** add a Postgres unique partial index on
`(name, sort_order)` where `is_addon=false AND show_in_app=true` to prevent the collision class
entirely. Or extend the daily audit to flag rows that would poison `.find()`.
```

---

## 2. `washroute-migration-review` — add Edge Function Redeploy verify_jwt preservation

**Where to add:** as a new section near the end of Step 2, after `### 🔄 Reversibility`.

```markdown
### 🔐 Edge function redeploy: preserve `verify_jwt` setting
When redeploying an edge function via `deploy_edge_function`, the `verify_jwt` parameter is set
per-deploy-call — it does NOT inherit from the previous version. Passing the wrong value silently
breaks every caller's auth.

**Lesson from session 167:** A redeploy of `send-receipt` accidentally enabled `verify_jwt: true`
when the function had been `verify_jwt: false`. Every admin "Send Receipt" call silently 401'd
for 2 hours before David tried to send himself a receipt and noticed nothing arrived.

**Rule:** before any `deploy_edge_function` call, fetch the current setting:
\`\`\`
mcp__d72da7d1-...__get_edge_function(function_slug)
→ check the .verify_jwt field
→ pass the same value in the deploy
\`\`\`

Common settings across WashRoute functions:
- `verify_jwt: false` — send-receipt, send-sms (anon-callable), stripe-webhook, send-order-notification, refund-charge
- `verify_jwt: true` — most other functions that require an authenticated user

If you're not sure: check first. Don't guess.
```

---

## 3. `washroute-audit` — add a daily check for duplicate-row poisoning

**Where to add:** as a new check in the audit skill, alongside the other daily integrity checks.

```markdown
### Check N — Duplicate service rows that could poison client-side `.find()`

Detects: services rows that share `(name, sort_order)` AND are both `is_addon=false AND show_in_app=true`.
This is the class that caused the session 167 HOTFIX (Subscription Wash & Fold poisoning Delivery
customers' defaultService).

\`\`\`sql
SELECT name,
       COUNT(*) AS row_count,
       ARRAY_AGG(pricelist) AS pricelists,
       ARRAY_AGG(base_price::text) AS prices,
       ARRAY_AGG(id::text) AS ids
FROM services
WHERE is_addon = false
  AND show_in_app = true
  AND is_active = true
GROUP BY name, sort_order
HAVING COUNT(*) > 1;
\`\`\`

If any rows return: at least one of the colliding rows needs either (a) `show_in_app=false`,
(b) a different `sort_order`, or (c) a different `name`. Otherwise client-side `.find()` calls
across the apps can pick either row non-deterministically.

Reference: session 167 PROJECT-NOTES entry, sub-section (q) HOTFIX.
```

---

## How to apply

Open each `~/.claude/skills/<name>/SKILL.md` in your text editor and paste the
sections in at the indicated locations. Or, in a future Claude session, ask:
"Use cowork-plugin-customizer to apply the skill updates from SKILL-UPDATES-SESSION-167.md."

---

## 4. `washroute-audit` — point at MONITORING.md + use the new SQL helper

**Where to add:** near the top of the skill, just under the "## Overview" section.

```markdown
## Production monitoring is now automated

Three live monitors run continuously in production — see `MONITORING.md` at the
repo root for the full inventory + diagnostics for each alert:
- `wr-health-monitor` — pg_cron every 15min, alerts on order-rate anomalies
- `wr-nightly-smoke-test` — pg_cron at 3am PT, alerts on broken booking flow
- `database/audits/daily_audit.sql` — 8 manual integrity checks

When David says "morning rounds" or "load up", FIRST read MONITORING.md to
understand what's already being watched automatically, then run any of the
checks in `database/audits/daily_audit.sql` that aren't covered by the
automated monitors. Don't duplicate work the automation already does.

## SQL helpers available

| Function | Returns |
|---|---|
| `audit_duplicate_services()` | Rows where (name, sort_order) collides in `services` AND both are show_in_app=true + is_addon=false + is_active=true. Catches the HOTFIX class (Session 167) where `.find()` callers can pick the wrong row. |

Always call this BEFORE inserting a new row into `services` to confirm you're
not creating a collision.
```

---

## 5. `washroute-changelog` — note the MONITORING.md change-log convention

**Where to add:** as a new section near the end.

```markdown
## After deploying monitoring changes

If the session shipped a new automated monitor, audit, or cron job:
1. Add an entry to the `## Live monitors` or `## SQL helpers` section of
   `MONITORING.md` at the repo root.
2. Add a row to the change log table at the bottom of MONITORING.md with the
   date + a one-line description.
3. PROJECT-NOTES.md gets its own paragraph as usual (high-level story); the
   MONITORING.md row is the operational reference David checks during incidents.
```
