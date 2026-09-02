// _shared/ledger-dating.ts — putting a DATE on an undated lender figure by
// measuring it against the lender's own transactions.
//
// ─── THE PROBLEM, IN THE DOCUMENTS THAT CAUSED IT ───────────────────────────
// A Stripe Capital portal screenshot states a balance and does not state a
// balance date. It prints a PERIOD ("Jul 6 – Sep 4") and a period-to-date total,
// and never says which day the balance belongs to. The figure extractor returns
// as_of: null, correctly — its schema says to report a date only if the image
// prints one and never to infer one — and loan-bundle-plan.ts §5b then refuses to
// file the balance as a lender anchor, because an anchor on the wrong date does
// not fail loudly. It counts as a real anchor by source, so it silently moves the
// variance on the one screen whose job is to say this loan is ready for the
// accountant. No anchor is a gap somebody can see; a wrong anchor is a gap nobody
// can. That refusal is correct and stays as the fallback.
//
// But the date is not always unknowable. When the bundle ALSO holds the lender's
// transaction export, the screenshot can be dated by MEASUREMENT rather than by
// inference: the screen states how much has been paid in the period, the export
// lists every withholding with a date, and
//
//     the day on which cumulative withholdings equal the screen's paid-to-date
//     IS the day the screen was showing.
//
// On the real documents, cumulative from the period's first withholding:
//
//     through 2026-08-26  =  $22,783.34   — the screen's "paid this period", exact
//     and it splits          $19,522.72 financing / $3,260.62 fee
//                                        — the screen's own two lines, exact
//     and $145,875.00 − $22,783.34 = $123,091.66
//                                        — the screen's "Amount remaining", exact
//     through 2026-08-27  =  $23,131.77   — $348.43 past it, so 08-26 is the only
//                                           day that fits
//
// ─── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
// Not in stripe-capital.ts: that file is a pair of READERS ("deterministic
// readers for Stripe Capital documents"), and nothing here reads a document. It
// is arithmetic over days and a target, and it is true of every lender that
// withholds continuously and exports its transactions — Stripe Capital, PayPal
// Working Capital, Square Loans, Shopify Capital. Not in loan-bundle-plan.ts:
// that module's own header says it is the planner and nothing else. So this
// follows the precedent of settlement-lag.ts, which is STRUCTURALLY typed against
// StripeCsvDay rather than importing it, for the same reason: the next lender of
// this shape will have its own parser and the same days.
//
// ─── AND WHY EVERY ANSWER HERE IS A REFUSAL UNTIL IT IS NOT ─────────────────
// This function assigns a date to a financial anchor. A WRONG date is worse than
// no date, so every branch below fails closed, and the four that matter are:
//
//   * NOT THE NEAREST DAY. A target that falls between two days is refused, never
//     rounded to whichever is closer. "Between $22,700 and $23,100" is not a date,
//     it is two dates and a preference.
//   * NOT A TIE. Two days with the same cumulative — which is what a day of zero
//     withholding immediately after a match produces — fit equally well, so
//     neither is returned.
//   * NOT A LATE START. This is the one that does not announce itself. A
//     cumulative that begins after the period does matches the WRONG DAY rather
//     than no day: hand in only the August file for a loan whose withholdings
//     started 2026-07-06 and the running total is $11,192.29 light all the way
//     through, so it crosses $22,783.34 somewhere in September and returns a real
//     date that is a month late. It cannot be caught downstream — the answer looks
//     exactly like a good one. So the export must be complete from on or before
//     the period start, or the caller must state what the period had already
//     accumulated before the file begins, and there is no third option.
//   * NOT AN INCOMPLETE FILE. An export with unreadable rows understates the
//     cumulative by whatever it could not read, which is the same defect in a
//     smaller dose and just as silent.
//
// All money is compared as INTEGER CENTS. stripe-capital.ts learnt this the
// expensive way — 4,000 rows of $0.005 reported $40.00 against a true $20.00 — and
// a cumulative sum is exactly where float drift accumulates fastest. "Exact to the
// cent" here means integer equality, not a tolerance.
//
// ─── WHAT THIS STILL CANNOT SEE, STATED RATHER THAN LEFT TO BE FOUND ────────
// The method proves that a running total EQUALS a figure. It cannot prove the two
// are measuring the same thing, and there is one shape where that matters: a
// screen showing a LATER period, whose period-to-date total happens to equal a
// cumulative-from-the-start somewhere in an earlier one. Three things stand
// against it — the running total passes each value once and only once, the match
// must fall on or after `periodStart`, and `corroborated` wants the split to land
// on the same day too — but none of them is a proof, and a caller that hands in a
// whole loan's ledger against a second period's figure is relying on all three.
// The right shape for that case is the caller's: hand in that period's days, and
// state what came before them with `openingCumulative`.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One day's withholding out of the lender's export.
 *
 * Structurally what stripe-capital.ts's StripeCsvDay carries, deliberately NOT
 * imported from it — see the header. `date` must be the date the BOOKS would call
 * it (Pacific for this lender, via utcStampToPacificDate); nothing here converts
 * or reasons about timezones, and a caller that hands in UTC dates gets a date
 * that is right for the wrong calendar.
 */
