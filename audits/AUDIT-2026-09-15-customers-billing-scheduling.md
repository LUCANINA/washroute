# WashRoute Audit — Customers, Billing, Scheduling
**Date:** 2026-09-15 · **Mode:** read-only (no data changed) · **Scope:** daily_audit.sql checks + deeper 60–90 day sweeps

## Bottom line
No double charges, no big leaks, no broken routes. Four real problems, and **most share one root cause: admin screens write straight to the database without applying business rules** (discount, tip, recurrence, account matching).

---

## Priority findings

| # | Pri | Area | Finding | Impact |
|---|---|---|---|---|
| 1 | P1 | Scheduling | Unticking "repeat" in admin silently ends a customer's repeat series | 35 orders in 60 days; 2 chains lost (Claire Tolan, Kidango – Hillside after 9/17) |
| 2 | P1 | Billing | Admin "New Order" ignores discounts and puts the tip inside the total | 16 of 17 discount customers missed discount since 9/10; ~20 orders with tip in total |
| 3 | P1 | Billing | Kidango NON PROFIT discount still missing | ~$557 (79 unbilled orders $367, 12 upcoming $39, 130 paid orders $151) |
| 4 | P1 | Customers | New duplicate account **after** the session-290 fix | Katie Steele — 2nd empty account created today |
| 5 | P2 | Scheduling | Auto-fail job re-fails orders minutes after staff reset them (can double-text) | 26 auto-fails in 60 days; Claire Tolan, Gadise Reg, Homebase |
| 6 | P2 | Billing | Open customer money items | Owed to customers: D'Auria's $13.75, Keliiaa $11, Addington $3.71, Olivella $20 credit, Quinlan $14.95 credit. Uncollected: Abdurahman $20, Odean $5, Hinson $3 |
| 7 | P2 | Billing | Itemised discount not deducted | #14685 Matthew Raifman, −$6.60 (same bug as #12228, still unfixed) |
| 8 | P2 | Billing | Cancelled subscription still stamped on new orders → $0 orders | #14853 Candy RamirezHale (~$75/pickup uncollected) |
| 9 | P2 | Billing | Possible double-bill at subscription start | #13856 Robert Molony, $65 — needs your call |
| 10 | P2 | Customers | Phone sign-in abandoned → people create email accounts | 6 stuck (incl. Jennifer Stahl, Michael Sullivan); Patrick Campbell did exactly this today |
| 11 | P2 | Scheduling | Possible double order | Sylvie Hart #15069 / #15070, 3 min apart, same window |
| 12 | P3 | Billing | Same-day fee charged on non-same-day order | #12203 Cory Johnson $14.95 (+ #11840, #11516 to check) |
| 13 | P3 | Customers | Likely real duplicates / split history | Genevieve Davis (3 accounts), Danielle Ross, John Taladiar |

---

## Root causes

**A. Admin writes bypass business rules (findings 1, 2, 7)**
- `admin-dashboard/index.html` `saveOrder()` ~line 39129: discount block is empty — comment says "billing adjustments happen later", but they don't. Line ~39152 adds `tipRaw` into `total_amount`.
- `opSaveRecurring()` ~line 30503: Frequency dropdown saves instantly, no confirm, no warning that "One-time" ends the series. `trg_create_recurring_order_fn()` then creates nothing. Likely staff think "One-time" = "just this occurrence." (Known tech debt TD-2.)

**B. Account matching only stops on errors, not on "no match" (findings 4, 10)**
- `customer-app/index.html` `handleNameSubmit` (~2517–2593): session-290 block fires only when the match function *errors*. When someone signs in by phone with a new number, the email they type isn't trusted, so nothing matches and a new account is created. Returning customers who switch login method (phone ↔ email) are the pattern.

**C. Discount lines copied instead of recalculated (findings 3, 7)**
- Kidango (on-account + POS weigh-in + recurring) hit hardest. Leftover from session 291.

**D. Recurring generator carries stale subscription link (finding 8)**
- `trg_create_recurring_order_fn` doesn't check subscription status.

**E. Auto-fail only looks at the window, not recent human action (finding 5)**
- `auto_fail_expired_orders()`: reset status without moving the window → failed again on next 30-min run. Also scans old stops, not just active ones.

---

