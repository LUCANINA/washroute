# WashRoute QA + Security Audit — May 6, 2026

System-wide audit across DB security (RLS, RPCs, advisors), edge functions, all 4 client apps (admin, customer, driver, POS), data integrity, and repo hygiene. Findings ranked P0 → P3 with file paths, line numbers, and remediation notes.

**Headline:** the apps themselves are in good shape — auth flows, XSS escaping, timezone handling, and the session-135 RPC refactor are holding up. **The serious risk surface is the database and edge function layer.** Several SECURITY DEFINER RPCs are callable by any signed-in user, three subscription edge functions accept arbitrary subscription_ids with no caller validation, `charge-order` itself has no caller auth, and one production logging table has RLS disabled. Plus ~$12K of customer credit balance has no ledger backing.

---

## 🔴 P0 — Fix before launch (or before the next session ends)

### P0-1 — `delete_orders(uuid[])` is SECURITY DEFINER, granted to `authenticated`, with **zero auth check**
**Verified.** Function source is literally `DELETE FROM orders WHERE id = ANY(p_ids);` — no `auth.uid()` check, no role check.
- ACL: `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}`
- Anyone signed in (any customer, driver, POS attendant) can call `db.rpc('delete_orders', { p_ids: [<any uuid>] })` and erase any orders.
- **Fix:** wrap with `IF NOT is_admin() THEN RAISE EXCEPTION 'forbidden'; END IF;` and revoke EXECUTE from `authenticated` (grant only to admin role / service_role). Sibling functions in the same family need the same gate: `delete_address(uuid)`, `delete_preference(uuid)`, `delete_service_zone(uuid)`, `update_preference_sort_order`, `update_service_sort_order`, `upsert_preference`, `upsert_service_zone`.

### P0-2 — `public.sms_optout_restore_log` has **RLS DISABLED** with 2,927 rows of phone numbers
**Verified.** `relrowsecurity = false`. Anon role has standard table grants on every public schema table, so this table is fully readable, writable, and deletable from any browser holding the anon key.
- **Fix:** `ALTER TABLE public.sms_optout_restore_log ENABLE ROW LEVEL SECURITY;` then add policies (admin SELECT, service_role ALL). If it's purely a backing log written by edge functions, revoke from anon/authenticated entirely.

### P0-3 — Subscription edge functions have **no `assertOwnership` check**
Files: `supabase/functions/cancel-subscription/index.ts:18-65`, `pause-subscription/index.ts:18-67`, `resume-subscription/index.ts:18-65`.
- All three accept `{ subscription_id }`, look up the row, call Stripe + mutate `subscriptions`, with no caller-vs-customer comparison. Anyone with the anon key can cancel/pause/resume any customer's subscription.
- PROJECT-NOTES.md has been tracking this as planned-but-unshipped since session 134.
- **Fix:** validate the `Authorization` header with `auth.getUser()`, resolve caller's `customer_id`, reject if `sub.customer_id !== caller.customer_id` unless the caller is admin. Same template as `create-staff/index.ts` (the only edge function that does this correctly today).

### P0-4 — `charge-order` edge function has **no caller auth** — anyone can trigger a real Stripe charge
File: `supabase/functions/charge-order/index.ts:60-77`.
- Accepts `{ orderId }` only. An anon attacker who can guess or enumerate an order UUID can off-session charge that customer's saved card. The order's `NON_CHARGEABLE_STATUSES` blacklist is a UX guard, not an auth boundary.
- **Fix:** require admin JWT (or service_role-bearing internal callers from `stripe-webhook` / `rack_order` flow). At minimum apply `requireAdmin(req)` per session 134's plan.

### P0-5 — `stripe-terminal` edge function: 6 of 9 actions skip shift validation
File: `supabase/functions/stripe-terminal/index.ts:71-150`.
- `connection_token`, `create_payment`, `charge_reader`, `cancel_payment`, `get_payment`, `cancel_reader_action` — none call `validateOpenShift(pos_shift_id)`. Only `list_recent_pos_sales`, `refund_pos_payment`, `delete_pos_order` are gated.
- `charge_reader` (line 105) creates card-present PaymentIntents and pushes them to the Stripe terminal reader — unauthenticated. An attacker can run charges through your readers from anywhere.
- **Fix:** apply `validateOpenShift` to every action. The pattern at lines 160 / 219 / 375 is the template.

