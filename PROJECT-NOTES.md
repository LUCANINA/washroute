# WashRoute — Project Notes
*Last updated: Mar 12, 2026*

---

## What We're Building

Three connected web apps, one shared database. Focused on **delivery first** (retail/drop-off in a later phase).

| App | File | Who uses it |
|---|---|---|
| Admin Dashboard | `admin-dashboard/index.html` | Owner + managers |
| Customer App | `customer-app/index.html` | Customers |
| Driver App | `driver-app/index.html` | Drivers |

**Supabase project ID:** `umjpbuxrdydwejqtensq`

---

## Services Offered
- Wash & Fold (by weight)
- Shirt Service (per item)
- Hang Dry / Delicates (special handling)
- Monthly Subscription — flat fee, unlimited pickups

---

## Integration Stack

| Tool | Purpose | Status |
|---|---|---|
| Supabase | Database + auth + realtime + Edge Functions | ✅ Live |
| Stripe | Subscriptions + payments | ✅ Integrated (charge-order fn) |
| Twilio | 2-way SMS inbox + driver notifications | ✅ Built — ⚠️ see note below |
| SendGrid | Transactional email + receipts | ✅ Done |
| Klaviyo | Marketing broadcasts + segments | 🔲 Pending |
| Google Maps | Driver navigation + live tracking | 🔲 Pending |
| Google Route Optimization API | Auto-sort route stops | 🔲 Pending |
| Xero | Accounting sync | 🔲 Pending |
| Vercel | App hosting | 🔲 Pending |

### ⚠️ Twilio — Action Required Before SMS Works
Outbound SMS is built and tested end-to-end but messages are stuck in `queued` status because:
- **If on a trial account:** Verify the recipient number at Twilio Console → Phone Numbers → Verified Caller IDs
- **If on a paid account:** Register for A2P 10DLC at Twilio Console → Messaging → Regulatory Compliance (required by US carriers)

Twilio credentials are embedded in the three Edge Functions (not yet moved to Supabase secrets):
- Account SID: `AC57c50cec278e5987a7a0d8d9443d1851`
- From number: `+15105884102`
- Webhook URL (set in Twilio Console): `https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/twilio-webhook`

---

## Supabase Edge Functions

| Function | Purpose | JWT |
|---|---|---|
| `send-sms` | Send outbound SMS via Twilio + log to DB | Off |
| `twilio-webhook` | Receive inbound SMS from Twilio + match customer | Off |
| `notify-on-my-way` | Driver "On My Way" button → customer SMS | Off |
| `charge-order` | Stripe payment charge | On |
| `send-order-notification` | Status-change notifications | On |

---

## Admin Dashboard — Completed Features

### Orders Page
- Full order table with status pipeline filter tabs
- Click status badge to change status on individual orders
- "Advance Status" batch action (requires all selected orders to have same status)
- Cancel = hard delete (irreversible, with confirmation)
- Clickable pickup/delivery route cells for rescheduling → "Reschedule Route" modal
- "+ Assign" shown instead of "—" for unassigned reschedulable orders
- **Batch SMS:** select orders → Send SMS → compose message → sends to all customer phones

### Routes Page
- Route template editor (create/edit recurring routes)
- Live map view with stop assignment/reassignment per driver
- Stop reassignment: picking route's default driver clears override (sets NULL, not explicit UUID)
- Weekly Schedule: time-banded rows (morning/evening slots), one row per route, chips show driver name
- Removed: "Upcoming Routes Preview", "This Week's Workload"

### Inbox Page
- Real SMS conversations grouped by customer
- Realtime updates (new inbound messages appear instantly)
- Reply sends via Twilio Edge Function
- "Compose" button (top right) to start a new SMS to any number
- Blue dot badge shows unread inbound count
- Customer auto-matched by last 10 digits of phone (handles any formatting)

### Other
- Customer management, driver management, services & pricing, reports (all built)
- Driver Messages tab (in-app driver ↔ admin chat, separate from SMS)

---

