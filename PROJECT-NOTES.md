# WashRoute — Project Notes
*Last updated: Mar 10, 2026*

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

## Database Key Tables

| Table | Notes |
|---|---|
| `customers` | `phone_cache` stores phone in any format (e.g. `(415) 608-5446`) |
| `orders` | Status pipeline: scheduled → ready_for_pickup → assembled → ready_for_delivery → out_for_delivery → delivered |
| `routes` | Route templates (recurring schedule) |
| `route_stops` | `driver_id = NULL` means inherit route default; set = individual override |
| `sms_messages` | All SMS in/out. `direction`: inbound/outbound. Linked to `customers` by phone matching |
| `driver_messages` | In-app admin ↔ driver chat (not SMS) |

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

### How it works
A Postgres function `create_recurring_orders()` runs every day at **8 AM UTC** (midnight Pacific) via pg_cron.

For each customer's most recent recurring order, it:
1. Calculates the next pickup date (weekly +7d, biweekly +14d, monthly +30d)
2. If that date is **within 7 days**, checks whether an order already exists in that window
3. If not, creates a new `scheduled` order copying all the key fields from the previous one

The function is idempotent — running it multiple times won't create duplicates.

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

---

## Pending / Next Up
- ⚠️ Twilio verification / A2P 10DLC registration (SMS delivery fix)
- Receipt printing: print button on order detail (thermal 80mm bag tag) — mockup exists at `receipt-mockup.html`
- ~~Customer email receipt (SendGrid)~~ ✅
- SMS/email automation — Phase 1: status check auto-replies (see section above)
- Live driver tracking (Google Maps)
- Xero accounting sync
- Klaviyo marketing integration
- Vercel deployment

---

## Git Log (recent)
```
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
