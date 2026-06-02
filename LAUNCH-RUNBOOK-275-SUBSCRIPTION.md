# $275 Wash & Fold Monthly — Launch-Day Runbook

**Target launch:** Monday, June 8, 2026
**Owner:** David
**Estimated total time:** 10–15 minutes once the same-day pricing decision is made

This is the step-by-step for flipping the subscription live. Every step is reversible. The whole thing is designed so we can stop after any step without exposing anything to customers.

---

## Pre-flight (do this BEFORE launch day)

### 1. Decide the same-day surcharge rate

The announcement says **"Same-day delivery $14.95"**. The current `service_fees` row "Same-Day Surcharge" is **$10**. Three options:

| Option | What it does | Trade-off |
|---|---|---|
| A. Raise to $14.95 globally | Every customer pays $14.95 for same-day (subscribers + non-subscribers) | Non-subscribers see a $4.95 increase with no warning. |
| B. Add subscriber-specific row at $14.95 | Subscribers pay $14.95, non-subscribers stay at $10 | Requires customer-app code change to pick by sub status (~30 min). |
| C. Keep $10, update marketing copy | No code/data change; marketing flyers + the customer-app plan card features array drop "$14.95" | Easiest, but you've already announced $14.95 publicly. |

**Recommendation:** Option A is simplest and cleanest. Same-day is a premium service; a small rate bump is normal. Communicate to existing customers if helpful.

To execute A: Services & Pricing → Fees tab → Same-Day Surcharge → change $10 → $14.95 → save.

---

## Launch day (June 8)

### 2. Push the customer-app flag (one-line edit + commit)

In `customer-app/index.html`, around **line 1826**:

```js
const SUBSCRIPTIONS_ENABLED = false;   // ← change to true
```

Commit and push:

```bash
cd ~/Projects/WashRoute
git checkout main
git pull
# Edit the file (or use sed: sed -i '' 's/SUBSCRIPTIONS_ENABLED = false/SUBSCRIPTIONS_ENABLED = true/' customer-app/index.html)
git add customer-app/index.html
git commit -m "Launch: enable SUBSCRIPTIONS_ENABLED for $275 Wash & Fold Monthly"
git push origin main
```

Vercel auto-deploys in ~30 seconds. The customer-app's "My Plan" menu item + plan cards become visible — but only after step 3, because the customer-app loads ONLY `is_active=true` plans from the DB and there are still 0 of those.