## Driver App — Completed Features
- Daily route loads automatically by driver login
- Per-stop detail view: address, customer name, order info, special instructions
- One-tap Google Maps navigation
- Mark pickup / delivery complete with optional photo
- **📲 On My Way button** → marks stop `en_route` + sends customer an SMS automatically
- Undo complete (within same session)

---

## Terminology

We use **"Route"** for everything — both the template definition (e.g. "the Oakland AM route") and a specific dated instance (e.g. "the Oakland AM route on March 12"). We never say "run" in conversation or UI. The DB still has legacy column names like `run_date`, `pickup_run_id`, `delivery_run_id` — renaming those would touch hundreds of lines across all apps, so they stay as-is, but in all human-facing text and notes we say "route."

---

## Database Key Tables

| Table | Notes |
|---|---|
| `customers` | `phone_cache` stores phone in any format (e.g. `(415) 608-5446`) |
| `orders` | Status pipeline: scheduled → ready_for_pickup → picked_up → processing → ready_for_delivery → out_for_delivery → delivered. `source`: scheduled, walk_in, customer_app, recurring |
| `route_templates` | Recurring route definitions: zone, schedule_days (0=Mon..5=Sat), window_start/end, turnaround_days, default drivers, stop_limit |
| `routes` | Dated route instances (auto-created from templates by `auto_route_order()`). Links to template_id, date, driver assignments. Note: DB columns still use `run_date` / `pickup_run_id` / `delivery_run_id` — legacy naming, but we call everything "Route" in conversation and UI |
| `route_stops` | `driver_id = NULL` means inherit route default; set = individual override |
| `route_driver_overrides` | Per-day driver overrides: (template_id, day_of_week, driver_type) → driver_id |
| `sms_messages` | All SMS in/out. `direction`: inbound/outbound. Linked to `customers` by phone matching |
| `driver_messages` | In-app admin ↔ driver chat (not SMS) |

### Key DB Functions & Triggers
| Object | Type | Purpose |
|---|---|---|
| `auto_route_order(p_order_id)` | Function | Matches order to template by zone+day+time, finds/creates the dated route, assigns driver, creates stops |
| `trg_auto_route_new_order` | Trigger (AFTER INSERT on orders) | Fires for new scheduled orders with zone but no route assigned |
| `trg_create_recurring_order` | Trigger (AFTER UPDATE on orders) | On status → delivered with recurring_interval, creates next order (which then auto-routes) |
| `find_customer_by_phone(digits)` | Function | Matches phone by last 10 digits |

---

## Phone Number Matching
Twilio sends E.164 (`+14156085446`), DB stores formatted (`(415) 608-5446`).
We match by stripping all non-digits and comparing last 10 digits.
Postgres function: `find_customer_by_phone(digits TEXT)`.

---

## SMS / Email Automation — Roadmap

The goal is to auto-handle common customer requests that arrive via SMS or email
(e.g. "I'd like to book a pickup tonight") without requiring admin intervention.

### Pipeline overview
1. **Ingestion** — Twilio webhook (SMS) or Postmark/SendGrid inbound parse (email)
   fires a Supabase Edge Function when a message arrives.
2. **Intent recognition** — Call Claude API with the message + customer context.
   Claude classifies intent (booking, cancellation, status check, other) and
   extracts entities (date/time, address, service type).
3. **Customer matching** — Match inbound phone/email to a `customers` row.
   Unknown sender → route to human inbox.
4. **Action execution** — Write to Supabase (create order, update status, etc.)
   and send a confirmation reply.

### Build order (start simple, prove pipeline first)
| Phase | What | Why |
|-------|------|-----|
| 1 | **Status checks** — "Where's my driver?" / "What time is my pickup?" | Read-only, zero risk, proves pipeline |
| 2 | **Cancellations** — "Can I cancel Thursday?" | Simple write, business logic is clear |
| 3 | **New bookings** — "Book a pickup tonight" | Complex: availability check, multi-turn conversation, order creation |

