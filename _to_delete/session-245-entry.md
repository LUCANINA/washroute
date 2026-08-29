### Session 245 (2026-08-27) — the rate that was never a rate

David, in one sentence: **"stripe holds 8% of revenue generated, not specifically
430/day."** That correction invalidated the central quantity in
`settlement-lag.ts`, and everything below follows from it.

**What the module was doing.** It inferred a daily withholding rate in $/day from
how fast the balance fell, computed `impliedDays = gap / rate`, and called a gap
`explained` when that landed inside a business-day tolerance. The $430.47/day it
used on Stripe Capital is *exactly* the July export's mean ($11,192.29 / 26 days).

**Why that is not a test.** `gap / mean` returns a number of days for ANY gap.
Feed it $60,000 and it reports a number of days. The verdict was arithmetic
performed on the gap by a constant the gap had helped set — circular, and it read
on screen as evidence. Against the real July export, grouped Pacific:

| | |
|---|---|
| daily withholding | **$28.40 – $694.44 — a 24x swing** |
| a *three-business-day window* | $1,346.09 – $2,393.23 — only 1.8x |

So the daily rate is an artifact and the **window aggregate** is the real
quantity. That distinction is the whole fix.

**The rule now (David's decision):** no export covering the window, **no verdict**.
New non-benign verdict `unconfirmed_no_export` states the arithmetic, says plainly
that it is an assumption rather than a measurement, names the date the last export
ends, and makes "upload a current export" the actionable thing. `explained` is now
reachable ONLY by summing the lender's own withholdings across the settlement
window. A rate may still rule a gap OUT (`too_large`); it may never rule one in.

Blast radius was measured against the 2026-08-26 fixture, not guessed: **0 loans
currently reach a benign `explained`, so 0 verdicts change.** The behaviour change
lands in `loan-bundle`, on one bundle.

#### The vindication, and my own error inside it

I told David the $2,166.05 gap was ~21% larger than any three-business-day window
had ever been worth, and therefore suspicious. **That was wrong**, and an agent
caught it before his export arrived: I had counted only weekdays. A three-business-day
settlement delay spans a weekend, and Stripe withholds on weekend sales. Counting
them, $2,166.05 sits inside July's range. The honest claim was never "this gap is
impossible" — it was "nobody measured the window it belongs to."

Then David uploaded August-to-date, and the measurement is exact:

```
books 8/26 $125,257.71   lender 8/26 $123,091.66   gap $2,166.05
books have recognised $20,617.29; full days through 8/21 = $20,442.15,
so $175.14 of Sat 8/22's $403.51 is already settled — the boundary falls
PARTWAY THROUGH A DAY, which is what continuous payouts look like.
   rest of Sat 8/22   $228.37
   Sun 8/23           $122.18
   Mon 8/24           $761.98
   Tue 8/25           $572.34
   Wed 8/26           $481.18
   ─────────────────────────
   TOTAL            $2,166.05      exact
```

The old code reached the right verdict **by luck**. That is the entire argument for
this session: being right and being able to show why are different properties, and
only the second one survives the next loan.

#### Dating a screenshot from the lender's own ledger — `_shared/ledger-dating.ts`

`Stripe overview.png` prints **no as-of date** — a period ("Jul 6 – Sep 4") and a
period-to-date total, never a balance date. The extractor returning `as_of: null`
was CORRECT and must not be weakened. But the date is *measurable*: the day on
which cumulative withholdings equal the screen's paid-to-date IS its as-of date.

```
cumulative from 2026-07-06 reaches $22,783.34 on 2026-08-26 and no other day
  ...splitting $19,522.72 financing / $3,260.62 fee — the screen's own two lines
  ...and 145,875.00 − 22,783.34 = $123,091.66, the screen's "Amount remaining"
  ...while 08-27 stands at $23,131.77, $348.43 further on
```

`dateFromLedger` returns a date only on an exact, unique, corroborated match, and
refuses on: no export, incomplete parse, **coverage starting after the period
start** (the dangerous one — a late-starting cumulative dates the screen LATE and
hands back a real date that is simply wrong), a target between two days (never
rounds), an ambiguous tie (a zero-withholding day after a match fits equally), and
a target beyond the file. It states its working in prose, and notes honestly that
the three agreements are really two, since total = financing + fee on both sides.

#### Two exports of one ledger, and the bug in the first fix

`loan-bundle` kept `csv` in a **single variable**, so a bundle carrying July AND
August silently kept whichever was read last. Both halves then fail safe and
useless — August alone starts six weeks after the period, July alone never reaches
an August figure — so the dating capability could not fire at all.

The first fix concatenated the files' records and **rejected all 1,458 August rows**
with `expected 7 columns, found 13`. These are the real exports of the same loan
from the same portal: **July carries 7 columns, August carries 13** (Transaction ID,
Merchant, Financing Object, Financing offer ID, Financing Type, Livemode, then the
same 7). Stripe gives you different columns depending on which Export button you
press. A merge by position produced July on its own and said nothing.

So the merge **projects each file onto the needed columns by NAME**, and refuses
unless the files are provably disjoint by Pacific day — overlapping exports
double-count, and a double-counted running total crosses the target EARLY, which
returns a confident wrong date rather than a refusal. Either way `csvNote` records
what happened and the plan shows it: *an optional step may fail silently in its
EFFECT, never in its RECORD.*

#### Why Stripe was not on the Loans page

David: *"After all this work, Stripe is still not showing up on the Loans page."*
It was — showing "no opening balance" and "n/a — swept from Xero", excluded from
the rollforward. The rollforward reads two inputs and Stripe had neither:

* **Opening · 6/30** — `_loanBalanceAsOf(loan, priorMonthEnd)`. The loan originated
  2026-06-30; the Xero sweep began 2026-07-01. **It missed by one day and by $0.00.**
* **Per lender · 7/31** — same lookup with `realOnly`. All 35 rows are
  `xero_balance_snapshot`: our own books, not Stripe's figure.

The 10 applied changes taught the system what the loan **is** — basis, dates, 12
terms, 4 documents — and **not one of them wrote a balance**. The engine read the
lender's own balance off a screenshot, used it to establish the carrying basis, and
discarded it as a balance.

Two new planner actions close that: **`open_at_origination`** (day-one balance from
the basis-appropriate term — `gross_payback` → `total_repayment_amount` $145,875,
corroborated to the cent by the 7/01 sweep row — filed as `contract_origination`,
which is outside `_VARIANCE_REAL_ANCHORS` and so can open a rollforward but never
close one) and **`record_lender_balance`** (the portal balance as `portal_manual_pull`,
requiring the figure to be *corroborated* rather than merely present, and **blocked
with an Unresolved question when the date cannot be established**).

#### The audit that started the session

Four adversarial agents; I reproduced the severe claims independently before fixing
any. Eight confirmed in the evidence modules and fixed (the derived sum that
laundered the $125,000 misread and defeated its own guard; a vacuous `paid = 0`
identity; order-dependent `mergePortal`; a DRAFT journal accepted as the booked fee;
a composite journal reporting "Wages $412,000" as the fee debit; a refinance account
taking the bundle; `'Active'` vs `'active'`; a contradicting agreement amount that
did not veto). In `applyBundle`, **three of seven claims were REFUTED** — the claim
is a proper compare-and-swap, `source_document_id` binds by SHA from the stored
plan, and the marking is loan-scoped — while S3/S7 confirmed and four *unclaimed*
defects surfaced. Fixed: the plan was read twice and only the ids validated (a
payload swapped between reads executed unvalidated — on `set_carrying_basis` that is
the $20,875 phantom liability); `raise_finding` reopened suppressed findings and
**destroyed `pinned_note`**, the only copy of a hand-written diagnosis; the receipt
overwrote its own `failed` list so a half-applied bundle could report `applied`;
`attach_document` retry filed duplicates; the term marking widened when the source
document did not resolve.

#### The meta-finding: 52 tests that could never fail

`loan-roster.test.mts` and `queue-hygiene.test.mts` **transcribed** the dashboard
functions instead of importing them. Fifty-two green assertions proving a copy
agreed with itself — worse than no tests, because it reads as coverage. Meanwhile
`tests/bookkeeping-harness.mjs` had loaded the real `index.html` in headless
Chromium since session 244 and nobody pointed the roster at it.

Seven harness groups now drive the shipped functions (675 assertions). Each of the
four session-244 roster fixes was proved to *discriminate* by re-applying the
inverse of the fix to the function's own `.toString()` in page context and watching
the assertion go red — never by editing the file. `loan-roster.test.mts` is deleted;
`queue-hygiene.test.mts` keeps only the two materiality constants, read out of
`reconciliation-run/index.ts` by a regex that throws if the export moves.

The harness then found two dashboard defects the transcriptions never could:

* **`_bkDismissalHolds` failed OPEN.** Both guards were `if (opts && …)`, so calling
  it with no `opts` skipped the escalation check AND the title check and returned
  `true` — nothing verified, finding hidden. Same when `item_title` was empty.
  Now fails **closed**, and `_bkUnarchivedReason` gained the matching sentence so
  nothing reappears without saying why.
* **`_bkSubstanceKey` normalised every number**, so `"…is $415.88 above the lender"`
  and `"…is $1,180.32 above"` shared a key — a balance gap that nearly tripled read
  as the same finding — and `E5-4751` / `E6-7410` collided across two loans. 21 of
  138 real titles shared a key. Now the loan name is preserved verbatim, dates and
  money are preserved, and **only counts collapse** (a bare integer, and the total
  introduced by "totalling", which moves in lockstep with its count) — so session
  242's treadmill fix survives intact.

#### Left standing

* **Nothing is deployed.** `loan-bundle` and `reconciliation-run` both need it.
* The scheduled `reconciliation-run` can never *confirm* a lag: no parsed export is
  stored, so its settlement path only ever describes and refuses. Making that
  finding self-clearing needs a stored parse.
* Intake findings are written `status:'open'` and `loan-bundle` has no resolve
  sweep, so a bundle with a current export raises nothing but does not close the
  older row. Weakens the fourth gate.
* `_anchorSourceLabel` has no entry for `contract_origination`, so the close band's
  opening column will read the raw slug. One line; pinned by a test that fails the
  day someone adds it.
* Section 5 (books-vs-lender) still compares against the last statement row when
  `as_of` is null, rather than against the derived date.
