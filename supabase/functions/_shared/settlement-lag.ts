// _shared/settlement-lag.ts — why a payment-provider loan's balance never
// matches the lender's, and how to tell that from a real discrepancy.
//
// THE FACT, WHICH IS TRUE OF EVERY LOAN OF THIS SHAPE
// David, on Stripe Capital: "the lender calculates the payback at the time of a
// successful card transaction, but Xero only sees the update 2-3 business days
// later when we receive our daily deposit."
//
// That is not a Stripe quirk. It is how every loan repaid out of settled card
// receipts works — Stripe Capital, PayPal Working Capital, Square Loans, Shopify
// Capital, any merchant-cash-advance style facility. The lender's clock starts at
// the SALE; the books' clock starts at the PAYOUT. So on these loans the lender is
// permanently, structurally a few days ahead, and the two balances are SUPPOSED to
// differ. A tool that flags that difference is not being careful, it is crying
// wolf on every close, forever, on every loan of this kind.
//
// WHY THIS IS A MODULE AND NOT A SENTENCE IN A CAVEAT
// The module already said this, in prose, as a caveat on the finding: "confirm it
// is only timing by checking that the gap closes." True, and useless — it asked a
// person to do arithmetic the system already had the numbers for, every month,
// on every such loan.
//
// Settlement lag has a SIGNATURE, and it is checkable:
//
//     the gap should equal the withholding of the last few days
//
// Stripe Capital, 2026-08-26: the books said $125,257.71, the lender said
// $123,091.66, a gap of $2,166.05. The lender's own July export withheld
// $11,192.29 over 26 days — $430.47 a day. $2,166.05 / $430.47 = 5.03 calendar
// days, and the five calendar days back from Wednesday 2026-08-26 span a weekend:
// THREE business days. Which is exactly the lag David described, derived from the
// documents without being told.
//
// So the gap is explained by arithmetic or it is not explained at all. A gap worth
// forty days of withholding is not settlement timing whatever anyone says, and a
// gap worth three business days needs no one's attention.

export type SettlementLagVerdict =
  /** The gap is a few business days of withholding. This is timing, not money. */
  | 'explained'
  /** Bigger than any plausible lag. Something else is going on. */
  | 'too_large'
  /** Books BEHIND the lender. Lag can never produce this direction. */
  | 'wrong_direction'
  /** This loan is not repaid out of settled receipts, so lag explains nothing. */
  | 'not_continuous'
  /** No measurable withholding rate — nothing can be concluded either way. */
  | 'no_rate'

export interface SettlementLagInput {
  /** Books balance minus lender balance. POSITIVE means the books show more owing. */
  gap: number
  /** The date the lender's figure is as of, 'YYYY-MM-DD'. */
  lenderAsOf: string | null
  /** Average amount the lender withholds per CALENDAR day, or null if unmeasurable. */
  dailyWithholding: number | null
  /** Plain-English account of where that rate came from, for the sentence shown. */
  rateBasis: string
  /**
   * Whether this loan is actually repaid continuously out of settled receipts.
   * Settlement lag explains nothing on a loan paid by monthly ACH — the arithmetic
   * would still produce a number, and that number would mean nothing.
   */
  repaysContinuously: boolean
  /** How many business days of lag is still plausible. Default 5. */
  maxBusinessDays?: number
}

export interface SettlementLagResult {
  verdict: SettlementLagVerdict
  /** Calendar days of withholding the gap is worth. */
  impliedCalendarDays: number | null
  /** Business days between the implied book cut-off and the lender's date. */
  impliedBusinessDays: number | null
  /** The date the books appear to reflect settled receipts through. */
  impliedBooksThrough: string | null
  /** One sentence, ready to show. */
  statement: string
  /** True when the finding should stop being treated as something to act on. */
  benign: boolean
}

