// _shared/balance-rechain.ts — recompute a Stripe Capital balance chain so that a
// missed day repairs itself instead of offsetting every balance after it forever.
//
// THE BUG THIS EXISTS TO KILL (session 260, measured on real rows).
// xero-payout-sync writes a loan_statements snapshot per payout as
// `previous_snapshot.principal_balance - paydown`, taking "previous" as the newest
// row dated on-or-before this payout. That is a CHAIN, and a chain has no memory of
// what it skipped. When the 2026-08-27 payout never posted, the 08-28 snapshot
// chained off 08-26 and every balance from 08-28 onward was overstated by exactly
// the missing $704.09 paydown. Backfilling 08-27 alone did NOT fix it -- the later
// rows had already been computed from the wrong base, and the repair had to be done
// by hand.
//
// THE FIX IS TO STOP TREATING THE STORED NUMBER AS THE BASE. A balance is
// reconstructed from an anchor plus the paydowns actually recorded between the
// anchor and that date. Recompute the tail on every write and the chain becomes
// self-healing: fill a gap and every row after it corrects on the next payout,
// with no manual UPDATE.
//
// WHY THIS IS NOT THE "DERIVED, NOT MEASURED" MISTAKE (session 245/247). The
// module's standing rule is that a quantity computed from the balances it is meant
// to CHECK will always agree with itself. Nothing here is a check. The paydowns are
// MEASURED -- each one is the financing_paydown Stripe reported in its own payout,
// stored as a loan_splits row. The balance is openly a derived running total of
// those measurements, and the thing that audits it is a lender anchor from
// loan_statements (source portal_manual_pull / lender_statement), which this
// function never reads and can never move.
//
// ALL MONEY IS INTEGER CENTS. stripe-capital.ts learnt this at a cost: 4,000 rows
// of $0.005 accumulated as rounded floats reported $40.00 against a true $20.00.

export interface ChainEntry {
  /** ISO YYYY-MM-DD. */
  date: string
  /** Paydown recorded for this date, in cents. Always POSITIVE (a repayment). */
  paydownCents: number
  /** What loan_statements currently holds for this date, in cents. */
  storedBalanceCents: number
}

export interface Correction {
  date: string
  fromCents: number
  toCents: number
}

export interface RechainResult {
  corrections: Correction[]
  /** Balance the chain ends on, in cents. */
  finalBalanceCents: number
  /** Set when an input made the walk untrustworthy; corrections is empty when so. */
  refusal: string | null
}

/**
 * Walk forward from an anchor, recomputing each date as previous - paydown.
 *
 * `entries` MUST be every snapshot after the anchor, in date order, with no gaps
 * omitted -- the caller reads them from loan_statements in one query. A caller that
 * passes a filtered subset would reintroduce exactly the bug this fixes, so the
 * ordering is asserted here rather than assumed.
 *
 * REFUSES rather than guesses on: a negative paydown (a repayment can only reduce
 * the liability -- xero-payout-sync already refuses to write one, and this is the
 * second guard on the same fact), dates out of order or duplicated, or a walk that
 * would drive the balance below zero. A refusal returns no corrections at all: a
 * partial rewrite of a balance chain is worse than none, because half a chain looks
 * exactly like a whole one.
 */
export function rechain(anchorBalanceCents: number, entries: ChainEntry[]): RechainResult {
  const empty = (refusal: string): RechainResult =>
    ({ corrections: [], finalBalanceCents: anchorBalanceCents, refusal })

  if (!Number.isInteger(anchorBalanceCents)) return empty('anchor balance is not integer cents')

  let prevDate = ''
  for (const e of entries) {
    if (!Number.isInteger(e.paydownCents) || !Number.isInteger(e.storedBalanceCents)) {
      return empty(`entry ${e.date} carries non-integer cents`)
    }
    if (e.paydownCents < 0) {
      return empty(`entry ${e.date} has a negative paydown (${e.paydownCents}c) -- a repayment cannot increase the balance`)
    }
    if (prevDate && e.date <= prevDate) {
      return empty(`entries are not strictly ascending by date (${prevDate} then ${e.date})`)
    }
    prevDate = e.date
  }

  const corrections: Correction[] = []
  let running = anchorBalanceCents
  for (const e of entries) {
    running -= e.paydownCents
    if (running < 0) {
      return empty(`walk drives the balance below zero at ${e.date}`)
    }
    if (running !== e.storedBalanceCents) {
      corrections.push({ date: e.date, fromCents: e.storedBalanceCents, toCents: running })
    }
  }

  return { corrections, finalBalanceCents: running, refusal: null }
}

/** Cents from a numeric/string dollar amount, without ever touching a float. */
export function toCents(v: number | string): number {
  const s = String(v).trim()
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/)
  if (!m) return NaN
  const sign = m[1] === '-' ? -1 : 1
  const frac = (m[3] ?? '').padEnd(2, '0')
  return sign * (parseInt(m[2], 10) * 100 + parseInt(frac, 10))
}

export const fromCents = (c: number): number => Math.round(c) / 100
