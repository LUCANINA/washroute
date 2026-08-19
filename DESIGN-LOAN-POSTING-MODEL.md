# Design — How loan principal/interest reaches Xero

**Status:** proposed, not built. Written session 222 (2026-08-19) after the Direct Transaction
Split feature was proven unworkable in its intended form.
**Decision owner:** David.
**Companion doc:** `PROJECT-NOTES-BOOKKEEPING.md` tech-debt items 9 and 10 (the incident and the
immediate fix). This doc is the forward design, not the post-mortem.

---

## 1. The problem in one paragraph

Every loan repayment is economically two things — principal (reduces a liability) and interest (an
expense) — but it arrives in Xero as a single undifferentiated bank transaction coded entirely to
the loan account. Something has to split it. The product's job is to know the correct split for
every period across 20+ loan accounts, get it into Xero accurately, and leave behind a record a CPA
can audit without asking questions. The split *figures* are the hard part and are already solved.
This doc is about the last mile: how the numbers land in Xero.

---

## 2. Hard constraints (all verified live this session, not assumed)

These are the facts the design has to respect. Each was proven against the live Xero org, not read
from documentation — Xero's own docs pages are JS-rendered and could not be fetched.

| # | Constraint | How it was proven |
|---|---|---|
| C1 | **A reconciled bank transaction cannot be edited via the API.** | Replayed the exact Update payload against the real 2026-08-18 Rapid transaction → `HTTP 400 ValidationException: "This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement."` Nothing was written. |
| C2 | **An unreconciled bank transaction CAN be created and split via the API.** | Created a disposable $0.02 SPEND, confirmed `IsReconciled: false`, applied a 2-line split → `HTTP 200`, lines landed on 247 + 800, total preserved. Then deleted it and verified `DELETED`. |
| C3 | **Reconciliation cannot be triggered via the API, and unreconciled statement lines are not exposed.** | Xero's own Bank Statements API documentation states this. It means the product can stage a transaction but can never press "Reconcile" — a human always closes that loop. |
| C4 | **Bank-feed transactions are born reconciled; there is no unreconciled window to act in.** | Of **1,179 live transactions over 4 months, exactly 2 were unreconciled** — and both were created by our own `xero-payout-sync`. Zero feed-originated transactions were unreconciled, including same-day ones. A BankTransaction only comes into existence *at the moment of reconciliation*; before that there is only a statement line, which C3 says we cannot see. |
| C5 | **Turning off bank rules does not help.** | Follows from C4. Bank rules only pre-fill the reconcile screen. With them off, the statement line still sits unreconciled and *no bank transaction exists at all* — so there would be nothing to split, not something easier to split. It would mean more manual clicking for strictly worse results. |
| C6 | **Xero bank rules can only split by percentage, not fixed amount.** | Xero Central / bank-rules documentation. A loan's interest portion changes every period, so a percentage rule is wrong almost every time. Bank rules are not a viable splitting mechanism for loans. |
| C7 | **The `accounting.attachments` scope is granted and attachment works.** | Verified 2026-08-19: `2026-08-18-Rapid to date.pdf` (92,652 bytes) is attached to journal `91f454f7-…`. The long-standing "attachments scope missing" caveat in the code comments is **stale and should be removed.** |

**The single most important consequence:** C1 + C4 together mean in-place splitting of a payment
that came from a bank feed is impossible, permanently, for every loan. C2 means splitting is only
available on transactions *we create ourselves before reconciliation*.

---

## 3. What the portfolio actually looks like

The right mechanism depends on the loan's shape, and the portfolio splits cleanly into two kinds.
This is the fact that makes a single universal answer wrong.

**Kind A — amortizing term loans (blended payment).** One payment inherently contains principal and
interest. There is no separate fee event. Verdant, Dexter 2, PayPal 2, PCV, BayFirst SBA, the Ford
E-Transits, EIDL. **~250 of ~417 posted splits.** For these, a journal that carves interest back out
genuinely *is* an after-the-fact adjustment to a transaction that should have been coded correctly.
David's instinct that this "looks messy" is correct here.

**Kind B — revolving lines with separate fee postings.** The lender posts a finance charge as its
own dated event, and the repayment separately. Rapid Credit Line, Funding Circle, partly BayFirst
SBA 2. For these, recording two entries is *faithful to reality*, not an adjustment — booking the
lender's balance fee on the day the lender charged it is textbook accrual. No mechanism change
needed; this is already how they work as of session 222.

