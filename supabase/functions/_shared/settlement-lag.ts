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
// ─── WHAT THAT SENTENCE DOES NOT SAY, AND WHAT SESSION 245 GOT WRONG ────────
// It says the withholding of the last few DAYS. It does not say "a daily rate
// times a few days", and until session 245 this module could not tell the two
// apart. It inferred a rate in dollars per day, divided the gap by it, and called
// the quotient a number of days:
//
//     impliedDays = gap / dailyWithholding
//
// That is not a test. It is a division, and it returns a number of days for ANY
// gap you hand it — feed it $60,000 and it reports a number of days with the same
// composure it reports three. The only thing standing between a real shortfall and
// benign:true was whether the quotient happened to land under the tolerance.
//
// And the rate it divided by was never a rate. Stripe Capital withholds EIGHT
// PERCENT OF EVERY SALE. The $430.47/day this module used is exactly the mean of
// the lender's July export ($11,192.29 over 26 days) — the arithmetic average of a
// quantity that is not constant. Measured against that same export, in the
// Pacific days the books run on:
//
//     daily withholding ran $28.40 to $694.44 — a 24x swing;
//     the mean, $430.47, describes no day in the file;
//     $2,166.05 (the gap this module called "three business days of timing")
//       falls between the cheapest and the dearest three-business-day window in
//       the month — so July neither confirms it nor rules it out.
//
// A three-business-day WINDOW is far steadier than a day ($1,346.09 to $2,393.23
// across July, 1.8x rather than 24x), which is why the window aggregate is a real
// quantity worth measuring even though the daily rate is not. But it is only real
// when it is MEASURED — summed out of the lender's own transactions for the actual
// days in question. Extrapolating it from a mean is the same division wearing a
// better sentence.
//
// ─── SO THE MODULE NOW ANSWERS OR IT REFUSES ────────────────────────────────
// There is exactly one way to earn 'explained' here: the lender's own export,
// covering the settlement window, showing that it actually withheld at least the
// gap over those days. No export, no benign verdict — the finding stays open as
// 'unconfirmed_no_export', says the gap is CONSISTENT with settlement timing,
// says plainly that this is an assumption and not a measurement, names the date
// the last export ends, and asks for a current one. A gap is never again waved
// through on an extrapolated average.
//
// The rate estimators below survive, DEMOTED. They produce a descriptive number
// for the sentence — "this is about the size of three business days" — and a
// description can still RULE A GAP OUT (a gap worth forty days of withholding is
// not settlement timing however loosely the rate is measured). It can never rule
// one in. That asymmetry is the whole design: every path a rate can reach ends at
// a verdict that keeps the finding in front of a person.
//
// THE SIGNATURE HAS A SECOND HALF, AND IT TOOK UNTIL SESSION 244 TO COMPUTE IT
// The sentence this module has always printed on an explained gap ends "what would
// matter is the gap GROWING from one month to the next, because settlement lag stays
// the same size while a real shortfall compounds". It was right, and for two sessions
// it was only a sentence: nothing compared this close's gap with the last one, so a
// shortfall compounding $1,000 a month stayed benign for three consecutive closes
// while the gap tripled. Lag is a rate times a fixed number of days, so BOTH halves
// are checkable — the gap must be the right SIZE and it must not be GROWING — and a
// caller that can supply last close's figure now gets both.
//
// EVERY GUARD HERE LEANS THE SAME WAY, AND IT IS NOT SYMMETRY
// Understating the withholding rate makes a gap look like more days of lag than it
// is, and raises a finding somebody reads. Overstating it turns a real shortfall
// into "three business days of timing", benign:true, severity info, grey text.
// Those two errors do not cost the same, so the estimator below refuses to answer
// far more readily than it rounds up: no rate at all is a 'no_rate' verdict that
// stays in front of a person, and that is the worst it can do.

export type SettlementLagVerdict =
  /**
   * The gap is covered by withholding the LENDER'S OWN EXPORT shows it actually
   * took over the settlement window. This is timing, not money — and since
   * session 245 it is the only benign verdict, and the only one an export can
   * produce. A rate estimate can never reach it.
   */
  | 'explained'
  /** Bigger than any plausible lag. Something else is going on. */
  | 'too_large'
  /**
   * The gap is the SIZE of settlement lag but it is bigger than it was last close.
   * Lag does not grow — it is the same two or three days of withholding every
   * month — so growth is the one thing the 'explained' sentence has always said
   * would matter. Until session 244 it said it and never computed it.
   */
  | 'growing'
  /**
   * The gap is CONSISTENT with settlement timing and nothing has confirmed it
   * (session 245). No lender export covers the settlement window, so the only
   * thing supporting the reassurance is an average daily rate — and this lender
   * withholds a percentage of each sale, so an average describes no day of it.
   *
   * NOT BENIGN, deliberately and permanently. It is what the module used to
   * return as 'explained', and the difference between the two is the difference
   * between a measurement and an assumption. It is actionable — upload a current
   * export — and it clears the moment one arrives.
   */
  | 'unconfirmed_no_export'
  /** Books BEHIND the lender. Lag can never produce this direction. */
  | 'wrong_direction'
  /** This loan is not repaid out of settled receipts, so lag explains nothing. */
  | 'not_continuous'
  /** No measurable withholding rate — nothing can be concluded either way. */
  | 'no_rate'