### Key new pieces needed
- `conversations` table — tracks state for multi-turn SMS threads
  (which step of the booking flow a customer is currently in)
- New Edge Function (or extend `twilio-webhook`) — orchestrates intent → action → reply
- Admin dashboard: "Automation log" panel — shows what was auto-handled vs. escalated

### Fallback-to-human triggers
- Claude confidence below threshold
- Customer replies more than twice without resolution
- Certain keywords: "speak to someone", out-of-area address, angry language
- Any request the system has no data to answer

### Notes
- Twilio webhook URL already exists: `twilio-webhook` Edge Function
- Phone matching already solved: `find_customer_by_phone()` Postgres function
- Start with Phase 1 as a contained afternoon project

---

## Stripe Migration (Starchup → Family Laundry)

When ready to cut over from Starchup, customer payment methods need to be migrated between Stripe accounts.

| | Account ID |
|---|---|
| **Source** (Starchup connected account, current) | `acct_1PJhUs2f1JPZhPdh` |
| **Destination** (Family Laundry standalone account) | `acct_1MPrRDGACgbvEugH` |

### Migration process
1. Pull the list of `cus_xxx` Stripe customer IDs from Starchup's export
2. Open a support ticket with Stripe requesting payment method migration between the two accounts — include both account IDs and the customer ID list
3. Stripe manually migrates card tokens (typically 1–3 weeks)
4. Once migrated, import customers into WashRoute DB with the new `cus_xxx` IDs

### Fallback plan
If migration is incomplete or Stripe can't move certain cards, run a re-entry email campaign asking customers to re-add their card (small incentive helps conversion).

---

## Recurring Order Auto-Scheduling

### How it works (two mechanisms)

**1. Trigger-based (primary, real-time):** When an order with `recurring_interval` is marked `delivered`, the `trg_create_recurring_order` trigger immediately creates the next order with shifted pickup/delivery windows (weekly +7d, biweekly +14d, monthly +1mo). Sundays are skipped (bumped to Monday). The new order INSERT fires `trg_auto_route_new_order` which auto-assigns it to the correct route. Source is set to `'recurring'`.

**2. pg_cron batch (backup, daily):** A Postgres function `create_recurring_orders()` runs every day at **8 AM UTC** (midnight Pacific) via pg_cron. For each customer's most recent recurring order, it calculates the next pickup date and creates orders within a 7-day lookahead window. Idempotent — won't create duplicates.

**Manual trigger:** Admin Dashboard → Overview → "Recurring Orders" panel → **▶ Run Scheduler** button.

**To view the cron schedule:** Supabase Dashboard → Database → Cron Jobs → `create-recurring-orders`.

---

## Known Recurring Issues

### 🔄 Login button gets permanently stuck ("Signing in…")
**Symptom:** After tapping Sign In, the button stays disabled and says "Signing in…" forever. Sometimes called a "cache issue" but it's actually a network hang.

**Root cause:** `db.auth.signInWithPassword()` can silently hang on flaky/mobile networks — the Promise never settles, so `try/catch` can't save you and the button stays stuck.

**Why `Promise.race` does NOT fix this:** The Supabase auth client doesn't behave as a plain Promise in a `Promise.race` — the timeout leg fires immediately, causing instant "Connection timed out" errors on every login.

**Current fix — two-stage safety net (all three apps):**

There are actually **two separate hang points** that must both be covered:

1. **`signInWithPassword` itself hangs** → `safetyTimer` (30s) in `handleLogin()` / `doLogin()` covers this. `clearTimeout(safetyTimer)` is called in all resolution paths.

2. **Post-auth DB fetch hangs** → After `signInWithPassword` resolves, `onAuthStateChange` fires and immediately does a DB query (profile fetch in admin, `loadDriverData()` in driver app). If that fetch hangs, the first safety timer is already cleared and nothing resets the button. Fixed with a second `profileTimer` / `loadTimer` (15s) scoped inside `onAuthStateChange`.

