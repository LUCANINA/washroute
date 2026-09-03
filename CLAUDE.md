# WashRoute — project memory

Claude reads this file automatically at the start of every session in this repo.
Keep it short: **orientation and rules only**. Narrative history belongs in the
PROJECT-NOTES files, deep context belongs in the skills.

David is the owner/operator, not a developer. Explain changes in plain language,
give step-by-step instructions, and don't assume command-line fluency.

---

## Load these first

| Kind of work | Load |
|---|---|
| Any WashRoute session (orders, routes, drivers, SMS, customers, POS) | skill `washroute` |
| Loans / Payroll / Reconciliation / Xero (the Bookkeeping tabs) | skill `washroute-bookkeeping` — **instead of** `washroute`, not on top of it |
| Start of a working day, or before touching orders/routes/customers | skill `washroute-audit` |
| Any schema change (new table, column, index, constraint, RLS) | skill `washroute-migration-review` — **every time, no exceptions** |
| Bulk imports, enabling cron/SMS, UPDATE/DELETE >10 rows, "go live" | skill `washroute-preflight` — **every time** |
| A feature is finished | `washroute-qa`, then `washroute-test`, then commit, then `washroute-changelog` |

> **If a skill above isn't available**, don't stop — it's a per-machine install,
> not a repo file. `washroute`, `washroute-audit` and `washroute-changelog` live
> in `~/.claude/skills/` and the `.skill` archives in this repo root are the
> source (`WashRoute-Laptop-Setup.md` §7 installs them). Meanwhile: this file plus
> `docs/washroute/*.md` carry the orientation, and
> `database/audits/daily_audit.sql` carries the audit checks.

Notes files (large — grep them, don't read them whole):
- `PROJECT-NOTES.md` — laundry app history through today. Sessions are logged newest-first at the top.
- `PROJECT-NOTES-BOOKKEEPING.md` — Bookkeeping module only, from session 218 onward.
- `PROJECT-NOTES-ARCHIVE.md` — older history.
- `TECH-STACK.md`, `MONITORING.md` — stack and alerting.

Where the rest lives (tidied 2026-09-03):
- `docs/bookkeeping/` — every Bookkeeping design doc and finding: `DESIGN-LOAN-POSTING-MODEL.md`,
  `DESIGN-CLOSING-EVIDENCE.md`, `DESIGN-VARIANCE-ATTRIBUTION.md`, `DESIGN-STAGING-EXPANSION.md`,
  `DESIGN-LOAN-BUNDLE-INTAKE.md`, `BOOKKEEPING-OPERATING-NOTES.md`, `FORD-FINDINGS-2026-08-22.md`,
  `LOAN-CORRECTIONS-2026-09-01.md`, and the Ramona pre-staged-payments PDF.
  (`PROJECT-NOTES-BOOKKEEPING.md` stays at the root, beside the other notes files.)
- `docs/washroute/` — architecture, authorization, coding patterns, status.
- `docs/` — `TOKEN-HABITS.md`, `TOKEN-BASELINE.md`, `TOKEN-STEP2-CONTEXT-DIET.md`.
- `scripts/console/` — browser-console recovery/outreach scripts, still live:
  `batch-charge-retry.js`, `outreach-sms.js`, `outreach-email.js` (see skill `washroute`).
- `archive/` — finished or superseded: old planning docs, one-off spreadsheets
  and incident CSVs. Kept for history, not current reference.

---

## Shape of the code

Four single-file vanilla-JS SPAs. No build step, no framework, no bundler — each
is one large `index.html` that Vercel serves directly.

| App | File | Domain |
|---|---|---|
| Admin dashboard | `admin-dashboard/index.html` (~3 MB) | admin.familylaundry.com |
| Customer app | `customer-app/index.html` | app.familylaundry.com |
| Driver app | `driver-app/index.html` | driver.familylaundry.com |
| POS | `pos/index.html` | pos.familylaundry.com |

Routing lives in `vercel.json`. Backend is Supabase (project `umjpbuxrdydwejqtensq`):
Postgres + RLS + auth, edge functions in `supabase/functions/`, SQL in `migrations/`
and `database/`. Node test scripts in `tests/`. Deploys are automatic on push to
`main` (repo `LUCANINA/washroute`), live in about 30 seconds.

Because the files are huge, **edit by targeted search-and-replace, never by
rewriting the file**. Find the function first, change the smallest region that
fixes the problem, and prefer one shared helper over N parallel edits.

---

## Rules that exist because something broke

- **Never `rm` a backup or notes file.** Superseded files go to `_to_delete/`.
- **`build-version.txt` is how new code reaches open tabs.** The four SPAs poll it
  and reload. `scripts/githooks/pre-commit` bumps it automatically when client code
  is staged (`git config core.hooksPath scripts/githooks` — verify this is set on a
  new machine). Shipping without a bump left the rack station on stale JavaScript
  and recorded 21 valid cards as declined.
- **Anything that COULD message a customer WILL message every customer** until
  proven otherwise. Run `washroute-preflight` first.
- **Test the UI by clicking it**, not by calling handlers by name — a dead `onclick`
  attribute passes every test that invokes `window.someFunction()` directly.
- **Test with production-shaped data.** PostgREST returns `numeric` as strings;
  `.in('id', ids)` must be batched (100 at a time) or long lists fail opaquely.
- **The database is the one thing that cannot be undone.** Migration review, always.
- **A `git push` does NOT deploy an edge function.** Vercel auto-deploys the four SPAs on
  push; Supabase functions do not, and never have. Session 261 lost three round trips to
  this — the code was on GitHub, the function was still the old version, and the START HERE
  block would have said "deployed" on the strength of the push. **Deploy state is checked by
  BEHAVIOUR, never inferred from git.** The command, from the repo root:
  ```
  npx -y supabase@latest functions deploy <name> --project-ref umjpbuxrdydwejqtensq --no-verify-jwt
  ```
  `npx` because the `supabase` binary is not on David's PATH (`command not found` — the
  second lost round trip). **`--no-verify-jwt` is not optional on any function that is
  currently `verify_jwt: false`** — omitting it flips the function to requiring a JWT and
  breaks every caller, which is how session 260 nearly killed the Stripe payout webhook.
  To check the flag on any function in one call: POST it with no Authorization header. The
  gateway (verify_jwt true) answers `401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}`; a function
  with it false answers in its own words.
