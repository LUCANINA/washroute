# DESIGN — Customer-Service Escalation & Pattern Detection

Status: design agreed 2026-09-10. Not yet built.
Owner: David. CS team owns issues day-to-day (info@familylaundry.com);
Operations Director Luis Lemus (luis@familylaundry.com) is tier 2; David is tier 3.

---

## The incident this exists to prevent

A neighbor at 5811 Mendocino Ave (not a customer) asked us seven times over seven
weeks to stop parking in her driveway while servicing 5805 Mendocino. Jul 23 →
Sep 10. Three different reps sent three near-identical apologies. The tone went
from a polite 95-second voicemail to profanity and a threat to post fabricated
negative reviews. **Nobody in management knew it was happening.**

Four separate failures, each of which is a design requirement below:

1. **No durable object for "a problem with a person."** `cs_issues` existed but was
   a scratchpad — 112 of its 176 rows are `note` rows from one day, categories were
   free-text (`Billing` and `billing` both present), 5 open. Reps replied in the
   thread; the thread closed; nothing persisted.
2. **Everything was keyed to `customer_id`. She is not a customer.** Neighbors,
   prospects, landlords and adjacent businesses are invisible to every existing view.
   The key must be the phone number.
3. **Nothing counted repetition.** Each of her seven contacts looked like a first
   contact to whoever picked it up.
4. **"Resolved" meant "I replied."** No rep changed the route note, the stop's parking
   instruction, or spoke to the driver. The apology was the whole remedy.

---

## What the data actually looks like (measured 2026-09-10, trailing 365 days)

These numbers set every threshold in this document. Re-measure before changing one.

| Signal | Volume | Verdict |
|---|---|---|
| Inbound SMS | 11,144 msgs / 1,542 phones | baseline |
| Phones with inbound on ≥3 distinct days | **597** | useless alone — ordinary customers texting about orders |
| Messages matching escalation language | 372 / 237 phones | ~1/day — a reviewable queue |
| Phones both repeat AND escalating | **118** | ~2/week — the right alert volume |
| Non-customer phones | 273 | mostly one-off wrong numbers |
| Non-customer phones with ≥3 days | **6** | tiny, high-value. Lauren is #1. The other 5 are vendor spam and robocalls |

Theme frequency, trailing 365 days:

| Theme | Msgs | Distinct customers | Of which last 3 months |
|---|---|---|---|
| billing | 128 | 79 | 54 |
| missed_service | 81 | 65 | 32 |
| lost_item | 69 | 47 | 26 |
| parking | 59 | 26 | **31** |
| quality | 38 | 23 | 10 |
| damage (holes/tears) | 25 | 19 | **16** |

Two live spikes are already hiding in this data: **damage is running at ~3x its
12-month rate** (16 of 25 msgs in the last quarter) and **parking at ~2x** (31 of 59).
Neither was visible to anyone before this scan.

**Conclusion that shapes the whole design:** repeat contact alone is noise (597
phones). Repeat contact *plus a real complaint classification* is signal (118).
Keyword matching alone cannot make that distinction — the 6 non-customer repeat
contacts include one genuine grievance and five sales robocalls that no regex
separates. Hence the LLM pass.

---

## Data model

### `cs_issues` — extended, and re-keyed to a contact rather than a customer

New columns:

| Column | Why |
|---|---|
| `contact_phone` text | **the real key.** E.164. Present even when `customer_id` is null |
| `contact_email` text | same, for email-origin issues |
| `contact_name` text | what they call themselves; may differ from any customer record |
| `is_customer` boolean | drives the "non-customer complaint" section of the dashboard |
| `theme` text | enforced vocabulary (below). Replaces free-text `category` |
| `subject_ref` jsonb | what the issue is *about*: `{address, driver_id, order_id, route_id}` |
| `first_reported_at` / `last_reported_at` timestamptz | the age clock and the recency clock |
| `report_count` integer | how many times they have raised it. Drives the ladder |
| `severity` smallint | 1 normal, 2 manager, 3 owner. Never decreases automatically |
| `resolution_action` text | **required to close.** What CHANGED, not what was said |
| `reopened_count` integer | how many times a "resolved" issue came back |
| `verify_by` date | when someone must confirm the fix held |

`theme` vocabulary, enforced by CHECK constraint — no more `Billing`/`billing`:
`parking`, `driver_conduct`, `damage`, `lost_item`, `missed_service`,
`quality`, `billing`, `app`, `account`, `other`.