**Customer app is safe** — `showLoading()` has a built-in 20s self-dismiss timer, and the login button is explicitly re-enabled on `signInWithPassword` success before `onAuthStateChange` fires.

**If it recurs:** Check both `handleLogin()` (for the 30s `safetyTimer`) **and** `onAuthStateChange` (for the 15s `profileTimer`/`loadTimer`) in whichever app is stuck.

---

## 📋 Working Convention

**Update PROJECT-NOTES.md at the end of every session.** This is the only memory that persists between days — Claude starts fresh each session, so anything not written here is lost. At end of day, log what was built, any decisions made, and anything pending.

---

## Session Log

### Mar 10, 2026
- **Order status pipeline rework:** New flow is `scheduled → ready_for_pickup → picked_up → processing → ready_for_delivery → out_for_delivery → delivered`. Retired `assembled`; replaced `pickup_missed`/`delivery_missed` with unified `skipped` (sits in Issues tab until manually resolved).
- **Filter tabs rework:** Removed "All" tab from Orders page and customer profile. "Upcoming" renamed to "Scheduled". Default tab is now Scheduled.
- **Cancelled orders:** Hidden from All/Scheduled/Active views. Dedicated greyed-out Cancelled tab added in admin and customer profile.
- **Login stuck bug fixed:** `signInWithPassword` can silently hang on flaky networks. Fixed with `setTimeout` safety net (30s) in both admin and customer app. `Promise.race` does NOT work — don't use it (fires immediately with Supabase auth client).
- **Customer app home:** Removed duplicate "Schedule a Pickup" nudge from empty active orders card.
- **Driver app multi-route support:** Driver can now be assigned multiple routes in a day. Home screen shows one card per route with per-route stats. Stop list groups stops by route under route name headers. Stops render in `stop_number` order (geographic) — the old pickup/delivery section split was removed since stops are prioritized by location, not category.
- **Dummy test data:** 8 customers created (4 Berkeley, 4 Oakland), each with a scheduled order for Wed Mar 11 · 7–9 AM pickup, assigned to Berkeley AM / Oakland AM routes. Delivery routes (also named Berkeley AM / Oakland AM) set for Thu Mar 13 · 12–2 PM. Customer IDs start with `a1000001-`, address IDs with `b1000001-`, route IDs with `c1000000-0000-0000-0001-`.
- **Login hang fix extended:** Diagnosed a second hang point — after `signInWithPassword` resolves, `onAuthStateChange` fires and does a DB fetch that can also silently hang. Added a second 15s safety timer (`profileTimer`) in admin `onAuthStateChange` and a `loadTimer` in driver app `onAuthStateChange` covering `loadDriverData()`. Customer app confirmed safe (built-in 20s self-dismiss). All three apps now fully covered.
- **Driver app `doLogin()` hardened:** Was missing `try/catch` and any safety timer. Added both (30s timer + try/catch), consistent with admin `handleLogin()`.
- **Admin login timeout fix (root cause solved):** When a cached session existed in localStorage, Supabase fired `INITIAL_SESSION` + `TOKEN_REFRESHED` on page load. These background operations raced against the user's manual `signInWithPassword` call and caused the 30s safety timer to fire ("Connection timed out"). Fix: on a fresh tab/window load, clear localStorage before initialising Supabase so there's no cached session to trigger the race. `sessionStorage` is used to distinguish a fresh load (clear localStorage) from a page refresh within the same tab (keep the session). Outcome: no timeout on fresh visits, no logout on refresh. sessionStorage flag set on successful login, cleared on logout.
- **Admin logout-on-refresh fix (round 2):** Supabase v2 can fire `INITIAL_SESSION` with `session = null` when the access token is expired but the refresh token is still valid (e.g. once per hour). The previous code called `showLoginScreen()` immediately on any null session, removing the `sessionStorage` key and flashing the login screen before `TOKEN_REFRESHED` arrived with a fresh token. Fix: `SIGNED_OUT` is the only event that definitively ends a session — show login immediately only for that event. For any other null-session event (`INITIAL_SESSION` null, etc.), start a 2-second fallback timer; if `TOKEN_REFRESHED` arrives with a valid session first, the timer is cancelled and the app shows normally. Result: no login-screen flash on token refresh, and users stay logged in across refreshes.

