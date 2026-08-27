// _shared/portal-figures.ts — the control totals printed on a lender's own screen.
//
// WHY THIS IS ITS OWN FILE
// Two things happen to a figure transcribed off a screenshot before anything is
// allowed to rest on it: it is checked against the other figures on ITS OWN
// screen (checkPortalTotals), and it is reconciled against what a DIFFERENT
// screenshot said about the same thing (mergePortal). Both are pure arithmetic
// over a small record, both decide whether a number is evidence or noise, and
// neither was testable while it sat inside an edge function next to storage
// uploads and a vision-model call.
//
// It was extracted the day a bug got through both of them in production: a loan
// screen and a deposit screen were uploaded together, both stated an "amount
// remaining", they disagreed by $1,908.34, and the merge silently kept the wrong
// one. The plan then told David the lender wanted $125,000.00 back when the
// lender's own screen said $123,091.66. mergePortal's own comment carries the rest.

export interface PortalTotals {
  as_of: string | null
  amount_remaining: number | null
  paid_to_date: number | null
  principal_paid: number | null
  fee_paid: number | null
  total_amount_due: number | null
  funds_deposited: number | null
  funds_deposited_date: string | null
  /** Which screenshot(s) these figures came from. Needed to say WHO disagreed. */
  sources: string[]
  /** Figures dropped because the screen failed ITS OWN arithmetic. */
  warnings: string[]
  /** Figures dropped because two SCREENS contradicted each other. A different
   *  kind of problem with a different remedy, so it is reported separately
   *  rather than filed under "this screen does not add up". */
  disputes: string[]
  checks: string[]
}

/**
 * Arithmetic-check a transcribed screenshot against ITSELF before trusting it.
 *
 * A model reading a picture is the least reliable input this system has, so a
 * figure off a screenshot only earns its place by participating in a sum that
 * comes out right. Two identities the lender's own screen must satisfy:
 *
 *     principal paid + fee paid = paid to date
 *     total due − paid to date  = amount remaining
 *
 * A number that fails one of these is dropped, not corrected. Session 242's
 * screenshots passed both to the cent, which is the only reason their figures
 * were allowed to establish the loan's carrying basis.
 */
export function checkPortalTotals(p: PortalTotals): PortalTotals {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.02
  const checks: string[] = []
  const warnings: string[] = []
  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (p.principal_paid !== null && p.fee_paid !== null && p.paid_to_date !== null) {
    if (near(p.principal_paid + p.fee_paid, p.paid_to_date)) {
      checks.push(`The screen's own parts add up: ${fmt(p.principal_paid)} financing + ${fmt(p.fee_paid)} fee = ${fmt(p.paid_to_date)} paid.`)
    } else {
      warnings.push(`The screen's parts do not add up (${fmt(p.principal_paid)} + ${fmt(p.fee_paid)} ≠ ${fmt(p.paid_to_date)}), so these three figures were dropped rather than used.`)
      p.principal_paid = p.fee_paid = p.paid_to_date = null
    }
  }
  if (p.total_amount_due !== null && p.paid_to_date !== null && p.amount_remaining !== null) {
    if (near(p.total_amount_due - p.paid_to_date, p.amount_remaining)) {
      checks.push(`The remaining balance ties to the total: ${fmt(p.total_amount_due)} − ${fmt(p.paid_to_date)} = ${fmt(p.amount_remaining)}.`)
    } else {
      warnings.push(`The remaining balance does not tie to the total less what is paid (${fmt(p.total_amount_due)} − ${fmt(p.paid_to_date)} ≠ ${fmt(p.amount_remaining)}), so the remaining balance was dropped.`)
      p.amount_remaining = null
    }
  }
  return { ...p, checks, warnings, disputes: p.disputes ?? [] }
}

