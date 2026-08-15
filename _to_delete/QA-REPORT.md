# WashRoute — End-to-End QA Report
**Date:** March 2, 2026
**Tested by:** Claude (autonomous testing session)
**Scope:** Full order placement flow, admin dashboard display, driver app data readiness

---

## Summary

This report covers two full autonomous testing sessions. Starting from scratch (no test orders existed), the sessions uncovered **11 bugs** — all now fixed — and identified **12 improvement suggestions** for future sprints.

A real test order (Order #25, Alex Rivera, Berkeley CA, $118.00, 2 bags) was successfully placed end-to-end and is visible in both the admin dashboard and driver app.

---

## Bugs Found and Fixed

### Customer App — Order Placement Flow

#### Bug 1 — `selectService` Crash on Load
**Symptom:** Customer app threw a JavaScript ReferenceError immediately on load, preventing any interaction.
**Root cause:** `selectService()` was called before the services list had loaded.
**Fix:** Added a guard to check that services are available before calling.
**Status:** ✅ Fixed

#### Bug 2 — Zone Detection: Berkeley, Oakland, Hayward Not Matched
**Symptom:** Entering addresses in Berkeley, Oakland, or Hayward returned "no service in your area" even though routes cover those cities.
**Root cause:** Zone polygon coordinates were missing or incorrect for those service areas.
**Fix:** Added correct polygon coordinates for all three zones.
**Status:** ✅ Fixed

#### Bug 3 — Pickup Time Slots Not Appearing
**Symptom:** Step 1 (Pick a Day) showed no available time slots for any date.
**Root cause:** The slots query was hitting the `routes` table (actual scheduled runs) instead of `route_templates` (recurring schedule). No routes had been manually created yet, so nothing returned.
**Fix:** Changed query to use `route_templates` with day-of-week matching.
**Status:** ✅ Fixed

#### Bug 4 — `pickup_date` / `delivery_date` Columns Don't Exist
**Symptom:** Order insert silently failed.
**Root cause:** `placeOrder()` was trying to insert `pickup_date` and `delivery_date` — columns that don't exist in the `orders` table schema.
**Fix:** Removed those fields from the insert.
**Status:** ✅ Fixed

#### Bug 5 — `pickup_run_id` Foreign Key Violation
**Symptom:** Order insert silently failed with a Postgres FK constraint error.
**Root cause:** `computeSubWindows()` returns `route_templates.id` as the `routeId`. That value was being passed as `pickup_run_id`, but `pickup_run_id` is a FK to the `routes` table (actual runs), not `route_templates`. Template IDs and route IDs are separate.
**Fix:** Set `pickup_run_id: null` on insert. Admin links orders to routes manually via the dashboard.
**Status:** ✅ Fixed

#### Bug 6 — Preferences Step Rendered Blank
**Symptom:** Step 2 (Preferences) showed no preference buttons — just an empty screen.
**Root cause:** `renderOrderPrefs()` was only called when navigating to step 3 (Bag Count), not step 2 (Preferences). The step check was off by one.
**Fix:** Changed condition from `step === 3` to `step === 2`.
**Status:** ✅ Fixed

#### Bug 7 — Special Instructions Stored the Address String
**Symptom:** After placing an order, `special_instructions` in the database contained the customer's address instead of their care notes.
**Root cause:** `special_instructions: draft.address || null` — wrong property referenced.
**Fix:** Changed to `draft.specialInstructions`. Also added a `<textarea>` to Step 2 so customers can actually enter care notes.
**Status:** ✅ Fixed

#### Bug 8 — `order_number` Identity Column Rejection
**Symptom:** Order insert failed with: *"cannot insert a non-DEFAULT value into column 'order_number' — Column is an identity column defined as GENERATED ALWAYS."*
**Root cause:** `placeOrder()` was manually generating and inserting an `order_number`. The column is `GENERATED ALWAYS AS IDENTITY` — Postgres auto-assigns it and rejects any supplied value.
**Fix:** Removed `order_number` from the insert entirely. The DB now auto-increments it.
**Status:** ✅ Fixed

#### Bug 9 — Pickup Window Stored as Wrong Timezone (UTC vs Local)
**Symptom:** Admin dashboard showed pickup time as "12:00 – 2:00 am" when it should be "7:00 – 9:00 am".
**Root cause:** `computeSubWindows()` built ISO datetime strings without a timezone offset (e.g., `"2026-03-09T07:00:00"`). When stored to a `timestamptz` Postgres column, the server treated the naive string as UTC. A 7:00 AM local time got stored as 7:00 UTC, which displays as midnight in Pacific time.
**Fix:** Wrap in `new Date(...).toISOString()` so the local-time string is properly converted to UTC before storage.
**Status:** ✅ Fixed (test order #25 was also corrected directly in the DB)

---

### Admin Dashboard — Order Detail Panel

#### Bug 10 — Customer Name Showed "—"
**Symptom:** The NAME field in the order detail side panel always showed "—" regardless of which order was opened.
**Root cause:** The `<a>` element had two `id` attributes on the same tag: `id="op-cust-link"` and `id="op-cust-name"`. Browsers only register the **first** `id` attribute, so `getElementById('op-cust-name')` always returned `null`. The name was computed correctly but then thrown away.
**Fix:** Removed the duplicate `id="op-cust-link"` attribute. The element now has a single `id="op-cust-name"`.
**Status:** ✅ Fixed

#### Bug 11 — Bags Count Showed "—"
**Symptom:** The BAGS field in the order detail panel always showed "—".
**Root cause (1):** The `loadOrders()` query didn't include `total_bags` in the SELECT — only `weight_lbs` was fetched.
**Root cause (2):** The panel display code showed `o.weight_lbs` for the BAGS field, not `o.total_bags`. Weight in pounds is separate from the bag count.
**Fix:** Added `total_bags` to the `loadOrders()` select. Updated the display to show `o.total_bags` (falling back to `o.weight_lbs` if bags isn't set).
**Status:** ✅ Fixed

---

## Remaining Known Issues (Not Yet Fixed)

### Medium Priority

**Issue A — "Sign In" on Confirm Screen Loses the Draft Order**
When a guest reaches Step 4 (Confirm) and clicks "Sign in to existing account," the auth flow redirects and the draft order state is lost. The user has to start over.
*Suggested fix:* Persist `draft` to `sessionStorage` before the auth redirect, then restore it on return.

**Issue B — Customer Greeting Shows "Hello, there" for Test Users**
After login, the greeting reads "Hello, there" instead of the customer's name. `currentProfile.first_name` is empty for test accounts inserted manually (they don't have a matching `profiles` record with the name).
*Suggested fix:* Fall back to `customers.first_name_cache` when `profiles.first_name` is empty.

**Issue C — "Recent Orders" Row Opens Customer Panel Instead of Order Detail**
On the Overview tab, clicking a row in the Recent Orders table opens the customer side panel rather than the order detail panel. This is confusing — the user is looking at orders, not customers.
*Suggested fix:* Change the `onclick` on recent-order rows to call `openOrderPanel(o.id)`.

### Low Priority

**Issue D — Test Driver Accounts Have No Passwords**
Marcus Williams, Sofia Rodriguez, and Tyler Johnson exist in `auth.users` with their test email addresses, but no passwords were set during data seeding. To test the driver app with a real login, either reset their passwords via the Supabase console, or log in as David (dmacquart@gmail.com) after reassigning a stop to his driver record.

**Issue E — Admin Pickup Route Shows "—" Until Route is Manually Linked**
New customer orders arrive with `pickup_run_id = null`. The "Pickup Route" field in the order detail panel correctly shows "—" until an admin creates a route and links the stop. This is expected behavior but there's no in-app workflow to prompt the admin to do this.
*Suggested fix:* Add a "Assign to Route" quick-action button on the order detail panel.

---

## Improvement Suggestions

### High Impact

**1 — Auto-Create Route Stops from New Orders**
Currently, when a customer places an order, nothing in the driver app changes. An admin must manually create a `route_stop` record. Consider building an "Unassigned Orders" section in the admin Routes view that shows orders needing a stop, with a one-click "Add to Route" action.

**2 — Admin Notification on New Order**
There's no alert when a new order comes in. Consider sending a push notification or email to David when `orders.status = 'scheduled'` is newly inserted — either via a Supabase database webhook or a Postgres trigger calling the `send-order-notification` Edge Function.

**3 — Customer Email Confirmation**
After placing an order, the customer gets no receipt or confirmation. Integrate SendGrid (already in the backlog) to send a summary email: order number, pickup window, total, and special instructions.

**4 — Order History for Returning Customers**
The customer app has no way to see past orders. Adding a simple "Your Orders" tab after login would reduce support inquiries and give customers confidence.

### Medium Impact

**5 — Configurable Business Timezone in Admin Settings**
Currently, all time displays depend on the browser's local timezone. If David's admin computer and drivers are always in Pacific time, this works — but a settings field for the business timezone would make this explicit and safe.

**6 — Phone Number Stored Consistently**
The `customers.phone_cache` column stores numbers in various formats (`(415) 608-5446`, `415-608-5446`, etc.). The Twilio matching logic handles this, but storing in a single canonical format (E.164) would simplify all matching logic.

**7 — Bag Count Shown on Confirm Screen (Customer App)**
Step 3 (Bag Count) asks customers how many bags they have. This count should be summarized on the Step 4 (Confirm) screen so they can review before placing. Currently it's not displayed.

**8 — "Mark Delivered" Should Update Order Status Automatically**
When a driver marks a stop as complete in the driver app, the `route_stop.status` updates to `complete` — but `orders.status` stays at `out_for_delivery`. These should stay in sync. A Supabase trigger or Edge Function could watch `route_stops` and advance the parent order status when all stops are done.

### Low Impact

**9 — Add a "Test Data" Banner During Development**
A small yellow banner in each app reading "🧪 Test Mode" would help distinguish test orders from real ones once actual customers start signing up.

**10 — Drag-and-Drop Stop Reordering in Driver App**
The driver route view currently shows stops in `stop_number` order. A drag-to-reorder feature (or "Optimize Route" button using Google Maps Directions API) would help drivers plan their day more efficiently.

**11 — Undo Window on Order Cancellation**
Order cancellation in the admin dashboard is currently a hard delete with no confirmation dialog. Adding a "Are you sure?" modal and a brief undo window would prevent accidental data loss.

**12 — Customer Preferences Remembered Across Orders**
The preferences (no bleach, hang dry, detergent type, etc.) are stored on the customer record but the order flow shows them as blank each time. They should be pre-populated from the customer's saved preferences so returning customers don't have to re-enter them.

---

## Test Data Created

The following records were inserted during testing and are safe to keep as demonstration data:

| Type | Details |
|------|---------|
| Customer | Alex Rivera · (510) 555-1001 · 2847 Telegraph Ave, Berkeley CA |
| Order | #25 · Scheduled · $118.00 · 2 bags · Wash & Fold · Pickup Mar 9 7–9 AM |
| Route | Berkeley AM · Mar 9, 2026 · Marcus Williams (driver) |
| Route Stop | Pickup stop #1 · currently assigned to David's driver record for testing |

To clean up test data: delete Order #25, customer Alex Rivera, route "Berkeley AM", and the associated route stop.

---

## Current Deployment Status

- **Vercel:** `https://washroute.vercel.app` — latest commit `423f5fc` (March 2, 2026)
- **Supabase:** `umjpbuxrdydwejqtensq` — all schema changes applied
- **GitHub:** `main` branch, 4 commits pushed this session

---

*Report generated by Claude after autonomous end-to-end testing.*
