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
//   * the search itself has to have been COMPLETE. An entry that could not be
//     read is not an entry that does not exist, and "found nothing" is only
//     worth saying when everything was actually looked at.
//
// AND IT HAS TO LOOK EVERYWHERE, NOT JUST AT JOURNALS
// The first version searched ManualJournals alone — and its own not-found message
// admitted the gap: "the fee may have been capitalised some other way, an opening
// balance, or a bill rather than a journal." Naming a hole is not covering it.
// David: "you need to be looking everywhere, not just the journal entries, or the
// tool itself is only 50% built."
//
// What can actually CREDIT a loan liability in Xero, and how each looks:
//
//   manual journal      a line on the loan account with a negative LineAmount.
//                       Xero's journal convention: positive debits, negative credits.
//   receive money       a bank transaction of Type RECEIVE with a line coded to the
//                       loan account. RECEIVE credits the coded account, so this is
//                       a real way for a balance to go up. (SPEND debits it, which
//                       is a repayment, and is excluded.)
//   opening balance     the loan entered Xero with the fee already inside its
//                       conversion balance, in which case NO entry exists to find.
//
// The first two are searched. The third is NOT reachable through the read path
// available here, so it is named in the answer rather than left as a silent gap —
// a person told "journals and bank transactions were searched, an opening balance
// was not" knows exactly where to look next. A bill cannot produce this shape at
// all: a bill's lines DEBIT their coded accounts and it credits Accounts Payable,
// so it can never be the credit side of a capitalised fee.

export interface JournalLine {
  account: string | null          // account CODE
  account_name?: string | null
  description?: string | null
  /** Xero convention: positive is a DEBIT, negative is a CREDIT. */
  amount: number | null
}

/** Where a candidate entry came from. Decides how a CREDIT is recognised. */
export type LedgerSource = 'manual_journal' | 'bank_transaction'

export interface LedgerEntry {
  id: string
  source: LedgerSource
  date: string | null
  narration?: string | null
  status?: string | null
  /** For bank transactions: 'SPEND' or 'RECEIVE'. Ignored for journals. */
  type?: string | null
  lines: JournalLine[]
}

/** @deprecated the journal-only shape, kept so older callers still compile. */
export type JournalWithLines = LedgerEntry

const SOURCE_LABEL: Record<LedgerSource, string> = {
  manual_journal: 'journal',
  bank_transaction: 'bank transaction',
}

/**
 * Does this entry CREDIT `code` by exactly `wantCents`?
 *
 * The sign convention differs by source and getting it backwards is the whole
 * difference between finding the fee and finding a repayment of the same size.
 */
function creditsAccount(e: LedgerEntry, code: string, wantCents: number): boolean {
  const lines = e.lines || []
  if (e.source === 'manual_journal') {
    // Journal lines: positive debits, negative credits.
    return lines.some(l => String(l.account ?? '') === code &&
      typeof l.amount === 'number' && Math.round(l.amount * 100) === -wantCents)
  }
  // A bank transaction's line amounts are unsigned; the TYPE carries the sign.
  // RECEIVE credits the coded account, SPEND debits it. A SPEND of the fee amount
  // is a repayment and must never be mistaken for the fee going on.
  if (String(e.type ?? '').toUpperCase() !== 'RECEIVE') return false
  return lines.some(l => String(l.account ?? '') === code &&
    typeof l.amount === 'number' && Math.round(l.amount * 100) === wantCents)
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
  /** What the debit account turned out to be, once its type was read. */
  treatment?: { kind: string; consequence: string; account_type: string | null; account_class: string | null }
  journal: LedgerEntry | null
  /** The accounts that took the matching debit, largest first. */
  debits: { account: string | null; account_name: string | null; amount: number }[]
  candidates: { id: string; source: LedgerSource; date: string | null; narration: string | null }[]
  /** One sentence, ready to show. */
  statement: string
}

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const cents = (n: number) => Math.round(n * 100)