**The unlock — three loans already know the future.** Amortization schedules on file mean the exact
principal/interest split is known *before the payment happens*:

| Loan | Future periods already computed | Next |
|---|---|---|
| Verdant Capital | 78 | 2026-09-10 |
| PCV Good and Green | 70 | 2026-09-01 |
| Dexter Loan 2 | 30 | 2026-08-31 |

**178 future periods**, no lender statement required, no race against the bank feed. These three
account for ~159 posted splits historically. They are the ideal candidates for pre-staging and
should be where it is proven first — *not* Ford, which has no schedule on file and is therefore the
harder case despite being the obvious-looking example.

---

## 4. Proposed model — three tiers

### Tier 1 — Pre-staged split transaction (Kind A loans with a forward schedule)

The product creates the bank transaction itself, already correctly split, **before** the feed line
arrives. When the statement line lands, Xero offers it as a match and the CPA clicks once. This is
the model Xero's own Lending Write-Back guidance describes, and it is the only path that produces a
single clean two-line transaction with no journal at all.

```
Type:        SPEND
BankAccount: <loan's bank account>
Contact:     <lender>
Date:        <scheduled payment date>
Reference:   <product-generated, stable, greppable>
LineItems:
  <Loan> principal    $2,817.34   -> 247
  Interest              $682.66   -> 800
```

Applies to: Verdant, PCV, Dexter 2 today. Extends to any loan once a schedule is on file.

**Risks, and they are operational rather than technical — this is where the actual work is:**

- **Duplicate creation.** If the CPA clicks "Create" instead of "Match" on the reconcile screen,
  the ledger gets both the pre-staged transaction and a new one. This is the main danger and needs
  a duplicate sweep, not just hope. Mitigation: distinctive `Reference`, plus a scheduled check for
  two same-amount same-date transactions on a loan account.
- **Stale stages.** If the real payment differs from the schedule (rate change, extra payment, late
  fee, skipped month), the pre-staged transaction never matches and sits there. Needs an automatic
  sweep that flags — and after a grace period deletes — unmatched stages older than N days.
- **Never stage twice.** Must check whether a matching transaction already exists (reconciled or
  not) before creating one. The live-Xero duplicate check already built in `loan-ingest-statement`
  v17 is the right pattern to reuse.
- **Do not stage far ahead.** Staging 78 periods of Verdant at once would clutter the reconcile
  screen badly. Stage one period at a time, a few days before the due date.

### Tier 2 — Batched fee/interest journal (Kind B loans, and Kind A without a schedule)

Where pre-staging is not possible, a journal is the correct and only mechanism — but the volume
should be reduced. **Batching is about reducing the number of documents, not the amount of detail.**

David's question — *"it doesn't necessarily need to be monthly, correct?"* — is right. The batch
period is a free variable. The natural boundary is **one statement upload → one journal**, since the
statement is the source document and can be attached to it exactly once.

```
ManualJournal
  Narration: "Rapid Credit Line — balance fees, 2026-08-03 to 2026-08-24"
  Date:      2026-08-24            <- last event in the batch, NOT month-end
  Attachment: the source statement PDF
  JournalLines:
    Interest — 2026-08-03    $513.28  -> 800     |  Balance fee — 2026-08-03   -$513.28 -> 247
    Interest — 2026-08-10    $499.42  -> 800     |  Balance fee — 2026-08-10   -$499.42 -> 247
    Interest — 2026-08-17    $485.49  -> 800     |  Balance fee — 2026-08-17   -$485.49 -> 247
```

One document instead of three, with every individual event still visible as its own line carrying
its own date. Xero's Account Transactions report concatenates the Narration with each line's
Description, so the per-line dates surface where a reviewer will actually see them.

**The one hard rule: a batch must never straddle a month-end.** The journal's single `Date`
determines which accounting period the interest expense lands in. A batch spanning Aug 28 – Sep 3
would misstate one of the two months whichever date is chosen. Split at the month boundary; accept
two journals that month.