**Why push customer-app first?** Defense in depth. If anything goes wrong with the UI deploy, the server-side gate (create-checkout's `if (!plan.is_active) → 403`) still blocks subscriptions.

### 3. Activate the plan in admin

Open admin → **Services & Pricing → Subscriptions tab**.

You'll see the new "Subscriptions" tab between "Point of Sale" and the existing tabs.

Click **Edit** on the row for **Wash & Fold Monthly · $275 · 100 lbs**. Verify all fields match the announcement:

- Name: `Wash & Fold Monthly`
- Description: matches announcement copy
- Price: `275.00`
- Included lbs: `100`
- Overage $/lb: `2.75`
- Pickup limit: *(blank = unlimited)*
- Stripe price ID: *(blank — will auto-create on first checkout)*

Check the **Active** checkbox at the bottom. A yellow warning banner will appear. Click **Save**. A confirmation modal will summarize the plan and ask "Activate this plan? Customers will be able to subscribe immediately." Click **OK**.

The plan is now live.

### 4. End-to-end test on your own account

Open the customer app, sign in as yourself. You should now see:

- A **"My Plan"** menu item in the Account section
- Tapping it shows the Wash & Fold Monthly $275 plan card with the features array
- Tap "Start subscription" → Stripe Checkout opens in a new tab
- Pay with a real card (or use a Stripe test card if you set up the test mode — production uses live keys)
- Return to the customer app, verify:
  - **Home screen** shows the new subscription card: "Active · Wash & Fold Monthly · 0 / 100 lbs · 100 lbs left · 0 pickups this cycle · Renews on Jul 8"
  - **My Plan** shows the detail panel with the same numbers + Pause / Cancel buttons
- In admin → Reports → Subscriptions, your row should appear with status "active", lbs left "100", "this cycle" for pickups, renewal date next month
- In admin → Customers → your record → Billing tab: subscription block + (eventually) "Past cycles" once your first month rolls over

### 5. Place a real test order to validate the bill-split

Book a delivery order from the customer app. Add an Oxi add-on. Schedule it for tomorrow.

At intake time (when the launderer weighs the order and moves it to ready_for_delivery), watch:
- `charge-order` should fire and charge your card for `add-ons + tip + same-day (if applicable)` ONLY, NOT the wash & fold base
- The order's `billing_notes` should read "subscription absorbed $X; $Z credit applied" if applicable
- Subscription `usage_lbs_this_period` should increment by the order's weight
- A row in `subscription_usage_log` should record `event_type='order_ready'` with the weight delta

If anything looks off, charge yourself a refund via admin → customer profile → Billing → Refund, and pause/cancel your own subscription from the customer app or admin.

### 6. Watch for the first real customer signup

Both the admin Inbox and Stripe dashboard show subscription events. Klaviyo's Welcome Series flow doesn't fire for subscription signups (it triggers on Email List, not on subscription create) — if you want a subscription-welcome flow, that's a separate Klaviyo flow design task.

---

## Rollback (if something goes wrong)

### Rollback the data (plan) — keeps existing subscribers active

Admin → Services & Pricing → Subscriptions → Edit "Wash & Fold Monthly" → uncheck **Active** → Save.

Effect: no new customers can subscribe (create-checkout's server gate refuses). Existing subscribers keep their Stripe billing + service. Customer-app stops showing the plan card for non-subscribers.

### Rollback the customer-app UI

```bash
cd ~/Projects/WashRoute
git revert --no-edit <the SUBSCRIPTIONS_ENABLED commit SHA>
git push origin main
```

Vercel redeploys in ~30s. The customer-app My Plan UI disappears entirely.

### Rollback the bill-split logic (only if a serious billing bug is discovered)

Apply the rollback SQL in `migrations-draft/session_165_subscription_bill_split.sql` (bottom of the file). Then redeploy charge-order from the prior git version. This restores the pre-launch behavior where the trigger stamps subscriber orders as `billing_status=paid`. Reverting this with active subscriptions would mean those subscribers retroactively pay $0 for their orders — only do this if there are 0 live subscriptions OR you intend to manually charge those subscribers separately.

---

## What's NOT in this launch

- **SMS opt-in for subscribers** — separate from the existing transactional SMS consent. Deferred until there's an actual SMS marketing campaign.
- **Subscription welcome email/SMS** — Klaviyo Welcome Series triggers on Email List add (signup), not on subscription create. If you want a "welcome subscriber" message, build a separate Klaviyo flow triggered on the standard `customer.subscription.created` event (`send-order-notification` would need to forward this, similar to how it forwards `Placed Order`).
- **Loyalty milestone rewards** — Phase 2 design from session 164. Not built. Requires pre-launch backfill of existing customer milestones before turning on (see session 164 note (e)).
- **POS subscription handling** — POS is retail-only; subscription orders flow through the delivery channel exclusively. No POS changes needed.

---

## Known limitations of the v1 launch (worth knowing, not blocking)

- **Cancelled orders after `ready_for_delivery` don't auto-reverse subscription usage.** If a launderer marks an order ready_for_delivery and then it gets cancelled (rare — customer would have to refuse delivery), the lb count was already deducted from the plan. Admin can manually adjust via Customer Profile → Billing → "✎ Adjust usage" button. Future v1.1: automatic reversal trigger.
- **Same-day surcharge dollar amount is one global value.** Per the pre-flight decision above. A subscriber-specific rate requires customer-app pricing logic.
- **The `overage_amount_due` column on `subscriptions` is now mostly informational.** It used to accumulate lb-overage settled at cancellation. With the new bill-split, lb-overage is charged per order at `ready_for_delivery`. The column still gets updated by the trigger but doesn't drive billing. Could be removed in a future cleanup migration.
