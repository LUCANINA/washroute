# Variance Attribution — from "the books disagree" to "here is who did what, and what it should have been"

*Design, session 259 (2026-09-01). Written after the PayPal 2 investigation, which
this document is an attempt to turn into a machine.*

> David: "this tool will ultimately be the only window into the truth."
>
> That sentence sets the bar. A tool that reports a variance tells the CPA a
> number she can already get from a trial balance. A tool that says **which entry
> created the variance, what that entry was made of, and what it should have
> been** is the window. This document is about how to build the second one
> without violating a single rule this module has learned the hard way.

---

## 0. What actually happened on PayPal 2, as an algorithm

The investigation that produced the answer took four steps, and every one of them
generalises. Nothing about it was PayPal-specific.

| Step | On PayPal 2 | The general move |
|---|---|---|
| 1 | Variance was **+$21.66** at 6/30 and **−$3,120.60** at 7/31 | **LOCALIZE**: find the period in which the variance MOVED |
| 2 | The move is **$3,142.26**; one ledger entry in July is exactly that — journal `a2c49ead` | **ATTRIBUTE**: find the entry whose effect equals the move |
| 3 | $3,142.26 = **$3,120.60** (the 08-05 scheduled principal) + **$21.66** (the variance carried from June) | **DECOMPOSE**: express the entry's amount in quantities the system already knows |
| 4 | The resulting balance, $58,775.97, **is the lender's own 08-05 portal balance** — she plugged to a later week | **NAME THE SHAPE**, and state the fix: the entry should have been $21.66 |

Step 4 is the one that matters most and is the least obvious. It is **not** amount
matching. It matches the **balance the entry produced** against an independently
sourced document. That is the difference between "these two numbers happen to be
equal" and "this is what a person did."

---

## 0b. ⚠️ REVISED, session 259 cont. 4 — most of this already exists. Do not rebuild it.

**Read this before §1–§3.** Those sections were written before anyone ran
`loan-find-difference` on the three stuck E-Transit loans. It answered all three in
seconds, and its output is better than what §2 proposed to build:

> *"2026-05-28 → 2026-06-17 is off by $283.07 — your accountant's own split on the
> 2026-06-17 payment carries 2026-04 + 2026-05 + 2026-06 interest ($415.88), and all 3
> of those months were already booked."*

`loan-find-difference` (session 225, live at v24) **already performs stages 1–3**: it
localizes the gap to a span between lender anchors, names the entry, decomposes the
amount against the schedule and the lender's own history, collapses offsetting-pair
timing spans, hunts cross-loan misallocations, and writes plain-English conclusions. It
also already honours the rule that matters most here — **the CPA's work is untouchable**:
where the culprit is one of Ramona's own multi-line splits it returns
`can_post: false, proposal: null` and flags an exception rather than proposing anything.

**So the diagnosis was never missing. Its DELIVERY was.** Nothing calls that function
automatically, nothing stores its conclusion, and nothing puts the sentence in front of
the CPA — so three loans sat in Issues for months showing a bare dollar amount and "No
correcting entry prepared yet", with the real answer one unpressed button away.

**The revised build, in priority order:**

1. **Call `loan-find-difference` from `reconciliation-run` for any loan with a material
   variance, and store its conclusion at `loan_tie_outs.detail.attribution`.** Note it
   requires a user JWT today (`callerRole`); either add the `x-wr-internal` path it
   already has siblings for, or factor `analyzeWalk()` into `_shared/` and call it
   in-process — the second is cleaner and avoids a function calling a function.
2. **Surface the stored sentence** in Issues' Explanation column and the Loans hover,
   exactly as §4 describes. §4 is unchanged and still correct.
