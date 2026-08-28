# Closing Evidence — how a loan's month-end balance is established

Session 246 (2026-08-28). Written before any code. Every agent working on this
builds against this document; where the code and this document disagree, one of
them is wrong and it must be resolved, not papered over.

---

## The problem David stated

> "On Loans > July, we're missing a few balances because there are no statements
> to compare Xero to lender balances. The reality is that some lenders do not
> give us statements on a monthly basis (Dexter), while others share statements
> with payment amounts and no splits (Verdant). In this case, we need to be able
> to say: rely on the amortization schedule for the true number. That's all we
> can do."

Today the rollforward has exactly two states: a loan has a lender document
covering the month, or it is "not checkable". Three active loans land in the
second bucket for July 2026 — Dexter Loan 2, EIDL SBA Loan, Verdant Capital Loan
— and the close band reports "3 statements outstanding" as though those
statements are late. Two of them are not late. **They are never coming.**

A gate that waits for something that will never arrive is not a gate, it is a
queue people learn to ignore. That is the same failure the close date fixed in
session 230, in a different costume.

## The answer, in one sentence

**A closing balance has a GRADE, and the grade is stated on the screen — it is
never inferred from silence and never mixed into a total that implies a higher
grade than it has.**

---

## The three grades

| Grade | Name on screen | What establishes it | Counts toward |
|---|---|---|---|
| **A** | *Confirmed by lender* | a real lender document — either dated inside the month, or a later one rolled back to month end | the lender-confirmed subtotal; this is what the CPA signs |
| **B** | *Per amortization schedule* | the lender's contractual schedule, where a stated per-loan policy says no usable statement exists | its own subtotal, always separate, never folded into A |
| **C** | *No evidence* | nothing available | the excluded line, as today |

`_VARIANCE_REAL_ANCHORS` (`lender_statement`, `email_pdf_upload`,
`portal_manual_pull`) still defines grade A and its meaning is unchanged. Grade B
does **not** join that list. It is a parallel track with its own subtotal, its
own wording, and its own footer sentence.

**The close may proceed with grade-B loans in it.** David's decision, 2026-08-28.
The band reads, for July:

> Ready for your accountant · 11 confirmed by lender · 2 per schedule · 1 no evidence

not "3 statements outstanding".

---

## Grade A, extended: rolling a late statement back to month end

EIDL SBA does not issue a statement at month end. It issues one on the 25th. We
hold a real one dated 2026-08-25 saying **$960,005.00**, and no principal was
booked between 2026-07-31 and that date. Therefore the SBA's own figure for
2026-07-31 is $960,005.00. That is arithmetic on lender evidence, not a
projection, and it is strictly better than a schedule.

    monthEndLenderBalance = laterStatementBalance + principalBookedIn(monthEnd, statementDate]

**Refuse rather than guess.** The roll-back is available only when ALL of:

1. The later statement is a grade-A source AND its `balance_basis` is not
   `'unknown'`. An unlabelled balance is an unknown quantity — see START HERE §3.
   It may not be rolled back, because we do not know what it measures.
2. The statement is within `ROLLBACK_WINDOW_DAYS` (60) of month end. Beyond that
   too much can have happened for the walk to be trustworthy.
3. **Every split in the roll-back window is posted.** A `pending_review`,
   `needs_attention` or `staged` split in that window means the principal we
   would add is not yet a fact. Refuse — do not add a number we are still
   arguing about. (`staged` in particular is money that has NOT moved; the
   rollforward already excludes it from the month, and it must be excluded here
   too or the roll-back double-counts it.)
4. The walk is over *principal only*. Interest never moves a principal balance.

When a roll-back is used, the screen says so — `8/25 · rolled back from lender
statement` — never just `8/25`. A reader must be able to see that the figure was
derived, and from what.

If any condition fails, the loan falls through to grade B, then C. **A refused
roll-back is never silently upgraded to a tie.**

---

## Grade B: the per-loan policy that makes a schedule admissible

A schedule becomes an acceptable closing basis only by an explicit, recorded,
per-loan decision. Not by the absence of a statement — absence is the state we
are trying to stop reading as a fact.

