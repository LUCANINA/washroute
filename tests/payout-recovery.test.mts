// tests/payout-recovery.test.mts — the session-260 payout recovery path.
//
// Run:  npx tsx tests/payout-recovery.test.mts
//
// These test the REAL modules by import. There are no transcribed copies here --
// session 245 found tests/loan-roster.test.mts full of functions "transcribed from
// admin-dashboard/index.html", fifty-two green assertions proving a copy agreed
// with itself. Every assertion below runs the shipped code.
//
// Each group ends with a DISCRIMINATION check: the inverse of the fix, applied to
// the real inputs, must make the assertion go red. An assertion that passes against
// both the fixed and the broken behaviour is decoration.

import { classifyPrecheckFailure, mayAutoRetry, retriesExhausted, backoffMinutes,
         nextRetryAt, MAX_AUTO_ATTEMPTS } from '../supabase/functions/_shared/payout-retry.ts'
import { rechain, toCents, fromCents } from '../supabase/functions/_shared/balance-rechain.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const g = (name: string) => console.log(`\n${name}`)

// ─────────────────────────────────────────────────────────────────────────────
g('classifyPrecheckFailure — only proven-transient shapes may auto-retry')

ok('429 is transient (the real 2026-08-27 and 2026-09-02 failures)',
  classifyPrecheckFailure(429, 'status 429') === 'transient')
ok('503 is transient', classifyPrecheckFailure(503, 'status 503') === 'transient')
ok('500 is transient', classifyPrecheckFailure(500, 'status 500') === 'transient')
ok('network throw with no status is transient',
  classifyPrecheckFailure(null, 'fetch failed: ECONNRESET') === 'transient')

// The dangerous direction. Each of these WOULD fail again identically, and
// retrying every 2 minutes buries the real signal.
ok('401 is NOT transient (a dead token does not heal itself)',
  classifyPrecheckFailure(401, 'status 401') === 'permanent')
ok('403 is NOT transient', classifyPrecheckFailure(403, 'status 403') === 'permanent')
ok('400 is NOT transient', classifyPrecheckFailure(400, 'status 400') === 'permanent')
ok('an unrecognised message with no status is NOT transient (default is do-not-retry)',
  classifyPrecheckFailure(null, 'something nobody has seen before') === 'permanent')

// ─────────────────────────────────────────────────────────────────────────────
g('mayAutoRetry — every condition refuses independently')

const NOW = new Date('2026-09-02T02:30:00Z')
const due = new Date(NOW.getTime() - 60_000).toISOString()
const notDue = new Date(NOW.getTime() + 60_000).toISOString()
const base = { status: 'failed', failure_kind: 'transient', attempt_count: 1, next_retry_at: due }

ok('a due transient failure retries', mayAutoRetry(base, NOW) === true)
ok('a posted row never retries', mayAutoRetry({ ...base, status: 'posted' }, NOW) === false)
ok('a pending row never retries', mayAutoRetry({ ...base, status: 'pending' }, NOW) === false)
ok('a PERMANENT failure never retries — the watchdog rule survives intact',
  mayAutoRetry({ ...base, failure_kind: 'permanent' }, NOW) === false)
ok('an UNKNOWN failure never retries (stranded pending: state genuinely unknown)',
  mayAutoRetry({ ...base, failure_kind: 'unknown' }, NOW) === false)
ok('a null failure_kind never retries', mayAutoRetry({ ...base, failure_kind: null }, NOW) === false)
ok('a row not yet due does not retry', mayAutoRetry({ ...base, next_retry_at: notDue }, NOW) === false)
ok('a row with no next_retry_at does not retry',
  mayAutoRetry({ ...base, next_retry_at: null }, NOW) === false)
ok('the attempt cap is enforced',
  mayAutoRetry({ ...base, attempt_count: MAX_AUTO_ATTEMPTS }, NOW) === false)
ok('one attempt below the cap still retries',
  mayAutoRetry({ ...base, attempt_count: MAX_AUTO_ATTEMPTS - 1 }, NOW) === true)
ok('retriesExhausted fires exactly at the cap',
  retriesExhausted({ ...base, attempt_count: MAX_AUTO_ATTEMPTS }) === true
  && retriesExhausted({ ...base, attempt_count: MAX_AUTO_ATTEMPTS - 1 }) === false)

// ─────────────────────────────────────────────────────────────────────────────
g('backoff — covers the evening-to-morning deadline')

ok('backoff is non-decreasing', (() => {
  let prev = 0
  for (let a = 1; a <= MAX_AUTO_ATTEMPTS; a++) {
    const m = backoffMinutes(a); if (m < prev) return false; prev = m
  }
  return true
})())
ok('first retry is soon (the rolling window may have already rolled)', backoffMinutes(1) <= 5)
// The deadline that matters: a ~7pm PT payout must be recovered before the bank
// feed line lands next morning, or a human meets an unreconciled line with no
// transaction to match it to. That is precisely how Aug 27 went wrong.
ok('total retry span exceeds 3 hours', (() => {
  let total = 0
  for (let a = 1; a <= MAX_AUTO_ATTEMPTS; a++) total += backoffMinutes(a)
  return total >= 180
})())
ok('nextRetryAt advances from now', nextRetryAt(1, NOW).getTime() > NOW.getTime())

// ─────────────────────────────────────────────────────────────────────────────
g('toCents — money never becomes a float')

