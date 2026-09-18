# The proposed fix on the row — spec (item A)

**Status: proposed, not built. David asked for the detail 2026-09-17 (session 309).**
Sessions 306–307 put better *verdicts* on the Loans close table and were reverted.
This spec is not a verdict. It is the thing the table has never had: **for every row
that does not tie, the journal that would make it tie, or the document that would
let us say.**

Prior art this builds on, all live today:
* `loan-find-difference` already BUILDS journals — `interest_reallocation_journal`,
  `unexplained_difference_writeoff`, `recorded_cause_adjustment`, `stale_split_trueup`,
  `crossloan_reallocation_journal` — each with a `token`, a `dated_into`, a
  `dated_because` and a `journal` (Narration, Date, JournalLines). They render only inside
  the Find the Fix modal, only after a click, and each click costs Xero calls.
* `loan-attribution-run` (cron, twice a day since s309) already calls that engine in analyze mode for
  every loan carrying an open material finding and stores `headline` + `payload` in
  `loan_attributions`. **The proposal comes back in that same response and is discarded.**
* `_bkLoanAttribution()` is the one dashboard reader of `loan_attributions`; five states
  (`ok / empty / error / none / unread`), deliberately not collapsible.

So A is mostly plumbing: **keep what the walk already proposes, store it beside the cause
it already stores, and put it on the row the reader acts on.**

---

## 1. The row contract — four shapes, one column

A non-tying row is in exactly one of these. The shape is decided in ONE function,
`_bkLoanFix(loanId, month)`, and every surface (Loans closing table, Overview Issues
segment, CSV export, harness) reads it. Nothing else may re-derive it.

| Shape | When | The row says (≤ 40 visible words) | ACTION button |
|---|---|---|---|
| **Fix** | the engine returned a proposal with a `journal`, and its `token` still matches the live books | one-line cause · `Dr 800 / Cr 284 · $1,023.20 · 31 Aug` | **Find the Fix** → opens the prepared journal preview (§4) |
| **Ask** | no usable lender figure for the month (`stale_anchor`, no export covering the window, missing statement) | "Lender figure is dated 26 Aug. Nothing to resolve until a September statement is in." | **Upload Statement** |
| **Accountant** | cause established but the repair is not ours to write — a journal a human posted (PayPal 2's `a2c49ead` vs `b90ceb80`), or a `cpa_review` step | the one narrow question, verbatim from the engine, and who it is for | none. The row names Ramona; nothing to click. |
| **Re-check** | a proposal exists but its `version` (§3) is older than the loan's live version | "Books changed since this was worked out (statement 12 Sep). Re-run." | **Find the Fix** → runs the walk (today's behaviour) |

A row that TIES says nothing and has no button — unchanged.

**Two labels in ACTION, still** (s290, David). `Find the Fix` does one of two things
depending on `data-action` — `fix` opens a prepared journal, `investigate` runs the walk —
and the suite asserts on `data-action`, never the wording. `Leave it` is NOT a third button:
an immaterial gap gets the same prepared write-off journal, and declining it is closing the
preview.

**The Checks glyphs stay exactly as they are.** This column ADDS the fix; it does not replace
the verdict. (307's lesson: the reader needs the magnitude to check a word — the FIX column
carries a magnitude by construction.)

### Where the four shapes come from (engine → shape)

| Engine result | Shape |
|---|---|
| `proposal.kind ∈ {interest_reallocation_journal, recorded_cause_adjustment, crossloan_reallocation_journal, stale_split_trueup}` with `journal` | Fix |
| `writeoff.eligible === true` (immaterial: under $25 and 0.25 %, nothing found after the four searches) | Fix — write-off |
| `cpa_exception.proposed_entry` present | Fix, labelled "prepared by your accountant" |
| any step `kind: 'cpa_review'`, or a `refusal` naming a human journal | Accountant |
| `proposed_action.kind === 'upload_earlier_statement'`, `stale_anchor`, `unconfirmed_no_export` | Ask |
| walk ran, no proposal, no refusal, material | **Ask** (§262: `probable`/unresolved asks; `balance_vs_lender` is a restatement, not a cause) |
| stored `version` ≠ live version | Re-check |

