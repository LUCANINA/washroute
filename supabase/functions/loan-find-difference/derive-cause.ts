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
// ⚠️ WHICH ROWS ARE THE LENDER SPEAKING, AND WHICH ARE OUR OWN ARITHMETIC.
//
// `loan_splits.source` is the whole of this distinction and the first cut ignored
// it, which made the sentence's provenance clause simply false.
//
//   explicit_split      the lender's own "Applied to Principal / Applied to
//                       Interest" line, verbatim (loan-ingest-statement v21).
//                       This IS the outside witness.
//   statement_delta     OUR arithmetic: principal = the balance delta. On a
//                       question about why a BALANCE moved, "principal = 0"
//                       here means only "the balance did not move" -- it is the
//                       conclusion restated as its own evidence, which is §246
//                       exactly. Not merely weaker: uninformative.
//   amortization_schedule  our schedule, and on most of this book a schedule we
//                       DERIVED from statements. Ours.
//
// So only lender-stated rows can carry the claim. The others are named in the
// working and explicitly discounted, because a reader who sees three months on
// the loan and two in the sentence deserves to know which one dropped out and
// why (nothing is deleted -- ce17).
const LENDER_STATED = ['explicit_split']

// ── WHEN DID IT APPEAR? BRACKET IT BETWEEN TWO DOCUMENTS (session 289) ──────
//
// David: "a simple walk through the statements reveals exactly when the lender
// added those $5. That would be good information to share."
//
// He is right, and the reason the card could not say it is worth writing down.
// The 2026-04-25 statement reads $960,000.00 and the 2026-05-25 one reads
// $960,005.00 — the whole answer, sitting in two rows we hold. But the April
// document carries no `balance_as_of`, so on a due_date lender it is REFUSED as
// an anchor: its balance cannot be placed in time, and the walk never sees it.
// The card was left saying the difference "predates the earliest usable
// statement", which is an apology for not knowing something the documents state.
//
// ⚠️ REFUSED AS AN ANCHOR IS NOT THE SAME AS UNUSABLE AS EVIDENCE, and that
// distinction is the whole function. We cannot say WHAT DAY the balance changed
// — that is exactly what the refusal protects, and inventing one would be §0zo's
// bug inverted. We CAN say it changed between two documents, because a filed
// date is a fact printed on the page. So the sentence names FILED dates and the
// word "between", and never a balance date.
//
// The bracket is claimed only when there is EXACTLY ONE transition to the
// current balance. Two transitions mean the balance moved more than once and a
// single bracket would be a tidier story than the truth.
const LENDER_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']

export function bracketIncrease(o: {
  statements: any[], lenderBalance: number | null,
}): { fromFiled: string, fromBalance: number, toFiled: string, toBalance: number } | null {
  const { statements, lenderBalance } = o
  if (lenderBalance == null) return null
  // The lender speaking, and nothing else: `xero_derived` rows are OUR record of
  // a balance and would make this a check on ourselves (§246).
  const rows = (statements || [])
    .filter((s: any) => s.balance_basis === 'principal_only'
      && s.principal_balance != null
      && LENDER_SOURCES.includes(String(s.source || '')))
    .map((s: any) => ({ filed: String(s.statement_date), bal: r2(Number(s.principal_balance)) }))
    .sort((a, b) => a.filed < b.filed ? -1 : a.filed > b.filed ? 1 : 0)
  if (rows.length < 2) return null

  const target = r2(lenderBalance)
  // ⚠️ IF THE EARLIEST DOCUMENT ALREADY READS THE TARGET, WE NEVER SAW IT
  // APPEAR. Caught by the "reached this figure twice" test, which the
  // transition scan alone let through: 960,005 → 960,000 → 960,005 has exactly
  // one upward transition, and bracketing it would report the balance
  // RETURNING to a figure as the moment it arrived at one. The balance already
  // being there before our earliest statement is the same failure in its
  // simplest form, so both are refused here.
  if (Math.abs(rows[0].bal - target) < TOL) return null
  const transitions: { from: typeof rows[0], to: typeof rows[0] }[] = []
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i].bal - target) < TOL && Math.abs(rows[i - 1].bal - target) >= TOL) {
      transitions.push({ from: rows[i - 1], to: rows[i] })
    }
  }
  // Exactly one, or we say nothing: a balance that reached this figure twice has
  // a history, not a moment, and a single bracket would flatter it.
  if (transitions.length !== 1) return null
  const t = transitions[0]
  return { fromFiled: t.from.filed, fromBalance: t.from.bal, toFiled: t.to.filed, toBalance: t.to.bal }
}