/**
 * Combine the figures from two screenshots of the same loan.
 *
 * WHY THIS IS NOT A FIRST-NON-NULL PICK (session 242, found live)
 * It used to be. David uploaded a loan-details screen and a deposit screen
 * together, and the plan reported the lender's remaining balance as $125,000.00
 * — the FUNDING amount off the deposit screen — instead of $123,091.66. Both
 * screenshots stated an "amount remaining"; they disagreed by $1,908.34; the
 * merge kept whichever arrived first and threw the other away without a word.
 *
 * That is the one thing this whole module exists to not do. Reading documents
 * together is only worth anything if a disagreement between them SURVIVES the
 * reading. So:
 *
 *   * two screens agreeing on a figure  -> keep it, and say they agree (that is
 *     genuine corroboration, and the plan should show it)
 *   * two screens disagreeing           -> DROP the figure and say so, naming
 *     both files and both numbers. A figure two documents contradict is not
 *     evidence of anything, and choosing between them is a guess.
 *   * one screen silent                 -> take the other's value, as before
 *
 * Dropping is deliberately the outcome rather than "prefer the higher/later/
 * more-precise one". Every such rule is a tie-break dressed up as reasoning, and
 * this module's job when the documents do not settle a question is to hand the
 * question back, not to answer it.
 */
export function mergePortal(a: PortalTotals, b: PortalTotals): PortalTotals {
  const checks = [...a.checks, ...b.checks]
  const warnings = [...a.warnings, ...b.warnings]
  const disputes = [...(a.disputes ?? []), ...(b.disputes ?? [])]
  const who = (p: PortalTotals) => p.sources.length ? p.sources.join(' + ') : 'another screenshot'
  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const LABEL: Record<string, string> = {
    amount_remaining: 'the balance still owed',
    paid_to_date: 'the amount paid to date',
    principal_paid: 'the financing paid',
    fee_paid: 'the fee paid',
    total_amount_due: 'the total amount due',
    funds_deposited: 'the amount deposited',
  }

  const num = (k: keyof PortalTotals): number | null => {
    const av = a[k] as number | null, bv = b[k] as number | null
    if (av === null || av === undefined) return (bv ?? null)
    if (bv === null || bv === undefined) return av
    if (Math.abs(av - bv) <= 0.02) {
      checks.push(`Two of the lender's own screens agree on ${LABEL[k as string]}: ${fmt(av)}.`)
      return av
    }
    disputes.push(
      `Two screenshots disagree about ${LABEL[k as string]} — ${who(a)} shows ${fmt(av)}, ` +
      `${who(b)} shows ${fmt(bv)}. The figure was dropped rather than picking one, so nothing ` +
      `below rests on it. Re-upload the single screen that states the balance you want used.`)
    return null
  }

  // Dates. Two screens pulled at different times legitimately carry different
  // "as of" dates — that is not an error, but it does mean the merged figures
  // describe two moments, which the person approving deserves to be told.
  let as_of = a.as_of ?? b.as_of
  if (a.as_of && b.as_of && a.as_of !== b.as_of) {
    as_of = a.as_of > b.as_of ? a.as_of : b.as_of
    disputes.push(
      `These screenshots were taken on different days (${a.as_of} and ${b.as_of}), so their ` +
      `figures describe two different moments. The later date (${as_of}) was used.`)
  }
  let funds_deposited_date = a.funds_deposited_date ?? b.funds_deposited_date
  if (a.funds_deposited_date && b.funds_deposited_date && a.funds_deposited_date !== b.funds_deposited_date) {
    disputes.push(
      `Two screenshots give different deposit dates (${a.funds_deposited_date} and ` +
      `${b.funds_deposited_date}); the date was dropped rather than picking one.`)
    funds_deposited_date = null
  }

  return {
    as_of,
    amount_remaining: num('amount_remaining'),
    paid_to_date: num('paid_to_date'),
    principal_paid: num('principal_paid'),
    fee_paid: num('fee_paid'),
    total_amount_due: num('total_amount_due'),
    funds_deposited: num('funds_deposited'),
    funds_deposited_date,
    sources: [...a.sources, ...b.sources],
    checks, warnings, disputes,
  }
}
