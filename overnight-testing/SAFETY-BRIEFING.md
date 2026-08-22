# Safety Briefing — Loan Ingestion Torture Test

Written 2026-08-22, before the campaign started, after a read-only
investigation of the loan ingestion pipeline. This explains why the
campaign did not immediately start firing test fixtures at the engine,
per MISSION.md's own "Safety Boundary" section (which requires operating
only inside an authorized dev/test environment and never modifying
production data).

## What "the loan ingestion engine" actually is

It isn't one function. It's three pieces:

1. **`loan-document-intake`** (Supabase edge function) — takes a raw
   file (base64), tries deterministic parsers and keyword heuristics
   first, and only as a last resort calls Anthropic's
   `claude-haiku-4-5-20251001` to classify an "unknown" document. This
   function is **dry-run only, permanently** — it has no write path at
   all (it explicitly 400s if you try to pass `confirm:true`). It is
   safe to call as many times as we want; nothing it does can touch the
   database. It's the one piece that does real AI-based extraction.

2. **`loan-ingest-statement`** and **`loan-ingest-amortization`**
   (Supabase edge functions) — these do NOT call an LLM. They accept
   already-parsed JSON (numbers, dates, split amounts) and persist it.
   The actual field-extraction/interpretation the torture test cares
   about most (turning a messy statement into principal/interest/fee
   numbers) happens **client-side, in the admin dashboard's browser
   JavaScript**, before these functions are ever called. Both functions
   have **no dry-run mode** — every successful call writes real
   `loan_statements`/`loan_splits`/`loan_accounts` rows that are
   indistinguishable from genuine production data, with no test/source
   flag to tell them apart later.

3. There is only **one Supabase project actually wired up for
   Bookkeeping** right now — `Family Laundry Project`
   (`umjpbuxrdydwejqtensq`), which is WashRoute's live production
   database. A second project, `WashRoute Staging`
   (`tnbngwnzsmonmkntjaon`), exists and has the right tables (with one
   naming mismatch: `loan_amortization_rows` vs. the schema's
   `loan_amortization_schedule_rows`), but **none of the loan edge
   functions are deployed there yet**, and it has no `ANTHROPIC_API_KEY`
   or other secrets configured. It is empty and otherwise safe to use
   — it just isn't wired up yet.

## Why this matters for the campaign

MISSION.md's Test Executor role is supposed to "run the fixture through
the actual WashRoute Bookkeeping Module" and its Safety Boundary section
says never to modify production databases. Taken literally, running
`loan-ingest-statement`/`loan-ingest-amortization` fixtures the normal
way means writing real-looking loan rows straight into the live
production financial database, with no way to mark them as synthetic
test data later. That's the scenario this briefing exists to flag
before doing it, not after.

## Options (see David's answer recorded below once given)

**A. Stand up WashRoute Staging as a real sandbox.** Deploy the three
loan edge functions there, fix the `loan_amortization_rows` naming
mismatch, copy over an `ANTHROPIC_API_KEY` secret. Most faithful to
MISSION.md as written — the full pipeline runs for real, safely
isolated. Costs some setup time this session and real (small) per-call
Anthropic API spend for `loan-document-intake` cases.

**B. Test what's already safe, audit the rest by code-reading.** Run
`loan-document-intake` for real (it's harmless) against many adversarial
documents. For `loan-ingest-statement`/`loan-ingest-amortization`, have
the Test Executor trace the actual code logic against each fixture
(reading the deployed source, not calling the live function) to
determine what it would produce, instead of writing rows to production.
Zero setup, zero cost, zero prod risk — but "the real pipeline" is
only partially exercised.

**C. Run for real against production, tagged and cleaned up
afterward.** Fastest path to literally what MISSION.md describes, but
goes against both MISSION.md's own safety boundary and the WashRoute
project's standing rule to never test against production financial
data. Not recommended.

## Decision

**David chose Option A** — stand up WashRoute Staging as a real, isolated sandbox.

That's now done and verified. `WashRoute Staging` (`tnbngwnzsmonmkntjaon`) has:
- A schema migration bringing it to parity with production's loan-ingestion tables
  (the `loan_amortization_rows` naming concern mentioned above turned out to be a
  false alarm — production's real code universally uses `loan_amortization_rows`;
  there was never an actual mismatch to fix).
- All three loan edge functions deployed (`loan-document-intake`,
  `loan-ingest-statement`, `loan-ingest-amortization`), matching production's code.
- A private storage bucket for statement uploads and a working test admin login.
- A smoke test confirming the full pipeline works end-to-end before the real
  campaign fixtures ran.

One gap: staging has **no `ANTHROPIC_API_KEY` configured**, so
`loan-document-intake`'s AI-assisted document classification path (the last-resort
step that calls Claude to classify an unrecognized document) wasn't exercised in
wave 1. Everything else ran for real, exactly as MISSION.md describes. See
FINDINGS.md and BUGS.md for wave 1's results — 2 confirmed bugs (High and Critical
severity) were found, entirely isolated from production the whole time.
