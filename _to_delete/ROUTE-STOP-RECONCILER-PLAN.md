# Route-Stop Reconciler — Design & Migration Plan

*Drafted session 162 (May 27, 2026). Status: ✅ SHIPPED session 162 — staged variant applied (reconciler authority + targeted rewiring + DB uniqueness backstop). All transitions tested in rolled-back transactions; zero active-stop duplicates system-wide.*

## SHIPPED — what actually landed (session 162)

Implemented the **staged** variant (see §5/§"honest tradeoff") rather than the
big-bang trigger rewrite, after discovering a nested-trigger hazard with
`auto_route_order` / `complete_route_stop`. Same end guarantee, smaller blast radius.

Migrations applied (Supabase project `umjpbuxrdydwejqtensq`):
1. `session_162_reconcile_order_stops_function` + `_v2_clear_route` — the single
   `reconcile_order_stops(order, leg)` authority. Owns active-stop existence /
   routing / dedupe; returns early for terminal/failed states (lifecycle triggers
   keep those); demotes the pending stop when a leg's route is cleared; never
   disturbs an `en_route` stop; touches only `route_stops` + `routes.total_stops`
   (never `orders`, so it can't recurse into the orders triggers).
2. `session_162_rewire_writers_to_reconciler` — `reschedule_order` now delegates
   all active-stop management to the reconciler (replaced the inline find/repoint/
   insert/skip blocks that excluded skipped stops); `sync_stops_on_order_status_advance`
   replaced its route-blind delivery-revive branch with a reconciler call (this was
   the resurrection half of the bug); `reset_failed_delivery_stop` guarded so it
   can never reactivate a failed stop while another active one exists.
3. `session_162_uniq_active_stop_per_order_leg` — partial unique index
   `(order_id, stop_type) WHERE status IN ('pending','en_route')`. The hard backstop.

Left intentionally untouched (working + not duplicate-creating): `auto_route_order`
(initial routing), `complete_route_stop` + driver lifecycle, `sync_stops_on_order_terminal`,
`reconcile_stop_route_on_run_change` (moves the single pending stop on run change),
the `sync_*_stop_on_window_change` route-resolution triggers.

Tests (all rolled back): dedupe 2→1 on correct route; revive skipped-on-wrong-route
→ 1 on correct route; en_route keeper preserved while dup demoted; full
`reschedule_order` RPC E2E (stop moved, not duplicated — 1 total row); index rejects
a raw second active stop; legitimate reschedule still passes with the index live.

Decisions honored: losing duplicates → `skipped` (history preserved); all shipped
in one session.

---

*Original proposal below (retained for reference).*


## 1. Why this exists

Order #5432 (Tanicia Bell) surfaced a duplicate delivery stop: the correct stop
on today's route plus a resurrected stale stop on yesterday's route. It tripped
four morning-rounds checks (2, 11, 14, 18) — all symptoms of one underlying
problem.

**Root cause is not a single bug.** It is an architecture in which *many
independent pieces of code each mutate `route_stops` using their own private
definition of "the stop," with nothing enforcing consistency.* Tanicia's
duplicate came from two of them colliding:

1. Pickup failed → `sync_stops_on_order_terminal` set her delivery stop to
   `skipped`.
2. Lili rescheduled delivery → `reschedule_order`'s stop finder **excludes**
   `skipped` stops, so it didn't find one and **inserted a brand-new** delivery
   stop on the correct route.
3. Order picked up → `sync_stops_on_order_status_advance` (session 141) revived
   the old `skipped` stop back to `pending` **with no route check**, resurrecting
   the orphan on the wrong route.

Each behaved correctly in isolation. The system has no layer that guarantees the
end state is sane. A different sequence (date-only edit, a different screen, a
future seventh rule) recombines these and produces the same class of orphan or
duplicate through a different door. **Patching the two that collided this week
does not close the class.**

## 2. The invariant we want to guarantee

> For each order and each leg (pickup / delivery), there is **at most one
> active (`pending`/`en_route`) route stop**, and it lives on **that leg's
> current route** (`pickup_run_id` / `delivery_run_id`) with the order's current
> window.

Today nothing enforces this. ~14 code sites *try* to maintain it by convention.

## 3. Current state — everything that touches `route_stops`

### Database functions / triggers (8)

| Mechanism | Fires on | What it does to stops | Its "find the stop" filter |
|---|---|---|---|
| `auto_route_order` (trg on order INSERT) | new order | creates initial pickup + delivery stops | n/a (creates) |
| `reschedule_order` RPC | admin/customer reschedule | UPDATE route_id / INSERT new / skip | `status NOT IN (skipped,failed,complete)` |
| `reconcile_stop_route_on_run_change` (AFTER UPDATE) | `*_run_id` changes | repoints stop to new route + fixes counters | `status = 'pending'` |
| `sync_delivery_stop_on_window_change` (BEFORE UPDATE) | delivery window date changes, run_id unchanged | moves stop to a matching route, **creates routes** | `status = 'pending'` |
| `sync_pickup_stop_on_window_change` (BEFORE UPDATE) | pickup window date changes, run_id unchanged | mirror of above for pickup | `status = 'pending'` |
| `reset_failed_delivery_stop` (AFTER UPDATE) | window/run changes | resets `failed` → `pending` **on new route only** | `status='failed' AND route_id=new` |
| `sync_stops_on_order_terminal` (AFTER UPDATE) | delivered/cancelled/pickup_failed/delivery_failed/skipped | sets stops complete/failed/skipped | `status IN (pending,en_route)` |
| `sync_stops_on_order_status_advance` (AFTER UPDATE) | forward status | completes pickup; **revives skipped/failed delivery → pending (no route check)** | `status IN (skipped,failed)` |

Five different filters, all racing on the same `UPDATE orders` statement, plus
the reschedule RPC layering its own logic on top. That is the bug factory.

### App-code direct writes (6)

| File:line | Write | Dimension |
|---|---|---|
| `admin:17536/17540` | INSERT pickup + delivery stop on manual order create | **routing** (bypasses reconciler today) |
| `driver:2901` | UPDATE status → `en_route` ("On My Way") | driver lifecycle |
| `driver:1291` | UPDATE `proof_photo_url` after upload | driver lifecycle |
| `admin:21915 / 22659` | UPDATE `stop_number` after a move | ordering |
| `admin:22705` | UPDATE `driver_id` (manual reassign) | driver lifecycle |
| `complete_route_stop` RPC (driver completeStop) | UPDATE status → `complete` (+order +route) | driver lifecycle |

**Key insight for the design:** writes split into two dimensions —
- **Routing** (does an active stop exist, and on which route) — the source of
  all the bugs.
- **Driver lifecycle** (`en_route`, `complete`, photo, `driver_id`, `stop_number`)
  — these operate on an already-correct stop and are fine.

The reconciler owns **routing only**. It must *preserve* lifecycle state, never
clobber a stop a driver has already engaged with.

## 4. The design

### 4a. One authority: `reconcile_order_stops(p_order_id, p_leg)`

A single `SECURITY DEFINER` function, the **only** thing allowed to create,
move, or de-duplicate active stops. Idempotent — running it repeatedly yields
the same result.

Given an order + leg it:

1. Reads the order's current `<leg>_run_id`, window, and status.
2. Determines the **target state**:
   - Order terminal (delivered/cancelled/skipped) or leg already complete →
     target = **no active stop**.
   - Otherwise → target = **exactly one active stop on `<leg>_run_id`**.
3. Looks at all existing stops for (order, leg) and reconciles:
   - **Winner selection (preserve engagement):** if any active stop is already
     on the target route, keep it. Prefer a stop with driver engagement
     (`en_route`, has `driver_id`, has photo) so we never discard real driver
     work. Repoint the winner to the target route if needed.
   - **Collapse losers:** any *other* active stop for this leg is demoted to
     `skipped` (kept for history, invisible to routing). This is what prevents
     duplicates.
   - **Create if none:** if no reusable stop exists and target requires one,
     INSERT it on the target route. (Reuses a previously-skipped stop by
     repointing it rather than inserting, to avoid row churn.)
   - **Demote if not wanted:** if target = no active stop, demote any active
     stop.
4. Fixes `routes.total_stops` counters for any route it moved a stop off/onto.

It does **not** touch `proof_photo_url`, `completed_at`, `en_route` transitions
driven by the driver, or `stop_number` beyond assigning one on create/move.

### 4b. Every path calls it; none does its own routing surgery

| Today | After |
|---|---|
| `reschedule_order` INSERT/UPDATE/skip block | calls `reconcile_order_stops(order, leg)` per changed leg |
| `reconcile_stop_route_on_run_change` | folded into one AFTER-UPDATE trigger that calls the reconciler |
| `sync_delivery_stop_on_window_change` (route-finding) | route resolution stays; stop mutation → reconciler |
| `sync_pickup_stop_on_window_change` | same |
| `reset_failed_delivery_stop` | redundant — reconciler handles failed→active; **retire** |
| `sync_stops_on_order_status_advance` (delivery revive branch) | replaced by reconciler call (route-aware) |
| `sync_stops_on_order_terminal` | keep (lifecycle: terminal → complete/skip) but it already only hits active stops; reconciler is consistent with it |
| admin manual-create INSERT (17536/17540) | call reconciler after order insert, or rely on `auto_route_order` |

The goal: **one AFTER-UPDATE trigger on `orders`** that, when run_id / window /
status changes, calls `reconcile_order_stops` for the affected leg(s). The half-
dozen overlapping triggers collapse into that single dispatcher + the reconciler.

### 4c. Database backstop: partial unique index

```sql
CREATE UNIQUE INDEX uniq_active_stop_per_order_leg
ON route_stops (order_id, stop_type)
WHERE status IN ('pending','en_route');
```

Once all writers go through the reconciler this never trips in normal use. But
it makes the duplicate state **physically impossible to store** — any future
code path, or a manual SQL edit, that tries to create a second active stop fails
loudly instead of silently corrupting data. **This is what makes the fix
future-proof rather than "fixed for now."**

Validated: **zero existing rows violate this index** (checked across all orders,
session 162), so it can be created without a cleanup pass.

**Implementation note (important):** Postgres checks a non-deferrable unique
index at statement end, and partial unique indexes cannot be deferred. So the
reconciler must demote losers **before/within the same statement** as promoting
the winner — it must never transiently hold two active stops. The function will
be written single-statement-safe (demote extras first, then ensure the winner).

## 5. Migration sequencing (safe order)

1. **Ship `reconcile_order_stops`** (new function, touches nothing yet). Unit-test
   it in isolation against copies of real orders.
2. **Rewire writers** to call it, one at a time, re-testing after each:
   reschedule RPC → run-change trigger → window-change triggers → advance trigger
   → admin manual-create. Retire `reset_failed_delivery_stop`.
3. **Re-run the active-stop-dup scan** (must stay 0).
4. **Add the partial unique index** last, once nothing can create a dup.
5. Update morning-rounds: checks 2/11/14/21 should now be permanently green;
   note the index as the enforcing mechanism.

Each DB step goes through `washroute-migration-review` before it runs. Every
function is replaced via `CREATE OR REPLACE` (reversible) and the index can be
dropped instantly if anything misbehaves.

## 6. Test matrix (every transition must keep exactly-one-active-stop-per-leg)

- New order (customer app, admin manual create, recurring) → 1 pickup + 1 delivery
- Reschedule pickup leg / delivery leg / both (admin + customer)
- Date-only change vs route change vs window-within-route change
- Pickup fails → reschedule → recover (the Tanicia path) → exactly one delivery stop
- Delivery fails → reschedule → recover
- Cancel / skip / deliver → no stray active stops
- Driver mid-delivery (`en_route`) then admin reschedules → driver work preserved
- Commercial route (`stop_limit = 0`) unaffected

Test via the `washroute-test` skill (browser-console, real Supabase, anon key).

## 7. Open decisions for David

1. **Demote-to-skipped vs hard-delete** for losing duplicate stops. Recommend
   **skipped** (preserves history, invisible to routing). Hard-delete is cleaner
   rows but loses the audit trail.
2. **Scope now or stage it.** Recommend doing the whole thing in one focused
   session so the index goes on the same day — half-done leaves two systems of
   record fighting.

## 8. Estimated effort

One focused work session: ~the reconciler function + rewiring 6 sites + index +
full test matrix. Larger than the 20-minute patch; closes the class permanently.
