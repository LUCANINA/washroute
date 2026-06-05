# Session 168 — Deep QA Review

*Date: June 5, 2026. Reviewer: Claude (3 parallel audit agents + live-code verification). Scope: everything changed today — subscription pickup picker, recurring/overage triggers, the overage double-charge fix, admin address fix, server-side allowlist, POS commercial/on-account support, and the Stripe webhook secret fix.*

**Bottom line:** the core flows are sound and the day's bug fixes hold up under scrutiny. The most valuable output of this review is **architectural**, not a bug list — the same underlying weakness (too many independent writers to `orders.line_items` / `total_amount`, and too much logic duplicated across surfaces) produced *most* of today's bugs and will keep producing them until consolidated. Two of the audit's loudest "critical" findings were **false positives** that, if "fixed", would have broken working billing — documented at the bottom so they don't get re-raised.

Nothing here was changed in code during this review (you asked for analysis, and I won't stack unreviewed edits to money-handling code over the weekend). Everything is a recommendation with a priority.

---

## 1. Architectural improvement areas (the important part)

### A1. `orders.line_items` + `total_amount` have ~4 independent writers that don't compose — **highest-leverage fix**
Today a single order's line items / total can be written or rebuilt by, in sequence:
1. **Customer-app picker** (`saveSubscriptionPickupPreference`) — builds base + delivery + same-day + standing add-ons at booking.
2. **Recurring trigger** (`trg_create_recurring_order_fn`) — on each cycle, *rebuilds* line items for the child order and *carries forward* a subset of the parent's lines.
3. **Admin processing intake** (`_buildIntakeLineItems` / `saveIntake`) — at weigh-in, **discards the existing line_items and rebuilds them from scratch** (base + prefs→`pref_service` + add-on services + …).
4. **Overage trigger** (`apply_subscription_usage_fn`) — at `ready_for_delivery`, strips any existing `lb_overage`, recomputes it from weight, and adjusts `total_amount`.

Each actor assumes a different thing about what's already in `line_items`. Reasoning about the *final* state of any subscriber order requires mentally executing all four in order. **This is the root cause of today's overage double-charge** (intake wrote `overage` while the trigger wrote `lb_overage`), and it makes several other behaviors unverifiable by inspection (see N1 below).

**Recommendation:** establish a single authoritative "price this order" path and make every surface call it instead of re-deriving. Notably, **`compute_subscription_residual(order_id)` already exists in the database** — it was built in session 165 to be exactly this authority — but `charge-order` (v45) no longer calls it; the v2 pricelist rewrite routed overage through the trigger→`total_amount` instead, orphaning the RPC. Decide on ONE model:
- (a) the trigger owns `line_items`/`total_amount` and `charge-order` charges what it sees (today's de-facto model — works, but fragile because intake rebuilds), **or**
- (b) `charge-order` calls `compute_subscription_residual` and is the sole arbiter (the originally-intended model; then drop the dead RPC if going with (a)).
Either is fine; the current half-and-half is what bites. Also: **`record_order_intake` should not fully rebuild `line_items`** — it should merge (preserve `same_day_surcharge`, etc.) or be the single pricing authority itself.

### A2. Pricing/billing resolution is re-implemented per surface instead of shared
"Resolve the right price for this customer's pricelist" now exists in: the customer-app booking flow (`getCustomerService`/`getCustomerFees`), the subscription picker (`_subPaidAddonsFromPrefs` + direct service queries), the admin intake (`calcProcTotal`), the recurring trigger, and now the POS (`applyCustomerPricelist`). Each is a slightly different copy. Today's `$59-instead-of-$0` picker bug and the POS retail-only bug were both "this surface forgot to resolve by pricelist." **Recommendation:** a single server-side `resolve_service_price(customer_id, service_name)` (or a shared client helper) that every surface calls. The POS should consume the same pricing source as everything else rather than hard-coding `pricelist='Retail'`.

### A3. UI flags / client caches are treated as boundaries when they aren't
Recurring theme across sessions and today: `SUBSCRIPTIONS_ENABLED` (UI) vs the server allowlist; the admin **excludes on-account orders from charging only in client-side filter code** (`charge-order` itself has no `billing_type` guard); the admin order/customer **caches** (`allOrders`/`allCustomers`) drove the "order not appearing" and "No address on file" issues. **Recommendation:** every money/visibility rule needs a server-side enforcement (RLS / edge-function guard / RPC), with the UI as convenience only. Detail views should resolve from per-record joins (as the address fix now does), not cached arrays.

### A4. Money-handling code has no automated regression tests
Every bug today (webhook secret, $59 pricing, overage double-charge, address) was found by manual click-testing, and several were already in production. The `washroute-test` skill exists but isn't applied to billing. **Recommendation:** a small suite of scripted scenarios (subscriber under-cap, over-cap, with add-ons, same-day, recurring cycle, on-account POS) that asserts the final `total_amount` + `line_items` + ledger. This is the single best defense against A1/A2 regressions.

### A5. No monitoring on the Stripe→DB seam
The webhook signing-secret mismatch silently rejected *every* Stripe event (400s) and was only caught because the $275 invoice had to be hand-backfilled. **Recommendation:** add a check to the existing health-monitor (sessions 167's `_health_alerts`) that alerts if `stripe-webhook` returns non-200s or if a subscription exists with no recent `subscription_invoice` row. Config drift on secrets should page, not lurk.

---

## 2. Verified findings (real, by severity)

> "Mine-today" = introduced or touched in this session. "Pre-existing" = latent before today.

### HIGH
- **None confirmed.** (Both agent-flagged "highs/criticals" were false positives — see §4.)

### MEDIUM
- **M1 — POS: `applyCustomerPricelist` not awaited in `attachCustomer` (race).** *(mine-today, pos/index.html)* If a cashier attaches a Commercial customer and adds an item within the ~200ms pricelist fetch, the tile is still Retail-priced. Mitigated by `_repriceCartToPricelist()` running after the fetch (it reprices existing cart lines), so the cart self-corrects — but a charge completed inside that window could save at Retail. **Fix:** make `attachCustomer` await the pricelist load (and its callers), or disable Charge until `_plPriceMap` resolves.
- **M2 — `charge-order` has no `billing_type='on_account'` guard.** *(pre-existing; my POS comment overstated the protection)* Only the admin *batch retry* filters out on-account customers; `charge-order` itself doesn't load `billing_type`. If the processing→`ready_for_delivery` charge path fires on the new POS on-account order (City of Oakland has no card), it'll mark `billing_status='failed'` (still counted as owed, so it's still invoiced — not a double-charge, but a spurious failed status + a possible failed-payment notification). **Fix:** add `if (customer.billing_type === 'on_account') return early` in `charge-order`; correct the POS comment. **Verify first:** whether the ready_for_delivery transition actually invokes `charge-order` for these orders.
- **M3 — `create-checkout` `customerId` path has no ownership check.** *(pre-existing; legacy function, no longer called by the UI but still deployed, `verify_jwt:false`)* The `customerId` lookup accepts any customer UUID with no auth, so a `type:'setup'` call could attach/capture a card on someone else's Stripe customer. `create-subscription` is correctly ownership-gated; `create-checkout` is not. **Fix:** add the same ownership check, or retire `create-checkout` now that the in-app flows use `create-subscription`.
- **M4 — Subscription usage isn't reversed on cancel/skip after `ready_for_delivery`.** *(pre-existing)* `apply_subscription_usage_fn` only fires *into* `ready_for_delivery`; if an order is later cancelled, `usage_lbs_this_period` stays inflated and the customer's remaining-lbs is wrong. Manual "Adjust Usage" button is the current workaround. **Fix:** reverse the delta on transition out of ready_for_delivery / on cancel.

### LOW
- **L1 — Monday launch reminder (deployment):** empty the `SUBSCRIPTION_ALLOWLIST` array in **both** `create-subscription` and `create-checkout` and redeploy, alongside flipping `SUBSCRIPTIONS_ENABLED()` → `return true`. Plan is already active. *(Already in PROJECT-NOTES; repeating because it's easy to miss the second function.)*
- **L2 — POS commercial orders show under the admin "Retail" segment** (`source='walk_in'`). Pricing/line-items are correct; only the segment label is off. Cosmetic.
- **L3 — POS doesn't block `Subscription`/`Delivery`-pricelist customers at the counter.** Their per-bag pricing won't reprice (pricing_type mismatch → stays Retail, which is safe but not "correct"). These customers aren't expected at the counter; a guard/toast would prevent confusion.
- **L4 — Picker preview has minor stale-state edges** (async `updateDeliveryPreview` can paint stale results if the user changes selection mid-fetch; local `_sameDaySurcharge` cached for the session). Cosmetic; the *saved* order recomputes correctly.
- **L5 — Dead code:** `compute_subscription_residual` RPC is no longer called by `charge-order`. Either wire it back (A1 option b) or remove it so it doesn't mislead future work.

---

## 3. Needs verification before launch / first recurring cycle (tests to run, not assumptions)

- **N1 — Does `same_day_surcharge` survive admin intake on a recurring subscription order?** The recurring trigger carries `same_day_surcharge` forward to the child, but `_buildIntakeLineItems` **rebuilds `line_items` from scratch** at weigh-in and does not appear to re-add same-day. If so, recurring same-day deliveries would be delivered same-day but **not charged the surcharge** (a revenue *leak*, opposite of a double-charge). The inherited `lb_overage` is safely neutralized by the overage trigger (it strips + recomputes), so that one's fine — but same-day needs an end-to-end test. **No urgency yet:** the first recurring child can't exist until ~1 week after the first real subscriber's first order, so there's time — but it must be tested before then. *(This is the strongest argument for A1.)*
- **N2 — Confirm M2:** trace whether `ready_for_delivery` actually invokes `charge-order` for an on-account POS order. If yes, add the guard before any real commercial counter order is processed.
- **N3 — POS on-account end-to-end:** process a real City of Oakland order via the POS, advance it to ready_for_delivery/delivered, and confirm it lands in their on-account **balance** and the monthly invoice with the correct Commercial total — and is **never** Stripe-charged.

---

## 4. False positives caught (do NOT act on these — verification record)

- **FP1 — "`charge-order` never bills subscription overage; it doesn't call `compute_subscription_residual`."** **False.** The audit agent read the discarded session-165 v1 migration draft. The *live* `apply_subscription_usage_fn` trigger appends the `lb_overage` line to `line_items` **and** sets `NEW.total_amount := total − existing_overage + new_overage` at `ready_for_delivery`; `charge-order` then charges `total_amount`, which includes the overage. Confirmed empirically: order #6533 carried a trigger-written `lb_overage` line and was really charged for it. (The RPC is orphaned dead code — see L5 — but overage *is* charged.)
- **FP2 — "Intake overage subtraction applies the discount the wrong way; remove the `(1 − discount)` factor."** **False.** `savedTotal` (= `preTipTotal`) already has the percent discount applied across the whole subtotal *including* overage, so the overage's net contribution to it is `overage × (1 − discountPct)` — which is exactly what the code subtracts. Removing the factor would **over-subtract** and underbill discounted subscribers. Verified algebraically (e.g. $137.50 overage @10%: net contribution $123.75, matches the formula).
- **FP3 — "Recurring trigger missing delta logic → overage double-counts across cycles."** **Effectively false.** Each recurring child is created fresh (`subscription_usage_lbs_applied` not copied), and any carried `lb_overage` is stripped + recomputed by the overage trigger at the child's own `ready_for_delivery`. No double. (The real open question is the *opposite* — same-day possibly lost at intake, N1.)

---

## 5. Suggested priority order

1. **Decide A1** (single billing authority) — this is the architectural keystone; N1 and most future billing bugs hang off it.
2. **N1 test** (same-day surcharge through intake) before the first recurring subscription cycle.
3. **M2 + N2** (`charge-order` on-account guard) before processing real commercial counter orders.
4. **M1** (POS await race) — quick, safe.
5. **M3** (`create-checkout` ownership or retire it) — latent security.
6. **A4** (billing regression tests) — the durable fix for everything above.
7. L1 Monday deploy reminder; then M4, A2, A3, A5 as steady-state hardening.

*Today's shipped fixes (webhook secret, $59→$0 pricing, overage double-charge, admin address, POS commercial/on-account) all verified correct under this review.*

---

## 6. Architectural work IMPLEMENTED (session 168 continuation)

Done, in order, behind the net:

- **A4 — billing regression net (DONE).** `database/tests/subscription_billing_invariants.sql` — 5 read-only invariants (no >1 overage line; never both `overage`+`lb_overage`; `total_amount == sum(line_items)`; no negative usage; base must be $0). Passes on current data; RAISEs on violation.
- **A5 — Stripe→DB seam monitoring (DONE).** `audit_subscriptions_missing_invoice()` flags active subs with no invoice for the current period (the webhook-secret-drift signature). Wired into `nightly-smoke-test` (v4, SMS-alerts) + `daily_audit.sql` Check 9 + MONITORING.md. Verified: smoke test passes with the new check.
- **A1 (footguns removed, DONE).**
  - **Dropped `compute_subscription_residual`** — orphaned + double-counts overage on the v2 architecture (would have double-charged if anyone wired it into charge-order). Zero callers verified.
  - **Narrowed the recurring carry-forward** to standing extras only (`addon`/`pref_service`/`same_day_surcharge`); it no longer carries per-order `overage` or one-time `credit`/`discount`.

## 7. A1/A2 — remaining consolidation (PLAN for a fresh, tested effort)

The keystone "one pricing authority" rewrite was deliberately NOT attempted at the tail of this long session — it touches every billing surface and must be scenario-tested. With the A4 net + A5 monitor now guarding it, here is the plan:

**Decision already made by the code:** the de-facto single authority today is the pair **(admin intake `record_order_intake`/`_buildIntakeLineItems` rebuilds line_items) + (apply_subscription_usage_fn trigger owns overage at ready_for_delivery)**, and `charge-order` charges the resulting `total_amount`. That works. So the consolidation should *formalize* this model, not introduce a competing one (we just deleted the competing `compute_subscription_residual`).

**Steps:**
1. **N1 — verify same-day survives intake.** Confirm `openIntakePanel` sets `procIsSameDay` from the order's delivery==pickup date so `_buildIntakeLineItems` re-adds the $14.95 surcharge for a recurring same-day order. If it doesn't, same-day recurring leaks revenue. *Test before the first recurring cycle (~1 week post-launch).*
2. **A2 — shared pricing resolver.** Extract one server-side `resolve_service_price(customer_id, service_name) → {price, pricing_type, service_id}` and have the picker, booking flow, admin intake, recurring trigger, and POS all call it (replacing the 5 parallel pricelist lookups). This is what makes the $59-vs-$0 and POS-retail bugs structurally impossible. Adopt surface-by-surface behind the A4 invariants.
3. **Make `record_order_intake` MERGE, not blind-rebuild.** It should preserve lines it doesn't own (e.g. `same_day_surcharge`) instead of dropping + re-deriving, so the "what survives intake" question disappears.
4. **Document the line-item ownership table** (who writes base / delivery / overage / addon / same_day / discount / credit, and when) in PROJECT-NOTES so the 4-writers model is explicit and new code can't violate it.

**Sequencing:** A2 (shared resolver) first — highest value, lowest risk, additive. Then #3 (intake merge). #1 (N1) is a verification, do it before the first recurring cycle. Run `subscription_billing_invariants.sql` after each step.