export interface LedgerDay {
  /** 'YYYY-MM-DD'. */
  date: string
  /** What the lender took that day, all in. Never negative. */
  total: number
  /** The two halves, when the export splits them. Null/absent when it does not. */
  financing?: number | null
  fee?: number | null
}

/** A figure to be dated, and the parts the screen states beside it. */
export interface LedgerDatingFigures {
  paid: number
  financing?: number | null
  fee?: number | null
}

export interface LedgerDatingInput {
  /** The export's days, in any order. One entry per day; duplicates are refused. */
  days: LedgerDay[]
  /**
   * False when the parse could not read every row. An incomplete export
   * understates the cumulative and therefore dates the screen LATE, so it is not
   * allowed to date anything at all. Same rule as settlement-lag.ts's
   * LenderExport.complete, and for the same reason.
   */
  complete: boolean
  /** The first day the export is complete FROM. */
  coversFrom: string
  /**
   * The first day of the period `target.paid` measures — the earliest day one of
   * its withholdings could fall on.
   *
   * Two jobs, and they are the two halves of the late-start refusal:
   *   1. the export must cover from on or before it, or the cumulative is missing
   *      its head (unless `openingCumulative` states that head outright);
   *   2. a match BEFORE it is refused, because a cumulative that reaches back into
   *      an earlier period crosses the target too early and the date it returns is
   *      a real date from the wrong period.
   *
   * It is a completeness gate, NOT a filter: every day handed in is counted. That
   * is deliberate and it is load-bearing on the real documents, where the
   * agreement's Repayment Start Date is 2026-07-07 and the export's first Pacific
   * day is 2026-07-06 — a sale at 04:01 UTC on the 7th is 21:01 on the 6th in the
   * calendar the books run on. Filtering to `date >= periodStart` would drop that
   * day's $60.41 and the cumulative would never again equal anything the screen
   * says. A caller dating a LATER period hands in that period's days only, and
   * says what came before it with `openingCumulative`.
   */
  periodStart: string
  /** What the screen states: the period-to-date total, and its parts if printed. */
  target: LedgerDatingFigures
  /**
   * What the period had already accumulated before `coversFrom`, when the caller
   * can state it from evidence of its own.
   *
   * This is the ONLY way past the coverage gate, and it is a claim, not a
   * convenience: passing zero asserts that nothing was withheld between the period
   * start and the first day of the file. loan-bundle-plan.ts deliberately never
   * passes it — it has no evidence for a non-zero head and does not need one,
   * because on that loan the export begins before repayment could start.
   */
  openingCumulative?: LedgerDatingFigures | null
}

