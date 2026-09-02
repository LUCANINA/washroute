# WashRoute — Feature Status & History (STALE — VERIFY BEFORE TRUSTING)

> ⚠️ **This file lags.** `Recently Completed` stops around **session 195** and the
> project is well past that. In session 213 this gap caused three migrations to be
> named `session_196_*` when they belonged to session 213.
>
> **`PROJECT-NOTES.md` is the source of truth.** Treat every claim here as a hint to
> verify, not a fact. Before naming any migration, read the `*Last updated:` line at
> the top of PROJECT-NOTES.md.

## Completed Features

### Admin Dashboard
- Customer management (lifetime value, repeat rate, at-risk flagging)
- Orders: status pipeline tabs, click-to-change status badge, batch Advance Status, cancel = hard delete, pickup/delivery rescheduling, batch SMS
- Routes: template editor, live map, stop reassignment, weekly schedule (time-banded rows)
- Inbox: real Twilio SMS conversations, realtime updates, reply, compose new
- Driver Messages: in-app chat (separate from SMS)
- Services & Pricing, Reports, Notifications all built
- Login form wrapped in `<form>` with `autocomplete` attributes (fixes Chrome warnings, enables password manager)
- Notification templates: all 13 SMS types in `message_templates` table, editable in admin UI
- `send-order-notification` Edge Function reads templates from DB + interpolates `{{tags}}`
- Photos-as-links: `route_stops.proof_photo_url` → plain-text link in SMS body (no MMS needed)
- Scheduled reminders: pg_cron → `send-scheduled-reminders` Edge Function for day-before, day-of, reorder
- Billing retry flow (session 70h): 3-way button logic — "Request card" / "Retry charge" / "📞 Update card" based on `charge_failed_at` vs card `created_at`
- CloudPRNT receipt printing: Star Document Markup natively to mC-Print3, 2 copies, auto-print on intake
- Credit ledger integrity (session 128): every write to `customers.credits` is paired with a `customer_transactions` insert. 4 writers exist — customer panel add/deduct, Bill Orders → credit (tips included), saveRacking tip-from-credit, saveIntake credit-at-intake. Fully-credited orders with tips route to credits-first, card-fallback, or Issues-tab-failure — tips can never silently disappear.
- Override-template zone integrity (session 129): `trg_create_recurring_order_fn` re-resolves `zone_id` from `customers.route_template_override_id` on every recurring cycle, so a single manual mis-booking can't poison the customer's entire recurring chain.
- Route Command Center "Optimize" button (session 129): `optimize-route` v22 deployed with `verify_jwt: false` so the Supabase gateway stops rejecting the call with HTTP 401. All WashRoute edge functions now follow this pattern and handle auth internally via `SUPABASE_SERVICE_ROLE_KEY`.
- Null-coord address prevention (session 130): all 4 `addresses` INSERT paths now guard against saving an address without lat/lng. Admin `saveIntake` and `saveNewAddress` show a confirm dialog ("could not verify this address — save anyway?"); customer `saveAddressForm` and order-placement flow run a Google-geocoder fallback and then hard-block if no coords.
- Missing-coords warning banner (session 130): admin Orders → Map render loop surfaces any stops with null-coord addresses via a yellow "N stops not on map — [Fix now]" banner; Fix-now button batch-geocodes the affected addresses and refreshes routes.
- Map fullscreen mode (session 130): Orders → Map has a Maximize button + Escape key that toggles `body.map-fullscreen`, hiding the sidebar, topbar, and List/Map tabs and stretching the map to 100vh. Auto-resets on page change.
- RCC polish (session 130): progress bar and misleading "X done" badge removed from route column headers; en-route stops now included in ETA auto-refresh + optimize gating; discrete en-route tag added to stop cards; AM/PM toggle + smaller route chips on Map view; moving a stop to another route now clears any stale `driver_id` override (plus DB trigger guard); driver app auto-reloads when an inherited-stop (`driver_id=NULL`) is moved onto my route.
- Permanent overcapacity solution (session 131): three-phase release. **Phase 2 (DB, `session_130_phase2_safe_overrides`):** `auto_route_order`, `sync_pickup_stop_on_window_change`, and `sync_delivery_stop_on_window_change` now accept a soft ceiling of `GREATEST(stop_limit+1, FLOOR(stop_limit*1.25))` per sub-window; stops booked into the override range get `orders.overcap_booking = TRUE`; beyond the ceiling still hard-blocks with `routing_error`. **Phase 1 (admin):** Routes tab shows a "+N over" badge on any route whose active-stop count exceeds its `stop_limit` — purely cosmetic, surfaces the exact subset of `overcap_booking = TRUE` stops to the owner. **Phase 3 (customer-app, `session_131_phase3_nearest_slots`):** `get_nearest_available_slots(zone_id, preferred_date, preferred_time, stop_type, limit, day_radius)` RPC returns the 3 closest open sub-windows around the customer's pick so booking never dead-ends on "full." Phase 2 patch `session_131_phase2_skip_stop_limit_zero` hardened the three functions to gate on `stop_limit IS NOT NULL AND > 0` so dedicated commercial routes (see `stop_limit = 0` convention below) aren't false-flagged.
- **`advance_order_status` reroute-on-reopen fix** (session 191): reopening an order from `on_hold` back to `scheduled` now auto-reroutes via `auto_route_order` whenever a run_id is still null, instead of silently clearing `routing_error` and leaving the order invisible with no route_stops. Known follow-up (Known Issues #30, not yet fixed): reopening from `pickup_failed`/`delivery_failed`/`skipped`/`cancelled` can still leave a *stale non-null* run_id pointing at a dead stop.
- **Route Command Center press-and-hold solo view** (session 191): holding the eye icon on any open route (~450ms) hides every other open route so only that one shows; holding again restores them all. Click still does the normal single-route visibility toggle. `rccEyeDown`/`rccEyeUp`/`rccEyeCancel`/`_rccIsRouteSolo`/`rccSoloRoute` in `admin-dashboard/index.html`.
- **Pickup/delivery SMS notify race fixed** (session 194, migration `session_194_fix_pickup_delivery_sms_notify_race`) — see Known Issues #31. `complete_route_stop` now calls `advance_order_status` BEFORE marking the stop complete (previously after, which let `sync_order_status_from_stops` race ahead and silently kill the SMS + mis-attribute the event to `'System'`). `sync_order_status_from_stops` now routes through `advance_order_status` as a safety net instead of writing `orders.status` directly.

### Driver App
- Route loads by driver login
- Stop detail: address, customer info, special instructions
- Google Maps navigation (standard link, no API key)
- Mark pickup/delivery complete + optional photo proof
- 📲 On My Way button → customer SMS + `en_route` status
- Undo complete
- Skip stop (with confirm sheet + undo bar)
- Failed Pickup button (pickup stops only) → notifies customer, flags for admin rescheduling
- Can't-Complete-Stop branching (session 129): `cantCompleteStop()` branches on `isPickup` and writes `pickup_failed` or `delivery_failed` accordingly. Prevents failed-delivery customers from getting a "we couldn't pick up your laundry" SMS and prevents the recurring trigger from firing on a failed delivery. New `delivery_failed` `message_templates` row + explicit EVENT_TO_TRIGGER mapping in `send-order-notification` v28.
- Live GPS tracking → Supabase Realtime → admin map (12s interval, `driver_locations` table)
- Capture-now-upload-later photo queue (session 70e): IndexedDB + background upload with retry

### Customer App
- Full booking flow: address → date/time → preferences → confirm + pay
- Same-day delivery toggle for AM pickups (⚡ "Want it back tonight?") — eligibility via `turnaround_hours` on route template
- My Orders: Current tab (active) + Past tab (delivered/skipped/pickup_failed/cancelled)
- Order detail: pickup date, compact time slots, skip button (recurring orders)
- Delivery address removed from customer flow — admin can still set different delivery address; customer sees read-only note if so
- SendGrid email receipts: confirmed working
- Phone number required on all registration paths (session 70f)

### POS (Foothill, session 139)
- **Login:** `foothill@familylaundry.com` (renamed from `pos-foothill@…` in session 139). Shared device account; cashiers enter their personal PIN after device sign-in.
- **Refund flow** — `↩` button in topbar opens recent walk-in sales (last 30, card + cash). Tap a sale → confirm modal with editable amount input (defaults to full remaining, allows partial). Auto-refunds remaining balance: Stripe refund for card, bookkeeping-only for cash. Customer-attached orders also get a `customer_transactions` refund row + `customers.lifetime_value` decrement (mirrors admin's `refund-charge`). Edge function: `stripe-terminal` v9 actions `list_recent_pos_sales`, `refund_pos_payment`.
- **Queue order delete** — tap card → blue highlight + red Delete button → confirm modal with refund preview. Auto-refunds remaining balance, hard-deletes the order, FK cascades clean up events/items/folding. Restricted to `processing` / `ready_for_delivery` walk-in orders. Edge function: `stripe-terminal` v9 action `delete_pos_order`.
- **Already-refunded handling** — when delete is invoked on an order already fully refunded, no second Stripe call fires (`needsRefund = remaining > 0` guard). Modal shows "Already refunded — $X.XX has already been refunded" before delete.
- **Spanish toggle** — circular EN/ES button next to cashier badge. Per-device localStorage persistence. ~290-entry translation table covering topbar / cart / payment modals / queue / refund flow / delete flow / errors / customer attach / merchandise category names. DB product names + customer names stay as stored.
- **Retail terminology** — every user-facing "Walk-in" → "Retail" (DB value `source='walk_in'` is unchanged; that's the stable identifier). Admin-side `_serviceLabelForOrder(o)` helper returns "Retail - Wash & Fold" for POS orders by parsing `line_items`.
- **Auth boundary for refund/delete** — `pos_shifts.ended_at IS NULL`. Anyone with the public anon key + an open shift_id can refund/delete walk-in orders. Matches David's "anyone signed into the POS" intent. Internal-trust model.
- **Double-submit guard** — `chargeAndFinish` has a module-level `_chargeInFlight` boolean lock. Prevents fast double-tap on Complete sale from creating two orders. Bulletproof regardless of which payment surface fires.
- **Walk-in SMS** — `walkin_order_placed` (auto on charge) + `walkin_order_ready` (when admin flips card to ready_for_delivery). Both gated by `message_templates.sms_enabled`.
- **Multi-site (sessions 149 pt 3 + 150 pts 4/5) — LIVE.** Two sites in DB: 23rd Ave (default, teal) + Foothill Blvd (coral, active). `pos_devices.site_id NOT NULL` (Foothill Register → Foothill Blvd). The `pos_order_read` RLS policy admits two cases: (a) walk-in orders on this device's open shift, (b) ANY active-processing order (`picked_up`/`processing`/`folding`/`ready_for_delivery`) where `orders.site_id = device.site_id`. `customers.default_site_id` auto-tags new orders via the `set_order_site_on_insert` trigger. Foothill Retail Queue shows the delivery orders that come in via driver pickup with a "🚚 For delivery" badge. POS intake panel (session 150 pt 5) handles them end-to-end via `record_order_intake` RPC — same door admin uses, same line_items shape. **Tech debt:** POS `currentSiteId` still reads from localStorage, not the device row — UI dropdown can claim a different site than the device's true site, but RLS catches it server-side. Worth tightening when a second device exists.

---

## What's Pending (in rough priority order)

0. **🔴 Session 227 security follow-ups — top of the list.**
   a. **Four hardened edge functions are written but NOT deployed** — `send-scheduled-reminders`,
      `bookkeeping-kpis`, `health-monitor`, `sync-klaviyo`. Each is called by a pg_cron job that
      sends the ANON key, so deploying as-is kills the job silently. Ready-to-apply code plus the
      two unblock options are in `proposed-migrations/session-227-edge-hardening/README.md`.
      Until then: `bookkeeping-kpis` still returns the full Xero P&L to an unauthenticated caller
      via `{"source":"pg_cron","debug_rows":true}`, `send-scheduled-reminders` can still be
      triggered by anyone to mass-text every customer, and `sync-klaviyo`'s secret
      (`wr-klaviyo-sync-9x2`) is still in git history and must be rotated.
   b. **~200 unescaped `innerHTML` interpolations across the four apps.** Sharpest: the admin
      inbox pre-fills a Create-Issue `value=""` attribute with the raw body of the most recent
      INBOUND SMS (admin ~line 22049), and the driver app renders `sms_messages.body` raw
      (driver ~line 4348). Anyone can write that field by texting the business number, and both
      surfaces hold a staff session in `localStorage`. `driver_messages.body` (admin ~38390) and
      `special_instructions` on five Processing surfaces are the same class.
   c. **`escJS()` and `svcEsc()` are broken helpers** — `escJS` doesn't escape `&`, `svcEsc`
      doesn't escape `'`, and two local `esc` shadows (admin ~24148, ~24161) don't escape `<`/`>`.
      ~19 inline `onclick` handlers use them. `escAttrJSArg()` (admin ~21551) is the only correct
      one. Also `esc(x).replace(/'/g,"\\'")` is a no-op — `esc` already turned `'` into `&#39;`,
      which the HTML tokenizer decodes back to `'` before the JS parser sees it.
   d. **Admin `batchSendSMS` ignores both opt-out columns** (~19981) and has no confirmation
      dialog. Its sibling `rccBatchSendSms` filters correctly — copy that.
   e. **`exec_sql` RPC does not exist** but the admin health-check panel calls it (~15222), so
      that check has always silently failed. Either drop the call or write the read-only RPC.
   f. **Neither refund path passes a Stripe `idempotencyKey`** (`refund-charge` ~150,
      `stripe-terminal` ~340) and both over-refund gates are read-check-write. A double-click or
      a timeout retry can refund twice. `charge-order` was already hardened for this.
   g. **`_to_delete/` is at 104 files / 1.7 MB** — David: `rm -rf _to_delete` from Finder/Terminal.


1. **POS intake v2 backlog** (session 150 pt 5) — current panel handles weight + bag count + auto base/overage + preserved booking line items. Add-on prefs (Vinegar, Oxi at counter), discount application, credit-at-intake, and same-day-surcharge UI deferred. Wait for operational signal from Foothill attendants before building — may not be needed at the counter.
2. **POS `currentSiteId` from localStorage** (session 150 pt 4) — UI dropdown can claim a different site than the device's true `pos_devices.site_id`. RLS catches it server-side (writes always honor the device's stored site), but the UI/DB inconsistency is worth tightening when a second device ships. Read `currentSiteId` from `pos_devices.site_id` at load and hide the dropdown when a device is permanently assigned.
3. **POS refund + delete edge actions are not transactional** (session 139) — `refund_pos_payment` and `delete_pos_order` in `stripe-terminal` v9 do multi-step DB ops (Stripe refund → customer_transactions insert → orders update / delete → LTV update) without wrapping in a Postgres transaction. If any later step fails after Stripe succeeds, prior steps stay applied. Acceptable for now (single-cashier-per-device workflow makes races near-impossible) but worth a refactor: extract the DB portion into a single SECURITY DEFINER RPC the edge function calls AFTER the Stripe refund clears.
4. **`profiles.email` has no auto-sync trigger from `auth.users.email`** (session 139) — when an auth email is renamed (rare, but happened in session 139 pt 6), the denormalized `profiles.email` cache stays stale. Caught the gap manually for the Foothill device rename. Worth a small migration: `CREATE TRIGGER sync_profile_email_on_auth_change AFTER UPDATE OF email ON auth.users FOR EACH ROW EXECUTE FUNCTION ...`. Low priority — rarely-needed safety net.
5. ~~`washroute-audit.skill` exclusion list keys on email, not UUID~~ — **✅ Done, fixed session 148.** Check 12 now filters by `au.id NOT IN (<uuid list>)` (rename-proof) instead of email. Verified directly against the current skill content during the August 15, 2026 CLAUDE.md/skills/guardrails audit — this item was stale and had been sitting unresolved in this list since session 139 despite being fixed 9 sessions later. See "How to Update Skills" below and `washroute-changelog` Step 2.6 — pending items need to be spot-checked against actual code/skill state before being left in this list, not just added to and never re-verified.
6. ~~RPC refactor — 7 RPCs left from the session 135 audit~~ — **✅ Done, all shipped session 136** (`complete_route_stop`, `record_order_intake`, `rack_order`, `mark_orders_paid`, `recall_delivered_order`, `adjust_customer_credits`, `save_order_address`). See the "Shipped RPCs" table under Architectural Mutation RPCs — the numbered list further down in this file is historical only. Small extension on #1 (`p_clear_route` flag for `_opShiftDeliveryWindow`) status unconfirmed — verify before assuming still open.
7. ~~Admin rollback-to-on_hold path~~ — **✅ Done.** `rollback_order_to_on_hold` RPC exists and is in active use (e.g. session 191's live verification test).
8. **Driver `triggerUndo`** (driver-app line 2943) — reverse op, not forward advance. Could be its own narrow RPC (`undo_stop_completion`) when we ship `complete_route_stop`.
9. SMS/email automation — Phase 2: natural-language cancellations ("cancel Thursday")
10. Driver app duplicate prevention — line 1764 auto-create fallback needs `profile_id` uniqueness guard (tech debt from session 70h)
11. `paid_at` gap on credit-card orders (session 128 follow-up) — 278 credit-card-paid orders are missing `paid_at` because `supabase/functions/charge-order/index.ts` (line 228) + two admin paths (`admin-dashboard/index.html` lines 16007, 16121) and `stripe-webhook/index.ts` (line 260) never set it. Fix: add `paid_at: new Date().toISOString()` to those four sites, redeploy `charge-order`, and `UPDATE orders SET paid_at = COALESCE(paid_at, billed_at) WHERE billing_status='paid' AND paid_at IS NULL AND billing_payment_method IN ('credit_card','credit')` to backfill.
12. Xero accounting sync
13. Klaviyo marketing — Phase 1 LIVE (welcome + $15 laggard flow, real-time Placed Order events, signup consent fixed session 174). Remaining: admin UI toggle for `sms_notifications_opt_out_at`; restrict WELCOME15 to first order (currently unlimited reuse); verify Day-17 laggard leg has its own 14-day Time Delay; consider one-off campaign for the 16 profiles permanently skipped before the 3-day delay was added; Phase 2 Loyalty Milestone (designed, not built — MUST backfill prior milestones before launch).
14. ⚠️ **stripe-webhook deploy pending** (session 174) — repo source has the `sms_notifications_opt_out_at` dunning-SMS gate but production does NOT. Whoever next touches stripe-webhook must deploy from repo (repo is ahead of production).

## Recently Completed
- ⚠️ **This list stops at session 195 and is NOT maintained. Read PROJECT-NOTES.md for anything after that.** Kept only because a few entries below carry design rationale that hasn't been restated elsewhere.
- ✅ **Session 213 (Aug 16, 2026) — Subscription customers charged pay-as-you-go overage (2 customers, root-caused into `link_subscription_on_order_fn` + both intake apps); then `refund-charge` found mis-recording every partial refund as a full one — fixed via the new `record_order_refund` RPC + an 87-order backfill. See PROJECT-NOTES.**
- ✅ **Session 195 (July 31, 2026) — Fixed stale/self-referencing `moved_from_route_id` badge on route stops. See PROJECT-NOTES for full writeup.**
  - **Root cause:** `reconcile_order_stops`'s "reuse a skipped/failed stop" branch (ELSE arm) repointed a reused stop's `route_id` to the new target route but never updated `moved_from_route_id` — unlike the sibling "keeper" branch. A stop moved away from route A, then skipped, then later reused and reassigned back onto route A ended up with `route_id = A` and a stale `moved_from_route_id = A`, producing a self-referencing "↩ moved from Hayward" badge on a stop that was never actually moved this time (admin-dashboard's badge renderer, ~line 24106).
  - **Fix (migration `session_195_fix_reconcile_order_stops_stale_moved_from`):** the reuse branch now captures the reused stop's prior `route_id` and sets `moved_from_route_id` with the same `IS DISTINCT FROM` logic the keeper branch already used. One-time cleanup nulled the 7 historical self-referencing rows (all dating to May 20, 2026). Verified live: self-reference count query returned 0 post-fix, confirmed on the specific flagged order. See Known Issues #32.
- ✅ **Session 194 (July 31, 2026) — Fixed system-wide outage of pickup/delivery confirmation SMS (0 of 89 sent since 7/30 14:54 UTC). See PROJECT-NOTES for full writeup.**
  - **Root cause:** `complete_route_stop` marked the route_stop `'complete'` before calling `advance_order_status`; that UPDATE fired `sync_order_status_from_stops`, which wrote `orders.status` directly for the common single-stop case, so `advance_order_status` always saw a no-op transition and never fired the SMS. Existed since ~session 137 (April) but was masked by driver-app's own client-side SMS `fetch()` call until session 189 (7/29) centralized notification-sending server-side — which is what turned the latent race into a full outage.
  - **Fix:** reordered `complete_route_stop` to call `advance_order_status` first; hardened `sync_order_status_from_stops` to route through `advance_order_status` instead of a raw UPDATE. Verified live via a rolled-back transaction. See Known Issues #31.
- ✅ **Session 191 (July 30, 2026) — Fixed `advance_order_status` reroute-on-reopen bug + shipped RCC press-and-hold solo view. See PROJECT-NOTES for full writeup.**
  - **Root cause (Kidango - Mayfair Too's order disappearing):** reopening an order from `on_hold` to `scheduled` cleared `routing_error` without ever calling the routing engine, so an order that had lost its route_stops landed back in `scheduled` invisible to both the RCC and Issues tab. Fixed in `advance_order_status` (migration `session_191_advance_order_status_reroute_on_reopen`); verified live on a second affected order.
  - **New feature:** press-and-hold (~450ms) on any RCC route's eye icon solos that route, hiding all others; holding again restores them. Click still does the normal toggle.
  - **Known follow-up, not yet fixed:** reopening from `pickup_failed`/`delivery_failed`/`skipped`/`cancelled` (not `on_hold`) can still leave a stale non-null run_id (Known Issues #30).
- ✅ **Session 174 (June 11, 2026) — Klaviyo pipeline fixed + per-customer SMS kill-switch + 2 new Kidango centers. See PROJECT-NOTES for full detail.**
  - **Klaviyo consent leak fixed:** the booking-flow signup ("Create Account & Place Order") had NO email-consent checkbox — 15 of 17 June converters never reached Klaviyo. Added `c-email-consent` checkbox, wired through signUp metadata + `ensureProfile` (now also calls `subscribeKlaviyoWelcome`), and `claim_existing_customer` gained `p_email_consent` (old 7-arg version DROPPED — PostgREST overload ambiguity; def snapshotted in `_archive`). 25 missed signups backfilled (Email List 23→48).
  - **Laggard-flow diagnosis:** the $15-off emails never sent because the flow was missing its 3-day Time Delay — Email #2 fired seconds after the welcome and Smart Sending silently skipped everyone (these skips do NOT appear in the Skipped Send event log). David added the delay. Klaviyo flow-card "Placed order %" = ATTRIBUTED conversions only — never compare to the admin Registrations report.
  - **`customers.sms_notifications_opt_out_at`** (migration `session_174_sms_notifications_opt_out`): when set, ALL automated SMS are suppressed — reminders (send-scheduled-reminders v26), order-status (send-order-notification v41, gate AFTER the Klaviyo block), driver on-my-way (notify-on-my-way v31; stop still goes en_route). Manual Inbox sends unaffected. Set for all 18 Kidango sites. send-scheduled-reminders + notify-on-my-way are now IN THE REPO (were deploy-only). No admin UI toggle yet.
  - **2 new Kidango centers:** Russo (San Jose) + Hillview Crest (Hayward) — orders #7070/#7071, weekly Thu 7–11am pickup / Fri delivery from Jul 9, `recurring_anchor_at` set, mirrored Dayton's conventions, auto-routed cleanly.
- ✅ **Sessions 172–173 (June 10, 2026) — large feature day. See PROJECT-NOTES for full detail.**
  - **`written_off` billing status** (session 172): mark uncollectible delivered orders; excluded from unpaid widget, customer balance, on-account report, in-app audit Check 3 + the `washroute-audit` skill Check 3/3b. Grey "WRITTEN OFF" badge in `_payStatusIcon`.
  - **Reports — Registrations Delivery/Retail tabs**; **New Delivery Customers** widget excludes `referral_source='pos_walkin'`.
  - **POS lifetime_value fix** (`trg_record_pos_sale_ltv`): walk-in POS paid sales now bump `customers.lifetime_value` + write a `customer_transactions` charge row (backfilled 130 orders / 98 customers).
  - **Subscriptions → Usage Trends** rebuilt as monthly comparables. **New Delivery KPIs report** (`delivery_kpis(p_from,p_to)` + `_dk_window`/`_dk_retention` RPCs): conversion, spend/order, rev/order incl. subs, avg LTV, pounds processed, driver stops/hr, **avg pounds processed/hr (launderer Square hours)**, 1/2/3/6-month retention, active customers, sub churn. Compares to SAME dates one month earlier. ⚠️ per-hour route metrics depend on `routes.started_at`+`completed_at` which are sparsely logged pre-May 2026.
  - **Global Quick Range** bar on all report tabs (`setRptQuickRange`).
  - **Holidays feature** (session 172): see Key Tables. Admin General → Holidays; recurring/SMS shift one-time via `recurring_anchor_at`; customer-app greys dates.
  - **Account freeze** (session 173): `customers.frozen_at` + `trg_enforce_not_frozen`. Frozen = no new orders (UI scope only; unfreeze via `UPDATE customers SET frozen_at=NULL`).
  - **Order archive used for unpaid declutter** (session 173): `archived_at` hides from Overview unpaid widget + audit Check 3 (not written off, still collectible).
  - **Customer panel: Notes tab → Issues tab** (session 173): `loadCpIssues` shows per-customer `cs_issues` history; migrated `customers.notes` (the COLUMN — NOT `preferences._notes`) into cs_issues. ⚠️ QA-caught: first attempt migrated the wrong field + crashed panel open; both fixed (commit `05a0d76`).
  - **Customer booking delivery-before-pickup fix** (session 173): delivery alt-slots hard-filter `run_date > pickupDate`; `selectSchedWindow` resolves by `slotStart` (not a pickup-day index); submit-time guard auto-corrects.
  - **DEPLOY PIPELINE FIXED**: GitHub→Vercel reconnected; a plain `git push` auto-deploys again (no manual hook needed). Keep "Require Verified Commits" DISABLED in Vercel or unsigned commits get refused.

- ✅ **Session 142 — Starchup migration finishing touches + POS polish (May 4, 2026)**
  - Migrated 24 fixed-dollar discount codes from Starchup to WashRoute (post-2025-01-01, 5-letter codes only). 15× $250, 8× $100, 1× $50. Skipped WY3QW (already in DB), all percentage codes, single-use ORDER credits, and pre-2025 codes per David's spec.
  - Admin Discounts page: added "Date Created" column with header row. Added between Code and the upstream-shipped Redeemed/Last Use columns. Layout is now `CODE | CREATED | REDEEMED | LAST USE | [Archive]`. No query change — `loadDiscounts()` already does `select('*')`.
  - POS iPad layout: removed the desktop-preview "device" mockup wrapper that was drawing a fake black bezel + rounded corners around the POS at every viewport. The `.device` + `.device-screen` containers now collapse to 100vw × 100vh unconditionally (max-width: none, padding: 0, border-radius: 0, transparent bg). Recovered ~30-40px of edge real estate on iPads. Removed dead helper classes (`.page`, `.page-header`, `.page-title`, `.page-sub`, `.screen-label`).
  - POS sales tax label: was hardcoded `<span data-i18n>Tax (9.25%)</span>` even though `TAX_RATE` was loaded dynamically from `settings.sales_tax_rate` since session 140 (actual rate is 0.1075). Math was always correct — only the visible label lied. Replaced with `<span id="taxLabel">` populated by new `refreshTaxLabel()` helper called from `loadTaxRate()` and `applyTranslations()` so language toggle reformats correctly. Spanish translation simplified from `'Tax (9.25%)' → 'Impuesto (9.25%)'` to just `'Tax' → 'Impuesto'`.
  - POS receipts reworked for the laundering team workflow (printed receipt doubles as a bag tag): (a) customer name now leads the ticket at size 2:2 bold uppercase centered — the largest thing on the page — with order number + timestamp below, store header demoted to footer; (b) `queuePosPrintJob(order, copies = 2)` defaults to 2 copies per sale (one for customer, one for bag tag), capped at 5; (c) Retail Queue cards now reveal a side-by-side `🖨 Reprint receipt | ✕ Delete order` action row when tapped (extends the existing 3-step delete flow). New `reprintQueueOrder(orderId)` helper queues a single copy. Receipt builders updated to prefer `order._customerName` so reprints work without swapping the active-cart globals.
  - Recovered from a stale-lock + diverged-branch git state mid-session (cleaned `.git/HEAD.lock` + bad `refs/remotes/origin/main.lock.s140p1d.stale`, rebased on top of session 141 pt 12's discount-page upstream changes, manually merged the column-layout conflict).
  - Commits `fef8870` (Date Created column), `2e772b8` + `3f7c98a` (POS fullscreen — second commit removed desktop preview exception so frame is gone everywhere), `9698def` (tax label fix), `b4e0859` (receipts + 2x copies + queue reprint).

- ✅ **Session 139 — POS hardening sweep + Spanish + retail rename + Foothill email rename**
  - Double-submit fix on Complete sale (module-level `_chargeInFlight` lock).
  - Refund flow: card + cash, full + partial, with already-refunded recognition. New `orders.amount_refunded NUMERIC(8,2)` accumulator + stripe-terminal v9 actions `list_recent_pos_sales`, `refund_pos_payment`.
  - Queue order delete: 3-step UX (select → delete → confirm) with auto-refund. stripe-terminal v9 action `delete_pos_order`. Restricted to in-queue walk-in orders.
  - Retail/walk-in user-facing rename (DB value unchanged). Admin `_serviceLabelForOrder(o)` helper renders "Retail - Wash & Fold" for POS orders in customer panel + folding/cleaning kanban.
  - Spanish localization: circular EN/ES toggle, `t()` helper, ~290 translations, `data-i18n*` attributes on static markup, dynamic JS wrapped at ~318 sites.
  - Foothill device email rename `pos-foothill@familylaundry.com` → `foothill@familylaundry.com`. Updated all 3 layers: auth.users + auth.identities + profiles. Audit skill exclusion list synced.
  - End-of-session XSS fix: added `esc()` helper to POS, applied to 4 innerHTML render paths (refund list / refund confirm / delete confirm / queue card) where DB-sourced customer names + descriptions previously interpolated raw.
  - Commits `958c506`, `8eeb000`, `a8c455f`, `60913ce`, `bc93dfc`, `628b478`, `35be74e`, `143d705`, `481c4b0`, `81e5b01`. DB migrations: `session_139_orders_amount_refunded_accumulator`. Edge function: stripe-terminal v9.
- ✅ **RPC #2 `advance_order_status` shipped (session 135)** — second architectural mutation RPC. Replaces 8 raw `db.from('orders').update()` status-change sites (admin opSkipOrder + opSetOrderStatus forward + batchSetStatus + batchAdvanceStatus + setSingleOrderStatus + advanceOrderStatus, driver completeStop + cantCompleteStop). Enforces `picked_up→actual_pickup_at`, `delivered→actual_delivery_at`, skip/cancel/fail→`cancelled_by`, forward→clear `routing_error`, driver bag adjust atomic with status, attributed events. Caught a latent bug (batchSetStatus/batchAdvanceStatus didn't stamp cancelled_by on skip/cancel/fail). Migration `session_135_advance_order_status_rpc`. Commit `3d76e6e`.
- ✅ **`auto_route_order` hotfix (session 135)** — function still had two `INSERT INTO routes (..., date, ...)` references after session 134 pt 11 dropped that column. Any booking needing a fresh route run on the fly would have crashed. Surfaced while testing RPC #2; patched via `session_135_auto_route_order_drop_date_column_refs`. New "audit pg_proc after column drops" lesson added to this skill.
- ✅ **RPC #1 `reschedule_order_leg` shipped (session 135)** — first architectural mutation RPC born from the post-mortem on a customer-facing bug. Replaces 6 raw `db.from('orders').update()` window/route sites across admin + customer-app. Enforces window-in-template, run_id sync, route_stops repointing, status reset on re-routing of pickup_failed/on_hold/delivery_failed, attributed `rescheduled` + `routed` events. Auto-snaps window when route changes without explicit window. Migration `session_135_reschedule_order_leg_rpc`. Commit `85055d0`.
- ✅ **DB trigger `enforce_window_in_route_template` (session 135)** — BEFORE UPDATE on `orders` rejects any window UPDATE that lands outside the assigned route's template window unless the run_id is also changing. Catches today's customer-facing bug (Jeanbaptiste #3128 — customer-app `saveEditOrder` updated window without run_id, customer waited at 7 AM for a PM-routed pickup). Backstops the RPC pattern. Migration `session_135_window_in_route_template_guardrail`. Commit `3d114b4`.
- ✅ **RPC refactor audit doc (session 135)** — `RPC-REFACTOR-AUDIT.md` in repo root: 75 raw `.update()` sites scanned across 3 apps, grouped into **9 conceptual mutations**, ranked by risk × frequency × bug history. Roadmap for the architectural pass kicked off after session 135's customer-facing bug. Commit `766215b`.
- ✅ **Itay Levy overseas-guest booking (session 135)** — Israeli tourist at Beacon Hotel SF needed laundry. Walked through admin-create-and-book path (no US phone). Order #3173 routed to SF route (Fri 7-10 PM pickup → Sat 7-10 PM delivery). Demo of how to handle email-only one-off international guests without changing the customer-app's phone-required signup. Hit + fixed a duplicate-customer issue mid-flow (David had created Itay via admin while Claude was creating via DB; merged onto the earlier record per session 124 convention).
- ✅ Permanent overcapacity solution (session 131) — three-phase release. Phase 2: DB now allows soft overrides up to 125% of `stop_limit` per sub-window, flags booked stops with `orders.overcap_booking = TRUE`, still hard-blocks beyond the ceiling. Phase 1: admin Routes tab shows a "+N over" badge so David sees the exact overcap without having to hunt. Phase 3: customer app uses new `get_nearest_available_slots` RPC to offer 3 alternative slots when the preferred pick is full — no more booking dead-ends. Follow-up patch `session_131_phase2_skip_stop_limit_zero` taught the three Phase-2 functions to skip templates with `stop_limit <= 0` (dedicated commercial routes like Kidango) so they don't get false-flagged. Commits `845e0b2`, `a6cdb2c`, `6429602`.
- ✅ Null-coord addresses + map fullscreen (session 130) — root-cause trace found 4 `addresses` INSERT paths (2 admin, 2 customer-app) that silently saved null lat/lng when Google Maps failed. All 4 patched with confirm dialogs (admin) or geocoder fallback + hard block (customer). 6 affected addresses healed via `geocodeMissing()` (Carol Stevenson, Jennifer Evans, Paula Murphy, Henrike Lange, Dominic Volpatti, Karen White). Admin Orders → Map now shows a yellow "N stops not on map — [Fix now]" warning banner when any routes contain null-coord stops. New Maximize button + Escape key on Orders → Map toggles `body.map-fullscreen`, hiding sidebar + topbar + List/Map tabs (100vh map). Plus RCC polish: progress bar + "X done" badge removed, en-route tag, AM/PM toggle, stop driver_id override clearing on move. Commits `229f14a`, `34f3401`, `889b4c7`, `862c9b6`, `486854f`, `3319b33`, `16a145f`, `79b3bc3`, `4622524`, `bf7774f`.
- ✅ Failed-delivery SMS + Baby Lee zone fix + optimize 401 (session 129) — (a) driver-app `cantCompleteStop()` now branches on `isPickup` so delivery failures write `delivery_failed` (not `pickup_failed`); new `delivery_failed` template + `send-order-notification` v28. (b) `trg_create_recurring_order_fn` re-resolves `zone_id` from `customers.route_template_override_id` every cycle — fixes Baby Lee's commercial-route poisoning. (c) `optimize-route` v22 redeployed with `verify_jwt: false` (gateway was rejecting the anon JWT with HTTP 401). ⚠️ guardrails added to PROJECT-NOTES.md for all three.
- ✅ Credit ledger integrity fix (session 128) — three silent bugs in `admin-dashboard/index.html`: (a) `saveIntake()` deducted credits without logging a `customer_transactions` row; (b) `saveRacking()`'s fully-credited branch skipped `billing_status`/`paid_at` and silently lost tips; (c) Bill Orders → Account Credit summed pre-tip `total_amount`, excluding tips from the deduction. All three fixed + 636 ledger rows backfilled across 377 customers ($13,766.80) + 12 "zombie-$0" orders marked paid. Two new ⚠️ CRITICAL invariants added to PROJECT-NOTES.md. Katie Guadagno's account reconciles exactly. Commit `4090df1`.
- ✅ Orphan auth follow-up (session 127) — cleaned 2 blocking pre-cron orphans (Melissa Crouch, Carrie Stone), fixed cron filter that excluded magic-link provider, audit skill exclusion list updated.
- ✅ Retail SMS pipeline (session 126) — walk-in POS order-placed + ready-for-pickup SMS from `message_templates`.
- ✅ POS v1 live on Vercel (session 125) — S700 card reader, Foothill staff auth token patch.
- ✅ Billing recovery (session 83) — charge-order v31 (NON_CHARGEABLE_STATUSES blacklist fix), $2,327 recovered via batch retry, 27 SMS + 26 emails sent to customers with no card on file
- ✅ Billing retry flow (session 70h) — 3-way button logic, charge-order v26, `charge_failed_at` column, backfill of 10 failed orders
- ✅ A2P 10DLC approved (2026-03-16) — SMS fully live
- ✅ CloudPRNT receipt overhaul (session 70g) — Star Document Markup natively, no more ESC/POS conversion
- ✅ Phone required on signup (session 70f) — JS-level 10-digit validation on all 3 registration paths
- ✅ Driver photo queue (session 70e) — IndexedDB, background upload, retry on reconnect
- ✅ Same-day delivery toggle fixed (session 8) — `selectSchedPickupDate` was missing `_checkSameDayAvailable()` call; toggle now appears on date selection automatically. Copy is context-aware: "tonight" vs "Tuesday evening"
- ✅ Security hardening (session 8) — Twilio auth token rotated, all credentials moved to Supabase Secrets, `create-test-user` unauthenticated endpoint neutralized (returns 404)
- ✅ Customer app UX (session 8) — order cards show pickup date (not booking date), skipped/pickup_failed in Past tab, delivery address removed from booking flow, compact time/address display
- ✅ Customer email receipts — SendGrid confirmed working (session 8 verification)
- ✅ Live driver GPS tracking — `driver_locations` table, Supabase Realtime → admin map
- ✅ Same-day delivery option — AM pickup routes show "⚡ Want it back tonight?" toggle (turnaround_hours on route_templates)
- ✅ SKIP reply handling: `twilio-webhook` detects "SKIP" → marks next order skipped → fires `skip_confirmation` template
- ✅ Scheduled reminders: pg_cron → `send-scheduled-reminders` edge function for day-before, day-of, reorder
- ✅ Receipt printing: thermal 80mm, 2 copies, auto-prints on intake save + 🖨 Print button

---


