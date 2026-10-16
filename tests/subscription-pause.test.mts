// tests/subscription-pause.test.mts — session 345 one-month pause date math
// Run:  node --experimental-strip-types tests/subscription-pause.test.mts
import { addOneMonth, occurrencesInWindow } from '../supabase/functions/_shared/pause-window.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) } else { fail++; console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`) }
}
const iso = (d: Date) => d.toISOString()

// addOneMonth — same rule Stripe uses for a monthly period
ok('Oct 18 → Nov 18, same clock time', iso(addOneMonth(new Date('2026-10-18T15:30:00Z'))) === '2026-11-18T15:30:00.000Z')
ok('Jan 31 → Feb 28 (clamped)', iso(addOneMonth(new Date('2027-01-31T08:00:00Z'))) === '2027-02-28T08:00:00.000Z')
ok('Dec 15 → Jan 15 (year roll)', iso(addOneMonth(new Date('2026-12-15T08:00:00Z'))) === '2027-01-15T08:00:00.000Z')
ok('Mar 31 → Apr 30', iso(addOneMonth(new Date('2027-03-31T08:00:00Z'))) === '2027-04-30T08:00:00.000Z')

// occurrencesInWindow — pause Oct 18 15:30 PT-ish → Nov 18
const start = new Date('2026-10-18T22:30:00Z'), end = new Date('2026-11-18T22:30:00Z')
// Weekly Thursday series, next order Thu Oct 15 (before the pause)
const weekly = [{ pickup_address_id: 'A', recurring_interval: 'weekly', recurring_anchor_at: '2026-10-15T14:00:00Z', pickup_window_start: '2026-10-15T14:00:00Z' }]
const w = occurrencesInWindow(weekly, start, end).map(r => r.skip_date)
ok('weekly: skips Oct 22, 29, Nov 5, 12 — not Oct 15, not Nov 19', JSON.stringify(w) === JSON.stringify(['2026-10-22','2026-10-29','2026-11-05','2026-11-12']), JSON.stringify(w))

// Next order already inside the window (Tue Oct 20): its own date is NOT planned (the tick skips
// that order); the following ones are.
const inside = [{ pickup_address_id: 'B', recurring_interval: 'weekly', recurring_anchor_at: '2026-10-20T14:00:00Z', pickup_window_start: '2026-10-20T14:00:00Z' }]
const i = occurrencesInWindow(inside, start, end).map(r => r.skip_date)
ok('existing in-window order: later weeks planned, own date not', JSON.stringify(i) === JSON.stringify(['2026-10-27','2026-11-03','2026-11-10','2026-11-17']), JSON.stringify(i))

const biweekly = [{ pickup_address_id: 'C', recurring_interval: 'biweekly', recurring_anchor_at: '2026-10-16T14:00:00Z', pickup_window_start: '2026-10-16T14:00:00Z' }]
const b = occurrencesInWindow(biweekly, start, end).map(r => r.skip_date)
ok('biweekly: Oct 30, Nov 13', JSON.stringify(b) === JSON.stringify(['2026-10-30','2026-11-13']), JSON.stringify(b))

const monthly = [{ pickup_address_id: 'D', recurring_interval: 'monthly', recurring_anchor_at: '2026-10-25T14:00:00Z', pickup_window_start: '2026-10-25T14:00:00Z' }]
ok('monthly: next is Nov 25, after the pause → nothing planned', occurrencesInWindow(monthly, start, end).length === 0)

// Evening window: 8 pm PT Thursday = 03:00Z Friday — skip date must be the PT date (Thursday)
const evening = [{ pickup_address_id: 'E', recurring_interval: 'weekly', recurring_anchor_at: '2026-10-16T03:00:00Z', pickup_window_start: '2026-10-16T03:00:00Z' }]
const e = occurrencesInWindow(evening, start, end).map(r => r.skip_date)
ok('evening pickups use the Pacific date', e[0] === '2026-10-22', JSON.stringify(e))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