/**
 * One Pacific calendar day of withholding, out of the lender's own export.
 *
 * Structurally what stripe-capital.ts's StripeCsvDay carries, deliberately NOT
 * imported from it: this module is loaded by reconciliation-run, which has no
 * business pulling in an 870-line Stripe CSV reader, and the next lender of this
 * shape (PayPal, Square, Shopify) will have its own parser and the same days.
 */
export interface LenderExportDay {
  /** 'YYYY-MM-DD', the date the BOOKS would call it. */
  date: string
  /** What the lender withheld that day, on the same basis as the gap. */
  withheld: number
}

/**
 * A lender transaction export, offered as evidence for one particular gap.
 *
 * WHY THE COVERAGE DATES ARE SEPARATE FROM `days`. `days` may legitimately be a
 * subset (one loan out of a file, one basis out of two). `coversFrom` and
 * `coversThrough` are what the FILE spans, and they are what freshness is judged
 * on. Deriving them from `days` would let a caller that filtered the rows down to
 * the window prove its own freshness with the very rows in question.
 */
export interface LenderExport {
  days: LenderExportDay[]
  /** First and last date the export itself covers. */
  coversFrom: string
  coversThrough: string
  /**
   * False when the parse could not read every row. An incomplete export UNDER-
   * states the window, which fails safe (the gap looks too large) — but it can
   * never be the thing that blesses a gap, so it does not get to.
   */
  complete: boolean
  /** What `withheld` measures, for the sentence: 'withheld', 'principal withheld'. */
  measures: string
  /** Plain-English account of the export, for the sentence. */
  label: string
}

/** Why an export could not settle the question — or that it did. */
export type ExportEvidence =
  | 'confirmed'      // a current, complete export covers the window
  | 'absent'         // no export at all
  | 'stale'          // the newest export ends before this balance date
  | 'incomplete'     // rows in the export could not be read
  | 'not_covering'   // the export does not span the settlement window
  | 'no_window'      // no lender as-of date, so there is no window to cover

export interface SettlementLagInput {
  /** Books balance minus lender balance. POSITIVE means the books show more owing. */
  gap: number
  /** The date the lender's figure is as of, 'YYYY-MM-DD'. */
  lenderAsOf: string | null
  /**
   * Average amount the lender withholds per CALENDAR day, or null if unmeasurable.
   *
   * DESCRIPTIVE ONLY since session 245. It sizes the gap in the sentence and it
   * can rule a gap OUT; it cannot earn 'explained'. See the header.
   */
  dailyWithholding: number | null
  /** Plain-English account of where that rate came from, for the sentence shown. */
  rateBasis: string
  /**
   * The lender's own transactions, when the caller has them. This is the only
   * evidence that can produce a benign verdict.
   */
  lenderExport?: LenderExport | null
  /**
   * Whether this loan is actually repaid continuously out of settled receipts.
   * Settlement lag explains nothing on a loan paid by monthly ACH — the arithmetic
   * would still produce a number, and that number would mean nothing.
   */
  repaysContinuously: boolean
  /**
   * How many business days of lag is still plausible. Default 3.
   *
   * Was 5 until session 244, and nothing ever justified the extra two: David's
   * account of this loan is "2-3 business days", the header's worked example lands
   * on exactly 3, no caller has ever passed an override and no test exercised one.
   * Two days is $860.94 at Stripe Capital's $430.47 a day — a flat, permanent,
   * invisible allowance per loan per close, granted in the direction that hides
   * money, because every extra day of tolerance is another real shortfall that
   * comes back 'explained'.
   *
   * Since session 245 it also sets the length of the window summed out of the
   * lender's export, which is the one place it decides a benign verdict.
   */
  maxBusinessDays?: number
  /**
   * The same loan's gap as measured at the PREVIOUS close, and the date it was
   * measured on. Both optional: with no prior figure this module behaves exactly as
   * it did before the growth test existed, so a caller that cannot supply one loses
   * nothing it had.
   *
   * It must be a prior CLOSE, not simply the previous anchor. On a loan with daily
   * portal pulls the gap legitimately swells across a weekend — three days of sales
   * settle on Monday — and testing THAT for growth would raise an alarm every
   * Monday, which is the crying-wolf failure this whole module exists to stop.
   * Choosing the baseline is the caller's job (reconciliation-run requires at least
   * 20 days between the two observations, which is what separates a monthly close
   * from PCV's two anchors three days apart); all this module refuses is a baseline
   * that is not strictly older than the figure being tested.
   */
  priorGap?: number | null
  priorGapAsOf?: string | null
}

export interface SettlementLagResult {
  verdict: SettlementLagVerdict
  /** Calendar days of withholding the gap is worth. */
  impliedCalendarDays: number | null
  /** Business days between the implied book cut-off and the lender's date. */
  impliedBusinessDays: number | null
  /** The date the books appear to reflect settled receipts through. */
  impliedBooksThrough: string | null
  /**
   * What the lender's export shows it ACTUALLY withheld over the settlement
   * window, and the day that window opens. Null when no usable export was
   * offered — which is exactly when nothing here is a measurement.
   */
  windowWithholding: number | null
  windowFrom: string | null
  /** The last date the offered export covers, whether or not it was usable. */
  exportThrough: string | null
  /** Whether an export settled this, and if not, why not. */
  exportEvidence: ExportEvidence
  /** One sentence, ready to show. */
  statement: string
  /** True when the finding should stop being treated as something to act on. */
  benign: boolean
}

