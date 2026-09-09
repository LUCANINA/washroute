// ═══════════════════════════════════════════════════════════════════════════
// xero-budget.ts — ASK WHAT IS LEFT BEFORE SPENDING IT (session 290)
// ═══════════════════════════════════════════════════════════════════════════
// David, 2026-09-09, after the tenant's daily quota was emptied on two
// consecutive days: *"yes put it on the priority list"*.
//
// Session 290 already fixed the SENTENCE — `xero-429.ts` stops the twelve-hour
// sleep and says the honest thing. **That was not fixing the problem.** A click
// still starts a fifty-call ledger pull against a budget of zero, discovers the
// refusal halfway through, and the person still loses the day. The fix is to
// spend less, and the cheapest way to spend less is to ask first.
//
// ── THE SIGNAL WAS ALREADY ARRIVING AND BEING THROWN AWAY ──────────────────
// This is the fifth time in this module's history that the guard existed one
// branch away from where it was needed (s231), and this instance is the purest:
// BOTH big pullers already make a cheap Xero call before the expensive one, and
// BOTH discard everything about it except the body.
//
//     loan-find-difference  fetchAccountsMap:  `if (!res.ok) return {}`
//     reconciliation-run    fetchTrialBalances: `if (!r.ok) return null`
//
// A 429 on either of those is `X-DayLimit-Remaining: 0` in the hand, dropped on
// the floor, immediately before the pull that cannot finish. So the pre-check
// costs NOT ONE EXTRA CALL — it is reading a response we were already paying
// for. The START HERE note called this "one call to save fifty"; measured, it is
// zero calls to save fifty.
//
// ── THREE RULES, AND THE FIRST IS THE ONE THAT WILL BITE ───────────────────
//
// 1. **UNKNOWN IS NOT ZERO.** Xero omits `X-DayLimit-Remaining` on some
//    endpoints and has been observed to send it empty. Treating absence as
//    exhaustion would refuse every operation on a healthy tenant the moment
//    Xero changed which endpoints carry counters — a self-inflicted outage
//    dressed as a safety feature. `unknown` is a distinct state and it always
//    proceeds. (Same discipline as `xero-meter.ts`'s parseCounter, and as
//    session 247's "a null is not a zero".)
//
// 2. **ONLY THE DAILY CAP REFUSES THE WHOLE OPERATION.** The per-minute limit
//    clears in seconds and `xero-429.ts` already waits it out inside the pull.
//    Refusing an operation over a minute limit would turn a two-second pause
//    into a failed close.
//
// 3. **NO GUESSED FLOOR.** The obvious next thought is "refuse when fewer than
//    N calls remain, because the pull needs about N". Do not invent N. Nothing
//    in this project has ever measured what a Find the Fix costs — `xero-read`
//    is the ONLY metered caller of eleven, and it alone spent 977 calls in six
//    days against a 1,000/day cap. Wire `xero-meter.ts` into the pullers first,
//    read the real distribution out of `xero_api_usage`, and only then set a
//    floor. A threshold picked from the same intuition that produced "the cap is
//    5,000" (it is 1,000, measured) is a number that will refuse real work.
//    See session 245: a quantity derived from the thing it is meant to check
//    cannot fail, and a guessed constant is not a measurement.
// ═══════════════════════════════════════════════════════════════════════════

import { readRateLimit, rateLimitMessage, isDailyProblem, type XeroRateLimit } from './xero-429.ts'

export type XeroBudget = {
  /** Xero's own X-DayLimit-Remaining. null = it did not say. NEVER read as 0. */
  remainingDay: number | null
  remainingMinute: number | null
  /** X-Rate-Limit-Problem, when refused. */
  problem: string | null
  retryAfter: number | null
  status: number | null
  /** POSITIVE evidence that the daily budget is spent. */
  exhausted: boolean
  /** Nothing on the wire said anything about the budget. Always proceeds. */
  unknown: boolean
}

/** Present-but-not-a-number is not zero. Xero sends empty strings. */
function counter(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const t = String(raw).trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

type Headerish = { status: number, headers: { get(k: string): string | null } }

/**
 * Read the budget off a response we already made. Works on ANY api.xero.com
 * response — the whole point is that it needs no call of its own.
 */
export function budgetFromResponse(res: Headerish | null | undefined): XeroBudget {
  if (!res) return { remainingDay: null, remainingMinute: null, problem: null, retryAfter: null, status: null, exhausted: false, unknown: true }

  const remainingDay = counter(res.headers?.get?.('X-DayLimit-Remaining'))
  const remainingMinute = counter(res.headers?.get?.('X-MinLimit-Remaining'))
  const problem = res.headers?.get?.('X-Rate-Limit-Problem') || null
  const retryAfter = counter(res.headers?.get?.('Retry-After'))

  // Exhausted needs POSITIVE evidence, from either of two independent places:
  // the counter reading zero, or Xero naming the daily limit as the problem on a
  // refusal. Two sources, because a header can be absent and a 429 body is empty.
  // isDailyProblem, NOT a third hand-written copy of the predicate -- writing it
  // twice is exactly how one copy came to be wrong (see xero-429.ts).
  const namedDaily = res.status === 429 && isDailyProblem(problem)
  const countedZero = remainingDay === 0
  const exhausted = namedDaily || countedZero

  // Unknown only when NOTHING informative arrived. A 429 is always informative.
  const unknown = !exhausted && remainingDay === null && res.status !== 429

  return { remainingDay, remainingMinute, problem, retryAfter, status: res.status ?? null, exhausted, unknown }
}

/**
 * Should the expensive operation start at all?
 *
 * Refuses ONLY on the daily cap. A minute limit, an unknown budget, a 500, or a
 * healthy response all proceed — see rule 1 and rule 2 in the header.
 */
export function refuseBeforeSpending(b: XeroBudget): { refuse: boolean, message: string | null } {
  if (!b.exhausted) return { refuse: false, message: null }
  const info: XeroRateLimit = {
    problem: b.problem || 'Daily',
    retryAfter: b.retryAfter,
    remainingDay: b.remainingDay === null ? null : String(b.remainingDay),
    remainingMinute: b.remainingMinute === null ? null : String(b.remainingMinute),
    waitable: false,
    waitSeconds: 0,
  }
  // ONE SENTENCE, WRITTEN ONCE. rateLimitMessage already carries the
  // rolling-window warning and the honest "nothing is wrong with your data";
  // a second copy here is a second thing to keep true (s279).
  return { refuse: true, message: rateLimitMessage(info) }
}

/** Convenience for a caller holding a Response it already made. */
export function refuseFromResponse(res: Headerish | null | undefined) {
  return refuseBeforeSpending(budgetFromResponse(res))
}

/** Re-exported so callers need one import for the whole concern. */
export { readRateLimit, rateLimitMessage, isDailyProblem }