## Audit checks giving false alarms (fix the checks)
- Check 1: flags all POS walk-ins → exclude `source = 'walk_in'`.
- Check 5: exact email match misses 234 case/space variants → use `lower(trim())`.
- Check 6: Nit Pixies multi-location → group by address too.
- Check 23: fires though subscriptions are live.
- L3 / L5 / L6: noise (no billing-type filter, wrong date basis, 30-day vs balance).
- **Add:** "was repeating in last 30 days, no future order" check.

## Clean
No double card charges · no negative totals/credits · weight × rate correct · no wrong-date stops · no stop/status desync · no cron failures · no shared Stripe IDs · no login tied to two customers · photo rate normal.

## Informational
- On-account receivables ~$50k; oldest: Charlotte Maxwell Clinic (177 days), Laura Guevara (173), Berkeley Rep (169). Largest: Soul Sanctuary $12,259.
- SF route today: 19 stops vs 15 limit. No driver: Concord AM 9/19, Kidango 9/21.
- #15040 David Glasebrook card declined, $95.95.

---

## Recommended fix order
1. Correct unbilled Kidango orders **before** next invoice.
2. Fix `saveOrder` (apply standing discount, keep tip out of total).
3. Add confirm + `recurring_stopped` event to `opSaveRecurring`; restore Claire Tolan and Kidango – Hillside chains.
4. Block account creation when a typed email/phone already belongs to an account; merge Katie Steele.
5. Auto-fail: skip orders touched in the last hour; only look at active stops.
6. Settle the 8 customer money items; decide on #13856.
7. Fix recurring generator subscription linking.
8. Tidy false-alarm audit checks.

---

## Fix log — 2026-09-15 (same day)

**Shipped to code (uncommitted, admin-dashboard/index.html):**
- `saveOrder()` — discount now applied (customer's standing discount pre-selected; % on service only, fixed capped), discount line written, tax on discounted base, tip no longer inside `total_amount`.
- `opSaveRecurring()` — confirm before ending a repeat series; event reads "Repeat series ENDED".

**Correction to finding #3 (Kidango):** the $517 on past orders is ALREADY covered by the pending $518.10 Kidango Group invoice credit from session 291 (79 unbilled $366.70 + 130 paid $151.40 = $518.10). Do NOT also edit those orders — that would credit twice. The 12 upcoming orders (#14817–14830) will get their discount at POS weigh-in (291L re-derives it). No data change needed.

**Tip-in-total on live orders:** only #15074 (Linda Mevorach) and #15132 (John Palmer) are unbilled; POS intake rebuilds the total at weigh-in, so they self-correct.

**Still open / needs David:** restore repeat on Kidango – Hillside (#14821) and Claire Tolan; Katie Steele merge; account-matching gap; auto-fail job; customer money items; #13856.

**Later 2026-09-15:**
- Kidango – Hillside #14821 set back to weekly (event logged).
- Katie Steele merged into her original account (5 orders kept). Login is now the phone sign-in she used today; her old email login is left unlinked.
- **Claire Tolan — NOT an accident.** She asked to cancel on 8/30 and 8/31 by text, and John ended the series at her request. Root cause of losing her: card declined 8/29 → delivery held and auto-failed → she couldn't log in (a duplicate account had taken her phone number, and the password reset sent a magic link) → 5 "couldn't process payment" texts, 2 of them after staff reset the order, plus a "place your first order" marketing text to a long-time customer. Remove her from the "lost chains" list.
- **Duplicate-account fix (session 294):** DB trigger `trg_block_duplicate_customer_signup` (migration `session_294_block_duplicate_customer_signup`, applied) refuses a customer self-signup whose email or phone already belongs to another customer; staff and service-role inserts are exempt. Customer app now creates accounts only through `_insertNewCustomer()`, which stops and shows "call us" instead of silently continuing. Tested in a rolled-back transaction: dup email (different case) blocked, dup phone (different format) blocked, new contact allowed, staff allowed.
- **Recovery instead of "call us" (session 294b):** duplicate sign-ups now get a "Welcome back!" sheet offering an email sign-in link or SMS code to the existing account. Live on app.familylaundry.com (build 20260915215748).
- **Auto-fail fix (session 294c, applied):** `auto_fail_expired_orders()` now skips orders a staff member changed in the last hour, or reset out of a failed status in the last 24 hours, and only reads active stops. Would have prevented 8 re-fails in the last 60 days (incl. Claire Tolan #13219, Homebase #10487, Gadise Reg #10366). 22:30 UTC cron run succeeded on the new version.
