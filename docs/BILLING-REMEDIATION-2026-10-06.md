# Billing remediation — 2026-10-06

Worked from the daily audit's check 25 (receipt total drift) and check 26 (order/payment
reconciliation). Read-only investigation; no data was changed. Every order below was traced
through `line_items`, `customer_transactions` and `order_events` before being listed.

**Headline: far less money is in play than the raw check output suggests.** 44 of the 58
flagged orders are not money errors at all — see section 5, and read it before touching
anything, because two passes at this list (including the first pass this morning) drew the
wrong conclusion from the same rows.

**One live code gap was found and fixed today** — section 2. Everything else was already fixed.

---

## 1. Refund now — $39.06 on cards, $9.95 in credit

| # | Customer | Amount | How | Why it's owed |
|---|---|---|---|---|
| 14859 | Morgan Connolly | $15.00 | Card refund | Charged $30.00, order then re-priced to $0.00 service. Full trail in section 2. |
| 13302 | D'Auria's Children's Learning Center | $13.75 | Card refund | Charged $16.75 (correct: $3.00 Oxi + $13.75 subscription overage), then a staff member set the total back to $3.00 two hours later. Saving that edit moved no money. Session 281. |
| 14685 | Matthew Raifman | $6.60 | Card refund | LOVELAUNDRY 15% discount itemised on his receipt, never deducted from the charge. |
| 12228 | Jamie Addington | $3.71 | Card refund | Same cause as 14685. |
| 14666 | Kate Roberts | $9.95 | Add account credit | $12.95 of credit taken for a $3.00 order. Her plan cancelled between booking and weigh-in, so delivery priced off the stale 'Delivery' pricelist. Code fixed in session 292; the credit transaction was never reversed. |

Refund against the original payment intent so the Stripe record matches, and use the admin
refund button rather than editing the order — editing writes no `customer_transactions` row,
which is how several of these started.

## 2. The one live code gap — #14859

The event trail settles both the refund and the bug:

```
18:26:06  Racked -> Ready for Delivery         (Laundry Tech)
18:26:09  Charged $30.00 incl. tip             (System)      <- correct: $15 service + $15 tip
18:49:31  Moved back to Intake                 (Laundry Tech)
18:50:10  Re-intake: 13 lbs, 1 bag
          Total: $15.00 -> $0.00               (System)      <- order re-priced to zero
18:58:14  Racked again -> Ready for Delivery   (Laundry Tech) <- already 'paid', no re-charge
```

Charged $30.00 for an order the system then priced at $0.00 service + $15.00 tip. The
`System` actor on `total_changed` is just `log_order_change`, the logging trigger — a human
did the re-intake.

**The gap:** `record_order_intake` will lower `total_amount` on an order that has already
been successfully charged, with no warning, no reconciliation and no `billing_discrepancy`
event. Session 281 fixed exactly this hazard — but on `opSaveDetails`, the Billing-details
Save path. Intake Save is a different branch reaching the same write and has no guard.

Session 281's own closing line, applied to itself: *"a guard is only as good as the branch it
sits on; grep every branch that reaches the same write."*

Related but distinct: session 175 fixed the **opposite** direction on this same path (a
re-intake raising the total after a $0 order was marked paid, so the customer was never
charged). The downward direction — money already taken, total drops, nothing returns it —
was never covered.

**Fixed 2026-10-06**, migration `session_334_intake_blocks_downward_reprice_after_charge`.
`record_order_intake` now refuses to lower an order's total below money already collected
on the card. Downward only — upward corrections still work and still charge. Review record:
`migrations/session_334_review-notes.md`.

## 3. Needs your call — #11455, $14.95

The order was fully refunded to Heather Quinlan's card ($94.94), but the $14.95 of account
credit she also paid has no matching `credit_refund` row — credit she appears never to have
got back. Confirm the order wasn't re-created under another number before returning it.

## 4. Recommend writing off — $23.00 never collected

| # | Customer | Amount | Cause |
|---|---|---|---|
| 13934 | Susana Abdurahman | $20.00 | $20 credit returned to her balance on re-intake while its discount stayed on the order. Session 281. |
| 13932 | Xena Hinson | $3.00 | Credit line says $8.50 applied; only $5.50 was. Session 281. |

Both are five weeks old and delivered. Chasing $3–$20 on a delivered order costs more in
goodwill than it returns. Mark `billing_status='written_off'` with an audit note rather than
leaving them to resurface in check 26 every morning.

## 5. No action — 44 orders, $319, not money errors

Listed so nobody re-opens them.

- **23 orders, $249 — Ereene Belamide / Suz Burroughs / RedDoor Catering.** Vinegar and Oxi
  are `Delivery` services; a Commercial per-lb customer is deliberately not billed for them.
  `calcProcTotal` and the intake breakdown both skip them; `_buildIntakeLineItems` had no
  such guard and itemised them anyway. **The money was always right; the receipt was wrong.**
  Fixed 2026-09-08 (session 281); last occurrence 2026-09-01. Charging this $249 would
  overcharge three customers for a policy the code holds on purpose.
- **21 orders, ~$70 — Kate Roberts and five others.** Orders whose only charge was a $3–$15
  add-on, paid in full by account credit. Card + credit reconciles to the itemised total to
  the cent on every one.

## What was already fixed, and when

Four of the five classes above were closed before today. Worth knowing so they aren't
re-investigated:

| Class | Fixed |
|---|---|
| Commercial phantom add-on lines | Session 281, 2026-09-08 |
| Total edited after charge, Billing-details path | Session 281, 2026-09-08 |
| Stale pricelist → credit over-consumed | Session 292 |
| Percent discount not applied to subscription overage | Session 294d, 2026-09-15 |
| Total lowered after charge, Intake path | Session 334, 2026-10-06 |

The discount class hit 2 of 2 eligible orders (100% of subscription + percent discount +
weight overage) and has not recurred only because that combination comes up about once a
month. Both failures predate the 294d fix.

## Lesson, repeated from session 281

Session 281's notes say it three times: *"Scale of the symptom was the scale of my
misunderstanding, every time."* It happened twice more on this pass. A naive "line items
don't sum to total_amount" test matched 48 orders; 44 were fine, because `total_amount` is
net of credit and the comparison wasn't. Then two orders looked like double charges until
the tip was added back.

`total_amount` is **pre-tip and post-credit**. Any reconciliation that drops either term
produces a confident wrong answer with a plausible row count. Check 26 had both terms right
and found the real rows on its first pass.

Audit check **30** was added to `database/audits/daily_audit.sql` today to catch the
record-corruption class (#14666, #14859) that checks 25 and 26 are structurally blind to.
Scoped to 7 days on purpose — see the comment in the file.
