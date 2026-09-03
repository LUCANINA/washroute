// tests/xero-meter.test.mts — the Xero budget, measured instead of estimated
// (session 265).
//
// The morning this was written, staging a loan payment failed with "Could not
// check Xero for an existing stage (status 429) -- refusing to stage blind."
// The guard was right. The question nobody could answer was WHAT had spent the
// day's 1,000 calls, because in eleven Xero-touching edge functions not one line
// recorded a call. The best available answer was invocation counts multiplied by
// a hand-read estimate of calls-per-invocation — a derivation wearing a
// measurement's clothes, which this module has a rule about (session 245).
//
// Run:  node --experimental-strip-types tests/xero-meter.test.mts

import { createXeroMeter, XERO_API_HOST } from '../supabase/functions/_shared/xero-meter.ts'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

/** A response with just the bits the meter reads. */
function res(status: number, headers: Record<string, string | null> = {}) {
  return {
    status,
    headers: { get: (k: string) => (k in headers ? headers[k] : null) },
  } as unknown as Response
}
const DAY = 'X-DayLimit-Remaining'
const MIN = 'X-MinLimit-Remaining'
const API = `https://${XERO_API_HOST}/api.xro/2.0/ManualJournals`
const TOKEN = 'https://identity.xero.com/connect/token'

section('what counts against the budget, and what does not')
{
  const seen: string[] = []
  const m = createXeroMeter('test', {
    fetchImpl: async (u) => { seen.push(String(u)); return res(200, { [DAY]: '900' }) },
  })
  await m.fetch(TOKEN)
  await m.fetch(API)
  await m.fetch(API)

  // The OAuth token endpoint is a DIFFERENT host and is not billed against the
  // accounting limit. Counting it would overstate every caller by one and put the
  // meter permanently at odds with Xero's own header, for a reason that is ours.
  ok('api.xero.com calls are counted', m.calls === 2, `calls=${m.calls}`)
  ok('identity.xero.com is not', m.auxiliaryCalls === 1, `aux=${m.auxiliaryCalls}`)
  ok('every request still reached the wire', seen.length === 3)
}

section('a retry costs a call, because it does')
{
  const m = createXeroMeter('test', { fetchImpl: async () => res(429, { [DAY]: '0' }) })
  await m.fetch(API)
  await m.fetch(API)   // the retry Xero asks for
  await m.fetch(API)
  ok('three attempts are three calls', m.calls === 3, `calls=${m.calls}`)
  ok('...and the 429 is recorded', m.rateLimited === true)
  // Retrying into an exhausted budget is exactly how a day gets burned, so a
  // meter that only counted "successful" calls would hide its own worst case.
  ok('remaining_day of 0 is read as 0', m.remainingDay === 0, String(m.remainingDay))
}

section('AN EMPTY HEADER IS NOT A ZERO')
{
  // The most misleading thing this file could do: report an exhausted budget on
  // a healthy call because Xero sent the header with nothing in it.
  const empty = createXeroMeter('test', { fetchImpl: async () => res(200, { [DAY]: '' }) })
  await empty.fetch(API)
  ok('empty string reads as unknown, not 0', empty.remainingDay === null, String(empty.remainingDay))

  const junk = createXeroMeter('test', { fetchImpl: async () => res(200, { [DAY]: 'n/a' }) })
  await junk.fetch(API)
  ok('non-numeric reads as unknown, not 0', junk.remainingDay === null, String(junk.remainingDay))

  const absent = createXeroMeter('test', { fetchImpl: async () => res(200, {}) })
  await absent.fetch(API)
  ok('an absent header reads as unknown', absent.remainingDay === null, String(absent.remainingDay))

  const real = createXeroMeter('test', { fetchImpl: async () => res(200, { [DAY]: '0' }) })
  await real.fetch(API)
  ok('...and a genuine 0 still reads as 0', real.remainingDay === 0, String(real.remainingDay))
}

section('a silent response does not erase a known reading')
{
  let n = 0
  const m = createXeroMeter('test', {
    fetchImpl: async () => (++n === 1 ? res(200, { [DAY]: '412', [MIN]: '58' }) : res(200, {})),
  })
  await m.fetch(API)   // carries the counters
  await m.fetch(API)   // does not
  ok('the day counter survives', m.remainingDay === 412, String(m.remainingDay))
  ok('the minute counter survives', m.remainingMinute === 58, String(m.remainingMinute))
  // Some endpoints simply omit them. "We stopped being told" is not "the budget
  // became unknown", and overwriting would throw away the only reading we had.
}

