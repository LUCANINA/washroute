# RPC Refactor Audit

*Originally drafted session 135. Last refreshed session 148 (May 12, 2026) — all originally-proposed RPCs have shipped; this doc now tracks current state + remaining migration gaps.*

---

## Purpose

App code should not write directly to important tables. Instead it should call a named, transactional, server-side Postgres RPC that encapsulates the "do the right thing" logic — keeps correlated fields in sync, runs within a single transaction, validates inputs, logs the right events, returns success/failure. The apps get simpler; future bugs of the "forgot to update field Y when changing field X" shape become impossible because the RPC is the only door.

This audit tracks (a) which RPCs exist, (b) which app sites still bypass them, and (c) the architectural gaps remaining.

---

## Shipped RPCs — DO NOT DUPLICATE

### Core architectural mutations

| RPC | Session | Replaces |
|---|---|---|
| `apply_customer_credit_to_order(p_customer_id, p_amount, p_description, p_order_id, p_payment_method)` | 134 | 3 admin credit-deduction sites |
| `reschedule_order_leg(p_order_id, p_leg, p_new_route_id?, p_new_window_start?, p_new_window_end?, p_actor_name?, p_clear_route?)` | 135 | 6 raw window/route update sites |
| `advance_order_status(p_order_id, p_new_status, p_actor_name?, p_cancelled_by?, p_driver_skip_reason?, p_adjusted_bags?)` | 135 | 8+ raw status-update sites |
| **`reschedule_order(p_order_id, p_pickup_route_id?, p_pickup_window_start?, p_pickup_window_end?, p_delivery_route_id?, p_delivery_window_start?, p_delivery_window_end?, p_actor_name?, p_clear_pickup_route?, p_clear_delivery_route?)`** | **148** | Two-leg atomic reschedule. `reschedule_order_leg` is now a thin wrapper around this. Cross-leg invariant enforced (delivery_window_start > pickup_window_end). Kalen Gleeson #4238 root-cause fix. |
| `complete_route_stop(p_stop_id, p_stop_type, p_notes?, p_photo_url?, p_adjusted_bags?)` | 136 | 3 non-atomic driver writes (route_stops + orders + routes) |
| `record_order_intake(p_order_id, p_weight_lbs, p_bags, p_total_amount, p_line_items, p_service_id, p_discount_id, p_is_same_day, p_notes, p_credit_applied?, p_customer_id?)` | 136 | admin saveIntake — closes credit-deduction race |
| `rack_order(p_order_id, p_rack_id)` | 136 | admin confirmRack — consolidates 4 billing branches |
| `mark_orders_paid(p_order_ids[], p_payment_method, p_notes?)` | 136 | admin batch billing (3 sites) |
| `recall_delivered_order(p_order_id, p_delivery_route_id, p_reason?)` | 136 | admin un-deliver (2 sites) |
| `adjust_customer_credits(p_customer_id, p_delta, p_note, p_type)` | 136 | last credit-ledger drift site (admin applyCreditAdjust) |
| `save_order_address(p_order_id, p_leg, p_address_id, p_actor_name?)` | 136 | admin opSaveAddress (atomic FK + log + stop repoint) |
| `rollback_order_to_on_hold(p_order_id, p_actor_name?)` | 136 | admin status-rollback path |
| `undo_stop_completion(p_stop_id, p_actor_name?)` | 136 | driver triggerUndo |
| `create_order_for_customer(p_customer_id, p_total_bags, p_total_amount, p_line_items, p_source, p_service_id?, ...)` | 147 | customer-app placeOrder + subscription bootstrap + admin Add Order |
| `refund_order_credits(...)` | 136 | credit refunds |

### Other mutation RPCs

`delete_orders`, `delete_address`, `upsert_preference`, `delete_preference`, `upsert_service_zone`, `delete_service_zone`, `update_service_sort_order`, `update_preference_sort_order`.

### Read-only RPCs (no mutation concerns)

`customers_in_zone`, `get_zones_for_point`, `get_zone_for_point`, `get_service_zones_geojson`, `get_slot_availability`, `get_nearest_available_slots`, `find_customer_by_phone`, `check_account_exists`.

### Auth-flow RPCs

`claim_existing_customer`, `link_phone_auth_account`, `link_phone_auth_driver`.

---

## Session 148 audit findings — raw `.update()` sites still in app code

