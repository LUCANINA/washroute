// tests/xero-budget.test.mts — ask what is left before spending it (session 290)
//
// The dangerous failure here is NOT "it let a doomed pull start". It is the
// opposite: a pre-check that refuses real work on a healthy tenant. So most of
// these assertions are about the cases that must PROCEED.
//
// Run:  npx tsx tests/xero-budget.test.mts

import { budgetFromResponse, refuseBeforeSpending, refuseFromResponse }
  from '../supabase/functions/_shared/xero-budget.ts'
import { isDailyProblem, readRateLimit, rateLimitMessage }
  from '../supabase/functions/_shared/xero-429.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`)

const res = (status: number, h: Record<string, string> = {}) => ({
  status,
  headers: { get: (k: string) => (k in h ? h[k] : (h[k.toLowerCase()] ?? null)) },
})

section('UNKNOWN IS NOT ZERO — the rule that would cause an outage')
{
  // Xero omits the counter on some endpoints. If absence read as exhaustion,
  // every operation would refuse on a perfectly healthy tenant.
  const b = budgetFromResponse(res(200))
  ok('a healthy 200 with no counters is UNKNOWN, not exhausted', b.unknown && !b.exhausted, JSON.stringify(b))
  ok('...and it does not refuse', !refuseBeforeSpending(b).refuse)

  const empty = budgetFromResponse(res(200, { 'X-DayLimit-Remaining': '' }))
  ok('an EMPTY counter string is null, not 0', empty.remainingDay === null, JSON.stringify(empty))
  ok('...and does not refuse', !refuseBeforeSpending(empty).refuse)

  const junk = budgetFromResponse(res(200, { 'X-DayLimit-Remaining': 'n/a' }))
  ok('a non-numeric counter is null, not 0', junk.remainingDay === null && !junk.exhausted)

  const broken = budgetFromResponse(res(500))
  ok('a 500 tells us nothing about the budget and proceeds', !broken.exhausted && !refuseBeforeSpending(broken).refuse)

  ok('a null response proceeds', !refuseFromResponse(null).refuse)
  ok('an undefined response proceeds', !refuseFromResponse(undefined).refuse)
}

section('EXHAUSTED needs positive evidence, from either of two sources')
{
  const counted = budgetFromResponse(res(200, { 'X-DayLimit-Remaining': '0' }))
  ok('⭐ counter at zero on a 200 is exhausted', counted.exhausted, JSON.stringify(counted))
  ok('...and refuses', refuseBeforeSpending(counted).refuse)

  // The 429 body is empty, so the header may be all we get -- and sometimes the
  // counter is absent on the refusal itself. The named problem carries it.
  const named = budgetFromResponse(res(429, { 'X-Rate-Limit-Problem': 'Daily', 'Retry-After': '45461' }))
  ok('⭐ a 429 naming Daily is exhausted even with NO counter header', named.exhausted, JSON.stringify(named))
  const m = refuseBeforeSpending(named).message || ''
  ok('...the message warns against retrying', /rolling window/.test(m), m)
  ok('...says nothing is wrong with the data', /Nothing is wrong with your data/.test(m), m)
  ok('...and converts 45461s into hours, not seconds', /about 13 hours/.test(m), m)
  ok('⭐ ...and never says "try again in a moment"', !/in a moment|in a few minutes|shortly/.test(m), m)
}

section('ONLY THE DAILY CAP REFUSES THE WHOLE OPERATION')
{
  // The minute limit clears in seconds and xero-429 already waits it out inside
  // the pull. Refusing here would turn a two-second pause into a failed close.
  const minute = budgetFromResponse(res(429, { 'X-Rate-Limit-Problem': 'Minute', 'Retry-After': '3', 'X-MinLimit-Remaining': '0' }))
  ok('⭐ a MINUTE limit does not refuse the operation', !minute.exhausted && !refuseBeforeSpending(minute).refuse, JSON.stringify(minute))
  ok('...and it is not reported as unknown either — a 429 is informative', !minute.unknown, JSON.stringify(minute))

  const concurrent = budgetFromResponse(res(429, { 'X-Rate-Limit-Problem': 'Concurrent', 'Retry-After': '5' }))
  ok('a CONCURRENT limit does not refuse the operation', !refuseBeforeSpending(concurrent).refuse)

  // ...but a minute-limit refusal that ALSO reports the day counter at zero is
  // still exhausted. The counter outranks the label.
  const both = budgetFromResponse(res(429, { 'X-Rate-Limit-Problem': 'Minute', 'X-DayLimit-Remaining': '0' }))
  ok('⭐ a zero day-counter beats a "Minute" label', both.exhausted, JSON.stringify(both))
}

