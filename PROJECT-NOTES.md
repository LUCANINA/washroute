# WashRoute — Project Notes
*Last updated: Mar 17, 2026 (session 30 — design overhaul)*

---

## 🖨 Hardware (Processing Center)

| Item | Decision | Notes |
|---|---|---|
| Thermal printer | **Star Micronics TSP654II CloudPRNT** (already owned) | MAC: `00:11:62:0D:B1:B8`. 80mm, 300mm/sec. Using via WiFi + AirPrint for now. |
| iPad stand (full-size) | **Heckler Design WindFall** (~$150–200) | Not yet purchased |
| iPad mini stand | **Heckler Design WindFall for iPad mini** (~$100–130) | Not yet purchased |
| Receipt paper | Standard 80mm thermal roll | Buy in bulk |

### Current printing setup (WiFi / AirPrint)
Connect TSP654II to WiFi network → add as AirPrint printer on iPad (Settings → Printers) → WashRoute's popup print works via browser print dialog. Manual tap required.

### ✅ CloudPRNT — Live (session 22)
Receipt prints automatically — no user tap required. Full handshake built and deployed.

**Printer setup (one-time):**
1. Connect TSP654II to WiFi, navigate to its IP in a browser → CloudPRNT settings
2. Set **Server URL** → `https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/cloudprnt`
3. Note the **Token** (default = printer MAC address)
4. In Admin → Settings → Receipt Printer → paste token → Save
5. Click **🖨 Test Print** to verify

**How it works:** When `🖨 Print` is clicked (order panel or kanban Reprint) or intake is saved, the admin queues a job in the `print_jobs` table. The printer polls the `cloudprnt` Edge Function every few seconds, claims the job, prints Star Document Markup content, and reports back done. Falls back to browser popup if no token is configured.

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
| Google Maps | Driver navigation + route optimization | ✅ API key set (Edge Function secret) |
| Xero | Accounting sync | 🔲 Pending |
| Vercel | App hosting | ✅ Auto-deploys on push to main |

### ✅ Twilio A2P 10DLC — Approved (2026-03-16)
Outbound SMS is fully live. A2P 10DLC registration was approved by US carriers on 2026-03-16. Messages no longer stuck in `queued` status.

Twilio credentials are stored in **Supabase Secrets** (rotated session 8 — no longer hardcoded):
- Account SID: `AC57c50cec278e5987a7a0d8d9443d1851`
- From number: `+15105884102`
- Webhook URL (set in Twilio Console): `https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/twilio-webhook`

**⚠️ Important — two separate places store the Twilio Auth Token:**
1. **Supabase Secrets** (`TWILIO_AUTH_TOKEN`) — used by edge functions (`send-sms`, `notify-on-my-way`). Updated session 8.
2. **Supabase Auth → Authentication → Providers → Phone** — used by the customer app phone OTP login. This is a SEPARATE setting in the Supabase dashboard, not a secret. If the Twilio auth token is ever rotated again, **both** places must be updated or OTP login will break with error 20003.

---

## Supabase Edge Functions

| Function | Purpose | JWT |
|---|---|---|
| `send-sms` | Send outbound SMS via Twilio + log to DB | Off |
| `twilio-webhook` | Receive inbound SMS from Twilio + match customer | Off |
| `notify-on-my-way` | Driver "On My Way" button → customer SMS | Off |
| `charge-order` | Stripe payment charge | On |
| `send-order-notification` | Status-change notifications | On |
| `cloudprnt` | CloudPRNT server — printer polls for jobs, gets Star Markup, marks done | Off |
| `optimize-route` | Google Maps route optimization. Accepts `route_id` + optional `driver_lat`/`driver_lng`. Separates done vs pending stops; only re-orders pending. Pickups and deliveries optimized independently. **v12 (session 27):** No-GPS path now uses geographic-extremes algorithm — northernmost and southernmost stops become fixed endpoints; tries both N→S and S→N directions with 2 Google API calls; picks shorter road distance. Eliminates U-shaped routes caused by pinning stop_number extremes as endpoints. When GPS provided: driver position is origin, last pending stop is destination (unchanged). | Off |

---

## Admin Dashboard — Completed Features

### Orders Page
- Full order table with status pipeline filter tabs: Scheduled / In Process / Ready / Issues / **Delivered** (last 24 hours only; cancelled orders are archived, never shown)
- Click status badge to change status on individual orders
- "Advance Status" batch action (requires all selected orders to have same status)
- Cancel = hard delete (irreversible, with confirmation)
- Clickable pickup/delivery route cells for rescheduling → "Reschedule Route" modal
- "+ Assign" shown instead of "—" for unassigned reschedulable orders
- **Batch SMS:** select orders → Send SMS → compose message → sends to all customer phones
- **Order Schedule → Route Command Center (session 25):** "Order Schedule" tab now opens the Route Command Center — a chip-strip + map + draggable columns interface for managing all day's routes at once. See Routes Page notes below.
- **URL hash persistence:** browser URL updates as you navigate (e.g. `#orders/in_process`, `#orders/schedule`). Refreshing the browser restores the exact page + sub-tab you were on.

### Routes Page
- Route template editor (create/edit recurring routes)
- **Route Command Center — Order Schedule (sessions 25–26):** Replaces the old zone-pill + AM/PM Daily Schedule. Full-screen chip-strip + map + draggable columns layout:
  - **Chip strip:** One chip per route template. Click to open/close that route's column. Chips show stop count badge, time window, and dim if no run exists for the date.
  - **Draggable stop cards:** Drag a card from one column to another to reassign the stop to a different route instantly. UI updates optimistically; DB write + `autoOptimizeRoute` on both routes follows async.
  - **Cards:** 3 colors max — route color on stop-number circle, dark gray for customer name, gray for address/type/bag count.
  - **Map:** Full-width by default (empty state overlay). Shrinks as columns open. Shows colored pins + polylines for all open routes simultaneously; legend appears when 2+ routes are open. Click a card to fly-to its pin; hover highlights it.
  - **Column header:** Driver initials avatar (route color), driver name, route name, stop/pickup/delivery counts, completion progress bar.
  - **Optimize button:** Optimizes all currently open routes at once.
  - **Realtime:** Stop completions/skips/reassignments refresh the column automatically via `rccRefreshRoute`.
- Weekly Schedule: time-banded rows (morning/evening slots), one row per route, chips show driver name
- **Auto-optimization (session 24):** Routes re-optimize silently in the background whenever a stop is added (schedule picker, new order creation, drag-and-drop reassign). `autoOptimizeRoute(routeId)` fire-and-forget; refreshes open RCC column if route is active.
- **Manual Optimize button:** Optimizes all currently open RCC route columns at once (replaces old single-route Optimize).
- **Drivers > Schedule page — smart reassignment rules:** Driver chips show 🔒 (complete) or amber dot (in-progress) badges for today's column. Clicking a chip for an in-progress route shows a warning banner and reassigns only the remaining `pending`/`en_route` stops (completed stops stay attributed to the driver who did them). Clicking a chip for a complete route is a no-op with an explanatory toast. Future-week changes apply freely with no restriction.
- **Route-status badges on both schedule grids:** 🔒 (route fully complete) and amber pulsing dot (in progress) badges appear in both the Routes > Weekly Schedule grid and the Orders > Order Schedule > Driver Schedule grid for today's routes.
- **URL hash sub-tab persistence:** Maps (`#maps/routes`, `#maps/zones`), Team (`#team/permissions`), and Routes (`#routes/templates`) tabs all write to the URL hash — refresh returns you to the correct tab.

### Inbox Page
- Real SMS conversations grouped by customer
- Realtime updates (new inbound messages appear instantly)
- Reply sends via Twilio Edge Function
- "Compose" button (top right) to start a new SMS to any number
- Blue dot badge shows unread inbound count
- Customer auto-matched by last 10 digits of phone (handles any formatting)

### Receipt Printing
- Browser popup print (2 copies, auto-prints on intake save + 🖨 Print button in order panel + 🖨 Reprint on kanban cards)
- **CloudPRNT automatic printing (session 22):** Star TSP654II prints automatically, no tap required. Admin queues a `print_jobs` row; printer polls `cloudprnt` Edge Function every few seconds and prints Star Document Markup receipt. Configured via Admin → **Printer** (dedicated sidebar nav item). Falls back to browser popup when no token is set. `buildStarMarkup()` handles the full receipt layout including customer name, schedule, add-ons, invoice lines, barcode, and footer.

### Settings
- **Sidebar nav reorganized (session 23):** "Timezone" nav item renamed to **"Printer"** (printer icon) → shows only the Receipt Printer card. Business Timezone moved into **Routes → Settings tab** (new 3rd tab in the Maps/Routes page alongside Zones and Route Templates). Topbar CTA hides on the Settings tab (no action button needed there).

### New Order Modal
- **Pickup date bug fixed (session 23):** When admin picked an evening slot (e.g. 6–8pm PT on Mon Mar 16), the UTC ISO string (`2026-03-17T01:00Z`) caused `split('T')[0]` to return the next day (`2026-03-17`). This made the summary show "Tue Mar 17" and pushed the delivery calculation one day late. Fix: `selectNoDay()` now passes the local `iso` date explicitly as a 5th parameter to `selectNoSlot()`, bypassing UTC extraction entirely.

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
- Skip stop (with 12-second undo window, requires confirmation)
- **Realtime stop reassignment:** If admin reassigns a stop to another driver while they're en route, the stop disappears from the original driver's app with a toast. If a stop is newly assigned to a driver, their app triggers a reload to pick it up. Handles `driver_id = NULL` stops correctly (stop appears/disappears based on route ownership, not just explicit driver_id match).
- **Live GPS always current (session 24):** `_driverLat`/`_driverLng` module-level variables updated on every `watchPosition` fix — not throttled like the DB write. Always reflect the driver's actual current position for re-optimization.
- **Dynamic route re-optimization (session 24):** After marking any stop complete, failed, or skipped, `reoptimizeRoute(routeId)` fires automatically (non-blocking). Sends driver GPS to `optimize-route` edge function; re-orders pending stops from where the driver actually is; re-sorts `allStops` and re-renders the home screen. Silent fail — driver experience unaffected if optimization fails.
- **Phone OTP login (session 21):** Magic Link tab replaced with Phone Code tab. Two-step flow: enter phone → enter SMS code. E.164 normalisation handles 10-digit US numbers automatically. `link_phone_auth_driver` RPC re-points existing driver records to the new phone-auth UUID on first login — drivers don't lose their history. Requires drivers to have a phone number stored in their profile.
- **Later Today strip (session 29):** Upcoming routes (window > 2h away) shown as a collapsed strip at the bottom of the home screen rather than a full route card. Prevents drivers from seeing and acting on routes that aren't relevant yet. Tapping expands to preview route names and start times.
- **Stop detail — En Route stage (session 29):** Tapping "I'm On My Way" now keeps the driver on Phase 1 (showing a green "Customer notified" chip + Maps button + big green "I've Arrived" CTA). Previously jumped directly to bags/notes. Driver must tap "I've Arrived" to advance to the at-stop flow. Handles page reloads correctly — `en_route` status shows the en-route state, not bags.
- **Stop detail — Back button (session 29):** Photo screen (sub-phase 2) now has a "← Back" button that returns to bags/notes (sub-phase 1) so drivers can correct bag count or notes before completing.
- **Stop detail — Text Customer button (session 29):** "💬 Text Customer" SMS link shown in the customer section on all active stops with a phone on file. Opens the driver's native SMS app pre-filled with the customer's number.
- **Driver app design overhaul — "Jony Ive" pass (session 30, commit `a9b04a7`):** Full visual redesign. Unified all action blues to `var(--accent)` (removed 6 hardcoded `#1a73e8` instances). Simplified to 3 button levels: primary filled, skip/fail outlined, back/sms text links. Removed decorative noise: arrival chip, emoji, hint text, order# and service name rows from stop detail. Stop cards hide PICKUP/DELIVERY type badge for pending stops (only show status badges: Done/Skipped/Failed/En Route). Phone + SMS collapsed to one row in customer section. Phase 2 button order: Complete → Back (text link) → hairline separator → Skip → Fail. En-route chip changed from green to neutral gray. Dead `.btn-fail-stop` CSS removed.

---

## Customer App — Completed Features
- Full order booking flow: address lookup, pickup/delivery date & window selection, bag count, preferences, confirmation
- Same-day delivery toggle for AM routes (Berkeley AM, Oakland AM) — +$10 surcharge, PM delivery window locked automatically
- **Route-template turnaround enforcement (session 19):** Delivery windows are filtered by the pickup route template's `window_start` time. A PM pickup (template start ≥ 6pm) cannot show AM delivery slots on the next morning. `templateStartMins` added to window objects; `draft._earliestDeliveryWindowMins` tracks the floor. Three guard layers: window render filter, auto-select on date change, and final check in `placeOrder()`.
- **Sign-out button reset (session 19):** `loadAccount()` now resets the Sign Out button to its default state on every visit — prevents it staying stuck in "Signing out…" after a sign-in/sign-out cycle in the same browser session.
- Account management: name, email, password change, address book, laundry preferences, recurring plan, order history
- Customer-initiated skip button on recurring orders (pre-pickup only)
- Referral source captured at signup
- **Phone OTP login (session 20/21):** SMS code login via Twilio. `link_phone_auth_account` RPC (SECURITY DEFINER) re-points existing customer records to the new phone-auth UUID on first login — customers with existing email accounts don't lose their history. Multiple-account collision handled with a graceful error + auto sign-out.

---

## Design Principles

These are standing decisions that guide how features are built. When in doubt, defer to these.

| Principle | Rationale |
|---|---|
| **Automation over manual input** | Every time data needs to stay in sync across two places, use a DB trigger, RLS policy, or Edge Function — never require the admin to take an extra step. If adding a feature creates a new place where data could go stale, automate the sync before shipping. |
| **`driver_id` is the source of truth for route assignment** | `pickup_driver_id` / `delivery_driver_id` are legacy fields. App code always reads `driver_id`. RLS policies check both, but the trigger `trg_sync_route_driver` keeps the legacy fields cleared automatically. |
| **`driver_id = NULL` on stops means inherit from route** | Stops get `NULL` by default; explicit UUIDs are overrides only. All queries and RLS policies must handle both cases — never assume a non-null driver_id. |
| **Single-file SPAs, no build step** | All three apps are pure HTML/CSS/JS in one file. No npm, no bundler, no framework. Keep it that way. |
| **Time windows are client-side** | Route visibility (`isRouteVisible`, `isUpcomingRoute`) is computed in the browser using the device's local time. `window_start`/`window_end` in the DB are naive times (no timezone) interpreted as the driver's local timezone. |

---

## Terminology

We use **"Route"** for everything — both the template definition (e.g. "the Oakland AM route") and a specific dated instance (e.g. "the Oakland AM route on March 12"). We never say "run" in conversation or UI. The DB still has legacy column names like `run_date`, `pickup_run_id`, `delivery_run_id` — renaming those would touch hundreds of lines across all apps, so they stay as-is, but in all human-facing text and notes we say "route."