const DAY = 86_400_000
/**
 * The lag David describes, and the lag the header's own worked example measures:
 * 2-3 business days. See SettlementLagInput.maxBusinessDays for what the old 5 cost.
 */
export const DEFAULT_MAX_BUSINESS_DAYS = 3
/**
 * How much bigger this close's gap may be than the last one's before it stops
 * looking like timing. Settlement lag is a rate times a fixed number of days, so on
 * a stable loan the gap is the same size every close and this bar is nowhere near
 * it; a shortfall that compounds walks straight through it.
 */
export const GAP_GROWTH_LIMIT = 0.25
/**
 * How far the last paydown in an export may fall short of the balance date and
 * still be CURRENT for it (session 245).
 *
 * ONE DAY, and here is the whole of the justification. An export is pulled at a
 * moment: pull it on the morning of the 26th and the 26th's sales have not all
 * cleared, so the newest paydown in it is the 25th. That is a pull-time boundary,
 * not a stale file, and refusing it would mean no export is ever current enough to
 * confirm anything on the day it is downloaded.
 *
 * Two days would be a different claim. On this loan a day is worth roughly a
 * quarter to a half of the whole settlement gap, and the days most likely to be
 * missing are the ones nearest the balance date — the exact days in question. A
 * Friday export against a Monday balance is three days short and misses an entire
 * weekend of withholding: it is not a slightly-old answer to this month's
 * question, it is a complete answer to a different one.
 */
export const EXPORT_FRESHNESS_TOLERANCE_DAYS = 1
/**
 * Rounding slack when comparing a gap against a summed window, and nothing more.
 * Two cents: enough for the cent-level disagreement between a balance difference
 * and a sum of per-transaction amounts, far too little to be a tolerance.
 */
export const WINDOW_ROUNDING_TOLERANCE = 0.02
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n: number) => Math.round(n * 100) / 100
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)
const isWeekend = (t: number) => { const d = new Date(t).getUTCDay(); return d === 0 || d === 6 }

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

/**
 * The calendar span whose withholding is still unsettled at `asOf`, given a
 * settlement delay of `businessDays` business days. Returns the span as
 * (from, to] — the same half-open convention businessDaysBetween counts on.
 *
 * ── WHY THE SPAN IS CALENDAR DAYS AND THE DELAY IS BUSINESS DAYS ────────────
 * Two different clocks, and conflating them is the easiest mistake here.
 *
 * The DELAY is in business days because the books see money when a payout lands,
 * and payouts land on business days. Three business days back from Wednesday
 * 2026-08-26 is Friday 2026-08-21.
 *
 * The WITHHOLDING is every calendar day in between, weekends included, because
 * the lender takes its cut when the SALE clears and sales happen on Saturday. The
 * $202.34 Stripe withheld on Sunday 2026-07-12 is unsettled money exactly like the
 * $616.34 it took the following Monday. Counting business days only would drop a
 * whole weekend of real withholding out of the window and report a benign gap as
 * too large — the crying-wolf failure, arrived at by being "conservative".
 *
 * `from` is therefore walked back off a weekend onto the preceding business day:
 * the books' cut-off is a payout date, and there is no payout on a Sunday.
 */
export function settlementWindow(asOf: string, businessDays: number): { from: string; to: string } | null {
  const end = Date.parse(asOf + 'T00:00:00Z')
  if (!Number.isFinite(end)) return null
  if (!Number.isFinite(businessDays) || businessDays < 1 || businessDays > 20) return null
  let t = end, counted = 0, guard = 0
  while (counted < businessDays && guard++ < 100) {
    if (!isWeekend(t)) counted++
    if (counted < businessDays) t -= DAY
  }
  if (counted < businessDays) return null
  let from = t - DAY
  while (isWeekend(from) && guard++ < 200) from -= DAY
  return { from: new Date(from).toISOString().slice(0, 10), to: asOf }
}

/** What the export shows was withheld in (from, to]. */
function withholdingInWindow(days: LenderExportDay[], from: string, to: string): number {
  let s = 0
  for (const d of days) if (d.date > from && d.date <= to) s += Number(d.withheld) || 0
  return round2(s)
}

/**
 * The date the books appear to reflect settled receipts through, MEASURED: walk
 * back from the lender's date adding each day's actual withholding until it covers
 * the gap. This is the export-backed answer to the question `gap / rate` used to
 * answer by division.
 */
function booksThroughFromExport(days: LenderExportDay[], from: string, to: string, gap: number): string {
  const inWindow = days.filter(d => d.date > from && d.date <= to).sort((a, b) => (a.date < b.date ? 1 : -1))
  let acc = 0
  for (const d of inWindow) {
    acc += Number(d.withheld) || 0
    if (acc + WINDOW_ROUNDING_TOLERANCE >= gap) return addDays(d.date, -1)
  }
  return from
}

