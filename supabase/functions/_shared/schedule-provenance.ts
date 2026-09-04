// ─────────────────────────────────────────────────────────────────────────────
// schedule-provenance.ts — is this amortization schedule the LENDER'S document,
// or our own arithmetic?
//
// Session 268. Extracted because `loan-xero-post` asked the question with a
// DENYLIST — `amort_type.startsWith('derived_')` — and a denylist fails OPEN.
// The client (`admin-dashboard/index.html`, `_REAL_SCHEDULE_SOURCES` /
// `_SCHEDULE_AMORT_TYPES`) had already been through this exact mistake and come
// out the other side as an allowlist; the server had not. This module is the
// one the server now reads, and the client's copy is asserted against it by
// `tests/schedule-provenance.test.mts` — a no-build SPA cannot import from the
// functions tree, so the copy is unavoidable and the assertion is the price.
//
// WHAT THE DENYLIST MISSED, MEASURED 2026-09-04 (not assumed):
//   PayPal A00845102 — source 'claude_assisted_parse',
//                      amort_type 'actual_payment_history_from_lender_csv',
//                      prestage_enabled, schedule anchored 2026-08-04,
//                      newest lender statement 2026-09-02.
// That amort_type does not begin with 'derived_', so the staleness guard was
// SKIPPED on the one prestaging loan whose schedule is most obviously a
// projection: it is a parse of the lender's payment HISTORY with everything
// past the parse date projected forward (Tech Debt #33). The 2026-09-02 stage
// carried the projection's 3180.34/234.37 against the lender's own
// 3180.33/234.38. A penny, staged into Xero, by exactly this hole.
//
// Every other prestaging schedule keeps the verdict it has today: the eleven
// `derived_*` rows were already caught, and PCV / Verdant / Dexter 2 remain
// exempt because they are genuine contractual documents.
// ─────────────────────────────────────────────────────────────────────────────

// HOW the file was read. Allowlist: a source nobody has looked at is not a
// lender speaking. Same discipline, same direction as REAL_ANCHOR_SOURCES.
export const REAL_SCHEDULE_SOURCES = ['claude_assisted_parse', 'client_parsed_verified'] as const

// WHAT the file IS. `source` says how it was parsed; it does not say whether the
// artefact is a contractual schedule. A payment history parses the same way and
// is a record of the past, not a promise about the future.
export const SCHEDULE_AMORT_TYPES = ['amortization_schedule'] as const

export type ScheduleProvenanceRow = {
  source?: string | null
  amort_type?: string | null
} | null | undefined

/**
 * True only when this row is the LENDER'S OWN contractual amortization
 * schedule — a document they issued, parsed by a path a person has vetted.
 *
 * Null/undefined is FALSE. A schedule we could not read is not a schedule we
 * may trust: unknown provenance is not permission.
 */
export function isContractualSchedule(sched: ScheduleProvenanceRow): boolean {
  if (!sched) return false
  const source = String(sched.source ?? '')
  const amortType = String(sched.amort_type ?? '')
  return (REAL_SCHEDULE_SOURCES as readonly string[]).includes(source)
    && (SCHEDULE_AMORT_TYPES as readonly string[]).includes(amortType)
}

/**
 * True when this schedule's future rows are a PROJECTION and can therefore be
 * invalidated by a lender statement arriving after its anchor.
 *
 * The inverse of `isContractualSchedule`, named separately because that is the
 * question the staging staleness guard actually asks, and a caller writing
 * `!isContractualSchedule(x)` is one missing `!` away from failing open again.
 */
export function scheduleGoesStale(sched: ScheduleProvenanceRow): boolean {
  return !isContractualSchedule(sched)
}