- **The MCP `deploy_edge_function` tool has a real size ceiling** (~100–130KB of file
  content per call) and `deploy_edge_function`'s `verify_jwt` **defaults to true**. Anything
  near that size — `loan-find-difference` (158KB), `loan-bundle` (404KB) — must go through
  the CLI above, from David's own terminal. Never truncate or re-type a file to force it
  through the tool.

## Committing

`./commit.sh "message"` stages tracked changes and pushes. Plain `git commit` is
equally safe — the version bump lives in the hook, not the script. Commit only
when David asks.

## RTK — compress command output

> **Machine-specific — check before using.** `rtk` is installed per machine, not
> in this repo. Run `command -v rtk` once; if it's missing (the laptop, a fresh
> clone, CI), **use the plain command instead** — `git status`, not `rtk git
> status`. Everything in this section is an optimization, never a requirement.
> Nothing here should ever produce "command not found".
> Install steps: `WashRoute-Laptop-Setup.md` §7.

`rtk` (v0.47.0, `~/.local/bin/rtk`) filters noisy command output before it reaches
context. Prefix a command with `rtk` and it uses a filter if it has one, or passes
through unchanged. Measured on this repo: `ls -laR` 75% smaller, `git status` 52%,
`git log` 19%.

Use it for: `rtk ls`, `rtk find`, `rtk git status|log|diff|show`, `rtk log <file>`,
`rtk err <cmd>`, `rtk json`, `rtk psql`, `rtk curl`, `rtk read <file>`.
`rtk gain` shows cumulative savings.

**⚠️ NEVER use `rtk grep` when completeness matters.** It truncates: 86 matches in
`admin-dashboard/index.html` came back as 28 lines. Fine for "does this exist";
wrong for any audit. Use plain `grep` when finding ALL callers — before a schema
change, when auditing `pg_proc`, or during migration review. A missed caller is
exactly the failure `docs/washroute/authorization.md` exists to prevent.

Same rule for `rtk read` on the PROJECT-NOTES files: grep them, don't read them.

## Route grunt work to cheaper agents

Budget = tokens x model. Locating, verifying and mechanical edits don't need the
full model or the main thread. Three agents in `.claude/agents/`, all on Haiku:

| Agent | Use for | Returns |
|---|---|---|
| `locator` | "where is X handled?" | `file:line` only, never code |
| `verifier` | blind-check a claim after a change | PASS/FAIL + evidence |
| `worker` | mechanical edits already decided | what changed, file:line |

Send a broad search to `locator` rather than grepping into this thread — 384
timezone hits across 46 files is ~20,000 tokens read directly, ~900 via the agent.

**Do NOT route these to a smaller model.** They exist because something broke in
production, and the saving isn't worth the risk:
`washroute-migration-review`, `washroute-preflight`, `washroute-qa`.

Same rule for the agents: `worker` hands back anything needing judgment, a schema
change, or anything that could message a customer.
