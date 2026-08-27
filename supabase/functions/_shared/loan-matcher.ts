// _shared/loan-matcher.ts — which loan do these documents belong to?
//
// WHY THIS IS ITS OWN FILE
// David, on the first live bundle: "the engine doesn't automatically recognize
// these are belonging to Stripe without my input." It didn't, and the reason was
// narrow: the old matcher compared the account reference printed on the document
// against loan_accounts.lender_account_number and gave up when they disagreed.
// For Stripe Capital they always disagree — the agreement names
// `acct_1MPrRD...` while the loan record stores the string 'STRIPE-CAPITAL'.
//
// The replacement is a RANKED matcher, and it lives here rather than inside
// planBundle because of what it decides: which loan four documents get filed
// against. That is worth testing directly, and a matcher tangled up with HTTP
// handling and storage uploads cannot be. Everything below is pure — the one
// piece of I/O the ranking needs (references learned from earlier documents) is
// fetched by the caller and passed in.
//
// THE RULE THAT MATTERS MOST
// Every rung must resolve to exactly ONE active loan or it is discarded. A rung
// that narrows four Ford loans to two has not identified anything, and choosing
// between them is precisely the guess this module refuses to make. Discarding
// costs one question to a human; guessing costs a document filed against the
// wrong loan, which nobody goes looking for.

export type MatchableLoan = {
  id: string
  status?: string | null
  lender?: string | null
  xero_account_name?: string | null
  lender_account_number?: string | null
  original_amount?: number | string | null
}

export type MatchInput = {
  loans: MatchableLoan[]
  /** The account reference printed on the documents, if any. */
  acctRef?: string | null
  /** Lenders a PARSER recognised by name (not a string scraped off the page). */
  lenderHints?: Iterable<string>
  /** loan ids that already carry `acctRef` as a lender_account_ref contract term. */
  learnedRefLoanIds?: string[]
  /** The Loan Amount the agreement stated, used only to strengthen the wording. */
  agreementLoanAmount?: number | null
}

export type MatchResult = {
  loan: MatchableLoan | null
  /** Plain-English account of HOW, for the human approving the plan. null when unmatched. */
  matchedOn: string | null
  /** Which rung fired. 'account_number' | 'learned_ref' | 'lender_name' | null */
  rung: 'account_number' | 'learned_ref' | 'lender_name' | null
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
const only = <T>(rows: T[]): T | null => (rows.length === 1 ? rows[0] : null)

export function matchLoan(input: MatchInput): MatchResult {
  const active = (input.loans || []).filter(l => l.status === 'active')
  const acctRef = (input.acctRef || '').trim() || null
  const none: MatchResult = { loan: null, matchedOn: null, rung: null }
  if (!active.length) return none

  // ── 1. The account number, exactly as the document states it ───────────────
  // Exact equality only. The previous version also accepted "the last 8
  // characters match", which is a coincidence generator: two loans from the same
  // lender routinely share a suffix, and the rule fired at full confidence.
  if (acctRef) {
    const hit = only(active.filter(l => l.lender_account_number === acctRef))
    if (hit) return {
      loan: hit, rung: 'account_number',
      matchedOn: `the account number ${acctRef}, which matches this loan's record exactly`,
    }
  }

  // ── 2. A reference LEARNED from a document filed earlier ───────────────────
  // This is what makes the matcher self-healing. The first Stripe bundle records
  // the agreement's acct_ id as a lender_account_ref contract term; from then on
  // this rung recognises it, even though the loan's own lender_account_number
  // still says 'STRIPE-CAPITAL' and always will.
  if (acctRef && input.learnedRefLoanIds?.length) {
    const ids = [...new Set(input.learnedRefLoanIds)]
    if (ids.length === 1) {
      const hit = active.find(l => l.id === ids[0])
      if (hit) return {
        loan: hit, rung: 'learned_ref',
        matchedOn: `the account reference ${acctRef}, recorded against this loan from a document filed earlier`,
      }
    }
  }

  // ── 3. The lender a parser recognised, when exactly one active loan is theirs ─
  // Deliberately NOT a fuzzy search over every loan on file. The four Ford loans
  // and the two BayFirst loans each narrow to several and are discarded, which is
  // the correct answer: a lender with more than one open loan cannot be
  // identified by name alone, and saying so is more useful than picking one.
  for (const hint of input.lenderHints || []) {
    const h = norm(String(hint))
    if (!h) continue
    const hit = only(active.filter(l => {
      const ln = norm(String(l.lender || '')), xn = norm(String(l.xero_account_name || ''))
      // The `h.includes(ln)` direction needs a length floor. Without it a lender
      // recorded under a very short name is "contained in" almost any hint and
      // matches documents that have nothing to do with it.
      return (!!ln && ln.includes(h)) || (ln.length >= 5 && h.includes(ln)) || (!!xn && xn.includes(h))
    }))
    if (!hit) continue
    let matchedOn = `the lender named in these documents (${hint}), which matches exactly one active loan`
    // Corroborate with the amount when the agreement gave one. Never required —
    // it only strengthens the sentence the human reads before approving.
    const la = input.agreementLoanAmount
    if (typeof la === 'number' && hit.original_amount !== null && hit.original_amount !== undefined &&
        Math.abs(Number(hit.original_amount) - la) < 0.01) {
      matchedOn += `, and whose recorded original amount matches the agreement's Loan Amount to the cent`
    }
    return { loan: hit, matchedOn, rung: 'lender_name' }
  }

  return none
}