/** Which figure agreed, named the way the screen names them. */
export type LedgerFigureName = 'paid_to_date' | 'financing_paid' | 'fee_paid'

export type LedgerDatingRefusal =
  /** No days at all, so there is nothing to measure against. */
  | 'no_export'
  /** Rows in the export could not be read, so its cumulative is short by an unknown amount. */
  | 'export_incomplete'
  /**
   * The ledger cannot be read as a ledger: a day is malformed, negative,
   * duplicated or does not add up, a coverage date is not a date, or the days
   * contradict the coverage the caller claims for them.
   */
  | 'unusable_days'
  /** The export begins after the period does and no opening cumulative was stated. */
  | 'coverage_starts_late'
  /** The screen's figure is missing, not a cent amount, or not positive. */
  | 'unusable_target'
  /** The cumulative is already past the target on the export's first day. */
  | 'target_precedes_export'
  /** The export's whole run never reaches the target. */
  | 'target_beyond_export'
  /** The target falls strictly between two days' cumulative totals. */
  | 'between_days'
  /** Two days share the target's cumulative total, so two dates fit equally. */
  | 'ambiguous'
  /** The only match is before the period the target measures. */
  | 'match_precedes_period'

export interface LedgerDatingNeighbour {
  date: string
  cumulative: number
  /** Cumulative less the target. Negative before the match, positive after. */
  difference: number
}

