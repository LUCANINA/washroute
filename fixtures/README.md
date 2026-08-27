# Fixtures

Real source documents kept alongside **hand-verified ground truth**, so
extraction accuracy can be measured instead of eyeballed.

## Why this exists

Session 220 shipped six lender parsers "verified" against `pdftotext -layout`
output. Three of them were broken. The bugs only surfaced when David said
"take it for a spin" and they were driven in a real browser, because
**`pdftotext -layout` is not a faithful proxy for `pdf.js`'s real spacing and
ordering** — `pdf.js` interleaves each label with its own value and inserts
multiple spaces between words, so regexes that read values positionally, or
assumed single spaces, silently failed against the real extraction while
looking correct against the offline fixture.

Session 221 closed that gap on the extraction side (`loan-document-intake`
runs the same pdf.js version, proven byte-identical across five real
statements via SHA-256). This directory closes it on the **assertion** side:
a parser is not verified because its output looked plausible, it is verified
because it matched a value someone wrote down in advance.

## ⚠️ These are real documents

Every file here is a real Family Laundry financial document — real vendors,
amounts, account numbers, email addresses. The repo is private. Keep it that
way, and never use a fixture as demo or seed data.

## Layout

```
fixtures/
  vendor-bills/
    port-power-INV-1026.pdf            <- the document, untouched
    port-power-INV-1026.expected.json  <- hand-verified ground truth
```

One `.expected.json` per document, same basename.

## What a `.expected.json` contains

The split between sections is the point:

| Section | Ground truth? |
|---|---|
| `extraction_ground_truth` | **Yes.** Objectively on the document. A correct extraction matches exactly. |
| `arithmetic_checks` | **Yes.** Internal consistency, provable without touching Xero. |
| `expected_splits` | Amounts yes; **account treatment no** — that's a proposal for the CPA. |
| `expected_behaviour` | What a correct run does, *including what it must not do*. |
| `expected_findings` / `known_extraction_traps` | What should be raised, and where naive extraction goes wrong. |

**Declining to be confident is a pass.** This mirrors the module's existing
rule that the AI may identify what a document is but never originates a
financial figure, and the `'unknown'` default on `balance_basis` — an untyped
or uncertain figure must be *visibly* so and refused, not silently assumed.
A fixture where extraction proposes a treatment it should have escalated is a
failure even when the number is right.

## Current fixtures

| Fixture | Type | Why it's here |
|---|---|---|
| `port-power-INV-1026` | One-off vendor bill (AP) | Not a loan or payroll document — outside every parser and every `doc_type` in the module today. Four independent arithmetic checks all reconcile, including two memo-stated percentage derivations. Exercises the proposed `derivation_cross_check` finding. |

## Wanted

The set is thin and skewed toward the easy case:

- **A scanned or photographed document.** Every fixture so far is a clean
  digital PDF, which is exactly what LLM/regex extraction handles best.
- **Ground truth for the six live-verified lender statements** (BayFirst,
  iBusiness, SBA EIDL, Ford Pro PDF + CSV, PCV, PayPal CSV). These were
  verified by hand in a browser once; nothing currently pins that verification
  down so a future refactor can be checked against it.
- **`Ford_July26_9744.pdf`** — the "paid ahead / $0.00 due" sample whose
  correct behaviour is to return `null` and defer to manual entry. A fixture
  asserting the *absence* of a split is worth as much as one asserting a value.

## Note for Bookswell

The same document and ground-truth file are relevant to Bookswell's
document-ingestion design (it is the "document-itemized split" case, and the
first non-recurring vendor). Kept here rather than duplicated — Bookswell's
`PROJECT-NOTES.md` points at this path. Update one, not two.

## Stripe Capital (session 242)

| File | What it is | Ground truth |
|---|---|---|
| `Stripe_Capital_agreement.pdf` | The signed loan agreement, 13 pages | Loan $125,000.00 · Fixed fee $20,875.00 · Total repayment $145,875.00 · Net proceeds $125,000.00 · Minimum payment $16,208.34 every 60 days · Repayment rate 8.00% · Originated 2026-06-30 · Repayment starts 2026-07-07 · Final repayment 2027-12-29 · `acct_1MPrRDGACgbvEugH` · Celtic Bank |
| `Stripe_July.csv` | July 2026 transaction export, 1,352 paydowns | **In Pacific**: 2026-07-06 → 2026-07-31, one month. Total paid $11,192.29 = financing $9,590.61 + fee $1,601.68. In UTC it straddles two months and July comes out $28.84 short — which is the point. |

Both are read by `tests/loan-bundle.test.mts` (68 assertions). The agreement is
the harder case: pdf.js emits its summary table as all labels then all values in
arbitrary order, so the parser recovers terms by solving the document's own
arithmetic rather than by position. Every assertion in that file is a defect two
red teams found — do not adjust an expected value to make a test pass.
