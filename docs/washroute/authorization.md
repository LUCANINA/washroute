# WashRoute — Authorization, Mutation RPCs & Migrations

*Split out of the `washroute` skill 2026-09-02.* **Read this before writing ANY RPC, trigger, or table write.**

## `_archive` Schema Convention (session 134)

Any backup/snapshot table created during a recoverable migration goes in the **`_archive` schema**, not `public`. PostgREST does not expose `_archive` by default, so snapshots stay accessible to admin SQL but invisible to the REST API. Removes the 'remember to enable RLS each time' foot-cannon.

Existing entries in `_archive`:
- `_backfill_paid_at_20260424` — 33 rows captured before dropping `orders.paid_at`
- `_backup_function_defs` — historical pg_get_functiondef snapshots; growing slowly, purge entries >90 days old when convenient
- `_merge_backup_renee_hahn_20260424` + `_merge_backup_renee_hahn_addresses_20260424` — snapshot of the duplicate-customer merge
- `_merge_backup_itay_20260424_*` — session 135 duplicate-customer merge for Itay Levy

---

## Architectural Mutation RPCs (session 135 — read before adding any new `db.from('orders').update(...)` or `db.from('route_stops').update(...)`)

**The principle:** app code should not write directly to important tables. Instead it calls a named, transactional, server-side Postgres RPC that encapsulates the "do the right thing" logic — keep correlated fields in sync, run within a single transaction, validate inputs, log the right events, return success/failure. The apps get simpler; future bugs of the "forgot to update field Y when changing field X" shape become impossible because the RPC is the only door.

