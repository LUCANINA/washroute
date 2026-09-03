# Bookkeeping — Scope Reduction

**Decided 2026-09-03 with David. This document outranks feature ideas until it is
superseded. If a proposed change does not serve the one job below, the answer is no.**

David: *"let's bring this down to just a few important features, and grow from there —
we have lost focus and the system is not doing what I want it to."*

---

## 1. The one job

**Get every loan payment into Xero, correctly split, without anyone hand-coding it.**

Everything else in this module is either supporting evidence for that, or it is out of
scope for now.

The reason the job matters — David's actual goal — is **closing the month faster and with
confidence.** Loan payments are what blocks that, which is why they are the one job.

## 2. What "confidence" means — the two sentences

Both, not one. These are the only two claims the module makes on its main surface:

> **August: 11 of 14 loan payments posted to Xero. 3 waiting on you.**
> **12 of 14 balances agree with the lender. 2 don't — see below.**

Sentence one is *the work is done*. Sentence two is *it agrees with the outside world*.
A module that can state both truthfully is finished for this phase.

## 3. The primary loop is PRE-STAGING, and that is deliberate

David, asked directly whether to wind pre-staging down: **"Keep it — it's the feature I
actually want."** Ramona clicking Match in Xero is less work for the business than David
clicking Post in this dashboard.

So the loop is:

1. The schedule says a payment is due.
2. `loan-xero-post` STAGES the pre-split transaction in Xero (`WR-STAGE <code> <date>`).
3. Ramona matches it against the bank feed during her ordinary work.
4. `sweep_stages` sees the match and marks the split posted.
5. `ensureUpcomingSplit()` stages the next period.

**This is what "hands-off" means here.** It is hands-off for David; the human check is
Ramona's Match, which she performs anyway. Nobody has to look at this dashboard for a
loan that is behaving.

**The one-click approve flow is the FALLBACK**, not the main road: loans with variable
payments, loans staging cannot handle, and anything that fell out of the loop.

### Consequence for the UI

**The page's job is the exceptions only.** When every loan is staging and matching, the
list is empty — and an empty list is the success state, not a broken screen. Design the
empty state as the thing you are aiming at.

## 4. The surface: one page, one list

One Bookkeeping page. The two sentences at the top. Underneath, one list.

**Every row is exactly one of four kinds. If a row is not one of these, it does not go on
the page.**

| # | Row kind | The action |
|---|---|---|
| 1 | A payment is ready to post | You click Post (the fallback path) |
| 2 | A balance disagrees with the lender | The amount, and the ONE reason |
| 3 | A document is needed | Which loan, which month, who provides it |
| 4 | A payment failed | What broke |

No tiles. No badges. No grades. No severity colours. No second opinion about a number
stated elsewhere on the page. This is the existing **LESS IS BEST** rule (session 250)
applied to the module as a whole rather than to one card.

## 5. What gets hidden

**Posture: hide the UI hard, keep the code. Restore on demand, one item at a time —
what David asks to bring back is the evidence of what actually mattered.**

Hidden behind a flag, code untouched, background jobs left running:

- The Overview queue's three segments (Issues / Approvals / Staged) — replaced by the one list
- The Debt Schedule view
- The close band's tiles and readiness strip
- Per-loan grades and `carrying_basis`
- The attribution explanations as their own surface (`loan-attribution-run`)
- The evidence gate (unfinished, wired into nothing)
- Rollforward / derived drift / settlement-lag as SEPARATE findings — at most they become
  the "one reason" on a kind-2 row

Roughly two thirds of the module's ~145 dashboard functions go dark on screen while
remaining in the file.

**Nothing is deleted.** This is the same discipline as the 40-word card rule: a claim that
leaves the visible surface has to survive somewhere, or the cut is a lie rather than a trim.

## 6. Payroll

**Stays visible. Stays frozen. No investment.**

David keeps it but is not sure it is right, so it gets **one verification pass before any
other work in this reduction**: check `payroll_departments` mapping against what has
actually posted. A wrong `wage_account_code` does not fail loudly — it puts real money in
the wrong GL account silently.

## 7. What this does NOT change

The invariants in the `washroute-bookkeeping` skill all still apply without exception —
double-entry correctness, Xero idempotency, the close date, the close gate, "a transaction
is never the whole answer", "measured never derived". **Reducing scope reduces what is on
screen and what we build next. It never reduces correctness.**

## 8. Open question, deferred

**Materiality band** (a percentage-of-balance floor beside the absolute one) — carried
from sessions 264/265, PayPal 2's `fits_neither` at ERROR over $21.66. Still unbuilt, and
under this reduction it only matters if it changes whether a kind-2 row appears. Revisit
after the one page exists.
