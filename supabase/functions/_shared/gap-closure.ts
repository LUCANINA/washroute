// _shared/gap-closure.ts
//
// ── session 279: THE GAP CLOSES WHEN THE MONEY ARRIVES, NOT AT THE END ───────
//
// A tie-out compares the lender's balance on a date against ours. When they
// differ, the honest next question is whether the difference is an error or
// simply the payment arriving a few days after the lender's statement was
// produced -- so the check asks whether the entries dated AFTER the anchor
// account for the gap.
//
// It asked that by netting EVERY later entry up to today. That is right for one
// payment and wrong for two: the moment a second lands, the sum sails past zero
// and a gap that was closed exactly by the first one reads as an exception
// again, permanently. Both of the two largest unexplained exceptions on this
// book were that, and both to the cent:
//
//   PCV 202555         gap 5,335.52 @ 2026-08-01
//                      2026-08-03 payment, line on account 254 = 5,335.52 -> closed
//                      2026-09-01 payment then overshoots the net to -5,357.75
//   BayFirst SBA Loan  gap   971.56 @ 2026-08-05
//                      2026-08-06 payment, line on account 243 =   971.56 -> closed
//                      a second entry then overshoots the net to -1,046.56
//
// ── THIS IS NOT AMOUNT MATCHING ─────────────────────────────────────────────
// Worth saying plainly, because the first draft of this fix WAS an amount
// matcher -- find a payment near the anchor whose size equals the gap -- and
// this module exists partly to record why that was thrown away. Nothing here
// compares the gap to any payment's size. It adds up real entries in date order
// and reports the first moment they account for the difference. The question is
// "did the money actually arrive", which is measured; not "is there something
// about the right size nearby", which is a pattern found in data (s245).
//
// ── THE SAFETY PROPERTY: IT IS MONOTONE ─────────────────────────────────────
// The full set of later entries is itself a prefix, so anything that closed
// under the old net test still closes here, possibly at an earlier date. This
// can only ever turn an exception INTO an explanation, never the reverse, and a
// loan with no later entries cannot move at all. That is what makes it safe to
// ship against a live close: on the day it was written, 2 of 9 open exceptions
// resolved and five could not move by construction -- including all three Ford
// loans, whose prepared corrections are untouched.
//
// ── TWO REJECTED DESIGNS, KEPT SO THEY ARE NOT RE-INVENTED ──────────────────
// Both looked obviously right and were killed by counting, not by argument:
//   1. "the lender reported no movement while our books moved" -- fires on 38
//      pairs across this book. Every Ford is pulled twice a month and the second
//      pull correctly shows nothing. A nag machine.
//   2. "the payment window crosses a month end" -- 8 of 10 loans sit at 83-100%.
//      It measures how often statements are pulled, not timing risk.
// Do not widen anything here without counting first.

/** Tolerance for "closed". Matches the tie-out's own 0.02 -- one place, not two. */
export const CLOSURE_TOL = 0.02

export interface ClosureEntry {
  date: string
  /** Signed effect on the loan account: negative reduces the balance. */
  effect: number
}

export interface ClosureResult {
  /** The date the running total first accounted for the gap, or null. */
  closed_on: string | null
  /** How many entries that took. 0 when it never closed. */
  closed_after_entries: number
  /** What is left once EVERY later entry is counted -- unchanged by this walk,
   *  and still what a human acts on when the gap did not close. */
  residual_after_all: number
}

/**
 * Walk `entries` (already filtered to after-anchor and not future-dated, and in
 * date order) and report the first point at which they account for `diff`.
 *
 * `diff` is xero - lender at the anchor date. The caller owns the filtering:
 * this deliberately does no date arithmetic, so a future-dated staged
 * transaction cannot sneak in here after being excluded there.
 */
export function walkToClosure(diff: number, entries: ClosureEntry[]): ClosureResult {
  const rows = Array.isArray(entries) ? entries : []
  let running = diff
  let closedOn: string | null = null
  let afterEntries = 0
  for (const r of rows) {
    running = Math.round((running + Number(r.effect || 0)) * 100) / 100
    if (closedOn === null) {
      afterEntries++
      if (Math.abs(running) < CLOSURE_TOL) closedOn = String(r.date)
    }
  }
  return {
    closed_on: closedOn,
    closed_after_entries: closedOn === null ? 0 : afterEntries,
    residual_after_all: running,
  }
}
