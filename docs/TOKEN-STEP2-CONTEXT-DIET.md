# Step 2 — Context diet (2026-09-02)

Baseline preload: **72,163 tokens** (see TOKEN-BASELINE.md).

## 1. CLAUDE.md — NO CHANGE NEEDED ✅

| | Lines |
|---|---|
| Before | 74 |
| After | 74 |
| Target | < 200 |

Already rules-only. Reference material already lives in `TECH-STACK.md`,
`MONITORING.md`, `DESIGN-*.md`, `PROJECT-NOTES*.md`. Line 26 already enforces
"grep them, don't read them whole". Rewriting it would only make it worse.

## 2. MCP connectors — REMOVE THESE (David does this in the Claude app)

These are claude.ai **connectors**, not local `.mcp.json` entries. There is no
config file on disk to edit. Remove them at:

**Claude app → Settings → Connectors** (or claude.ai → Settings → Connectors),
then start a fresh session for the preload to shrink.

### Verified before removing (the build's replacement check)

| Connector | Check | Result | Verdict |
|---|---|---|---|
| Supabase | `list_projects` | Returned 4 real projects; `umjpbuxrdydwejqtensq` = "Family Laundry Project", matches CLAUDE.md | **KEEP** — works |
| Vercel | `list_projects` | `{"error":"Failed to list projects."}` | **REMOVE** — broken |
| Vercel | `list_teams` | `{"teams": []}` — success flag, **empty payload** | **RE-CHECK, then remove** — exactly the failure the build warns about |

> ⚠️ The Vercel verdict rests on two calls in one session. That could be a
> transient auth/API blip rather than a permanent break. Re-run `list_teams`
> once in a fresh session before removing it; if it returns a real team, keep it.

Vercel is not needed anyway: CLAUDE.md says deploys are automatic on push to `main`.

### Removal list (~13 connectors, ~250 tool definitions)

| # | Connector | ~tools | Why it goes |
|---|---|---|---|
| 1 | **Klaviyo** | ~120 | Biggest single win — roughly half the tool-name list. Real in the codebase (`supabase/functions/sync-klaviyo/index.ts`), so re-enable only on days you touch email. |
| 2 | **Vercel** | ~35 | Fails the replacement check (re-check once first). Deploys go through `git push` either way. |
| 3 | Gmail | ~29 | Only appears in `MONITORING.md` prose, never in code |
| 4 | Google Drive | ~11 | No references |
| 5 | Google Calendar | ~9 | No references |
| 6 | Asana | — | **Failing to connect**: "Incompatible auth server" |
| 7 | BigQuery | — | **Failing to connect**: "Incompatible auth server" |
| 8 | Atlassian | — | Never authorized, unused |
| 9 | Intercom | — | Never authorized, unused |
| 10 | Linear | — | Never authorized. The repo "hits" were all `linear-gradient` in CSS |
| 11 | Notion | — | Never authorized; mentioned only in old PROJECT-NOTES prose |
| 12 | Figma | — | Never authorized; one mention in PROJECT-NOTES-ARCHIVE |
| 13 | Slack | — | Never authorized; mentioned only in MONITORING/notes prose |

**KEEP:** Supabase (the backend — verified working), plus the built-in
browser / computer-use / terminal / session tools and the BuildPartner plugin.

## 3. Skill descriptions — trimmed drafts to paste in

Your skills are **cloud-managed** (each has a `skillId` in the app manifest and is
re-materialized per session), so local file edits do not persist. Paste these at:

**Claude app → Settings → Capabilities → Skills → [skill] → Description**

### Method: move rationale, don't delete triggers

A description is paid on **every session**. A skill body is paid **only when the
skill fires**. So every "this exists because…" sentence in a description should be
moved into the body, and **every trigger phrase must survive verbatim** — a
shortened description that stops firing `washroute-preflight` is not a saving, it
is an outage.

| Skill | Before | After | Saved |
|---|---|---|---|
| washroute-bookkeeping | 899 | ~470 | 429 |
| washroute-preflight | 821 | 533 | 288 |
| washroute-audit | 627 | ~410 | 217 |
| washroute-test | 608 | ~385 | 223 |
| washroute-migration-review | 567 | ~390 | 177 |
| bookswell | 517 | ~345 | 172 |
| washroute | 502 | ~300 | 202 |
| washroute-changelog | 487 | ~330 | 157 |
| washroute-qa | 376 | ~285 | 91 |
| boxit-design | 343 | 343 | 0 (already tight) |
| **TOTAL** | **5,747** | **~3,791** | **~1,956 chars ≈ 490 tokens** |

Left alone on purpose: `docx`, `pptx`, `xlsx`, `pdf`, `skill-creator`, `morning`
and the other Anthropic-managed skills — they are overwritten on update and their
descriptions are tuned for trigger accuracy.

---

### washroute
> Load WashRoute project context. Use at the start of EVERY session on the WashRoute laundry app — admin dashboard, driver app, customer app, POS, orders, routes, route stops, drivers, SMS inbox, Supabase, or any WashRoute feature. Also when David asks "where were we" or "pick up where we left off".

*(Added POS, which CLAUDE.md lists but the old description missed.)*

