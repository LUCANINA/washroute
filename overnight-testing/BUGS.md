# Bugs — Loan Ingestion Torture Test

Campaign wave 1, run against **WashRoute Staging** (`tnbngwnzsmonmkntjaon`), 2026-08-22.
2 confirmed, reproducible bugs found out of 6 fixtures tested. Both are real bugs in the
deployed code — not staging artifacts — and both will exist on production the moment a
real-world loan hits the same pattern.

---

## BUG-0001 (from TEST-0004) — Severity: High

**One statement upload can silently destroy an entire loan's payment history if two
legitimate payments land on the same date.**

### What happens
If a bank statement contains two genuinely separate payments on the same calendar
date for the same loan (e.g., an ACH draft that failed and was immediately retried —
this is a normal, common bank pattern, not a data error), the whole upload fails —
and every *other*, unrelated payment in that same statement is silently thrown away
too, even payments on completely different dates that had nothing to do with the
conflict.

In our test: one statement had a legitimate same-day $500 + $500 payment pair, plus
one unrelated $500 payment on a different date. After the upload "failed," **zero**
rows were saved for any of it — the unrelated payment vanished along with the
conflicting pair.

### Why it happens
The system saves all of a statement's payments in one batch. The database correctly
refuses to store two payments for the same loan on the same date (it assumes that's
always a duplicate), but the code doesn't handle that refusal gracefully — instead
of saving everything it safely can and flagging just the conflicting date, it aborts
the entire batch and reports a generic database error with no indication of what was
lost.

### Real-world impact
A CPA uploads a normal monthly statement. If it happens to contain any same-day
payment pair — a retried ACH draft, a payment plus a same-day fee, anything — the
*entire statement's* worth of payments disappears with no useful error message, and
re-uploading the same statement will fail identically every time until someone fixes
the code or manually intervenes. Nothing in the response tells the CPA which date
collided or that other payments were lost too — they'd just see the upload "failed"
and have no idea their history for that account got wiped.

### Suggested fix direction
Handle same-day payment collisions explicitly and individually — either combine them
into one line with a note, or flag just that one date for human review — instead of
one all-or-nothing batch insert that dies on the first conflict.

### Confidence
High — reproduced once, confirmed via direct database query that 0 rows existed for
the loan after the call.

---

## BUG-0002 (from TEST-0006) — Severity: Critical — ✅ FIXED (2026-08-22)

**A future projection can permanently block the real number from ever being recorded,
with no warning to the CPA that what they're looking at was never checked against an
actual bank statement.**

### What happens
WashRoute automatically creates a forward-looking "here's what we project you'll owe
next" placeholder for a loan, based on its amortization schedule, before any real
statement for that period exists. This is a normal and useful feature — it gives the
CPA something to look at ahead of time.

The bug: when the *real* statement for that period later arrives — especially if it
arrives out of order (a completely normal real-world occurrence, since statements
don't always get pulled chronologically) — the system is supposed to replace the
placeholder with a number computed from the real statement. It doesn't. It sees
*something* already exists for that period, assumes that's good enough, and never
computes the real, statement-backed number at all.

In our test, the projected and real numbers happened to match exactly (by design, to
isolate this bug cleanly) — but the mechanism that's supposed to confirm that match
never ran. The placeholder simply sat there, permanently unconfirmed, indistinguishable
from a real reviewed number.

### Why it happens
The check that decides "has this period already been handled?" only looks at whether
*any* row exists for that loan and period. It doesn't check whether that row is a
real, statement-backed number or just an unconfirmed projection. So a projection
placeholder passes the check exactly as if it were the real, verified thing.

A second review pass confirmed this is asymmetric and clearly unintended: when
statements arrive in normal chronological order, the projection silently gets
overwritten (also without a proper check, but at least the numbers do get replaced).
When they arrive out of order — which is common — the projection blocks the real
number from ever being written, permanently.

### Real-world impact
This is the most serious finding of the wave, because it's silent and permanent. In
any case where the schedule projection and the real statement numbers *don't* match
exactly — which will happen whenever a rate changes, a fee is added, an escrow line
shifts, or a payment is late — the CPA could review and approve a number that was
**never actually checked against the real bank statement**, with nothing in the
interface indicating that. It looks exactly like every other reviewed split.

### Suggested fix direction
The system already has the right pattern for this elsewhere (the "what period should
be staged next" logic correctly distinguishes real, statement-backed rows from
projections). The same distinction needs to be applied to the out-of-order/backfill
path so a projection never counts as "already handled."

### Confidence
High — reproduced once, independently confirmed by a second review pass that also
identified the order-dependent asymmetry described above.

### Fix applied

`loan-ingest-statement/index.ts`'s backward-fill block now checks the existing
row's `status` and `source` before deciding a period is "already handled" —
mirroring the same check the Staging Engine's own `ensureUpcomingSplit` already
uses. An unconfirmed schedule projection (`source: 'amortization_schedule'`,
`status: 'pending_review'`) no longer blocks the real, statement-backed number;
any other existing split (already real, staged, or posted) still correctly
blocks re-computation, so nothing already reviewed can be silently overwritten.

Deployed to WashRoute Staging and verified with two live calls:
1. Re-ran the exact TEST-0006 scenario — the backfill now replaces the stale
   projection with a real `source: 'statement_delta'` split correctly linked to
   both real statements (`prior_statement_id` / `current_statement_id` populated).
2. Regression check — re-posted the same statement a third time, after the real
   split existed; the fix correctly left it alone (`backfilled_split: null`),
   confirming a genuinely real split still can't be clobbered by a re-upload.

**Deployed to production** (`umjpbuxrdydwejqtensq`, `loan-ingest-statement` v23,
2026-08-22) — same code verified on staging, deployed with the function's
existing auth setting unchanged. No test data was written to production to
verify this; the two live checks above (on staging) are what confirmed the fix
works and doesn't clobber real splits. If you want, I can also check whether
any of your real, currently-active loans already have a stale unconfirmed
schedule projection sitting where a real number should be, from before this
fix — that would be a read-only check, not a change.

---

## Minor note (from TEST-0003) — Severity: Low, not a functional bug

The exact dollar amount reported for a schedule-vs-statement mismatch can come back
as a slightly messy number (e.g. `2.009999999999991` instead of a clean `2.01`) due
to ordinary floating-point math. It didn't change any pass/fail decision in this
wave, but if a mismatch's *true* value sits exactly on the $2.00 tolerance boundary,
this kind of drift could in theory push it to the wrong side. Worth a defensive fix
(round to cents before comparing) even though it caused no incorrect behavior here.
