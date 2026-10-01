// sms-intent.test.mts — session 325
// ============================================================================
// PICKUP matched six hardcoded strings while SKIP had a real classifier. In the
// 120 days to 2026-10-01: 775 exact SKIP, 53 exact PICKUP — and 193 messages
// that mentioned a pickup AND named a weekday, every one of which went to the
// staff inbox. One of them was session 324's win-back customer, who replied
// "Reshedule" and waited 16 hours for a human.
//
// The asymmetry these tests protect: a missed command costs a reply, a wrongly
// booked pickup sends a van to a doorstep with nothing on it. So the bar for
// UNDERSTANDING a message is every word expected — the negative cases below
// matter more than the positive ones.
// ============================================================================
import {
  classifySkip, classifyPickup, isRescheduleRequest, resolvePickupDate, wrDow,
} from '../supabase/functions/_shared/sms-intent.ts'

let pass = 0, fail = 0
const ok = (c: unknown, name: string, obs = '') => {
  if (c) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${obs ? `\n        ${obs}` : ''}`) }
}
const sec = (t: string) => console.log(`\n── ${t} `)

sec('PICKUP — understood')
for (const [msg, day] of [
  ['PICKUP', null], ['pickup', null], ['pickup.', null], ['Pick up', null],
  ['pickup please', null], ['can you pick up please', null],
  ['pickup thanks', null], ['I need a pickup', null],
] as const) {
  const r = classifyPickup(msg)
  ok(r && r.day === day, `"${msg}" → soonest`, JSON.stringify(r))
}
for (const [msg, day] of [
  ['pickup friday', 4], ['PICKUP FRIDAY', 4], ['pick up on friday please', 4],
  ['can you pickup tuesday', 1], ['pickup mon', 0], ['pickup sunday', 6],
] as const) {
  const r = classifyPickup(msg)
  ok(r && r.day === day, `"${msg}" → day ${day}`, JSON.stringify(r))
}
ok(classifyPickup('pickup today')?.day === 'today', '"pickup today"')
ok(classifyPickup('can i have a pickup tomorrow please')?.day === 'tomorrow',
   'a request phrased as a question is still a request')
ok(classifyPickup('hi! can i do pickup on wednesday?')?.day === 2, '"can i do pickup on wednesday?"')
ok(classifyPickup('pick up tomorrow please')?.day === 'tomorrow', '"pick up tomorrow please"')

sec('PICKUP — refused, a human reads these')
for (const msg of [
  'no pick up today',              // a negation, the opposite of a booking
  'no need to pick up laundry',
  'dont pick up tomorrow',
  'skip pickup today',             // belongs to classifySkip
  'how do i reschedule?',
  'can you pick up friday or saturday',   // two days — which one?
  'pickup friday tomorrow',               // contradictory
  'we have two bags to pick up and one is heavy',
  'is my pickup still coming',
  'pick up my laundry at my moms house',  // an instruction we would silently drop
  'do i have a schedule pick up tonight?',   // asks about state — found by replaying real traffic
  'did i have a pickup today',
  'am i booked for a pickup tomorrow',
  '',
]) ok(classifyPickup(msg) === null, `"${msg}" → human`, JSON.stringify(classifyPickup(msg)))

sec('SKIP — unchanged by this session')
ok(classifySkip('skip')?.when === null, '"skip"')
ok(classifySkip('skip pick up today thanks')?.when === 'today', '"skip pick up today thanks"')
ok(classifySkip('skip tomorrow')?.when === 'tomorrow', '"skip tomorrow"')
ok(classifySkip('skip this week')?.when === 'week', '"skip this week"')
ok(classifySkip('dont skip') === null, '"dont skip" → human')
ok(classifySkip('pickup friday') === null, '"pickup friday" is not a skip')

sec('RESCHEDULE — asks, never guesses')
for (const msg of ['reschedule', 'Reshedule', 'can we reschedule', 'please rebook me', 'move my pickup'])
  ok(isRescheduleRequest(msg), `"${msg}"`)
for (const msg of ['pickup friday', 'skip', 'thanks', ''])
  ok(!isRescheduleRequest(msg), `"${msg}" → not a reschedule`)
ok(!isRescheduleRequest('I wanted to ask whether it is possible to reschedule the pickup we had planned for next week sometime'),
   'a long message is a conversation, not a command')

sec('resolvePickupDate')
{
  // Thu 2026-10-01 12:00 PT
  const now = Date.UTC(2026, 9, 1, 19, 0, 0)
  ok(resolvePickupDate(null, now) === null, 'no day → soonest')
  ok(resolvePickupDate(4, now) === '2026-10-02', 'friday → tomorrow (2026-10-02)',
     String(resolvePickupDate(4, now)))
  ok(resolvePickupDate(3, now) === '2026-10-01', 'thursday on a Thursday → today',
     String(resolvePickupDate(3, now)))
  ok(resolvePickupDate(2, now) === '2026-10-07', 'wednesday → next week (2026-10-07)',
     String(resolvePickupDate(2, now)))
  ok(wrDow(2026, 10, 2) === 4, 'wrDow: 2026-10-02 is a Friday (0=Mon)')
}

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
process.exit(fail ? 1 : 0)