/**
 * Can this export settle a gap measured as of `asOf`, and if not, why not?
 *
 * Every 'no' here is a refusal to conclude, never a downgrade to a softer yes.
 */
function judgeExport(
  ex: LenderExport | null | undefined, asOf: string | null, win: { from: string; to: string } | null,
): ExportEvidence {
  if (!ex || !ex.days?.length || !ex.coversThrough) return 'absent'
  if (!asOf || !win) return 'no_window'
  if (!ex.complete) return 'incomplete'
  // FRESHNESS. The export has to reach the balance date, give or take the
  // pull-time boundary above. A July file cannot say what August's gap is made of.
  if (ex.coversThrough < addDays(asOf, -EXPORT_FRESHNESS_TOLERANCE_DAYS)) return 'stale'
  // COVERAGE. The window opens the day after `from`; an export that starts inside
  // it is missing the earliest — and largest — part of the unsettled withholding.
  if (ex.coversFrom > addDays(win.from, 1)) return 'not_covering'
  return 'confirmed'
}

/**
 * Build the evidence bundle from a parsed transaction export.
 *
 * Structurally typed against stripe-capital.ts's StripeCsvParseResult rather than
 * importing it — see LenderExportDay for why. `basis` decides WHICH figure is
 * summed, and that is the caller's call because only the caller knows what basis
 * the gap it is explaining was measured on: a principal-only balance difference
 * must be compared against principal withheld, or the fee is counted as
 * settlement lag.
 */
export function lenderExportFromCsv(
  csv: {
    ok: boolean
    lender_label?: string
    days: { date: string; total_paid: number; principal_paid: number }[]
    first_date: string | null
    last_date: string | null
  } | null | undefined,
  basis: 'principal_only' | 'total_paid',
): LenderExport | null {
  if (!csv || !csv.days?.length || !csv.first_date || !csv.last_date) return null
  const days = csv.days.map(d => ({
    date: d.date,
    withheld: basis === 'principal_only' ? Number(d.principal_paid) : Number(d.total_paid),
  })).filter(d => d.date && Number.isFinite(d.withheld))
  if (!days.length) return null
  return {
    days,
    coversFrom: csv.first_date,
    coversThrough: csv.last_date,
    // An export with unread rows is incomplete, and an incomplete export is not
    // allowed to be the thing that blesses a gap. It is still carried, because its
    // DATE is worth naming in the refusal.
    complete: csv.ok === true,
    measures: basis === 'principal_only' ? 'principal withheld' : 'withheld',
    label: `${csv.lender_label ?? "the lender's transaction export"}, ${csv.first_date} to ${csv.last_date}`,
  }
}

