// ═══════════════════════════════════════════════════════════════════════════
// split-pair.ts — MAY THIS PAIR OF STATEMENTS DEFINE A PERIOD'S SPLIT?
// (session 290, from David's "what's keeping us from proposing a fix?")
// ═══════════════════════════════════════════════════════════════════════════
// Extracted rather than left inline for the reason derive-schedule.ts says in
// its own header: a rule buried in a function that talks to Supabase on every
// path cannot be tested, and an untested rule about money is a rule waiting to
// be wrong. This one was wrong for five months.
//
// ── WHAT HAPPENED ──────────────────────────────────────────────────────────
// Funding Circle's 2026-08 split was built from prior = the 2026-07-01
// statement and current = the 2026-08-03 one. Both report $66,215.03, because
// they are the SAME PDF — identical bytes, the July statement re-dated. A
// person had established that months earlier and written it into
// `anchor_exclusion_reason`.
//
// With no measurable movement between them, the explicit-split branch fell back
// to the document's own stated breakdown — July's, $1,025.71 / $1,008.06 — and
// filed it as AUGUST. The lender applied $1,041.09 that month. The $15.38
// difference is what David clicked on, and the same shape had been running every
// month: 14.72, 14.92, 15.14, 15.38, growing because the principal portion of an
// amortising loan grows.
//
// ── THE GUARD EXISTED ONE BRANCH AWAY (session 231, third time on this row) ──
// The statement_delta branch has refused this shape since s231 — "The balance did
// not fall between X and Y (both $…)" — because it COMPUTES from the delta and a
// zero delta is visible to it. The explicit branch never computes a delta, so it
// never noticed there was not one.
//
// ⚠️ TWO OBJECTIONS, AND THE ORDER MATTERS. The human's exclusion is the more
// specific claim and names a document a person actually opened, so it is
// reported first. But the SAME-PAIR test is the more valuable one, because it
// needs nobody to have noticed anything: it would have fired in April, months
// before the note was written. Never drop it in favour of the exclusion field.
//
// Pure: no Supabase, no Xero, no Deno.env. Everything it needs is passed in.

export type StatementRow = {
  statement_date?: string | null
  principal_balance?: number | string | null
  file_sha256?: string | null
  anchor_exclusion_reason?: string | null
}

/** A cent of rounding is not a movement, and is not a reason to refuse either. */
export const SAME_BALANCE_TOL = 0.005

export type PairObjection = {
  /** 'excluded' — a person ruled a document out. 'unmeasurable' — the pair cannot move. */
  kind: 'excluded' | 'unmeasurable'
  /** The sentence, in words a bookkeeper reads, with no leading capital. */
  why: string
}

/**
 * Why this pair may not define `periodLabel`'s split, or null when it may.
 *
 * Returns at most one objection because the review note has one subject. When
 * both apply the exclusion wins the sentence — it names a document and a person
 * — but `unmeasurable` is still what would have caught it unaided, so
 * `bothApply` is reported for anything that wants to know.
 */
export function splitPairObjection(
  prior: StatementRow | null | undefined,
  current: StatementRow | null | undefined,
): (PairObjection & { bothApply: boolean }) | null {
  const cur = current || null
  const pri = prior || null

  const excludedWhy =
    cur?.anchor_exclusion_reason
      ? `this statement is one a person ruled out as a balance anchor`
      : pri?.anchor_exclusion_reason
        ? `the statement this period is measured against (${pri.statement_date ?? 'an earlier one'}) is one a person ruled out as a balance anchor`
        : null

  // ⚠️ SAME BYTES IS TESTED BEFORE SAME BALANCE, and both are kept. Identical
  // files are a certainty; identical balances are a symptom that a legitimate
  // interest-only or fee-only month can also produce. The sentence a reader gets
  // should say which of the two it is, because those are different conversations.
  const sameDoc = !!(pri?.file_sha256 && cur?.file_sha256 && pri.file_sha256 === cur.file_sha256)
  const sameBalance = !sameDoc && pri?.principal_balance != null && cur?.principal_balance != null
    && Math.abs(Number(pri.principal_balance) - Number(cur.principal_balance)) < SAME_BALANCE_TOL

  const unmeasurableWhy = sameDoc
    ? `${pri?.statement_date ?? 'the prior statement'} and ${cur?.statement_date ?? 'this one'} are the SAME DOCUMENT (identical file contents), so no balance moved between them`
    : sameBalance
      ? `${pri?.statement_date ?? 'the prior statement'} and ${cur?.statement_date ?? 'this one'} both report $${Number(cur?.principal_balance).toFixed(2)}, so no balance moved between them`
      : null

  const bothApply = !!excludedWhy && !!unmeasurableWhy
  if (excludedWhy) return { kind: 'excluded', why: excludedWhy, bothApply }
  if (unmeasurableWhy) return { kind: 'unmeasurable', why: unmeasurableWhy, bothApply }
  return null
}

/** The review note a refused pair carries, so both call sites word it identically. */
export function splitPairNote(o: PairObjection, periodLabel: string): string {
  if (o.kind === 'excluded') {
    return `NOT ACCEPTED as ${periodLabel}'s split: ${o.why}. `
      + `The figures below are the document's own stated breakdown and are recorded only so this period is not silently empty. `
      + `Find the statement that genuinely covers ${periodLabel} and re-ingest it, or record what this difference is on the loan.`
  }
  return `NOT ACCEPTED as ${periodLabel}'s split: ${o.why} — so this period has no measured principal movement, and the breakdown below is whatever that document states about ITS OWN period, not this one. `
    + `On Funding Circle this exact shape booked July's $1,025.71 as August and left the books $15.38 behind the lender, every month, growing. `
    + `Upload the statement that covers ${periodLabel} before approving anything here.`
}
