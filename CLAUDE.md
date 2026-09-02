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

Notes files (large — grep them, don't read them whole):
- `PROJECT-NOTES.md` — laundry app history through today. Sessions are logged newest-first at the top.
- `PROJECT-NOTES-BOOKKEEPING.md` — Bookkeeping module only, from session 218 onward.
- `PROJECT-NOTES-ARCHIVE.md` — older history.
- `TECH-STACK.md`, `MONITORING.md`, `DESIGN-*.md` — stack, alerting, and per-feature design docs.

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

## Committing

`./commit.sh "message"` stages tracked changes and pushes. Plain `git commit` is
equally safe — the version bump lives in the hook, not the script. Commit only
when David asks.
