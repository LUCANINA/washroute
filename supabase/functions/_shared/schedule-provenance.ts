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

// ─────────────────────────────────────────────────────────────────────────────
// SESSION 293 — DAVID'S RULE: "staging only applies to Loans with amortization
// schedules", and an amortization schedule means one the LENDER ISSUED.
//
// The predicate above already asked exactly this question. It was wired to a
// STALENESS check and not to PERMISSION, which is session 231's shape once more:
// right logic, one branch away from the thing that needed it. Until now the
// permission was `loan_accounts.prestage_enabled`, a boolean nobody had to
// justify — and `loan-ingest-amortization` and `loan-derive-schedule` both
// SET it automatically, so deriving a schedule from a loan's own statements
// granted that loan permission to write forecasts of our own arithmetic into
// the ledger. Measured 2026-09-14: eleven loans carried the flag and only three
// had a schedule the lender had sent.
//
// WHY IT IS THE RIGHT LINE, and it is §246's rule applied to a forecast rather
// than to a balance. A staged transaction is a real entry in Xero made BEFORE
// the money moves, on the strength of a document. When the document is the
// lender's own schedule, the forecast is THEIR figure and the bank feed is a
// genuine outside check of it. When we derived the schedule from the same
// statements our books are built on, the forecast and the thing it will be
// matched against come from one source, and the match can only ever confirm our
// own arithmetic back to us.
//
// THE EVIDENCE, measured the same day. All three contract-schedule loans
// completed clean stage → match → post round trips (233, 254, 394). Every stuck
// stage was a derived one: 243 carried a live duplicate in Xero for six days,
// 332 sat two days past its date unmatched, 244's waiting split still pointed at
// a schedule whose payment day had since been re-measured from the 20th to the
// 9th. The failure mode is not a wrong number, it is a transaction in the
// general ledger that nothing outside our own records asked for.
//
// ⚠️ THE FLAG IS NOW NECESSARY BUT NOT SUFFICIENT. Do not restore a path where
// `prestage_enabled` alone can stage. It is a switch a person can turn on; this
// is the reason they are allowed to.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May a split built on this schedule create a pre-staged transaction in Xero?
 *
 * The rule is `isContractualSchedule` and nothing else — the separate name
 * exists so a grep for the STAGING rule finds every place it is enforced, and so
 * a future change to one question cannot silently move the other.
 *
 * Null/undefined is FALSE, for the same reason as above: a schedule we could not
 * read is not permission to write to the ledger.
 */
export function mayPrestage(sched: ScheduleProvenanceRow): boolean {
  return isContractualSchedule(sched)
}

/**
 * The sentence a person reads when staging is refused. It names what we hold
 * rather than only what is missing (§262: ask for the document, don't assert a
 * gap), and it says plainly that the ordinary route still works — the refusal
 * costs a click, not the month's close.
 */
export function prestageRefusal(sched: ScheduleProvenanceRow): string {
  const amortType = String(sched?.amort_type ?? '')
  const what = !sched
    ? 'this loan has no readable amortization schedule'
    : amortType === 'actual_payment_history_from_lender_csv'
      ? 'this loan\'s schedule is a parse of the lender\'s payment HISTORY, with everything after the parse date projected forward by us'
      : String(sched?.source ?? '') === 'derived_from_statements'
        ? 'this loan\'s schedule was derived by us from its own statements, not issued by the lender'
        : `this loan's schedule is recorded as ${amortType || 'an unrecognised type'} from ${String(sched?.source ?? 'an unrecognised source')}, which nobody has confirmed is the lender's own document`
  return `Pre-staging is only for loans with the lender's own amortization schedule, and ${what}. `
    + 'Nothing is blocked: split this period the normal way once the payment reaches the bank feed. '
    + 'If the lender does issue a schedule, upload it and staging becomes available again.'
}