### Mar 12, 2026 (session 3) — Auto-routing architecture overhaul
- **Major architecture change: route assignment moved from client JS to DB triggers.**
  The system now auto-routes orders without any admin intervention. Zero manual route creation needed.
- **New DB objects created:**
  1. `route_driver_overrides` table — per-day driver overrides by template + day_of_week + driver_type (pickup/delivery)
  2. `auto_route_order(p_order_id UUID)` function — matches templates by zone + day + time window, finds or creates the dated route, resolves drivers (override → template default → NULL), handles capacity overflow, creates route_stops, links order FKs, syncs `total_stops`
  3. `trg_auto_route_new_order()` trigger — AFTER INSERT on orders, fires for `status='scheduled' AND zone_id IS NOT NULL AND pickup_run_id IS NULL`
  4. `trg_create_recurring_order()` trigger — AFTER UPDATE on orders, fires when status transitions to `delivered` and `recurring_interval` is set. Creates next order (shifted by weekly/biweekly/monthly), skips Sundays (bumps to Monday). New order INSERT fires the auto-route trigger automatically.
- **Updated `orders_source_check`** — expanded from `('scheduled','walk_in')` to include `'customer_app'` and `'recurring'`.
- **Removed JS auto-assign from customer app** — the 80-line IIFE with `tmplsForDay()`, `runForDate()`, `nextStopNum()` helpers is gone. Replaced with a comment noting DB trigger handles it.
- **Admin dashboard JS route_stop code retained** — `saveOrder()` route_stop creation stays (needed when admin explicitly picks routes, since trigger only fires when `pickup_run_id IS NULL`). `opSaveRouteAndSlot()` stays (manual route reassignment from order panel).
- **Tested end-to-end:** Inserted a test order for Oakland AM March 12 → trigger auto-created the dated route, assigned driver, created pickup + delivery stops. Then set `recurring_interval='weekly'` and marked delivered → recurring trigger created next order for March 19, which in turn auto-routed to Oakland AM March 19/20. Full chain works.
- **⚠️ Previous operational note is OBSOLETE:** Admins no longer need to pre-create routes. The DB function auto-creates them from templates on demand.

### Mar 12, 2026 (session 2)
- **SendGrid confirmed working** — customer email receipts are live.
- **Root cause of missing routes on customer orders diagnosed and fixed (4 bugs):**
  1. **Dummy test routes had no `template_id`** — auto-assign queries routes by `template_id`; the 4 hardcoded test routes (c1000000... IDs) had `template_id = NULL`, making them invisible. Fixed via SQL UPDATE.
  2. **Customer app: auto-assign only handled pickup, never delivery** — rewrote the auto-assign block to find both pickup and delivery routes (by zone + day-of-week), create both stops, and update both `pickup_run_id` + `delivery_run_id` in one write.
  3. **Admin new-order modal: created route FKs but never created route_stop rows** — fixed to also insert pickup and delivery `route_stop` rows when routes are auto-linked.
  4. **Admin order panel delivery assignment: created no route_stop** — `opSaveRouteAndSlot` already upserted a stop for pickup assignments; mirrored the same logic for delivery.
- **`source` field fixed** — customer-placed orders now correctly set `source = 'customer_app'` (was inheriting DB default `'scheduled'`).
- ~~**⚠️ Important operational note:** Auto-assign only works when admin has already created routes~~ — **OBSOLETE as of session 3, DB triggers now auto-create routes.**
- **Commit:** `791cc6f`