This pattern was kicked off in session 134 (`apply_customer_credit_to_order`) and formalized in session 135 after a customer-facing bug (Jeanbaptiste #3128) where the customer-app updated `pickup_window_start` without `pickup_run_id`. The RPC refactor audit at `RPC-REFACTOR-AUDIT.md` (session 135) ranks the 9 conceptual mutations to RPC-ify.

**Shipped RPCs (use these — do not re-implement their logic in app code):**

| RPC | Replaces | Invariants enforced |
|---|---|---|
| `apply_customer_credit_to_order(p_customer_id, p_amount, p_description, p_order_id, p_payment_method)` | 3 admin credit-deduction sites | atomic `customers.credits` write + `customer_transactions` insert with FOR UPDATE row lock; defensive `LEAST(amount, current)` cap |
| `reschedule_order_leg(p_order_id, p_leg, p_new_route_id?, p_new_window_start?, p_new_window_end?, p_actor_name?)` | 6 raw window/route UPDATE sites (admin opSaveRouteAndSlot, selectSpSlot, confirmReassignRun, rccDrop, confirmMoveStop, customer saveEditOrder) | run_id + window stay in sync; route_stops repointed atomically; auto-snap window to template default when route changes without explicit window; status reset on re-routing of pickup_failed/on_hold/delivery_failed; routing_error cleared; attributed `rescheduled` + `routed` events |
| `advance_order_status(p_order_id, p_new_status, p_actor_name?, p_cancelled_by?, p_driver_skip_reason?, p_adjusted_bags?, p_notify_sms?)` | 8 raw status UPDATE sites (admin opSkipOrder + opSetOrderStatus forward + batchSetStatus + batchAdvanceStatus + setSingleOrderStatus + advanceOrderStatus, driver completeStop + cantCompleteStop) | `picked_up` → auto-stamp `actual_pickup_at`; `delivered` → auto-stamp `actual_delivery_at`; skip/cancel/fail → REQUIRE `p_cancelled_by`; forward advance → clear `routing_error`; driver bag adjust → atomic with status; attributed `status_change` event; blocks re-advance from terminal states (delivered/cancelled/skipped); reopening to `scheduled` with a null run_id auto-reroutes (session 191); generalized SMS notify block covers picked_up/delivered/pickup_failed/delivery_failed/walkin_ready, gated by `p_notify_sms` (session 189/194) |
| `complete_route_stop(p_stop_id, p_actor_name?, p_notes?, p_photo_url?, p_photo_skipped?, p_adjusted_bags?)` | 3 non-atomic writes (route_stops + orders + routes) in driver app's completeStop | **Shipped session 136 — do not re-build, the "Pending RPCs" list below is historical.** Driver tap-to-complete, highest daily-volume path. **Session 194 fix:** now calls `advance_order_status` BEFORE marking the stop `'complete'` (previously ran after, which let `sync_order_status_from_stops` race ahead and silently swallow the SMS + mis-attribute the event to `'System'` — see Known Issues #31 in PROJECT-NOTES) |
| `record_order_intake` / `rack_order` / `mark_orders_paid` / `recall_delivered_order` / `adjust_customer_credits` / `save_order_address` | remaining sites from the session 135 RPC-refactor audit | **All shipped session 136 — do not re-build.** See `RPC-REFACTOR-AUDIT.md` for original scope; the "Pending RPCs" list below is historical and left as-is only for that context. |
| `record_order_refund(p_transaction_id, p_amount, p_note?, p_actor_name?)` | the 3 loose writes `refund-charge` used to do (insert refund txn / decrement LTV / update order) | **Shipped session 213.** ONE transaction: refund ledger row + `customers.lifetime_value` decrement + **`orders.amount_refunded` increment** + `billing_status='refunded'` **ONLY when fully refunded** (`amount_refunded >= total_amount + tip_amount`) + attributed `billing` order_event. Admin/manager or service_role only. **Stripe stays outside** — refund first, then record; an over-refund is RECORDED (`over_refunded:true`), never rejected, because the money already moved. The blocking pre-check lives in the edge function. ⚠️ POS `refund_pos_payment` still has its own duplicate copy — rewire it onto this RPC. |
| `rollback_order_to_on_hold` | admin rollback-to-on_hold path | Shipped — nulls run_ids, deletes route_stops, sets `routing_error`. (The "What's Pending" item describing this as raw UPDATE+DELETE is stale — ignore it.) |

**Pending RPCs — HISTORICAL, all shipped session 136 (kept for the original audit context only; do not treat as a live to-do list — see the "Shipped RPCs" table above for current status):**

3. ~~`complete_route_stop(...)`~~ — shipped session 136, then fixed session 194 (SMS notify race).
4. ~~`record_order_intake(...)`~~ — shipped session 136.
5. ~~`rack_order(...)`~~ — shipped session 136.
6. ~~`mark_orders_paid(...)`~~ — shipped session 136.
7. ~~`recall_delivered_order(...)`~~ — shipped session 136.
8. ~~`adjust_customer_credits(...)`~~ — shipped session 136.
9. ~~`save_order_address(...)`~~ — shipped session 136.

**Small extension to RPC #1:** `reschedule_order_leg` currently treats `p_new_route_id = NULL` as "keep existing." Needs a `p_clear_route bool DEFAULT FALSE` flag to support the same-day-toggle uncheck restore path (`_opShiftDeliveryWindow`, admin line 8460), which legitimately wants to null out `delivery_run_id`.

**JS calling convention:**

```js
const { data: rpcRes, error } = await db.rpc('reschedule_order_leg', {
  p_order_id:         orderId,
  p_leg:              'pickup',
  p_new_route_id:     newRouteId,     // null to keep
  p_new_window_start: newStart,       // null to keep
  p_new_window_end:   newEnd,
  p_actor_name:       currentUserDisplayName || currentUserFirstName || 'Admin',
});
if (error) { showToast('Failed: ' + error.message, 'error'); return; }
// rpcRes is jsonb with new state for cache sync
```

**Backstop trigger** (`enforce_window_in_route_template`, BEFORE UPDATE on `orders`): rejects any UPDATE that puts `pickup_window_start` outside the assigned route's template window unless `pickup_run_id` is also changing in the same UPDATE. Catches anything that bypasses the RPC, surfaces with a clear error message. Same trigger for delivery side.

---

## 🔐 Authorization Architecture (session 227 — READ BEFORE WRITING ANY RPC, TRIGGER, OR TABLE WRITE)

Sessions 134–136 built the "one door" RPC pattern. Session 227 discovered the
doors had no locks: **every mutation RPC was `SECURITY DEFINER` (bypasses RLS)
with `EXECUTE` granted to `authenticated`, and only 4 of ~24 checked the
caller.** Any signed-in customer could open the browser console and run
`db.rpc('adjust_customer_credits', {p_customer_id: <self>, p_amount: 10000, ...})`.
Verified exploitable against production, then fixed. Three helpers now exist and
**every new privileged function must use one of them.**

| helper | use when | behaviour |
|---|---|---|
| `assert_staff(p_fn text)` | the RPC is staff-only (admin/POS/driver operations) | passes for: no PostgREST JWT context (pg_cron, psql), `jwt.role = service_role` (edge functions), or `is_staff()`. Otherwise raises `insufficient_privilege`. |
| `enforce_caller_owns_order(p_order_id uuid)` | the RPC is order-scoped and customers legitimately call it for their OWN order | same bypasses, plus: an authenticated customer passes iff the order's `customer_id` maps to their `profile_id`. |
| `wr_allow_protected_write()` | you are writing a protected column from a legitimate customer-context path (a trigger on a customer-writable table, or a customer-callable RPC) | sets the transaction-local `washroute.trusted_write` GUC. Revoked from `anon` and `authenticated` — only SECURITY DEFINER code can call it. |

`assert_staff` and `enforce_caller_owns_order` call `wr_allow_protected_write()`
themselves on every allowed path, so an RPC that starts with one of them can
write protected columns freely.

### Protected columns (`trg_enforce_protected_customer_columns`, `trg_enforce_protected_order_columns`)

`customers` and `orders` carry a plain table-level UPDATE grant plus RLS of
`USING (profile_id = auth.uid())`. That let a customer skip the RPC layer
entirely — `db.from('customers').update({credits: 99999})`,
`db.from('orders').update({billing_status:'paid'})`. Two BEFORE UPDATE triggers
now reject non-staff, non-trusted changes to the money/identity columns and name
the offending column in the error.

**Why a trigger and not column-level GRANTs:** admin, driver, POS device and
customer all authenticate as the single Postgres role `authenticated`. A column
GRANT cannot tell them apart. A trigger can. Do not "fix" this with GRANTs.

Two deliberate exceptions, both in the trigger bodies:
- a customer may set `subscription_plan_id` to NULL / `subscription_plan` to
  `'paygo'` (the app's Pay-As-You-Go downgrade button) but never to a paid plan;
- a customer may change `total_amount` / `line_items` only while the order is
  still `scheduled` (the only state the edit sheet offers), never after service.

**When you add a money or identity column to `customers` or `orders`, add it to
the matching `v_protected` array in the same migration.** The lists are
deny-lists, so a new column is unprotected by default.

### Rules for new code

1. **Every new SECURITY DEFINER function that mutates data starts with
   `PERFORM assert_staff('<name>')` or `PERFORM enforce_caller_owns_order(p_order_id)`.**
   No exceptions. Add it in the same migration that creates the function.
2. **Run the transitive-PERFORM audit before adding a guard** — and include
   TRIGGER functions, not just RPCs. Session 227 nearly broke every customer's
   ability to save an address: `_refresh_customer_address_cache` got the staff
   guard, and it is `PERFORM`ed by `sync_customer_address_cache`, a trigger on
   `addresses`, which customers write themselves. A guarded function reached
   through a trigger inherits the *end user's* auth context, not the trigger's.
   ```sql
   SELECT p.proname, pg_get_function_result(p.oid) AS ret
   FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.prosrc ~ '\m<function_being_guarded>\M';
   ```
   Any caller returning `trigger` on a table `anon`/`customer` can write is a
   BLOCKER — use `enforce_caller_owns_order`, `wr_allow_protected_write()`, or
   leave that function unguarded.
3. **`anon` EXECUTE is a separate grant from PUBLIC** (session 148 lesson F).
   Every migration: `REVOKE ... FROM PUBLIC; REVOKE ... FROM anon;
   GRANT ... TO authenticated, service_role;`
4. **Test all 9 identities before shipping a guard** — `admin`, `manager`,
   `laundry_tech`, `driver`, `attendant`, `pos_device`, `customer`, plus
   `service_role` and `anon`. The reusable harness: a `DO` block that
   `set_config('request.jwt.claims', ...)`, `SET LOCAL ROLE authenticated`,
   runs each case inside `BEGIN … EXCEPTION`, accumulates a report string, and
   ends with `RAISE EXCEPTION '%', out` — which prints the whole table AND rolls
   back every write. Use it; it is how session 227 verified all of this against
   live production data without changing a row.

### Edge functions

All run `verify_jwt: false`, so **each authenticates the caller itself.** The
reference implementation is `send-sms/index.ts`'s `authorize()`: accept the
service-role key, **explicitly reject the anon key**, otherwise validate the JWT
and check `profiles.role` against an allow-list. Copy it. A new edge function
that reads `SUPABASE_SERVICE_ROLE_KEY` without an `authorize()` call is a
publicly-callable admin API.

**When you write the role allow-list, do not forget `laundry_tech`.** The
pre-deploy review of session 227 caught `charge-order` and `send-receipt` with
`{admin, manager, attendant}` — which would have made every card sale racked by
a kanban operator fail to charge *and* get stamped `billing_status='failed'`,
firing dunning texts at customers who owed nothing. This is the third time this
exact role has been missed (see session 148 lesson G).

### ⚠️ THE DATABASE IS A CALLER TOO — grep `pg_proc`, not just the repo (session 227)

**This one bit us the same day we wrote the rule above.** Session 227's caller audit
grepped the four apps and the edge functions for `fetch('.../functions/v1/<name>')`
and updated every hit. It did not grep `pg_proc`. **Five database functions call
edge functions over `net.http_post` carrying the ANON key**, and every one of them
started returning 401 the moment the hardened functions deployed:

| DB function | fires | calls |
|---|---|---|
| `flush_notification_queue` | pg_cron, every minute | `send-order-notification` |
| `sweep_autocharge_ready_orders` | pg_cron, every 5 min | `charge-order` |
| `advance_order_status` | every status change | `send-order-notification` |
| `reschedule_order` | every reschedule | `send-order-notification` |
| `apply_signup_promo_credit` | trigger on card add | `send-email` |

`flush_notification_queue` is the dangerous one: **every** `picked_up` / `delivered`
customer SMS goes through it, and it stamps `sent_at` BEFORE posting — so a 401
permanently burns that notification rather than retrying. That is precisely the
session 194 outage shape. (Session 227 got lucky: the deploy window happened to
contain no queued sends, and the autocharge sweep is self-healing.)

**So the caller audit for ANY edge-function auth change is three greps, not one:**

```bash
grep -rn "functions/v1/<name>" admin-dashboard/ customer-app/ driver-app/ pos/ \
        supabase/functions/ *.js
```
```sql
-- 2. database functions and triggers
SELECT proname FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND prosrc ~ 'functions/v1/<name>';

-- 3. cron jobs
SELECT jobname, command FROM cron.job WHERE command ~ '<name>';
```

**The DB cannot present the service-role key** — it is not stored anywhere reachable
from SQL and the Supabase vault is empty. So `public.wr_internal_auth` exists: one
row, one random secret, RLS on with no policies and no anon/authenticated grants, so
only a `service_role` client can read it. DB functions send it as the `x-wr-internal`
header via `public.wr_internal_secret()`; `charge-order`, `send-email` and
`send-order-notification` check it first in their `authorize()`. Rotate any time with
a single UPDATE — both sides read the row at call time, so no redeploy is needed.

⚠️ **That secret is equivalent to staff authority** on those three endpoints (on
`send-email` it resolves to `mode: 'staff'`, i.e. arbitrary-recipient send rights).
Add the header to a new DB caller deliberately, not reflexively.

### ⚠️ pg_cron sends the ANON key

Verified session 227: **every** pg_cron HTTP job (`wr-reminder-evening`,
`wr-reminder-morning`, `wr-bookkeeping-kpis`, `wr-health-monitor`,
`wr-klaviyo-nightly-sync`, `wr-nightly-smoke-test`, `wr-payroll-attention-check`,
`wr-xero-payout-watchdog`) posts `Authorization: Bearer <anon key>`. Decode any
of them with `SELECT jobname, command FROM cron.job;`.

So **hardening a cron-called edge function to require the service-role key kills
that cron silently.** Four functions are hardened but deliberately NOT deployed
for exactly this reason — see `proposed-migrations/session-227-edge-hardening/README.md`.
Check `cron.job` before hardening anything, every time.

---

## ⚠️ Migration Lesson — When Dropping a Column, Audit ALL Functions (session 135)

Session 134 pt 11's migration dropped `routes.date` and the migration note claimed "both functions updated." Reality: only 2 of 3 functions were updated. `auto_route_order` still had two `INSERT INTO routes (..., date, ...)` statements that silently broke any booking needing to create a fresh route run on the fly. Hadn't bitten production yet because all recent bookings landed on already-existing routes. Found while testing RPC #2.

**Rule for any future column-drop migration:** before applying, run this against every function in `public`:

```sql
SELECT proname, prosrc
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND prosrc ILIKE '%<column_name>%';
```

Don't trust "I think I got them all." The audit is 5 seconds and prevents weeks of latent breakage.

---

## Auth Architecture (read before touching any auth code)

Each app uses a unique `storageKey` so sessions never cross-contaminate:
- Admin: `storageKey: 'wr-admin-auth'`
- Driver: `storageKey: 'wr-driver-auth'`
- Customer: `storageKey: 'wr-customer-auth'`

### Admin auth (complex — role-checking required)
`onAuthStateChange` fires multiple times per page load (INITIAL_SESSION + TOKEN_REFRESHED). The admin must fetch the user's `profiles` row to verify role before showing the app. Key variables and rules:

- `_authGen` counter — each `onAuthStateChange` invocation claims a generation ID. Stale handlers bail before touching the UI (`if (myGen !== _authGen) return`).
- `_loginInProgress` flag — debounces concurrent `handleLogin()` calls (e.g. Enter key + button click at the same time).
- `_pendingAccessDeniedMsg` — stores the "staff only" message across the `signOut()` → null-session event boundary so it survives to display on the login screen.
- `profileTimer` (15s) — resets the button if the profile fetch hangs. **Never calls `signOut()` here** — that cascades into an infinite loop. Just resets the UI.
- `safetyTimer` in `handleLogin()` (30s) — same, for the Supabase sign-in call itself.
- Both timers check `app.style.display !== 'block'` — **not** `login-screen.style.display !== 'none'`. On a fresh page load the login-screen inline style is `''` (CSS controls it via stylesheet), so `!== 'none'` is always true and causes false positives.

### Driver & Customer auth (simpler)
Both use an `appReady` boolean flag — no generation counter, no role check, no `signOut()` in any timer. Safe.

---

