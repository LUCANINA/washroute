// ═══════════════════════════════════════════════════════════════════════════
// xero-429.ts — HOW LONG MAY WE WAIT FOR XERO? (session 290)
// ═══════════════════════════════════════════════════════════════════════════
// David, 2026-09-09 03:00 UTC: "Find the Fix requests are timing out."
//
// They were, and the cause was ours. Both big Xero pullers retried a 429 like
// this:
//
//     if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || …) * 1000); continue }
//
// Sensible for the limit it was written for -- Xero's per-MINUTE burst, whose
// Retry-After is a few seconds. But the tenant had hit the DAILY cap, and that
// 429 carries `Retry-After: 45461`. So the function obeyed it literally and slept
// for TWELVE AND A HALF HOURS, up to five times, until the gateway killed it at
// its own wall and returned 504. The line below it -- `throw new Error('Xero rate
// limit hit — try again in a few minutes.')` -- was never reached, because the
// sleep never returned.
//
// The user saw "The analysis failed — try again in a moment", which is the
// client's fallback when there is no JSON body at all, and is the worst possible
// advice: Xero enforces the daily cap as a ROLLING window, so every retry pushes
// the reset further out. The product was inviting the one action that made it
// worse.
//
// ── THE GUARD ALREADY EXISTED, ONE BRANCH AWAY (fourth time in session 290) ──
// `xero-read` has capped this since it was written:
//     const wait = Math.min(Number(res.headers.get('Retry-After') || 0) || 5, 30)
// The two functions that pull the most from Xero did not.
//
// ⚠️ THE DAILY CAP ON THIS TENANT IS 1,000, NOT THE 5,000 XERO'S DOCS QUOTE.
// Measured 2026-09-01 by xero-rate-probe, which is the only thing to trust here.

/** Longer than this and waiting is not a retry, it is a hang. */
export const MAX_RETRY_WAIT_SECONDS = 45

export type XeroRateLimit = {
  /** 'Minute' | 'Daily' | 'Concurrent' | 'AppMinute' | null when Xero did not say. */
  problem: string | null
  /** Seconds Xero asked us to wait, or null when it did not say. */
  retryAfter: number | null
  remainingDay: string | null
  remainingMinute: string | null
  /** May we sleep and retry inside one request? */
  waitable: boolean
  /** Seconds to actually sleep. 0 when not waitable. */
  waitSeconds: number
}

const num = (v: string | null): number | null => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? n : null
}

/**
 * Read what Xero actually said about the refusal.
 *
 * ⚠️ A MISSING Retry-After IS NOT PERMISSION TO WAIT FOREVER, and it is not a
 * reason to give up either. Xero sends the header on the minute limit and does
 * not always send it on others, so an absent value falls back to a short backoff
 * -- but `problem === 'Daily'` is decisive on its own, header or no header.
 */
export function readRateLimit(res: { status: number, headers: { get(k: string): string | null } }, attempt = 0): XeroRateLimit {
  const problem = res.headers.get('X-Rate-Limit-Problem')
  const retryAfter = num(res.headers.get('Retry-After'))
  const remainingDay = res.headers.get('X-DayLimit-Remaining')
  const remainingMinute = res.headers.get('X-MinLimit-Remaining')

  // The day cap is never waitable inside one request, whatever it asks for.
  const daily = String(problem || '').toLowerCase().startsWith('day')
    || num(remainingDay) === 0
  const asked = retryAfter == null ? (2 + attempt * 3) : retryAfter
  const waitable = !daily && asked <= MAX_RETRY_WAIT_SECONDS
  return {
    problem: problem || null,
    retryAfter,
    remainingDay: remainingDay || null,
    remainingMinute: remainingMinute || null,
    waitable,
    waitSeconds: waitable ? asked : 0,
  }
}

const human = (s: number): string => {
  if (s < 90) return `${Math.round(s)} seconds`
  if (s < 5400) return `about ${Math.round(s / 60)} minutes`
  return `about ${Math.round(s / 3600)} hours`
}

/**
 * The sentence the person reads. It must never say "try again in a moment" for a
 * daily cap -- that is the advice that costs them another call and pushes the
 * rolling window out.
 */
export function rateLimitMessage(info: XeroRateLimit): string {
  const daily = String(info.problem || '').toLowerCase().startsWith('day') || info.remainingDay === '0'
  if (daily) {
    return `Xero's daily API limit for this organisation is used up, so the books cannot be read right now`
      + (info.retryAfter ? ` — it should clear in ${human(info.retryAfter)}` : '')
      + `. Nothing is wrong with your data or the connection. ⚠️ Do not keep retrying: Xero counts the day as a rolling window, so each attempt pushes the reset further out.`
  }
  if (String(info.problem || '').toLowerCase().includes('concurrent')) {
    return `Xero is refusing because too many requests are in flight at once. Wait for the other job to finish and run this again.`
  }
  return `Xero's per-minute rate limit was hit and did not clear`
    + (info.retryAfter ? ` after ${human(info.retryAfter)}` : '')
    + `. This one usually clears on its own — try again shortly.`
}