### Mar 12, 2026 (session 1)
- **Admin logout-on-refresh — FINAL root cause and fix:** Despite the `_noopLock` Web Locks fix being confirmed deployed and working, the logout-on-refresh bug persisted on every single refresh. Diagnosed using `[WR Auth]` console logging added to `onAuthStateChange`. Root cause: there was a `localStorage.removeItem('wr-admin-auth')` call guarded by `sessionStorage.getItem('wr-admin-tab')`. The intent was to clear stale sessions on fresh tab opens. The guard was supposed to pass on page refreshes (same tab, sessionStorage preserved). BUT: in Chrome, when the profile fetch fails for any reason, `sessionStorage.setItem('wr-admin-tab', '1')` never runs — so the flag is never set — so the guard fires on the next refresh — so localStorage gets wiped — perpetual logout cycle. Additionally the `_noopLock` fix already eliminated the Web Locks race that this guard was defending against, making the guard pure overhead. **Fix:** Removed the entire `localStorage.removeItem` guard block. Supabase now manages the session lifecycle on its own. Invalid/expired sessions result in `SIGNED_OUT` which correctly shows the login screen. **Commit:** `57cfcb0`. **⚠️ NOT DEPLOYED YET — David needs to run `vercel --prod` from terminal to go live.**
- **Auth diagnostics added (will remove in a future cleanup):** Added `[WR Auth]` console.log lines at every key auth decision point (onAuthStateChange entry, profile fetch success/error, showLoginScreen, null-session timer). Useful for debugging. Commit `afe7436`.
- **`_sessionNullTimer` extended from 2s → 10s:** Commit `afe7436`. Also not yet deployed but bundled with the above.

### Mar 11, 2026
- **QA sweep (all three apps):** Full code review pass. Found two issues fixed below.
- **Customer app safetyTimer wrong element ID:** `document.getElementById('home-screen')` was wrong — correct ID is `screen-home`. Bug caused the login button to always show "Connection timed out" after 30 seconds even when the user was already authenticated. Fixed by correcting the ID.
- **`pickup_failed` missing from admin Issues tab:** `ORDER_FILTER_GROUPS.issues` only had `['skipped','on_hold']`. Orders with `pickup_failed` status were invisible in the dashboard. Fixed by adding `'pickup_failed'` to the array.
- **Admin logout-on-refresh — TRUE root cause (Web Locks deadlock):** Confirmed via live browser testing. Supabase JS v2 acquires a Web Lock named `lock:wr-admin-auth` during auth initialisation and token refresh. On hard refresh (Cmd+R / F5), the new page tries to acquire the same lock before the browser fully releases it from the unloaded page. This causes a **permanent deadlock** — `getSession()` and all subsequent auth calls hang forever (never resolve, never reject). Symptoms: the app loads but never shows any content and never transitions to login screen either. `navigator.locks.query()` confirmed: lock held with 9 pending requests. The previous `sessionStorage` and `INITIAL_SESSION` fixes did not address this at all — the storage was intact, the auth event pipeline just never started. **Fix:** Pass a no-op lock function to `createClient` to bypass Web Locks entirely: `const _noopLock = (name, acquireTimeout, fn) => fn();` used as `auth: { lock: _noopLock }`. Safe for this app — single admin, single tab, no concurrent refresh race conditions to worry about.

---

## Pending / Next Up
- ⚠️ Twilio verification / A2P 10DLC registration (SMS delivery fix)
- Receipt printing: print button on order detail (thermal 80mm bag tag) — mockup exists at `receipt-mockup.html`
- ~~Customer email receipt (SendGrid)~~ ✅ — SendGrid confirmed working and sending
- SMS/email automation — Phase 1: status check auto-replies (see section above)
- Live driver tracking (Google Maps)
- Xero accounting sync
- Klaviyo marketing integration
- Vercel deployment

---

## Test Order SQL Template

When inserting test orders directly via SQL, use this template so that DB triggers fire correctly and the order behaves like a real customer-placed one. **Replace the placeholder values** with real IDs from the DB.

