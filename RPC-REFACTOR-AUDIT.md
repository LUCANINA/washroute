# RPC Refactor Audit — Session 135

## Summary

Scanned all three apps and found ~75 `db.from(...).update(...)` call sites across `orders` (45+), `route_stops` (11), `customers` (16), and `addresses` (3). The bug that shipped today (session 135) — `saveEditOrder` in customer-app updating `pickup_window_start` without `pickup_run_id` — is one of at least 8 places where the same class of "correlated field left stale" can happen silently. Proposed 9 RPCs below, ranked by (likelihood of silent data corruption × number of affected sites × known bug history). Ship them in order — the first three protect the most operationally critical paths.

---

## Existing RPCs (don't duplicate)

- `apply_customer_credit_to_order(p_customer_id, p_amount, p_description, p_order_id, p_payment_method)` — session 134 pt 11; used at intake, rack, bill-orders (credit path), and tip-at-rack
- `delete_orders(p_ids uuid[])` — cascade-deletes route_stops + fires notifications
- `customers_in_zone(zone_id)` — read-only
- `get_zones_for_point / get_zone_for_point / get_service_zones_geojson` — read-only
- `get_slot_availability / get_nearest_available_slots` — read-only
- `claim_existing_customer / link_phone_auth_account / link_phone_auth_driver / find_customer_by_phone / check_account_exists` — auth flows
- `update_service_sort_order / update_preference_sort_order / upsert_preference / delete_preference / delete_address / upsert_service_zone / delete_service_zone / exec_sql` — admin utility
- `reschedule_order_leg` (session 135) — ✅ shipped
- `advance_order_status` (session 135) — ✅ shipped
- **`create_order_for_customer` (session 147) — ✅ shipped.** Consolidates customer-app `placeOrder`, customer-app subscription bootstrap, and admin Add Order modal. Enforces service_id resolution chain + line_items base.amount > 0. Plus `CHECK (service_id IS NOT NULL OR source='walk_in')` backstop on `orders` and `log_order_created` trigger fix so `source='scheduled'` actor reads as `'System'` not `'Customer'`.

---

## Proposed RPCs (ranked by priority)

---

### 1. `reschedule_order_leg` — risk: HIGH — this is exactly the bug that shipped today; three apps, at least 6 call sites

**Signature:** `reschedule_order_leg(p_order_id uuid, p_leg text, p_route_id uuid, p_window_start timestamptz, p_window_end timestamptz)`

**Replaces 6 call sites**

