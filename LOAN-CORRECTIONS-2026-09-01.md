# Five loan entries to review — Xero corrections

**Prepared 1 September 2026. Five entries across five loans, $5,787.45 in total.**

Each item below states what the entry **did** in Xero, what the lender's own
documents say it **should** have done, and the difference. Every figure has been read
from the entry's own line items in Xero and checked against the lender's statements —
nothing here is inferred from a balance alone.

Nothing has been changed. These are for your review, and each fix is yours to make.

---

## 1. PCV Good and Green Loan — one payment split twice

**Journal `d1347f7c-1629-4c5c-9b04-25884ccc3c02`, dated 31 August 2026**
*"To split out August 2026 PCV loan interest expense…"*

| | |
|---|---|
| The 3 Aug payment (`ec50f278`, $7,138.10) | **already split at source**: $5,335.52 to loan 254, $1,802.58 to Interest Expense 800 |
| This journal then moves | a further **$1,802.58** from 254 to 800 |
| Effect | interest expense overstated by **$1,802.58**; loan 254 overstated by the same |

The journal's narration states that the payment "was posted in full to the loan
account." The bank transaction shows two lines, so the premise does not hold — the
split had already been made.

**Arithmetic:** the books tie to PCV's statements exactly at 30 June and 31 July. The
3 Aug payment brings account 254 to $427,284.34, matching PCV's 1 Aug statement to the
cent. This journal then adds $1,802.58 back.

**Suggested fix:** reverse journal `d1347f7c`. Nothing else on this loan needs to change.

---

## 2. Paypal 2 — a July journal reduced the loan more than the schedule supports

**Journal `a2c49ead-3c5c-4bf0-a343-9cbfa657f271`, dated 31 July 2026**
*"To reclass the payment made for paypal"* — lines: `284` +$3,142.26 / `800` −$3,142.26

| | Books | PayPal's own statement | Difference |
|---|---|---|---|
| End of June | $77,301.26 | $77,279.60 (24 Jun) | **+$21.66** |
| End of July | $58,775.97 | $61,896.57 (29 Jul) | **−$3,120.60** |

July's five weekly drafts reduce principal by $15,383.03 per the schedule, and PayPal's
statements agree to the cent. The books reduced by $18,525.29. **The whole difference is
this one journal.**

**Why it matters now:** all four August drafts (6, 13, 20 and 26 Aug) are posted and
reconciled in Xero and are individually correct. Because this July journal had already
removed the 5 Aug payment's principal, that payment is now in the books **twice**, and
account 284 is understated by roughly **$3,120.60**.

### The fix: reverse this journal in full. Do not re-date it.

**Reverse `a2c49ead` in full, dated 31 July 2026** (July is open — the books are closed
through 30 June):

| Account | | Amount |
|---|---|---|
| `800` Interest Expense | debit | $3,142.26 |
| `284` Paypal 2 | credit | $3,142.26 |

**Re-dating the $3,120.60 into August would not fix it.** The 6 August bank draft
already reduces account 284 by that payment, so moving the journal forward simply moves
the duplication into August. Walked through all four August drafts:

| | Account 284 after 26 Aug | vs PayPal's figure ($49,324.91) |
|---|---|---|
| Leave the journal as is | $46,204.31 | **−$3,120.60** |
| Re-date it into August | $46,225.97 | **−$3,098.94** |
| **Reverse it in full** | **$49,346.57** | **+$21.66** |

Only the reversal restores the account. The $21.66 that remains is a small difference
that predates July and is a separate question — **it should not be plugged**; it is the
same $21.66 the books were already carrying at 30 June.

*Two independent checks agree on the $3,142.26: the journal's own line items, and the
July ledger movement rebuilt from Xero — which reduced account 284 by $20,215.81, being
the five drafts at $17,073.55 plus this journal, against $15,383.03 of scheduled
principal.*

*We have not established why this entry was posted, and are not assuming. The figures
above are what it did.*

---

## 3–5. Ford Pro FinSimple — three payments split with several months' interest at once

In each case one payment's interest line carries more than one month, while those
months had already been booked separately. The loan account is therefore under-reduced
by the excess. Correct splits are from Ford's own transaction histories.

| Loan | Payment | Posted in Xero | Should be | Loan account short by |
|---|---|---|---|---|
| **E-Transit 4140** | 17 Jun 2026, $1,180.32 | `242` $764.44 / `800` **$415.88** | $1,047.51 / $132.81 | **$283.07** |
| **E-Transit E5-4751** | 12 May 2026, $1,046.95 | `332` $498.74 / `800` **$548.21** | $780.53 / $266.42 | **$281.79** |
| **E-Transit E4-9744** | 11 May 2026, $1,144.55 | `244` $793.81 / `800` **$350.74** | $975.78 / $168.77 | **$181.97** |

4140's $415.88 interest line is April + May + June interest added together
($147.43 + $135.64 + $132.81). The other two each carry two months.

**Current effect on the balances:** 4140 is **$415.88** above Ford's figure, E5-4751
**$266.42** above, E4-9744 **$182.00** above. These three differences have not moved
since June.

**Suggested fix:** re-split each of the three payments per the "Should be" column.

**One thing not to change:** E4-9744's **April** payment is correct as posted — it came
in lumped and a journal has already moved $181.99 out of it, netting to exactly the
right principal. Only the May payment needs attention.

---

## Summary

| | Amount |
|---|---|
| PCV — duplicated interest split | $1,802.58 |
| Paypal 2 — over-reduction, now double-counted | $3,120.60 |
| E-Transit 4140 | $415.88 |
| E-Transit E5-4751 | $266.42 |
| E-Transit E4-9744 | $181.97 |
| **Total** | **$5,787.45** |

Happy to pull the underlying transactions or statements for any of these.