export function findOriginationFeeJournal(input: {
  /** Every candidate from every source that was searched. */
  journals: LedgerEntry[]
  /** Which sources were actually searched, so the answer can say. */
  searched?: LedgerSource[]
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

  const searched = input.searched ?? ['manual_journal']
  const searchedPhrase = searched.length
    ? `${searched.map(x => SOURCE_LABEL[x] + 's').join(' and ')} were searched.`
    : `Nothing was searched.`

  const want = cents(feeAmount)
  const DEAD = new Set(['DELETED', 'VOIDED'])
  const hits = journals.filter(e =>
    !DEAD.has(String(e.status ?? 'POSTED').toUpperCase()) &&
    creditsAccount(e, String(loanAccountCode), want))

  if (hits.length > 1) return {
    verdict: 'ambiguous', journal: null, debits: [],
    candidates: hits.map(j => ({ id: j.id, source: j.source, date: j.date ?? null, narration: j.narration ?? null })),
    statement:
      `${hits.length} entries${window} each credit ${money(feeAmount)} to account ${loanAccountCode}, so which one capitalised the fee cannot be settled from the ledger alone. ` +
      hits.map(j => `${SOURCE_LABEL[j.source]} ${j.date ?? 'undated'} (${j.narration || 'no narration'})`).join('; ') + '.',
  }

  if (!hits.length) return {
    ...none,
    verdict: complete ? 'not_found' : 'incomplete',
    statement: complete
      ? `Nothing${window} credits ${money(feeAmount)} to account ${loanAccountCode}. ${searchedPhrase} ` +
        `What is left is an opening balance — the loan entered Xero with the fee already inside it, in which case there is no entry to find — and that cannot be read through this path, so it is the one place still worth a person's time.`
      : `The ledger could not be searched completely${window}, so nothing follows from not finding the fee entry. An entry that could not be read is not an entry that does not exist.`,
  }

  const j = hits[0]
  // A RECEIVE's other side is the bank account itself, not another coded line, so
  // "what was debited" has a different answer there and the line list is not it.
  if (j.source === 'bank_transaction') return {
    verdict: 'found', journal: j, debits: [], candidates: [],
    statement:
      `A bank transaction dated ${j.date ?? 'unknown'}${j.narration ? ` ("${j.narration}")` : ''} credits ${money(feeAmount)} to account ${loanAccountCode}. ` +
      `Its other side is the bank account it was recorded against, which means this was money moving rather than a fee capitalised by journal — worth confirming that is what you expect before relying on it.`,
  }

  const debits = (j.lines || [])
    .filter(l => typeof l.amount === 'number' && l.amount > 0)
    .map(l => ({ account: l.account ?? null, account_name: l.account_name ?? null, amount: l.amount as number }))
    .sort((a, b) => b.amount - a.amount)

  if (!debits.length) return {
    verdict: 'ambiguous', journal: j, debits: [],
    candidates: [{ id: j.id, source: j.source, date: j.date ?? null, narration: j.narration ?? null }],
    statement:
      `A ${SOURCE_LABEL[j.source]}${window} credits ${money(feeAmount)} to account ${loanAccountCode} (${j.date ?? 'undated'}), but no debit line could be read from it, so the other side of the entry is still unknown.`,
  }

  const named = (d: { account: string | null; account_name: string | null }) =>
    d.account_name ? `${d.account_name} (${d.account})` : `account ${d.account}`
  const where = debits.length === 1
    ? named(debits[0])
    : debits.map(d => `${named(d)} ${money(d.amount)}`).join(', ')

  return {
    verdict: 'found', journal: j, debits, candidates: [],
    statement:
      `The ${SOURCE_LABEL[j.source]} dated ${j.date ?? 'unknown'}${j.narration ? ` ("${j.narration}")` : ''} credits ${money(feeAmount)} to account ${loanAccountCode} and debits ${where}. ` +
      `That debit is the answer: it is where this loan's ${money(feeAmount)} of financing cost went.`,
  }
}

/**
 * Where a debited fee LANDS decides whether the books are right, and the three
 * outcomes have three different fixes. Naming which one this is turns the answer
 * into something a CPA can act on rather than a fact to file.
 *
 * Keyed on what Xero REPORTS, never on the account's name: "Loan Fees" could be an
 * expense or an asset depending on how the chart was built, and guessing from a
 * label is how a prepaid gets recorded as expensed.
 *
 * `class` is preferred over `type` because it is the coarse, stable bucket —
 * Stripe Capital's fee account came back `type: "OVERHEADS", class: "EXPENSE"`,
 * and it is the class that answers the question. `type` still refines it and is
 * the only thing that can spot a suspense account.
 */
export function classifyFeeDebit(accountType: string | null | undefined, accountClass?: string | null): {
  kind: 'expensed' | 'capitalised' | 'suspense' | 'unusual' | 'unknown'
  consequence: string
} {
  const t = String(accountType ?? '').toUpperCase()
  const c = String(accountClass ?? '').toUpperCase()

  // Suspense first: it is a real answer and it outranks whatever class it sits in.
  if (/SUSPENSE|CLEARING|UNCATEGORI[SZ]ED/.test(t) || /SUSPENSE|CLEARING/.test(c)) return {
    kind: 'suspense',
    consequence: `The cost was parked, not booked. It is sitting unresolved in the ledger and belongs in a real account before this loan is relied on in a close.`,
  }

  const expense = c === 'EXPENSE' || (!c && ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS'].includes(t))
  const asset   = c === 'ASSET'   || (!c && ['CURRENT', 'PREPAYMENT', 'NONCURRENTASSET', 'FIXED'].includes(t))

  if (expense) return {
    kind: 'expensed',
    // Stated, not argued, and then dropped. David, on seeing 264 come back as an
    // Overhead: "it should probably be simply listed as an expense" — and, on
    // being offered the accruals caveat anyway, "but that is irrelevant now."
    // He is right: the treatment is settled, so the tool records what it is and
    // says nothing further. Re-litigating a decision every run is how a queue
    // becomes noise, and this module's whole history is the cost of that.
    consequence: `This is an expense account, so the fee was booked as a cost at origination.`,
  }
  if (asset) return {
    kind: 'capitalised',
    consequence: `The cost was capitalised as an asset, which is the accruals-basis treatment — but something has to amortise it over the loan's life and nothing in this system does. Worth confirming a schedule exists, or the cost never reaches the profit and loss at all.`,
  }
  if (c === 'LIABILITY' || c === 'EQUITY') return {
    kind: 'unusual',
    consequence: `The fee was debited to a ${c.toLowerCase()} account, which is not where a financing cost normally lands. Worth checking it was intended before this loan is relied on in a close.`,
  }
  return {
    kind: 'unknown',
    consequence: `What that account is for decides whether the cost is recognised, deferred, or merely parked — worth a look before this loan is relied on in a close.`,
  }
}

export function normaliseLedgerEntry(raw: any, source: LedgerSource): LedgerEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id ?? raw.ManualJournalID ?? raw.BankTransactionID ?? '')
  if (!id) return null
  const rawLines = raw.lines ?? raw.JournalLines ?? raw.LineItems ?? []
  return {
    id, source,
    date: raw.date ?? (typeof raw.DateString === 'string' ? xeroDate(raw.DateString) : null)
        ?? (typeof raw.Date === 'string' ? xeroDate(raw.Date) : null),
    narration: raw.narration ?? raw.Narration ?? raw.reference ?? raw.Reference ?? null,
    status: raw.status ?? raw.Status ?? 'POSTED',
    type: raw.type ?? raw.Type ?? null,
    lines: (Array.isArray(rawLines) ? rawLines : []).map((l: any) => {
      const n = typeof l.amount === 'number' ? l.amount
              : typeof l.LineAmount === 'number' ? l.LineAmount
              : typeof l.LineAmount === 'string' && l.LineAmount.trim() !== '' ? Number(l.LineAmount)
              : NaN
      return {
        account: l.account ?? l.AccountCode ?? null,
        account_name: l.account_name ?? l.AccountName ?? l.Name ?? null,
        description: l.description ?? l.Description ?? null,
        // A figure that could not be read must be null and never 0 — a zero would
        // silently participate in comparisons as if it were a real amount.
        amount: Number.isFinite(n) ? n : null,
      }
    }),
  }
}

/** Xero's other date shape: "/Date(1782777600000+0000)/", alongside plain ISO. */
export function xeroDate(v: string): string | null {
  const m = /\/Date\((-?\d+)/.exec(v)
  if (!m) return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
  const t = Number(m[1])
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}