export interface LedgerDatingResult {
  /** The one day whose cumulative equals the target, or null. */
  date: string | null
  /** The figures that agreed to the cent on that day. */
  agreed: LedgerFigureName[]
  /** Figures the screen stated that the export CONTRADICTS on that day. */
  disagreed: LedgerFigureName[]
  /**
   * True only when the total agreed AND at least one part the screen states agreed
   * AND nothing the screen states disagreed.
   *
   * False on a total-only match is not an accusation — it means there was nothing
   * else on the screen to check, or the export does not split its days. The caller
   * decides what to do with that; see the recommendation in the header of §5b in
   * loan-bundle-plan.ts.
   */
  corroborated: boolean
  /** The running totals on the matched day. */
  cumulative: { paid: number; financing: number | null; fee: number | null } | null
  /** The days either side of the match, so a person can see how close the call was. */
  previous_day: LedgerDatingNeighbour | null
  next_day: LedgerDatingNeighbour | null
  covers: { from: string; through: string } | null
  refused_because: LedgerDatingRefusal | null
  /** The working, in plain English. Always populated, match or refusal. */
  statement: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Money and dates
// ─────────────────────────────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Dollars to integer cents, or null when the value is not a whole number of cents.
 *
 * The null case is a real guard, not paranoia. A sub-cent input silently rounded
 * into the sum is how stripe-capital.ts's 4,000 rows of $0.005 became $40.00
 * against a true $20.00 — and here it would be worse, because a sum that is a
 * fraction of a cent off compares UNEQUAL to a target that is exact and the whole
 * function reports "no day matches" for a file that matched perfectly.
 *
 * The tolerance is for the multiply itself, nothing else: 22783.34 * 100 is
 * 2278334.0000000002 in binary floating point, a few ulps out, while a genuine
 * sub-cent figure like $1.001 is 0.1 of a cent out — a thousand times further.
 */
function toCents(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const c = n * 100
  const r = Math.round(c)
  if (Math.abs(c - r) > 1e-4) return null
  if (!Number.isSafeInteger(r)) return null
  return r
}

const major = (cents: number) => cents / 100

// ─────────────────────────────────────────────────────────────────────────────
// The measurement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The date on which the lender's own cumulative withholdings equal the figure the
 * screen states, or null and why not.
 *
 * PURE. No I/O, no clock, no date arithmetic — dates are compared as ISO strings
 * and never constructed, so there is no second definition of what a day is to
 * disagree with utcStampToPacificDate().
 */
export function dateFromLedger(input: LedgerDatingInput): LedgerDatingResult {
  const refuse = (why: LedgerDatingRefusal, statement: string): LedgerDatingResult => ({
    date: null, agreed: [], disagreed: [], corroborated: false, cumulative: null,
    previous_day: null, next_day: null, covers: null, refused_because: why, statement,
  })

  const raw = Array.isArray(input.days) ? input.days : []
  if (!raw.length) {
    return refuse('no_export', 'There is no transaction export in this set, so there is nothing to date the screen against.')
  }
  if (input.complete !== true) {
    return refuse('export_incomplete',
      `Rows in this transaction export could not be read, so its running total is short by an unknown amount. An export that is missing payments dates a screen LATE — the total reaches the screen's figure some days after it really did — so it is not allowed to date one at all.`)
  }
  if (!ISO.test(String(input.coversFrom)) || !ISO.test(String(input.periodStart))) {
    return refuse('unusable_days',
      `The export's coverage (${input.coversFrom || 'none'}) or the period start (${input.periodStart || 'none'}) is not a calendar date, so nothing here can be judged complete.`)
  }

  // ── The days themselves ─────────────────────────────────────────────────
  const days: { date: string; total: number; financing: number | null; fee: number | null }[] = []
  const seen = new Set<string>()
  for (const d of raw) {
    const date = String(d?.date ?? '')
    if (!ISO.test(date)) {
      return refuse('unusable_days', `A day in this export is dated '${date || 'nothing'}', which is not a calendar date.`)
    }
    // A repeated date means the caller handed in transactions rather than days.
    // The sum would still be right and every other answer here would be wrong: two
    // rows for one date make "the day the total reaches X" two different days.
    if (seen.has(date)) {
      return refuse('unusable_days', `This export carries more than one entry for ${date}. It has to be totalled by day before a date can be read off it.`)
    }
    seen.add(date)
    const total = toCents(d?.total)
    if (total === null) {
      return refuse('unusable_days', `The withholding for ${date} is not a whole number of cents, so a running total built on it could never equal an exact figure off a screen.`)
    }
    // A negative day is a refund or a reversal, and it breaks the one property
    // every branch below rests on: that the running total only ever goes up. With a
    // dip in it the total can cross the screen's figure three times, "between two
    // days" stops meaning anything, and the ties this function refuses to resolve
    // become common rather than rare. stripe-capital.ts already rejects a positive
    // (i.e. reversed) paydown row outright and turns the whole file not-ok, so on
    // this lender it cannot arise; it is refused here so that it cannot arrive from
    // the next lender's parser either.
    if (total < 0) {
      return refuse('unusable_days', `${date} shows a negative withholding (${money(major(total))}). A running total that goes down can equal the screen's figure on more than one day, so this export cannot date anything.`)
    }
    const financing = d?.financing === null || d?.financing === undefined ? null : toCents(d.financing)
    const fee = d?.fee === null || d?.fee === undefined ? null : toCents(d.fee)
    if ((d?.financing !== null && d?.financing !== undefined && financing === null) ||
        (d?.fee !== null && d?.fee !== undefined && fee === null)) {
      return refuse('unusable_days', `The financing/fee split for ${date} is not a whole number of cents.`)
    }
    // Parts that do not add up to their own total are not a split, they are three
    // numbers. Corroborating a date against them would be corroborating against
    // arithmetic the export itself does not satisfy.
    if (financing !== null && fee !== null && financing + fee !== total) {
      return refuse('unusable_days',
        `${date} does not add up in the export: ${money(major(financing))} financing + ${money(major(fee))} fee is not ${money(major(total))}.`)
    }
    days.push({ date, total, financing, fee })
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  // A day earlier than the export's own stated coverage is a contradiction, and it
  // is the shape a mis-stated `coversFrom` takes — which is the one input the
  // coverage gate below cannot check for itself.
  if (days[0].date < input.coversFrom) {
    return refuse('unusable_days',
      `This export says it covers from ${input.coversFrom} but carries a withholding dated ${days[0].date}. One of the two is wrong, and the coverage check below is worthless until it is settled.`)
  }
  const covers = { from: input.coversFrom, through: days[days.length - 1].date }

  // ── The coverage gate. See the header: this is the refusal that would
  // otherwise return a real date from the wrong month. ────────────────────
  const opening = input.openingCumulative ?? null
  if (input.coversFrom > input.periodStart && !opening) {
    return refuse('coverage_starts_late',
      `This export begins ${input.coversFrom}, and the period the screen's figure covers begins ${input.periodStart}. Its running total is therefore missing everything withheld in between — an unknown amount — so it would reach the screen's figure days or weeks after the screen really did, and hand back a real date that is simply the wrong one. An export covering from ${input.periodStart} would date it.`)
  }

  // ── The target ──────────────────────────────────────────────────────────
  const targetPaid = toCents(input.target?.paid)
  if (targetPaid === null || targetPaid <= 0) {
    return refuse('unusable_target',
      `The screen does not state a usable amount paid to date (${input.target?.paid ?? 'nothing'}), and that figure is the whole measurement.`)
  }
  const targetFin = input.target?.financing === null || input.target?.financing === undefined ? null : toCents(input.target.financing)
  const targetFee = input.target?.fee === null || input.target?.fee === undefined ? null : toCents(input.target.fee)

  // The opening cumulative is a claim the caller is making about days this file
  // does not contain, so it is held to the same standard as the file: whole cents,
  // never negative, and a part it declines to state makes the running SPLIT
  // unknown rather than zero. Treating an unstated part as zero would let the
  // decomposition check pass against a number nobody supplied.
  const openPaid = opening ? toCents(opening.paid) : 0
  if (openPaid === null || openPaid < 0) {
    return refuse('unusable_target', `The opening cumulative offered for this period (${String(opening?.paid ?? 'nothing')}) is not a usable amount of money.`)
  }
  let openFin: number | null = 0, openFee: number | null = 0
  if (opening) {
    openFin = opening.financing === null || opening.financing === undefined ? null : toCents(opening.financing)
    openFee = opening.fee === null || opening.fee === undefined ? null : toCents(opening.fee)
    if ((opening.financing !== null && opening.financing !== undefined && openFin === null) ||
        (opening.fee !== null && opening.fee !== undefined && openFee === null)) {
      return refuse('unusable_target', `The opening cumulative's financing/fee split is not a whole number of cents.`)
    }
  }

  // ── Walk it ─────────────────────────────────────────────────────────────
  let paid = openPaid
  let fin: number | null = openFin
  let fee: number | null = openFee
  const running: { date: string; paid: number; financing: number | null; fee: number | null }[] = []
  for (const d of days) {
    paid += d.total
    fin = fin === null || d.financing === null ? null : fin + d.financing
    fee = fee === null || d.fee === null ? null : fee + d.fee
    running.push({ date: d.date, paid, financing: fin, fee })
  }

  const hits = running.filter(r => r.paid === targetPaid)

  if (hits.length > 1) {
    // Two dates fit equally. The ordinary way this happens is a day of zero
    // withholding straight after a match — a weekend on a card-receipts loan, a
    // pause, a lender that exports an empty day — and there is nothing in the
    // arithmetic to prefer either. Picking the first would be a tie-break wearing
    // reasoning's clothes.
    return refuse('ambiguous',
      `The export's running total is ${money(major(targetPaid))} on ${hits.length} different days (${hits.map(h => h.date).join(', ')}) — nothing was withheld in between — so it cannot say which of them the screen was showing.`)
  }

  if (!hits.length) {
    const first = running[0], last = running[running.length - 1]
    if (targetPaid < first.paid) {
      return refuse('target_precedes_export',
        `The screen says ${money(major(targetPaid))} has been paid, and the export's running total is already ${money(major(first.paid))} on its first day (${first.date}). The day the screen is describing is before this file begins.`)
    }
    if (targetPaid > last.paid) {
      return refuse('target_beyond_export',
        `The screen says ${money(major(targetPaid))} has been paid; this export runs to ${last.date} and only reaches ${money(major(last.paid))}, ${money(major(targetPaid - last.paid))} short. The screen is newer than the file, so a more recent export would date it.`)
    }
    // Strictly between two days. NOT rounded to the nearer one: the two candidates
    // below are two different dates, and picking the closer is a preference, not a
    // measurement. A gap like this normally means the screen and the export are not
    // counting the same thing — a different period start, a fee the export does not
    // carry — and that is a reason to stop, not to approximate.
    let before = running[0], after = running[running.length - 1]
    for (const r of running) { if (r.paid < targetPaid) before = r; else { after = r; break } }
    return refuse('between_days',
      `No day's running total is ${money(major(targetPaid))}. It stands at ${money(major(before.paid))} on ${before.date} and ${money(major(after.paid))} on ${after.date}, so the screen's figure falls between two days and no date can be read off it. Nothing here rounds to the nearer one — that would be a preference, not a measurement.`)
  }

  const hit = hits[0]
  const idx = running.indexOf(hit)

  // The match must be inside the period the target measures. When it is not, the
  // running total reached back into an EARLIER period and crossed the figure there
  // — the one failure of this method that returns a plausible date rather than
  // nothing. See `periodStart`.
  if (hit.date < input.periodStart) {
    return refuse('match_precedes_period',
      `The export's running total reaches ${money(major(targetPaid))} on ${hit.date}, which is before ${input.periodStart} — the period the screen's figure covers. That means the total was being added up from further back than the screen counts, so the date is not the screen's.`)
  }

  const prev = idx > 0 ? running[idx - 1] : null
  const next = idx < running.length - 1 ? running[idx + 1] : null
  const neighbour = (r: typeof hit | null): LedgerDatingNeighbour | null =>
    r ? { date: r.date, cumulative: major(r.paid), difference: major(r.paid - targetPaid) } : null

  // ── Which figures agreed ────────────────────────────────────────────────
  const agreed: LedgerFigureName[] = ['paid_to_date']
  const disagreed: LedgerFigureName[] = []
  if (targetFin !== null && hit.financing !== null) (targetFin === hit.financing ? agreed : disagreed).push('financing_paid')
  if (targetFee !== null && hit.fee !== null) (targetFee === hit.fee ? agreed : disagreed).push('fee_paid')
  const corroborated = agreed.length >= 2 && disagreed.length === 0

  // ── The working, so a person can check it rather than trust it ──────────
  // Deliberately FACTUAL rather than concluding — no "so this is the date". The
  // caller decides whether an uncorroborated match is enough (see `corroborated`),
  // and a sentence that has already announced the answer reads as a contradiction
  // when it is quoted inside a refusal.
  const parts: string[] = []
  parts.push(
    `Adding up every withholding in the lender's export from ${days[0].date} onwards, the running total is ${money(major(hit.paid))} — the amount the screen says has been paid — on ${hit.date}, and on no other day in the file.`)
  if (next) {
    parts.push(`By ${next.date} it stands at ${money(major(next.paid))}, ${money(major(next.paid - targetPaid))} further on.`)
  } else if (prev) {
    parts.push(`The day before (${prev.date}) it stood at ${money(major(prev.paid))}, ${money(major(targetPaid - prev.paid))} short.`)
  }
  if (agreed.includes('financing_paid') && agreed.includes('fee_paid')) {
    parts.push(
      `On that same day the running total splits ${money(major(hit.financing!))} financing and ${money(major(hit.fee!))} fee, which is what the screen's own two lines say, to the cent. ` +
      // Said out loud because the alternative is overselling it. The paid total is
      // the sum of the two parts on the screen AND in the export, so once two of
      // the three agree the third is arithmetic. Two independent agreements is
      // still far more than one; three would be a number this module made up.
      `(That is two independent agreements rather than three: the total is the sum of the two parts on both sides, so the third follows from the other two.)`)
  } else if (agreed.includes('financing_paid') || agreed.includes('fee_paid')) {
    const which = agreed.includes('fee_paid')
      ? `the ${money(major(hit.fee!))} fee` : `the ${money(major(hit.financing!))} financing`
    parts.push(`On that same day ${which} the screen states agrees with the export too.`)
  }
  if (disagreed.length) {
    parts.push(
      `But the screen's own split does NOT agree with the export's on that day: the screen says ` +
      `${targetFin !== null ? `${money(major(targetFin))} financing` : ''}${targetFin !== null && targetFee !== null ? ' and ' : ''}${targetFee !== null ? `${money(major(targetFee))} fee` : ''}` +
      `, the export says ${money(major(hit.financing ?? 0))} financing and ${money(major(hit.fee ?? 0))} fee. The two are measuring the payments differently, so the date they seem to share is not proven.`)
  } else if (agreed.length === 1) {
    parts.push(
      `Only one figure agreed — the amount paid. ${targetFin === null && targetFee === null
        ? `The screen states no split for the export to be checked against`
        : `The export does not split its days, so the screen's two lines could not be checked`}, so this date rests on a single equality.`)
  }

  return {
    date: hit.date,
    agreed, disagreed, corroborated,
    cumulative: {
      paid: major(hit.paid),
      financing: hit.financing === null ? null : major(hit.financing),
      fee: hit.fee === null ? null : major(hit.fee),
    },
    previous_day: neighbour(prev), next_day: neighbour(next),
    covers,
    refused_because: null,
    statement: parts.join(' '),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dating a screen that states what is still OWED (session 263)
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything above dates a figure that measures what has been PAID, because the
// screen that caused this module — Stripe Capital's — states amounts paid.
// PayPal's states the mirror image: principal still owed, fee still owed, and
// the two together. Its screen prints no as-of date either, and it was equally
// undatable, for a reason that turns out to be a missing three-line conversion
// rather than anything about the method:
//
//     paid so far  =  what the contract says is owed in total  −  what is owed now
//
// The identity is exact, and it is the LENDER's own arithmetic on both sides —
// its contract and its screen. So an outstanding balance becomes a paid figure
// and `dateFromLedger` dates it unchanged. There is deliberately no second
// dating engine here; a second one would drift from the first, and every refusal
// written above would have to be written again.
//
// WHAT THIS WILL NOT DO, and it is the whole reason it is a function rather than
// three lines at the call site:
//
//   * It never converts from a balance alone. The conversion needs the contract's
//     own opening figures, and a loan whose terms are not on file is refused
//     rather than dated off an assumed principal.
//   * It refuses terms that do not add up. If the advance plus the fee is not the
//     total repayment, the three fields do not describe one contract, and
//     choosing which two to believe is a guess with a date attached.
//   * It refuses a negative. A balance larger than the loan's own opening figure
//     means the screen and the terms are not about the same loan, or one of them
//     is misread. Either way the arithmetic is meaningless and returning it would
//     hand `dateFromLedger` a target it will politely fail to find.

/** The contract's opening figures. All three, because the conversion checks them. */
export interface LedgerOpeningTerms {
  /** The cash advanced. */
  loan_amount: number | null
  /** The whole fee, as the contract states it. */
  fixed_fee: number | null
  /** Advance plus fee — what the borrower repays in total. */
  total_repayment_amount: number | null
}

/** What an itemising screen states is still owed. */
export interface OutstandingBalances {
  principal_balance?: number | null
  fee_balance?: number | null
  total_balance?: number | null
}

export type OutstandingConversionRefusal =
  /** The contract's opening figures are not on file, so there is nothing to subtract from. */
  | 'no_terms'
  /** The terms on file do not add up, so they do not describe one contract. */
  | 'terms_disagree'
  /** The screen states no total still owed. */
  | 'no_balance'
  /** A figure is not a whole number of cents. */
  | 'unusable_amount'
  /** The conversion produced a negative amount paid. */
  | 'impossible_result'

export interface OutstandingConversion {
  /** Feed straight to `dateFromLedger`'s `target`. Null on any refusal. */
  target: LedgerDatingFigures | null
  refused_because: OutstandingConversionRefusal | null
  /** The working, in plain English. Always populated. */
  statement: string
}

/**
 * Turn "this much is still owed" into "this much has been paid", using the
 * contract's own opening figures. Integer cents throughout, same as everything
 * above — a conversion that introduced float drift would make an exact match
 * unreachable and the whole module would report "no day matches" on a file that
 * matches perfectly.
 */
export function paidFromOutstanding(
  balances: OutstandingBalances,
  terms: LedgerOpeningTerms,
): OutstandingConversion {
  const loanC = toCents(terms.loan_amount)
  const feeC = toCents(terms.fixed_fee)
  const totalC = toCents(terms.total_repayment_amount)

  if (totalC === null) {
    return { target: null, refused_because: 'no_terms',
      statement: `This loan's total repayment amount is not on file, so a balance still owed cannot be turned into an amount paid. Upload the agreement, or the lender's own statement of the loan's terms.` }
  }
  // The three figures must describe ONE contract. Where all three are on file and
  // the advance plus the fee is not the total, believing any two of them is a
  // guess — and a guess here comes back as a confident date.
  if (loanC !== null && feeC !== null && loanC + feeC !== totalC) {
    return { target: null, refused_because: 'terms_disagree',
      statement: `The terms on file do not add up: ${money(major(loanC))} advanced plus ${money(major(feeC))} of fee is ${money(major(loanC + feeC))}, not the ${money(major(totalC))} recorded as the total repayment. Nothing is dated from figures that contradict each other.` }
  }

  const totalBalC = toCents(balances.total_balance)
  const princBalC = toCents(balances.principal_balance)
  const feeBalC = toCents(balances.fee_balance)

  if (balances.total_balance != null && totalBalC === null) {
    return { target: null, refused_because: 'unusable_amount',
      statement: `The total still owed read off the screen is not a whole number of cents, so nothing was converted.` }
  }
  if (totalBalC === null) {
    return { target: null, refused_because: 'no_balance',
      statement: `This screen states no total still owed, so there is nothing to convert into an amount paid.` }
  }

  const paidC = totalC - totalBalC
  const financingC = (loanC !== null && princBalC !== null) ? loanC - princBalC : null
  const feePaidC = (feeC !== null && feeBalC !== null) ? feeC - feeBalC : null

  if (paidC < 0 || (financingC !== null && financingC < 0) || (feePaidC !== null && feePaidC < 0)) {
    return { target: null, refused_because: 'impossible_result',
      statement: `Converting this screen's balances against the loan's opening figures gives a negative amount paid, which cannot be true — the screen and the terms on file are not describing the same loan, or one of them has been misread. Nothing was dated.` }
  }

  const parts = [
    `${money(major(totalC))} owed in total less ${money(major(totalBalC))} still owed is ${money(major(paidC))} paid`,
    financingC !== null ? `${money(major(loanC!))} advanced less ${money(major(princBalC!))} still owed is ${money(major(financingC))} of financing paid` : null,
    feePaidC !== null ? `${money(major(feeC!))} of fee less ${money(major(feeBalC!))} still owed is ${money(major(feePaidC))} of fee paid` : null,
  ].filter(Boolean)

  return {
    target: { paid: major(paidC), financing: financingC === null ? null : major(financingC), fee: feePaidC === null ? null : major(feePaidC) },
    refused_because: null,
    statement: `${parts.join('; ')}. These are the figures the ledger is measured against.`,
  }
}