### P0-6 — `voicemails` table + storage bucket are world-readable
- DB policies: `"Authenticated users can view voicemails" USING (true)`, `"Authenticated users can update voicemails" USING (true)` — every signed-in user (including any customer) can read every voicemail row and mark it listened.
- Storage policy `Public can read voicemails` on `bucket_id='voicemails'` makes the audio files themselves anonymously fetchable from storage URLs.
- Voicemails contain phone audio + transcripts → direct PII exposure.
- **Fix:** restrict DB SELECT/UPDATE to `is_admin()` (or `is_staff()`). Make the `voicemails` storage bucket private and serve via signed URLs.

### P0-7 — `cloudprnt` edge function: zero auth, leaks order content across all customers
File: `supabase/functions/cloudprnt/index.ts:251-329`.
- Anyone polling `GET /cloudprnt` (line 280) receives the next pending print job — receipt content with full PII (name, address, line items, totals).
- The DELETE/`?delete=` branch (line 265) lets any caller mark another printer's job as `done`, silently dropping the actual print.
- The `mac` parameter is a routing convenience, not an auth boundary; if omitted the function returns ANY pending job (line 262).
- **Fix:** require a per-printer shared secret in a header (e.g., `X-Printer-Token` checked against a hashed value in the `printers` table). Reject if `mac` missing or doesn't match an active printer.

### P0-8 — `send-receipt` edge function has no auth; receipt-spam vector + UUID confirmation oracle
File: `supabase/functions/send-receipt/index.ts:255-322`.
- Accepts `{ order_id }` only. Re-fires the SendGrid receipt to the order's customer with full PII. Spam-bombs customers + burns SendGrid budget + 200/400 response confirms whether an order_id exists.
- **Fix:** require admin JWT or restrict to service_role internal callers.

### P0-9 — Five edge functions are deployed but **not in the repo**
`send-sms`, `send-email`, `send-order-notification`, `twilio-webhook`, `get-stripe-fees` — referenced from other functions and the front-end, but no source under `supabase/functions/`. They cannot be audited.
- `send-sms` is the canonical "SMS spend on Twilio" risk; if anon-callable, anyone can blast SMS on the company's bill.
- `twilio-webhook` should verify the Twilio signature; cannot be confirmed.
- `stripe-webhook` POSTs to `send-sms` and `send-email` with the service role key as bearer — if those functions accept anon callers, the URL is the auth.
- **Fix:** `supabase functions download` for each. Commit. Re-audit. Until then, treat as unverified.

### P0-10 — Credit ledger drift: ~$3,600 in unbacked credit (81 customers, zero transaction history)
**Verified independently.** 81 customers have `customers.credits > 0` with **zero rows in `customer_transactions`**. Total stored: $3,625.65. The deeper agent sweep (counting drift in either direction across all customers) put the total absolute drift around $13,000 across ~396 customers; the `$3,625.65 / 81` subset is the strict "phantom credit, no audit trail" case.
- Examples: Amy Schneider $445.45, Jenny Herbert $440, John Kuhns $300, Luc Brickey $194.05.
- These look like manual SQL or a code path that wrote `customers.credits` directly without inserting a paired `customer_transactions` row. The session 128 invariant ("every credit write is paired with a ledger insert") is being violated somewhere.
- **Fix:** (a) backfill `credit_add` rows with `note='reconciliation backfill'` so the ledger reconciles for the 81 zero-history customers; (b) audit every code path that writes `customers.credits` (admin UI panel, cron, merge logic, edge functions) and ensure each is paired with a ledger insert; (c) add a CHECK trigger asserting any UPDATE to `customers.credits` requires a ledger insert in the same transaction.

---

## ⚠️ P1 — Should fix this week

### P1-1 — `routes` and `route_stops` readable by any authenticated user
Policies: `"Auth read routes" USING (true)`, `"Auth read route_stops" USING (true)`. Customers can read every driver's daily route plan + stop sequence, ETAs, and notes.
- **Fix:** scope SELECT to `is_admin() OR (driver_id = current_driver_id())` for staff, and a customer-narrow policy that exposes only the stop currently assigned to that customer's order.

