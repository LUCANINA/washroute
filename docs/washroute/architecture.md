# WashRoute — Architecture & Infrastructure

*Split out of the `washroute` skill 2026-09-02. Read this before touching Supabase schema, edge functions, cron, or Twilio.*

## Project at a Glance

David is building a laundry pickup/delivery business called **WashRoute** (also referred to as "Family Laundry"). Three connected single-page apps share one Supabase database.

| App | File | Users |
|---|---|---|
| Admin Dashboard | `admin-dashboard/index.html` | Owner/managers |
| Driver App | `driver-app/index.html` | Drivers |
| Customer App | `customer-app/index.html` | Customers |

**All apps are single-file SPAs** — pure HTML/CSS/JS, no build step, no framework. Everything lives in one `index.html`. Always edit in place; never introduce npm, React, or a bundler.

**⚠️ Bookkeeping is a separate skill (session 217).** The admin dashboard's "Bookkeeping" tabs (Loans, Payroll, Reconciliation — Xero sync) have their own skill, `washroute-bookkeeping`, and their own notes file, `PROJECT-NOTES-BOOKKEEPING.md`, split out from this skill and `PROJECT-NOTES.md` because that surface has a different risk profile (double-entry correctness, Xero sync idempotency) than ordinary laundry-app work. If the task touches Loans/Payroll/Reconciliation, load `washroute-bookkeeping` instead of — or in addition to — this skill. Bookkeeping history from session 212 (cont. 2) onward lives in `PROJECT-NOTES-BOOKKEEPING.md`; earlier Bookkeeping-related entries are still only in `PROJECT-NOTES.md` (interleaved with laundry-app sessions), findable by grepping for "Loan"/"Payroll"/"Reconciliation"/"Xero journal".

**Project folder:** `~/Projects/WashRoute`
**Git:** Changes are committed after every significant feature. Always `git add` specific files, never `-A` blindly. Standard git commands (`git status`, `git diff`, `git log`, `git commit`, `git push`) all work normally through the remote-devices `device_bash` tool — but see the stale-lock note below, which is a real recurring issue in this repo.

### ⚠️ Git locks on this repo (session 209/210 — read before any `device_bash` git command)

David's WashRoute folder reaches Claude through the `remote-devices` bridge, which mounts it over **FUSE**. FUSE blocks `unlink()` for processes on Claude's side — so `device_bash` can `mv` a file but can never truly `rm` one. This has one specific, recurring consequence: **git can finish a commit successfully and still fail to clean up its own `.git/HEAD.lock` / `.git/index.lock` / `tmp_obj_*` files afterward**, because deleting them is exactly the operation the bridge blocks. You'll see `git commit` print `warning: unable to unlink '.git/index.lock': Operation not permitted` and then still report `[main <hash>] ...` — that's a successful commit with a harmless leftover lock, not a failure. Don't re-run the commit when you see this; check `git log -1` to confirm it landed before doing anything else.

**Standing protocol, every time you're about to run a git write command (`add`, `commit`, `push`, `rebase`, etc.) via `device_bash`:**