New on `loan_accounts`, mirroring the existing `carrying_basis` /
`carrying_basis_evidence` / `_set_at` / `_set_by` quartet:

    close_basis          text not null default 'lender_statement'
                         -- 'lender_statement' | 'amortization_schedule' | 'none'
    close_basis_reason   text        -- why, in a sentence a CPA would accept
    close_basis_set_at   timestamptz
    close_basis_set_by   text

Initial values, from David 2026-08-28:

| Loan | close_basis | reason |
|---|---|---|
| Dexter Loan 2 | `amortization_schedule` | Dexter Financial issues no periodic statements. The contractual amortization schedule (PDF on file, generated 2021-10-13) is the accepted basis. |
| Verdant Capital Loan | `amortization_schedule` | Verdant's monthly notice carries the payment amount only — no balance and no principal/interest split. The contractual schedule is the accepted basis. |

Everything else keeps the default.

### Three rules the policy must obey

1. **A real lender document always wins.** The policy says what to do in the
   ABSENCE of grade-A evidence. It never suppresses one. If a Dexter statement
   ever arrives, Dexter closes at grade A that month.
2. **The policy is per loan, not per month.** But the grade is per month, because
   evidence is.
3. **`close_basis = 'amortization_schedule'` on a loan with no schedule is
   grade C, not grade B.** A stated policy does not conjure a document. EIDL has
   no schedule and must never be given this policy as a way of making a number
   appear.

### The schedule figure itself

Month-end schedule balance = the balance on the **latest schedule row dated on or
before month end**, from the loan's newest schedule. Two live hazards:

- **Verdant has two schedules** (`73183999…` generated 2026-08-25 and
  `fbd72d5d…` generated 2025-06-12) with overlapping rows and duplicate dates.
  Pick one deterministically — newest `schedule_generated_date`, tie-broken by
  `created_at` — and use only its rows. Never mix rows from two schedules into
  one walk.
- **Verdant also has all 85 schedule rows mirrored into `loan_statements`** with
  `source='amortization_schedule'`, 70 of them future-dated. Read the schedule
  from `loan_amortization_rows`, not from that mirror. The mirror is the thing
  that caused session 196's live $0 balance.
- A `row_type` that is not a payment (Dexter has a `rate_change` row dated
  2026-08-31 with `balance = 0.00`) must not be read as a balance. Filter to
  rows with a real `balance` and a payment-bearing `row_type`, or the August
  close reads Dexter as paid off.

---

## The circularity problem — and why grade B is worthless without fixing it

This is the part that matters most and it is easy to get wrong.

The rollforward's check is:

    opening balance − principal paid = closing balance

For **Dexter**, the opening comes from `loan_statements` rows with
`source='xero_derived'` — our own Xero ledger. The principal comes from a
schedule-generated split. The closing would come from the schedule. Opening and
closing come from *independent* places, so the check tests something real: **do
the books still track the contract?** It currently ties to the cent.

For **Verdant**, all 85 `loan_statements` rows are the schedule, every split is
schedule-generated, and the closing would be the schedule. Opening, movement and
closing are all the same document. **The variance is identically zero by
construction, for every month, forever.** It cannot fail. It is not a test.

This is session 245's lesson in a new costume: *an average is not a test*, and
neither is a document compared with itself. Shipping grade B without fixing this
would print a green tick beside Verdant while the books actually disagree with
the schedule by **−$1,835.75** — a figure `loan_tie_outs` already holds and the
rollforward is structurally incapable of showing.

### The fix: an independent books-side balance

`reconciliation-run`'s `balance_vs_lender` **already rebuilds each loan's balance
from Xero** — BankTransactions plus ManualJournals — and stores it on
`loan_tie_outs.xero_balance`. That number is genuinely independent of any
schedule. It is computed for one as-of date (the anchor date), not for month end,
and it is not retained per period.

So: store it per loan per date.

    create table public.loan_book_balances (
      id               uuid primary key default gen_random_uuid(),
      loan_account_id  uuid not null references loan_accounts(id) on delete cascade,
      as_of            date not null,
      balance          numeric(14,2) not null,
      basis            text not null default 'xero_rebuild',
      run_id           uuid references reconciliation_runs(id) on delete set null,
      detail           jsonb,
      computed_at      timestamptz not null default now(),
      unique (loan_account_id, as_of, basis)
    );

**It is a separate table, deliberately.** `loan_statements` means *what the
lender said*. START HERE §2 is currently blocked precisely because Stripe's sweep
writes our own books into that table and collides with a lender figure on the
same date. Do not repeat that. Nothing about our own arithmetic belongs in
`loan_statements`.