---

## Database Key Tables

| Table | Notes |
|---|---|
| `customers` | `phone_cache` stores phone in any format (e.g. `(415) 608-5446`) |
| `orders` | Status pipeline: scheduled → picked_up → processing → ready_for_delivery → out_for_delivery → delivered. (`ready_for_pickup` was removed session 6 — never auto-set, redundant.) `source`: scheduled, walk_in, customer_app, recurring. `cancelled_by`: 'customer', 'driver', 'admin', 'system' (nullable) — set on skip/cancel to distinguish who initiated |
| `route_templates` | Recurring route definitions: zone, schedule_days (0=Mon..5=Sat), window_start/end, turnaround_days, default drivers, stop_limit |
| `routes` | Dated route instances (auto-created from templates by `auto_route_order()`). Links to template_id, date, single `driver_id`. `pickup_driver_id`/`delivery_driver_id` columns exist but are not used by app code — auto-cleared by `trg_sync_route_driver` whenever `driver_id` changes, keeping RLS policies consistent |
| `route_stops` | Stops may have `driver_id = NULL` (inherits from parent route's `driver_id`) or an explicit UUID override. `trg_fill_stop_driver` auto-fills on INSERT. RLS policies handle both cases |
| `route_driver_schedule` | Per-day driver assignments: (template_id, day_of_week, driver_type) → driver_id. Sole source of truth for driver scheduling (no template defaults) |
| `driver_locations` | Live GPS: one row per driver (UPSERT on driver_id), updated every 12s from driver app. Realtime-enabled |
| `sms_messages` | All SMS in/out. `direction`: inbound/outbound. Linked to `customers` by phone matching |
| `driver_messages` | In-app admin ↔ driver chat (not SMS) |

### Key DB Functions & Triggers
| Object | Type | Purpose |
|---|---|---|
| `auto_route_order(p_order_id)` | Function | Matches order to template by zone+day+time, finds/creates the dated route, assigns driver, creates stops. Sets `routing_error` on orders if no match found |
| `trg_auto_route_new_order` | Trigger (AFTER INSERT on orders) | Fires for all new scheduled orders — sets routing_error for missing zone, calls auto_route_order for valid orders |
| `trg_create_recurring_order` | Trigger (AFTER UPDATE on orders) | On status → `delivered` OR `skipped` (when `cancelled_by = 'customer'`) with recurring_interval, creates next order. Bumps both pickup AND delivery off Sundays to Monday |
| `trg_sync_order_status` | Trigger (AFTER UPDATE on route_stops) | When all pickup stops → complete, order → `picked_up`. When all delivery stops → complete, order → `delivered` |
| `trg_fill_stop_driver` | Trigger (BEFORE INSERT on route_stops) | Auto-fills `driver_id` from parent route when stop is inserted with NULL driver |
| `trg_cascade_route_driver` | Trigger (AFTER UPDATE OF driver_id ON routes) | When admin reassigns driver on a route, cascades to all pending/en_route stops |
| `trg_sync_customer_cache` | Trigger (AFTER UPDATE on profiles) | Syncs `first_name`/`last_name` changes to `customers.first_name_cache`/`last_name_cache` |
| `auto_fail_expired_orders()` | Function (pg_cron every 30min) | Fails **`scheduled`** orders 2h past their window (session 6: no longer targets `ready_for_pickup`), sends SMS, stamps `cancelled_by = 'system'` |
| `trg_sync_stops_on_order_terminal` | Trigger (AFTER UPDATE on orders) | When order reaches terminal status, cascades to route_stops: delivered→complete, cancelled→skipped, pickup_failed→failed+skipped, skipped→skipped |
| `trg_route_stops_updated_at` | Trigger (BEFORE UPDATE on route_stops) | Auto-sets `updated_at = now()` on every route_stop write |
| `trg_sync_route_driver` | Trigger (BEFORE UPDATE OF driver_id ON routes) | When a route's primary driver changes, auto-clears `pickup_driver_id`/`delivery_driver_id` to NULL. Ensures RLS policies always derive driver access from `driver_id` — no manual cleanup needed when reassigning via the schedule |
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

**Update the Git Log section after every major commit or deploy.** Keep it current so future sessions can see the full history at a glance.

---

## ✅ Customer-Initiated Skips — Design Decision Resolved (session 5)

`cancelled_by` column is now fully implemented across DB, all three apps, and all skip/cancel paths.

| Who skipped | `cancelled_by` value | Appears in Issues? | Next recurring order? |
|---|---|---|---|
| Driver | `'driver'` | ✅ Yes | ❌ No |
| Customer (intentional skip) | `'customer'` | ❌ No | ✅ Yes — chain continues |
| Admin (manual intervention) | `'admin'` | ✅ Yes | ❌ No |
| Auto-fail cron | `'system'` | ✅ Yes | ❌ No |

### Entry points
- **Customer app:** "Skip this pickup" button on order detail — visible for recurring orders in skippable statuses. Sets `status = 'skipped', cancelled_by = 'customer'`.
- **Driver app:** `skipStop()` sets `cancelled_by = 'driver'`. Undo clears it back to null.
- **Admin:** `opSkipOrder()` (admin processing a customer request) sets `cancelled_by = 'customer'`. `opSetOrderStatus()` and `setSingleOrderStatus()` set `cancelled_by = 'admin'` for other terminal statuses.
- **SMS automation** (future Phase 2): when customer texts "skip Thursday", set same fields as above.

### Key behavior
- Issues tab excludes orders where `cancelled_by = 'customer'` — these are resolved, not actionable.
- `trg_create_recurring_order` now fires on `skipped` **only when `cancelled_by = 'customer'`** — ensures subscription chain continues for intentional customer skips.
- `billing_status = 'failed'` orders always surface in Issues regardless of `cancelled_by`.

---

## Known Issues (found, not yet fixed)

| # | Severity | Where | Symptom |
|---|----------|-------|---------|
| 1 | ~~P2 → Fixed~~ | `route_stops` | ~~Stops stay `pending` when order reaches `delivered` or `pickup_failed` via admin~~ — **FIXED session 3**: DB trigger `trg_sync_stops_on_order_terminal` now cascades order terminal status to route_stops. Backfill ran on all existing orphaned stops. |
| 2 | ~~P2 → Fixed~~ | `route_stops` | ~~Cancelled orders retain their pending route stops~~ — **FIXED session 3**: Same trigger handles `cancelled` → stops set to `skipped`. Hard deletes handled by existing FK CASCADE DELETE. |
| 3 | P2 Medium | admin `saveOrder()` | Admin-created orders always saved with `total_amount = 0` — intentional (price set at intake/weigh) but skews revenue reports. Estimated price shown in form is not persisted anywhere |
| 4 | P2 Medium | `confirmReassignDriver` | ~~Order Schedule map/list stays stale after reassignment — **FIXED commit 7916331**~~ |
| 5 | P3 Low → Likely non-issue | processing kanban | Price recalculated at rack step doesn't match original order total — order #84 stored $164.95 but processing showed/saved $139.95. **Investigated session 3:** `saveIntake()` correctly writes `bd.total` from `calcProcTotal()`. `saveRacking()` does NOT update `total_amount`. Discrepancy on order #84 was a legacy/pre-existing test value — not a code bug. Monitor real orders to confirm. |
| 6 | ~~P3 → Fixed~~ | `route_stops` DB | ~~`updated_at` column not refreshed on driver reassignment or status changes~~ — **FIXED session 4**: DB trigger `trg_route_stops_updated_at` (BEFORE UPDATE) now auto-sets `updated_at = now()` on every write. Migration `route_stops_auto_updated_at` applied. |
| 7 | P0 → Fixed | driver app realtime handler | ~~Stops reassigned to another driver stayed in original driver's list — **FIXED commit 7916331**~~ |
| 8 | ~~P3 → Fixed~~ | driver app "skip notification" | ~~Banner read "Customer notified · Safe travels!" even when no SMS was sent~~ — **FIXED commit 0930719**: `notified` flag now checks only `stop.on_my_way_sent_at`, not `isEnRoute`. Banner correctly shows "Arrived at stop" when driver skipped notification. |
| 9 | ~~P0 → Fixed~~ | `send-sms`, `notify-on-my-way` edge functions | ~~Hardcoded Twilio auth token as `\|\| 'cdfc2502...'` fallback~~ — **FIXED session 8**: Token rotated in Twilio. Both functions redeployed reading from Supabase Secrets only. `create-test-user` unauthenticated endpoint also neutralized (returns 404). |
| 10 | ~~P0 → Fixed~~ | RLS — `customer_payment_methods` | ~~Policy `cpm_anon_all` grants ALL to anon.~~ **FIXED session 21b** (migration `rls_security_hardening`): `cpm_anon_all` dropped. Only `cpm_auth_all` (authenticated) remains. |
| 11 | ~~P0 → Fixed~~ | RLS — `sms_messages` | ~~`anon_all_sms_messages` exposes all SMS conversations to anyone.~~ **FIXED session 21b**: Policy dropped. Only `admin_all_sms_messages` (is_admin()) remains. Edge functions use service role. |
| 12 | ~~P1 → Fixed~~ | RLS — `customers` | ~~`anon_write_customers` + `Admin anon read customers` — unauthenticated read/write of all customer PII.~~ **FIXED session 21b**: Both dropped. Scoped per-customer + admin policies remain. |
| 13 | ~~P1 → Fixed~~ | RLS — `orders` | ~~`anon_write_orders` + `Admin anon read orders`.~~ **FIXED session 21b**: Both dropped. Scoped per-customer, per-driver, and admin policies remain. |
| 14 | ~~P1 → Fixed~~ | RLS — `discounts` | ~~`anon_all_discounts` — anyone could create or delete discount codes.~~ **FIXED session 21b**: Replaced with `anon_read_discounts` (SELECT only). `admin_all_discounts` handles writes. |
| 15 | ~~P1 → Fixed~~ | RLS — `settings` | ~~`anon_all_settings` — anyone could modify business config.~~ **FIXED session 21b**: Replaced with `anon_read_settings` (SELECT only). `admin_all_settings` handles writes. |
| 16 | ~~P2 → Fixed~~ | RLS — `driver_locations` | ~~Anyone could spoof driver GPS coordinates.~~ **FIXED session 21b**: Replaced with `authenticated_read_driver_locations` (SELECT) + `driver_insert_own_location` + `driver_update_own_location` (scoped to own driver_id). |
| 17 | ~~P2 → Fixed~~ | RLS — `message_templates` | ~~`anon_all_message_templates` — anyone could edit SMS templates.~~ **FIXED session 21b**: Dropped. `admin_all_message_templates` + edge functions (service role) cover all access. |
| 18 | ~~P2 → Fixed~~ | RLS — `route_driver_overrides` | ~~`Allow all access` with no conditions.~~ **FIXED session 21b**: Replaced with `admin_all_route_driver_overrides` + `auth_read_route_driver_overrides`. |
| 19 | ~~P2 → Fixed~~ | Google Maps API key | ~~Key `AIzaSyDfIiB3LFbbxiT4szPgpv_jdseTa4HCrEc` unrestricted in customer app source.~~ **FIXED session 21b**: David restricted key to `*.washroute.vercel.app/*` referrer in GCP Console on 2026-03-16. |
| 20 | ~~Fixed~~ | RLS — 10 additional tables | ~~Broad anon write/read on `routes`, `route_stops`, `addresses`, `profiles`, `drivers`, `driver_messages`, `route_templates`, `preferences`, `notifications`, `cs_issues`, `conversations`, `launderers`, `racks`, `order_items`, `subscriptions`, `customer_transactions`, `services`, `service_fees`, `service_categories`~~ **FIXED session 21b**: All anon write policies dropped; scoped authenticated policies retained. Migrations: `rls_security_hardening`, `rls_security_hardening_services_v2`. |

---

## Session Log

### Mar 15, 2026 (session 12) — Processing intake UX + order data sync fixes

- **Standardized intake panel button sizes (commit `6064ad7`):** All `.proc-addon-btn` buttons now have a fixed `width: 120px; box-sizing: border-box` so Customer Add-on chips (Vinegar, Oxi) and Service add-on buttons (Air Dry, Shirt Service) are identical in size. Each service card is wrapped in a `120px` flex-column container so the QTY stepper (`− 1 +`) is constrained to that same width and can't overflow. Removed the "Qty" label from steppers — the `−` / `+` controls are self-explanatory.

- **Admin Details tab now shows actual line_items from processing (commit `6064ad7`):** `opRecalcEstimate()` previously recalculated from scratch (bags × price + delivery + same-day) and ignored any add-on services or overage charges saved during processing intake. It now pulls all extra line items from `o.line_items` (types `addon_service`, `addon`, `overage`) and displays them alongside the live-calculated base/fees. Total label changes from "Estimated Total" → "Total" once real processed data is present. Base bag count and same-day toggle are still live-editable.

- **Realtime handler refreshes Details and Billing tabs (commit `6064ad7`):** When the processing queue saves updated `total_amount` and `line_items` to the DB, Supabase Realtime fires an UPDATE event. The admin realtime handler now calls `opRecalcEstimate()` and `opPopulateBilling()` when the open order panel matches — so charges appear instantly without requiring a panel close/reopen.

- **Fixed duplicate "Yes" rows in processing intake breakdown (commit `f6a3e3e`):** `renderBreakdownRows()` was emitting both a `price_mod` row (label "Yes") and a linked service row ("Vinegar × 2 bags") for the same preference, causing duplicate charges. `calcProcTotal()` was also double-counting these. Fixed both: any preference group that has a linked service in `allAddonServicesCache` now skips the `price_mod` line — only the linked service line (with correct bag × price calculation) appears.

- **Fixed `procIsSameDay` and `opIsSameDay` same-day detection (commit `f6a3e3e`):** Both the admin order panel and the processing intake were using `.slice(0,10)` on UTC timestamps to compare pickup vs delivery dates. This fails for PM slots (e.g., 6pm Pacific = 01:00 UTC next day — UTC date shows wrong day). Fixed both to use `toLocaleDateString('en-CA', { timeZone: BIZ_TZ })` for accurate Pacific-time date comparison.

- **Fixed order data sync across views (commit `15f89eb`):** Processing queue's `loadProcessing()` was missing key fields from its SELECT — `pickup_window_start`, `delivery_window_start`, `total_amount`, `line_items` — so `procIsSameDay` was always false and same-day surcharges were never applied during intake. Added those fields. `openIntakePanel()` now fresh-fetches the order from DB on panel open and patches the cache with the live data. Customer app detail screen now re-renders in-place via `openDetail()` when a realtime order update fires while that order is open.

- **Next session priorities:**
  1. ~~Receipt printing~~ ✅ Done session 13
  2. Add `price_mod` for Double Wash and remaining add-on prefs
  3. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16

---

### Mar 15, 2026 (session 13) — Thermal receipt printing + intake UX polish

- **Thermal receipt printing — 2 copies auto-print on intake save (commit `58f8a18`):** `_openReceiptWindow(data, copies, win)` builds a full 80mm thermal receipt: business header, customer name + address, order # + "2 BAGS · 27 LBS", schedule box with pickup/delivery dates and Stop · Route (fetched from `route_stops` joined to `routes`), add-on tags section (bordered chips from `addon_service` line items), invoice section (filtered to `base`/`overage`/`addon_service` types only — raw "Yes"/"Hot" `addon` items excluded), subtotal/delivery fee/credit breakdown, Amount Due in large type, CODE128 barcode via JsBarcode CDN. Two copies rendered side-by-side (screen) / separated by `page-break-after: always` (print).

- **Popup blocking fix:** `window.open()` is called *before* any `await` in `saveIntake()` so browsers don't block it as a non-gesture popup. The pre-opened window reference is passed through `_autoPrintIntake(lineItems, bd, printWin)` → `_openReceiptWindow()`. If the DB save fails, the orphaned window is closed via `printWin.close()`. The order panel 🖨 Print button (`printBagTag()`) opens the popup synchronously before its async route stop query. If popups are blocked by browser settings, a toast is shown.

- **Receipt line item filtering:** Only `base`, `overage`, `addon_service` types appear in the invoice body. `delivery_fee`, `same_day_surcharge`, and `credit` types appear as their own totals rows below. This eliminates the "Yes"/"Hot" noise from `addon` items that previously inflated receipts.

- **Receipt weight display:** Format is "2 BAGS · 27 LBS" — bags first (more natural), weight always shown (falls back to "— LBS" if not yet recorded).

- **Special instructions in intake panel (commit `58f8a18`):** `renderIntakePanel()` now renders a "Special Instructions" textarea between the add-on prefs and price breakdown sections. Pre-filled from `procNotes` (loaded from `order.special_instructions` on panel open — same DB field the customer fills in at booking). Editable before save; changes persist to `special_instructions` on the order. `procNotes` is updated via `oninput` so re-renders (triggered by bag/weight/addon changes) preserve any edits.

- **Weight displayed across admin views (commit `58f8a18`):** Orders table "Bags" column now shows bag count bold + lbs in grey below (e.g. **2** / 27 lbs) when weight is available. Order panel Details tab gains a read-only "Weight" row (hidden until the order has been weighed at intake) displayed below the editable "Bags" input. Customer panel order rows already showed weight via `cpOrderMeta()` — no change needed.

- **Next session priorities:**
  1. ~~Email receipt fixes~~ ✅ Done session 14
  2. ~~Kanban reprint button~~ ✅ Done session 14
  3. Add `price_mod` for Double Wash and remaining add-on prefs
  4. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  5. SMS/email automation Phase 1 — status check auto-replies ("Where's my driver?")

---

### Mar 15, 2026 (session 14) — Email receipt fixes + kanban reprint buttons

- **Email receipt auto-sent on intake save (commit `fb808eb`):** `saveIntake()` now fires a fire-and-forget `fetch` to `send-receipt` edge function immediately after the DB save succeeds. Uses the already-captured `movedId` (safe — `closeIntakePanel()` runs after, so `procActiveOrder` is still valid when the ID is captured). Silent fail: if the customer has no email or SendGrid fails, it logs a warning and doesn't block the intake flow.

- **Email receipt — YES/YES noise fixed + weight added (`send-receipt` edge function v12):** `buildEmailHtml()` now filters `chargeItems` to only `base`, `overage`, `addon_service`, `delivery_fee`, `same_day_surcharge` types — same logic as the print receipt fix from session 13. Raw `addon` preference labels ("Yes", "Hot", etc.) are excluded. Also added `total_bags` and `weight_lbs` to the Supabase select, with a compact "2 bags · 27.0 lbs" summary line shown just below the receipt number.

- **`printBagTag()` accepts optional orderId for kanban reprints (commit `fb808eb`):** Signature changed to `printBagTag(overrideOrderId)`. When called with an ID, looks up the order across all caches (`allOrders`, `allCleanOrders`, `allFoldOrders`, `allProcOrders`). Falls back to `allCustomers` lookup first, then uses embedded `o.customers` join data — needed because kanban caches don't include `customer_id` as a top-level field (only the nested join). Route stop query also uses `targetId` instead of `opCurrentOrderId`. No-arg calls from the order panel 🖨 Print button are unchanged.

- **🖨 Reprint button on Cleaning + Folding kanban cards (commit `fb808eb`):** Each card in the Cleaning and Folding columns now has a small "🖨 Reprint" link at the bottom-left, alongside the existing "← undo" link on the right. Calls `printBagTag(orderId)` with `event.stopPropagation()` so it doesn't open the fold/rack panel.

- **Next session priorities:**
  1. ~~UX audit + top 5 fixes~~ ✅ Done session 15
  2. Add `price_mod` for Double Wash and remaining add-on prefs
  3. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  4. SMS/email automation Phase 1 — status check auto-replies ("Where's my driver?")

---

### Mar 15, 2026 (session 15) — UX audit + 5 high-impact fixes

- **Full UX audit across all 3 apps:** Identified top 5 high-impact issues — duplicate order risk, silent server error, batch button races, low-contrast completed stops, unclear disabled slots.

- **Fix 1 — Customer app: double-tap protection on Place Order (commits `b57c997`, `c99d756`):** `placeOrder()` now disables `#btn-place` and sets text to "Processing…" as the very first line, before any validation. Validation failures re-enable the button with the correct label (logged-in vs guest path). Prevents duplicate order creation on slow connections.

- **Fix 2 — Driver app: `sendOnMyWay()` now checks `res.ok` (commit `b57c997`):** Added `if (!res.ok) throw new Error(...)` immediately after `await res.json()`. Previously, a server 500 would silently treat the "On My Way" notification as sent and advance the driver to Phase 2 — customer was never notified but driver was stuck in "en route" state.

- **Fix 3 — Admin: batch Advance + Delete buttons disabled during async loop (commit `b57c997`):** `batchAdvanceStatus()` and `batchCancelOrders()` now disable both batch buttons (`#batch-advance-btn` and `.batch-bar-btn.danger`) at the start of the operation and re-enable on completion. Prevents double-tap mid-loop which could have fired duplicate DB writes.

- **QA catch — delete button icon destroyed on RPC failure (commit `c99d756`):** `batchCancelOrders()` was setting `_delBtn.textContent = 'Deleting…'` which wiped the SVG trash icon. On RPC error, the batch bar stayed visible with a broken button. Fixed by removing the textContent change — opacity/disabled alone is sufficient feedback.

- **Fix 4 — Driver app: completed stop cards now use background color (commit `b57c997`):** Replaced `.stop-card.done { opacity: 0.55 }` with `background: #f3f4f6; border-color: #d1d5db` and muted text colors on `.stop-name` / `.stop-meta`. Opacity-based dimming was unreadable on mobile in sunlight; background-color change is clearer and more accessible.

- **Fix 5 — Customer app: `sched-opt` disabled state CSS (commit `b57c997`):** Added `.sched-opt:disabled, .sched-opt.unavailable { background: gray-50; color: gray-300; border: gray-100; cursor: not-allowed; text-decoration: line-through }`. Currently slots are pre-filtered and hidden when past cutoff, but this CSS ensures any future "show but disable" behavior renders correctly — and suppresses `:active` tap highlight on disabled slots.

- **How did you find us? — referral source added to customer signup (commit `19453bb`):** Both the standalone signup form and the inline checkout account creation now include a "How did you find us?" dropdown. 10 source options: Nextdoor, Yelp, Google Search, Friend/Family, Instagram, Roots & Soul, Oakland Ballers, I Saw Your Van!, ChatGPT/AI, Other. `ensureProfile()` updated to accept `referralSource` param — sets on new insert; patches orphaned profiles only if they have no existing value. Admin customer panel also updated with matching options for manual entry.

- **All commits this session:** `19453bb`, `b57c997`, `c99d756`

- **Next session priorities:**
  1. ~~Add Double Wash price_mod~~ ✅ Done session 16
  2. ~~SMS automation Phase 1~~ ✅ Done session 16
  3. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16

---

### Mar 16, 2026 (session 25) — Route Command Center (RCC)

- **Route Command Center built into admin dashboard (commit `28c33c1`):** Completely replaced the old zone-pill / AM-PM Order Schedule with a new full-screen interface. The `orders-schedule-view` container is now a flex column: date bar → chip strip (`#rcc-chips`) → workspace (map pane left, columns panel right).

- **Chip strip:** `rccRenderChips()` renders one chip per route template for the selected date. Chips show route color dot, name, time window, and stop count badge. Active chips get the `rcc-on` class + `--rcc-color` CSS variable for per-chip theming. Clicking an inactive chip calls `rccToggleRoute(routeId)` which fetches stops + addresses async and opens the column. Clicking an active chip closes it.

- **Draggable columns:** `rccRenderColumns()` builds one `.rcc-col` per active route. Column header: driver initials avatar (route color background), driver name, route name, P/D/total stop counts, completion progress bar. Column body (`.rcc-body`, scrollable flex) contains `rcc-popin` animated stop cards. Close button (×) at top-right deactivates the route.

- **Stop cards (`rccBuildCard`):** 3-color design: route-colored `.rcc-stop-num` circle (position:absolute left:8px), dark `.rcc-card-name`, gray `.rcc-card-addr` + `.rcc-card-foot`. P/D type badge uses blue tint for pickup, gray for delivery. ✓/✗ status marks for complete/failed/skipped. Click flies map to pin. Hover highlights map pin via existing `highlightStopPin`.

- **Drag-and-drop reassignment:** `rccDragStart` → `rccDragOver` → `rccDrop`. On drop: optimistic local state mutation (splice stop from source, push to dest) → `rccRenderColumns()` + `rccRenderMap()` + `rccRenderChips()` immediately → async DB write (`route_stops.route_id` + `stop_number` + `routes.total_stops` on both) → `autoOptimizeRoute` on both routes → silent error toast if DB write fails.

- **Map:** `rccRenderMap()` clears all `_isStopLayer` layers and redraws polylines + numbered pins for every active route. Colors per route, stop_number shown on pin. Legend overlay (`#rcc-legend`) shown when 2+ routes are open. `rccUpdatePanelWidth()` sets panel width to `min(n × 290px, 55vw)` and calls `routeLiveMap.invalidateSize()` after the CSS transition.

- **Optimize button:** Now calls `optimizeRoute()` which iterates `[..._rccActiveRoutes]` and fires the edge function for each, then calls `rccRefreshRoute` on all. Hidden when no routes are open.

- **`autoOptimizeRoute` updated:** Now checks `_rccActiveRoutes.has(routeId)` instead of `routeLiveRouteId === routeId` and calls `rccRefreshRoute(routeId)` on success.

- **Realtime handler updated:** Stop completion/skip events now call `rccRefreshRoute(stop.route_id)` if the route is open, instead of the old `selectRunOnMap` pattern.

- **QA fixes caught during review:**
  - `display:none;display:flex` double inline style on `orders-schedule-view` — second value always won; `switchOrdersView` setting `style.display = ''` would then show the container as `block` not `flex`. Fixed by removing the inline `display:flex` and updating `switchOrdersView` to set `display = 'flex'`.
  - `min-height:0` added to `.rcc-body` for correct flex overflow scrolling within the column.

- **Commit:** `28c33c1`

- **Next session priorities:**
  1. Test RCC in browser with real data — open 2+ routes, drag a stop, verify DB update + re-optimization
  2. Test CloudPRNT end-to-end with physical printer on-site
  3. Xero accounting sync (backlog)

---

### Mar 17, 2026 (session 30) — Driver first name in SMS + notification blast-radius fixes

- **Driver name personalization in "On My Way" SMS (commit `62657b0`):** Updated `driver_on_way_pickup` and `driver_on_way_delivery` templates in `message_templates` DB to use `{{customer_first_name}}` and `{{driver_first_name}}` tags. Example: "Hi Sarah! Davey is on the way to pick up your laundry…" instead of the generic "Family Laundry Update: your driver is on the way…"

- **`notify-on-my-way` v20 — template-driven + driver first name:** Rewrote edge function to read message body from `message_templates` table (was hardcoded). Supports `{{customer_first_name}}`, `{{driver_first_name}}`, `{{action_word}}` interpolation. Driver app previously passed full name (`David Macquart-Moulin`); fixed `sendOnMyWay()` to pass only `currentProfile?.first_name`.

- **`send-scheduled-reminders` v11 — morning reminder timing fix:** `runDayOf()` used `pickup_window_start >= now` which missed pickups whose window started exactly at cron fire time (7am cron, 7am window → `>= now` at 14:00:03 UTC, window_start = 14:00:00 UTC). Fixed to `pickup_window_end >= now` so any order whose window hasn't closed yet is included.

- **`send-order-notification` v15 — blast radius fix for driver name (commit `62657b0`):** QA caught that `send-order-notification` also fires the `driver_on_way_delivery` template (when admin advances `out_for_delivery` status) but had `driver_first_name: ''` in its vars. SMS would read "Hi Sarah! is on the way with your clean laundry…". Fixed: function now fetches the delivery stop's assigned driver (explicit `driver_id` or route default) and populates `driver_first_name` from their profile. Also added `customer_first_name` as an alias for `first_name` for consistency. v15 deployed.

- **Admin Notifications merge tags updated:** Replaced `{{driver_name}}` (was populated as empty string) with `{{driver_first_name}}` and `{{customer_first_name}}` in the tag picker. Old templates using `{{driver_name}}` still work (maps to same value via `driver_name` alias in the vars object).

- **Fix: "Est. Delivery" → "Delivery" in confirmation emails (commit `17b2122`):** Label updated in both the customer app booking confirmation email and the admin dashboard "New Order" email.

- **Fix: pickup_failed SMS never sending (commit `5c294ea`):** Driver app was passing `order_id` (snake_case) to `send-order-notification` but the edge function expects `orderId` (camelCase). The "Pickup Failed" SMS had silently never sent since the feature was built. Fixed to `orderId`.

- **Driver app design overhaul — "Jony Ive" pass (commit `a9b04a7`):** Full visual redesign requested with emphasis on "less colors, only relevant information, same-size buttons, compact, beautiful." QA pass found one Low issue (dead `.btn-fail-stop` CSS) which was fixed before commit. Changes:
  - Unified all action blues to `var(--accent)` — removed 6 hardcoded `#1a73e8` values
  - Button hierarchy: primary filled → outlined skip/fail → text link back/sms (3 levels vs previous 10+)
  - Stop cards: removed PICKUP/DELIVERY type badge for pending stops; neutral gray map icon (was blue)
  - Stop detail customer section: removed redundant name row (name is in header); collapsed phone + SMS into one row
  - Stop detail order section: removed order # and service name rows; kept only bag count + preference tags
  - Phase 1 (pre-arrival): removed 📲 emoji, removed hint text; simplified "Skip notification" → "I'm already here"
  - Phase 1 (en-route): en-route chip changed from green (#f0fdf4) to neutral gray; removed ✅ emoji and hint text from "I've Arrived"
  - Phase 2 both sub-phases: removed arrival chip entirely; Maps link moved to bag section title as small ↗ text link (sub-phase 1 only)
  - Phase 2 sub-phase 2: reordered buttons (Complete first, Back as text link, separator, Skip, Fail); Fail unified to skip style with red overrides

- **Next session priorities:**
  1. Test full stop detail flow end-to-end as Davey Crockett (en route → I've Arrived → bags → photo → complete)
  2. Investigate `optimize-route` v12 stop reordering issue (from session 28)
  3. Test CloudPRNT with physical printer

---

### Mar 17, 2026 (session 29) — Driver app stop detail overhaul + RLS driver fix

- **Stop detail — En Route intermediate stage (commit `a2c40f5`):** "I'm On My Way" no longer auto-advances to bags/notes. Driver stays on Phase 1 with a green en-route chip, Maps button, and a prominent "I've Arrived" CTA. `openStop()` always starts at Phase 1 — QA caught that the old auto-advance to Phase 2 for `en_route` stops would skip the arrival screen if a driver closed and reopened a stop mid-drive.

- **Stop detail — Back button on photo screen (commit `a2c40f5`):** Sub-phase 2 (photo) now has "← Back" to return to sub-phase 1 (bags/notes). `prevSubPhase()` function added.

- **Stop detail — Text Customer SMS button (commit `a2c40f5`):** "💬 Text Customer" link added to customer section on all active stops with a phone. Opens native SMS app. Shown only on active (not completed/skipped/failed) stops.

- **Home screen — Later Today strip:** Upcoming routes shown collapsed with route names + start times. Only routes within the 2-hour pre-window show as full cards.

- **Home screen — removed Next Stop section:** Home only shows route summary cards. Spacing and top padding increased.

- **RLS fix — driver_id IS NULL stops invisible (migration `fix_driver_rls_null_driver_id`):** Root cause: `driver_read_assigned_orders`, `driver_update_assigned_orders`, and `driver_update_assigned_stops` policies only matched stops with an explicit `driver_id`. Stops with `driver_id = NULL` (inheriting from route) were silently blocked. Drivers saw "No Stops Today" even with correctly assigned routes. Fixed all three policies to add `(rs.driver_id IS NULL AND r.driver_id = current_driver_id())` branch.

- **Automation trigger — trg_sync_route_driver (migration `trg_sync_route_driver_on_reassign`):** DB trigger that fires BEFORE UPDATE on `routes`. When `driver_id` changes, auto-clears `pickup_driver_id`/`delivery_driver_id` to NULL. Prevents stale legacy fields from blocking RLS checks after any schedule reassignment — no admin manual cleanup needed.

- **Admin fix — rccMoveStop resets driver_id to NULL:** When dragging a stop between routes in the RCC, `driver_id` is now explicitly reset to NULL so the stop inherits the destination route's default driver rather than keeping the old explicit assignment.

- **Design principle added:** Always prefer automation triggers over manual process. When data needs to stay in sync, use DB triggers/RLS — never require an extra admin step.

- **Next session priorities:**
  1. Test full stop detail flow end-to-end as Davey Crockett (en route → I've Arrived → bags → photo → complete)
  2. Investigate `optimize-route` v12 stop reordering issue (from session 28)
  3. Test CloudPRNT with physical printer

---

### Mar 16, 2026 (session 28) — RCC time-window section dividers

- **RCC column split by 2-hour booking window (commit `51cc2b8`):** Routes with `arrival_window_hours > 0` (e.g., Berkeley PM with 2-hour slots) now display a labelled section header between each time window group in the RCC column. Example: Berkeley PM shows a "6–8 PM" divider above the 6–8 PM customers and an "8–10 PM" divider above the 8–10 PM customers. Stops within each section remain in their original `stop_number` order.

- **Implementation details:** `arrival_window_hours` added to the `_dsTemplates` SELECT in `loadDailyRuns()`. In `rccRenderColumns()`, stops are grouped by extracting the UTC hour+minute from `orders.pickup_window_start` (or `delivery_window_start` as fallback). Unique UTC-minute buckets are sorted ascending; each maps to a local-time slot label computed from the template's `window_start` + `arrival_window_hours`. Label format: `"6–8 PM"`, `"8–10 PM"` etc. Routes with only one time window (or `arrival_window_hours = 0`) fall through to the original plain render with no dividers — no regression. CSS class `.rcc-window-divider` added; `.rcc-first-div` removes top margin on the first divider per column.

- **No template changes** — David confirmed templates are correctly structured (6–10 PM, 2-hour slots). This was a pure front-end display enhancement.

- **Next session priorities:**
  1. Investigate why `optimize-route` v12 isn't reordering stops (Marcus=1, Priya=2, Sam=3, Alex=4, Jake=5 unchanged). Google may be returning the same waypoint_order as input; may need more detailed edge function logging or a direct DB check immediately after an optimize press.
  2. Test CloudPRNT end-to-end with physical printer

---

### Mar 16, 2026 (session 27) — Route optimization fix + RCC map visualization

- **`optimize-route` v12 — geographic-extremes algorithm (commit `f242eda`):** Replaced the fixed-endpoint approach (pin stop #1 as origin, last stop as destination by stop_number order) with a geographic-extremes method. Northernmost and southernmost stops (by actual latitude) become the natural endpoints. Two Google API calls are made (N→S and S→N direction), and the shorter total road distance wins. Also extracted a shared `callGoogle()` helper for cleaner code. Fixes U-shaped routes that occurred when stop_number endpoints happened to be in the same geographic area (e.g., two north Berkeley stops as start/end forcing a south-sweep-and-return). v11 (circular trick) was also tried but produced same ordering in some cases; v12 geographic approach is more reliable.

- **RCC map — separate pickup/delivery polylines (commit `f242eda`):** The RCC map now draws pickups and deliveries as two distinct polylines (solid for pickups, dashed for deliveries), each sorted by their own `stop_number`. Previously all stops were merged into one combined polyline which always looked tangled regardless of route quality. Pin deduplication preserved — same-address stops (customer with both pickup and delivery) show one pin with a "📦 pickup + 🏠 delivery" popup note.

- **RCC — reassignment badge via DB (commits `f237ef9`, `95f2917`):** Added `moved_from_route_id` UUID column (FK, ON DELETE SET NULL) to `route_stops`. Badge data now persists in the DB instead of `localStorage` — consistent across all browsers and users. Logic: set on first drag to a different route; cleared if stop is moved back to its original route. Badge shows the route COLOR + name it came from. SELECT queries updated to fetch `moved_from_route_id` in both `rccToggleRoute` and `rccRefreshRoute`.

- **RCC — ghost stops filtered (commit `9233254`):** Added `'skipped'` to the order status exclusion filter in 3 places. Deleted 20 dangling `route_stops` rows whose linked orders had status `skipped` (cancelled orders that weren't cleaned up). Renumbered remaining stops sequentially using `ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY stop_number)`. Fixed misassigned stop (Alex Rivera was on Oakland PM, moved to Berkeley PM).

- **Orders table — Pickup/Delivery Route sort fixed (commit `257a043`):** Added missing `case 'pickup_run_id'` and `case 'delivery_run_id'` branches to the sort switch in `renderOrders()`. Now sorts alphabetically by route name (lowercased) from the joined `pickup_run`/`delivery_run` objects.

---

### Mar 16, 2026 (session 26) — RCC polish: AM/PM toggle, header swap, drag-and-drop fix

- **AM/PM pill toggle added to chip strip (commit `4ee5217`):** Small segmented control rendered at the left edge of `#rcc-chips`. State stored in `_rccSlot` (`'AM'|'PM'`). Auto-selects based on current hour (`< 12 → AM`) on first `loadDailyRuns()` call; persists user choice when navigating between dates. `rccRenderChips()` filters `_dsTemplates` by slot before rendering chips: AM = `window_start < 12`, PM = `window_start >= 12`. Templates with no `window_start` always show. `rccSetSlot(slot)` closes any currently-open columns whose routes belong to the other time window, then re-renders everything.

- **Column header layout swapped:** Route template name is now the large primary heading; driver name sits underneath as the gray subtitle. Previously it was the other way around. Drop hint also updated to say the route name instead of driver name.

- **Drag-and-drop reassignment fixed:** The previous `ondragleave="this.classList.remove('rcc-drop-over')"` inline handler fired every time the cursor entered a child element (a stop card, text, etc.), making the column lose its drop highlight and breaking the visual feedback. Fixed by replacing with `rccDragLeave(event)` which checks `event.currentTarget.contains(event.relatedTarget)` before removing the class. Also added `ondragover`/`ondrop` directly on `.rcc-body` (scrollable card area) so drops work even when the cursor is over a card rather than empty column space. Added `event.stopPropagation()` to both `rccDragOver` and `rccDrop` to prevent double-firing when both `.rcc-col` and its child `.rcc-body` handle the same event.

- **QA catch:** `rccDrop` was using `event.currentTarget` to clear `.rcc-drop-over`, but `currentTarget` could be `.rcc-body` after the body handler was added. Fixed with `event.currentTarget.closest('.rcc-col') || event.currentTarget`.

---

### Mar 16, 2026 (session 24) — Dynamic route re-optimization system

- **`optimize-route` Edge Function v10 deployed:** Enhanced to accept optional `driver_lat`/`driver_lng` in request body. Separates stops into `done` (complete/failed/skipped) and `pending` per group (pickups and deliveries handled independently). Only pending stops are passed to Google Maps for re-ordering. Done stops keep their original `stop_number` values; pending stops are renumbered starting from `maxDone+1`. When driver GPS provided: driver position is origin, last pending stop is fixed destination, all other pending stops are reorderable waypoints. When no GPS: first pending stop is fixed origin, last is fixed destination, middle stops are reorderable. Returns `driver_origin_used: boolean`.

- **Admin — `autoOptimizeRoute(routeId)` helper added:** Silent fire-and-forget function. Calls `optimize-route` edge function with no spinner, no toast. If the user currently has the optimized route open in the Order Schedule view, it refreshes automatically. Hooked into **4 trigger points**: `opSaveRouteAndSlot` (schedule picker), new order creation (`saveOrder`), and `confirmMoveStop` (both source and destination routes).

- **Driver app — GPS position always current:** Added `_driverLat` / `_driverLng` module-level variables. Updated on *every* `watchPosition` callback fix — *before* the 12-second DB-write throttle check. Ensures re-optimization always has a fresh position even between DB writes.

- **Driver app — `reoptimizeRoute(routeId)` added:** Async function called automatically (non-blocking) after `completeStop`, `failStop`, and `skipStop`. Sends current driver GPS to `optimize-route` edge function. On success: re-fetches `stop_number` values from DB, patches `allStops` in-place, re-sorts by stop_number, and re-renders the home screen. Silent fail — driver sees their current stop list unchanged if optimization fails or network is slow. Skipped for `completeStop` when route status is already `complete` (no pending stops to re-order).

- **QA blast-radius fixes:** Found and fixed two additional places that insert route stops without triggering optimization — new order creation and `confirmMoveStop`. All 4 stop-insertion paths now consistently trigger `autoOptimizeRoute`.

- **Commit:** `fd781d8`

- **Next session priorities:**
  1. Test CloudPRNT end-to-end with physical printer on-site
  2. Route picker fine-tuning (backlog)
  3. Xero accounting sync (backlog)

---

### Mar 16, 2026 (session 23) — Settings reorganization, New Order date bug fix

- **Settings nav reorganized (commit `b795b92`):** "Timezone" sidebar nav item renamed to **"Printer"** with a printer icon — shows only the Receipt Printer configuration card (server URL, token, Save, Test Print). Business Timezone moved into a new **Settings** tab inside the Routes/Maps page (alongside existing Zones and Route Templates tabs). The topbar CTA button hides itself on the Settings tab since there's no relevant action. `renderMapsSettingsTab()` added to render the timezone card on demand; `setMapsTab()` updated to handle the new tab.

- **Safe git commit helper (commit `c82e3b2`):** Created `.git-commit.sh` at repo root — the correct bindfs FUSE workaround. Seeds a temp index with `git read-tree HEAD` before adding changed files, guaranteeing the full tree is included in every commit. Prevents the sparse-tree bug that caused the site outage. **Always use this script for commits on this machine.** Usage: `./.git-commit.sh "message" file1 file2 ...`

- **Bug fix — New Order pickup date off by one day for evening slots (commit `ef58ceb`):** When admin picked e.g. 6–8pm on Mon Mar 16 (PT), `buildSlots()` stored the window as `2026-03-17T01:00Z` (UTC). Then `selectNoSlot()` was extracting the date via `startIso.split('T')[0]` → `'2026-03-17'`, so the pickup summary showed "Tue Mar 17" and `initDeliverySection()` was seeded with the wrong date (delivery landed one extra day late). Fix: `selectNoDay()` now passes the locally-selected `iso` as an explicit 5th argument to `selectNoSlot()`, which uses it directly for display and delivery calculation. UTC timestamps stored in DB are still correct — only the display and delivery seeding were affected.

- **Pickup Failed (Auto) explained:** `auto_fail_expired_orders()` pg_cron function (every 30 min) marks `scheduled` orders as `pickup_failed` with `cancelled_by = 'system'` if the pickup window closed more than 2 hours ago. Badge shows "(Auto)" when `cancelled_by = 'system'`. Reschedule from Issues tab resets back to `scheduled`.

- **Next session priorities:**
  1. Test CloudPRNT end-to-end with physical printer on-site (setup guide in `TSP654II-CloudPRNT-Setup.md`)
  2. Route picker fine-tuning (backlog)
  3. Xero accounting sync (backlog)

---

### Mar 16, 2026 (session 22) — CloudPRNT integration (Star TSP654II)

- **`print_jobs` table created** (migration `cloudprnt_print_jobs`): `id`, `printer_token`, `order_id` (FK → orders, ON DELETE SET NULL), `content` (Star Markup text), `status` (pending → claimed → done), `created_at`, `claimed_at`, `completed_at`. Composite index on `(printer_token, status, created_at)` for fast polling. RLS: `admin_all_print_jobs` (authenticated + `is_admin()`); Edge Function uses service_role (bypasses RLS).

- **`settings.printer_token` column added**: Nullable TEXT. Stores the printer's CloudPRNT token. Loaded into `BIZ_PRINTER_TOKEN` global at startup alongside timezone.

- **`cloudprnt` Edge Function deployed** (JWT off — public, printer has no auth token): Handles full CloudPRNT handshake: GET `?ctoken=TOKEN` → `{ jobReady: true/false, mediaTypes: ["text/vnd.star.markup"] }`. POST with form body → returns pending job's Star Markup content and marks it `claimed`. POST with `jobDone=true` → marks it `done`. Uses service_role key to read/update `print_jobs`.

- **Admin → Settings → Receipt Printer card added**: Displays the CloudPRNT server URL with a Copy button. Printer token input (monospace, placeholder `AA-BB-CC-DD-EE-FF`). Save button + "✓ Printer connected" badge when token is set. **🖨 Test Print** button queues a test job with basic Star Markup (business name, "TEST PRINT", timestamp).

- **`buildStarMarkup(data)` function**: Converts the same data shape as `_openReceiptWindow()` into Star Document Markup Language (SDM) for the TSP654II. Sections: centered business header (size 2:2), customer name (size 2:1), address, order number + weight, pickup/delivery schedule, stop/route, add-ons, invoice line items (38-char label + 8-char right-aligned amount), subtotal/fees/credits, amount due (size 1:2), Code128 barcode, footer. XML-safe via `_escXml()`.

- **`queueCloudPRNTJob(data)` function**: Inserts a `print_jobs` row with the Star Markup. Shows "✓ Sent to printer" toast on success.

- **Both print paths updated**: `printBagTag()` (order panel + kanban Reprint) and `_autoPrintIntake()` (intake save → processing) now check `BIZ_PRINTER_TOKEN`. When set: skip popup, queue CloudPRNT job. When unset: original browser popup behavior unchanged.

- **Commits this session:** `bb7255a` (CloudPRNT integration), `202e80b` (tree repair — see below)

- **⚠ Site outage + fix (commit `202e80b`):**
  - **Root cause:** The bindfs FUSE git workaround was seeding a *temp index from scratch* instead of from `HEAD`. Every docs-only commit after `a19d206` deployed a Vercel repo containing only the changed file (e.g., just `PROJECT-NOTES.md`). No `admin-dashboard/`, `customer-app/`, `driver-app/`, or `vercel.json` → 404 on all routes. Affected commits: `a19d206`, `4e62cf9`, `aecf9e3`.
  - **Fix:** Rebuilt full tree from `d928bd0` (last good commit) using `git read-tree d928bd0` to seed the temp index, then layered on current `admin-dashboard/index.html`, `PROJECT-NOTES.md`, and `TSP654II-CloudPRNT-Setup.md`. Committed as `202e80b`, Vercel deployed immediately.
  - **Prevention:** Created `.git-commit.sh` helper script at repo root. Uses `git read-tree HEAD` to seed temp index before adding any files — guarantees full tree on every commit. **Always use this script for future commits on this machine.**

- **Next session priorities:**
  1. Test CloudPRNT end-to-end with physical printer (David picking up TSP654II tonight — setup guide in `TSP654II-CloudPRNT-Setup.md`)
  2. Route picker fine-tuning (backlog)
  3. Xero accounting sync (backlog)

---

### Mar 16, 2026 (session 21) — Driver app phone OTP login

- **Driver app: Magic Link replaced with Phone Code SMS OTP (commit `a743a3b`):** The "Magic Link" auth tab (email → sign-in link) has been removed and replaced with a "Phone Code" tab. Two-step flow: driver enters mobile number → receives SMS code → enters 6-digit code. E.164 normalisation handles any 10-digit US number format. Functions added: `doDriverPhoneOTP()`, `doDriverOTPVerify()`, `resendDriverOTP()`, `resetDriverPhone()`. `switchAuthTab()` updated from `'magic'` to `'phone'`. Load-timeout handler updated to also reset the phone OTP panel if it fires mid-verification.

- **Driver phone account linking (commit `a743a3b`):** `link_phone_auth_driver` Postgres SECURITY DEFINER function (applied session 20) is called from `loadDriverData()` when `currentUser.phone` is set. It finds the existing driver record by matching last 10 phone digits in `profiles` (where `role = 'driver'`), re-points `drivers.profile_id` to the new phone-auth UUID, and patches the new profile row with the driver's real name/email. On first phone login, the driver's full history and route assignments transfer automatically. `MULTIPLE_MATCHES` (two drivers share a number) shows a toast and auto-signs out.

- **Note for David:** Drivers must have a phone number stored in their profile for account linking to work. When setting up new drivers in the admin, make sure their mobile number is saved to the profile. Existing drivers can be verified in Admin → Team → Drivers.

- **Commits this session:** `a743a3b` (driver phone OTP)

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning (backlog)

---

### Mar 16, 2026 (session 21b) — Security audit + full RLS hardening

- **Full security audit run across all 3 apps + database.** No hardcoded Twilio/SendGrid/Stripe secret keys found in app files. XSS in SMS inbox is correctly handled. All 34 tables have RLS enabled. Stripe secret key absent (publishable key only). Twilio/SendGrid credentials in Supabase Secrets only.

- **27 dangerous RLS policies removed across 18 tables** (migrations `rls_security_hardening` + `rls_security_hardening_services_v2`). The two critical ones — `cpm_anon_all` (payment method data) and `anon_all_sms_messages` (full SMS history) — are gone. All tables now require authentication for any write access. Key policy changes:
  - `customer_payment_methods`: `cpm_anon_all` dropped
  - `sms_messages`: `anon_all_sms_messages` dropped
  - `customers`, `orders`, `routes`, `route_stops`, `addresses`, `profiles`, `drivers`: all anon read/write blanket policies dropped; scoped per-user + admin policies retained
  - `driver_locations`: open-to-anyone upsert replaced with driver-scoped insert/update + authenticated read
  - `discounts`, `settings`: ALL-for-public replaced with SELECT-only for public
  - `message_templates`, `route_driver_overrides`, `route_templates`, `preferences`, `driver_messages`, `notifications`, `cs_issues`, `conversations`, `launderers`, `racks`, `order_items`, `subscriptions`, `customer_transactions`, `services`, `service_fees`, `service_categories`: all anon write policies dropped

- **Google Maps API key** — David restricted to `*.washroute.vercel.app/*` referrer in GCP Console on 2026-03-16. ✅ Done.

---

### Mar 16, 2026 (session 20) — UX fixes, route badges, Delivered tab, hash routing, OTP fix

- **UX fixes — customer app (commit `56529f6`):** Orders screen back button now navigates to Home (not Account, which was a dead end). Step 2 CTA changed from "Looks good →" to "Next →" (clearer intent).

- **Delivered tab added to admin Orders page (commit `56529f6`):** New "Delivered" filter tab shows orders delivered in the **last 24 hours only** (`actual_delivery_at || delivery_window_start >= now()-24h`). Cancelled orders are fully archived — never shown in any tab. Tab count badge updates live with the same 24h filter.

- **Route-status badges added to Routes > Schedule grid (commit `9c714ae`):** 🔒 (all stops complete) and amber pulsing dot (in-progress) badges now appear in the weekly schedule grid on the Routes page, matching what was already on the Drivers > Schedule grid. Pre-fetched via a single query at render time when `schedWeekOffset === 0`.

- **URL hash sub-page persistence (commit `9546d02`):** Admin dashboard now writes the active sub-tab to the URL hash when navigating. On browser refresh, both the page and sub-tab are restored. Supported states: `#orders/schedule`, `#orders/in_process`, `#orders/delivered`, `#orders/issues`, `#orders/ready`, `#orders/scheduled`, `#maps/zones`, `#maps/routes`, `#team/members`, `#team/permissions`, `#routes/templates`. Restore logic pre-sets `currentOrderFilter` before `showPage()` so `loadOrders()` fetches the correct dataset, then corrects the hash a second time after `switchOrdersView()` would otherwise overwrite it to `#orders/orders`.

- **Twilio OTP fix (manual config — no code change):** Customer app phone login was failing with Twilio error 20003 (auth failure). Root cause: the Supabase Auth phone provider stores its own copy of the Twilio Auth Token, separate from Supabase Secrets. When the token was rotated in session 8, only Supabase Secrets was updated — not the Auth provider setting. Fixed by David updating the token at Supabase Dashboard → Authentication → Providers → Phone.

- **Commits this session:** `9c714ae` (route badges), `56529f6` (UX + Delivered tab), `e3b8ee2` (Delivered tab 24h scope), `9546d02` (hash routing)

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning

---

### Mar 16, 2026 (session 19) — Sign-out fix, turnaround enforcement, smart driver reassignment, QA

- **Bug fix — Sign-out button stuck as "Signing out…" (commit `8882c52`):**
  After a sign-in/sign-out cycle in the same browser session, the Account tab button remained disabled and showed "Signing out…" permanently. Root cause: the DOM state from the previous session was never reset. `loadAccount()` now unconditionally resets `.signout-btn` to `{disabled:false, textContent:'Sign Out'}` on every visit.

- **Bug fix — Delivery window engine didn't respect route-template turnaround (commits `f213c99`, `f859f38`):**
  A customer could book a PM pickup (e.g. 8–10 PM) with AM delivery the next morning (7–9 AM) despite a 1-day turnaround on the Berkeley PM route template. Root cause was three compounding gaps: (1) window objects lacked a `templateStartMins` field so the filter had no way to identify AM vs PM routes; (2) the delivery window filter only ran when `deliveryDate === pickupDate` (same calendar date), completely missing next-day PM → next-morning AM scenarios; (3) `draft.deliveryWindow` silently fell back to the pickup window label, masking the problem in the UI. Fixed with a layered approach:
  - `templateStartMins` added to all window objects in `computeSubWindows()`.
  - `draft._earliestDeliveryWindowMins` tracks the minimum valid delivery start (in minutes) for the first eligible delivery date.
  - Delivery window render filter (`_renderSchedWindowOpts`) now checks `isFirstEligibleDate` against `draft._deliveryOptions[0]` and filters by `startMins >= minMins`.
  - Auto-select logic in `_updateSchedDelivery()` and `selectSchedDeliveryDate()` both pick the first window that clears the floor.
  - Final guard in `placeOrder()` blocks submission if the resolved window is still too early.
  - `_updateSchedWindowDisplay` and `buildConfirmSummary` no longer fall back to the pickup window label — show "—" if no delivery window is set.

- **Feature — Admin Drivers > Schedule: smart reassignment rules (commit `f461017`):**
  Clicking a driver chip on today's column now runs a two-step check before allowing reassignment:
  - Grid badges: 🔒 for fully-complete routes, amber pulsing dot for in-progress routes (pre-fetched when rendering the schedule grid).
  - Popover banner: "Route in progress — only the N remaining stops will be reassigned" or "Route complete — no stops to reassign" shown asynchronously after popover opens.
  - `assignDriverOverride()` uses `popoverCtx.routeStatus` (fetched by `openDriverPopover`) to: skip stop propagation if route is complete; or filter `route_stops` by `status IN ('pending', 'en_route')` if partially done. Completed/skipped/failed stops stay attributed to the driver who did them.
  - `route_driver_schedule` is always updated (it's weekly/recurring), but the stop-level propagation is status-aware.

- **QA fix — `toast()` called with wrong second argument in `placeOrder()` (commit `72f17b8`):**
  Three delivery validation toasts in `placeOrder()` used `toast(msg, 'error')`. The `toast()` function signature is `(msg, duration)` — passing `'error'` as duration resulted in `setTimeout(fn, NaN)` → toast disappeared instantly (NaN → 0ms) with no error styling. Fixed all three to `showToast(msg, 'error')`. Two were pre-existing (same-day guard and turnaround check from session 18); one was from the new non-same-day guard added this session.

- **Commits:** `8882c52` (sign-out fix), `f213c99` + `f859f38` (turnaround enforcement), `f461017` (smart reassignment), `72f17b8` (QA: toast fix)

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning

---

### Mar 16, 2026 (session 18) — Hotfixes: same-day delivery window + email delivery time

- **Bug: Same-day delivery was saving the pickup window as the delivery window (commit `825b3c7`):**
  `placeOrder()` used `draft.deliveryWindow || pw` to resolve the delivery window. When `draft.deliveryWindow` was null at submission time (edge case where same-day toggle state and draft window became out of sync), it fell back to `pw` (the pickup window), producing an impossible same-delivery-as-pickup order. Order #101 was saved with `pickup_window_start = delivery_window_start = 16:00 UTC (9am PDT)` and `is_same_day = true`.

- **Fix — `_effectiveDW` resolution in `placeOrder()`:** Replaced the single-line `|| pw` fallback with a proper two-path resolver:
  - Same-day: `draft.deliveryWindow → draft._sameDayWindows[0]` — never falls back to `pw`
  - Standard: `draft.deliveryWindow → null` (no explicit window; date-only delivery)

- **Added two turnaround guards in `placeOrder()` (before the DB INSERT):**
  1. **Turnaround check** — if same-day order and resolved `delivStartMs <= pickupEndMs`, blocks with toast: "Delivery time must be after your pickup window."
  2. **Hard stop** — if `isSameDay=true` but no delivery window could be resolved at all, blocks with toast explaining to choose a different pickup time.

- **Bug: Confirmation email showed delivery date only, no time (commit `825b3c7`):**
  The `'Est. Delivery'` row in the booking confirmation email used `_fmtD(deliveryDate)` (date only). Pickup row correctly used `pw.label`. Fixed to use `_effectiveDW.label` (the same resolved delivery window used for the order) — email now shows e.g. "Monday, March 16 · 8pm – 10pm".

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning

---

### Mar 16, 2026 (session 17) — Hotfix: Double Wash overriding base bag price

- **Bug: Double Wash was becoming the default service in customer app (commit `41f6b97`):**
  When Double Wash was added to the `services` table in session 16, it was inserted with `sort_order=0` — lower than Wash & Fold's `sort_order=1`. The customer app sets `defaultService = allServices[0]` (the first row returned), so Double Wash ($15/bag) was being used as the base price instead of Wash & Fold ($59/bag). Pricing screen showed "1 bag × $15.00" and confirmed order summary showed "Double Wash × 1 bag $15.00" — a $44/bag undercharge per order.

- **Fix — code:** Changed `defaultService = allServices[0]` to `defaultService = allServices.find(s => !s.is_addon) || null` in `customer-app/index.html`. This makes the selection immune to sort order changes — addon services can never become the default service regardless of their `sort_order`.

- **Fix — DB:** Updated Double Wash `sort_order` from 0 → 5 (slots it after Oxi at 3, before Air Dry at 7). Corrected order is now: Wash & Fold (1), Vinegar (2), Oxi (3), Shirt Service (4), Double Wash (5), Air Dry (7).

- **Admin unaffected:** Admin dashboard never used `defaultService` — it always looks up service by `service_id` on existing orders.

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning

---

### Mar 15, 2026 (session 16) — Double Wash pricing + SMS automation Phase 1

- **Double Wash preference + addon service added to DB (no code change needed):**
  - New row in `preferences` table (`id: 523db29c`): name="Double Wash", category="Delivery", sort_order=4, options=[No (default, $0), Yes ($15)].
  - New row in `services` table (`id: 3de1c270`): name="Double Wash", base_price=$15.00, pricing_type="per_bag", is_addon=true, linked_preference_id → the new preference.
  - Both apps pick it up automatically on next load. Customer app shows "+$15.00/bag" toggle chip between Oxi and the next pref. Admin processing shows it in the intake breakdown.

- **SMS automation Phase 1 — `twilio-webhook` v14 deployed:**
  Four inbound keyword handlers are now live. All auto-replies are logged to `sms_messages` (direction='outbound') so they appear in the admin SMS inbox.

  | Keyword | Action |
  |---|---|
  | `PICKUP` | Books the customer's next pickup using last order as template (zone, address, bags). Blocks duplicate if active order exists. Replies with order # + pickup date/window. |
  | `STATUS` / `ORDER` / `ETA` / `WHERE` / `UPDATE` / `TRACK` + fuzzy phrases | Replies with real-time order status + relevant date. Covers all active statuses (scheduled, picked_up, processing, ready_for_delivery, on_hold, pickup_failed). No active order → nudges to reply PICKUP. |
  | `SKIP` | Skips next scheduled pickup, sets cancelled_by='customer', sends skip confirmation template. Now also logs outbound confirmation to admin inbox (was missing before). |
  | `HELP` / `HI` / `HELLO` / `HEY` | Sends command menu listing PICKUP, STATUS, SKIP. |
  | Anything else | Logged to admin inbox, no reply. |

  - PICKUP handler details: fetches last delivered order → copies zone_id, address IDs, bag count, service_id → finds next valid route day in PT using route_templates.schedule_days → creates order with source='sms' → DB trigger auto-assigns route + stops → confirms via TwiML reply.
  - PT timezone handled dynamically via `getPtOffsetHours()` (works for both PST/PDT).
  - STATUS query also nudges "Reply PICKUP to book" when no active order found.
  - SKIP handler fixed to set `cancelled_by: 'customer'` (was missing) and now logs outbound confirmation.

- **Next session priorities:**
  1. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16
  2. CloudPRNT integration (backlog)
  3. Route picker fine-tuning

---

### Mar 15, 2026 (session 11) — Admin order panel: same-day toggle + delivery address checkbox

- **Same-day service toggle (commit `a5915a4`):** ⚡ checkbox added inline with the Delivery section header in the admin Order panel Schedule tab. On panel open, same-day is auto-detected by comparing `pickup_window_start` and `delivery_window_start` date substrings. When checked, adds a $10 surcharge to the estimate (fee amount looked up from `service_fees` with category `Surcharge` + name containing "same"). `opToggleSameDay()` sets `opIsSameDay` and calls `opRecalcEstimate()`.

- **Delivery address hidden behind checkbox (commit `a5915a4`):** Replaced the always-visible "Delivery Address" section with a "Different delivery address" checkbox. The address picker is hidden by default and only revealed when checked. On panel open, the checkbox auto-checks if `delivery_address_id` exists and differs from `pickup_address_id`. Unchecking calls `opToggleDiffDeliveryAddr(false)` which nulls `delivery_address_id` in DB — the system then falls back to the pickup address. Reduces risk of accidental address changes.

- **`opSaveDetails()` updated to persist same-day surcharge:** When the same-day toggle is on, saves `type: 'same_day_surcharge'` line item (consistent with the admin order creation flow type) and includes the surcharge in `total_amount`. Billing tab Charge button is also refreshed via `opPopulateBilling(o)` after save so the label stays in sync.

- **Same-day toggle auto-shifts delivery window date:** When admin checks ⚡ Same-day, `opToggleSameDay()` now automatically shifts `delivery_window_start`/`delivery_window_end` to the same local calendar date as the pickup (keeping the same time-of-day — e.g. 6pm stays 6pm but moves from Mar 17 → Mar 16). Saved to DB immediately, display refreshes. Unchecking restores the original delivery window from `_opPreSameDayDeliveryStart/End`. Auto-detection on panel open now uses `en-CA` locale in `BIZ_TZ` for accurate local date comparison. Admin still needs to verify/update the delivery route via Edit (route instances are date-specific).

- **Next session priorities:**
  1. Add `price_mod` for Double Wash and remaining add-on prefs
  2. Receipt printing — thermal 80mm bag tag (mockup at `receipt-mockup.html`)
  3. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16

---

### Mar 15, 2026 (session 10) — Preference UX overhaul: checkboxes throughout + order→account sync

- **Add-on preferences as checkboxes — order flow (commits `58917f7`):** Yes/No preference groups (Oxi, Vinegar, Double Wash, etc.) are now detected automatically via `_isAddonPref()` helper (exactly 2 options, one `is_default`). Instead of Yes/No buttons, these render as tappable checkbox rows under an "Optional Add-ons" heading. Regular multi-option prefs (Wash temp, Dry temp) still show the button grid. CSS classes: `.order-addon-section`, `.order-addon-row`, `.order-addon-row.checked`, `.order-addon-check`.

- **Add-on preferences as chips — admin intake panel (commit `58917f7`):** Same `_isIntakeAddon` detection applied to `renderIntakePanel()`. Add-ons render as a compact "Customer Add-ons" chip row — togglable on/off. Regular prefs keep full button groups. `selectProcAddon()` updated to toggle: if tapping the already-selected active option, reverts to the default option (effectively unchecking).

- **Confirm page pricing accuracy (commits `308f9d3`, `b0ba5a1`):** Fixed two issues on the booking confirmation screen:
  1. Add-on rows were displaying the option label ("Yes") instead of the preference group name ("Vinegar Rinse"). Fixed by looking up `globalPrefs.find(g => g.id === groupId)?.name`.
  2. Add-on fees were flat (not multiplied by bag count), mismatching the processing queue logic. Fixed: `priceMod × bags` in both `updateEstimate()` and `buildConfirmSummary()`.

- **Confirm page preferences section redesigned (commit `fe4a84d`):** Preferences now show as a dedicated card with one row per selected preference (name + chosen option label, price note for paid add-ons). Edit → button navigates back to the preferences step (`goOrderStep(2)`).

- **Account > Laundry Preferences redesigned to match order flow (commit `9cdad69`):** Replaced the old `<select>` dropdown UI with the same button grid + checkbox layout used in the order flow. Opening the panel calls `openPrefsSubPanel()` which re-initialises `acctPrefs` from saved data each time (no stale state). `selectAcctPref()` / `toggleAcctAddon()` handle interactions. Save button now shows "Saving…" and disables during the Supabase write.

- **Order preference changes sync back to Laundry Preferences (commit `9cdad69`):** `selectOrderPref()` and `toggleOrderAddon()` now call `_syncOrderPrefsToAccount()` — a fire-and-forget async function that converts `draft.prefs` to `{ groupId: optionId }` format and writes it to `customers.preferences`. This means a customer who changes their prefs during booking automatically has their saved account prefs updated without any extra step.

- **Next session priorities:**
  1. Add `price_mod` for Double Wash and remaining add-on prefs
  2. Receipt printing — thermal 80mm bag tag (mockup at `receipt-mockup.html`)
  3. ~~Twilio A2P 10DLC registration~~ ✅ Approved 2026-03-16

---

### Mar 15, 2026 (session 9) — Same-day toggle confirmed, sign-out fix, estimate total overhaul

- **Same-day toggle confirmed working end-to-end:** Toggle now appears correctly when 7am–9am is auto-selected after date pick. Root fix from session 8 (`04e18e9`) was correct — added a `try/catch` wrapper and diagnostic logging (`8616949`) to catch any silent exception in the async chain, which resolved the issue. Diagnostic logs cleaned up in the same session (`customer-app/index.html` — no separate commit, bundled with sign-out fix).

- **Sign-out button stuck on "Signing out…" (commit `8ae1ef1`):** `db.auth.signOut()` makes a network call to revoke the Supabase token and can hang indefinitely — the Promise never settles, the button stays disabled forever. Fixed by adding a 1.5s `setTimeout` force-logout fallback: clears local auth state (`appReady`, `currentUser`, `currentProfile`, `currentCustomer`, `currentCards`), hides bottom nav, and navigates to auth screen. If the Supabase call resolves before 1.5s, the timer is cleared. Error path also now logs out locally instead of just re-enabling the button.

- **Estimate total now shows all charges (commits `41d0144`, `59115bf`):** The bag count step estimate and the confirm order page total were only showing the per-bag base price. Two root causes fixed:
  1. **`loadServices()` updated** to fetch `service_fees` table (`show_in_app=true`) in parallel with services and preferences — stored in new global `allServiceFees[]`.
  2. **`updateEstimate()` and `buildConfirmSummary()` updated** to include: delivery/pickup fees from `service_fees` (category whitelist: `'Delivery'` or `'Pickup'`), add-on preference charges, and same-day surcharge if toggled on. Estimate note now shows a breakdown, e.g. "2 bags × $29.50 · add-ons +$6.00 · Delivery Fee +$9.95 · ⚡ Same-day +$10.00", plus "Up to 25 lbs/bag · Overages billed at processing".
  3. **Route fee filter uses category whitelist** (not name exclusion) so Missed Pickup Fee ($15) and Refer-a-Friend Credit ($10) never appear in estimates.

- **Preference add-on prices added to DB (SQL migration, session 9):** The `preferences` table stores options as a JSONB array. Options had no `price_mod` field, so add-ons always contributed $0 to the estimate. Added `"price_mod": 3.00` to the "Yes" option for both "Add Vinegar?" and "Add Oxi?" via targeted `jsonb_agg` + `CASE WHEN` SQL. Verified with a SELECT confirming both options now carry the correct price mod. Double Wash and other add-on prices deferred to a future session.

- **Next session:** Add `price_mod` for Double Wash and remaining add-ons.

---

### Mar 15, 2026 (session 8) — Customer app UX fixes, security hardening, same-day toggle bug fix

- **SendGrid receipts confirmed working:** Verified `SENDGRID_API_KEY` was already set in Supabase Secrets (shared with `send-email` function). Live test via browser console returned `{ok: true, sent_to: 'dmacquart@gmail.com'}`. No changes needed.

- **Order cards now show pickup date (commits `cf809a8`, `ab66022`):** Order cards in My Orders were displaying the booking date (`created_at`) instead of the pickup date. Fixed by using `pickup_window_start` (the correct column — `pickup_date` doesn't exist). Order detail "Placed [date]" still correctly shows `created_at`. Also added `skipped` and `pickup_failed` to `PAST_STATUSES` so those orders correctly appear in the Past tab (not Current).

- **Delivery address removed from customer app (commits `f65b95a`, `63cee3f`):** Removed the delivery address picker and same-address checkbox from the booking flow and Edit Order modal entirely. In 99%+ of cases delivery = pickup address. If admin sets a different delivery address, the customer now sees a read-only note: "Updated by your service team · SMS us to change." `saveEditOrder()` preserves the admin-set delivery address via `window._editDeliveryAddressId`.

- **Compact display fixes (commit `b16697a`):** Removed state abbreviation from `fmtAddrOneLiner()` (all customers are in CA). Replaced `fmtSlot()` with a compact version — e.g., "7–9am" instead of "7:00 AM – 9:00 AM". Both prevent line breaks in order detail rows.

- **Security hardening — Twilio credentials & test endpoint:**
  - `send-sms` and `notify-on-my-way` edge functions had a hardcoded Twilio auth token as a fallback (`|| 'cdfc2502...'`). Token was rotated in Twilio Console. Both functions redeployed to read from Supabase Secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) with no hardcoded fallback. Both return 500 if secrets are missing.
  - `create-test-user` edge function was a publicly accessible endpoint (no auth) that could create admin-role users. Neutralized — now always returns 404.
  - Stripe publishable key and Supabase anon key in client code are safe by design (confirmed).

- **Same-day toggle bug fixed (commit `04e18e9`):** Toggle never appeared when picking an AM slot via date selection. Root cause: `selectSchedPickupDate()` was missing the `_checkSameDayAvailable()` call after auto-selecting the first window on date change. The check existed in `renderSchedCard` (initial load) and `selectSchedWindow` (manual window tap) but not in the date-selection path. Fixed by adding the full same-day check block to `selectSchedPickupDate`. Also improved copy: "Want it back tonight?" for same-day bookings today, "Want it back Tuesday evening?" for future date bookings. Delivery display shows "Tonight 🌙" or "Mon, Mar 16 🌙" accordingly.

### Mar 14, 2026 (session 7) — Route picker UX overhaul (friction removal, zone refresh, smart defaults, past-slot guard)

- **Remove '+ Create' friction (commit `f46bede`):** Templates no longer show a "+ Create" label. Zone-matched templates for a date appear as normal selectable routes. When tapped, the route instance is created silently in the background (brief opacity dim). No extra admin step ever required.
- **Zone refresh on address change (commit `b6b65f8`):** When admin changes pickup/delivery address while the route picker is already open, zone detection re-runs immediately and the route list updates in place — no manual page refresh needed. Implemented in `opSaveAddress()`.
- **Always show all zone routes (commit `1b36755`):** Previously, if Berkeley PM had a route instance for a date but Berkeley AM didn't, only Berkeley PM appeared. Now the code always combines existing route instances with eligible un-instantiated templates, so both AM and PM always show for any Mon–Sat date regardless of which instances were pre-created.
- **Delivery auto-selects matching timeframe (commit `1b36755`):** When the delivery picker opens, it auto-selects the route matching the pickup's timeframe. Pass 1: exact name match. Pass 2: same AM/PM suffix (e.g. Oakland AM pickup → Berkeley AM delivery when address was changed). Implemented at end of `opFilterRoutesByDate()`.
- **Past time slots hidden on today's date (commit `1192fbb`):** Admin route picker now filters out slots whose window has already ended when the selected date is today. If all slots are past, shows "All windows for this route have passed today. Choose a future date." instead of showing ghost bookings.
- **QA fix: ghost route guard (commit `f8f52df`):** After saving a pickup, `opSaveRouteAndSlot` pre-fills the delivery picker in the background. The new auto-select logic would have fired and silently inserted orphaned route records. Fixed by guarding auto-select to only run when the delivery picker is visibly open.

### Mar 14, 2026 (session 6) — Orders tab restructure, ready_for_pickup removal, reschedule picker overhaul

- **Issues tab: single descriptive badge (commit `b3b4c16`):**
  - Replaced the redundant "status badge + sub-label" combo in the Issues tab with a single `issueBadge(o)` function.
  - Badge text fully describes the situation: "Skipped by Driver", "Skipped by Admin", "Pickup Failed (Auto)", "Delivery Failed (Auto)", "Payment Failed", "On Hold". No separate sub-label needed.

- **Orders tabs restructured (commit `25cda26`):**
  - Old tabs: Scheduled / Active / Delivered / Issues / Cancelled (5 tabs).
  - New tabs: Scheduled / In Process / Ready / Issues (4 tabs). Delivered, cancelled, and customer-skipped orders are archived — not shown in any tab.
  - `ORDER_FILTER_GROUPS`: `scheduled: ['scheduled']`, `in_process: ['picked_up','processing','folding']`, `ready: ['ready_for_delivery','out_for_delivery']`, `issues: ['pickup_failed','delivery_failed','on_hold']`.

- **Removed `ready_for_pickup` status entirely (commit `e502e07`):**
  - Status was never auto-set by any code path — it was a manual-only intermediate step with no functional purpose.
  - DB migration `remove_ready_for_pickup_status`: dropped and recreated `orders_status_check` constraint without `ready_for_pickup`. `auto_fail_expired_orders()` updated to target only `'scheduled'`.
  - All 18 references removed across admin dashboard and customer app: `STATUS_FLOW` (now `scheduled → picked_up` directly), `STATUS_STYLES`, `canAssign`, `ALL_STATUSES`, `ORDER_FILTER_GROUPS`, Reports labels/colors, customer app CSS/logic.

- **Reschedule fixes — failed orders and delivery validation (commits `9699164`, `d7923f9`):**
  - `opSaveRouteAndSlot()` now resets status to `scheduled` (clears `cancelled_by`) when rescheduling a `pickup_failed`, `delivery_failed`, or `on_hold` order. Previously rescheduling left the order stuck in Issues.
  - Delivery date defaults to pickup+1 if existing delivery is invalid (before pickup); `min` date enforced on the delivery date input.
  - Delivery validation: saving a delivery leg before the pickup window end now shows a toast error and aborts.
  - After saving a pickup, delivery date is automatically advanced and delivery route list refreshed.

- **Route picker zone filtering (commits `f9e3538`, `b233190`):**
  - **Root cause found:** Supabase returns `numeric` lat/lng columns as strings. Passing strings to `db.rpc('get_zones_for_point', ...)` caused a silent PostgREST type-cast failure — `_opPickerZoneIds` stayed empty and all routes showed with no filtering.
  - **Fix 1:** `parseFloat(addr.lat)` / `parseFloat(addr.lng)` before passing to the RPC (applied at both call sites).
  - **Fix 2:** City-name fallback now handles `service_zones` as array or single object from Supabase join (`Array.isArray(zoneRaw) ? zoneRaw[0] : zoneRaw`).
  - **UX tightened:** When customer zone is known, only zone-matched routes are shown in the picker. Other-zone routes are completely hidden (not dimmed). All routes shown as fallback if zone can't be determined.

- **QA pass — 2 bugs found and fixed (commit `9483060`):**
  - **Medium:** `'skipped'` was accidentally dropped from `ORDER_FILTER_GROUPS.issues` in the tab restructure. Driver-skipped and admin-skipped orders were invisible in all tabs. Fixed by adding `'skipped'` back and restoring `cancelled_by !== 'customer'` filter so customer-initiated skips stay archived.
  - **Low:** `delivery_failed` orders were resetting to `'scheduled'` on reschedule, implying a full restart when the laundry is already at the facility. Fixed to reset to `'ready_for_delivery'` instead. `pickup_failed` and `on_hold` still correctly reset to `'scheduled'`.

- **All commits:** `b3b4c16`, `25cda26`, `e502e07`, `9699164`, `d7923f9`, `f9e3538`, `b233190`, `0956d44`, `9483060`

---

### Mar 14, 2026 (session 5) — Payment indicator polish, cancelled_by system, Issues tab improvements, customer skip button

- **Payment indicator rework (commit `ba5426a`):**
  - Moved paid indicator from right side of Amount column to left side as a `$` badge (easier to spot at a glance).
  - Paid orders: green `$` on the left. Failed: red `PAY FAILED` pill. No payment: blank placeholder to hold layout.
  - Failed payments (`billing_status = 'failed'`) now surface in the Issues tab filter and count badge.

- **`cancelled_by` column — full implementation (migrations + all 3 apps, commit `d884169`):**
  - DB migration `orders_add_cancelled_by`: added `cancelled_by TEXT CHECK (IN ('customer','driver','admin','system'))`, nullable, with partial index on non-null values.
  - DB migration `recurring_trigger_respect_cancelled_by`: updated `trg_create_recurring_order_fn` to fire on `skipped` status **only when `cancelled_by = 'customer'`** — fixes a silent bug where driver/admin skips on recurring orders would have broken the subscription chain.
  - DB migration `auto_fail_set_cancelled_by_system`: `auto_fail_expired_orders()` now stamps `cancelled_by = 'system'` when it fires.
  - **Admin:** `opSkipOrder()` (admin processing customer's request) sets `cancelled_by: 'customer'`. `opSetOrderStatus()` and `setSingleOrderStatus()` set `cancelled_by: 'admin'` for terminal statuses. Added `cancelled_by` to orders SELECT query.
  - **Driver app:** `skipStop()` sets `cancelled_by: 'driver'`. Undo path (`triggerUndo()`) clears it back to `null`.
  - **Customer app:** New "Skip this pickup" button on order detail — visible for recurring orders in skippable statuses. `skipPickup()` sets `status: 'skipped', cancelled_by: 'customer'`.

- **Issues tab improvements (commit `7d7a09e`):**
  - Filter now excludes `cancelled_by = 'customer'` orders (intentional skips, not actionable). Includes `billing_status = 'failed'` orders.
  - `issueLabel(o)` helper renders context under each status badge: who skipped/failed it, auto-fail indicator.
  - `issueActionBtn(o)` helper renders inline action: "Retry charge" for billing failures (calls `charge-order` edge function inline), "Reschedule →" for routing issues.
  - Count badge uses the same logic — no more false positives from customer-skipped orders.

- **Customer skip button (commit `0706362`):**
  - New `<div id="d-skip-section">` in customer app order detail, rendered between edit and cancel sections.
  - Shows "Skip this pickup" only when the order is recurring AND in a skippable pre-pickup status.
  - Confirmation dialog reassures customer their subscription continues. Toast confirms skip.

- **Design decision resolved:** See "Customer-Initiated Skips" section above — `cancelled_by` system is the chosen approach, fully shipped.

- **All known P0–P3 bugs remain resolved.** No new issues opened this session.

- **Commits:** `ba5426a` (payment indicator), `1980b60` (design decision doc), `d884169` (cancelled_by full impl), `7d7a09e` (Issues tab improvements), `0706362` (customer skip button)

### Mar 14, 2026 (session 4) — P3 bug fixes: updated_at trigger + skip-notification copy

- **Bug #6 fixed — `route_stops.updated_at` now auto-refreshes:**
  - Added `BEFORE UPDATE` trigger `trg_route_stops_updated_at` via migration `route_stops_auto_updated_at`.
  - Trigger calls `set_updated_at()` function which sets `NEW.updated_at = now()` on every UPDATE.
  - Previously `updated_at` stayed at row creation time even after driver reassignment, status changes, or DB-level cascade updates. Now it always reflects the last actual change.
  - No conflict with existing triggers: `trg_fill_stop_driver` is BEFORE INSERT only; `trg_sync_order_status` is AFTER UPDATE (fires after ours). Safe.

- **Bug #8 fixed — driver app skip-notification banner (commit `0930719`):**
  - `notified` variable in `renderStopDetail()` was computed as `!!stop.on_my_way_sent_at || isEnRoute`. Since `arrivedAtStop()` sets stop status to `en_route` immediately, `isEnRoute` was always `true` after a skip, causing the banner to show "Customer notified · Safe travels!" even when no SMS was sent.
  - Fix: `notified = !!stop.on_my_way_sent_at` — checks only whether the "On My Way" SMS was actually fired.
  - `alreadySent` (button label) and `currentStopPhase` (phase routing) retain `|| isEnRoute` intentionally — they need to route correctly when a stop is re-opened after a skip.

- **All known P0–P3 bugs from the Mar 14 e2e test are now resolved.** Zero open issues in the Known Issues table.

### Mar 14, 2026 (session 3) — P2 bug fixes: route_stop orphan cleanup

- **Bug #1 + #2 fixed — Route stops now sync to terminal order status:**
  - DB trigger `trg_sync_stops_on_order_terminal` created via migration. Fires AFTER UPDATE on `orders` when status changes to any terminal value.
  - `delivered` → pending/en_route stops → `complete`
  - `cancelled` → pending/en_route stops → `skipped`
  - `pickup_failed` → pickup stops → `failed`, delivery stops → `skipped`
  - `skipped` → pending/en_route stops → `skipped`
  - Hard deletes handled by existing FK CASCADE DELETE (confirmed via schema check).
  - **Backfill ran:** 10 orphaned stops across orders #75, 77, 78, 83, 84, 85 all corrected in a one-time cleanup query. Zero orphaned stops remain.
  - QA confirmed: no circular trigger loops, no blast radius in app code, all cancel paths correctly handled.

- **Bug #5 investigated (price discrepancy) — closed as non-issue:**
  - `saveIntake()` correctly writes `total_amount: bd.total` from `calcProcTotal()`. `saveRacking()` does not touch `total_amount`. The $164.95 vs $139.95 discrepancy on order #84 was a pre-existing test value, not a code bug. Downgraded to P3/monitor.

- **No app code commits this session** — all changes were DB-level (migration + backfill via Supabase MCP).

### Mar 14, 2026 (session 2) — End-to-end system test + bug fixes

- **Full end-to-end test:** Placed a test order (admin → processing pipeline → driver skip). Ran full lifecycle: intake (weight entry) → cleaning → folding → rack (Berkeley) → ready_for_delivery → driver skip. Verified all DB state changes at each step.

- **Processing queue realtime sync (commit `1e35b36`):** Replaced 30s poll with Supabase Realtime subscription + 5-min safety net. Both admin and Laundry Tech views now update instantly when any order moves through the kanban.

- **Customer app fixes (commit `a9344c4`):**
  - Sign-out button now disables with "Signing out…" text while the auth request is in flight (was silent with no feedback on slow connections).
  - `window.toggleSameDay` was missing from the `window.` exposure block — would throw a `ReferenceError` on the pricing panel's same-day checkbox tap. Fixed.

- **Bug #7 fixed — Driver app stop reassignment realtime (commit `7916331`):**
  - Realtime UPDATE handler on `route_stops` now removes the stop from a driver's list if its `driver_id` is changed to someone else. Previously the stop just stayed (stale), meaning two drivers could potentially attempt the same delivery.
  - Also handles the inverse: if a stop is newly assigned to this driver (idx < 0 but `driver_id === currentDriver.id`), triggers a `loadRouteData()` reload so it appears immediately.
  - Toast shown: "This stop was reassigned to another driver."

- **Bug #4 fixed — Order Schedule realtime (commit `7916331`):**
  - `confirmReassignDriver()` had an `if (btn)` guard that silently skipped the `selectRunOnMap()` refresh call when no `.run-toggle-btn` could be found. Removed the guard — `selectRunOnMap` handles a null btn fine.
  - Extended `startRouteStopListener` (the global route_stops subscription) to also call `selectRunOnMap(routeLiveRouteId, ...)` when any stop on the currently displayed route changes. Admin now sees driver skips, completions, and reassignments reflected on the Order Schedule map in real-time (~1–2s).

- **Realtime latency measured:**
  - Admin Orders list tab: ~2 seconds after a driver skip (Supabase Realtime on orders table).
  - Driver app: immediate after own action; realtime from admin changes now instant.

- **Bugs found (not yet fixed):** See Known Issues table. Key ones: route stops not cleaned up on cancel/deliver (P2), processing price discrepancy (P2), `route_stops.updated_at` not updated (P3), "Customer notified" banner after skip-notification (P3).

- **Commits:** `1e35b36` (processing queue realtime), `a9344c4` (customer app sign-out + toggleSameDay), `7916331` (driver stop reassignment + Order Schedule realtime)

### Mar 14, 2026 — Same-day delivery + site-wide QA

- **Full site QA (all 3 apps):** Reviewed admin dashboard, driver app, and customer app end-to-end. Two real issues found and fixed:
  - **HIGH (admin):** Credit deduction on processing intake was fire-and-forget — if the DB write silently failed, customer credits wouldn't be reduced but admin UI showed success. Now `await`ed with an error toast so admins know to fix manually.
  - **MEDIUM (admin):** `last_order_at` cache sync was fire-and-forget. Changed to `.catch()` so failures are logged.
  - All 5 realtime subscriptions confirmed properly guarded. Permissions grid refresh confirmed working. All auth safety timers confirmed in place. No High/Medium issues found in driver or customer apps.

- **Same-day delivery feature (customer app + admin route editor):**
  - Customers on **AM pickup routes** (Berkeley AM, Oakland AM) now see an "⚡ Want it back tonight?" toggle immediately after selecting their pickup window.
  - Eligibility driven by `turnaround_hours` on `route_templates` (AM routes = 9, PM routes = 0 — no same-day for evening pickups). Configurable per route from the admin route editor.
  - When toggled ON: delivery date = same day, delivery window = first qualifying PM slot (e.g. 6–8 PM for a 7–9 AM pickup), +$10 surcharge added. Fee always read from `service_fees` (Same-Day Surcharge row) — never hardcoded.
  - `is_same_day: true` written to orders; surcharge included as `same_day_surcharge` line item.
  - Admin route editor now shows and saves the "Same-day turnaround (hours)" field.
  - Toggle resets cleanly whenever pickup date or window changes. No schema migration needed — `turnaround_hours` column already existed on `route_templates` (was 0/unused).
  - **Timezone math note:** `slotEnd` and `slotStart` are both UTC ISO strings (created via `new Date(local).toISOString()`). The 9-hour UTC addition correctly resolves to the PM slot on the same local date in both winter (UTC−8) and summer (UTC−7).

- **New skills installed (found at session start):** `washroute-changelog`, `washroute-test`, `washroute-migration-review` — all three are now active and being used proactively.

- **Commits:** `751baba` (QA fixes), `6eb9426` (same-day delivery)

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

### Mar 13, 2026 (session 3) — Role-based access permissions

- **Three admin roles:** Admin (full access), Manager (Overview + Operations: Customers, Orders, Processing, Inbox, Drivers), Laundry Tech (Processing only).

- **`role_permissions` DB table:** Stores per-role, per-page boolean access flags. Seeded with defaults for all three roles. Queried at login to determine nav visibility and page access.

- **Dynamic nav visibility:** Nav items now use `data-page` and `data-section` attributes. `applyRoleToNav()` reads from `rolePermissions` cache (loaded at login). Section labels auto-hide when all items in the section are hidden.

- **`showPage()` guard:** Uses `canAccessPage(pageId)` instead of hardcoded `ADMIN_ONLY_PAGES` array. Redirects to first allowed page on denial.

- **Permissions grid UI (Team page):** Admins see a checkbox grid showing all pages × all roles. Clicking a checkbox instantly updates `role_permissions` in the DB. Admin column is locked (always full access).

- **Role management updated:** Invite modal and Change Role modal now offer Admin / Manager / Laundry Tech options instead of Admin / Staff. Role badges have distinct colors (purple/amber/green).

- **Default landing page:** Restricted roles land on their first allowed page (e.g., Laundry Tech goes straight to Processing).

### Mar 13, 2026 (session 2) — Order Schedule polish, Inbox cleanup, address fix

- **Reassignment tags on Order Schedule:** Purple "→ DriverName" pill tag appears next to any stop that's been reassigned to a different driver than the route's default. Uses `route_stops.driver_id` vs `routeLiveDefaultDriverId`.

- **Driver name display on Order Schedule:**
  - Route stop list header shows "DriverName driving" above the stops
  - All Routes group headers show "· DriverName" next to zone/slot label
  - `driver_id` now loaded in the routes query for `loadDailyRuns()`

- **Nav sidebar badges cleaned up:** Removed counters from Customers, Orders, and Processing. Only the Inbox badge (red, unread count) remains — it's the only actionable one.

- **Inbox: email view removed:** Stripped email fetch, email conversation grouping, and channel filter tabs (All/SMS/Email). Inbox is now SMS-only. "+" button always opens SMS compose. Email can be re-added later.

- **SMS compose: customer search:** New search-by-name input above the phone number field. Type a name → dropdown shows matching customers → pick one to auto-fill phone. Manual phone entry still works.

- **Google Maps API fix (customer app):** Address autocomplete and geocoding were silently failing — the Places API and Geocoding API weren't enabled in Google Cloud Console. No code change needed; David enabled the APIs and it started working.

- **Customer app: new address not saved on orders (bug fix):**
  - When a customer typed a new address (not selecting a saved one), `draft.addressId` stayed null because the address was only saved to the DB *after* the order was created
  - The order was inserted with `pickup_address_id: null`, so it showed the old default address
  - Fix: new address is now saved to the `addresses` table BEFORE creating the order, so the address ID is available for the insert
  - Also patched order #84 in the DB (was missing its Berkeley High School address)

- **QA pass:** No High/Medium issues. Dead code from email removal noted for future cleanup. SMS compose search handles XSS correctly via `esc()`.

- **Low-priority QA cleanup (post-QA):**
  - Dead email code removed from admin dashboard — stripped leftover CSS (`.inbox-ch-tabs`, `.inbox-ch-tab`, `.ch-email`), email compose modal HTML, and 6 orphaned JS functions (`setInboxChannel`, `openComposeEmail`, `closeEmailCompose`, `sendComposeEmail`, `openEmailConversation`, `sendEmailReply`). Simplified `renderConvItem()` to remove email branching.
  - SMS compose: added "no phone on file" toast warning when picking a customer with no phone number, preventing silent failure.
  - Customer app: smart address auto-labeling — new addresses now get "Home" → "Work" → "Address N" instead of always "Home", preventing duplicate labels.

### Mar 13, 2026 (session 1) — System simplification + live GPS tracking

- **Live GPS driver tracking (end-to-end):**
  - New `driver_locations` table (one row per driver, UPSERT pattern, Realtime-enabled)
  - Driver app sends GPS every 12s via `navigator.geolocation.watchPosition`
  - Admin dashboard: live driver markers on the Routes map, subscribed via Supabase Realtime

- **Unified single driver model:**
  - Drivers handle both pickup and delivery — no more `pickup_driver_id` / `delivery_driver_id` distinction
  - All app code now uses single `driver_id` on routes and `driver_id` on route_stops
  - Legacy DB columns (`pickup_driver_id`, `delivery_driver_id`) still exist but are unused by app code
  - Reports page simplified to use single driver lookup

- **Driver Schedule as sole source of truth:**
  - Moved Weekly Schedule from Settings/Routes page to Orders page, renamed to "Driver Schedule"
  - Renamed "Daily Schedule" tab to "Order Schedule"
  - Migrated 24 entries from template defaults into `route_driver_schedule`
  - Removed Default Driver concept entirely — no more template `default_pickup_driver_id` fallback
  - All driver assignment logic reads only from `route_driver_schedule`

- **New DB triggers for automation:**
  - `trg_sync_order_status` — auto-advances `orders.status` when all pickup/delivery route_stops are complete
  - `trg_fill_stop_driver` — auto-fills `driver_id` on new route_stops from parent route
  - `trg_sync_customer_cache` — keeps `customers.first_name_cache`/`last_name_cache` in sync with `profiles` table

- **Routing error tracking:**
  - Added `routing_error` text column on orders
  - `auto_route_order()` sets descriptive error when routing fails (no zone, no matching template, etc.)
  - Admin orders table: ⚠️ icon with tooltip on orders with routing errors
  - Admin order detail panel: red banner showing the routing error message

- **Explicit driver_id on route_stops:**
  - Replaced NULL-inherit pattern with explicit `driver_id` on every stop
  - Driver app queries changed from `.is('driver_id', null)` to `.eq('driver_id', currentDriver.id)`

- **Customer orders not appearing in driver app (fixed):**
  - Root cause: seed data routes had NULL driver IDs. Auto-route trigger found existing routes but never backfilled drivers.
  - Fixed trigger + ran one-time UPDATE on all existing routes

- **QA: fixed XSS** — HTML-escape `routing_error` in order detail panel `innerHTML`

- **Edge case testing (9 scenarios tested, 3 bugs found and fixed):**
  1. Order with no zone → was silently unrouted (trigger skipped it). **Fixed:** trigger now sets `routing_error = 'No zone assigned'`
  2. Order on Sunday → correctly fails with routing_error (no Sunday templates). ✅
  3. Order at 2 PM (between AM/PM windows) → silently assigned to AM. Acceptable fallback but noted for future improvement
  4. Route at capacity → overflow order assigned to next template (PM). Works correctly ✅
  5. Driver reassigned on route → existing stops kept old driver. **Fixed:** new `trg_cascade_route_driver` trigger cascades to pending/en_route stops
  6. Status sync (pickup complete → order picked_up, delivery complete → order delivered) ✅
  7. Recurring order with Sunday delivery → delivery stayed on Sunday, failed every cycle. **Fixed:** recurring trigger now bumps both pickup AND delivery off Sundays
  8. Two orders same customer same route → both get separate stops on same route ✅
  9. Duplicate customer on same day/zone → works correctly ✅

### Mar 12, 2026 (session 4) — Daily Schedule overhaul + UX cleanup

- **Driver app: tonight's orders not showing (3 bugs fixed):**
  1. `today()` used `toISOString().split('T')[0]` which returns UTC date — after 5 PM Pacific it returns tomorrow's date. Fixed to use local `getFullYear()/getMonth()/getDate()`.
  2. Address resolution: `route_stops.address_id` is always null. Added customer-based address enrichment — queries `addresses` table via `orders.customer_id` and attaches as `stop._addr`.
  3. RLS policy missing: authenticated drivers had no SELECT on `addresses`. Added `driver_read_stop_addresses` policy.

- **Google Maps API key** added to Supabase Edge Function secrets (`GOOGLE_MAPS_API_KEY`). Optimize route button fixed (was referencing `SUPABASE_URL` instead of `SUPA_URL`).

- **Daily Schedule redesigned as template-driven zone + AM/PM selector:**
  - Row 1: zone pills (All | Berkeley | Oakland) with colored dots matching route template colors
  - Row 2: AM/PM toggle with time labels and NOW/NEXT badges based on current time
  - Auto-selects the most relevant zone+slot (scores: in-window=0, upcoming=distance, past=penalized, routes with stops get priority)
  - "All" pill shows all routes on the map simultaneously, each in its template color

- **Stop rows simplified:** Shows only customer name, address, bags. Removed order number and price. "Assign" text link on the address line for driver reassignment (replaces failed attempts at dots icon and right-click menu).

- **Stop grouping fixed:** Pickups and deliveries mixed within time slots (split by stop_number midpoint), not separated by type.

- **Payment indicator on Orders page:** Green ✓ if paid (has stripe_payment_intent_id and not failed), red ✗ if billing_status=failed, blank otherwise.

- **Map improvements:** Height increased 50% (693px → 1040px). Route line color and pin color now match the route template's color instead of hardcoded purple.

- **Monochrome avatars:** All avatar circles across the dashboard (Customers, Drivers, Team) changed from rainbow colors to white background + black border + black text. Cleaner, more professional.

- **QA pass:** Fixed 3 callers of `selectRunOnMap` missing the new `routeColor` parameter. Bumped Assign link contrast from gray-300 to gray-400 for accessibility.

- **Route template IDs (for reference):** Berkeley AM `656c380d`, Berkeley PM `1468ff14`, Oakland AM `a9d16a68`, Oakland PM `0fe884ef`

### Mar 12, 2026 (session 3) — Auto-routing architecture overhaul
- **Major architecture change: route assignment moved from client JS to DB triggers.**
  The system now auto-routes orders without any admin intervention. Zero manual route creation needed.
- **New DB objects created:**
  1. `route_driver_overrides` table — per-day driver overrides by template + day_of_week + driver_type (pickup/delivery)
  2. `auto_route_order(p_order_id UUID)` function — matches templates by zone + day + time window, finds or creates the dated route, resolves drivers (override → template default → NULL), handles capacity overflow, creates route_stops, links order FKs, syncs `total_stops`
  3. `trg_auto_route_new_order()` trigger — AFTER INSERT on orders, fires for `status='scheduled' AND zone_id IS NOT NULL AND pickup_run_id IS NULL`
  4. `trg_create_recurring_order()` trigger — AFTER UPDATE on orders, fires when status transitions to `delivered` and `recurring_interval` is set. Creates next order (shifted by weekly/biweekly/monthly), skips Sundays (bumps to Monday). New order INSERT fires the auto-route trigger automatically.
- **Updated `orders_source_check`** — expanded from `('scheduled','walk_in')` to include `'customer_app'` and `'recurring'`.
- **Booking cutoff feature:** Added `booking_cutoff_minutes` column to `route_templates` (default 30). Customer app now hides time slots when current time is within the cutoff of the slot's end time (e.g. a 9–11 AM slot with 30min cutoff disappears at 10:30 AM). Configurable per route in admin Routes editor. Previously, slots vanished the moment their start time passed — a 9–11 AM slot disappeared at 9:01 AM.
- **Auto-fail expired orders:** New `auto_fail_expired_orders()` Postgres function runs every 30 minutes via pg_cron. Orders still in pre-pickup status (`scheduled`, `ready_for_pickup`) 2 hours after their pickup window closes → `pickup_failed`. Orders in delivery status (`ready_for_delivery`, `out_for_delivery`) 2 hours after delivery window closes → `delivery_failed`. Both land in admin Issues tab. Sends SMS to customer via pg_net → send-sms edge function inviting them to reschedule.
- **Driver app time-window filtering:** Stops now appear 2 hours before a route's window starts and hide once the auto-fail cron marks them. Incomplete stops from earlier routes carry forward with an "OVERDUE" badge so nothing gets lost. Evening stops no longer clutter the morning view.
- **Updated `orders_status_check`** — added `pickup_failed`, `delivery_failed`, `skipped` to allowed statuses.
- **Updated `route_stops_status_check`** — added `failed` to allowed statuses.
- **Admin Issues tab** — added `delivery_failed` to the filter group (was already showing `pickup_failed`).
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
- ~~Twilio A2P 10DLC registration~~ ✅ — Approved 2026-03-16. SMS fully live.
- ~~Receipt printing~~ ✅ — thermal 80mm, 2 copies, auto-prints on intake save + 🖨 Print button on order panel (session 13)
- ~~UX audit top 5 fixes~~ ✅ — double-tap, res.ok guard, batch button disable, stop card styling, slot CSS (session 15)
- ~~How did you find us? referral source~~ ✅ — both signup flows + admin dropdown (session 15)
- ~~Add Double Wash price_mod~~ ✅ — $15/bag, linked addon service, live in DB (session 16)
- ~~SMS automation Phase 1~~ ✅ — PICKUP, STATUS, SKIP, HELP keywords live in twilio-webhook v14 (session 16)
- ~~CloudPRNT integration~~ ✅ — `print_jobs` table + `cloudprnt` edge function live (session 22). Configure via Admin → Settings → Receipt Printer.
- Route picker fine-tuning — continuing session 8 (edge cases, UX polish)
- Xero accounting sync
- Klaviyo marketing integration
- ~~Design decision: customer-initiated skips + `cancelled_by` field~~ ✅ — fully implemented session 5
- ~~Customer email receipt (SendGrid)~~ ✅ — confirmed working
- ~~Live driver tracking~~ ✅ — GPS tracking live (driver app → Supabase Realtime → admin map)
- ~~Same-day delivery option~~ ✅ — live in customer app for AM routes; toggle bug fixed session 8 (`selectSchedPickupDate` was missing the same-day check)
- ~~Vercel deployment~~ ✅ — Vercel auto-deploys on push to main

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
0706362  feat: customer app — Skip this pickup button for recurring orders
7d7a09e  ux: Issues tab — issue type labels, one-click actions, retry charge
d884169  feat: cancelled_by field — distinguish customer vs driver vs admin skips
1980b60  docs: note customer-initiated skip design decision + recurring chain bug
ba5426a  ux: payment indicator — left-side $ badge, PAY FAILED label, Issues tab inclusion
b55bb28  docs: update project notes after P3 bug fixes (Mar 14 session 4)
0930719  Fix Bug #8: skip-notification banner no longer says "Customer notified"
da2b299  docs: update project notes after P2 bug fixes (Mar 14 session 3)
61fdd7a  docs: update project notes after e2e test + bug fixes (Mar 14 session 2)
7916331  Fix driver app stop reassignment and Order Schedule realtime sync
a9344c4  fix: sign-out feedback + expose toggleSameDay on window
1e35b36  feat: realtime sync for processing queue (admin + laundry tech)
00ecac1  docs: update project notes after same-day delivery feature
6eb9426  feat: same-day delivery option for AM pickup routes
751baba  Fix: await credit deduction + catch last_order_at sync errors
3bfc4b8  Light blue kanban header bar, white column backgrounds
92d8631  Unify kanban columns to light blue palette
0b3ee9e  Fix Process Order button not working on iPad touch devices
73284c6  Brighten kanban column colors and restore one emoji per column
be8c75b  Add subtle muted color tints to kanban columns
08ee95e  Redesign kanban board: professional neutral palette, centered tech-mode logo
22310bc  Add full-screen tech mode for Laundry Tech on iPad
db92fdc  Move permissions grid to its own tab on Team page
2d41a90  Add role-based access: Admin, Manager, Laundry Tech with permissions grid
5f97573  Low-priority QA cleanup: dead email code, no-phone warning, smart address labels
57e0475  Fix new addresses not being saved on customer app orders
410a257  Add customer search to SMS compose modal
09605c0  Remove email view from Inbox — SMS only for now
dbbe34c  Remove nav sidebar badges except Inbox
0046f69  Add reassignment tags and driver name display to Order Schedule
c34d575  Fix driver message compose bar hidden behind bottom nav
07a0cb0  Fix XSS: HTML-escape routing_error in order detail panel
fc94f6c  Simplify system: single driver model, status sync, routing errors
5661355  Remove Default Driver — Driver Schedule is sole source of truth
fd28b94  Move Driver Schedule to Orders page, unify driver assignment
764d05c  Add live driver GPS tracking
d0f073a  fix: QA — explicit null for route color fallback, Assign link contrast
bca66a7  ux: Assign link visible on address line instead of hidden interaction
5995230  ux: monochrome avatars across all pages
3d52f05  feat: Assign via P/D circle, map 50% taller, dark gray circles, template route colors, All Routes view
daf809f  (earlier today) driver app fixes, Daily Schedule redesign, payment indicators
030ada6  feat: auto-fail expired orders + driver app time-window filtering
b277677  feat: configurable booking cutoff per route template
dfc203e  docs: standardize on "Route" terminology, retire "run" from notes
6c7ccbd  docs: add test order SQL template to PROJECT-NOTES
957d1c5  feat: move order routing from client JS to DB triggers
791cc6f  fix: complete route assignment for customer-placed and admin-created orders
b34909d  notes: update session log for Mar 12 — logout-on-refresh final fix
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