### P1-2 — `drivers` table readable by any authenticated user
`"Auth read drivers" USING (true)` exposes driver names, phones, vehicles, hire dates to every customer login.
- **Fix:** `is_admin() OR (profile_id = auth.uid())` for staff/self, plus a customer-facing policy that exposes only the driver currently assigned to that customer's active stop.

### P1-3 — `claim_existing_customer` RPC accepts arbitrary `p_profile_id` — account hijack vector
Function takes `p_profile_id uuid` as a parameter and links a customer record to it without checking `p_profile_id = auth.uid()`. A freshly-signed-up phone-OTP user could pass another user's profile_id and inherit their order history.
- **Fix:** add `IF p_profile_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'forbidden'; END IF;` at the top. Same fix for `link_phone_auth_account`, `link_phone_auth_driver`.

### P1-4 — `prepare-phone-otp` edge function: phone-takeover vector via destructive auth-user mutation
File: `supabase/functions/prepare-phone-otp/index.ts:84-118`.
- Anyone calling with a phone number can cause `auth.users.phone` to be (re)set on the matching customer's auth user, deleting "orphan" auth users with that number along the way.
- **Fix:** don't perform the auth-user mutation in this pre-auth helper. Move it to a post-OTP verification step where the JWT proves possession of the phone.

### P1-5 — POS shift_id forgery boundary
The refund/delete flow gates on "open shift_id" (server-side `pos_shifts.ended_at IS NULL`). The POS app does not validate that the shift_id in localStorage actually belongs to the current device — a stolen or swapped shift_id from another open shift gets refund/delete powers on that shift's orders.
- **Fix:** server-side, verify the refund request's `shift_id` was opened by the `pos_device_id` claimed by the caller's auth.uid(). Pin shift→device at creation.

### P1-6 — Recurring auto-generation skipping 5.6% of expected weekly orders (37 orders, 60 days)
All 37 are B2B accounts (Kidango × 10 sites, Kasa Hotels × 2, Soul Sanctuary, Homebase Shelter, Extended Stay America, Fitnesse, Rachel Boller, Jennifer Felipe). Spot-checked: customers are still active and placing weekly orders manually — the auto-generation cron/trigger is silently missing weeks.
- **Fix:** inspect `trg_create_recurring_order_fn` (and any companion cron) for the chain-projection logic. Add a daily check that compares `recurring_interval='weekly'` deliveries against expected next-pickup dates and alerts on misses.

### P1-7 — 76 in-progress routes have stop/route driver mismatch
`route_stops.driver_id` doesn't match the route's `driver_id` AND doesn't match `pickup_driver_id` / `delivery_driver_id`. The driver app may attribute to the wrong person; per-stop overrides are being set without populating the explicit-override columns.
- **Fix:** backfill `route_stops.driver_id` to NULL where it matches the parent route's default driver (the explicit-override pattern), or formalize per-stop overrides by always populating `routes.pickup_driver_id` / `delivery_driver_id`.

### P1-8 — `order_events` insertable by any authenticated user with arbitrary `actor_name`
Policy: `order_events_authenticated_insert WITH CHECK (auth.uid() IS NOT NULL)`. Audit-trail pollution + actor impersonation.
- **Fix:** scope INSERT WITH CHECK to `is_admin() OR current_driver_id() IS NOT NULL OR pos_session_active()`, and add a BEFORE INSERT trigger that overwrites `actor_name` with a server-derived value.

### P1-9 — `draft-reply` edge function: no auth, leaks SMS history + burns Anthropic budget
File: `supabase/functions/draft-reply/index.ts:141-151`.
- Returns recent SMS thread per customer + AI-generated draft. No auth; no rate limit. Anon attacker can scrape SMS one customer at a time AND DoS the Anthropic spend.
- **Fix:** require admin JWT. Add a per-IP rate limit.

### P1-10 — `optimize-route` edge function: no auth, returns customer_ids in `at_risk` array
File: `supabase/functions/optimize-route/index.ts:399`.
- Lock down to admin/driver role check. Already verified its `verify_jwt:false` is intentional (session 129) but the in-function gate is missing.