The mapping is an **allowlist**. An unknown `kind` renders as Re-check, never as Fix —
a new proposal kind must be added here on purpose (same rule as `_bkSplitKind`, s262).

---

## 2. What the FIX cell shows — the 40 words

Order fixed, from the bundle-card rule (s263):

1. **What gets written** — figure and date, first. The journal as a two-line table, not prose:
   ```
   Dr 800 Interest expense      1,023.20
   Cr 284 Funding Circle loan   1,023.20      31 Aug 2026
   ```
2. **The one check that would have failed if it were wrong** — one sentence:
   *"Lender moved 2,033.77; Xero moved 3,056.97; the gap is July's interest to the cent."*
3. **What would change the answer** — only when blocked: *"dated 31 Aug because July is closed."*

Everything else — `based_on`, `searched`, the span rows, `dated_because` in full — goes to
`working` and renders behind **Show the working** in the preview (§4), never in the cell.

**Once per screen** (s279): the variance figure lives in the Variance column and is NOT
repeated in the FIX cell. The journal amount may differ from the variance (a write-off
equals it; a reallocation usually does not) and is its own statement, not a repeat.

**The hover carries the full sentence** (`data-fix` on the cell), so the CSV export and the
harness read the claim without parsing the cell.

---

## 3. Where the proposal is stored, and when it goes stale

**No new table. No migration.** `loan_attributions.payload` is jsonb and is rewritten by
the 6-hourly job already. Add to the payload:

```
payload.fix = {
  schema: 1,
  shape: 'fix' | 'ask' | 'accountant' | 'recheck',      // decided server-side, same allowlist
  kind, amount, direction, dated_into, dated_because,
  journal: { Narration, Date, JournalLines[] },            // verbatim from the engine
  check: "<the one sentence>",                            // engine's based_on, first sentence
  token,                                                   // the engine's own proposalToken
  version: "<greatest(latest statement.created_at, latest split.updated_at, latest reconciliation run) for this loan>",
  working: [...]                                           // everything else, unabridged
}
```

**`version` is the staleness key, and it is the same key the START HERE cache item
specified** — any write to the loan's evidence makes a new key by construction; nothing
has to remember to invalidate. The dashboard computes the live version from rows it already
loads (`loan_statements`, `loan_splits`, `reconciliation_runs`) and compares. Mismatch ⇒
Re-check. **The stored journal is never shown as postable when the books it was derived from
have moved.**

Two selection changes to `loan-attribution-run/selection.ts`:
* today it selects loans with an open **material** finding (5 of 14). Add immaterial
  `balance_vs_lender` findings so −0.01 / −5.00 / +15.38 get a write-off prepared. Cost: the
  walk on those loans, inside the job's existing time budget and Xero meter.
* order stays by staleness; a loan whose live `version` changed since `generated_at` sorts
  first.

**`run_status='error'` keeps its meaning**: the row says the fix could not be worked out
and retries on its own — it never shows yesterday's journal.

---

## 4. Posting — nothing new is written, and nothing is auto-posted

Click on a `fix` row opens the existing Find the Fix modal **scrolled to the prepared
entry**, with the walk's sections behind "Show the working". The button in the preview
is the existing one; it calls `loan-find-difference` with the existing flag for that kind
(`post_fix` / `post_writeoff` / `post_recorded` / `post_crossloan` / `post_exception`) and
the stored `token`.

Guards that already exist and are relied on, not re-implemented:
* **token** — amount, direction, period AND date are folded in; a close-date move between
  the 6-hourly run and the click refuses to post (s234).
* **narration marker** — the engine searches Xero for a journal with the same narration
  before posting (`[WR-WRITEOFF …]`, the reallocation narration); a second click is a no-op
  or a loud refusal, never a duplicate.
* **close date** — `postingDateFor` / `isProtectedDate`; the preview prints the date and the
  reason. ⚠️ s231 notes `loan-find-difference` still does not call `effectiveCloseDate()`
  on every write branch. **Audit that before this ships** — A makes those branches one click
  from the roster instead of three.
