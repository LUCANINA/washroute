# Bookkeeping — how the tool expects the books to be run

Written session 230 (2026-08-24). Short on purpose. This is the operating
agreement between the tool and whoever closes the books; the engineering detail
lives in `PROJECT-NOTES-BOOKKEEPING.md` and `DESIGN-STAGING-EXPANSION.md`.

---

## 1. The tool works best when the books are locked

Everything this module does splits into two jobs:

- keeping a **closed** period's record straight, and
- getting an **open** period booked correctly.

Only the second is work. A closed month has already been adjusted and settled by
the CPA. An approval or a flag raised inside one asks for something nobody can
act on — the entry is made, the month is done — and the only lasting effect is a
queue that people learn to ignore. That is the real cost: not the noise itself,
but that a list containing unactionable items stops being read, and then the
actionable item in it gets missed too.

**So the tool needs to know where the line is.** Told where the books are closed,
it stops asking about anything behind it and spends its attention forward — on
projecting the next payment's split and staging it before the money moves.

When this was built, Funding Circle was carrying five approvals going back to
November 2025, every one of them inside a closed month. Once the close date was
set, four filed themselves and one remained: July, which is genuinely open and
genuinely needs looking at.

## 2. The best place to set it is Xero

Xero has a **Lock Date** (Settings → Advanced → Lock Dates). Setting it when a
month is closed is worth doing for two independent reasons:

1. **It protects the books.** Nothing currently stops a closed month being edited
   in Xero. A lock date is a real control, not a convenience.
2. **The tool reads it automatically.** No second date to maintain, nothing to
   remember, and no chance of the two drifting apart.

As of this writing this organisation's Xero has **no lock date set**, so the tool
falls back to a date entered manually in the dashboard.

**A manual close date that goes stale is worse than none**, because the tool keeps
filing periods that should have stayed open. If it stays manual, it needs updating
every month. The lock date does not.

## 3. What "closed" changes, and what it does not

| | Behaviour |
|---|---|
| Approvals inside a closed period | Filed automatically, with a note naming the close date. They stay visible in the loan's split history — nothing is deleted. |
| Per-period flags inside a closed period | Not raised. "A statement is missing for 2023-05" is not actionable once 2023 is shut. |
| **Balance checks** | **Still run, always.** |
| Statements for closed periods | Still stored. They are evidence, and every balance check depends on them. |
| Anything already in Xero (posted, staged, matched) | Never touched. A close date is not a reason to rewrite a record of something real. |

The third row is the important one. `balance_vs_lender` compares **today's**
balance against the lender's own figure. That is a statement about now, not about
a closed month — so it keeps running even when its cause lies in closed books. You
get one live finding instead of fourteen historic chores.

## 4. Two edges worth knowing

- **A month closes only when the close date reaches its end.** Closing through the
  15th does not close that month; half its transactions are still open, and filing
  them would bury real work.
- **A period the tool cannot date stays open.** Verdant labels its periods
  `Period 84` rather than by month. Rather than guess, the tool leaves those alone —
  hiding something it cannot place would be worse than showing it.

## 5. The monthly rhythm this assumes

1. The CPA closes the month and sets Xero's lock date.
2. The tool picks it up, files anything behind the line, and stops mentioning it.
3. Statements arrive for the new month; splits are proposed for review.
4. For loans with pre-staging, the next payment's split is created in Xero *before*
   the money moves — so when the payment lands it is one Match click, not a journal.

Step 1 is the only one that needs a human to remember something. Everything after
it follows.

---

## The Staged tab (session 231)

**Approvals** is decisions you owe. **Staged** is work already finished — a pre-split
transaction is sitting in Xero waiting on the bank feed, not on you. It has no count
badge on purpose: a number in a tab reads as a to-do list, and these need nothing done.

Before this split, Approvals read "12" when eleven of the twelve were staged. A count
that overstates by 11x stops being read.

A staged transaction that goes wrong appears in **Issues** as well, in amber at the top
of Staged. That redundancy is deliberate — the alarm should not depend on you opening
the register.

**What watches them:** pg_cron `wr-loan-stage-sweep`, daily at 9am Pacific. Each night it
posts anything that matched, returns anything deleted in Xero to review, and flags a
suspected duplicate or a payment that never came. You only hear from it when something
needs you.

**Month-end, still the most valuable thing you can do:** ask Ramona to set Xero's lock
date when she closes. Xero currently carries none, so `books_closed_through` in Bookkeeping
is the only close signal that exists — and until session 231 it did not stop a single
Xero write.
