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

### 4a. The dropzone moves, and it heads the page

**David, 2026-09-03: he wants the "Drop your documents here" intake at the TOP of loan
management.**

Today it sits on the **Overview** tab (`#bk-dropzone`, `admin-dashboard/index.html` ~line 3943,
with its `#bk-batch-card` results pile directly beneath). Overview is on the hide list in §5, so
**if the dropzone does not move it disappears with the tab** — losing the module's only entry
point for statements, schedules and payroll reports.

It belongs above the list for a plain reason: **most of the four row kinds are resolved by
uploading a document.** A kind-3 row asks for a statement; a kind-2 variance usually needs the
lender's current figures before anyone can judge it. Putting intake at the top of the page means
the answer to "what do I do about this?" sits directly above the question.

Move the dropzone and its batch card together — files land in the pile beneath it, so splitting
them breaks the flow.

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

## 6. Payroll — KEEP IT. It earned its place.

**Revised 2026-09-03, after the verification pass. David: "let's keep the payroll feature
live because it works well."**

The pass that decided this is worth stating, because "it works well" is now a MEASURED claim
rather than an impression:

* All five departments' wage and tax codes verified against Xero itself — every code exists,
  is ACTIVE, is class EXPENSE, and its name matches what `payroll_departments` records.
* 254 of 255 import lines matched an employee, every one agreeing with that employee's
  department. The odd line is the Square insurance-reimbursement run, which has no department
  by design.
* **Every one of the ten department accounts ties to the source data to the cent**, once the
  correction journals are netted. Nine at $0.00; the tenth explained by the 668 bank-rule
  misroute, spot-checked against two real transactions in Xero.

One real fault was found and fixed the same day (the 170/171 split — see §6a). By the end of
the day all eleven periods through 2026-08-28 were posted with no flags outstanding.

**So Payroll is not "frozen pending a decision" any more — it is a working feature that stays
visible and keeps working.** It still gets no new investment: the one job (§1) is loans. But
it is no longer a candidate for hiding, and the one-page rule in §4 does not apply to it.

### 6a. What the verification pass changed

`payroll-xero-post` v21 / `payroll-check-attention` v5: the whole payroll cash draw now credits
**170 Direct Wages**, including employee California tax. The old model drew EE CA tax from 171,
which is not where the EDD payments land, so 171 walked negative every period until the balance
gate refused a payroll whose remittances had all been paid on time. Both functions now import
`_shared/payroll-clearing.ts` so they cannot drift apart — they were previously kept in step by
a comment, and both carried the same wrong model for a month.

**This is the reduction working as intended.** The 170/171 split was an invented distinction
the real world did not follow, bought a check that never once answered correctly, and produced
a false alarm on correct books. Removing it was cheaper than maintaining it — which is the §5
test ("would a reader act differently without it?") applied to a mechanism rather than a
screen.

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