**Invariants enforced:**
- When changing `pickup_window_start`, MUST also update `pickup_run_id` (today's bug: session 135 trigger)
- When changing `delivery_window_start`, MUST also update `delivery_run_id`
- When changing route_id, MUST upsert the matching `route_stops` row (`route_id`, `driver_id = NULL`, `status = pending`)
- If `pickup_failed` or `on_hold`, reset `status = scheduled` / clear `cancelled_by`
- If `delivery_failed`, reset `status = ready_for_delivery` / clear `cancelled_by`
- Clear `routing_error` when re-routing a broken order
- All four fields (`*_run_id`, `*_window_start`, `*_window_end`, route_stops) must land atomically; partial success currently possible

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 9158 | `opSaveRouteAndSlot` | orders: pickup/delivery_run_id, *_window_start, *_window_end, status, cancelled_by, routing_error; route_stops: route_id, driver_id |
| admin-dashboard | 8460 | `_opShiftDeliveryWindow` | orders: delivery_window_start/end only — NO delivery_run_id update |
| admin-dashboard | 10687 | `confirmReassignRun` | orders: pickup/delivery_run_id only — NO window update, NO route_stop sync |
| admin-dashboard | 19154 | `rccDragDropStop` | orders: pickup/delivery_run_id only — NO route_stop re-point |
| admin-dashboard | 19557 | `confirmMoveStop` | route_stops: route_id, stop_number, driver_id; then orders: run_id separately (non-atomic) |
| customer-app | 6122 | `saveEditOrder` | orders: *_window_start/end, *_run_id, address_ids — existing BEFORE UPDATE trigger guards pickup side, but delivery side unguarded |

**Why this ranks #1:** The session 135 trigger was added reactively to fix one path. Lines 8460 (`_opShiftDeliveryWindow`) and 10687 (`confirmReassignRun`) still mutate a single correlated field in isolation. The RCC drag-drop at 19154 updates `run_id` on the order without touching the stop's `route_id` at all in a separate code path. Moving this logic into one RPC means the trigger can be removed or simplified — the RPC enforces the invariants before writing.

---

### 2. `advance_order_status` — risk: HIGH — status transitions have 4+ correlated timestamps and billing side-effects, duplicated across 8+ call sites

**Signature:** `advance_order_status(p_order_id uuid, p_new_status text, p_actor text, p_note text DEFAULT NULL)`

**Replaces ~10 call sites**

**Invariants enforced:**
- `status = picked_up` → MUST set `actual_pickup_at = NOW()`
- `status = delivered` → MUST set `actual_delivery_at = NOW()`, MUST NOT leave `actual_delivery_at = NULL`
- `status = skipped | cancelled | pickup_failed | delivery_failed` → MUST set `cancelled_by`
- `status = on_hold` (rollback) → MUST also NULL `pickup_run_id`, `delivery_run_id`, `actual_pickup_at`, `actual_delivery_at`; MUST delete `route_stops`
- Forward advance → clear `routing_error` if set
- Every status change must insert an `order_events` row (currently done client-side before the update, so a network drop between log and update leaves events with no matching status)

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 8119 | `opSkipOrder` | status, cancelled_by |
| admin-dashboard | 8740 | `opSetOrderStatus` (rollback path) | status, *_run_id, *_at, routing_error; + route_stops.delete separately |
| admin-dashboard | 8788 | `opSetOrderStatus` (forward path) | status, actual_*_at, cancelled_by |
| admin-dashboard | 10405 | `batchSetStatus` (loop) | status, actual_*_at |
| admin-dashboard | 10479 | `batchAdvanceStatus` (loop) | status, actual_*_at; charge-failed stamp at 10466 is a separate update |
| admin-dashboard | 10646 | `setSingleOrderStatus` | status, actual_*_at, cancelled_by |
| admin-dashboard | 11450 | `advanceOrderStatus` (order list btn) | status, actual_*_at |
| driver-app | 3076 | `completeStop` | orders: status, actual_*_at, total_bags (if adjusted) |
| driver-app | 3181 | `cantCompleteStop` | orders: status, cancelled_by, driver_skip_reason |
| driver-app | 2966 | `triggerUndo` | orders: status, cancelled_by, driver_skip_reason, actual_*_at |

**Why this ranks #2:** Eight separate places build `{ status, actual_pickup_at, actual_delivery_at, cancelled_by }` by hand. Several already have subtle bugs: `batchSetStatus` (line 10405) does NOT stamp `actual_pickup_at` for `picked_up`; line 10646 `setSingleOrderStatus` also misses `actual_delivery_at` on `delivered` — both stamp the timestamp only if the NEW status matches, but there's no guard against calling with an already-terminal status that would clear a previously valid timestamp. An RPC can enforce the complete rule set once.

---

### 3. `complete_route_stop` — risk: HIGH — driver completing a stop touches route_stops + orders + routes non-atomically

**Signature:** `complete_route_stop(p_stop_id uuid, p_stop_type text, p_notes text DEFAULT NULL, p_photo_url text DEFAULT NULL, p_adjusted_bags int DEFAULT NULL)`

**Replaces 3 call sites in driver-app**

**Invariants enforced:**
- `route_stops.status = complete`, `completed_at = NOW()`, `actual_arrival = NOW()`, `driver_notes`
- `orders.status = picked_up | delivered`, `actual_pickup_at | actual_delivery_at = NOW()`
- `routes.completed_stops` counter incremented atomically; if all stops done → `routes.status = complete`, `completed_at = NOW()`
- If `p_adjusted_bags` differs from `orders.total_bags`, update `total_bags` atomically with the status
- Currently: `route_stops` is written first; if that succeeds but the `Promise.all` for `orders` + `routes` fails, the stop is marked complete but the order stays `scheduled` — driver gets no error, admin sees zombie status

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| driver-app | 3039 | `completeStop` | route_stops: status, completed_at, actual_arrival, driver_notes, photo_skipped_at |
| driver-app | 3076 | `completeStop` (parallel) | orders: status, actual_*_at, total_bags; routes: completed_stops, status, started_at, completed_at |
| driver-app | 2952 | `triggerUndo` | route_stops + orders reverse (two sequential writes, not atomic) |

**Why this ranks #3:** The driver is the last human touch before an order is marked delivered. If the `Promise.all` at line 3107 partially fails (orders write fails, route_stops already committed), the customer never gets their delivered SMS, admin sees a stuck status, and there is no retry path in the driver app. This is the highest-volume real-world path — every delivery, every pickup, every day.

---

### 4. `record_order_intake` — risk: HIGH — weigh-in sets total_amount; if credit apply RPC fails, order is priced wrong and already advanced to `processing`

**Signature:** `record_order_intake(p_order_id uuid, p_weight_lbs numeric, p_bags int, p_total_amount numeric, p_line_items jsonb, p_service_id uuid, p_discount_id uuid, p_is_same_day bool, p_notes text, p_credit_applied numeric DEFAULT 0, p_customer_id uuid DEFAULT NULL)`

**Replaces 1 large call site in admin-dashboard**

**Invariants enforced:**
- `orders.status = processing`, `weight_lbs`, `total_bags`, `total_amount`, `line_items`, `service_id`, `discount_id`, `is_same_day` must land atomically
- If `p_credit_applied > 0`: MUST atomically decrement `customers.credits` AND insert `customer_transactions` row in the same transaction (currently done via `apply_customer_credit_to_order` RPC called AFTER the `orders` update — if the RPC fails, the order has a lower `total_amount` but `customers.credits` was never decremented → free laundry)
- `total_amount` must be the pre-tip subtotal (the comment at line 22748 is the only guard; an RPC can enforce this with a CHECK)

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 22756 | `saveIntake` | orders: status, weight_lbs, total_bags, total_amount, line_items, is_same_day, service_id, discount_id, special_instructions; then `apply_customer_credit_to_order` RPC separately |

**Why this ranks #4:** The credit deduction happens AFTER the order update. A crash window exists between the two writes. Additionally, `total_amount` includes a client-side tip subtraction (the `bd.preTipTotal` vs `bd.total` split). If that logic is ever wrong, there's no server-side guard. Moving into a SECURITY DEFINER RPC lets you add a CHECK: `total_amount >= 0` and validate `line_items` sum equals `total_amount`.

---

### 5. `rack_order` — risk: HIGH — racking touches order status + rack assignment + (sometimes) credit deduction; three separate billing branches

**Signature:** `rack_order(p_order_id uuid, p_rack_id uuid)`

**Replaces 3 order update sites in admin-dashboard (lines 21731, 21765, 21815) plus the upstream `apply_customer_credit_to_order` calls**

**Invariants enforced:**
- `orders.status = ready_for_delivery`, `rack_id`, `racked_at` must be atomic
- If fully credited (subtotal = $0, no tip): `billing_status = paid`, `billing_payment_method = credit`, `stripe_payment_intent_id = credit_applied` all in one transaction
- If fully credited but tip > 0 and credits insufficient: `billing_status = failed`, `charge_failed_at`
- `rack_id` foreign key must reference an active rack (currently only validated client-side)
- Currently: if `apply_customer_credit_to_order` succeeds but the final `orders` update (line 21815) fails, the credits were already deducted but the order is not in `ready_for_delivery` state

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 21731 | `confirmRack` (credit+tip path) | orders: billing_status, billing_payment_method, billing_notes, billed_at, stripe_payment_intent_id |
| admin-dashboard | 21754 | `confirmRack` (tip charge-fail path) | orders: billing_status, charge_failed_at, billing_notes |
| admin-dashboard | 21765 | `confirmRack` (no-tip credit path) | orders: billing_status, billing_payment_method, billing_notes, billed_at, stripe_payment_intent_id |
| admin-dashboard | 21815 | `confirmRack` (final) | orders: status, rack_id, racked_at |

**Why this ranks #5:** Billing + status in 4 separate writes with Stripe calls in between. If a Stripe call succeeds but the subsequent `orders` update fails, billing_status is never stamped paid and the order reappears as uncharged. This is money.

---

### 6. `mark_orders_paid` — risk: MEDIUM-HIGH — batch billing writes billing_status/billed_at in bulk; credit path has the same RPC-after-write race as intake

**Signature:** `mark_orders_paid(p_order_ids uuid[], p_payment_method text, p_notes text DEFAULT NULL)`

**Replaces 3 call sites in admin-dashboard**

**Invariants enforced:**
- `billing_status = paid`, `billing_payment_method`, `billing_notes`, `billed_at` all land atomically across multiple order IDs
- `billed_at` must always be set when `billing_status = paid` (currently missing if network drops after orders update but before function returns)
- For the credit path: the existing `apply_customer_credit_to_order` RPC is called AFTER `orders` update — must be inverted (deduct credit first, then mark paid, all in one transaction)

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 16555 | `confirmBillOrders` (card path) | orders: billing_status, billing_payment_method, billing_notes, billed_at (.in bulk) |
| admin-dashboard | 16614 | `confirmBillOrders` (credit path) | orders: billing_status, billing_payment_method, billing_notes, billed_at (.in bulk), then RPC separately |
| admin-dashboard | 16673 | `confirmBillOrders` (cash/check/venmo) | orders: billing_status, billing_payment_method, billing_notes, billed_at (.in bulk) |

**Why this ranks #6:** Three nearly-identical bulk updates with subtle differences (credit path has extra RPC). Easy consolidation win, ensures `billed_at` is never null when `billing_status = paid`.

---

### 7. `recall_delivered_order` — risk: MEDIUM — un-delivering an order requires status + route + stop to all move together

**Signature:** `recall_delivered_order(p_order_id uuid, p_delivery_route_id uuid, p_reason text DEFAULT NULL)`

**Replaces 2 call sites in admin-dashboard (lines 8235, 8252)**

**Invariants enforced:**
- `orders.status` → `out_for_delivery` or `ready_for_delivery` (based on route run_date vs today)
- `orders.actual_delivery_at = NULL`
- `orders.delivery_run_id = p_delivery_route_id`
- `orders.delivery_window_start/end` pulled from the route's `window_start/end`
- `route_stops` for this order on the delivery leg: upsert with `status = pending`, `completed_at = NULL`, `proof_photo_url = NULL`, `route_id = p_delivery_route_id`
- All three tables must be consistent; currently a failure after the `orders` update but before the `route_stops` upsert leaves the order back on a route with no stop

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 8235 | `confirmRecall` | orders: status, actual_delivery_at, delivery_run_id, routing_error, delivery_window_start/end |
| admin-dashboard | 8252 | `confirmRecall` (route_stops) | route_stops: route_id, driver_id, status, completed_at, proof_photo_url |

**Why this ranks #7:** Recall is an edge case but the consequence of partial failure is severe: order shows as active on a route with no driver stop — driver never sees it, customer waits forever. Known class of bug from today's session.

---

### 8. `adjust_customer_credits` — risk: MEDIUM — admin manual credit add/remove is still a sequential update + insert

**Signature:** `adjust_customer_credits(p_customer_id uuid, p_delta numeric, p_note text, p_type text)`

**Replaces 1 call site in admin-dashboard (line 15763)**

**Invariants enforced:**
- `customers.credits` update and `customer_transactions` insert must be atomic (currently sequential at lines 15763 + 15766)
- `credits` must never go below 0 on a remove (currently enforced client-side with `Math.max(0, ...)` at line 15762 — no DB guard)
- `p_delta` should be positive; RPC determines sign based on `p_type` (`credit_add` vs `credit_remove`)

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 15763 | `applyCreditAdjust` | customers: credits; then customer_transactions: insert |

**Why this ranks #8:** Exact same drift pattern as the `apply_customer_credit_to_order` race that was fixed in session 134. Low frequency but easy win — same pattern, one more place to close it.

---

### 9. `save_order_address` — risk: MEDIUM-LOW — address change on pickup leg must also update route_stop.address_id

**Signature:** `save_order_address(p_order_id uuid, p_leg text, p_address_id uuid)`

**Replaces 2 call sites in admin-dashboard**

**Invariants enforced:**
- `orders.pickup_address_id` or `orders.delivery_address_id` must be updated atomically with `route_stops.address_id` for the matching stop
- Currently: `orders` update at line 9294, then `route_stops` update at line 9301 — if the route_stop update fails silently (`.maybeSingle()` on a table with duplicates throws), the driver navigates to the old address
- Uses `.maybeSingle()` at line 9300 which throws if duplicates exist (known amplification bug, commented in code)

**Call sites:**

| File | Line | Function | Currently writes |
|---|---|---|---|
| admin-dashboard | 9294 | `opSaveAddress` | orders: pickup/delivery_address_id |
| admin-dashboard | 9301 | `opSaveAddress` | route_stops: address_id (separate, non-atomic) |

**Why this ranks #9:** Low frequency (manual admin action), but the consequence — driver navigating to wrong address — is operationally visible and embarrassing. The `.maybeSingle()` duplicate bug is also already noted in the code.

---

## Sites to leave alone (NOT refactor)

| File | Line | Function | Why leave it |
|---|---|---|---|
| admin-dashboard | 7050 | risk status bulk update | Writes only `risk_status`; single isolated field, no correlates |
| admin-dashboard | 15724 | `saveContactInfo` | Also writes `profiles` table — cross-table; but no order-correlated fields. Leave with existing dual-write pattern unless auth layer changes |
| admin-dashboard | 16259 | `loadCpOrders` (last_order_at sync) | Fire-and-forget cosmetic sync, `.catch()` already ignores failure |
| admin-dashboard | 19263 | `_opShiftDeliveryWindow` (line 8460) | Covered by RPC #1 — becomes a thin wrapper or is deleted |
| admin-dashboard | 15593–15594 | `saveAddress` | `is_default` swap + address patch — covered by existing `delete_address` RPC pattern; low risk |
| admin-dashboard | 15263 | geocode batch (lat/lng) | Cosmetic coordinate update only; no order-correlated fields |
| customer-app | 2085 | `handleNameSubmit` (post-claim update) | Runs once at account creation, no order correlation |
| customer-app | 2374 | `sms_consent_at` stamp | Single boolean field, no correlates |
| customer-app | 5018 | `confirmOrder` (customer stats update) | `total_orders`, `total_bags`, `last_order_at`, `preferences`, `default_tip` — denormalized stats; already best-effort; if it fails, order still exists |
| customer-app | 6180 | `cancelOrder` | Already a one-field status write; `cancelled_by` is always set. Could fold into `advance_order_status` eventually but not urgent |
| customer-app | 6888 | `saveCustomerTip` | `default_tip` / `default_tip_type` — preferences only, no order correlates |
| customer-app | 7365 | `savePreferences` | `preferences` jsonb only |
| driver-app | 1220 | photo upload queue | Only writes `proof_photo_url` after successful upload; no order correlates |
| driver-app | 2796 | `arrivedAtStop` | Best-effort `.catch(() => {})` status ping; already non-blocking by design |
| admin-dashboard | 19603 | `confirmReassignDriver` | Writes `route_stops.driver_id` only; no order correlates, no cascade needed |
| admin-dashboard | 21438, 21481, 21508 | `confirmFoldSplit`, `saveFolding`, `assignFolderInline` | Fold assignment writes — `status = folding`, `folded_by_id` — could be folded into `advance_order_status` eventually but folding queue is internal-only and low risk |
| admin-dashboard | 22702 | `moveOrderBack` | Status rollback within kanban; already sets `rack_id = null` when needed. Could be merged into `advance_order_status` in a future pass |

---

## Notes for David

1. **Ship RPC #1 (`reschedule_order_leg`) first.** It directly closes today's bug class for all remaining unprotected paths (the BEFORE UPDATE trigger only guards one column on one table; lines 8460 and 10687 are still bare). The trigger can be removed once this RPC is in place.

2. **RPC #3 (`complete_route_stop`) requires the driver app to be updated at the same time.** It currently fires two separate writes from the client (`route_stops` then `orders + routes` in `Promise.all`). The driver app is the simplest of the three files — the refactor is small.

3. **Decide: should `advance_order_status` be callable from the driver app, or is `complete_route_stop` sufficient?** The driver-app `cantCompleteStop` and `triggerUndo` paths do pure order-status writes that could go to `advance_order_status`, OR you keep them separate and only RPC the happy path. Keeping driver-app RPCs narrowly scoped (complete, skip, undo) is probably cleaner.

4. **`_opShiftDeliveryWindow` (admin line 8460) is a latent session-135-class bug right now.** It updates `delivery_window_start/end` but NOT `delivery_run_id`. It is called from the same-day delivery toggle rollback path. It's not on any customer-facing path today, but it will be the next ticket if not caught by RPC #1.

5. **`confirmReassignRun` (admin line 10687)** updates `pickup_run_id` or `delivery_run_id` on the order but does NOT upsert the `route_stops` row for the new route. That means the stop stays associated with the old route in the driver app after a manual quick-reassign from the orders list. Should be folded into RPC #1.

6. **~~The `billing_status = null` clear after a successful manual charge (admin line 9715)~~ — REMOVED, session 137.** The original assessment ("standalone and fine — single field cleanup after an already-successful Stripe call") was wrong: charge-order already moves `billing_status` from `'failed'` to `'paid'`, so this UPDATE silently clobbered the just-written `'paid'` back to NULL. Caused Dana Ross #3045 + Craig Griffin #3260 to look unpaid in the system even though Stripe collected. Fixed by deleting the UPDATE entirely. Lesson: a "single-field cleanup" that fires *after* an edge function has already written to that field is not standalone — it's a race against the edge function's authoritative write.

7. **`applyCreditAdjust` (admin line 15763)** is the one remaining place where `customers.credits` is updated WITHOUT `apply_customer_credit_to_order` — a direct `customers` update followed by a separate `customer_transactions` insert. The session-134 fix closed the intake + order-billing paths but missed this one. RPC #8 closes it.

8. **Windowing as a domain (session 147 — longer-term concern, not on today's roadmap).** "What time should this order's window be?" is currently computed in four different places: customer-app's `pickDefaultDeliveryWindow` (default delivery selection), DB's `snap_window_to_template` RPC (recurring-chain projection), `trg_create_recurring_order_fn` (next-cycle window math), and the `place_pickup_order_for_customer` agent RPC (AM/PM/evening token resolution). All four answer variants of the same question with different rules. No bug today — each path works for its caller — but if windowing rules ever evolve (per-route defaults, customer preferences, holiday handling, etc.), the duplication will bite. Worth a future consolidation pass into a single `resolve_window_for(context jsonb)` RPC. Not blocking; tracking only.