```sql
-- ╔══════════════════════════════════════════════════════════════╗
-- ║  TEST ORDER INSERT — copy, fill in placeholders, run once   ║
-- ╚══════════════════════════════════════════════════════════════╝
--
-- REQUIRED: fill in customer_id, address_id, zone_id, and dates.
-- The auto-route trigger handles everything else (route, stops, driver).
--
-- Zone IDs (for reference):
--   Oakland:       fbc4627b-7026-44e2-9b00-2c3c867f4460
--   Berkeley:      2dfc9835-3528-4143-bfa1-c6a9961bb3c2
--   Alameda:       9d624c91-2991-45d0-bcdd-db0906ad88c2
--   San Francisco: 670d7bb1-68f0-4696-9b8c-a726d8c85da4
--   Hayward:       39d9a0c0-c906-45f6-a8ab-6fe4a992e026

INSERT INTO orders (
  customer_id,
  status,
  total_bags,
  total_amount,
  pickup_window_start,        -- UTC timestamp (Pacific + 7 in winter, + 8 in summer)
  pickup_window_end,
  delivery_window_start,
  delivery_window_end,
  zone_id,
  pickup_address_id,
  delivery_address_id,
  source,
  line_items,
  recurring_interval          -- NULL, 'weekly', 'biweekly', or 'monthly'
) VALUES (
  '________-____-____-____-____________',   -- customer_id (required)
  'scheduled',                               -- must be 'scheduled' for trigger to fire
  2,                                         -- total_bags
  0,                                         -- total_amount (set when charged)
  '2026-03-__T__:00:00Z',                   -- pickup start (UTC)
  '2026-03-__T__:00:00Z',                   -- pickup end (UTC)
  '2026-03-__T__:00:00Z',                   -- delivery start (UTC, typically +1 day)
  '2026-03-__T__:00:00Z',                   -- delivery end (UTC, typically +1 day)
  '________-____-____-____-____________',   -- zone_id (required — see list above)
  '________-____-____-____-____________',   -- pickup_address_id
  '________-____-____-____-____________',   -- delivery_address_id (same as pickup if identical)
  'customer_app',                            -- source: customer_app, scheduled, walk_in, recurring
  '[]',                                      -- line_items (JSONB array)
  NULL                                       -- recurring_interval (NULL for one-time)
);

-- ⚠️ DO NOT set pickup_run_id or delivery_run_id — leave them NULL
--    so the auto_route_on_insert trigger fires and assigns routes.
--
-- ⚠️ Pickup time must fall within a route template's window for the
--    order's zone + day-of-week, or no route will be assigned.
--    Current windows: AM = 07:00-11:00, PM = 18:00-22:00 Pacific
--
-- To verify it worked:
-- SELECT id, pickup_run_id, delivery_run_id FROM orders WHERE id = '<new-id>';
```

---

## Git Log (recent)
```
57cfcb0  fix: remove Safari/Chrome-breaking sessionStorage guard that wiped auth on every refresh
afe7436  debug: add auth event logging + extend null-session timer to 10s
(before these) Fix: bypass Web Locks deadlock in admin auth; fix pickup_failed Issues tab; fix customer safetyTimer ID
9118546  Fix: cover both hang points in driver app login (signInWithPassword + loadDriverData)
36a256e  Fix: cover profile-fetch hang in onAuthStateChange (admin)
5cf47c3  Driver app: support multiple routes per day; fix stop ordering
ed97a34  Fix: replace Promise.race with setTimeout safety net for login timeout
431551c  Remove duplicate Schedule a Pickup nudge from empty active orders card
174bcc1  ux: driver app polish pass
ce44eed  ux: admin dashboard polish pass
6026ff8  ux: customer app polish pass
```

---

## Folder Structure
```
WashRoute/
├── admin-dashboard/
│   └── index.html              # Full admin dashboard SPA
├── customer-app/
│   └── index.html              # Customer-facing app
├── driver-app/
│   └── index.html              # Driver app
├── receipt-mockup.html         # Thermal bag tag + email receipt mockup
├── PROJECT-NOTES.md            # This file
├── TECH-STACK.md
└── QA-notes-2026-02-26.md
```
