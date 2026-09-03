# Multi-document loan intake — design notes

Session 242, 2026-08-27. Companion to `DESIGN-LOAN-POSTING-MODEL.md`.

---

## 1. The problem

A loan does not arrive as one document. It arrives as an agreement, a transaction
export, a funding confirmation and a portal screenshot — and until now the
ingestion engine read one file at a time, judging each only against itself.

That is not merely slower. It is blind to the only place some facts exist:

| The fact | Which single document states it |
|---|---|
| Every payment splits 14.3102% fee / 85.6898% financing | **none** — the agreement gives a fixed fee and a total; the export gives per-transaction splits; the ratio is the same fact seen twice, and each proves the other |
| These books carry the loan at payoff, not at principal | **none** — it takes the agreement's total *and* the portal's "amount remaining" *and* the opening balance on file |
| The lender has counted $2,166.05 more repayment than the books | **none** — portal against ledger |

Read one at a time, each of those is invisible. Read as a set, each falls out of
an arithmetic identity that either holds or does not.

---

## 2. The rule that decides everything: carrying basis

**There are two ways to carry a loan, they are mutually exclusive, and the same
payment is booked differently under each.**

```
gross_payback   liability = the whole contractual payback, fee capitalised at
                origination. A $100 withholding reduces it by $100 and carries
                NO financing cost of its own. The cost was dealt with once.

net_principal   liability = the cash borrowed, fee held outside it. A $100
                withholding is part principal, part financing cost, and MUST be
                split.
```

Nothing in the schema recorded which. `loan_statements.balance_basis` describes
one *statement*; this is a property of the *loan*, and confusing the two is what
nearly shipped a $20,875 phantom liability (§5).

`loan_accounts.carrying_basis` now holds it, with `carrying_basis_evidence`
beside it — plain English naming the documents and figures that establish it.
Never propose a principal/interest split while the value is `unknown`.

---

## 3. What the engine does, and what it refuses to do

```
POST { documents:[…] }             ->  { bundle_id, plan }      nothing filed
POST { bundle_id, approve:[ids] }  ->  { applied, failed }      only those actions
```

The confirm step applies the **stored** plan, never a freshly re-derived one.
That is an integrity property, not house style: if a plan could change between
the screen a person approved and the write that followed, then what they approved
and what happened would be two different things and no audit trail would show it.

**The engine creates no `loan_splits`. Not one.** Establishing facts and creating
money entries are different jobs in different hands: `loan-ingest-statement`,
`loan-generate-schedule-split` and `loan-xero-post` own splits, they are
review-gated, and they carry years of guards this function does not. What a
bundle writes is *evidence* — documents filed, terms as the lender stated them,
the carrying basis, findings. Every one is a fact about the record, not a
movement of money.

### The plan's shape

- **established** — what the set proves that no member proves alone
- **corroborations** — identities checked and held
- **conflicts** — disagreements, with severity and a caveat saying what each does *not* mean
- **actions** — tickable proposals, nothing default-checked that is blocked
- **unresolved** — *see §4*

---

## 4. When the documents prove a problem but not its remedy

**Name the missing evidence. Propose nothing.**

Session 242's documents proved that no financing cost was reaching the P&L on
Stripe Capital. They could not say whether the fix was an amortisation entry, a
reversal of a double-expensed fee, or a suspense clean-up — three mutually
exclusive answers, all reasonable-looking from the outside. The answer sat in a
June journal none of the four documents contained.

Proposing any of the three would have been a coin flip wearing a proposal's
clothes. So `unresolved` entries carry three fields — the question, why it
matters, and what would answer it — and the review screen gives them the same
visual weight as the proposals. "Here is what I don't know" is a result.

---

## 5. The near-miss, in full, because it is the whole reason for §2

A monthly fee reclassification was designed, costed, reviewed and approved:
move the fee portion of each payment out of loan principal into interest expense.
Net-zero, the same shape Rapid Credit Line already uses.

It was **correct for a net-booked loan and catastrophic for a gross-booked one.**
Stripe Capital is gross. Over the loan's life the reclasses would have credited
an extra $20,875 into the liability:

```
credits to 304:  145,875.00 (origination) + 20,875.00 (corrections) = 166,750.00
debits  to 304:  145,875.00 (every payment)
ending balance:   20,875.00 CREDIT — a phantom liability that never clears
```

In December 2027 Stripe says paid in full and the balance sheet says $20,875
still owing. It would have looked right for months.

An adversarial review caught it, and the only reason it was *catchable* is that
somebody asked which basis the loan was on — a question nothing in the system
could answer.

---

## 6. Reading documents: refuse rather than guess

### The agreement needs a constraint solver

pdf.js emits the page-1 summary table as **all the labels, then all the values**,
in an order unrelated to the layout:

```
… Loan Amount  The amount of credit … Fixed Fee  The cost of your Loan. …
1 July 7, 2026 $16,208.34 June 30, 2026 December 29, 2027 $0.00 $20,875.00
David Macquart-Moulin $145,875.00 Family Laundry acct_1MPrRD… $125,000.00 …
```

`/Loan Amount\s*\$([\d,]+\.\d{2})/` against that returns **$16,208.34** — the
Minimum Payment Amount — with total confidence and no error.

So terms are recovered by solving the identities the document itself states
(`Total = Loan + Fee`; `Net = Loan − Prior`; `Repayment Start = Origination + 7
days`), and **refused unless the solution is unique**. Every returned figure
carries the identity that pins it.

### Money never touches a float

Parsed from its decimal string straight to integer cents, accumulated as
integers, divided once at the end. A three-decimal or comma-decimal figure is
*refused*, not truncated — `$125.000,00` read as `$125.00` produced a
self-consistent triple that passed every arithmetic check while being wrong by
1000×.

### UTC is not Pacific

Stripe exports `Effective Time (UTC)`; the books run Pacific. In UTC the July
file straddles two months and understates July by $28.84. In Pacific it is
exactly 1,352 rows, 2026-07-06 to 07-31, one clean month. At a month boundary
this is a payment booked into the wrong period, which no downstream invariant
catches.

---

## 7. The detector

`_shared/carrying-basis-drift.ts` asks, continuously: *given the agreement and
what the balances actually do, which basis is this loan on — and is it still the
one we recorded?* It fits three models:

| model | predicts | means |
|---|---|---|
| `gross_payback` | total − paid | fee inside the balance, payments correctly whole |
| `net_principal` | borrowed − principal portion | fee outside, payments being split |
| `net_principal_unsplit` | borrowed − ALL paid | **fee taken out, payments still booked whole** |

The third is not a basis, it is a basis plus a mistake — exactly what a loan
looks like the day after someone reverses the entry that capitalised the fee.
A two-model check reports "fits neither" and sends somebody hunting a rogue
journal that does not exist. With three, the answer is `payments_unsplit`,
severity error, naming the amount sitting in the wrong account.

**It never changes the basis.** It reports, and the switch is one click away in
front of a human. A tool that quietly rewrites its own assumptions is not one
anybody can check.

It runs in two places from one implementation — `reconciliation-run` on a
schedule, `loan-bundle` on upload — so the two surfaces cannot reason
differently about the same loan.

---

## 8. Things learned the hard way

- **A partial unique index cannot back a PostgREST upsert.** Postgres will not
  infer one as an ON CONFLICT arbiter unless the statement repeats the predicate,
  and PostgREST emits only column names. `loan_contract_terms` shipped with one
  and every write would have raised 42P10 — silently disabling the reconciliation
  check that reads that table. If a table is written through the data API, give
  it a real UNIQUE constraint.
- **A point-in-time balance and a sum of movements must be cut at the same date.**
  Comparing today's balance against every non-voided split subtracts staged future
  projections the balance has not seen.
- **A read-then-write is not a guard.** The apply step claims the bundle with
  `UPDATE … WHERE status IN ('planned','partially_applied')` and refuses if it
  matches nothing. This is currently the module's only optimistic-concurrency
  predicate and should be the template for the others.
- **If you replace START HERE, check first that what it says lives somewhere
  else.** Session 241 recorded its entire session there and nowhere else.
