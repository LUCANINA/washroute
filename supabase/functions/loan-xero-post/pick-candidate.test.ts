import { assertEquals } from 'jsr:@std/assert@1'
import { chooseAutoCandidate } from './pick-candidate.ts'

const build = (rows: [string, string, boolean, string | null][]) => ({
  candidates: rows.map(([id, date]) => ({ id, date })),
  annotations: new Map(rows.map(([id, _d, worked, used]) => [id, { alreadyWorked: worked, usedByPeriod: used }])),
})

Deno.test('4140: the leftover payment is not this period\'s payment', () => {
  // The real 2026-06 posting on 2026-08-21. Every $1,180.32 payment on the loan, with
  // the state it was actually in at that moment. Expected payment date for the period
  // is 2026-06-17 (the statement the balance delta was measured to).
  const { candidates, annotations } = build([
    ['jan', '2026-01-20', true,  null],
    ['feb', '2026-02-17', true,  null],
    ['mar', '2026-03-17', true,  null],
    ['apr', '2026-04-17', false, '2026-04'],
    ['may', '2026-05-18', false, null],      // the only survivor -- and the wrong answer
    ['jun', '2026-06-17', true,  null],      // hand-split in Xero on 2026-07-14
    ['jul', '2026-07-17', false, '2026-07'],
    ['aug', '2026-08-17', true,  null],
  ])
  const out = chooseAutoCandidate(candidates, annotations, '2026-06-17')
  assertEquals(out.pickId, null)
  assertEquals(out.periodPaymentAlreadyWorked?.id, 'jun')
})

Deno.test('the ordinary case still auto-picks', () => {
  // 4140's 2026-05 period: two candidates, one taken by April, the May payment open
  // and one day from the expected date.
  const { candidates, annotations } = build([
    ['apr', '2026-04-17', false, '2026-04'],
    ['may', '2026-05-18', false, null],
  ])
  assertEquals(chooseAutoCandidate(candidates, annotations, '2026-05-17').pickId, 'may')
})

Deno.test('a lone survivor a month away is refused on distance alone', () => {
  // Nothing closer was excluded -- so we cannot say "already handled", but we still
  // must not post a June split onto a May payment.
  const { candidates, annotations } = build([
    ['may', '2026-05-18', false, null],
    ['jul', '2026-07-17', false, '2026-07'],
  ])
  const out = chooseAutoCandidate(candidates, annotations, '2026-06-17')
  assertEquals(out.pickId, null)
  assertEquals(out.tooFarDays, 30)
  assertEquals(out.periodPaymentAlreadyWorked, null)
})

Deno.test('a late payment inside the window is still picked', () => {
  // Genuinely late: 9 days after the expected date, nothing closer excluded. Allowed.
  const { candidates, annotations } = build([
    ['late', '2026-06-26', false, null],
    ['other', '2026-05-18', true, null],
  ])
  assertEquals(chooseAutoCandidate(candidates, annotations, '2026-06-17').pickId, 'late')
})

Deno.test('no anchor means no judgement -- old behaviour', () => {
  const { candidates, annotations } = build([['may', '2026-05-18', false, null]])
  assertEquals(chooseAutoCandidate(candidates, annotations, null).pickId, 'may')
})

Deno.test('more than one open candidate is still nobody\'s business here', () => {
  const { candidates, annotations } = build([
    ['a', '2026-06-17', false, null],
    ['b', '2026-06-18', false, null],
  ])
  assertEquals(chooseAutoCandidate(candidates, annotations, '2026-06-17').pickId, null)
})