* **role** — `canWriteBookkeeping(role)`; the internal secret cannot post (s293 pattern).
* **Accountant** rows have no post path at all. The product proposes the question; the
  repair is Ramona's journal (START HERE §0).

---

## 5. The header reads the same function

"Not ready to close" stays one line. Its count comes from the rows:
`N to fix · M statements needed · K for your accountant`. Each number is a row above with
that shape. This is NOT the 307 block — no lead sentences, no `who`/`act`, one line.

---

## 6. August 2026, worked against the live rows

| Loan | Variance | Shape | The cell |
|---|---|---|---|
| PayPal 2 | −3,120.61 | Accountant | "Two journals book the 5 Aug principal: `a2c49ead` (31 Jul reclass) and `b90ceb80` (6 Aug bank line). Which stands? — Ramona" |
| Stripe Capital | +1,472.54 | Ask | "Lender figure dated 26 Aug; withholding since then is unmeasured. Upload a September export." No variance figure printed (s262: ask *or* state). |
| Funding Circle | +15.38 | Fix (write-off) | `Dr 800 / Cr <FC code> · 15.38 · 31 Aug` · "No entry of 15.38 exists in Xero; walk attributed nothing." |
| EIDL SBA | −5.00 * | Fix (write-off) | same shape; the asterisk's reason moves into `check` and stops being a footnote |
| BayFirst SBA 2 | −0.01 | Fix (write-off) | same shape |
| Rapid Credit Line | — (ledger ✗) | Re-check | "Journal `71ed82b2` (31 Aug reallocation, posted 4 Sep) is in our splits and not in Xero's August window. Re-run." |
| 9 others | tie | — | nothing |

Header: **"Not ready to close · 3 to fix · 1 statement needed · 1 for your accountant"**.

That is the whole August close on one screen, with the journals typed for her.

---

## 7. Tests — what must be red before this is green

Harness group `proposed-fix`, live fixture (refresh first: a stale fixture has none of the
`payload.fix` rows). Pairs, per §245:

1. every non-tying row has exactly one shape, and every shape is in the allowlist —
   **and** an unknown `kind` injected into the fixture renders Re-check, not Fix;
2. a `fix` row's `data-fix` contains the journal's amount, both account codes and the date —
   **and** the visible cell is ≤ 40 words (rendered, stripped of `<details>`);
3. the variance figure appears once in the row (Variance column) and not in the FIX cell;
4. `version` mismatch ⇒ Re-check and NO post button — mutate the fixture's statement date
   and watch the button disappear;
5. header counts = row counts by shape, asserted as a relation, not a literal;
6. Accountant rows render no `onclick` that reaches a post flag;
7. `run_status='error'` ⇒ no journal shown.

Node: `loan-attribution-run` payload builder — same input, same bytes (deterministic, like
`buildAttributionPayload`); shape allowlist unit-tested with one case per engine kind and
one unknown.

**Prove each discriminates** by re-applying the inverse in page context (`.toString()` +
`new Function()`), never by editing `index.html`.

---

## 8. Deliberately not in scope

* **No auto-post.** Every journal is one human click through the existing preview.
* **No Xero call on page load.** The row reads stored data; the 6-hourly job and the click
  are the only pullers. (The quota emptied two days running in September — see START HERE §1.)
* **No new verdict words in Checks.** Reverted twice; not proposed a third time.
* **No change to `gates`, `_bkStatementGate`, the Variance total, or the rollforward
  columns.** Items B–F are separate and cheaper; they do not depend on this.
* **The Find the Fix modal is unchanged** except for the scroll-to and the fold; it remains
  the "show the working" surface.

## 9. Build order

1. `loan-attribution-run`: keep the proposal, compute `version`, widen selection to
   immaterial findings. Deploy needs the CLI (`--no-verify-jwt` is NOT this function's flag —
   check `verify_jwt` before pasting).
2. `_bkLoanFix()` + the FIX cell + `data-fix`, closing table only.
3. Header counts.
4. Overview Issues segment reads `_bkLoanFix()` for its explanation column.
5. Harness group; notes entry; commit locally; David pushes.
