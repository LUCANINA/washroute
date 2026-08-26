import { assertEquals } from 'jsr:@std/assert@1'
import { postingDateFor, isProtectedDate, endOfMonth } from './close-date.ts'

Deno.test('the real session-233 case: closed through June, closing July, today in August', () => {
  // Books closed through 2026-06-30, the accountant is closing July, today is 2026-08-26.
  // A correction must land in August -- not June (settled), not July (their live work).
  assertEquals(postingDateFor('2026-06-30', '2026-08-26'), '2026-08-31')
})

Deno.test('books months behind: the current month wins over closeMonth + 2', () => {
  // Closed through January while it is August. closeMonth+2 is March -- technically open,
  // but a month they will close soon and would then have to redo. Current month is safe.
  assertEquals(postingDateFor('2026-01-31', '2026-08-26'), '2026-08-31')
})

Deno.test('books current: the closing month is skipped even when it is this month', () => {
  // Closed through July on 2026-08-10 means August is the month being closed.
  assertEquals(postingDateFor('2026-07-31', '2026-08-10'), '2026-09-30')
})

Deno.test('year boundary', () => {
  assertEquals(postingDateFor('2026-11-30', '2026-12-15'), '2027-01-31')
  assertEquals(postingDateFor('2026-12-31', '2027-01-05'), '2027-02-28')
})

Deno.test('nothing closed: this month is fine', () => {
  assertEquals(postingDateFor(null, '2026-08-26'), '2026-08-31')
})

Deno.test('a February in a leap year still ends on the 29th', () => {
  assertEquals(endOfMonth('2028-02'), '2028-02-29')
})

Deno.test('protected dates are everything before the first postable month', () => {
  // June 17 and July 20 are both untouchable while July is being closed; August is not.
  assertEquals(isProtectedDate('2026-06-17', '2026-06-30', '2026-08-26'), true)
  assertEquals(isProtectedDate('2026-07-20', '2026-06-30', '2026-08-26'), true)
  assertEquals(isProtectedDate('2026-08-17', '2026-06-30', '2026-08-26'), false)
})
