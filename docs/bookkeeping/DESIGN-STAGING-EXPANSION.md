# DESIGN — Expanding Pre-Staging Beyond Amortization Schedules

Session 230, 2026-08-24. Written in response to: *"How far can we take pre-staging?
Determine what it would take to stage splits for loans not following amortization
schedules. Highest priority: the Ford loans. Then find a solution to edge cases such
as principal payments that fall outside the normal schedule."*

Companion to DESIGN-LOAN-POSTING-MODEL.md §4 (the Staging Engine as built).

---

## 0. The one-sentence answer

Ford's interest is **deterministic, not estimable** — daily accrual on the outstanding
principal at a fixed per-loan rate, which reproduces every historical period to within
**one cent** — so the Fords can be staged with the machinery that already exists, by
deriving a schedule from their own history rather than waiting for a lender to send one.
Off-schedule principal payments are a separate, real, and currently *mis-booked* problem
that must be fixed whether or not staging ships.

---

## 1. Why the Fords cannot stage today

Nothing about the Fords is unsuitable for staging. The blocker is narrow and mechanical:

`ensureUpcomingSplit()` (`_shared/staging-next.ts`) selects the period to stage from
**future payment rows on a `loan_amortization_schedules` row**. The four active Ford
loans have `scheds = 0`. No schedule → no future rows → `skipped: no_future_payment_rows`.

Everything downstream — `loan-xero-post`'s stage mode, the `WR-STAGE` reference, the
never-stage-twice guards, `sweep_stages` — is indifferent to where the numbers came from.
So this is a **missing input**, not a missing capability.

---

## 2. The finding that makes this cheap: Ford is exactly predictable

Fitting a single daily rate to each loan's own statement history (balance × rate × days
between statements, `actual/365`):

| Loan | Fitted rate | Periods tested | Worst error |
|---|---|---|---|
| E-Transit Loan - 4140 | 8.29% | 11 | **$0.01** |
| E-Transit Loan E4 -9744 | 9.29% | 9 | **$0.01** |
| E-Transit Loan E5-4751 | 9.99% | 11 | **$0.01** |
| E-Transit Loan E6-7410 | 8.99% | 16 | **$0.01** |

*(Built and re-measured in the same session — see "As built" at the end.)*

Two things to notice.

**The fitted rates are clean numbers** (8.29 / 9.99 / 8.99). A model that was merely
curve-fitting noise would not land on those. This is Ford's actual convention.

**`loan_accounts.interest_rate` says 9.000% for all three** — wrong for two of them, and
wrong enough to matter ($10–12 per period). The stored rate is a human's note, not a
measurement. **The fitted rate should be derived from data and stored separately;
the typed-in rate should never feed a posting.**

### The convention is not universal — fit it, don't assume it

Running the same fit across the other statement-based loans:

| Loan | Best model | Worst error | Verdict |
|---|---|---|---|
| Funding Circle | flat monthly, 1.4510%/mo (17.41%/yr) | $1.63 | **fails the $0.05 gate** — see "As built" |
| BayFirst SBA Loan | neither model | $85.11 | **not** stageable yet |
| BayFirst SBA 2 | neither model | $109.78 | **not** stageable yet |
| Rapid Credit Line | n/a — balance goes *up* (draws) | — | never stageable |
| EIDL SBA | 1 statement on file | — | insufficient data |