section('TWO NUMBERS, AND NEITHER ALONE IS THE TEST')
{
  // This is the pair. A meter that counted nothing would still faithfully echo
  // Xero's header, and a meter that echoed nothing would still count. Only both,
  // asserted separately, catch either failure — the same shape as the
  // independent-opening repair in session 246.
  const counted = createXeroMeter('test', { fetchImpl: async () => res(200, {}) })
  await counted.fetch(API); await counted.fetch(API)
  ok('counts with NO header at all', counted.calls === 2 && counted.remainingDay === null,
     `calls=${counted.calls} day=${counted.remainingDay}`)

  const echoed = createXeroMeter('test', { fetchImpl: async () => res(200, { [DAY]: '731' }) })
  await echoed.fetch(API)
  ok('reads the header independently of the count', echoed.remainingDay === 731 && echoed.calls === 1,
     `calls=${echoed.calls} day=${echoed.remainingDay}`)
}

section('statuses, deduped and in the order first seen')
{
  const codes = [200, 429, 200, 503, 429]
  let i = 0
  const m = createXeroMeter('test', { fetchImpl: async () => res(codes[i++], {}) })
  for (const _ of codes) await m.fetch(API)
  ok('distinct statuses, first-seen order',
     JSON.stringify(m.statuses) === JSON.stringify([200, 429, 503]), JSON.stringify(m.statuses))
}

section('the row it writes')
{
  const rows: Record<string, unknown>[] = []
  const sink = { from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null } } }) }

  const m = createXeroMeter('xero-read', {
    mode: 'payment_picture',
    fetchImpl: async () => res(200, { [DAY]: '640', [MIN]: '57' }),
  })
  await m.fetch(API)
  const r = await m.flush(sink)

  ok('one row written', r.written === true && rows.length === 1, r.error ?? '')
  const row = rows[0] as Record<string, unknown>
  ok('caller is recorded', row.caller === 'xero-read')
  ok('mode is recorded', row.mode === 'payment_picture')
  ok('calls_made is the in-process count', row.calls_made === 1)
  ok('remaining_day is Xero’s own', row.remaining_day === 640)
  ok('started_at precedes finished_at',
     String(row.started_at) <= String(row.finished_at), `${row.started_at} .. ${row.finished_at}`)
  ok('http_statuses rides along', JSON.stringify(row.http_statuses) === '[200]')
}

section('telemetry never breaks the thing it measures')
{
  const throwing = { from: () => ({ insert: async () => { throw new Error('boom') } }) }
  const m = createXeroMeter('test', { fetchImpl: async () => res(200, { [DAY]: '5' }) })
  await m.fetch(API)
  let threw = false
  let out: any = null
  try { out = await m.flush(throwing) } catch (_) { threw = true }
  ok('a sink that throws does not throw at the caller', threw === false)
  ok('...and the failure is reported, not swallowed silently',
     out?.written === false && /boom/.test(String(out?.error)))

  const nullSink = createXeroMeter('test', { fetchImpl: async () => res(200, {}) })
  await nullSink.fetch(API)
  const n = await nullSink.flush(null)
  ok('a missing sink is handled', n.written === false && n.error === 'no sink')
}

section('an invocation that touched nothing writes nothing')
{
  const rows: unknown[] = []
  const sink = { from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null } } }) }
  const m = createXeroMeter('test', { fetchImpl: async () => res(200, {}) })
  await m.fetch(TOKEN)     // auxiliary only — no billed call
  const r = await m.flush(sink)
  ok('no billed call, no row', r.written === false && rows.length === 0)
  // A table full of zero rows makes the real ones harder to read, and this table
  // exists to be read by a person asking where the budget went.
}

section('WIRED — the meter is not just built')
{
  const src = readFileSync(new URL('../supabase/functions/xero-read/index.ts', import.meta.url), 'utf8')
  ok('xero-read imports the meter', /from ["']\.\.\/_shared\/xero-meter\.ts["']/.test(src))
  ok('...creates one naming itself', /createXeroMeter\('xero-read'/.test(src))
  ok('...and flushes it', /\.flush\(/.test(src))
  // The point of the wiring assertions: a shared module with a green unit suite
  // and no caller is a module that measures nothing. Session 263 shipped
  // evidence-gate.ts that way — 37 green assertions, wired into nothing.
  ok('no bare fetch to the Xero host remains outside the meter',
     !/(?<!meter\.)fetch\(`\$\{XERO\}/.test(src) || /meter\.fetch\(`\$\{XERO\}/.test(src))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