Scanned all `.update()` call sites on `orders`, `route_stops`, `customers`, `routes`, `addresses` across `admin-dashboard/index.html`, `driver-app/index.html`, `customer-app/index.html`, `pos/index.html`, and `supabase/functions/**/index.ts`. Total: ~52 sites.

**Bottom line: 31 SAFE + 16 RPC-WRAPPED + 5 GAPS.** Of the 5 gaps, 2 were migrated this session (customer-app `skipPickup` + `cancelOrder`). 3 remain as tech debt.

### ✅ Migrated this session

- **customer-app `skipPickup`** (line ~6437) — now routes through `advance_order_status` with `p_actor_name='Customer'` + `p_cancelled_by='customer'`. Closes audit-trail gap.
- **customer-app `cancelOrder`** (line ~6452) — same migration. Closes audit-trail gap + adds defense against re-cancellation from terminal state.

### 📋 Remaining gaps (open tech debt)

| File:Line | Function | Current state | Suggested fix | Severity |
|---|---|---|---|---|
| admin-dashboard:~8967 | `opToggleDiffDeliveryAddr` | Writes `delivery_address_id = NULL` directly; manually logs event before the UPDATE | Extend `save_order_address` with a `p_clear bool DEFAULT false` flag, then route this site through it | P2 — currently safe (no correlated fields), only loses atomicity between event log + UPDATE |
| admin-dashboard:~9314 | `opSaveRecurring` | Writes `recurring_interval` directly; no subscription side-effects yet | No RPC exists. Defer until subscription work establishes the canonical mutation pattern | P2 — currently safe; will need an RPC when subscriptions automation lands |
| driver-app:~3174 | `cantCompleteStop` | Marks `route_stops.status='skipped'` BEFORE calling `advance_order_status` for the paired order. If the order RPC fails, the stop is orphaned as skipped | New RPC `skip_route_stop(p_stop_id, p_reason, p_actor_name)` that atomically marks the stop skipped + advances the order to `pickup_failed`/`delivery_failed` | P1 — orphan window is small (sub-second) but non-zero; the eventual fix is a real new RPC, not a reorder |

### Safe-but-noted sites (audit hits to ignore)

- All `addresses` `is_default` toggle writes (admin + customer) — non-correlated field, no invariants.
- All `customers` cache writes (`first_name_cache`, `last_name_cache`, `email_cache`, `phone_cache`, `last_order_at`, `risk_status`) — denormalized fields with no business invariants; can be safely written ad-hoc.
- All `addresses` `lat`/`lng` writes — protected by session 130 null-coord prevention; current writes only fill in coords, never null them.
- Stripe webhook customer + order writes — legitimate server-side service-role backups of external state.
- `charge-order` edge function billing-field writes — internal RPC support within the canonical charge flow.

---

## ⚠️ Session 148 — newly-discovered architectural gap: ownership checks

While auditing GRANT discipline on the new `reschedule_order` RPC, found a broader issue:

**None of the customer-callable mutation RPCs verify caller ownership.** A signed-in customer could call `advance_order_status`, `reschedule_order`, `reschedule_order_leg`, or `save_order_address` with another customer's `order_id` and the RPC would happily process the request. SECURITY DEFINER functions bypass RLS, so the `orders.customer_insert_own_orders` policy doesn't help here.

The customer-app's UI only exposes the user's own order IDs, but a malicious or compromised browser could craft direct RPC calls. The existing protection is "RLS on `.from('orders').select()`" but RPCs don't go through that path.

`create_order_for_customer` (session 147) does this right: it explicitly checks `is_admin() OR caller.profile_id = customer.profile_id` inside the function body. Other mutation RPCs should follow the same pattern.

**Suggested next session:** Add ownership checks to the customer-callable mutation RPCs. Probably create a SQL helper `enforce_caller_owns_order(p_order_id)` that:
1. Returns immediately if `auth.uid() IS NULL` (service_role bypass for edge functions).
2. Returns immediately if `is_admin()` is true.
3. Otherwise raises `insufficient_privilege` unless the JWT's user is the linked customer's profile.

Apply to: `reschedule_order` (the wrapper `reschedule_order_leg` inherits the check), `advance_order_status`, `save_order_address`. Not needed on admin-only RPCs (`record_order_intake`, `rack_order`, `mark_orders_paid`, etc.) which the customer-app never calls — but adding `is_admin()` checks there for defense-in-depth is cheap.