Existing rows: `category` is migrated into `theme` by a mapping table, unmapped
values land in `other`, and `category` is kept for one release then dropped.

### `cs_signals` — what the detector found

One row per distinct finding, keyed by `fingerprint` and **carried across runs**, so a
signal you have already seen does not re-alarm every night. This is the same pattern
`reconciliation_findings` already uses successfully — reuse it, do not invent a second one.

| Column | Notes |
|---|---|
| `fingerprint` text unique | e.g. `repeat_contact:+14159945735:parking` |
| `signal_type` text | `repeat_contact` \| `noncustomer_complaint` \| `escalation_language` \| `theme_spike` \| `aging_issue` |
| `severity` smallint | 1/2/3 — maps to the notification ladder |
| `contact_phone`, `customer_id`, `theme` | subject of the signal |
| `issue_id` | the `cs_issues` row it opened or updated |
| `evidence` jsonb | the message ids and verbatim excerpts that triggered it |
| `llm_verdict` jsonb | classification, confidence, one-line rationale |
| `status` | `open` \| `acknowledged` \| `suppressed` \| `resolved` |
| `first_seen_at`, `last_seen_at`, `notified_at`, `notified_severity` | dedup + escalation state |

Suppression is sticky: a signal a human dismissed stays dismissed **unless the
underlying facts change** (new message, higher severity). Same rule as
`bk_issue_dismissals` and `customer_duplicate_dismissals`.

---

## Detection — `cs-signal-scan`, nightly, on pg_cron

Runs on raw comms (`sms_messages`, `email_messages`, `voicemails`). It **does not depend
on a rep filing anything** — that dependency is what failed.

### Stage 1 — cheap prefilter (SQL)

Select inbound messages from the last 24h (and, on the weekly pass, the last 30 days)
that match either the theme regexes or the escalation-language regex. ~2/day.

### Stage 2 — LLM classification pass

Each candidate goes to the model with the last 5 messages of its thread and any open
issue on that phone. Returns strict JSON:

```json
{
  "is_complaint": true,
  "theme": "parking",
  "severity": 3,
  "is_same_as_open_issue": true,
  "subject_ref": {"address": "5811 Mendocino Ave"},
  "customer_intent": "asking us to stop parking in her driveway",
  "rationale": "seventh request over seven weeks; profanity and review threat"
}
```

This stage is what separates Lauren from the five robocalls. At ~400–800 candidates a
year the cost is a couple of dollars a month. **The model may only classify — it may
never close an issue, notify anyone, or send a message.**

### Stage 3 — detectors

| Detector | Fires when | Severity |
|---|---|---|
| `noncustomer_complaint` | any LLM-confirmed complaint from a phone with no `customer_id` | 2 immediately — this class was 100% invisible |
| `repeat_contact` | LLM-confirmed complaint from a phone that already has an open issue, or a complaint on ≥2 distinct days in 60 days | 2, then 3 on the 3rd |
| `escalation_language` | review threat, legal threat, profanity, or "still/again/keep asking" | 3 regardless of count |
| `theme_spike` | distinct customers on a theme in 30 days ≥ 2x the trailing 90-day monthly rate, floor ≥4 customers | 2 |
| `aging_issue` | open issue with no `resolution_action` after 7 days | 2; 14 days → 3 |

Thresholds live in a `settings` row, not in code, so they can be tuned without a deploy.

---

## The rules that make it stick

These three are the difference between a dashboard and a fix.

1. **An issue cannot be closed by a reply.** Closing requires a non-empty
   `resolution_action` describing what changed — a route note edited, a driver spoken
   to, a stop instruction added. Enforced in the database (CHECK on the close
   transition), not just in the UI, so no code path can bypass it.
2. **Re-contact auto-reopens.** If the same phone contacts again within 30 days of a
   close, the issue reopens, `reopened_count` increments and `severity` rises by one.
   This single rule catches the Lauren case on Aug 27, six weeks before anyone noticed.
3. **Severity never decreases automatically.** Only a human lowers it, and the change
   is logged as a comment.

### Escalation ladder

| Severity | Who is told | When |
|---|---|---|
| 1 | info@familylaundry.com | in the daily digest |
| 2 | info@ + luis@ | in the daily digest |
| 3 | info@ + luis@ + david@ | **immediately**, plus the digest |

---

## Surfacing

### Dashboard — one "Needs Attention — Customer Service" card

Same shape as the Bookkeeping Needs Attention lists. Four sections, each collapsed to
a count until opened:

- **Repeat contacts** — open issues with `report_count ≥ 2`, sorted by severity then age
- **Aging** — open issues with no `resolution_action`, oldest first
- **Emerging patterns** — active `theme_spike` signals with their 30d/90d numbers
- **Non-customer complaints** — `is_customer = false`, always shown even at count 1

Each row shows the verbatim last message, not a summary. The apology-generating instinct
is what caused this; seeing her actual words is the corrective.

### Email

- **Daily digest, 7:00 PT**, to info@, luis@, david@ — recipients filtered by severity per
  the ladder. **Suppressed entirely when there is nothing open**, so its arrival means
  something. One guaranteed Friday summary regardless, so silence is never ambiguous.
- **Immediate send on severity 3.**
- **Dedup:** never re-notify the same `fingerprint` within 7 days unless
  `severity > notified_severity`.

Sent through the existing `send-email` function using the `wr_internal_auth`
shared-secret path (`x-wr-internal`), the same way pg_cron jobs already call it.

---

## Measured detector output (2026-09-10)

Dry run over the trailing 14 days:

| | |
|---|---|
| Prefilter candidates | 42 messages |
| Contacts sent to the model | 28 |
| Confirmed complaints | **5** |
| Of which severity 3 | 2 |
| Of which non-customer | 1 |

That is ~2.5 real complaints a week and ~1 severity-3 a week — a digest short enough to
read and an immediate alert rare enough to still mean something.

Both severity-3 findings were invisible before this ran:
- `+14159945735` — the Mendocino neighbour. Correctly typed NON-CUSTOMER, driver_conduct,
  intent read as "stop the driver from blocking their driveway despite explicit instructions".
- `+15103426105` — a customer escalating about missing towels.

The three severity-1 findings were ordinary first-time complaints, correctly not escalated.

Runtime: ~56s for a 14-day window. A 60-day backfill exceeds the edge-function wall clock
and must be chunked.

## The idempotency rule (learned the hard way, same day)

**A message must be counted once, ever.** v1 had no such gate. Re-running an identical
14-day window took severity-3 from 2 to 5: the issues the first run created were read by
the second run as proof of a repeat contact, so `report_count` climbed and severity
ratcheted on no new input. A detector that escalates on its own output is a cry-wolf
generator, and a queue nobody trusts is precisely the failure this project exists to fix.

v2 gates on `cs_signals.evidence.message_ids`: messages already seen are filtered out
before anything is counted, before severity is computed, and before the model is called
(so reruns are also free). The regression test is in `verify-session-291.sh` — run the
same window twice; the second run must report 0 new signals.

**Never enable the cron without that two-run test passing.**

**Verified 2026-09-10 on v2:** run 1 wrote 5 signals (2 severity-3); run 2 over the identical
window reported `total: 0`, `skipped_already_seen: 5`, and left every issue at
`report_count: 1` with severities unchanged. PASS.

## Build order

1. ~~Read-only backfill scan over 12 months~~ — done 2026-09-10, numbers above.
2. ~~Migration: extend `cs_issues`, add `cs_signals`~~ — applied 2026-09-10 as
   `session_291_cs_escalation` + `session_291a_revoke_anon_cs_signals`. PostgREST
   visibility of the new columns proven by REST round-trip before any client code.
3. ~~`cs-signal-scan` edge function~~ — v2 deployed 2026-09-10, verify_jwt TRUE (measured),
   two-run idempotency test PASSED, 14-day backfill written (5 open issues).
4. Dashboard card (reads real signals from step 3).
5. `session_291b` close-requires-a-note constraint — **apply in the same release as the
   dashboard change**, never before. It rejects the current Resolve button.
6. Enable email. Through `washroute-preflight` — must be proven it can only ever mail
   info@ / luis@ / david@.
7. pg_cron nightly job. Only after the two-run idempotency test passes.
8. Chunked historical backfill (the 6 non-customer contacts, the 118 repeat/escalating
   phones), in windows small enough to fit the wall clock.

## Open at design time

- Whether the CS team gets an "acknowledge" action distinct from "resolve" — probably
  yes, so a signal can leave the alert queue without claiming a fix happened.
- Whether voicemail transcription quality is good enough to classify on. Several rows
  in the sample are `(transcription pending…)` with 2–3 second durations.
- Lauren's issue itself is still open as of this writing and needs a real remedy —
  a route note on the 5805 Mendocino stop and a conversation with the driver.