### P1-11 — Stripe `pk_live` hardcoded in admin-dashboard
File: `admin-dashboard/index.html:4595`. Publishable key, so not a leaked secret per se, but blocks future key rotation without a code change.
- **Fix:** move to a settings table or environment-loaded value.

### P1-12 — GPS location data retention is indefinite
`driver_locations` rows accumulate forever; no TTL trigger and no cleanup on driver logout. Driver privacy gap + admin-readable history grows unbounded.
- **Fix:** add a daily cron that deletes `driver_locations` rows older than 7 days. Optionally, clear on driver logout.

### P1-13 — POS receipt timestamps hardcoded to `America/Los_Angeles`
File: `pos/index.html:5624,5695`. Foothill is in Pacific, but any future multi-location rollout will print wrong times.
- **Fix:** load timezone from a per-site setting or `BIZ_TZ` constant.

### P1-14 — `.gitignore` is missing `.env*`, `*.key`, `*.pem`, IDE configs
Root `.gitignore` has only 5 entries (`.vercel`, `.DS_Store`, `node_modules`, `*.log`, `washroute.skill`). A future `.env.local` with a service role key in it could be committed by accident.
- **Fix:** add `.env`, `.env.*`, `*.key`, `*.pem`, `*.p12`, `.vscode/`, `.idea/`, `zi*` patterns. Check `customer-app-native/.gitignore` for the same gaps.

---

## 📋 P2 — Best-practice gaps + cleanup

- **P2-1.** `is_admin()` includes role values `manager`, `laundry_tech` — function name implies admin-only but laundry techs get write access on every admin policy. Decide intent; if not, split into `is_admin()` and `is_staff()`.
- **P2-2.** `apply_signup_promo_credit` has the anon JWT compiled into plpgsql source as a string literal. Pin in `vault.secrets` instead.
- **P2-3.** Several SECURITY DEFINER functions don't `SET search_path` (advisor lint `function_search_path_mutable`). Risk is small but it's the documented best practice.
- **P2-4.** Wildcard CORS (`Access-Control-Allow-Origin: *`) on every edge function except `create-staff` (which gates origin via env). Tighten to known production origins.
- **P2-5.** Refund + delete in POS lack `_chargeInFlight`-style boolean re-entrancy locks. Fast double-tap could fire two edge function calls. Pos:4330,5219.
- **P2-6.** Driver-app missing role gate at `_handleDriverSession`: if `currentDriver` doesn't load successfully, `appReady = true` still fires. Defense-in-depth gap; RLS still enforces, but worth an explicit `if (!currentDriver) doSignOut()` guard.
- **P2-7.** 26 post-pickup orders with NULL `actual_pickup_at`. Backfill from `route_stops.completed_at` or `created_at`. Then audit the manual status-change flow in admin to ensure it sets the timestamp.
- **P2-8.** Order #3556 ghost: NULL `customer_id`, NULL pickup window, status=`delivered`. Delete it and add a NOT NULL constraint on `orders.customer_id`.
- **P2-9.** 286 phone format mismatches between `profiles.phone` and `auth.users.phone` (same number, different normalization). One-shot E.164 migration + sync trigger.
- **P2-10.** 50 customers with `stripe_customer_id` set but no card on file. UX gap; flag in dashboard so support knows these accounts can't auto-charge.
- **P2-11.** 10 line-item drift orders (~$1–22 each, all B2B). Audit the codepath that updates `total_amount` after editing `line_items`; flat-fee discounts may be applied to the total but not represented as a line item.
- **P2-12.** Customer-app: two hardcoded timezone strings instead of `BIZ_TZ` constant at lines 7272–7273 and 7461. Two-line fix.
- **P2-13.** Untracked clutter in repo root: 4 `zi*` zip archives (skill snapshots), several PDFs/docx (marketing material), test reports, stale skill docs. Clean up + add `zi*` to `.gitignore`.
- **P2-14.** Storage bucket `stop-photos` policies grant anon ALL (INSERT, SELECT, UPDATE, DELETE). Anon DELETE on every photo means anyone can wipe proof-of-delivery. Tighten `cmd` to `INSERT, SELECT` for anon.
- **P2-15.** Hardcoded URLs in `send-magic-link` and `send-receipt` (`https://washroute.vercel.app`, FROM_EMAIL constants). Move to `Deno.env`.