`reconciliation-run` emits rows for the closing month end and the prior month end
on every run. The rollforward then reads:

- **Opening** = `loan_book_balances` at prior month end, if present; otherwise
  today's `_loanBalanceAsOf` behaviour, with the row marked as possibly circular.
- **Computed** = opening − principal booked in the month.
- **Closing** = grade A or grade B figure as above.

Verdant's variance then becomes a real number, and the point of the whole
exercise is that we find out what it is.

### The circularity guard stays anyway

Even with the table, a loan may have no books balance on file yet. So the
rollforward computes, per row, whether the opening's provenance and the closing
anchor trace to the **same schedule id**. When they do, the row does **not**
print a tie. It prints:

> agrees by construction — not an independent check

in the variance column, and it counts in neither the ties nor the offs. A check
that cannot fail must never look like a check that passed.

---

## What must NOT change

- **The close date rules.** A closed period stops generating work; it never stops
  the balance being checked. Grade B does not alter that in either direction.
- **`_VARIANCE_REAL_ANCHORS`.** Grade B is a new track, not a new member of that
  list. `checkBalanceVsLender`'s deliberate suppression of schedule-anchored
  exceptions (session 231: "Xero disagreeing with our arithmetic, not with a
  fact") stays as it is on the reconciliation side.
- **`coversMonth`.** The existing guard — a closing anchor must post-date the
  prior month end — is what stops one statement answering both ends of the walk.
  It applies to grade A and grade B identically. A schedule row dated 2026-06-10
  may not close July.
- **Staged splits.** Still excluded from the month's principal, still counted as
  unposted, in the roll-back window as well as in the month.
- **The future-date filter.** A schedule row dated after today is a projection.
  For a CLOSING month that has already ended this is not usually binding, but the
  filter must not be quietly dropped while restructuring.

---

## Acceptance — what "it works" means

Measured against live data for **July 2026**:

1. Dexter Loan 2 closes at **grade B**, closing balance **$89,411.25**, and the
   variance against a books-side opening of $92,737.48 less $3,326.23 principal
   is **$0.00** — a real tie, because the opening is Xero's and the closing is
   the contract's.
2. Verdant Capital Loan closes at **grade B** and shows either a real variance or
   an explicit "agrees by construction" — **never a green tie**.
3. EIDL SBA Loan closes at **grade A, rolled back**, closing balance
   **$960,005.00**, and reports the **$5.00** the books are out by rather than
   nothing.
4. The close band reads "N confirmed by lender · 2 per schedule · …" and no
   longer says "3 statements outstanding".
5. The lender-confirmed subtotal contains only grade-A loans. Opening minus
   principal equals computed within each subtotal, as session 245 established.
6. Every new behaviour has a harness assertion that has been **proved to
   discriminate** — the inverse of the fix, applied to the shipped function's own
   `.toString()` in page context, turns it red.

---

# AMENDMENTS after the wave-1 audits (2026-08-28)

Three read-only audits (dashboard consumers, `reconciliation-run`, migration
review) ran against live data before any code was written. They found nine things
the draft above got wrong or left out. **Where this section and the draft above
disagree, this section wins.**

The migration is **APPLIED** as of 2026-08-28: `loan_accounts.close_basis`
(+`_reason`/`_set_at`/`_set_by`, CHECK on three values), `loan_book_balances`
(RLS on, `authenticated` = SELECT only after a follow-up revoke — the default ACL
had granted it everything at CREATE TABLE time), and Dexter 2 + Verdant set to
`amortization_schedule`. `migrations/session_246_closing_evidence.sql` is the
file of record.

## A1. Materiality — acceptance #3 and #4 contradicted each other

Rolling EIDL back produces a **$5.00** variance on a **$960,005** balance. Under
`blocked = gates.some(g => g.bad)` that lands in `rf.off`, and the band reads
"Not ready to close" — contradicting acceptance #4.

**Resolution: the rollforward gets the materiality test the rest of the module
already uses.** `reconciliation-run` has `isMaterialGap` (`MATERIAL_FLOOR = 25`,
`MATERIAL_SHARE = 0.0025`), and the roster already has a *"Small differences, not
worth chasing"* group. This is not a new policy — it is the existing policy
applied to one more surface. Mirror the two constants exactly.

Three bands now, not two:

- `|v| < 0.005` → **ties**. Prints nothing, as today.
- `0.005 ≤ |v|` and not material → **immaterial**. Printed in grey with the
  figure visible, counted in its own gate chip (`1 small difference — $5.00`),
  **does not block the close**.
- material → **off**. Red, blocks, exactly as today.

An immaterial variance is still shown. It is never hidden, only de-escalated.

## A2. Grade C must not swallow Stripe

Stripe Capital is `ingestion_method='automatic'` and is *deliberately* excluded
from `noEvidence` and from `cov.expected` — there is no outside party who could
disagree with a balance that IS the Xero sweep. The draft's example band copy
("1 no evidence") was counting Stripe, reversing a considered decision.

Grades A/B/C partition the **13 non-automatic active loans**. Stripe is reported
separately as *swept from Xero*, never as *no evidence*.

## A3. The grade-B figure must be read from `loan_amortization_rows`, and filtered

Two traps, both live, both worse than the draft said:

- **Dexter carries a `xero_derived` statement row dated 2026-07-30 whose balance
  is exactly the schedule's 7/31 figure.** Any grade-B path that reaches for
  `_loanBalanceAsOf(a, monthEnd)` without `realOnly` picks that row and prints a
  fully circular tie wearing grade A's clothes. Read the schedule from
  `loan_amortization_rows`. Never from `loan_statements`, for any loan.
- **`row_type` is load-bearing, not defensive.** Dexter's schedule has
  `annual_total` rows with *populated* balances (2025-12-31 → 112,314.00;
  2026-12-31 → 72,415.24), a `grand_total` at 0.00, and a `rate_change` dated
  **2026-08-31 with balance 0.00 sharing that date with the real payment row at
  86,066.61**. Sorting by date alone is a coin flip decided by sort stability. A
  December close would read the `annual_total`. Filter to payment-bearing
  `row_type` explicitly; a `balance != null` test is **not** sufficient (Verdant's
  totals are null, Dexter's are not — do not generalise from Verdant).

The same hazard is live in `reconciliation-run`'s `schedAnchors`
(`index.ts:1494`), which applies no `row_type` filter and no schedule
de-duplication. Fix it in both places or the August tie-out reads Dexter as paid
off.

## A4. The circularity guard keys on `source`, not on schedule id

Verdant's opening resolves from the **85-row `loan_statements` mirror**, whose
rows carry no `schedule_id` at all. The draft's guard ("opening and closing trace
to the same schedule id") **cannot fire**. Key it on
`opening.source === 'amortization_schedule'` instead.

## A5. `windowFrom` must be widened, and the walk must refuse outside it

`balanceAt()` is a pure walk over an in-memory, date-sorted ledger — snapshotting
it at two extra dates costs 44 array scans and one upsert, no Xero calls, against
an ~18-second run. But **outside the pulled window it returns the checkpoint
wearing the target date's label** — a confident wrong number, silently.

Two things are therefore mandatory:

1. Fold `priorMonthEnd` into the `windowFrom` candidate list at `index.ts:1430`.
2. Guard every write: `if (!haveCheckpoint || asOf < addDays(windowFrom, -1))`
   → **skip and record the skip in the run summary**. Never write. An absence
   the summary explains beats a number nobody can trust.

Set `computed_at` explicitly in the payload — a column default does not fire on
an upsert onto an existing row, and "when was this measured" is the table's whole
value.

## A6. Staged Xero transactions are AUTHORISED, so the books balance counts them

`loan-xero-post` creates pre-staged SPEND transactions with `Status:'AUTHORISED'`
dated on the schedule row's own due date — routinely a month end. `isLive()`
returns true for those, so `balanceAt()` includes them, while the rollforward
deliberately excludes staged splits from the month's principal.

A staged split dated exactly on the prior month end therefore puts a payment that
has not happened into the *opening* balance, and the rollforward prints a
variance equal to its principal, attributed to nothing.

**Do not net them out silently** — Xero's own balance sheet includes them, and
this table means *what Xero says*. Record the count in `detail`
(`staged_entries_at_or_before`) and have the rollforward say so on the row.

## A7. Acceptance #1 was an assertion; it is a prediction

Dexter's `xero_derived` rows are a **frozen one-time backfill** from August 2026
(nothing writes that source; all 61 carry `balance_basis='unknown'`), and they
agree with the schedule to the cent on every row. So the "independent opening"
the flagship acceptance test rested on may be the schedule under another name —
one level below the circularity the draft set out to fix.

**Reworded:** *the books-side opening at 2026-06-30 is computed from Xero by
`reconciliation-run` and the variance reported, whatever it turns out to be.* If
Xero's true 6/30 balance is not $92,737.48, that is a finding, not a failure.

## A8. Two surfaces outside the rollforward will keep nagging

Ship grade B without these and the close band says *"Verdant: per schedule,
accepted"* two clicks from a queue saying *"waiting on a statement"* — the exact
two-numbers-one-page failure this module's history is made of.

- **`checkStaleAnchor`** (`reconciliation-run/index.ts:937`) exempts only
  `ingestion_method==='automatic'`. Dexter and Verdant raise `stale_anchor`
  *forever*. Gate it on `close_basis` too.
- **`_bkRosterState` / the Overview statusline.** Verdant's tie-out is
  `unverified` → *"Needs a statement"*; Dexter's is `tied` on a schedule compared
  with itself → *"Reconciled"*. Both need the policy.
- **`_bkStatementCoverage`** must be extended **additively** — keep `expected` /
  `received` / `missing` / `naCount` intact and add a `perSchedule` bucket, with
  a real lender document still moving a `perSchedule` loan into `received`. A
  `close_basis='amortization_schedule'` loan with **no schedule rows** stays in
  `missing` (grade C).

`_VARIANCE_REAL_ANCHORS` is still not touched. `_loanOutstandingBalance`,
`_loanPrincipalReconciliation`, the Debt Schedule and its PDF export are still
not touched — that document leaves the building.

## A9. Data plumbing the draft assumed was free

- `loan_accounts` is `select('*')`, so `close_basis` arrives free. But it is
  `undefined` in the harness until the fixture is re-pulled — read every access
  as `a.close_basis || 'lender_statement'`.
- `loan_book_balances` needs a sixth entry in `loadLoans()`'s `Promise.all`, a
  `_allLoanBookBalances` global, a `_bkCheckRowCap` line, **and** registration in
  the harness's `FIXTURE_TABLES` — an unregistered table returns `[]` silently
  and would exercise only the fallback path.
- `loan_amortization_schedules.created_at` is **not selected** (index.html:12781),
  so "newest schedule, tie-broken by `created_at`" is not implementable today.
  Add it there and in `tests/refresh-bookkeeping-fixture.sql`.
- **`loan_amortization_rows` sits at 926 of a 1,000-row cap**, and `_bkCheckRowCap`
  only `console.warn`s. Grade B reads that table. One more Verdant-sized schedule
  crosses it. Raise the cap or make the breach a visible banner before close
  correctness depends on it.
- `loan_tie_outs.detail` is missing from the fixture refresh SQL though the page
  selects it — so every `detail.material` / `detail.residual_after_later` read is
  untested. Add it.

## A10. Adjacent defects found, to be handled not ignored

- **Verdant's `Period 14` split is invisible to `_monthSplits`** (it slices
  `period_label.slice(0,7)`, and `'Period 14'` → `'Period '`). Its P/I exactly
  matches the 2026-08-10 schedule row, so **August's Verdant principal will read
  $0.00 while a posted split for it exists**, and grade B will then print a
  variance of exactly one payment. Fix or flag loudly — do not let grade B ship
  on top of it silently.
- **START HERE §3 misattributes Dexter 2's 61 unlabelled rows** as
  `portal_manual_pull`; they are `xero_derived`. The remedy is completely
  different — labelling a books row does not create a lender anchor. Correct the
  note.
- **`carrying_basis` is `'unknown'` on both Dexter and Verdant** in production,
  not `net_principal`. Session 242's rule is "never propose a split while this is
  unknown", and grade B's whole walk is opening − *principal*. Raise with David.
- **`REAL_ANCHOR_SOURCES` has nine live copies, not the two its comment claims**
  — two of them re-declared inside `reconciliation-run` itself, 549 and 893 lines
  below the constant already in scope. Consolidating is the cheapest safety win
  available, and `tests/loan-bundle-balances.test.mts` pins only one of them.
