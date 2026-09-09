// tests/xero-429.test.mts — HOW LONG MAY WE WAIT FOR XERO?
//
// Session 290. David: "Find the Fix requests are timing out." They were, and the
// cause was ours: the retry loop obeyed a DAILY cap's Retry-After of 45,461
// seconds literally and slept for 12.6 hours until the gateway killed it. The
// user got a 504 with no body, rendered as "try again in a moment" — the one
// action that pushes a rolling daily window further out.
//
// The numbers below are the ones xero-rate-probe measured on this tenant at
// 2026-09-09T03:01:58Z.

import assert from 'node:assert'
import { readRateLimit, rateLimitMessage, MAX_RETRY_WAIT_SECONDS } from '../supabase/functions/_shared/xero-429.ts'

let pass = 0, fail = 0
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)) }
}
const h = (s: string) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)))

const res = (headers: Record<string, string>) => ({
  status: 429,
  headers: { get: (k: string) => headers[k] ?? null },
})

h('THE REAL REFUSAL — the one that hung for 12.6 hours')
const DAILY = res({ 'X-Rate-Limit-Problem': 'Daily', 'Retry-After': '45461', 'X-DayLimit-Remaining': '0' })
t('⭐ it is NOT waitable — this is the whole fix', () =>
  assert.equal(readRateLimit(DAILY).waitable, false))
t('...so nothing sleeps', () => assert.equal(readRateLimit(DAILY).waitSeconds, 0))
t('...and the figures Xero sent are preserved for the message', () => {
  const r = readRateLimit(DAILY)
  assert.equal(r.retryAfter, 45461)
  assert.equal(r.remainingDay, '0')
  assert.equal(r.problem, 'Daily')
})
t('⭐ the message says HOURS, not "in a moment"', () => {
  const m = rateLimitMessage(readRateLimit(DAILY))
  assert.match(m, /daily API limit/)
  assert.match(m, /about 13 hours/)
})
t('⭐ ...and tells the reader NOT to retry, which is the advice that was missing', () =>
  assert.match(rateLimitMessage(readRateLimit(DAILY)), /Do not keep retrying/))
t('...and says their data is fine, because a limit is not a fault', () =>
  assert.match(rateLimitMessage(readRateLimit(DAILY)), /Nothing is wrong with your data/))

h('THE LIMIT THIS LOOP WAS WRITTEN FOR — it must still be retried')
const MINUTE = res({ 'X-Rate-Limit-Problem': 'Minute', 'Retry-After': '3', 'X-MinLimit-Remaining': '0' })
t('⭐ a per-minute 429 IS waitable — the fix must not break the working case', () =>
  assert.equal(readRateLimit(MINUTE).waitable, true))
t('...and waits exactly what Xero asked for', () =>
  assert.equal(readRateLimit(MINUTE).waitSeconds, 3))
t('...and its message does NOT tell the reader to stop', () =>
  assert.ok(!/Do not keep retrying/.test(rateLimitMessage(readRateLimit(MINUTE)))))

h('THE BOUNDARY — a header is not permission to hang')
t(`anything over ${MAX_RETRY_WAIT_SECONDS}s is refused even when Xero calls it a Minute problem`, () =>
  assert.equal(readRateLimit(res({ 'X-Rate-Limit-Problem': 'Minute', 'Retry-After': String(MAX_RETRY_WAIT_SECONDS + 1) })).waitable, false))
t('...and exactly at the ceiling is still allowed', () =>
  assert.equal(readRateLimit(res({ 'X-Rate-Limit-Problem': 'Minute', 'Retry-After': String(MAX_RETRY_WAIT_SECONDS) })).waitable, true))

h('WHAT XERO DOES NOT SAY')
/* ⚠️ A missing Retry-After is not permission to wait for ever, and not a reason
   to give up. It falls back to a short backoff that GROWS with the attempt. */
t('no header at all still waits, briefly', () => {
  assert.equal(readRateLimit(res({}), 0).waitSeconds, 2)
  assert.equal(readRateLimit(res({}), 3).waitSeconds, 11)
})
t('⭐ ...but a zero day-remaining is decisive WITHOUT the problem header', () =>
  assert.equal(readRateLimit(res({ 'X-DayLimit-Remaining': '0' })).waitable, false))
t('...and that case still gets the daily sentence', () =>
  assert.match(rateLimitMessage(readRateLimit(res({ 'X-DayLimit-Remaining': '0' }))), /daily API limit/))
t('a day-remaining above zero is NOT the daily cap', () =>
  assert.equal(readRateLimit(res({ 'X-Rate-Limit-Problem': 'Minute', 'Retry-After': '5', 'X-DayLimit-Remaining': '400' })).waitable, true))

h('CONCURRENT — a third shape, and it needs its own sentence')
t('it is not waitable inside one request', () => {
  const r = readRateLimit(res({ 'X-Rate-Limit-Problem': 'Concurrent', 'Retry-After': '120' }))
  assert.equal(r.waitable, false)
})
t('...and says what to actually do about it', () =>
  assert.match(rateLimitMessage(readRateLimit(res({ 'X-Rate-Limit-Problem': 'Concurrent', 'Retry-After': '120' }))),
    /too many requests are in flight/))

h('THE CONTROL — the old behaviour, so the difference is measured not assumed')
t('⭐ the OLD rule would have slept 45,461 seconds on the real refusal', () => {
  // What the deleted line computed: Number(Retry-After) || (2 + retry * 3)
  const old = Number(DAILY.headers.get('Retry-After')) || 2
  assert.equal(old, 45461)
  assert.ok(old / 3600 > 12, 'over twelve hours')
  // And what it does now.
  assert.equal(readRateLimit(DAILY).waitSeconds, 0)
})

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
if (fail) process.exit(1)
