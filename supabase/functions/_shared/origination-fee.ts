// _shared/origination-fee.ts — what was debited when the fee was capitalised.
//
// WHY THIS EXISTS
// The bundle asked: "The $20,875.00 fee was added into this loan's balance at the
// start. What was debited on the other side of that entry?" — and said "these
// documents cannot say", which was true and beside the point. David:
//
//   "This is knowable information. If there is no stated link to Stripe, the
//    amount of the fee should be enough for the system to deduce that it is the
//    missing fee. It can then be presented as a change to make to the CPA."
//
// He is right, and the phrasing gave the mistake away. The question was scoped to
// the UPLOAD when the system has the ledger. A journal that credits exactly the
// fee to exactly this loan's account within days of origination is not a
// coincidence to be reported as an open question — it is the answer, and the
// account on the other side of it is what the whole question was about.
//
// THE STANDARD THIS HAS TO MEET
// It proposes a change to a financial record, so a near-miss must NOT pass:
//
//   * the amount matches TO THE CENT — a fee is a contractual figure, not an
//     estimate, and anything that needs a tolerance is not this journal;
//   * it CREDITS the loan's own account — a debit of the same amount is some
//     other event entirely;
//   * exactly one journal qualifies. Two is a question, not an answer, and
//     picking between them is the guess this module refuses to make;
//   * the search itself has to have been COMPLETE. A journal that could not be
//     read is not a journal that does not exist, and "found nothing" is only
//     worth saying when everything was actually looked at.

export interface JournalLine {
  account: string | null          // account CODE
  account_name?: string | null
  description?: string | null
  /** Xero convention: positive is a DEBIT, negative is a CREDIT. */
  amount: number | null
}

export interface JournalWithLines {
  id: string
  date: string | null
  narration?: string | null
  status?: string | null
  lines: JournalLine[]
}

export type FeeVerdict =
  /** Exactly one journal credits the fee to this loan. The debit side is the answer. */
  | 'found'
  /** More than one qualifies. A question, not an answer. */
  | 'ambiguous'
  /** Everything in the window was read and none of them is it. */
  | 'not_found'
  /** The search could not be completed, so nothing may be concluded from silence. */
  | 'incomplete'

export interface FeeSearchResult {
  verdict: FeeVerdict
  journal: JournalWithLines | null
  /** The accounts that took the matching debit, largest first. */
  debits: { account: string | null; account_name: string | null; amount: number }[]
  candidates: { id: string; date: string | null; narration: string | null }[]
  /** One sentence, ready to show. */
  statement: string
}

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cents = (n: number) => Math.round(n * 100)

