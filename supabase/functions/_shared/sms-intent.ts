// sms-intent.ts — how an inbound text is understood (session 325)
// ============================================================================
// Extracted from twilio-webhook/index.ts so it can be tested without the Deno
// runtime: index.ts reads Deno.env at module scope, so a Node test could never
// import it. Everything here is pure — no network, no database, no clock
// beyond an injectable `nowMs`.
//
// The shared rule, and the reason these classifiers look paranoid: a message
// is only understood when EVERY word in it is one we expected. An unexpected
// word — "no", "don't", a name, a second question — means a human reads it.
// Being wrong is not symmetrical. A missed command costs a reply; a wrongly
// booked pickup sends a van to a doorstep with nothing on it.
// ============================================================================

// YYYY-MM-DD in Pacific time, `addDays` from now (or from `iso` when given).
export function ptDateKey(iso?: string, addDays = 0): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + addDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

export const ptDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

// WashRoute's route_templates.schedule_days uses the convention 0=Mon … 6=Sun.
// JavaScript's Date.getDay() uses 0=Sun … 6=Sat, so it must be converted with
// (getDay() + 6) % 7 before comparing against schedule_days — the same
// conversion used throughout the customer app and admin dashboard. Without it,
// Sunday (getDay()=0) falsely matches schedule_days value 0 (which means Monday),
// so the SMS reorder would book closed Sundays and never book Saturdays.
export function wrDow(y: number, m: number, d: number): number {
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

// ── Skip-request classifier (2026-09-21) ──
// "Skip pick up today thanks" used to fall through to the staff inbox because
// only a handful of exact phrasings counted. Now: the text must contain SKIP
// and EVERY other word must come from a small filler list. Any
// other word — a name, "don't", "not", "next", "and", a question about
// something else — means a human reads it. Returns null when it isn't a skip.
// `when` is the day the customer named, checked against the order in handleSkip.
export type SkipWhen = 'today' | 'tomorrow' | 'week' | null;
const SKIP_FILLER = new Set([
  'PLEASE','PLS','PLZ','CAN','COULD','WOULD','YOU','WE','I','HI','HELLO','HEY','OK','OKAY',
  'PICK','UP','PICKUP','PICKUPS','MY','THE','OUR','ORDER','LAUNDRY','ME','US','IT','FOR',
  'NEED','WANT','TO','JUST','TIME','SORRY',
  'TODAY','TODAYS','TONIGHT','TONITE','TOMORROW','TOMORROWS','TMRW','THIS','WEEK','WEEKS',
  'THANKS','THANK','THX','TY','TNX',
]);
export function classifySkip(body: string): { when: SkipWhen } | null {
  const words = (body || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.includes('SKIP')) return null;
  if (!words.every(w => w === 'SKIP' || SKIP_FILLER.has(w))) return null;
  const has = (...ws: string[]) => ws.some(w => words.includes(w));
  const namesToday = has('TODAY', 'TODAYS', 'TONIGHT', 'TONITE');
  const namesTomorrow = has('TOMORROW', 'TOMORROWS', 'TMRW');
  if (namesToday && namesTomorrow) return null;           // contradictory — let a human decide
  if (namesToday) return { when: 'today' };
  if (namesTomorrow) return { when: 'tomorrow' };
  if (has('WEEK', 'WEEKS')) return { when: 'week' };
  return { when: null };
}

// ── Pickup-request classifier (session 325) ──
// The mirror of classifySkip, and written for the same reason: PICKUP matched
// six hardcoded strings, so "pickup friday" went to the staff inbox. 193 such
// messages in the 120 days to 2026-10-01, against 53 that used the exact word.
// Rule: the text must contain a pickup word and EVERY other word must be
// filler or a day name. Anything unexpected — "no", "don't", a question, a
// second topic — returns null and a human reads it. That strictness is the
// safety property: a wrongly booked pickup sends a van to a doorstep.
// `day` is what the customer asked for; resolvePickupDate turns it into a date.
export type PickupDay = 'today' | 'tomorrow' | number | null;   // number = 0=Mon … 6=Sun
const PICKUP_FILLER = new Set([
  'PLEASE','PLS','PLZ','CAN','COULD','WOULD','YOU','WE','I','HI','HELLO','HEY','OK','OKAY',
  'MY','THE','OUR','ORDER','LAUNDRY','ME','US','IT','FOR','A','AN','ANOTHER','UP',
  'NEED','WANT','TO','JUST','TIME','READY','AGAIN','NEXT','ON','AT','THIS','WEEK','WEEKS',
  'THANKS','THANK','THX','TY','TNX','SCHEDULE','BOOK','DO','HAVE','GOT','BAGS','BAG',
]);
const DAY_WORDS: Record<string, number> = {
  MONDAY: 0, MON: 0, TUESDAY: 1, TUES: 1, TUE: 1, WEDNESDAY: 2, WED: 2, WEDS: 2,
  THURSDAY: 3, THURS: 3, THUR: 3, THU: 3, FRIDAY: 4, FRI: 4,
  SATURDAY: 5, SAT: 5, SUNDAY: 6, SUN: 6,
};
export function classifyPickup(body: string): { day: PickupDay } | null {
  const words = (body || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return null;
  if (words.includes('SKIP')) return null;                       // handled by classifySkip
  const hasPickup = words.includes('PICKUP') || words.includes('PICKUPS')
    || (words.includes('PICK') && words.includes('UP'));
  if (!hasPickup) return null;
  const known = (w: string) =>
    w === 'PICKUP' || w === 'PICKUPS' || w === 'PICK'
    || PICKUP_FILLER.has(w) || w in DAY_WORDS
    || w === 'TODAY' || w === 'TODAYS' || w === 'TONIGHT' || w === 'TONITE'
    || w === 'TOMORROW' || w === 'TOMORROWS' || w === 'TMRW';
  if (!words.every(known)) return null;                          // an unexpected word → human
  // Found by replaying 120 days of real inbound texts: "do i have a schedule
  // pick up tonight?" is built entirely from allowed words, but it ASKS about
  // a pickup rather than requesting one — and would have booked a van. A
  // question about state is not a command.
  const opener = words.slice(0, 2).join(' ');
  if (['DO I', 'DID I', 'AM I', 'DOES MY', 'WAS MY'].includes(opener)) return null;
  const has = (...ws: string[]) => ws.some(w => words.includes(w));
  const namedDays = words.filter(w => w in DAY_WORDS).map(w => DAY_WORDS[w]);
  const namesToday = has('TODAY', 'TODAYS', 'TONIGHT', 'TONITE');
  const namesTomorrow = has('TOMORROW', 'TOMORROWS', 'TMRW');
  const mentions = (namesToday ? 1 : 0) + (namesTomorrow ? 1 : 0) + new Set(namedDays).size;
  if (mentions > 1) return null;                                 // "friday or saturday" → human
  if (namesToday) return { day: 'today' };
  if (namesTomorrow) return { day: 'tomorrow' };
  if (namedDays.length) return { day: namedDays[0] };
  return { day: null };                                          // "pickup please" → soonest
}

// A reschedule is a question, not a command — we never guess a new date from it.
// We answer with the one question that turns it into a command the system can
// act on. Session 324: a customer replied "Reshedule", it fell to the inbox,
// and a booking sat unanswered for 16 hours.
const RESCHEDULE_WORDS = new Set([
  'RESCHEDULE','RESCHEDULED','RESCHEDULING','RESHEDULE','RESHEDULED','RESCHED','RESHED',
  'REBOOK','REBOOKED','REARRANGE','MOVE',
]);
export function isRescheduleRequest(body: string): boolean {
  const words = (body || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || words.length > 12) return false;          // a long message is a conversation
  return words.some(w => RESCHEDULE_WORDS.has(w));
}

// Turn what the customer said into a Pacific date key, or null for "soonest".
export function resolvePickupDate(day: PickupDay, nowMs = Date.now()): string | null {
  if (day === null) return null;
  if (day === 'today') return ptDateKey();
  if (day === 'tomorrow') return ptDateKey(undefined, 1);
  for (let ahead = 0; ahead <= 7; ahead++) {                     // today counts: "friday" on a Friday
    const date = ptDateFmt.format(new Date(nowMs + ahead * 86_400_000));
    const [y, m, d] = date.split('-').map(Number);
    if (wrDow(y, m, d) === day) return date;
  }
  return null;
}

