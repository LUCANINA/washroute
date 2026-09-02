// _shared/payout-retry.ts — decides whether a failed Stripe-payout post may be
// re-attempted automatically, and when.
//
// WHY THIS IS A SEPARATE, PURE MODULE. xero-payout-watchdog's own comments say it
// "deliberately does NOT retry automatically", because auto-retrying financial
// posts without a human looking is how the session-217 payroll incident happened.
// That rule is still right for almost everything. Session 260 carves out exactly
// one exception and puts the reasoning somewhere it can be TESTED rather than
// argued:
//
//   A payout whose PRE-CHECK failed never reached Xero at all. xero-payout-sync
//   asks Xero "do you already hold Reference 'Stripe payout <id>'?" BEFORE it
//   posts (session 241). When that GET returns 429 or the network drops, the
//   function refuses and stops -- nothing was classified, nothing was written,
//   no money moved. Re-running it later is not "retrying a financial post", it is
//   making the original attempt for the first time. And because the pre-check
//   still runs on the re-attempt, a duplicate is impossible even if our reading
//   of the situation is wrong.
//
// Everything else stays manual. A payout blocked on unclassified transactions or
// rejected by Xero validation will fail again in exactly the same way, and
// retrying it just buries the signal under repetition.
//
// THE DEFAULT IS "DON'T". classifyFailure returns 'permanent' for anything it
// does not positively recognise as transient. A new failure mode we have never
// seen is, by construction, not auto-retried -- see the failure_kind CHECK
// constraint in session_260_payout_retry_state.sql, which encodes the same bias.

export type FailureKind = 'transient' | 'permanent' | 'unknown'

/** Attempts made automatically before the sweep gives up and leaves it to a human. */
export const MAX_AUTO_ATTEMPTS = 6

/**
 * Backoff in MINUTES by attempt number (1-based: the delay after the Nth failure).
 *
 * Shaped to Xero's actual behaviour rather than to a generic exponential curve.
 * Measured on this tenant 2026-09-01: the accounting cap is 1,000/day enforced as
 * a ROLLING window, and observed retry_after values have ranged from 88 seconds to
 * 86 minutes from the same hard 0-remaining refusal. So: probe again soon (the
 * window may have already rolled), then spread out to cover a genuine day-long
 * exhaustion without burning quota that the payout post itself needs.
 *
 * Total span ~4h10m, which comfortably covers the gap between a ~7pm PT payout
 * webhook and the bank feed line arriving the next morning -- the deadline that
 * actually matters, because after that a human meets an unreconciled line with no
 * transaction to match and Xero offers to code it wrong.
 */
const BACKOFF_MINUTES = [2, 10, 30, 60, 120]

export function backoffMinutes(attemptCount: number): number {
  if (attemptCount < 1) return BACKOFF_MINUTES[0]
  const i = Math.min(attemptCount, BACKOFF_MINUTES.length) - 1
  return BACKOFF_MINUTES[i]
}

export function nextRetryAt(attemptCount: number, now: Date): Date {
  return new Date(now.getTime() + backoffMinutes(attemptCount) * 60_000)
}

/**
 * Classify a pre-check failure. `status` is the HTTP status if we got one at all;
 * `message` is whatever the throw carried.
 *
 * ONLY the shapes proven to mean "nothing reached Xero, ask again later" return
 * 'transient'. Note 401/403 are deliberately NOT transient: a dead token does not
 * fix itself, and retrying it every two minutes for four hours hides a real
 * problem behind noise.
 */
export function classifyPrecheckFailure(status: number | null, message: string): FailureKind {
  if (status === 429) return 'transient'
  if (status !== null && status >= 500 && status <= 599) return 'transient'
  if (status === null && /network|timeout|timed out|connection|fetch failed|dns|econnreset/i.test(message)) {
    return 'transient'
  }
  return 'permanent'
}

export interface RetryCandidate {
  status: string
  failure_kind: string | null
  attempt_count: number | null
  next_retry_at: string | null
}

/**
 * The sweep's gate. Every condition is a separate refusal so that adding a new
 * caller cannot accidentally skip one -- session 231's lesson was six bugs of the
 * shape "the right check, one branch away from the path that needed it", so this
 * is the ONLY place the question is answered.
 */
export function mayAutoRetry(row: RetryCandidate, now: Date): boolean {
  if (row.status !== 'failed') return false
  if (row.failure_kind !== 'transient') return false
  if ((row.attempt_count ?? 0) >= MAX_AUTO_ATTEMPTS) return false
  if (!row.next_retry_at) return false
  return new Date(row.next_retry_at).getTime() <= now.getTime()
}

/** True once the sweep has given up: a human now has to look. */
export function retriesExhausted(row: RetryCandidate): boolean {
  return row.status === 'failed'
    && row.failure_kind === 'transient'
    && (row.attempt_count ?? 0) >= MAX_AUTO_ATTEMPTS
}