**Dating rule:** date the journal at the **last event in the batch**, never at month-end. This
matters because `PROJECT-NOTES-BOOKKEEPING.md` already carries a standing rule — *"any manual
reallocation journal touching a loan or payroll account must be dated at the real underlying
transaction date, never at month-end or whenever it was convenient to post it"* — introduced after
month-end dating broke reconciliation matching twice. Last-event dating honours that rule's intent
(stays inside the real activity window, always within the 40-day `REALLOC_WINDOW_DAYS` used by
`checkLumpedPayments`) while still collapsing the document count. **Month-end dating remains
banned.**

Expected effect: Rapid drops from ~52 journals/year to ~12, contingent on how often statements are
pulled — batching can only collapse what arrives together, so a weekly statement pull still yields
weekly journals. Statement cadence and journal cadence are the same lever.

### Tier 3 — No write at all

Already implemented and worth stating explicitly because it is easy to forget: a payment that is
100% principal produces **no Xero write whatsoever**. The bank transaction is already correctly
coded to the loan account; there is nothing to reallocate. The split is simply marked reconciled in
the product. This is the cleanest outcome available and it already happens for every Kind B payment.

---

## 5. Known gap to close first (small, concrete)

**The reclass/fee journal path never attaches its source statement**, even though the scope now
works. In `loan-xero-post`, the pure-reclass branch hardcodes:

```js
attachment: { attached: false, reason: 'pure reclass -- no bank transaction, nothing to attach to' }
```

The stated reason conflates two things: an attachment goes on the **journal**, not on a bank
transaction. There *is* a journal and there *is* a source statement, so it can and should attach.
This matters more now than it did before, because after session 222 the fee journal is exactly what
Rapid and Funding Circle produce every period — and an attached statement is the single biggest
factor in whether a reviewer treats a journal as documented or as unexplained.

Also stale and worth deleting while in there: the code comment claiming the attachments scope is
unauthorized (C7 disproves it).

---

## 6. Where the product's value actually sits

Worth stating plainly, because it should shape build priority. The posting mechanism is the visible
part but probably not the valuable part.

What costs a CPA real hours on a client with 20 loan accounts is: chasing statements from lenders
who make them hard to get, computing the split for every period, and — at year-end — *proving* each
GL loan balance ties to what the lender says it is. The product already does the hard parts:
independent ledger rebuild from Xero, drift detection against real lender documents, duplicate
journal detection, missing-statement detection, balance-basis typing so incompatible measures are
never silently compared.

Automated posting is close to a commodity. The assurance layer is not. If a choice has to be made
about where the next block of effort goes, "here are your 20 loan balances, each tied to a lender
document, with the exceptions listed" is a stronger product than "we posted your journals for you."

---

## 7. Build order

1. **Attach the statement to the reclass/fee journal** (§5). Small, immediate, improves everything
   currently being posted. Delete the stale scope comment at the same time.
2. **Batched journals for Kind B loans** (Tier 2). Contained change to split generation and posting;
   no new Xero mechanism, no new risk class. Delivers the volume reduction David asked about.
3. **Pre-staging for the three schedule loans** (Tier 1) — Verdant, PCV, Dexter 2. Highest-value and
   the "one click in Xero" story, but it introduces a genuinely new risk class (duplicates, stale
   stages) and must ship *with* its sweeps, not before them. Prove on one loan, one period, with a
   deliberate match-then-verify test before extending.
4. **Everything else stays as-is** until 1–3 are proven in production.

Explicitly **not** in scope: reviving in-place Direct Transaction Split for feed-originated
payments (impossible, C1+C4); using bank rules to split (C6); month-end batch dating (§ Tier 2).

---

## 8. Open questions for David

- **Statement cadence.** Batching only collapses what arrives together. Pulling Rapid monthly instead
  of weekly is what actually takes it from ~52 journals/year to ~12. Is a monthly pull acceptable, or
  is the more-frequent balance visibility worth the journal volume?
- **Retire or park Direct Transaction Split?** `loan-xero-post` v24–v29 and `loan-ingest-statement`
  v20 are now dormant with no loan enabled. Proven to work on unreconciled transactions (C2), so it
  is not dead code — Tier 1 would reuse the same write path. Recommend **parking**, since Tier 1
  makes it useful again.
- **Journal wording on the other loans.** Session 222 renamed Rapid's fee journal to "balance fee".
  The bank-matched journal used by every other loan still says "interest reallocation" / "principal
  correction". Deliberately left alone rather than rewriting wording mid-stream on loans that were
  not under discussion — worth a conscious decision either way.