export function findOriginationFeeJournal(input: {
  journals: JournalWithLines[]
  /** The loan's Xero account code. Without it nothing can be concluded. */
  loanAccountCode: string | null
  feeAmount: number
  /** False when the search was truncated, rate-limited or partly unreadable. */
  complete: boolean
  windowFrom?: string
  windowTo?: string
}): FeeSearchResult {
  const { journals, loanAccountCode, feeAmount, complete } = input
  const window = input.windowFrom && input.windowTo ? ` dated ${input.windowFrom} to ${input.windowTo}` : ''
  const none: FeeSearchResult = { verdict: 'not_found', journal: null, debits: [], candidates: [], statement: '' }

  if (!loanAccountCode) return {
    ...none, verdict: 'incomplete',
    statement: `This loan has no Xero account code on its record, so the ledger cannot be searched for the fee entry.`,
  }

  const want = cents(feeAmount)
  const hits = journals.filter(j =>
    (j.status ?? 'POSTED') !== 'DELETED' &&
    (j.lines || []).some(l =>
      String(l.account ?? '') === String(loanAccountCode) &&
      typeof l.amount === 'number' &&
      // Negative is a credit in Xero's journal lines. The fee INCREASES a
      // liability, so it must be on the credit side; a debit of the same amount
      // is a repayment or a correction and answers a different question.
      cents(l.amount) === -want))

  if (hits.length > 1) return {
    verdict: 'ambiguous', journal: null, debits: [],
    candidates: hits.map(j => ({ id: j.id, date: j.date ?? null, narration: j.narration ?? null })),
    statement:
      `${hits.length} journals${window} each credit ${money(feeAmount)} to account ${loanAccountCode}, so which one capitalised the fee cannot be settled from the ledger alone. ` +
      hits.map(j => `${j.date ?? 'undated'} (${j.narration || 'no narration'})`).join('; ') + '.',
  }

  if (!hits.length) return {
    ...none,
    verdict: complete ? 'not_found' : 'incomplete',
    statement: complete
      ? `No journal${window} credits ${money(feeAmount)} to account ${loanAccountCode}. The fee may have been capitalised some other way — an opening balance, or a bill rather than a journal — so it still needs a person.`
      : `The ledger could not be searched completely${window}, so nothing follows from not finding the fee entry. A journal that could not be read is not a journal that does not exist.`,
  }

  const j = hits[0]
  const debits = (j.lines || [])
    .filter(l => typeof l.amount === 'number' && l.amount > 0)
    .map(l => ({ account: l.account ?? null, account_name: l.account_name ?? null, amount: l.amount as number }))
    .sort((a, b) => b.amount - a.amount)

  if (!debits.length) return {
    verdict: 'ambiguous', journal: j, debits: [],
    candidates: [{ id: j.id, date: j.date ?? null, narration: j.narration ?? null }],
    statement:
      `A journal${window} credits ${money(feeAmount)} to account ${loanAccountCode} (${j.date ?? 'undated'}), but no debit line could be read from it, so the other side of the entry is still unknown.`,
  }

  const named = (d: { account: string | null; account_name: string | null }) =>
    d.account_name ? `${d.account_name} (${d.account})` : `account ${d.account}`
  const where = debits.length === 1
    ? named(debits[0])
    : debits.map(d => `${named(d)} ${money(d.amount)}`).join(', ')

  return {
    verdict: 'found', journal: j, debits, candidates: [],
    statement:
      `The journal dated ${j.date ?? 'unknown'}${j.narration ? ` ("${j.narration}")` : ''} credits ${money(feeAmount)} to account ${loanAccountCode} and debits ${where}. ` +
      `That debit is the answer: it is where this loan's ${money(feeAmount)} of financing cost went.`,
  }
}

/**
 * Where a debited fee LANDS decides whether the books are right, and the three
 * outcomes have three different fixes. Naming which one this is turns the answer
 * into something a CPA can act on rather than a fact to file.
 *
 * Deliberately keyed on the account TYPE Xero reports, not on its name: "Loan
 * Fees" could be an expense or an asset depending on how the chart was built, and
 * guessing from a label is how a prepaid gets recorded as expensed.
 */
export function classifyFeeDebit(accountType: string | null | undefined): {
  kind: 'expensed' | 'capitalised' | 'suspense' | 'unknown'
  consequence: string
} {
  const t = String(accountType ?? '').toUpperCase()
  if (t === 'EXPENSE' || t === 'OVERHEADS' || t === 'DIRECTCOSTS') return {
    kind: 'expensed',
    consequence: `The cost was recognised at origination — all of it in one month, which flatters every month after it. Correct on a cash-basis view; a CPA closing on accruals may want it spread over the loan's life.`,
  }
  if (t === 'CURRENT' || t === 'PREPAYMENT' || t === 'NONCURRENTASSET' || t === 'FIXED') return {
    kind: 'capitalised',
    consequence: `The cost was capitalised as an asset, which is right on an accruals basis — but something has to amortise it over the loan's life, and nothing in this system does. Worth confirming a schedule exists.`,
  }
  if (/SUSPENSE|CLEARING|UNCATEGORI[SZ]ED/.test(t)) return {
    kind: 'suspense',
    consequence: `The cost was parked, not booked. It is sitting unresolved in the ledger and belongs in a real account before this loan is relied on in a close.`,
  }
  return {
    kind: 'unknown',
    consequence: `What that account is for decides whether the cost is recognised, deferred, or merely parked — worth a look before this loan is relied on in a close.`,
  }
}