1. **Check first, don't wait for the error.** Before the git command, run `ls -la .git/*.lock 2>&1`. If any exist and there's no real concurrent git process (`ps aux | grep git` on the device, or just reasoning about it — this session isn't running two git commands at once), they're stale.
2. **Clear stale locks with `mv`, never retry-named copies.** Move each into `_to_delete/` with one clear, session-stamped name (e.g. `_to_delete/index.lock.session210`), not a fresh guess-name like `index.lock.retry3` — the whole reason `_to_delete/` ballooned to 36+ files by session 209 was every past session inventing a new filename instead of just clearing the path and moving on.
3. **If a git command itself throws the unlink warning but still reports a commit hash, treat it as success.** Don't loop retrying — `rm -f` will fail every time (permission denied on this bridge), and repeated retries are exactly what generated the pile of `retry1`/`retry2`/`retry3`/`retry4` files last time.
4. **`_to_delete/` is a one-way holding pen, not a fix.** Claude cannot ever truly empty it from this side. If it's grown large (check `du -sh _to_delete`), tell David so he can delete it for real from Finder/Terminal on his Mac — `rm -rf _to_delete .git/*.lock` from the WashRoute folder, done in seconds locally. Don't silently let it keep growing session after session; flag it once it's noticeably large (dozens of files / hundreds of KB) rather than waiting for him to notice.
5. **Never suggest disabling this check or skipping locks with `git commit --no-verify`/`-f`** — the lock files are genuinely inert (0 bytes, git's own abandoned temp state), the risk isn't in ignoring them, it's in retry-looping and re-cluttering `_to_delete/`.

This is a structural limitation of the FUSE bridge, not a git misconfiguration — it cannot be fixed by changing git config, hooks, or repo settings. The only real fix is periodic manual cleanup by David on his own machine.

---

## Supabase

**Project ID:** `umjpbuxrdydwejqtensq`
**Anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtanBidXhyZHlkd2VqcXRlbnNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NjgzMDQsImV4cCI6MjA4NzU0NDMwNH0.22WyUfBsqPaaza_HiDo1f_tQE3sGUDEJYYyV29XUSeY`
**Supabase URL:** `https://umjpbuxrdydwejqtensq.supabase.co`

Use the Supabase MCP tools (`apply_migration`, `execute_sql`, `deploy_edge_function`) — never raw curl for DB operations.

**`deploy_edge_function` from this sandbox has a real size ceiling**, found the hard
way in session 251: a single call tops out somewhere around 100-130KB of literal
file content before the response itself gets cut off mid-generation — not a
Supabase limit, a limit on how much one sandbox tool call can produce. A function
whose dependency bundle is more than ~5-6 files, or whose combined size is
anywhere near 100KB, should skip the MCP tool and go straight to handing David the
CLI command instead: `npx supabase functions deploy <name> --project-ref
umjpbuxrdydwejqtensq` from the repo root (after `supabase login` once on his
machine). Below that rough size, the MCP tool is fine. Full story in
PROJECT-NOTES-BOOKKEEPING.md's session 251 (cont. 2) entry — this same rule was
already written down once before, in session 232, and got rediscovered the
expensive way because it wasn't visible enough here.

### Key Tables

| Table | Key details |
|---|---|
| `customers` | `phone_cache` stores phone in any format e.g. `(415) 608-5446`. **`frozen_at`/`frozen_reason`** (session 173): when `frozen_at` is set the customer can place NO new orders — `trg_enforce_not_frozen` BEFORE INSERT on orders hard-blocks direct inserts and RETURN-NULLs recurring ones. **`notes`** (column) = the old per-customer Internal Notes; the Notes panel tab was replaced by an Issues tab (session 173) and existing `notes` were migrated into `cs_issues` (`created_by='migration'`). **`preferences._notes`** (jsonb) is the SEPARATE 'Special Care Notes' — edited in Preferences tab + customer app, shown in processing, and used as the order special-instructions fallback. Do NOT confuse the two. **`sms_notifications_opt_out_at`** (session 174): when set, ALL automated SMS (reminders/status/on-my-way/dunning) are suppressed; manual Inbox sends still work. Set for all 18 Kidango sites. |
| `orders` | Status pipeline: `scheduled → picked_up → processing → ready_for_delivery → out_for_delivery → delivered`. `cancelled_by`: 'customer'/'driver'/'admin'/'system' (nullable). `charge_failed_at` (TIMESTAMPTZ): set by charge-order on decline, cleared on success. `overcap_booking` (BOOLEAN, session 131): advisory flag, purely cosmetic. **`paid_at` was DROPPED in session 134** — `billed_at` is the sole source of truth for payment timestamp. **CHECK constraint** (session 134): `customer_id` may only be NULL when `source='walk_in'` (POS anonymous merchandise). **`billing_status`** values: paid / refunded / failed / NULL / **`written_off`** (session 172 — intentionally uncollectible, e.g. deceased/uncollectible customer; excluded from every unpaid view + audit Check 3/3b). **`recurring_anchor_at`** (TIMESTAMPTZ, session 172): the INTENDED recurring pickup; `trg_create_recurring_order_fn` computes the next occurrence from this (not the possibly holiday/Sunday-shifted actual), so a one-time shift never drifts the cadence. **`archived_at`/`archived_reason`/`archived_by`** (existing): hides an order from Overview (unpaid widget + in-app audit Check 3 now filter `archived_at IS NULL`, session 173) — history preserved, restorable via Archived tab. |
| `routes` | Daily run records derived from `route_templates`. **Single date column `run_date`** — the legacy `date` column was DROPPED in session 134; all code uses `run_date`. Has `driver_id` (legacy = `pickup_driver_id`), `pickup_driver_id`, `delivery_driver_id`. |
| `route_stops` | Explicit `driver_id` on every stop (auto-filled by `trg_fill_stop_driver`). `stop_number` auto-assigned by `trg_assign_stop_number` BEFORE INSERT trigger when caller leaves NULL (session 134 — atomic per-route via `pg_advisory_xact_lock`, replaces 5 select-then-insert sites). Has `on_my_way_sent_at`, `status`, `stop_type`, `photo_skipped_at` (TIMESTAMPTZ, session 134 — set when driver completes a stop without a proof photo via the Skip Photo button; admin sees a 📷✗ badge). |
| `holidays` | (session 172) `holiday_date` (DATE, unique) + `name`. Admin-managed via General → Holidays. `is_holiday(date)` helper. `trg_enforce_no_holiday_orders` BEFORE INSERT/UPDATE on orders rejects any pickup OR delivery on a holiday (all paths). Recurring + SMS reorder shift forward to the next service day; customer-app greys out holiday dates. RLS: public SELECT, admin/manager write. |
| `sms_messages` | All Twilio SMS in/out. `direction`: inbound/outbound. `customer_id` nullable |
| `driver_messages` | In-app admin ↔ driver chat — NOT SMS |
| `profiles` | Auth users. Linked to `customers` and `drivers` |
| `drivers` | One row per person who drives. **`profile_id` is UNIQUE, and `trg_prevent_duplicate_driver_identity` (session 231) rejects any INSERT/UPDATE that would give one human a second driver record** — matched on the profile's normalized last-10 phone OR its email (blank/short values ignored). Expect a `DUPLICATE_DRIVER_IDENTITY: ...` error, not a silent no-op, if you try. **Why it exists:** Aracely Cruzado had two driver rows (a phone-OTP account and a later `create-staff` email account, same person). The driver app resolves stops via `current_driver_id()`, which follows the login used, so on any day admin scheduled her on the other record she opened the app to an empty route — and `link_phone_auth_driver`'s merge attempt died on the unique constraint into a `console.warn`. **`is_active` gates NOTHING** — no app or DB function reads it; it is display-only and currently inaccurate (Known Issues #39). |

### Phone Number Matching
Twilio sends E.164 (`+14156085446`); DB stores formatted (`(415) 608-5446`).
Always match by stripping non-digits and comparing last 10 digits.
Postgres helper: `find_customer_by_phone(digits TEXT)`.

### Edge Functions

| Function | Purpose | JWT |
|---|---|---|
| `send-sms` | Send outbound SMS via Twilio + log to `sms_messages` | Off |
| `twilio-webhook` | Receive inbound SMS → match customer by phone | Off |
| `notify-on-my-way` | Driver "On My Way" → customer SMS + mark stop `en_route` | Off |
| `charge-order` | Stripe payment — **v31 (session 83):** uses `NON_CHARGEABLE_STATUSES` blacklist (not whitelist). Sets `charge_failed_at` on decline, clears on success. Stamps `billed_at` only (`paid_at` was dropped session 134). `verify_jwt: false`. | Off |
| `send-order-notification` | Status-change notifications. **v29 (session 134):** `console.warn` on `no_template`/`sms_disabled` paths so admin's accidental toggle-off is visible in Edge Function logs immediately. | Off |
| `get-stripe-fees` | Admin-only Stripe fees lookup. **v3 (session 134):** flipped to `verify_jwt: false` to match project pattern (in-function `requireAdmin()` enforces auth). | Off |
| `cancel-subscription` / `pause-subscription` / `resume-subscription` | Subscription lifecycle. **v2 (session 134):** added `assertOwnership(req, sub.customer_id)` — closes auth gap before launch. | Off |
| `apply_customer_credit_to_order` (RPC) | Atomic credit deduction + ledger insert. SECURITY DEFINER, `FOR UPDATE` row lock. Replaces 3 admin sites that did sequential update + insert (session 134). | RPC |
| `delete_address` (RPC) | Atomic FK clear + delete in one txn. SECURITY DEFINER. Replaces admin's 4-statement pattern that could fail with FK violation under concurrent INSERTs (session 134). | RPC |
| `send-scheduled-reminders` | Cron-triggered reminder SMS (day-before, day-of, reorder) | Off |

### pg_cron Jobs
| Job name | Schedule (UTC) | Fires at (PT) | Type sent |
|---|---|---|---|
| `wr-reminder-evening` | `0 1 * * *` | ~6pm | `day_before` — pickups 12–36h from now |
| `wr-reminder-morning` | `0 14 * * *` | ~7am | `morning` — day_of + reorder (not day_before) |

**Reminder dedup:** Each reminder type has its own timestamp column on `orders` (`reminder_day_before_sent_at`, `reminder_day_of_sent_at`, `reorder_reminder_sent_at`). Cron queries filter `IS NULL` so each order only ever gets each reminder once.

---

## Twilio ✅ Live

A2P 10DLC registration approved 2026-03-16. SMS fully operational — outbound delivery working on all customer numbers.

Credentials are stored in **Supabase Secrets** (session 8 — no longer hardcoded in edge functions):
- `TWILIO_ACCOUNT_SID` = `AC57c50cec278e5987a7a0d8d9443d1851`
- `TWILIO_AUTH_TOKEN` = (secret — rotated session 8)
- `TWILIO_PHONE_NUMBER` = `+15105884102`
- Webhook URL: `https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/twilio-webhook`

---

