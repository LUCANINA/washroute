// ── A PAYMENT'S MONTH COMES FROM THE MONEY, NOT THE PAPER (session 277) ───────
//
// One rule, one place. `loan-ingest-statement` had `statement_date.slice(0, 7)`
// written out twice, and that inference is wrong whenever a lender applies at the
// end of its cycle and the bank drafts in the following month. BayFirst SBA 2 does
// exactly that -- applies 7/31, drafts 8/3 -- so its August payment filed as July
// and July's close rollforward double-counted $858.66 of principal against the real
// July payment.
//
// The statement's DATE IS CORRECT and must not be re-dated to fix this. What was
// wrong is the inference drawn from it.
//
// This lives in _shared, and takes its Xero window as an argument rather than
// fetching one, for the reason session 245 wrote down: a verification that
// re-implements the function it is checking never executes the shipped line. With
// the fetch injected, `tests/period-label.test.mts` drives THIS function -- the one
// that ships -- with no network and no writes.

export const PERIOD_LABEL_AMOUNT_TOLERANCE = 0.02
export const PERIOD_LABEL_INTEREST_CODE = '800'

export type XeroWindowTxn = { date: string | null, lines: { code: string, amt: number }[] }

export type PeriodLabelResult = {
  label: string
  /**
   * 'bank_transaction' -- measured: exactly one Xero bank transaction carries the
   * lender's own principal and interest, and its date says when the money moved.
   * 'statement_date'   -- assumed: no window, no match, an ambiguous match, or Xero
   * could not be reached. The readers allowlist 'bank_transaction'; anything else,
   * including a value added later, is treated as an assumption.
   */
  basis: 'bank_transaction' | 'statement_date'
  /** Plain-English sentence for review_notes. Empty when there is nothing to say. */
  note: string
  /** How many transactions matched. 0 when no window was consulted at all. */
  matchCount: number
}

/**
 * Decide which month a lender-stated principal/interest payment belongs to.
 *
 * `window` is the candidate bank transactions around the statement date, or null
 * when Xero was not consulted or could not be reached -- the two are reported
 * differently to the reader but behave identically, because an outage must never
 * silently change how a period is labelled.
 */
export function resolvePeriodLabel(args: {
  statementDate: string
  principal: number
  interest: number
  loanAccountCode: string
  window: XeroWindowTxn[] | null
  windowError?: string | null
}): PeriodLabelResult {
  const { statementDate, principal, interest, loanAccountCode, window, windowError } = args
  const stated = statementDate.slice(0, 7)

  if (windowError) {
    return {
      label: stated,
      basis: 'statement_date',
      note: ' Xero could not be reached to confirm when the money moved, so this is filed by the statement date.',
      matchCount: 0,
    }
  }
  if (!window) {
    return { label: stated, basis: 'statement_date', note: '', matchCount: 0 }
  }

  const near = (a: number, b: number) => Math.abs(Math.abs(a) - b) < PERIOD_LABEL_AMOUNT_TOLERANCE
  // BOTH legs are required. The principal alone is not enough to identify a payment
  // -- on an amortizing loan an adjacent month's principal can sit within a couple of
  // cents of this one, and matching on one leg would then date the payment wrong with
  // full confidence. Requiring the interest leg too is what makes this falsifiable.
  const hits = window.filter(t =>
    t.date &&
    t.lines.some(l => l.code === loanAccountCode && near(l.amt, principal)) &&
    t.lines.some(l => l.code === PERIOD_LABEL_INTEREST_CODE && near(l.amt, interest)))

  if (hits.length === 1) {
    const paid = String(hits[0].date).slice(0, 10)
    const paidMonth = paid.slice(0, 7)
    return {
      label: paidMonth,
      basis: 'bank_transaction',
      note: paidMonth === stated ? ''
        : ` The lender applied this on ${statementDate}, but the money moved on ${paid}`
          + ` -- so it is filed as ${paidMonth}, not ${stated}, which is the month the statement's own date implies.`,
      matchCount: 1,
    }
  }
  if (hits.length > 1) {
    // On a loan whose payment is identical every month, two months' transactions
    // carry identical lines. An ambiguous match is not a measurement (session 245),
    // and picking the nearest would repeat the amount-matching-without-a-date mistake
    // that let Xero offer an earlier payment against a future stage.
    return {
      label: stated,
      basis: 'statement_date',
      note: ` ${hits.length} bank transactions in Xero carry these same figures near ${statementDate},`
        + ` so which one is this payment cannot be told from the amounts alone. Filed by the statement's date instead.`,
      matchCount: hits.length,
    }
  }
  // No match: normal when the payment has not cleared or synced yet.
  return { label: stated, basis: 'statement_date', note: '', matchCount: 0 }
}