section('a healthy budget proceeds, and low is not empty')
{
  for (const n of ['1', '5', '250', '1000']) {
    const b = budgetFromResponse(res(200, { 'X-DayLimit-Remaining': n }))
    ok(`${n} remaining proceeds`, !b.exhausted && !refuseBeforeSpending(b).refuse, JSON.stringify(b))
  }
  // NO GUESSED FLOOR (rule 3). If a future session adds one, this assertion is
  // where the decision gets re-read -- it should be changed deliberately, with a
  // measured number out of xero_api_usage, not tuned until it goes green.
  const one = budgetFromResponse(res(200, { 'X-DayLimit-Remaining': '1' }))
  ok('⭐ ONE call left still proceeds — no floor is guessed (see rule 3)', !refuseBeforeSpending(one).refuse)
}

section('DISCRIMINATION — the check can actually fail')
{
  // The whole module is satisfied by `return {refuse:false}`. These two prove it
  // is not, in both directions.
  const healthy = refuseFromResponse(res(200, { 'X-DayLimit-Remaining': '900' }))
  const dead = refuseFromResponse(res(200, { 'X-DayLimit-Remaining': '0' }))
  ok('⭐ the same function answers differently for 900 and 0',
     healthy.refuse === false && dead.refuse === true,
     JSON.stringify({ healthy, dead }))
  ok('⭐ ...and only the refusal carries a message',
     healthy.message === null && typeof dead.message === 'string' && dead.message.length > 40)
}

section('"Daily" DOES NOT START WITH d-a-y — the shipped bug this file found')
{
  // Both copies of the predicate in xero-429.ts tested the first three letters
  // as d/a/y. Xero sends "Daily". It survived in production only because the
  // counter was usually present too and carried the decision on its own.
  ok('⭐ the predicate matches Xero\'s actual value', isDailyProblem('Daily'));
  ok('...and its casing variants', isDailyProblem('daily') && isDailyProblem('DAILY') && isDailyProblem(' Daily '));
  ok('...and DailyLimit', isDailyProblem('DailyLimit'));
  ok('⭐ ...and does NOT match the other limits', !isDailyProblem('Minute') && !isDailyProblem('Concurrent') && !isDailyProblem('AppMinute'));
  ok('...and tolerates absence', !isDailyProblem(null) && !isDailyProblem(undefined) && !isDailyProblem(''));

  // THE CASE THAT WAS BROKEN, END TO END. A daily refusal with NO counter header.
  // Before the fix this produced the per-minute sentence -- "try again shortly" --
  // which is the one piece of advice that makes a rolling daily window worse.
  const bare = res(429, { 'X-Rate-Limit-Problem': 'Daily', 'Retry-After': '45461' });
  const info = readRateLimit(bare as any);
  const msg = rateLimitMessage(info);
  ok('⭐ a Daily refusal with no counter is not waitable', info.waitable === false && info.waitSeconds === 0, JSON.stringify(info));
  ok('⭐ ...and gets the DAILY sentence', /daily API limit/.test(msg), msg);
  ok('⭐ ...NOT the per-minute one that says to try again shortly', !/try again shortly|usually clears on its own/.test(msg), msg);

  // And the corroboration that hid it: with the counter present it was always
  // right, for the wrong reason. Both must now be right.
  const withCounter = readRateLimit(res(429, { 'X-Rate-Limit-Problem': 'Daily', 'X-DayLimit-Remaining': '0', 'Retry-After': '45461' }) as any);
  ok('the counter-present case is still right', /daily API limit/.test(rateLimitMessage(withCounter)));
}

console.log(`\n${pass + fail} assertions · ${pass} passed · ${fail} failed`)
process.exit(fail ? 1 : 0)
