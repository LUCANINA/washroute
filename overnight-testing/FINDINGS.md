# Findings — Loan Ingestion Torture Test

## Wave 1 summary (2026-08-22)

Run against **WashRoute Staging** (`tnbngwnzsmonmkntjaon`), a fully isolated sandbox
that mirrors production's loan-ingestion schema and code — see SAFETY-BRIEFING.md
for why staging was set up first and what it took to get there. Nothing in this wave
touched production (`umjpbuxrdydwejqtensq`) or any real loan data.

6 fixtures designed and run, using the mission's intended process: a Test Designer
role picked adversarial scenarios, an Accounting Oracle independently worked out the
*correct* expected answer before anything was run (blind to what the engine would
actually do), and a Test Executor ran each fixture and compared. The most severe
finding (TEST-0006) got a second, independent review pass before being written up,
per the mission's rule that significant findings get adversarial double-checking.

**Result: 4 passed, 2 failed. Both failures are real, reproducible bugs — see
BUGS.md.**

### What passed (the engine is working correctly here)

- **TEST-0001 — cross-document conflict.** A monthly statement's actual billed
  interest disagreed with the amortization schedule's projection by $80. The engine
  correctly flagged it `needs_attention` rather than silently trusting one source.
- **TEST-0002 — tolerance boundary, exactly at the line.** A $2.00 mismatch (the
  documented tolerance) was correctly treated as fine, not flagged.
- **TEST-0003 — tolerance boundary, one cent over.** A $2.01 mismatch was correctly
  flagged. (See the floating-point note in BUGS.md — didn't change the outcome here,
  but worth a defensive fix.)
- **TEST-0005 — first statement ever, insufficient data to compute a split.** No
  prior statement to diff against, no total due, no transaction list. The engine
  correctly created no split rather than guessing one. This is exactly the
  "inventing a plausible value is a failure" behavior the mission called out as
  critical to verify.

### What failed

- **TEST-0004 — same-day duplicate-looking payments (High severity, see BUGS.md).**
  Two legitimate same-day payments crash the whole statement upload and silently
  wipe out every other payment in it, including unrelated ones on other dates.
- **TEST-0006 — out-of-order statement vs. schedule projection (Critical severity,
  see BUGS.md).** A future schedule-based projection permanently blocks the real,
  statement-backed number from ever being computed when statements arrive out of
  chronological order — with nothing telling the CPA the number they're looking at
  was never actually checked against a real bank statement.

### What this wave validated about the engine's design

The core cross-checking logic (schedule vs. statement comparison, the $2.00
tolerance, and the refusal to fabricate data when information is missing) all work
correctly and match how a careful bookkeeper would want them to behave. The two bugs
found are both about *coordination* — how the system reconciles multiple write paths
(same-day duplicates within one upload; schedule projections vs. real statements) —
rather than the underlying accounting math being wrong.

### Coverage gap to flag

`loan-document-intake`'s AI-assisted classification path (the one that calls Claude
to classify an unrecognized document as a last resort) was **not exercised this
wave** — staging has no `ANTHROPIC_API_KEY` configured yet. Every fixture this wave
used documents the deterministic parsers/heuristics could already handle. If testing
AI-assisted classification is wanted, staging needs that key added first.

### Next wave candidates

- Same-day duplicates with different amounts (e.g. $500 + $500.01), and a fee vs.
  duplicate fee on the same date — narrower variants of BUG-0001.
- Schedule projection vs. real statement where the numbers *don't* match — does the
  CPA ever see the real number, or does the stale projection win forever? (Directly
  follows from BUG-0002.)
- Normal chronological ingestion with a pre-existing projection, to confirm whether
  the "silent overwrite" half of the asymmetry is actually clean or has its own bug.
- Broader multi-period, balance-ambiguity, and interest-model categories per
  COVERAGE.md — this wave only scratched 5 of the 12 tracked categories.
