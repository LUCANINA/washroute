# One loan table, two periods — the consolidation spec

**Decided by David, session 280 (2026-09-06).** This document is the settled design.
It exists because the build spans more than one session and every decision below was
made against a real alternative that a later session would otherwise re-open.

---

## The problem, stated once

The Closing table (`renderLoansCloseBand`) and the In flight table (`renderLoansTable`)
are not two designs of one thing. They are **two different questions wearing the same
word**, and on 2026-09-06 they printed different money for the same loan on the same day:

| Loan | Closing said | In flight said |
|---|---|---|
| BayFirst SBA 2 | −0.01 | +$695.23 explained |
| BayFirst SBA Loan | ties | −$1,046.56 |
| PCV Good and Green | ties | −$5,357.75 |
| Rapid Credit Line | ties | +$457.14 |
| E-Transit E6-7410 | ties | +$470.64 explained |

Closing asked *"did August's movement reconcile?"* — `opening + drawn − principal`
against the month-end lender figure. In flight asked *"does Xero match the lender's
newest document right now?"* — straight off `loan_tie_outs` via `_loanVariance`.

Both were correct. Neither said which it was. **This is the module's signature
two-numbers-one-page defect, sitting on its two largest tables.** Consolidation is
the fix for it, not a tidying exercise.

---

## RULE 1 — ONE VARIANCE, AND IT IS BOOKS MINUS LENDER

> **Variance = our book figure − the lender's own figure, as of the date on the row.**

One definition, both views, same word. What differs is *which book figure* and *which
date*, and both are stated on the row rather than implied by the tab:

| | Closing | In flight |
|---|---|---|
| Book figure | `computed` — opening + drawn − principal, rebuilt | `xero` — the live book balance |
| Lender figure | the month-end closing anchor | the newest real document, whatever its date |
| Date shown | the anchor's `asOf` | the anchor's `asOf` |

**Closing keeps the rebuilt figure on purpose.** It is the more rigorous of the two —
it can disagree with the live balance, and when it does, that disagreement is the
finding. In flight has no month to rebuild across, so it uses the live balance. The
row's hover names which figure was used; that is what stops the two being confused.

### THE ALTERNATIVE THAT WAS REJECTED, AND WHY IT MATTERS

Making In flight a **true rollforward** was considered and refused. `_loanClosingAnchor`
already refuses to compare when the lender document predates payments we have booked —
those rows become `rf.staleAnchorRows`, *"waiting on a statement dated at or after
&lt;month end&gt;"*, and print no number at all. That refusal is correct and load-bearing.

On the month in flight that is **most rows**, because most lenders have not delivered yet
(3 of 11 on the day this was written). So a true in-flight rollforward either collapses
into the strict-empty view David did not choose, or it prints a variance measured against
a document from before half the month's payments — **money that is knowingly wrong on the
one screen whose job is to say what is left to do.** Do not revisit this without first
reading `_directIsStale`.

---

## RULE 2 — THE DATE ON THE ROW IS WHAT MAKES THE CLAIM HONEST

The Closing table already solved this and it went unnoticed: **it dates its columns**
(`Opening · 7/31`). That is the whole trick. The two views are the same table with the
same words; the dates say which period, and which evidence, is being talked about.

An in-flight row anchored to an August document is making an **August-dated claim**. It
is allowed to, and the date is what tells the reader so. A row whose date is stale
relative to its own booked payments still carries the existing stale-anchor treatment —
consolidation never relaxes a refusal.

---

## The column set — 16, shared

| # | Column | Closing | In flight | Notes |
|---|---|---|---|---|
| 1 | **Loan** | name + lender sub-line | same | Lender was its own column on In flight. Folded to a sub-line: saves a column, keeps the lender sort and the filter pill. The **Agreement** tick becomes a marker on this cell (LESS IS BEST test 3 — it attaches to the thing it describes, and its own tooltip says it blocks nothing). |
| 2 | **Account #** | new | kept | David: keep it. |
| 3 | **Source** | kept | new | Statements vs Schedule — the recorded close basis, never the presence of a schedule file. |
| 4 | **Last payment** | new | kept | David: keep it. Money that has actually left the bank — never a staged or voided split (see `lastSplit` in `renderLoansTable`). |
| 5 | **Date** | new | kept | The last payment's date. |
| 6 | **Opening · &lt;priorEnd&gt;** | kept | kept | |
| 7 | **Drawn** | kept | kept | Measured from the ledger, never inferred. |
| 8 | **Principal** | kept | **changed** | ⚠️ In flight read this off ONE split (the last payment); Closing sums the whole month. They have never meant the same thing. **The month sum wins on both.** |
| 9 | **Interest** | kept | **changed** | Same defect, same fix. |
| 10 | **Books** | was `Computed` | was `Xero` | One column, one meaning: our figure. The arithmetic moves to its hover. |
| 11 | **Lender · &lt;date&gt;** | was `Closing` | was `Statement` | One column: the lender's own figure and the date it is as of. |
| 12 | **Variance** | kept | kept | Rule 1. Hover carries `opening + drawn − principal` and which book figure was used. |
| 13 | **Status** | kept | new | ✓ / ✗ / · . **`Booked` folds in here** — it was close to a second answer to the same question; its wording survives in the hover. |
| 14 | **Ledger** | kept | new | The second, different check. |
| 15 | **Staging** | new | kept | The one thing In flight did better: a live pre-split transaction in Xero was invisible on the close view. |
| 16 | **Action** | kept | new | **The biggest functional gap.** In flight showed five red variances with no path to a fix. |

**Both views get sortable headers** (In flight had them, Closing did not) and **Closing's
money format** — bare figures in the body, the currency symbol on the total only.

---

## What does NOT merge, deliberately

- **The filter bar** (lender / type pills, "Hide closed loans", "N of M loans") stays on
  In flight. It is a browsing surface.
- **The rollforward footnote, Export CSV and Run Reconciliation Check** stay on Closing.
  It is a workpaper.

Forcing either onto the other is tidiness, not consolidation.

---

## Build order

Stage 1 and 2 are each shippable on their own; the suite must be green between them.

1. **The shared row model.** One builder producing the normalized row both tables
   render, and one shared cell library. Neither table computes a displayed number
   itself — this is the rule that stops them drifting again, and it is the whole
   reason for the refactor.
2. **In flight adopts the shared set** — it has the bigger gaps (Action, Status,
   Ledger, Source) and it is the lower-risk of the two to move.
3. **Closing adopts it** — Account #, Last payment, Date, Staging, sortable headers,
   Books/Lender renames, Agreement onto the Loan cell, Booked into Status.
4. **The suite.** Assertions encoding the OLD column names go red on a rename and green
   on a deletion, which is backwards. Fix them in the same commit as the change they
   describe, and prove each one discriminates.

⚠️ `two-surfaces`, `close-band`, `close-band-columns`, `loans-table` and `money-format`
all read these tables by column name. Grep before renaming anything.
