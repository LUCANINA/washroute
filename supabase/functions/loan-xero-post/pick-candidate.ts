// ============================================================================
// Which bank transaction is THIS period's payment?
//
// Extracted and hardened in session 233, after E-Transit 4140 booked its 2026-06
// interest onto its 2026-05-18 payment and left the loan $415.88 above the lender.
//
// The failure was not a missing safety check. `alreadyWorked` did its job: it looked
// at the real 2026-06-17 payment, saw it had been split by hand in Xero five weeks
// earlier, and excluded it. Every other $1,180.32 payment on that loan was either
// already split at source or claimed by another period -- so exactly ONE candidate
// survived the filter, the 2026-05-18 payment, and the rule "if only one is open,
// that must be it" took it.
//
// "Only one left" is not evidence. It is the absence of evidence: the right answer
// there was "this period's payment is already done, post nothing". So the survivor
// now has to look like this period's payment on its own merits:
//
//   1. it must sit within `maxDays` of the date this period's payment is expected, and
//   2. no EXCLUDED candidate may sit closer to that date than it does.
//
// Rule 2 is the one that catches 4140: the excluded 06-17 payment was 0 days from the
// expected date and the surviving 05-18 payment was 30. When a closer candidate was
// excluded for being already split, that candidate IS this period's payment, and the
// caller should offer "mark already handled in Xero" instead of posting anything.
// ============================================================================

export const AUTO_PICK_MAX_DAYS = 12

export type Candidate = { id: string; date: string | null }
export type Annotation = { alreadyWorked: boolean; usedByPeriod: string | null }

export type AutoPick = {
  pickId: string | null
  // Set when the pick was refused because an already-split candidate sits closer to
  // the expected payment date. That transaction is this period's payment.
  periodPaymentAlreadyWorked: { id: string; date: string | null; usedByPeriod: string | null } | null
  // Set when the pick was refused purely on distance, with nothing closer excluded.
  tooFarDays: number | null
}

const days = (a: string, b: string) =>
  Math.round(Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000)

const day = (v: string | null | undefined) =>
  typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null

export function chooseAutoCandidate(
  candidates: Candidate[],
  annotations: Map<string, Annotation>,
  payAnchor: string | null,
  maxDays: number = AUTO_PICK_MAX_DAYS,
): AutoPick {
  const none: AutoPick = { pickId: null, periodPaymentAlreadyWorked: null, tooFarDays: null }

  const open = candidates.filter(c => {
    const a = annotations.get(c.id)
    return a && !a.alreadyWorked && !a.usedByPeriod
  })
  if (open.length !== 1) return none

  const anchor = day(payAnchor)
  const sole = open[0]
  const soleDate = day(sole.date)
  // No anchor, or an undated transaction: we cannot judge it. Fall back to the old
  // behaviour rather than blocking work on a loan whose dates we don't have.
  if (!anchor || !soleDate) return { ...none, pickId: sole.id }

  const soleDist = days(soleDate, anchor)

  // Rule 2 first -- it is the more specific diagnosis, and the more useful message.
  let closest: { id: string; date: string | null; usedByPeriod: string | null; dist: number } | null = null
  for (const c of candidates) {
    if (c.id === sole.id) continue
    const a = annotations.get(c.id)
    const d = day(c.date)
    if (!a || !d) continue
    if (!a.alreadyWorked && !a.usedByPeriod) continue
    const dist = days(d, anchor)
    if (dist < soleDist && (!closest || dist < closest.dist)) {
      closest = { id: c.id, date: d, usedByPeriod: a.usedByPeriod, dist }
    }
  }
  if (closest) {
    return { pickId: null, tooFarDays: null,
      periodPaymentAlreadyWorked: { id: closest.id, date: closest.date, usedByPeriod: closest.usedByPeriod } }
  }

  if (soleDist > maxDays) return { pickId: null, periodPaymentAlreadyWorked: null, tooFarDays: soleDist }

  return { ...none, pickId: sole.id }
}