export function explainBalanceGap(input: SettlementLagInput): SettlementLagResult {
  const { gap, lenderAsOf, dailyWithholding, rateBasis, repaysContinuously } = input
  const maxBiz = input.maxBusinessDays ?? DEFAULT_MAX_BUSINESS_DAYS
  const ex = input.lenderExport ?? null
  const exportThrough = ex?.coversThrough ?? null
  const none = {
    impliedCalendarDays: null, impliedBusinessDays: null, impliedBooksThrough: null,
    windowWithholding: null, windowFrom: null, exportThrough,
  }

  // The direction is the first question and it is not a close one. Lag makes the
  // LENDER ahead, never the books. Books ahead means the books have credited a
  // payment the lender does not acknowledge, and no amount of timing explains it.
  if (gap < 0) return {
    ...none, exportEvidence: 'absent', verdict: 'wrong_direction', benign: false,
    statement: `Settlement timing cannot explain this: it always leaves the LENDER ahead of the books, and here the books are ahead of the lender.`,
  }

  if (!repaysContinuously) return {
    ...none, exportEvidence: 'absent', verdict: 'not_continuous', benign: false,
    statement: `This loan is not repaid out of settled card receipts, so settlement timing does not explain a gap on it.`,
  }

  // A gap of exactly nothing has nothing to attribute to anything. This is not the
  // rate path reaching 'explained' by another door — no rate, no window and no
  // export is consulted, because there is no money to account for.
  if (gap === 0) return {
    ...none, exportEvidence: 'absent', verdict: 'explained', benign: true,
    impliedCalendarDays: 0, impliedBusinessDays: lenderAsOf ? 0 : null, impliedBooksThrough: lenderAsOf,
    statement: `The books and the lender agree to the cent, so there is no gap for settlement timing or anything else to explain.`,
  }

  const win = lenderAsOf ? settlementWindow(lenderAsOf, maxBiz) : null
  const evidence = judgeExport(ex, lenderAsOf, win)

  // ── THE GROWTH TEST (session 244) ───────────────────────────────────────────
  // The 'explained' sentence ends: "what would matter is the gap GROWING from one
  // month to the next, because settlement lag stays the same size while a real
  // shortfall compounds." It shipped; the arithmetic behind it did not. Nothing
  // ever compared this close's gap with the last one, so a shortfall compounding
  // $1,000 a month sat at benign:true for three consecutive closes while the gap
  // tripled — wearing the module's own reassurance as cover.
  //
  // A prior figure of zero or less has no growth to measure FROM — $0 to anything
  // is an infinite increase, and a negative prior gap ran the other way entirely.
  // A baseline that is not strictly older measures nothing either.
  const prior = input.priorGap ?? null
  const priorAsOf = input.priorGapAsOf ?? null
  const priorUsable = prior !== null && Number.isFinite(prior) && prior > 0 &&
    (!priorAsOf || !lenderAsOf || priorAsOf < lenderAsOf)
  const growth = priorUsable ? (gap - (prior as number)) / (prior as number) : null
  const grew = growth !== null && growth > GAP_GROWTH_LIMIT
  // Built lazily: `prior` is null on every call that supplies no baseline, which is
  // most of them, and money(null) throws.
  const priorPhrase = () => `${money(prior as number)}${priorAsOf ? ` at the ${priorAsOf} close` : ' at the previous close'}`
  const growingStatement = (arithmetic: string) =>
    `${arithmetic}. That is the SIZE of settlement timing on this loan, but it is not behaving like it: the ` +
    `same gap was ${priorPhrase()} and is ${money(gap)} now, up ${((growth as number) * 100).toFixed(1)}%. Settlement lag ` +
    `does not grow — it is the same two or three days of withholding every close — while a real shortfall compounds, ` +
    `and this is the growth that this check has always said would be the thing that mattered. It needs explaining ` +
    `rather than waving through as timing.`

  // ── THE EXPORT-FIRST TEST (session 245) ─────────────────────────────────────
  // The only path to a benign verdict. Not "the gap is about N days at the average
  // rate" but "the lender's own transactions for those exact days add up to at
  // least the gap". Everything below this branch is a refusal to conclude.
  if (evidence === 'confirmed' && win && lenderAsOf && ex) {
    const windowWithholding = withholdingInWindow(ex.days, win.from, win.to)
    const booksThrough = booksThroughFromExport(ex.days, win.from, win.to, gap)
    const bizDays = businessDaysBetween(booksThrough, lenderAsOf)
    const calDays = Math.round((Date.parse(lenderAsOf + 'T00:00:00Z') - Date.parse(booksThrough + 'T00:00:00Z')) / DAY)
    const measured = {
      impliedCalendarDays: Number.isFinite(calDays) ? calDays : null,
      impliedBusinessDays: bizDays, impliedBooksThrough: booksThrough,
      windowWithholding, windowFrom: win.from, exportThrough,
      exportEvidence: 'confirmed' as const,
    }
    const arithmetic =
      `${money(gap)} against the ${money(windowWithholding)} this lender's own export shows it actually ${ex.measures} ` +
      `over the ${maxBiz} business ${maxBiz === 1 ? 'day' : 'days'} from ${win.from} to ${lenderAsOf} (${ex.label})`

    if (gap > windowWithholding + WINDOW_ROUNDING_TOLERANCE) return {
      ...measured, verdict: 'too_large', benign: false,
      statement:
        `${arithmetic}. The gap is bigger than everything the lender took in that window, so settlement timing does ` +
        `not account for it — there is no number of unsettled days that adds up to ${money(gap)}. Something other than ` +
        `timing is behind it and it needs explaining before this loan is relied on in a close.`,
    }

    // Gated INSIDE the size test, deliberately, as it always was: a gap already too
    // big to be timing is too_large whether or not it grew.
    //
    // AND NOT LOOSENED BY THE MEASUREMENT. There is a real argument that a
    // confirmed window explains its own growth — bigger sales, bigger withholding,
    // bigger gap, all measured. It is not taken here, because the growth test
    // compares two closes on this book while the window measures three days on the
    // lender's, and when the two disagree the module's standing rule is that the
    // guard which keeps a person looking wins.
    if (grew) return { ...measured, verdict: 'growing', benign: false, statement: growingStatement(arithmetic) }

    return {
      ...measured, verdict: 'explained', benign: true,
      statement:
        `${arithmetic}. Every dollar of the gap is withholding the lender has already counted and the books have not ` +
        `seen yet: the books are at receipts settled through ${booksThrough}, the lender counts through ${lenderAsOf}. ` +
        `That is settlement lag, measured against the lender's own transactions rather than assumed from an average — ` +
        `what would matter is the gap GROWING from one month to the next, because settlement lag stays the same size ` +
        `while a real shortfall compounds.` +
        (growth !== null
          ? ` It has not: the same gap was ${priorPhrase()} and is ${money(gap)} now, ${growth < 0 ? 'down' : 'up'} ${Math.abs(growth * 100).toFixed(1)}%.`
          : ''),
    }
  }

  // ── NO EXPORT SETTLES THIS, SO NOTHING BELOW CAN BLESS THE GAP ──────────────
  if (!dailyWithholding || dailyWithholding <= 0) return {
    ...none, exportEvidence: evidence, verdict: 'no_rate', benign: false,
    statement:
      `There is no measurable withholding rate for this loan and no lender export covering this date, so the gap ` +
      `cannot be tested against settlement timing either way. A transaction export from this lender covering ` +
      `${win ? `${win.from} to ${lenderAsOf}` : 'the days before this balance date'} would settle it.`,
  }

  // Descriptive arithmetic. It sizes the gap for the sentence and it can rule a gap
  // OUT; it is never, on its own, enough to rule one in.
  const impliedCalendarDays = round2(gap / dailyWithholding)

  let impliedBusinessDays: number | null = null
  let impliedBooksThrough: string | null = null
  if (lenderAsOf) {
    const t = Date.parse(lenderAsOf + 'T00:00:00Z')
    if (Number.isFinite(t)) {
      impliedBooksThrough = new Date(t - Math.round(impliedCalendarDays) * DAY).toISOString().slice(0, 10)
      impliedBusinessDays = businessDaysBetween(impliedBooksThrough, lenderAsOf)
    }
  }

  const estimated = {
    impliedCalendarDays, impliedBusinessDays, impliedBooksThrough,
    windowWithholding: null, windowFrom: win?.from ?? null, exportThrough,
    exportEvidence: evidence,
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

  // A rate can still RULE A GAP OUT. However loosely it is measured, a gap worth
  // forty days of withholding is not two or three days of settlement timing, and
  // saying so costs nothing — the verdict is non-benign either way.
  if (!withinLag) return {
    ...estimated, verdict: 'too_large', benign: false,
    statement:
      `${arithmetic}. Settlement timing on this loan runs a few business days, so it does not account for a ` +
      `gap this size. Something other than timing is behind it and it needs explaining before this loan is ` +
      `relied on in a close.`,
  }

  if (grew) return { ...estimated, verdict: 'growing', benign: false, statement: growingStatement(arithmetic) }

  // The spread claim, MEASURED where there is anything to measure it on. The
  // sentence's whole point is that an average hides the swing, so quoting a swing
  // this module has not measured would be the same sin one level up.
  const spread = (() => {
    const vals = (ex?.days ?? []).map(d => Number(d.withheld)).filter(v => Number.isFinite(v) && v > 0)
    if (vals.length < 5) return `an average cannot say what any particular day was`
    const lo = Math.min(...vals), hi = Math.max(...vals)
    return `in the export on file the daily figure ran ${money(lo)} to ${money(hi)}, a ${(hi / lo).toFixed(0)}-fold swing`
  })()

  // What the module used to call 'explained', named honestly.
  const whyNotSettled =
    evidence === 'stale' && exportThrough && lenderAsOf
      ? `The newest transaction export on file ends ${exportThrough}, ${Math.round((Date.parse(lenderAsOf + 'T00:00:00Z') - Date.parse(exportThrough + 'T00:00:00Z')) / DAY)} days before this balance date, so it measures a different period and cannot speak for these days.`
      : evidence === 'incomplete' && exportThrough
        ? `The transaction export on file (ending ${exportThrough}) could not be read in full, so its totals are incomplete and cannot settle this.`
        : evidence === 'not_covering' && exportThrough
          ? `The transaction export on file ends ${exportThrough} and does not cover ${win ? `${win.from} to ${lenderAsOf}` : 'these days'}, so it cannot say what was withheld over them.`
          : evidence === 'no_window'
            ? `There is no lender as-of date here, so there is no window to measure an export against.`
            : `No transaction export from this lender is on file, so nothing has been checked against what it actually withheld.`

  return {
    ...estimated, verdict: 'unconfirmed_no_export', benign: false,
    statement:
      `${arithmetic}. That is CONSISTENT with settlement timing — but it is an assumption, not a measurement. ` +
      `${money(dailyWithholding)} a day is an AVERAGE, and this lender withholds a percentage of every sale, so what ` +
      `it actually took over ${win ? `${win.from} to ${lenderAsOf}` : 'those days'} is whatever the sales were — ` +
      `${spread}. ${whyNotSettled} ` +
      `Upload a transaction export from this lender covering ${win ? `${win.from} to ${lenderAsOf}` : 'the days before this balance date'} ` +
      `and this becomes a measurement — until then the gap stays open, because a gap this size is exactly what a real ` +
      `shortfall looks like too.` +
      // The one comparison this path CAN make, when a caller supplied a baseline.
      // It is not confirmation and does not pretend to be — a shortfall that has
      // stopped growing is a gap that is not growing — but a reader deciding how
      // hard to chase this deserves to know which of the two it is looking at.
      (growth !== null
        ? ` The gap has not grown, for what that is worth: it was ${priorPhrase()} and is ${money(gap)} now, ` +
          `${growth < 0 ? 'down' : 'up'} ${Math.abs(growth * 100).toFixed(1)}%.`
        : ''),
  }
}

/**
 * A DESCRIPTIVE daily figure from the lender's own transaction export.
 *
 * ── DEMOTED, SESSION 245. READ THIS BEFORE USING THE NUMBER FOR ANYTHING ────
 * This returns a month's total divided by the days in it. That is a MEAN, and on
 * a loan repaid by percentage-of-sales the mean describes no day of the month:
 * across the real July export the daily figure ran $28.40 to $694.44 around a
 * $430.47 mean, a 24x swing. Dividing a gap by it produces a number of days for
 * any gap at all, which is how a $2,166.05 gap came back "three business days of
 * settlement timing, benign".
 *
 * So this number is for the SENTENCE — "about the size of three business days" —
 * and for ruling a gap OUT. explainBalanceGap will not grant a benign verdict on
 * it, and if you find yourself wanting it to, what you actually want is
 * lenderExportFromCsv() and the per-day totals the same export already carries.
 *
 * `continuous` is a different quantity and is NOT demoted: many small withholdings
 * in a month is evidence about the SHAPE of the loan, not about any dollar figure.
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
 * A DESCRIPTIVE daily figure from the loan's OWN recorded balances.
 *
 * ── DEMOTED, SESSION 245, AND WHY THE MEDIAN WORK BELOW STAYS ───────────────
 * Everything this function computes is a description of history, not a test of
 * today's gap. A rate — however carefully measured — answers "how fast does this
 * balance usually fall", and the question on the table is "was THIS $2,166.05
 * withheld over THESE three days". Only the lender's transactions for those days
 * answer that, and this function has none. Since session 245 explainBalanceGap
 * cannot reach a benign verdict from this number at all.
 *
 * The day-weighted median below is kept in full, because it guards a DIFFERENT
 * defect and that defect is still live: a reissued statement or a catch-up sweep
 * makes one interval carry the whole answer, and the number this function prints
 * in the finding would then be wrong by 3-30x. A wrong description is still worth
 * preventing — it is read by a person, and it is the figure that decides whether a
 * gap gets ruled OUT. What the median is not, and never was, is a substitute for a
 * measurement.
 *
 * The transaction export is better evidence, but it only exists inside a bundle —
 * the scheduled reconciliation has never seen one. What it always has is a history
 * of balances, and a balance that falls is a payment whether or not anyone filed
 * the export that explains it.
 *
 * Only DECREASES count. A balance that rises is a fee, an advance or a correction,
 * and averaging those in would understate the rate and turn an ordinary settlement
 * gap into an alarm — the exact failure this whole module exists to stop.
 *
 * ── WHOSE BALANCES, AND MEASURING WHAT (session 244) ────────────────────────
 * This function used to be handed every statement row on the loan, filtered by
 * loan id and nothing else. Two different rows in that pile are not this loan's
 * lender balance at all:
 *
 *   THE BOOKS' OWN BALANCE. Stripe Capital carries 35 rows of
 *   source='xero_balance_snapshot' — a balance we computed FROM XERO and stored.
 *   It sits ABOVE the lender's by exactly the settlement lag being measured, so
 *   every snapshot -> lender-statement transition reads as a one-day payment of
 *   the whole lag. Measured on the real interleave: $430.47/day of truth came out
 *   as $863.68/day, 2.01x, which made a real $6,000 shortfall benign.
 *
 *   A DIFFERENT BASIS. A total_payback row carries the unamortized fee on top of
 *   principal, so the step down to the next principal_only row books the fee as
 *   withholding: $150.00/day of truth came out as $292.05/day.
 *
 * Both errors run the SAME WAY — they overstate the rate, and an overstated rate
 * is what turns a real shortfall into "a few business days of timing". So the
 * filter is an allowlist on both axes, and an unknown source or a missing basis
 * fails INTO the filter rather than out of it, the same rule the engine's
 * isDerivedSource() lives by.
 *
 * WHY principal_only AND NOT "any one consistent basis". A consistent total_payback
 * series would measure principal + fee amortisation and call the sum withholding —
 * an overstatement again. And the number this rate is used to explain is always
 * principal-only: computeTieOut() refuses any anchor that is not confirmed
 * principal_only, so a gap that reaches this module was measured principal-only or
 * it was never measured at all. A rate on any other basis is arithmetic between two
 * different quantities.
 */

/**
 * A balance row that can measure a rate: a document from the LENDER, stating
 * principal only. Deliberately the same three sources the engine already trusts to
 * anchor a reconciliation (REAL_ANCHOR_SOURCES in reconciliation-run/index.ts) —
 * anything else is a balance we derived from Xero ourselves, and measuring the
 * lender's withholding from our own arithmetic proves nothing.
 */
export const RATE_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']
/** A rate measured over the life of the loan describes a business that has since changed size. */
export const RATE_WINDOW_DAYS = 120
/** Below this many balances in the window there is no history, only a coincidence. */
export const RATE_MIN_BALANCES = 3
/** Below this many falling intervals one interval IS the answer, whatever the arithmetic. */
export const RATE_MIN_FALLING_INTERVALS = 2

export function dailyWithholdingFromBalances(
  rows: { statement_date: string; principal_balance: number | string; source?: string | null; balance_basis?: string | null }[],
  today: string,
): { rate: number | null; basis: string } {
  const dated = (rows || []).filter(r => r.statement_date && r.statement_date <= today)
  const clean = dated
    .filter(r => RATE_SOURCES.includes(String(r.source ?? '')) && String(r.balance_basis ?? '') === 'principal_only')
    .map(r => ({ d: r.statement_date, b: Number(r.principal_balance) }))
    .filter(r => Number.isFinite(r.b))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))

  if (!clean.length) {
    const sources = Array.from(new Set(dated.map(r => String(r.source ?? 'unknown')))).sort()
    const bases = Array.from(new Set(dated.map(r => String(r.balance_basis ?? 'unknown')))).sort()
    return { rate: null, basis: dated.length
      ? `none of the ${dated.length} balances on file is a lender document stating principal only (sources: ${sources.join(', ')}; bases: ${bases.join(', ')})`
      : 'no balances on file' }
  }

  // The last 120 days of history: a rate measured over the life of the loan
  // describes a business that has since changed size.
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - RATE_WINDOW_DAYS * DAY).toISOString().slice(0, 10)
  const use = clean.filter(r => r.d >= cutoff)

  // ── NO FALLBACK TO THE LAST TWO ROWS (session 244) ──────────────────────────
  // This used to read `win.length >= 2 ? win : clean.slice(-2)`, which measures the
  // rate from ONE interval whenever the window is empty. A statement reissued one
  // day after its predecessor then gave $12,900.00/day against a true $430.00/day —
  // 30x — and turned a $60,000 discrepancy into "4 business days of settlement
  // timing", benign:true. It was reachable in ordinary use: a mode:'deep' run opens
  // the run window to 365 days while this cutoff stays at 120, so the rows arriving
  // here can all be older than the window.
  //
  // There is no safe fallback to build here, because the failure is not "too little
  // data", it is "an answer from too little data". Refusing to answer costs a
  // 'no_rate' verdict, which stays non-benign and keeps the finding in front of a
  // person; answering wrongly hides the money. So: three balances in the window or
  // no rate at all.
  if (use.length < RATE_MIN_BALANCES) {
    return { rate: null, basis: `only ${use.length} lender ${use.length === 1 ? 'balance' : 'balances'} on file inside the last ${RATE_WINDOW_DAYS} days (since ${cutoff}), and a rate needs at least ${RATE_MIN_BALANCES}` }
  }

  // Sum the decreases AND only the days they happened over. A stretch where the
  // balance ROSE — a fee capitalised, an advance drawn — says nothing about the
  // withholding rate, because whatever was withheld underneath it is hidden by the
  // rise. Counting those days in the denominator without their withholding in the
  // numerator halves the rate, and a halved rate turns an ordinary settlement gap
  // into twice as many days of lag as really elapsed. That is this module's own
  // failure mode, so it is worth the extra loop.
  const legs: { rate: number; days: number }[] = []
  let fell = 0, days = 0
  for (let i = 1; i < use.length; i++) {
    const delta = use[i - 1].b - use[i].b
    if (delta <= 0) continue
    const span = Math.round((Date.parse(use[i].d + 'T00:00:00Z') - Date.parse(use[i - 1].d + 'T00:00:00Z')) / DAY)
    if (span <= 0) continue
    legs.push({ rate: delta / span, days: span })
    fell += delta
    days += span
  }

  // One falling interval is one number wearing a total's clothes. Two is the least
  // that can disagree, and disagreement is the whole point of a median.
  if (legs.length < RATE_MIN_FALLING_INTERVALS || days <= 0 || fell <= 0) {
    return { rate: null, basis: legs.length
      ? `only ${legs.length} interval in the last ${RATE_WINDOW_DAYS} days on which this loan's balance actually fell, and a rate needs at least ${RATE_MIN_FALLING_INTERVALS}`
      : 'no balance decreases on file to measure a rate from' }
  }

  // ── THE MIDDLE DAY'S RATE, NOT THE AVERAGE (session 244) ────────────────────
  // Still a DESCRIPTION of this loan's history, not a test of today's gap — see the
  // function header. A median rate is a better description than a mean rate; a
  // better description is not a measurement of the days in question.
  //
  // This used to return fell / days, which lets ONE interval carry the answer:
  //
  //   a $30,000 catch-up sweep on a single day, against ten ordinary 10-day
  //   intervals, took a $430.00/day loan to $722.77/day;
  //
  //   a $24,000 fee capitalised and then reversed took it to $1,630.00/day (3.79x),
  //   because the rise is discarded — correctly — while the whole reversal is
  //   counted as withholding when the balance comes back down.
  //
  // Both are the dangerous direction. The median is the same answer as the mean on
  // an ordinary series (a loan withholding $430.47/day every interval returns
  // $430.47 either way) and refuses to be moved by one interval, which is exactly
  // the difference between the two cases above and a real change in rate.
  //
  // Weighted by DAYS, not by interval count: a 30-day interval is thirty days of
  // evidence and a 1-day interval is one, and an unweighted median would let a
  // handful of one-day reissues outvote a quarter of real history.
  //
  // Ties go to the LOWER rate — `>=` on the cumulative half, taking the first leg
  // that reaches it. With two equal-weight intervals of $430.00 and $2,830.00 an
  // averaging median would return $1,630.00, which is the mean this fix exists to
  // get away from. Understating the rate makes a gap look like MORE days of lag
  // than it is, which raises findings; overstating hides them.
  const sorted = legs.slice().sort((a, b) => a.rate - b.rate)
  const half = days / 2
  let cum = 0
  let median = sorted[0].rate
  for (const leg of sorted) {
    cum += leg.days
    if (cum >= half) { median = leg.rate; break }
  }

  return {
    rate: Math.round(median * 100) / 100,
    basis: `the middle day's rate across ${legs.length} intervals on which this loan's balance actually fell — ${money(fell)} over ${days} such days in the lender's own statements (${use[0].d} to ${use[use.length - 1].d})`,
  }
}
