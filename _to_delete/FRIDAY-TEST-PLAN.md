# Friday Test Plan — Subscription Soft Launch

**Goal:** Validate the subscription feature end-to-end on real accounts (not just David's), then open to a tiny group of trusted customers Friday afternoon for real-world surprise-discovery before Monday's public launch.

**Time budget:** ~3 hours

---

## Block 1 — Must-do tests (90 min, do these in order)

### Test 1.1 — Stripe webhook reality check (15 min)

The webhook is the critical seam where Stripe → our DB. If it's broken (wrong signing secret, etc.) we'd never know until a real signup. Verify before trusting it.

1. Open Stripe Dashboard → Developers → Webhooks → click the WashRoute webhook → "Signing secret" → copy.
2. Compare against Supabase Edge Functions → Settings → `STRIPE_WEBHOOK_SECRET`. **They must match.** If different, update Supabase to Stripe's current value.
3. Stripe Dashboard → Events → find a recent `invoice.payment_succeeded` event (David's $275 from June 2 should be there). Click it → "Resend webhook".
4. Verify the resend landed:
   ```sql
   -- Should see the subscription invoice already in customer_transactions
   -- (because the v45 webhook handler has idempotency on stripe_payment_intent_id,
   -- a resend won't duplicate the row but should return 200)
   SELECT type, amount, description, created_at FROM customer_transactions
   WHERE customer_id = '0140849f-5b36-4691-9c4f-08b9da5f0296'
     AND type = 'subscription_invoice'
   ORDER BY created_at DESC LIMIT 3;
   ```
5. Check Supabase Dashboard → Edge Functions → stripe-webhook → Logs → confirm the resend got 200 (not 400 = bad signature).

**Pass criteria:** Webhook returned 200, no duplicate customer_transactions row, no error in logs.

### Test 1.2 — Create a fresh test account, test new-card subscribe (30 min)

This is the **single biggest untested path**. David's account had a saved card from PAYG, so the Payment Element flow never ran with real card data.

1. Customer app → sign up with `dmacquart+sub3@gmail.com` (or any test email you can receive at). Use phone-OTP signup like a real customer.
2. Complete signup. Verify Account → Subscription menu item is **hidden** (this account isn't in the allowlist yet).
3. Add `dmacquart+sub3@gmail.com` to `SUBSCRIPTIONS_ALLOWLIST` in `customer-app/index.html` around line 1856. Commit + push.
4. Hard-reload after Vercel deploys (~30s).
5. Account → Subscription → Subscribe → **the Payment Element modal opens (not the saved-card modal).**
6. Enter a real card (yours or a trusted test card). Tap Subscribe.
7. Watch for: spinner during Stripe round-trip, success toast, pickup-day picker opens, home shows "0/100 lbs · 1 pickup · Renews on [next month]".
8. In admin → Reports → Subscriptions → the new subscriber row appears.
9. In admin → Customer profile → Billing tab → `customer_transactions` shows `subscription_invoice · $275.00` AND `lifetime_value` reflects it.

**Pass criteria:** End-to-end completes without leaving the app. New customer_transactions row + LTV bump.

### Test 1.3 — Subscriber order: under-cap (15 min)

Same test account.

1. Customer app → place a 2-bag pickup for tomorrow.
2. Booking confirm screen shows **$0.00 total**.
3. Confirm.
4. Admin → Orders → find the new order. Total = $0.00.
5. Admin → Processing → open the order's intake panel. Subtitle reads "100 lbs left this cycle — overage billed at $2.75/lb" (not the per-bag default).
6. Enter weight = **30 lbs**. Save & Start Processing. Total still $0.00. No lb_overage line item.
7. Walk it through Folding → Rack → Out for Delivery → Delivered.
8. charge-order should run when status → ready_for_delivery; for a $0 order it marks billing_status='paid' / billing_payment_method='subscription' with no Stripe charge.
9. Verify: subscription row shows `usage_lbs_this_period = 30, pickups_this_period = 1`.

**Pass criteria:** $0 charge, no overage line, usage increments correctly.

### Test 1.4 — Subscriber order: over-cap (15 min)

Same test account.

1. Customer app → place another 2-bag pickup.
2. Admin Processing intake → enter weight = **100 lbs** (this customer's plan cap is 100; first order ate 30, so 70 remain → 30 lbs overage).
3. Subtitle should read **"70 lbs left this cycle — overage billed at $2.75/lb"**.
4. After saving: total should reflect 30 lbs × $2.75 = **$82.50** lb_overage.
5. Move to ready_for_delivery → charge-order fires → customer's card charged $82.50.
6. Verify Stripe dashboard shows the $82.50 PaymentIntent succeeded.
7. Verify `subscription.usage_lbs_this_period = 130` and `overage_amount_due = 82.50` (or similar based on math).

**Pass criteria:** lb_overage line item math correct, real Stripe charge for $82.50, usage tracked correctly.

### Test 1.5 — Refund flow on the real subscription invoice (10 min)

While you have a fresh subscriber, validate the refund resolver works on a real (not backfilled) `stripe_payment_intent_id`.

1. Admin → Customer profile → Billing → find the `subscription_invoice · $275.00` row from Test 1.2.
2. Click the ↩ Refund button → enter $275 → reason "test" → Issue Refund.
3. Should complete in ~3-5s. Stripe dashboard shows refund.
4. `customer_transactions` should have a new `refund · $275.00` row.
5. Customer's `lifetime_value` should drop by $275 (back to whatever it was pre-subscription).

After verifying: re-charge them or just leave the test account with $0 LTV (it's a test account).

**Pass criteria:** Refund completes, ledger balanced.

### Test 1.6 — Cancel → Reactivate cycle (5 min)

On the test account (or David's):
1. Subscription → Cancel → confirm. Page shows "Cancelling · Cancels on Jul 2". Stripe dashboard confirms `cancel_at_period_end=true`.
2. Tap Reactivate → confirm. Page returns to normal Active state. Stripe dashboard confirms `cancel_at_period_end=false`.

**Pass criteria:** Both buttons work + UI updates correctly + Stripe state matches.

---

## Block 2 — Decision gate (5 min)

Before opening to trusted customers, answer YES to all of:
- [ ] All 6 tests in Block 1 passed
- [ ] No SMS alerts received during testing
- [ ] `_health_alerts` table has no critical entries from today
- [ ] Stripe webhook events show 200 status in Supabase edge function logs

If any NO: don't soft-launch. Triage + retest.

---

## Block 3 — Soft launch to trusted customers (30 min)

### 3.1 — Pick your trusted group (5 min)

3-5 customers you trust to text you back if something looks weird. Suggestions:
- Family + close friends who already use the service
- 1-2 high-frequency customers who've been asking about a subscription
- Avoid: brand-new customers, anyone you don't have a direct line to

### 3.2 — Add them to the allowlist (5 min)

Edit `customer-app/index.html` ~line 1856:

```js
const SUBSCRIPTIONS_ALLOWLIST = [
  'dmacquart@gmail.com',
  'dmacquart+wrsignup1@gmail.com',
  'dmacquart+sub3@gmail.com',
  // soft-launch group:
  'trusted-customer-1@example.com',
  'trusted-customer-2@example.com',
  // ...
];
```

Commit + push.

### 3.3 — Activate the plan (5 min)

Admin → Services & Pricing → Subscriptions → Edit → check **Active** → Save → confirm.

### 3.4 — Send the invitation SMS (15 min)

Suggested text to each:

> Hey [name], we just opened a new $275/month subscription that includes 100 lbs of wash & fold + unlimited pickups + free next-day delivery. You're getting early access before we launch publicly on Monday. The Subscribe button should appear in your customer app (hard-refresh if you don't see it). I'd love your feedback — text me if anything's confusing or broken. Thanks!

Send one at a time, with a small gap between sends, so you can respond quickly to questions.

---

## Block 4 — Monitor over the weekend (passive)

Check 2x daily Sat + Sun:

```sql
-- 1. Were there alerts?
SELECT alert_type, severity, message, created_at FROM _health_alerts
WHERE created_at > NOW() - INTERVAL '24 hours' AND alert_type != 'heartbeat'
ORDER BY created_at DESC;

-- 2. Did any soft-launch customer actually subscribe?
SELECT c.email_cache, s.status, s.signup_date, s.usage_lbs_this_period
FROM subscriptions s
JOIN customers c ON c.id = s.customer_id
WHERE c.email_cache != 'dmacquart@gmail.com'
  AND c.email_cache != 'dmacquart+wrsignup1@gmail.com'
  AND c.email_cache != 'dmacquart+sub3@gmail.com'
ORDER BY s.signup_date DESC;

-- 3. Stripe revenue
SELECT SUM(amount) FROM customer_transactions
WHERE type = 'subscription_invoice'
  AND created_at > NOW() - INTERVAL '3 days';
```

If any soft-launch customer hits an issue, the customer-app + admin are now production-tested by the time Monday arrives.

---

## Monday launch (per LAUNCH-RUNBOOK-275-SUBSCRIPTION.md)

Change `SUBSCRIPTIONS_ENABLED()` body to `return true;`. Commit + push. Done — the plan is already activated and tested.

---

## Rollback plan (if Friday goes south)

1. **Soft rollback** — admin → uncheck Active on the plan. Existing soft-launch subscribers keep their billing; no new signups possible.
2. **Yank the allowlist** — revert the `SUBSCRIPTIONS_ALLOWLIST` commit; the UI disappears for everyone.
3. **Cancel a specific soft-launch subscription** — Stripe Dashboard → Customer → Cancel subscription immediately. Refund last invoice if needed.

Document what broke in PROJECT-NOTES, then fix before retrying.
