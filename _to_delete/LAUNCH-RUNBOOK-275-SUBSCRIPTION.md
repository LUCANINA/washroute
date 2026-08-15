# $275 Wash & Fold Monthly — Launch-Day Runbook

**Target launch:** Monday, June 8, 2026
**Owner:** David
**Estimated total time:** 10–15 minutes from start to "live"

This is the step-by-step for flipping the subscription live. Every step is reversible. The whole thing is designed so we can stop after any step without exposing anything to customers. Sessions 166 + 167 rebuilt the architecture from the v1 bill-split overlay into a clean subscription-as-pricelist model + in-app subscribe modal. This runbook reflects the final state.

---

## Architecture summary (one paragraph)

Subscribers are customers with `pricelist = 'Subscription'`. The Subscription pricelist has its own Wash & Fold service ($0/bag) and Delivery Fee ($0). When a subscriber places an order, the order naturally has $0 base + $0 delivery — no display-layer derivations anywhere. At `ready_for_delivery`, a DB trigger writes a `lb_overage` line item to the order if the customer's weight + prior cycle usage exceeds the plan cap (100 lbs × $2.75/lb). `charge-order` then charges the residual (lb_overage + add-ons + same-day + tip). Stripe handles the $275 monthly invoice independently; the `invoice.payment_succeeded` webhook records each invoice to `customer_transactions` with `type='subscription_invoice'` and bumps `customers.lifetime_value` so reporting stays accurate. Cancellation is scheduled (`cancel_at_period_end=true` on Stripe + DB), the customer keeps service through the paid period, then the `customer.subscription.deleted` webhook fires and restores `customers.pricelist` from the snapshot stored on the subscriptions row.

---

## Pre-flight (do this BEFORE launch day)

### 1. Same-day surcharge — *decision made: leave at $10 for launch*

David's call (June 2): keep `service_fees.Same-Day Surcharge` at **$10** for the launch. Raise to **$14.95** the following week via Services & Pricing → Fees tab. Same-day is a global fee, not pricelist-specific — same value for everyone.

Plan card lists "Same-day delivery $14.95" — customers will see $10 the first week. Recommend leaving as-is (positive surprise) rather than editing the plan features array twice.

### 2. Confirm system health

```sql
-- No duplicate services that could poison .find()
SELECT name, COUNT(*) FROM services
WHERE is_addon=false AND show_in_app=true AND is_active=true
GROUP BY name, sort_order HAVING COUNT(*) > 1;
-- Expected: 0 rows (HOTFIX-class check)

-- The subscription plan exists and is currently INACTIVE
SELECT id, name, price_monthly, weight_limit_lbs, overage_price_per_lb, pickup_limit, is_active
FROM subscription_plans
WHERE name ILIKE '%monthly%';
-- Expected: 1 row, is_active=false, price_monthly=275, weight_limit_lbs=100

-- The Subscription pricelist services exist
SELECT name, pricelist, base_price, is_active, show_in_app FROM services WHERE pricelist='Subscription';
SELECT name, pricelist, amount FROM service_fees WHERE pricelist='Subscription';
-- Expected: Wash & Fold $0/bag + Delivery Fee $0
```

### 3. Confirm no live subscribers other than David's test account

```sql
SELECT customer_id, status, stripe_subscription_id FROM subscriptions
WHERE status IN ('active','past_due','paused','incomplete');
-- Expected: 1 row (David's test). If others present, investigate.
```

If you want to wipe David's test sub before launch (clean slate): cancel it via the customer-app (sets cancel_at_period_end=true) then in Stripe dashboard "Cancel immediately" — the webhook will fire and clean the DB.

---

## Launch day (June 8) — 3 steps

### Step 1: Flip the customer-app allowlist (one-line edit + commit)

In `customer-app/index.html`, search for `function SUBSCRIPTIONS_ENABLED()` (around line 1855). The function currently returns true ONLY for emails in the allowlist:

```js
function SUBSCRIPTIONS_ENABLED() {
  const allowed = ['dmacquart@gmail.com', 'dmacquart+wrsignup1@gmail.com'];
  return currentUser?.email && allowed.includes(currentUser.email.toLowerCase());
}
```

Change the body to just `return true;`:

```js
function SUBSCRIPTIONS_ENABLED() {
  return true;
}
```

Commit and push:

```bash
cd ~/Projects/WashRoute
git checkout main
git pull
# Edit the file
git add customer-app/index.html
git commit -m "Launch: open subscriptions to all customers"
git push origin main
```

Vercel auto-deploys in ~30 seconds. The customer-app's "Subscription" menu item + plan cards become visible to every signed-in customer.

**Why customer-app first?** Defense in depth. If anything goes wrong with the UI deploy, the server-side `create-subscription` gate (`if (!plan.is_active) → 403`) still refuses new signups.

### Step 2: Activate the plan in admin

Open admin → **Services & Pricing → Subscriptions tab** → click **Edit** on the "Monthly Subscription / $275 / 100 lbs" row.

Verify:
- Name: `Monthly Subscription` (or whatever name you want customers to see)
- Price: `275.00`
- Included lbs: `100`
- Overage $/lb: `2.75`
- Pickup limit: *(blank = unlimited)*

Check the **Active** checkbox → Save → confirm the activation modal.

The plan is now live. New customers can subscribe immediately.

### Step 3: End-to-end smoke test on your own account

Open the customer app, sign in as yourself. Confirm:

1. **Plan card visible** — Account → Subscription shows the $275 plan card.
2. **Tap "Subscribe"** — if you have a saved card on file, you should see the in-app confirm modal with your saved card. If not, you'll see the Payment Element modal where you enter card details.
3. **Confirm** — modal closes within 3-5 seconds → "Subscription active 🎉" toast → pickup-day picker opens.
4. **Home screen** — subscription card shows "Active · Monthly Subscription · 0 / 100 lbs · 100 lbs left · 1 pickups this cycle · Renews on Jul 8."
5. **Admin → Reports → Subscriptions** — your row should appear with status="active", 100 lbs left.
6. **Admin → Customer → Billing tab** — recent transactions show `subscription_invoice · $275.00`. Your `lifetime_value` has the $275 included.
7. **Place a test order** — book a 2-bag pickup. Booking confirm screen shows "$0.00 total." Order is created with $0 line_items.
8. **Walk it through processing** — admin intake weighs at 50 lbs, then move to ready_for_delivery. Charge-order runs but charges $0. Subscription `usage_lbs_this_period` increments by 50.
9. **Place an over-cap test order** — book another, weigh at 75 lbs. At ready_for_delivery, the trigger writes a `lb_overage` line item: "25 lbs × $2.75 = $68.75". Charge-order charges $68.75.

If any step fails: see Rollback below.

---

## Rollback (if something goes wrong)

### Soft rollback (recommended first response)

Admin → Services & Pricing → Subscriptions → Edit → uncheck **Active** → Save.

Effect: no new subscriptions can be created (server-side gate refuses). Existing subscribers keep their Stripe billing + service. Customer-app stops showing the plan card for everyone.

This is reversible — re-check Active to resume.

### Hard rollback (customer-app UI)

```bash
cd ~/Projects/WashRoute
git revert --no-edit <the SUBSCRIPTIONS_ENABLED commit SHA>
git push origin main
```

Vercel redeploys in ~30s. The Subscription UI disappears entirely. Server-side state untouched.

### Hard rollback (architecture)

If something is fundamentally broken with the subscription pricelist, the rollback is heavier:

1. Cancel all live Stripe subscriptions via Stripe dashboard (one-time, irreversible from customer's perspective)
2. Flip plan inactive
3. Don't touch the DB schema — the Subscription pricelist data is benign without any active subscribers

The DB-side trigger + RPC changes are designed to be no-ops for non-subscribers, so they can stay live.

---

## What's wired up (so you know what works)

### Customer-app

- **Subscribe (saved card)** — taps Subscribe → in-app bottom-sheet modal → confirms via existing card → server-side `create-subscription` → webhook handles DB sync.
- **Subscribe (new card)** — taps Subscribe → modal with Stripe Payment Element → enters card → SetupIntent confirmation → card saved + set as default → subscription created.
- **Cancel** — taps Cancel Subscription → confirm dialog → `cancel-subscription` edge function → sets `cancel_at_period_end=true` on Stripe + DB.
- **Reactivate** — appears when scheduled to cancel → taps Reactivate → `resume-subscription` clears `cancel_at_period_end` on both sides.
- **Dunning banner** — appears on home subscription card when status=`past_due` → deep-links to Account → Payment.
- **Spinners** — all three subscription buttons (Subscribe / Cancel / Reactivate) show a white spinner + "Processing…" during the Stripe round-trip.
- **Usage display** — "X / 100 lbs · Y lbs left" on the home card + Subscription panel.

### Admin

- **Services & Pricing → Subscriptions tab** — plan CRUD + Active toggle.
- **Reports → Subscriptions** — 6 KPI tiles (Active Subs / Cancelled / Recurring Rev / Overage Rev / Avg Usage / Avg Revenue) + table.
- **Customer Profile → Billing tab → Subscription block** — shows current sub + Past Cycles history.
- **Refund subscription invoices** — refund button works on `customer_transactions` rows of type `subscription_invoice` (auto-resolves payment_intent for backfilled rows via Stripe API).

### Server-side (edge functions + DB triggers)

- `create-subscription` v1 — saved-card path (idempotency-keyed)
- `create-setup-intent` v18 — used by new-card path
- `save-payment-method` v19 — used by new-card path
- `cancel-subscription` v8 — scheduled cancel
- `resume-subscription` v9 — unpause OR clear cancel_at_period_end (reactivate)
- `stripe-webhook` v45 — customer.subscription.created/deleted/updated + invoice.payment_succeeded with LTV recording
- `charge-order` v44 — handles $0 subscriber orders (billing_payment_method='subscription' branch)
- `refund-charge` v23 — handles type='subscription_invoice'
- `send-receipt` v38 — net credit + lb_overage in DISPLAY_TYPES
- DB trigger `apply_subscription_usage_fn` — idempotent via `orders.subscription_usage_lbs_applied` column
- DB trigger `trg_create_recurring_order_fn` — Subscription branch added (rebuilds line_items at $0)
- RPC `create_order_for_customer` — relaxed base_amount guard for Subscription pricelist only

---

## Known limitations of the launch (not blockers)

- **Usage doesn't auto-reverse on order cancellation.** If a subscriber order makes it to `ready_for_delivery` (usage incremented) and is then cancelled, the lbs stay deducted. Admin has an "Adjust usage" button. Future trigger work could auto-reverse.
- **Recurring order chain stale-line-items after subscription cancel.** If a customer cancels mid-recurring-chain, their next scheduled recurring order may carry stale $0 line_items even though their pricelist is now Delivery. Admin can manually reprice. Documented edge case.
- **Subscription welcome email/SMS** — not built. Klaviyo Welcome Series only fires on Email List add, not on subscription create. If desired, create a separate Klaviyo flow triggered on a custom `Subscribed` event forwarded by stripe-webhook.
- **Apple Pay / Google Pay in Payment Element** — supported by Stripe but requires Apple Pay domain verification (not done). The new-card modal will only show the card input field on day 1.
- **`overage_amount_due` column** — vestigial from the v1 architecture. The lb_overage line item on each order is the source of truth now. Column can be dropped in a cleanup migration post-launch.

---

## What's NOT in this launch

- POS subscription handling (POS is retail-only; subscription is delivery-only)
- Loyalty milestone rewards (separate Phase 2 design from session 164)
- SMS marketing opt-in for subscribers
- Admin "subscribe customer on their behalf" flow (admin can only manage existing subs)

---

## Test cards (for QA without real money — if Stripe test mode)

If you switch to test mode for QA:
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`
- Insufficient funds: `4000 0000 0000 9995`

David's account is in live mode, so launch testing happens with real charges. Refund yourself via admin if needed.

---

## Post-launch monitoring (first week)

- **Stripe dashboard** — watch for subscription_invoice payments + any payment_failed events
- **Admin → Reports → Subscriptions** — daily glance at active subscriber count + revenue
- **Postgres logs** — `_rpc_warnings` table for any unusual RPC behavior
- **Klaviyo events** — Placed Order events should keep firing for subscriber orders (with `$value` = card-side residual)
- **send-receipt + send-order-notification logs** — should be quiet; any spike = customer-visible problem