Also resolved this session: `reschedule_order` had default `anon` + `PUBLIC` EXECUTE grants because Postgres' default for new SECURITY DEFINER functions is open. Revoked via migration `session_148_revoke_anon_from_reschedule_order`. Now grants match the discipline of other mutation RPCs (authenticated + service_role + postgres only).

---

## Future RPCs worth considering (when the work that motivates them lands)

- **`skip_route_stop(p_stop_id, p_reason, p_actor_name)`** — atomic stop-skip for driver-app `cantCompleteStop`. Currently orphan-risk (described above).
- **`update_subscription(p_subscription_id, ...)`** — when subscription automation expands beyond the existing `pause-subscription` / `resume-subscription` / `cancel-subscription` edge functions, the admin's direct `recurring_interval` writes should route through here.
- **Windowing as a domain** (session 147 note) — `pickDefaultDeliveryWindow`, `snap_window_to_template`, `trg_create_recurring_order_fn`, and `place_pickup_order_for_customer`'s window resolution all answer variants of "what time should this window be?" with different rules. Worth consolidating into a single SECURITY DEFINER helper if windowing rules ever evolve (per-route defaults, customer preferences, holiday handling). Not blocking today.

---

## Verification SQL (run periodically)

To re-audit raw `.update()` sites in the future:

```bash
grep -rn "\.from\(['\"]\\(orders\\|route_stops\\|customers\\|routes\\|addresses\\)['\"]\)\\.update\(" \
  admin-dashboard/index.html driver-app/index.html customer-app/index.html pos/index.html \
  supabase/functions/*/index.ts
```

To verify GRANT discipline on mutation RPCs (anon/PUBLIC should NOT appear in `exec_grantees`):

```sql
SELECT p.proname,
       array_agg(DISTINCT acl.grantee::regrole::text) FILTER (WHERE acl.privilege_type='EXECUTE') AS exec_grantees
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL aclexplode(p.proacl) acl ON true
WHERE n.nspname='public' AND p.prosecdef = true
  AND p.proname NOT LIKE 'check_%' AND p.proname NOT LIKE 'find_%'
  AND p.proname NOT LIKE 'get_%' AND p.proname NOT LIKE 'customers_in_zone'
GROUP BY p.proname
HAVING 'anon' = ANY(array_agg(acl.grantee::regrole::text))
    OR '-'    = ANY(array_agg(acl.grantee::regrole::text));
```

⚠️ **Session 148 pt 8 lesson — REVOKE PUBLIC alone is NOT sufficient in Supabase.** Supabase grants the `anon` role EXECUTE separately from PUBLIC. Every new function migration MUST include BOTH:

```sql
REVOKE EXECUTE ON FUNCTION public.<name>(<args>) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.<name>(<args>) FROM anon;
GRANT  EXECUTE ON FUNCTION public.<name>(<args>) TO authenticated, service_role;
```

The pt 7 security review found 5 functions (skip_route_stop, is_staff, enforce_caller_owns_order, sync_profile_email_on_auth_change, enforce_pickup_before_delivery) had anon EXECUTE despite REVOKE PUBLIC being in their migrations. Fixed in `session_148_harden_grants_on_new_functions`.

To find transitive callers of guarded RPCs (session 148 pt 7 — surfaced both
the complete_route_stop → advance_order_status path and the POS regression):

```sql
SELECT p.proname AS caller,
  CASE WHEN p.prosecdef THEN 'SECURITY DEFINER' ELSE 'INVOKER' END AS sec,
  array_agg(DISTINCT target) AS calls
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL (VALUES
  ('advance_order_status'),('reschedule_order'),('reschedule_order_leg'),
  ('save_order_address'),('skip_route_stop')
) AS guarded(target)
WHERE n.nspname='public'
  AND p.proname <> guarded.target
  AND p.prosrc ~* ('\m' || target || '\M')
GROUP BY p.proname, p.prosecdef
ORDER BY p.proname;
```

⚠️ **`pg_proc.prosrc` includes comments and error-message text.** Every match
requires manual inspection. Typical false positives: COMMENT blocks, RAISE
EXCEPTION strings that reference other RPCs by name.

Also grep app code for every guarded RPC name across `admin-dashboard/`,
`driver-app/`, `customer-app/`, `pos/`, and `supabase/functions/*/`. Confirm
every caller's auth role can satisfy the guard. **Don't trust the app-side
audit alone** — transitive DB calls are invisible to it.