3. **Only then add the three genuinely new things** the PayPal and E-Transit work turned
   up, which `loan-find-difference` does NOT do:
   * **The plug test** — does the balance an entry produced equal a lender anchor dated
     somewhere else? (PayPal's July journal; the strongest evidence available.)
   * **Future-dated schedule rows** as decomposition terms (PayPal was only solvable
     because the explaining figure was in the future).
   * **The `inherited` verdict** — "this gap predates the period; look in an earlier
     month."

§1–§3 below stay as the record of the reasoning, and their **refusal rules still govern
the new checks in (3)**. Ignore their framing of stages 1–3 as something to build.

---

## 1. Why this is an extension of `gap-diagnosis.ts`, not a new thing

`_shared/gap-diagnosis.ts` (session 253) already does a narrow version of step 3.
**Read it before building anything here.** It deliberately: makes no Xero calls,
uses only data the run already holds, adds a sentence rather than changing a
verdict, and returns `null` rather than guessing. **Every one of those constraints
is correct and is carried forward unchanged.**

What it cannot do — precisely the PayPal case, which is why PayPal went unexplained
for four sessions:

1. It matches only schedule rows **whose date is one of the ledger entry dates**.
   PayPal's journal is dated 7/31; the schedule row that explains it is **8/05**, a
   date no July ledger entry carries. Structurally unreachable.
2. It matches a **single** figure. PayPal's is a **sum** of two.
3. It has no concept of a **lender anchor**, so the plug test — the strongest
   evidence available — cannot occur to it.

So: promote it to `_shared/variance-attribution.ts`, keep its existing two rules as
two patterns among several, and add the three capabilities above. Same file
discipline: pure, no I/O, unit-testable, returns `null`/`unresolved` freely.

**It must not become a second answer to "is this loan off."** The variance itself
keeps coming from `computeTieOut` exactly as today. This engine *annotates an
existing number* and is incapable of changing one. That is the same decision
session 258 cont. 3 made when it refused to build a month-filtered Issues view out
of the client-side rollforward, and for the same reason.

---

## 2. The engine

### Stage 1 — LOCALIZE: which period made this?

A variance is a **stock**; a ledger is a **flow**. Comparing them directly is the
mistake that sends a CPA hunting through the wrong month.

```
V(t)  = books(t) − lender_anchor(t)        # the tie-out already computes this
ΔV    = V(close) − V(prior_close)          # priorBalanceGap() already supplies V(prior)
```

- `|ΔV| < materiality` while `|V|` is large → **`inherited`**. Say so in as many
  words: *"This gap was already $21.66 at 30 June; nothing in July moved it."*
  This verdict is worth building the engine for on its own — it tells the CPA
  which month to open.
- `|ΔV| ≈ |V|` → created this period. Continue.
- No real anchor in one of the two months → **`unresolved_no_anchor`**. Stop.
  Anchors come from the existing allowlist (`REAL_ANCHOR_SOURCES`); a new source
  is outside it and therefore fails safe, per the standing rule.

Use `computeTieOut`'s own anchor selection (`rankAnchorsByAuthority`). Do not write
a second one — two anchor pickers is the "two numbers, no way to tell which is
real" failure in a new costume.

### Stage 2 — ATTRIBUTE: which entry moved it?

Candidates are the ledger entries already pulled this run for the loan's account
code, dated inside the period, each with its signed `effect()`.

| | Rule | Verdict |
|---|---|---|
| a | exactly one entry whose effect == ΔV (2¢) | `attributed_single` |
| b | a **unique** subset of ≤3 entries summing to ΔV | `attributed_subset` |
| c | **more than one** subset fits | `unresolved_ambiguous` — report both, pick neither |
| d | nothing fits | `unresolved_no_entry` |

**On amount matching.** Session 247 admitted it once, under four conditions, and
they all hold here: same loan, same month, exact to the cent, and — the decisive
one — **this engine never posts, never de-escalates a finding, and never changes a
band.** It writes a sentence. A wrong sentence beside the correct number is a
different and far smaller failure than a wrong number.

### Stage 3 — DECOMPOSE: what is that amount made of?

Build a **quantity dictionary** — every figure the system can legitimately *name*,
each carrying its own label and provenance:

- `schedule.principal[d]`, `schedule.interest[d]`, `schedule.payment[d]` for every
  row in `close − 3 months … close + 3 months`. **Future rows included.** This is
  the single most important line in this document: PayPal was only solvable because
  the explaining figure was in the *future*.
- `anchor.balance[d]` — every lender statement on file.
- `anchor.delta[dᵢ, dᵢ₊₁]` — consecutive anchor differences.
- `V(prior)` — the carried variance.
- month sums of scheduled principal and interest.

Then, in order:

1. **The plug test (strongest, and not amount matching).** Does
   `books_after_entry` equal some `anchor.balance[d]` **exactly**?
   - `d` == the close's own anchor date → **`plug_to_anchor`**: a legitimate
     true-up. Say so and stop calling it unexplained.
   - `d` ≠ the close's anchor date → **`plug_to_wrong_date_anchor`**: someone
     forced the account to a balance dated somewhere else. **This is PayPal.**
2. **Single-term match.** `M == q` for exactly one dictionary entry.
3. **Two-term match, and only this shape:** `M == q + V(prior)`. A named quantity
   plus the carried variance — the shape a plug takes when it also sweeps up an
   old difference.

**Refusal rules, and they are the product.** Borrowed wholesale from
`ledger-dating.ts`, which got this right first:

- Exact only. **Never round, never widen a tolerance to make something fit.**
- **Unique or refuse.** Two decompositions that both fit → `unresolved_ambiguous`,
  showing both. Never pick the prettier one.
- **At most two terms, and the second must be `V(prior)`.** This is the hard cap
  and it is doing the same job the settlement-lag rewrite did in session 245: *a
  decomposition with enough free terms fits any number*, exactly as `gap / rate`
  returns a number of days for any gap. Free-form `a + b` search over a dictionary
  of forty quantities would "explain" everything and mean nothing.

### Stage 4 — NAME THE SHAPE

A small closed vocabulary. Each verdict carries `pattern`, `confidence`,
`sentence`, `evidence[]`, and — where it can be stated — `proposed_correction`
(amount, date, description). **`proposed_correction` is text for a human. Nothing
in this engine writes to Xero, stages, or creates a split.**

| Pattern | Confidence | The sentence it produces |
|---|---|---|
| `plug_to_wrong_date_anchor` | confirmed | "Journal *X* forced this account to $B — PayPal's own balance **dated 5 Aug**, booked as of 31 Jul. It should have been $21.66; the remaining $3,120.60 belongs to August." |
| `plug_to_anchor` | confirmed | "Journal *X* trued this account to the lender's balance for this date. Correct as posted." |
| `unsplit_payment` | probable | the existing `schedule_interest` sentence |
| `missing_period` | probable | "The schedule expects a payment on *d*; no ledger entry moved this account that day." |
| `inherited` | confirmed | "Already $V at *prior close*. Nothing this period moved it — look in *that* month." |
| `sibling_finding` | weak | the existing sentence |
| `unresolved_*` | **none** | states the arithmetic, names what was searched, asks for what's missing |

**The `unresolved` verdicts must be built with the same care as the confident
ones.** Session 247's rule — *a null is not a zero* — applies directly: an
unresolved attribution must never look like a clean one, must never change a band
or a gate, and must say what it looked at and what it would need. *"$3,142.26
appeared in July. No single entry, and no pair of entries, accounts for it. There
is no lender statement between 29 Jul and 31 Jul to check against."* That sentence
is a genuine deliverable. "No cause found" is not.

---

## 3. Where it runs, and what it costs

Inside `reconciliation-run`, immediately after `computeTieOut` and before
`checkBalanceVsLender` — at that point the ledger, the anchors, the schedule rows
and the prior tie-outs are **all already in memory**. Cost: **zero additional Xero
calls.** Same bargain `gap-diagnosis.ts` struck, and the reason it can never make a
run slower or risk a timeout.

Stored at **`loan_tie_outs.detail.attribution`** — a jsonb field on a table that
already exists. **No migration.** (If it later earns promotion to columns, that
goes through `washroute-migration-review` like everything else.)

`checkBalanceVsLender` keeps producing the finding it produces today; the
attribution rides along in `detail`. One computation, one storage location, every
surface reads it. Two surfaces rendering one stored verdict can never disagree —
which is the whole architectural point.

---

## 4. Revealing it — the CPA's two screens

### 4a. Issues (Overview) — the Explanation column stops restating the number

Today `_bkIssueQueueItems()` fills **Explanation** with the finding's
`plain_english`, which *states* the variance ("Rebuilt from every live entry in
Xero, this loan comes to $X against $Y…"). The variance is already in the
**Variance** column. Two statements of one fact — which the LESS IS BEST rule names
as the defect itself.

- **Explanation** prefers `attribution.sentence` when one exists, falling back to
  today's text when it doesn't.
- **Action** becomes the named fix — "Ask Ramona to re-date $3,120.60 into August"
  — instead of a generic "Review".
- Nothing is recomputed. `_bkRosterState`, `_bkLoanAttentionItems` and
  `_bkRosterCounts` are **untouched**; the population of rows and the "N need
  attention" headline are unchanged by this work.

### 4b. Loans page — hover on the variance figure

Follows session 249's established pattern exactly: provenance lives as `data-`
attributes on the cell whose figure it describes, read by three consumers — the
CSV export, the harness, and `data-hint`. **No new column** (the table was
deliberately cut to nine), **no extra row height on loans that tie.**

```
data-attr-pattern     plug_to_wrong_date_anchor
data-attr-confidence  confirmed
data-attr-sentence    Journal a2c49ead forced this account to $58,775.97 — PayPal's
                      own balance dated 2026-08-05, booked as of 2026-07-31.
data-attr-fix         Should have been $21.66; $3,120.60 belongs to August.
data-attr-evidence    journal:a2c49ead|anchor:2026-08-05:58775.97|schedule:2026-08-05:3120.60
```

`exportRollforwardCSV()` reads the **attributes, never rendered text** — the
standing rule, and the reason a workpaper exports what is true rather than what the
screen had room for. Ramona gets the full attribution in the CSV whether or not she
ever hovers.

**Confidence is carried by wording, not colour.** "is" / "looks like" / "not
explained". The rollforward's four-colour palette has one red and it is spoken for;
adding a confidence colour spends the one thing that still means something.

---

## 5. Proving it works

Two layers, and the second is non-negotiable.

**Unit** — `variance-attribution.test.ts`, in the style of `gap-diagnosis.test.ts`.
Pure function, hand-built fixtures.

**Harness** — a group in `tests/bookkeeping-harness.mjs`, driving the real page
against real production rows in `tests/fixtures/bookkeeping-fixture.json`. Session
245's rule stands: **a test that transcribes the function it tests is not a test.**
No copies of `_bkIssueQueueItems` in the test file.

**And prove each assertion discriminates** — re-apply the inverse of the fix to the
shipped function's own `.toString()` in page context, rebuild with `new Function()`,
confirm red. Never by editing `index.html`.

Four fixtures that must exist, because each one guards a specific way this engine
could lie:

| Fixture | Must produce | Guards against |
|---|---|---|
| PayPal 2, July 2026 | `plug_to_wrong_date_anchor`, fix = $21.66 | the engine failing to solve the case it was built for |
| A plug landing on the **correct** anchor date | `plug_to_anchor`, **not** the wrong-date pattern | crying wrong-date over every legitimate true-up |
| Two entries that both fit ΔV | `unresolved_ambiguous` | picking the prettier answer |
| A gap with no anchor in the period | `unresolved_no_anchor`, band and gate unchanged | an unresolved verdict quietly reading as clean |

The middle two are the ones that will actually be skipped under time pressure, and
they are the two that decide whether a CPA can trust the sentence.

---

## 6. Rollout

1. **Engine + tests, stored but invisible.** Run it, read
   `loan_tie_outs.detail.attribution` in SQL, and check its verdicts by hand
   against the six live Issues rows. **No UI.** A wrong sentence that nobody has
   seen costs nothing.
2. **Loans hover + CSV.** Lowest-risk surface: a hover is opt-in, and the CSV is
   read by exactly one person who will say if it is wrong.
3. **Issues Explanation + Action.** Only once the sentences have survived a real
   month-end.

---

## 7. What this does NOT do, deliberately

- **It does not post, stage, or create a correcting split.** David's call, session
  259: explain and name the fix, stop there. A wrong attribution should waste a
  conversation, never a journal.
- **It does not change any number, band, gate, or severity.** Annotation only.
- **It does not call Xero.** If a question needs a call the run did not already
  make, the answer is `unresolved` plus the sentence saying what would settle it.
- **It does not rank or hide.** Row order and population stay with
  `_bkRosterState`.
- **It does not date the birth of an inherited gap.** `loan_book_balances` keeps two
  month-ends per loan, so `inherited` means *older than the prior close* and must be
  worded as exactly that. David's call, session 259: **that is the rule for now** —
  retention stays as it is, and the verdict does not imply an age it cannot measure.

---

## 8. Open questions for David

1. **`inherited` may be the most valuable verdict here and it is nearly free** —
   several current Issues rows are probably old gaps nobody has localized. Should
   phase 1 report inherited-vs-created for all six live rows before any UI is
   built? It is one SQL query against stored attributions.
2. **Ramona's month-end plugging is the root cause, not the July journal.** The
   Root-Cause Rule says a one-time fix needs a fix to what produced it. Pre-staging
   removed the need for her PayPal true-ups from 2026-08-25 — is it worth asking
   whether she still plugs on the loans where pre-staging is **not** enabled?
3. **`xero-read` drops Xero's `Retry-After` / `X-Rate-Limit-Problem` headers on a
   429**, which is why the quota state has now been misread twice. Ten-line fix,
   unrelated to this design, worth doing first because it blocks everything else.
