// derive-cause.ts — session 289
// =============================================================================
// Its own module for the same reason diagnose-exception.ts is: the reasoning
// here is the part that was WRONG on the first cut, and reasoning that cannot be
// called from a test is reasoning nothing checks. index.ts cannot be imported by
// the Node suite (it pulls Deno's https: imports at the top level), so anything
// worth pinning has to live outside it. This file has no imports at all.
// =============================================================================

const TOL = 0.02
const r2 = (n: number) => Math.round(n * 100) / 100
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ═══════════════════════════════════════════════════════════════════════════
// THE CAUSE WE CAN MEASURE (session 289 cont.)
// ═══════════════════════════════════════════════════════════════════════════
//
// David, on the sentence a human had typed into EIDL's balance_note — "No
// principal was repaid either month, so it's a fee or capitalised interest":
// "As far as I can tell, that is a fact. What am I missing?"
//
// Nothing. It is a fact, and it is OURS. `loan_splits` carries nine rows for
// that loan reading `principal 0 / interest 4791`, month after month. A person
// sat and transcribed, into prose, a claim the database could already make.
//
// That is not merely redundant, it is WEAKER. A typed fact is never evidence
// (s230): it does not re-derive when a statement is re-ingested, nothing checks
// it, and it rots exactly the way s247 describes — the number moves, the
// sentence beside it keeps saying the old thing, and the CPA reads the sentence.
// Measured, the same claim is recomputed on every walk and dies the moment it
// stops being true.
//
// ⚠️ WHAT THIS IS AND IS NOT. It names the KIND of thing the increase is. It
// says nothing about whether the AMOUNT is right — the derivation reads
// identically at $5.00 and at $5,000.00 — so it is evidence on the card and
// never, on its own, a licence to post. The entry stays gated on a human's
// attestation for exactly that reason; see buildRecordedCauseEntry.
//
// ⚠️ AND IT IS OUR BOOKS AGREEING WITH OUR BOOKS. The splits are our record of
// what the lender applied, not the lender's. §246's rule — a check whose inputs
// share a source cannot fail — applies to EVIDENCE too, so the sentence says
// where it came from, and capturing `Applied to Principal` off the statement
// (Tech Debt #46's leftover) is what will one day give this an outside witness.
// Until then it is stated as ours, which is honest, rather than as the lender's,
// which would not be.
export function deriveIncreaseCause(o: {
  splits: any[], headline: any, winFrom: string, residual: number | null,
}): { sentence: string, working: string, months: number, covers_event: boolean } | null {
  const { splits, headline, winFrom, residual } = o
  const diff = headline?.difference == null ? null : r2(Number(headline.difference))
  // Only an INCREASE has this explanation. Our books BELOW the lender means the
  // lender added something we never booked. The mirror case (our books above)
  // is an over-payment or a missing charge and is a different question entirely.
  if (diff == null || diff >= -TOL) return null

  const fromMonth = String(winFrom || '').slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(fromMonth)) return null
  // period_label is 'YYYY-MM' on monthly loans and 'YYYY-MM-DD' where a month
  // carries several drafts (staging-next.ts). Both start with the month, and
  // anything that does not is not a dated period and cannot be placed.
  const inWindow = splits
    .filter((sp: any) => {
      const m = String(sp.period_label || '').slice(0, 7)
      return /^\d{4}-\d{2}$/.test(m) && m >= fromMonth
    })
    .sort((a: any, b: any) => String(a.period_label).localeCompare(String(b.period_label)))
  // Two is the minimum that makes "no principal in any of them" a pattern
  // rather than one month's arithmetic.
  if (inWindow.length < 2) return null
  const allInterestOnly = inWindow.every((sp: any) =>
    Math.abs(Number(sp.principal_amount ?? 0)) < 0.01 && Math.abs(Number(sp.interest_amount ?? 0)) >= 0.01)
  if (!allInterestOnly) return null

  const months = inWindow.length
  const first = String(inWindow[0].period_label).slice(0, 7)
  const last = String(inWindow[months - 1].period_label).slice(0, 7)

  // ⚠️ THE MONTHS WE EXAMINED ARE NAMED, NOT THE WINDOW WE MEANT TO EXAMINE.
  //
  // The first cut of this said "in any of the N payments since <winFrom>", and
  // on the loan it was written for that was FALSE in a way no figure would have
  // shown: the walk's window opens 2026-04 and the payments on file run
  // 2026-07 → 2026-09, so it claimed to have checked three months it had never
  // looked at. "A wrong word beside a right number is the harder mistake to
  // catch" (s247) -- so the sentence names the range it actually read.
  //
  // ⚠️ AND THE INFERENCE IS NOT CLAIMED OVER MONTHS WE DID NOT READ.
  //
  // A RESIDUAL is, by definition, a difference that arose before the earliest
  // usable statement -- so on exactly the loan this was built for, the $5.00
  // appeared in April and the payments we can see start in July. Writing "a
  // balance that rose did so through a fee" would have been an inference about
  // months outside the evidence, which is §246's failure wearing a new coat.
  //
  // So there are two sentences and they are different KINDS of claim: what we
  // measured, and the general rule it supports. When the difference predates the
  // evidence the card says so plainly, which also happens to be the honest
  // ground for asking for the earlier statements (§262).
  const coversEvent = !(residual != null && Math.abs(residual) >= TOL)
  const observed = `The ${months} payments on file from ${first} to ${last} apply $0.00 to principal — every one goes entirely to interest.`
  const rule = coversEvent
    ? `A balance that rose while no principal was being applied did so through a fee or capitalised interest, not through a repayment.`
    : `Where no principal is being applied, a rise in the balance is a fee or capitalised interest rather than a missed repayment — though this difference predates ${fromMonth}, so those months are not among the ones read here.`

  return {
    months,
    covers_event: coversEvent,
    sentence: `${observed} ${rule}`,
    working: `From our own payment records, not the lender's: `
      + inWindow.map((sp: any) => `${sp.period_label} ${money(Number(sp.principal_amount ?? 0))} principal / ${money(Number(sp.interest_amount ?? 0))} interest`).join('; ')
      + `. The statement's own "Applied to Principal" line is not captured yet, so this is our books describing themselves — corroborating it against the lender's own figure is Tech Debt #46's leftover.`,
  }
}