const DAY = 86_400_000
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Business days in (from, to] — weekends only; holidays are noise at this scale. */
export function businessDaysBetween(from: string, to: string): number | null {
  const a = Date.parse(from + 'T00:00:00Z'), b = Date.parse(to + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  if (b - a > 400 * DAY) return null          // nonsense range; refuse rather than loop
  let n = 0
  for (let t = a + DAY; t <= b; t += DAY) {
    const d = new Date(t).getUTCDay()
    if (d !== 0 && d !== 6) n++
  }
  return n
}

export function explainBalanceGap(input: SettlementLagInput): SettlementLagResult {
  const { gap, lenderAsOf, dailyWithholding, rateBasis, repaysContinuously } = input
  const maxBiz = input.maxBusinessDays ?? 5
  const none = { impliedCalendarDays: null, impliedBusinessDays: null, impliedBooksThrough: null }

  // The direction is the first question and it is not a close one. Lag makes the
  // LENDER ahead, never the books. Books ahead means the books have credited a
  // payment the lender does not acknowledge, and no amount of timing explains it.
  if (gap < 0) return {
    ...none, verdict: 'wrong_direction', benign: false,
    statement: `Settlement timing cannot explain this: it always leaves the LENDER ahead of the books, and here the books are ahead of the lender.`,
  }

  if (!repaysContinuously) return {
    ...none, verdict: 'not_continuous', benign: false,
    statement: `This loan is not repaid out of settled card receipts, so settlement timing does not explain a gap on it.`,
  }

  if (!dailyWithholding || dailyWithholding <= 0) return {
    ...none, verdict: 'no_rate', benign: false,
    statement: `There is no measurable withholding rate for this loan, so the gap cannot be tested against settlement timing either way.`,
  }

  const impliedCalendarDays = Math.round((gap / dailyWithholding) * 100) / 100

  let impliedBusinessDays: number | null = null
  let impliedBooksThrough: string | null = null
  if (lenderAsOf) {
    const t = Date.parse(lenderAsOf + 'T00:00:00Z')
    if (Number.isFinite(t)) {
      impliedBooksThrough = new Date(t - Math.round(impliedCalendarDays) * DAY).toISOString().slice(0, 10)
      impliedBusinessDays = businessDaysBetween(impliedBooksThrough, lenderAsOf)
    }
  }

  // With no date to work from, fall back on calendar days: a lag of at most
  // `maxBiz` business days can never span more than about maxBiz + 2 calendar days.
  const withinLag = impliedBusinessDays !== null
    ? impliedBusinessDays <= maxBiz
    : impliedCalendarDays <= maxBiz + 2

  const arithmetic =
    `${money(gap)} is ${impliedCalendarDays} days of withholding at ${money(dailyWithholding)} a day (${rateBasis})` +
    (impliedBusinessDays !== null && impliedBooksThrough
      ? ` — ${impliedBusinessDays} business ${impliedBusinessDays === 1 ? 'day' : 'days'}, which puts the books at receipts settled through ${impliedBooksThrough} while the lender counts through ${lenderAsOf}`
      : '')

  if (withinLag) return {
    verdict: 'explained', benign: true,
    impliedCalendarDays, impliedBusinessDays, impliedBooksThrough,
    statement:
      `${arithmetic}. That is the settlement lag on this loan, not a discrepancy: the lender counts a ` +
      `withholding when the sale clears and the books count it when the payout lands. A gap of this size is ` +
      `what agreement looks like on a loan repaid out of card receipts — what would matter is the gap GROWING ` +
      `from one month to the next, because settlement lag stays the same size while a real shortfall compounds.`,
  }

  return {
    verdict: 'too_large', benign: false,
    impliedCalendarDays, impliedBusinessDays, impliedBooksThrough,
    statement:
      `${arithmetic}. Settlement timing on this loan runs a few business days, so it does not account for a ` +
      `gap this size. Something other than timing is behind it and it needs explaining before this loan is ` +
      `relied on in a close.`,
  }
}

/**
 * The withholding rate from the lender's own transaction export — the best source
 * there is, because it is the lender's record of what it actually took and when.
 */
export function dailyWithholdingFromMonths(
  months: { month?: string; total_paid: number; first_date: string; last_date: string; transaction_count: number }[],
): { rate: number | null; basis: string; continuous: boolean } {
  const usable = months.filter(m => m.total_paid > 0 && m.first_date && m.last_date)
  if (!usable.length) return { rate: null, basis: 'no transactions in the export', continuous: false }
  // The most recent month: a rate from a year ago describes a business that no
  // longer exists.
  const m = usable.slice().sort((a, b) => a.last_date < b.last_date ? 1 : -1)[0]
  const days = Math.round((Date.parse(m.last_date + 'T00:00:00Z') - Date.parse(m.first_date + 'T00:00:00Z')) / DAY) + 1
  if (!Number.isFinite(days) || days <= 0) return { rate: null, basis: 'the export gives no usable date range', continuous: false }
  // Many small withholdings is what "repaid out of receipts" looks like. A handful
  // of transactions in a month is a scheduled payment, and lag explains nothing.
  const continuous = m.transaction_count >= 20
  return {
    rate: Math.round((m.total_paid / days) * 100) / 100,
    basis: `${m.transaction_count.toLocaleString('en-US')} withholdings totalling ${money(m.total_paid)} over ${days} days in the lender's ${m.month ?? 'own'} export`,
    continuous,
  }
}

/**
 * The withholding rate from the loan's OWN recorded balances.
 *
 * The transaction export is better evidence, but it only exists inside a bundle —
 * the scheduled reconciliation has never seen one. What it always has is a history
 * of balances, and a balance that falls is a payment whether or not anyone filed
 * the export that explains it.
 *
 * Only DECREASES count. A balance that rises is a fee, an advance or a correction,
 * and averaging those in would understate the rate and turn an ordinary settlement
 * gap into an alarm — the exact failure this whole module exists to stop.
 */
export function dailyWithholdingFromBalances(
  rows: { statement_date: string; principal_balance: number | string }[],
  today: string,
): { rate: number | null; basis: string } {
  const clean = rows
    .filter(r => r.statement_date && r.statement_date <= today)
    .map(r => ({ d: r.statement_date, b: Number(r.principal_balance) }))
    .filter(r => Number.isFinite(r.b))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
  if (clean.length < 2) return { rate: null, basis: 'fewer than two balances on file' }

  // The last 120 days of history: a rate measured over the life of the loan
  // describes a business that has since changed size.
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - 120 * DAY).toISOString().slice(0, 10)
  const win = clean.filter(r => r.d >= cutoff)
  const use = win.length >= 2 ? win : clean.slice(-2)

  // Sum the decreases AND only the days they happened over. A stretch where the
  // balance ROSE — a fee capitalised, an advance drawn — says nothing about the
  // withholding rate, because whatever was withheld underneath it is hidden by the
  // rise. Counting those days in the denominator without their withholding in the
  // numerator halves the rate, and a halved rate turns an ordinary settlement gap
  // into twice as many days of lag as really elapsed. That is this module's own
  // failure mode, so it is worth the extra loop.
  let fell = 0, days = 0
  for (let i = 1; i < use.length; i++) {
    const delta = use[i - 1].b - use[i].b
    if (delta <= 0) continue
    const span = Math.round((Date.parse(use[i].d + 'T00:00:00Z') - Date.parse(use[i - 1].d + 'T00:00:00Z')) / DAY)
    if (span <= 0) continue
    fell += delta
    days += span
  }
  if (!days || days <= 0 || fell <= 0) return { rate: null, basis: 'no balance decreases on file to measure a rate from' }
  return {
    rate: Math.round((fell / days) * 100) / 100,
    basis: `${money(fell)} of balance decreases across ${days} days on which this loan's balance actually fell (${use[0].d} to ${use[use.length - 1].d})`,
  }
}