### washroute-bookkeeping
> Load WashRoute's Bookkeeping module context — Loans, Payroll, Reconciliation (Xero sync) in admin-dashboard/index.html. Use at the start of EVERY session touching the Bookkeeping tabs, loan statements/splits, payroll allocation, Xero posting or journals, reconciliation findings, the Needs Attention lists, loan flags, payroll attention, department mapping, or account codes. Also when David asks "where were we" while in Bookkeeping. Use INSTEAD OF the `washroute` skill, not on top of it.

*Move to the skill body:* why it is separate from `washroute` (own notes file, double-entry and Xero-idempotency guardrails, keeping context lean).

### washroute-preflight
> Run a preflight safety check before any bulk or potentially dangerous WashRoute operation. Use EVERY TIME before: bulk imports, enabling/creating cron jobs, enabling SMS templates, deploying edge functions that send messages, UPDATE/DELETE on more than 10 rows, activating triggers, or anything that could fan out to customers. Also when David says "import", "enable", "turn on", "go live", "activate", "send to all", "bulk", or any phrasing that implies a large-scale operation. Do NOT skip this even when the operation seems safe.

*Move to the skill body:* the golden rule ("if it COULD message a customer it WILL message every customer") and the mass-messaging incident. **Every trigger word above is preserved verbatim.**

### washroute-audit
> Run a daily health audit on the WashRoute database. Use at the start of EVERY session — especially when David says "load up", "morning rounds", "run audit", "daily check", "health check", "check the system", or anything implying a pre-work data check. Also run proactively before any session working on orders, routes, or customers. Catches orphaned stops, unrouted orders, unpaid deliveries and duplicate accounts.

*Move to the skill body:* "takes about 30 seconds and prevents hours of debugging".

### washroute-migration-review
> Review a proposed Supabase migration for WashRoute before it is applied. Use EVERY TIME a migration is about to run — before any apply_migration, execute_sql on schema changes, or SQL that adds/removes/alters tables, columns, indexes, constraints or RLS policies. Also whenever David mentions a schema change, a new table, or adding a column. Do NOT skip this for small or "obvious" changes.

*Move to the skill body:* "the database is the one thing that cannot be easily undone".

### washroute-test
> Write and run a sanity-check test script for a completed WashRoute feature, after QA and before committing. Triggers: "test this", "write a test", "verify this works", "does this actually work", or any feature touching Supabase data whose happy path is unverified. Also invoke proactively after edge function changes, status pipeline changes, or anything involving SMS, payments, or auth.

*Move to the skill body:* "tests run in the browser console against the real Supabase instance using the anon key — no test framework needed."

### washroute-changelog
> Update PROJECT-NOTES.md and maintain the WashRoute changelog. Use after every git commit, after any feature is marked complete, at the end of any session with meaningful work, or when David says "update the notes", "document this", "log what we did", or "update the project file". Invoke automatically — don't wait to be asked.

### washroute-qa
> Run a code quality and UX review on recently changed WashRoute code. Use after completing any significant feature or set of edits, especially before committing — it catches bugs, broken patterns, security gaps and UX inconsistencies. Invoke proactively whenever a feature is "done".

### bookswell
> Load Bookswell project context — the standalone bookkeeping-automation product for CPAs and independent bookkeepers, spun out of WashRoute's Bookkeeping module. Use at the start of EVERY Bookswell session, when David mentions Bookswell, loan statements, payroll ingest, Xero posting or the CPA demo, or asks "where were we" about this project.

### boxit-design
> **No change** — 343 chars, already tight.

---

## Expected result

| Source | ≈ tokens saved per session |
|---|---|
| 13 MCP connectors removed | ~3,000–3,500 |
| Skill descriptions trimmed | ~510 |
| **Total off the preload** | **~3,500–4,000** |

New preload ≈ **68,000–69,000** (from 72,163), roughly a **5% cut**.

Because the preload is re-read on every turn, a 4,000-token cut is ~4,000 x turn
count. At 40 turns that is ~160,000 cache-read tokens saved per session.

## Bigger lever, NOT in this step

The `washroute` skill body is **102,319 bytes ≈ 25,600 tokens** and CLAUDE.md
routes essentially every session to it. `washroute-audit` adds another ~18,500.
That is ~44,000 tokens — **more than ten times** everything trimmed above.

Splitting `washroute` into a small always-load core plus on-demand sections is the
single highest-value change available. Out of scope for this step; revisit after
the build.


## Corrections after blind verification

1. **`washroute-preflight`: catch-all clause restored.** The first draft dropped
   *"or any phrasing that implies a large-scale operation"* and softened
   "potentially dangerous" to "risky". Neither is a keyword, but the catch-all is
   real trigger surface on a safety skill — without it the skill matches only the
   seven literal quoted phrases. Both are back. Net saving on this skill drops
   from 366 to 288 chars. Correct trade: ~20 tokens for a skill that exists
   because customers got mass-texted.

2. **Vercel needs a second look** before removal (see the warning above).

3. **The "removed from config" half of this step's verify is not file-checkable.**
   There is no local MCP config on this machine — no `.mcp.json`, and no
   `mcpServers` key in `~/.claude/settings.json` or `~/.claude.json`. The only
   on-disk `mcpServers` block is the BuildPartner plugin's own. These connectors
   are app-managed, so **this step is not done until David removes them in the
   Claude app.** The plan above is complete; the execution is his.