---

## 🧹 P3 — Informational / minor cleanup

- 132 stop/driver mismatches on completed routes (historical noise, can backfill in single UPDATE).
- 133 stop/driver mismatches on scheduled future routes (same fix as P1-7 will catch).
- 13 `draft_events` older than 30 days.
- 4 unread voicemails > 7 days (someone needs to listen).
- 10 profile/auth email mismatches (mostly profiles with email, auth.users.email NULL — phone-only auth users).
- POS tax calculation tolerance check uses `+ 0.005` floating-point fuzz at line 5212. Edge-correct, but documenting.
- Customer-app fetch cache option syntax `cache: no-store` (string-literal value) at line 1687. Works in modern browsers but stricter to use `cache: 'no-store'`.

---

## What's working well

The session 135 RPC refactor pass is paying off — admin and customer-app both correctly route schedule changes through `reschedule_order_leg`, status changes through `advance_order_status`, intake through `record_order_intake`, racking through `rack_order`. Raw `db.from('orders').update(...)` calls in admin are limited to legitimate edge cases (site_id assignment, recurrence toggle, charge-retry billing patches) and are documented.

Customer-app auth-orphan prevention is robust: every signup path pre-checks via `check_account_exists` and post-claims via `claim_existing_customer`. Address NULL-coord hard-block from session 130 is intact.

XSS escaping is consistent: `esc()` / `escHtml()` / `escAttrJSArg()` defined at the top of each app and applied at every DB-sourced innerHTML interpolation site. POS got its `esc()` helper in session 139 and the four flagged paths are all covered.

Timezone handling: every `toLocaleDateString` / `toLocaleTimeString` / `toLocaleString` call I sampled either includes `timeZone: BIZ_TZ` or formats numbers (no date involved). The pacific-helpers library (session 134) is in use.

`stripe-webhook` correctly verifies the Stripe signature via `constructEventAsync`. `create-staff` is the only edge function that does internal auth correctly today (admin JWT + restricted CORS via env) — use it as the template for the P0 edge function fixes.

No hardcoded secret keys (`sk_live`, `whsec_`, Twilio auth token, SendGrid key, Supabase service role) found in any tracked file. Stripe `pk_live` in admin is publishable, so safe but worth moving to config (P1-11).

---

## Suggested fix order

**Today / next session:**
1. P0-1, P0-2, P0-6 — RLS on `sms_optout_restore_log`, gate `delete_orders` and the admin helper RPCs, lock down `voicemails`. Pure SQL, ~30 min.
2. P0-3, P0-4, P0-5, P0-7, P0-8 — add `assertOwnership` / `requireAdmin` to subscription functions, `charge-order`, `send-receipt`; gate every `stripe-terminal` action on shift; printer-token auth on `cloudprnt`. Edge function deploys.
3. P0-9 — pull deployed source for the 5 missing functions (`send-sms`, `send-email`, `send-order-notification`, `twilio-webhook`, `get-stripe-fees`), commit, re-audit.
4. P0-10 — credit ledger reconciliation backfill + add the trigger that requires a paired ledger insert.

**This week:**
5. P1-1 / P1-2 (routes, route_stops, drivers RLS scoping)
6. P1-3 (claim_existing_customer auth.uid check), P1-4 (prepare-phone-otp redesign)
7. P1-5 (POS shift_id binding)
8. P1-6 (recurring chain auto-gen audit)
9. P1-14 (.gitignore tightening — quick win)

**Next sprint:**
10. P1-7 (driver/route attribution backfill), P1-8 (order_events scope)
11. P1-9, P1-10 (auth + rate limits on `draft-reply`, `optimize-route`)
12. P2 sweep at next quiet day — P2-1 through P2-15 are individually small but add up to a meaningful hardening pass.
13. P3 janitorial when convenient.

---

*Generated by parallel audit pass — 7 specialized agents (RLS+advisors, edge functions, admin QA, customer-app QA, driver+POS QA, data integrity sweep, secret leakage). Findings independently spot-checked on highest-severity items (delete_orders source, sms_optout_restore_log RLS state, voicemails policies, credit ledger drift count).*