Ford accrues **daily**; Funding Circle accrues **flat monthly**. Both BayFirst loans fail
both models — their balances on file are `xero_derived` (our own ledger, not the lender's),
and SBA loans commonly carry a variable prime-linked rate. That is a data problem and
possibly a rate-structure problem; do not paper over it with a projection.

**Design consequence:** the deriver must try several conventions, pick the best fit, and
**refuse to enable staging when the residual is too large.** A staged transaction that is
wrong by $85 is worse than no staged transaction at all.

---

## 3. Proposal — derive the schedule, reuse the engine

### 3.1 Shape

A new edge function `loan-derive-schedule` that, for one loan:

1. Reads real lender statements (`REAL_STATEMENT_SOURCES` only — never `xero_derived`,
   which is our own ledger and would make the fit self-referential).
2. **Excludes any period containing an off-schedule payment** (see §4) — a lump-sum period
   would poison the rate fit.
3. Fits each candidate convention: `daily_actual_365`, `daily_actual_360`,
   `flat_monthly_30_360`. Picks the lowest worst-case residual.
4. **Gate:** requires ≥ 4 clean periods AND worst residual ≤ $0.05. Below that bar it
   writes the fit result and a plain-English reason, and does **not** enable staging.
5. On success, projects forward to maturity and writes an ordinary
   `loan_amortization_schedules` row (`amort_type = 'derived_daily_accrual'` /
   `'derived_flat_monthly'`, `balance_basis = 'principal_only'`) plus its
   `loan_amortization_rows`, then flips `prestage_enabled`.

From that point **not one line of the staging path changes.** `ensureUpcomingSplit` sees
future payment rows exactly as it does for PCV or Verdant. This is the whole point of the
approach: one decision point for "which period stages next" stays one decision point.

### 3.2 Rebasing — the part that must not be got wrong

A projection is only as good as its last real anchor. Every new statement must re-derive
the *future* rows, and must never touch a period whose split has left `pending_review`.
`loan-generate-schedule-split` v12 already 409s on that; the deriver must honour the same
rule, and re-fit the rate rather than reuse a stale one (a rate change would otherwise
persist silently forever).

Rebase triggers: a new real statement, or a confirmed off-schedule payment.

### 3.3 Schema

```sql
ALTER TABLE loan_accounts
  ADD COLUMN rate_model            text,      -- daily_actual_365 | flat_monthly_30_360 | ...
  ADD COLUMN fitted_periodic_rate  numeric,   -- the measurement, never a typed-in number
  ADD COLUMN rate_fit_residual     numeric,   -- worst |predicted - actual|, in dollars
  ADD COLUMN rate_fit_periods      integer,
  ADD COLUMN rate_fit_at           timestamptz;
```

`interest_rate` stays as the human-readable contract rate and is never used for posting.
Showing both, side by side, in the loan detail panel is how a wrong contract note gets
noticed instead of quietly costing $12 a month.

### 3.4 Effort

| Piece | Size |
|---|---|
| `loan-derive-schedule` (fit + gate + project + write) | the bulk of it |
| Migration (5 columns) | small |
| Rebase hook on statement ingest | small |
| UI: fit result + "Enable staging" on the loan detail panel | small |
| Offline harness replaying all 14 loans' history through the fitter | medium, and non-negotiable |

Roughly one focused session for the Fords, with Funding Circle following for free.

---

## 4. Edge case: principal payments outside the schedule

### 4.1 This is not hypothetical — it is already wrong in the books

| Loan | What happened | Status |
|---|---|---|
| E-Transit Loan - 4140 | $5,000 extra principal between 2026-07-28 and 2026-08-10 | **no split computed yet** |
| E-Transit Loan E4 -9744 | $4,903.21 extra principal, May 2026 | booked |
| E-Transit N202 - 8562 | $5,000 extra, then $7,653.54 payoff, May 2026 | loan closed |
| E-Transit Loan E5-4751 | 2026-06 split reads **principal $3,862.49 / interest −$2,815.54** | `already_in_xero` |
| E-Transit Loan E6-7410 | 2026-06 split reads **principal $1,385.79 / interest −$742.29** | `already_in_xero` |

The last two are negative interest expense sitting in the ledger right now.

### 4.2 Root cause — TWO causes, not one

Building this revealed that the two live negative-interest splits are **not** extra
principal payments at all. Both were computed across **non-adjacent statements**:
E5-4751 diffed 2026-01-23 against 2026-06-22 (150 days) and E6-7410 diffed 2026-03-20
against 2026-06-19 (91 days), counting five and three months of principal against a
single month's payment. The statements in between were uploaded later, and nothing
ever recomputed the period. So there are two distinct failures with one symptom:

1. **A multi-period span** — a backfill ran when the intervening statements were
   missing, and no recompute happened when they arrived. (Both live cases.)
2. **A genuine off-schedule principal payment** — 4140's $5,000 on 2026-08-10,
   E4 -9744's $4,903.21 in May, N202-8562's $5,000 and payoff.

Both break the same identity, and the invariant catches both. They need different
fixes: (1) wants a recompute when better statements arrive, (2) wants the lump booked
as its own entry.

`statement_delta` assumes exactly one scheduled payment between two statements:

```
interest = scheduled_payment − (prior_balance − current_balance)
```

Any extra principal inside the window makes `Δbalance` exceed the payment, and the entire
excess is pushed into `interest` as a negative number. The arithmetic is not wrong; the
**assumption** is. And nothing rejects the impossible answer it produces.

### 4.3 The fix, in three parts

**(a) Enforce the invariant — do this first, independently of everything else.**

> `0 ≤ interest_amount ≤ total_amount` and `0 ≤ principal_amount ≤ total_amount`.

A split violating it becomes `needs_attention` with a plain-English explanation, and is
**never postable**. Cheap, self-contained, and stops recurrence today. That the module
booked −$2,815.54 of interest without complaint is the actual defect here.

**(b) Model a lump as its own event, not as a distortion of a period.**

A new split source `principal_only`: `total = principal = the lump`, `interest = 0`,
matched to its **own** bank-feed line. This is the same one-split-per-feed-line rule the
Staging Engine already enforces for weekly loans. The scheduled period's split is then
computed on what remains and stays clean.

**(c) Detect and propose — never guess.**

When `Δbalance` exceeds the scheduled payment by more than a cent, the engine proposes:

> *"Between 2026-07-28 and 2026-08-10 the balance fell $6,180.32 but the scheduled payment
> is $1,180.32. That looks like the regular payment plus $5,000 of extra principal. Confirm
> and I'll book them as two entries."*

The lump's date comes from the bank feed / Xero transaction when available, otherwise the
user supplies it. **Detection is automatic; the booking decision is human.**

### 4.4 The mirror-image case

`Δbalance` *less* than expected — a missed, partial, or deferred payment — implies interest
exceeding the payment (capitalised interest). Same invariant catches it (principal would go
negative); same rule applies: flag, don't guess. Deferred SBA periods will hit this.

### 4.5 Effect on staging

A confirmed lump invalidates every projected row after it → triggers a rebase (§3.2). A
*staged* future split whose loan just received a lump must be re-staged, not silently left
stale: unstage → rebase → stage the corrected period. The existing `unstage` mode already
does the Xero-side work.

---

## 5. How far pre-staging can go, overall

| Class | Loans | Basis | Status |
|---|---|---|---|
| A — lender schedule | PCV, Verdant, Dexter 2 | lender's own amortization doc | **live** |
| B — lender payment history | PayPal 2 | fitted fee allocation (0.475163%/wk) | **live** |
| C — derivable rate | 4× Ford, Funding Circle | fitted from own statements, ±$0.01–1.41 | **this proposal** |
| D — needs better data | BayFirst ×2, EIDL SBA | fit fails / one statement on file | blocked on real lender statements |
| E — unstageable by nature | Rapid Credit Line, Stripe Capital | amount unknown until it happens (draws / % of sales) | direct-split at match time instead |

**Ceiling: 9 of 14 active loans** can pre-stage once Class C ships (4 live + 5 added).
Class D is a data-collection problem, not an engineering one. Class E should never be
staged — pre-creating a transaction whose amount cannot be known is how you create a
mismatch for the CPA to clean up, which is the opposite of the point.

---

## 6. Recommended order

1. **The invariant (§4.3a)** — smallest change, stops books being wrong. Ship alone.
2. **Correct the two negative-interest splits** already in Xero, plus the unsplit $5,000
   on 4140. Root-Cause Rule: only after step 1 exists, so it cannot recur.
3. **`loan-derive-schedule` + offline harness (§3)** — Fords stage.
4. **Lump detection and the `principal_only` split (§4.3b, c)**.
5. Revisit Class D once real BayFirst / EIDL statements are on file.

Steps 1 and 2 are worth doing whether or not steps 3–4 ever ship.


---

## 7. As built (session 230, same day)

Everything in §6 steps 1–4 is written, type-checked and committed. What changed
against the plan above, and why:

**The invariant lives in the DATABASE, not in each edge function.** loan_splits has
five writers; a rule implemented in each is a rule the sixth skips. It is a
`BEFORE INSERT OR UPDATE` trigger calling `split_invariant_check()`, plus an RPC call
to that same function inside loan-xero-post v48 **before** any Xero write — because a
refusal that happened after the Xero call would strand a real journal with no row to
record it. One rule, one definition, two enforcement points with different jobs.

**The rule is stated on the total, not on the signs.** Two shapes that look wrong are
correct and had to keep working: a net-zero **reclassification** (total $0, principal
= −interest — Rapid's fee rows) and a **draw** (total < 0, all principal — Funding
Circle's −$46,843.84). Swept across all 687 splits: 681 pass, 4 fail.

**Two live defects corrected** (E5-4751 and E6-7410, 2026-06), recomputed from the
now-adjacent statements to $778.28/$268.67 and $463.49/$180.01 — both matching the
lender's own daily accrual to the cent. Snapshotted to `_archive.loan_splits_s230_multiperiod`
first, and left as `needs_attention` rather than silently re-marked handled, because
whatever was entered in Xero for those periods still needs checking by a person.

**The fitter is a separate module** (`_shared/rate-fit.ts`) with no Supabase, no
Deno.env and no network, so it can be replayed offline against every loan's real
history — which is how three defects were caught before shipping:
- the projection anchored on the newest statement's `total_amount_due`, which for
  E4 -9744 is a one-off $5,000, producing a schedule of $5,000 monthly instalments;
- it anchored on the newest *distinct balance* rather than the newest statement, so a
  paid-ahead loan projected from three months ago;
- Ford's twice-monthly portal pulls carry the same balance twice, which invents a
  zero-payment period and wrecks the fit unless duplicate balances are collapsed.

**Funding Circle does not pass the gate.** Its best fit misses by $1.63, not the
$1.41 first measured, and the gate is $0.05. The function refuses and says so. The
earlier claim that it was stageable was wrong: $1.63 is an estimate, and a staged
transaction wrong by $1.63 is a transaction the CPA has to fix.

**Detection is automatic, booking is not.** loan-cross-check v3 adds
`off_schedule_principal_payment`, which fires exactly once across all 14 active loans
today — 4140's $5,000. It deliberately presents *both* readings of the numbers (the
whole $5,000, or $3,819.68 alongside a regular payment) because only the bank feed
knows which, and loan-record-principal-payment books whichever a human confirms.