export function deriveIncreaseCause(o: {
  splits: any[], headline: any, winFrom: string, residual: number | null,
  statements?: any[], lenderBalance?: number | null,
}): { sentence: string, working: string, months: number, covers_event: boolean, bracket: any } | null {
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
  const stated = inWindow.filter((sp: any) => LENDER_STATED.includes(String(sp.source || '')))
  const ours = inWindow.filter((sp: any) => !LENDER_STATED.includes(String(sp.source || '')))
  // Two is the minimum that makes "no principal in any of them" a pattern rather
  // than one month's arithmetic -- and they must be two the LENDER stated. With
  // fewer, the honest answer is that we cannot say, which leaves the ask for the
  // documents standing (§262) instead of dressing our own arithmetic as evidence.
  if (stated.length < 2) return null
  const allInterestOnly = stated.every((sp: any) =>
    Math.abs(Number(sp.principal_amount ?? 0)) < 0.01 && Math.abs(Number(sp.interest_amount ?? 0)) >= 0.01)
  if (!allInterestOnly) return null

  const months = stated.length
  const first = String(stated[0].period_label).slice(0, 7)
  const last = String(stated[months - 1].period_label).slice(0, 7)

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
  // ⚠️ A BRACKET FROM THE DOCUMENTS OUTRANKS AN APOLOGY FOR NOT HAVING ONE.
  // Where two statements we hold straddle the change, WHEN it appeared stops
  // being an open question and the hedge about unread months has nothing left to
  // do — so it is replaced rather than stacked beside the answer (§279).
  const bracket = bracketIncrease({ statements: o.statements || [], lenderBalance: o.lenderBalance ?? null })
  const coversEvent = !(residual != null && Math.abs(residual) >= TOL)
  // ⚠️ THE FIGURE LEADS. David: "there's no mention of the $5 in the opening
  // paragraph when that's the only relevant piece of information we need."
  //
  // He is right and it was a real defect, not a style note. This function was
  // written as an observation ABOUT SPLITS and it never said what the difference
  // IS -- a reader got three clauses of evidence for a number the sentence never
  // named. The lead states the amount and the direction; the evidence follows
  // and explains it. §279's exemption covers this exactly: the decision's own
  // figure may appear in the lead AND on the journal it writes.
  // ⚠️ THE BRACKET IS DATA, NOT PROSE. David pointed at the mockup: it puts the
  // two documents on ONE MONO LINE — `04/25/26 stmt 960,000.00 → 05/25/26 stmt
  // 960,005.00` — under the paragraph, not inside it. That is the right call and
  // not only a shorter one: two dates and two figures are a comparison, and a
  // comparison is read faster in columns than in a sentence. So `bracket` ships
  // structured and the CARD draws it; the prose never mentions those figures,
  // which also keeps them stated once (§279).
  const led = `The lender added ${money(Math.abs(diff))} to the balance that our books have not booked.`
  const observed = months === 1
    ? `Its own statement for ${first} applies $0.00 to principal — all of it goes to interest.`
    : `Its own statements from ${first} to ${last} apply $0.00 to principal — every one of the ${months} goes entirely to interest.`
  // With the change located between two documents, the hedge about unread months
  // has nothing left to do — it was an apology for not knowing WHEN, and now the
  // card says when. Replaced, not stacked beside the answer.
  const rule = (coversEvent || bracket)
    ? `A balance that rose while no principal was being applied did so through a fee or capitalised interest, not through a repayment.`
    : `Where no principal is being applied, a rise in the balance is a fee or capitalised interest rather than a missed repayment — though this difference predates ${fromMonth}, so those months are not among the ones read here.`

  return {
    months,
    covers_event: coversEvent,
    bracket,
    sentence: [led, observed, rule].join(' '),
    working: `Stated by the lender (its own "Applied to Principal" line, captured verbatim at ingest): `
      + stated.map((sp: any) => `${sp.period_label} ${money(Number(sp.principal_amount ?? 0))} principal / ${money(Number(sp.interest_amount ?? 0))} interest`).join('; ')
      + `.`
      + (ours.length
        ? ` Not counted, because these are our own figures rather than the lender's: `
          + ours.map((sp: any) => `${sp.period_label} (${String(sp.source || 'unknown').replace(/_/g, ' ')}) ${money(Number(sp.principal_amount ?? 0))} principal`).join('; ')
          + `. On a statement_delta row the principal IS the balance delta, so "$0.00 principal" there says only that the balance did not move — which is the question, not an answer to it.`
        : ''),
  }
}