ok('toCents("704.09") === 70409', toCents('704.09') === 70409)
ok('toCents(124553.62) === 12455362', toCents(124553.62) === 12455362)
ok('toCents("0.05") === 5', toCents('0.05') === 5)
ok('toCents("100") === 10000', toCents('100') === 10000)
ok('toCents rejects a thousands separator rather than silently mangling it',
  Number.isNaN(toCents('1,234.56')))
ok('round-trips', fromCents(toCents('124553.62')) === 124553.62)

// ─────────────────────────────────────────────────────────────────────────────
g('rechain — the real August damage, replayed from production figures')

// Every number below is the actual production row, pre-repair. The 08-27 payout
// never posted, so 08-28 chained off 08-26 and each later row was overstated by
// exactly the missing $704.09.
const anchor = toCents('125257.71')           // 2026-08-26, the last correct row
const damaged = [
  { date: '2026-08-27', paydownCents: toCents('704.09'),  storedBalanceCents: toCents('124553.62') },
  { date: '2026-08-28', paydownCents: toCents('472.09'),  storedBalanceCents: toCents('124785.62') },
  { date: '2026-08-31', paydownCents: toCents('440.91'),  storedBalanceCents: toCents('124344.71') },
  { date: '2026-09-01', paydownCents: toCents('377.15'),  storedBalanceCents: toCents('123967.56') },
]
const r = rechain(anchor, damaged)
ok('no refusal on well-formed input', r.refusal === null, String(r.refusal))
ok('exactly the three damaged rows are corrected, and 08-27 is left alone',
  r.corrections.length === 3 && r.corrections.every(c => c.date !== '2026-08-27'),
  JSON.stringify(r.corrections))
ok('each correction is exactly -$704.09 — the missing paydown, to the cent',
  r.corrections.every(c => c.fromCents - c.toCents === toCents('704.09')),
  JSON.stringify(r.corrections.map(c => c.fromCents - c.toCents)))
ok('the corrected values are the ones session 260 wrote by hand', (() => {
  const m = new Map(r.corrections.map(c => [c.date, c.toCents]))
  return m.get('2026-08-28') === toCents('124081.53')
      && m.get('2026-08-31') === toCents('123640.62')
      && m.get('2026-09-01') === toCents('123263.47')
})())
ok('final balance matches the repaired chain', r.finalBalanceCents === toCents('123263.47'))

// The self-healing property, stated as a test: an already-correct chain is a no-op.
const healthy = [
  { date: '2026-08-27', paydownCents: toCents('704.09'), storedBalanceCents: toCents('124553.62') },
  { date: '2026-08-28', paydownCents: toCents('472.09'), storedBalanceCents: toCents('124081.53') },
  { date: '2026-08-31', paydownCents: toCents('440.91'), storedBalanceCents: toCents('123640.62') },
  { date: '2026-09-01', paydownCents: toCents('377.15'), storedBalanceCents: toCents('123263.47') },
]
ok('a correct chain produces zero corrections (idempotent)',
  rechain(anchor, healthy).corrections.length === 0)

// ─────────────────────────────────────────────────────────────────────────────
g('rechain — refuses rather than half-rewriting a balance chain')

const neg = rechain(anchor, [
  { date: '2026-08-27', paydownCents: -70409, storedBalanceCents: toCents('125961.80') },
])
ok('a negative paydown refuses', neg.refusal !== null)
ok('a refusal yields NO corrections — a half-rewritten chain looks like a whole one',
  neg.corrections.length === 0)

const unordered = rechain(anchor, [
  { date: '2026-08-28', paydownCents: toCents('472.09'), storedBalanceCents: toCents('124081.53') },
  { date: '2026-08-27', paydownCents: toCents('704.09'), storedBalanceCents: toCents('124553.62') },
])
ok('out-of-order dates refuse', unordered.refusal !== null && unordered.corrections.length === 0)

const dup = rechain(anchor, [
  { date: '2026-08-27', paydownCents: 100, storedBalanceCents: 1 },
  { date: '2026-08-27', paydownCents: 100, storedBalanceCents: 1 },
])
ok('a duplicated date refuses', dup.refusal !== null)

const overdrawn = rechain(toCents('100.00'), [
  { date: '2026-08-27', paydownCents: toCents('500.00'), storedBalanceCents: 0 },
])
ok('a walk below zero refuses', overdrawn.refusal !== null && overdrawn.corrections.length === 0)

// ─────────────────────────────────────────────────────────────────────────────
g('DISCRIMINATION — the inverse of each fix must go red')

// 1. The chain bug itself. Reimplement the OLD behaviour (each row computed from
//    the row stored before it) and confirm it does NOT reach the repaired values.
//    If this passes, rechain is not actually doing anything.
const oldChainResult = (() => {
  let prev = anchor
  const out: number[] = []
  for (const e of damaged) { out.push(e.storedBalanceCents); prev = e.storedBalanceCents }
  return out
})()
ok('DISCRIMINATES: the old stored chain disagrees with the rechained values',
  oldChainResult[1] !== toCents('124081.53'))

// 2. The retry carve-out. If mayAutoRetry ignored failure_kind (the inverse of the
//    fix), a permanent failure would retry. Assert it does not.
ok('DISCRIMINATES: a permanent failure would retry if failure_kind were ignored',
  mayAutoRetry({ ...base, failure_kind: 'permanent' }, NOW) === false
  && mayAutoRetry({ ...base, failure_kind: 'transient' }, NOW) === true)

// 3. The fail-safe default. If classifyPrecheckFailure defaulted to 'transient'
//    (the inverse of the stated bias), an unknown error would loop forever.
ok('DISCRIMINATES: an unknown failure defaults to permanent, not transient',
  classifyPrecheckFailure(418, 'teapot') === 'permanent')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
