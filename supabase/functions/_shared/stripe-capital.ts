// _shared/stripe-capital.ts — deterministic readers for Stripe Capital documents.
//
// Two documents, two very different parsing problems, one rule in common:
// EVERY figure returned here is either quoted verbatim from the document or
// proven by an arithmetic identity the document itself states. Nothing is
// inferred from position, and nothing is returned on a "best guess". When the
// evidence does not resolve, these functions say so in `unresolved` and omit
// the term. A parser that guesses is worse than no parser, because a guess
// enters the books wearing the same clothes as a fact.
//
// ─── WHY THE AGREEMENT NEEDS A CONSTRAINT SOLVER ────────────────────────────
// The Stripe Capital agreement's page-1 summary is a table, and pdf.js's text
// layer emits it as ALL THE LABELS, then ALL THE VALUES, in an order that has
// nothing to do with the visual layout:
//
//   ... Loan Amount  The amount of credit extended ...  Fixed Fee  The cost of
//   your Loan.  Total Repayment Amount ... Final Repayment Date**
//   1 July 7, 2026 $16,208.34 June 30, 2026 December 29, 2027 $0.00
//   $20,875.00 David Macquart-Moulin $145,875.00 Family Laundry
//   acct_1MPrRDGACgbvEugH $125,000.00 $125,000.00 8.00% 5215 Genoa Street ...
//
// `/Loan Amount\s*\$([\d,]+\.\d{2})/` against that text returns $16,208.34 —
// the Minimum Payment Amount — with total confidence and no error. That is the
// failure mode this module exists to make impossible.
//
// The values are unordered but not unconstrained. The document states its own
// arithmetic:
//   Total Repayment Amount = Loan Amount + Fixed Fee
//   Net Loan Proceeds      = Loan Amount − Prior Financing Balance
//   Repayment Start Date   = Origination Date + 7 days   (section 1, verbatim)
// So we solve for the assignment satisfying those identities and REFUSE unless
// it is unique.
//
// ─── HARDENING (session 242) ────────────────────────────────────────────────
// Two independent red teams attacked v1 of this file and found 20 defects. The
// ones worth remembering, because they are the shapes this code now exists to
// prevent:
//
//   * The first solver assumed "the larger of the two addends is the Loan
//     Amount". On a short-term advance whose fee EXCEEDS the principal it
//     silently swapped Loan Amount and Fixed Fee, at HIGH confidence, and the
//     "Net Proceeds" cross-check certified the swap — because that check
//     included the loan amount in its own candidate list, making it vacuous
//     whenever a $0.00 prior balance appeared (which is every non-refinance
//     agreement). 870 of 4,000 fuzzed agreements came back confidently wrong.
//     Now BOTH orientations are tested against distinct leftover slots and a
//     term is only claimed when exactly one survives.
//
//   * A single newline inside a quoted CSV description FABRICATED a payment,
//     because records were split on /\n/ before the quote scanner ever ran. One
//     real $10 payment became $510. Record splitting is quote-aware now.
//
//   * A reversal exported as a POSITIVE paydown was counted as another payment,
//     because Math.abs() ran before anything checked the sign.
//
//   * Money was accumulated as floats with a round-to-cents at every step, so
//     sub-cent inputs compounded — 4,000 rows of $0.005 reported $40.00 against
//     a true $20.00. All money is parsed straight from its decimal STRING into
//     integer cents now and never touches a float until it is returned.
//
//   * `Number('-1,234.56')` is NaN, so a thousands separator silently moved
//     real payments into a rejected list that was truncated at 50 entries while
//     the result still said ok:true. Rejections are counted in full and any
//     rejection makes the file not-ok, because an unexplained row is
//     unexplained money.

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TermConfidence = 'high' | 'medium' | 'low'

export interface ContractTerm {
  term_key: string
  value_numeric?: number | null
  value_date?: string | null   // ISO YYYY-MM-DD
  value_text?: string | null
  /** The verbatim run of document text this was read out of. Never synthesised. */
  source_text: string
  /** The identity that pins this value to this key, in plain English. */
  basis: string
  confidence: TermConfidence
}

export interface AgreementParseResult {
  ok: boolean
  lender_label: string
  terms: ContractTerm[]
  /** Identities that were checked and held. Shown to the human as proof. */
  checks_passed: string[]
  /**
   * Terms the document appears to contain but which could not be pinned to a
   * value with confidence. Never empty just because a term was dropped: a term
   * vanishing silently is indistinguishable from a document that never had one.
   */
  unresolved: string[]
  /** Why the parse was refused, when ok === false. Never a partial answer. */
  refused_because: string | null
  values_seen: { money: number[]; percents: number[]; dates: string[] }
}

export interface StripeCsvRow {
  date: string          // Pacific calendar date
  total_minor: number   // positive integer cents
  principal_minor: number
  fee_minor: number
}

export interface StripeCsvMonth {
  month: string         // 'YYYY-MM' Pacific
  transaction_count: number
  total_paid: number
  principal_paid: number
  fee_paid: number
  first_date: string
  last_date: string
}

/**
 * One Pacific calendar day's withholding, added session 245.
 *
 * WHY A DAY AND NOT A MONTH. A month total divided by its days is a MEAN, and a
 * mean is the wrong shape for this lender: Stripe withholds a percentage of each
 * sale, so what it takes in a day is whatever the sales were. Across this
 * export's own 26 days the daily figure runs $28.40 to $694.44 — a 24x swing
 * around a $430.47 mean. settlement-lag.ts needs the withholding of a specific
 * few days, and there is no way back to that from a month.
 *
 * The dates are Pacific, from the same utcStampToPacificDate() the months use,
 * so a day here is the day the books would call it.
 */
export interface StripeCsvDay {
  date: string          // 'YYYY-MM-DD' Pacific
  transaction_count: number
  total_paid: number
  principal_paid: number
  fee_paid: number
}

export interface StripeCsvParseResult {
  ok: boolean
  lender_label: string
  /** Data records found in the file, however malformed. */
  rows_in_file: number
  /** Rows accepted into the totals. */
  rows_accepted: number
  /** Full count of rows that could NOT be read. Not the length of the sample. */
  rows_rejected_count: number
  /**
   * Rows deliberately not counted because they are not repayments — an advance,
   * a fee line, a reversal. Kept separate from rejections: one of these is an
   * excluded row, the other is unexplained money, and conflating them made a
   * single advance line turn ok false and print "N rows could not be read. Every
   * unread row is a payment this file cannot account for" about rows that are
   * not payments at all.
   */
  rows_skipped_not_applicable: number
  /** At most 50, for display. */
  rows_rejected_sample: { line: number; reason: string }[]
  currency: string | null
  months: StripeCsvMonth[]
  /**
   * The same accepted rows totalled by Pacific calendar day (session 245).
   * Additive: every field that was here before is unchanged, and a consumer that
   * only reads `months` sees exactly what it saw before. See StripeCsvDay for why
   * a month total cannot answer the question this one exists for.
   */
  days: StripeCsvDay[]
  totals: { total_paid: number; principal_paid: number; fee_paid: number } | null
  first_date: string | null
  last_date: string | null
  /** The accepted rows, so a downstream check tests the same population. */
  accepted: StripeCsvRow[]
  refused_because: string | null
}

export interface DecompositionResult {
  holds: boolean
  fee_over_total: number | null
  rows_checked: number
  rows_failing: number
  note: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Money, without floats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a money string to integer minor units (cents), or null.
 *
 * Deliberately strict, and deliberately string-based. `Number()` accepts things
 * that are not money ('', '0x10', 'Infinity') and rejects things that are
 * ('-1,234.56'), and every float round-trip is a chance to lose a cent. This
 * reads the digits.
 *
 * Accepts:  -1234.56  |  -1,234.56  |  $1,234.56  |  (1,234.56) accounting
 * Rejects:  '' | '  ' | 'abc' | '1.234' (3dp) | '1.234,56' (euro) | Infinity
 */
export function parseMoneyToMinor(raw: unknown, opts: { decimals?: number } = {}): number | null {
  const dp = opts.decimals ?? 2
  let s = String(raw ?? '').trim()
  if (!s) return null

  let neg = false, paren = false
  // Accounting parentheses.
  if (/^\(.*\)$/.test(s)) { neg = true; paren = true; s = s.slice(1, -1).trim() }
  s = s.replace(/^\$/, '').replace(/^-\$/, '-').trim()
  // A sign INSIDE accounting parentheses is a contradiction, not a double negative.
  if (paren && (s.startsWith('-') || s.startsWith('+'))) return null
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1).trim() }
  if (s.startsWith('+')) s = s.slice(1).trim()
  s = s.replace(/^\$/, '').trim()

  // Whole part may carry comma groups; fraction must be exactly `dp` digits if
  // present. A 3-decimal figure is NOT truncated to 2 — it is refused, because
  // truncating is how '$125.000,00' became $125.00 in the euro-format attack.
  const m = /^(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) return null
  const whole = m[1].replace(/,/g, '')
  const frac = m[2] ?? ''
  if (frac.length > dp) return null
  const padded = (frac + '0'.repeat(dp)).slice(0, dp)
  const minor = Number(whole) * Math.pow(10, dp) + Number(padded)
  if (!Number.isSafeInteger(minor)) return null
  return neg ? -minor : minor
}

/** Integer minor units back to a float dollar amount, once, at the end. */
export function minorToMajor(minor: number, decimals = 2): number {
  return minor / Math.pow(10, decimals)
}

/**
 * Round half-up to cents, on the DECIMAL representation rather than the binary.
 *
 * The previous implementation was `Math.sign(n) * Math.round((Math.abs(n) +
 * Number.EPSILON) * 100) / 100`. EPSILON is 2.22e-16; the ULP at $2.00 is
 * already 4.44e-16, so the epsilon was a literal no-op for every amount at or
 * above $2 and `cents()` silently did banker's-adjacent rounding there:
 * 2.135 → 2.13, 4.015 → 4.01, 8.165 → 8.16. It repaired the smallest 11% of
 * half-up cases and gave a false sense of safety about the other 89%.
 */
export function cents(n: number): number {
  if (!Number.isFinite(n)) return NaN
  if (Math.abs(n) >= 1e21) return n   // past here toFixed()/String() go exponential; far beyond cent precision anyway
  // Round ONCE, on the shortest decimal that round-trips to this double.
  //
  // The previous version did `n.toFixed(3)` first and then applied half-up to the
  // third digit — two roundings. Any true value in [x.xx45, x.xx50) was lifted to
  // x.xx5 by toFixed and then rounded UP again: cents(545.4545454545454) returned
  // 545.46 for a true 545.45, and cents(9.99499) returned 10.00 for a true 9.99.
  // That is 5% of ratio-shaped values — i.e. exactly the fee-split arithmetic this
  // module exists to do. String(n) is the shortest round-tripping decimal, so
  // 2.135 still reads as "2.135" (and rounds up to 2.14) while a genuine long
  // ratio keeps all of its digits and is rounded only once.
  let s = String(Math.abs(n))
  if (s.includes('e') || s.includes('E')) s = Math.abs(n).toFixed(20)
  const [i, f = ''] = s.split('.')
  const frac = (f + '000').slice(0, 3)
  let c = BigInt(i) * 100n + BigInt(frac.slice(0, 2))
  if (Number(frac[2]) >= 5) c += 1n
  const out = Number(c) / 100
  return n < 0 ? -out : out
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

/** 'June 30, 2026' -> '2026-06-30'. Null on anything else. */
export function longDateToIso(s: string): string | null {
  const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/)
  if (!m) return null
  const mo = MONTHS[m[1].toLowerCase()]
  if (!mo) return null
  const d = Number(m[2])
  if (d < 1 || d > 31) return null
  const iso = `${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null
  return iso
}

/** Whole days between two ISO dates, b − a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000)
}

/**
 * A UTC timestamp's calendar date in America/Los_Angeles.
 *
 * This matters more than it looks. Stripe exports 'Effective Time (UTC)'; the
 * books run on Pacific. In UTC the July file straddles two months — three rows
 * land in August and July is understated by $28.84. In Pacific it is exactly
 * 2026-07-06 to 2026-07-31, 1,352 rows, one clean month. Get this wrong at a
 * month end and payments are booked into the wrong period, which no downstream
 * invariant catches.
 *
 * Intl, not a fixed offset, so DST is the platform's problem. Verified against
 * Python zoneinfo across 191,472 instants including every DST transition
 * 2020–2031: zero mismatches.
 *
 * Validation is a round-trip, because `Date.UTC` never returns NaN for numeric
 * arguments — it rolls over. '2026-06-31' silently became 2026-07-01, booking a
 * payment into the wrong month with no error at all.
 */
export function utcStampToPacificDate(stamp: string): string | null {
  // Anchored at both ends: a trailing offset ('12:00:00-07:00') must be refused,
  // not silently read as UTC.
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?Z?$/.exec(String(stamp).trim())
  if (!m) return null
  const [Y, Mo, D, H, Mi, S] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)]
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) return null
  const d = new Date(Date.UTC(Y, Mo - 1, D, H, Mi, S))
  if (d.getUTCFullYear() !== Y || d.getUTCMonth() !== Mo - 1 || d.getUTCDate() !== D) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// ─────────────────────────────────────────────────────────────────────────────
// The agreement
// ─────────────────────────────────────────────────────────────────────────────

const SUMMARY_ANCHOR = /Final\s+Repayment\s+Date\s*\*\*/gi
const FOOTNOTE_ANCHOR = /\*\s*If\s+you\s+have\s+a\s+Prior\s+Outstanding\s+Balance/i
const SPECIMEN = /illustrat\w*|example only|for example purposes|specimen|sample agreement|not an offer|do not sign/i

export function detectStripeCapitalAgreement(text: string): boolean {
  return /Stripe\s+Capital\s+Program/i.test(text)
    && /Loan\s+Agreement/i.test(text)
    && /Total\s+Repayment\s+Amount/i.test(text)
}

export function parseStripeCapitalAgreement(text: string): AgreementParseResult {
  const label = 'Stripe Capital loan agreement'
  const empty = { money: [] as number[], percents: [] as number[], dates: [] as string[] }
  const refuse = (why: string, seen = empty): AgreementParseResult => ({
    ok: false, lender_label: label, terms: [], checks_passed: [], unresolved: [],
    refused_because: why, values_seen: seen,
  })

  if (!detectStripeCapitalAgreement(text)) {
    return refuse('This is not a Stripe Capital loan agreement.')
  }
  // A brochure or specimen carries a complete-looking table with invented
  // figures. Parsing one would put a fictional loan on the books.
  if (SPECIMEN.test(text)) {
    return refuse('This document is marked as an illustration, example or specimen, so its figures are not a real loan.')
  }

  // A keyword blocklist alone is not a defence: a brochure carrying a complete
  // illustrative table but none of the words above parsed as a real $10,000 loan.
  // So require a POSITIVE signal that this document is about an identified
  // borrower -- a real Stripe account id. Marketing copy carries 'acct_EXAMPLE'
  // or no id at all. This is the parser's half; the bundle engine's half is that
  // an agreement must match an existing loan account before any term is written.
  if (!/\bacct_[A-Za-z0-9]{16,}/.test(text)) {
    return refuse('This document does not carry a Stripe account ID, so there is nothing identifying whose loan it is. A real executed agreement always names the borrower account.')
  }

  // More than one summary block means more than one agreement in the file — a
  // refinance packet, typically. text.search() would silently return the FIRST,
  // i.e. the superseded loan.
  const anchors = [...text.matchAll(SUMMARY_ANCHOR)]
  if (anchors.length === 0) return refuse('Could not locate the Financing Summary block on page 1.')
  if (anchors.length > 1) {
    return refuse(`This file contains ${anchors.length} loan agreements. Split it and upload the current agreement on its own — reading the first one would file a superseded loan.`)
  }
  const start = anchors[0].index!
  const footIdx = text.slice(start).search(FOOTNOTE_ANCHOR)
  // No character-count fallback. A fixed slice pulls body text into the solve,
  // and body dollar figures and dates then displace real terms while every
  // arithmetic check still passes.
  if (footIdx === -1) {
    return refuse('The Financing Summary does not end with the expected footnote, so its boundary cannot be established. Refusing rather than reading an arbitrary slice of the document.')
  }
  const run = text.slice(start, start + footIdx)
  if (!run.trim()) return refuse('The Financing Summary block is empty.')

  // ── Collect typed values ─────────────────────────────────────────────────
  // Strict: exactly two decimal places, optional comma grouping, no digit may
  // follow. '$1,234.567' and '$125.000,00' must FAIL to match rather than match
  // wrongly — a locale misread produced a self-consistent 1000x-wrong triple
  // that passed every downstream check.
  const MONEY_STRICT = /(-?)\$\s*(-?)(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?![\d]|[.,]\d)/g
  const MONEY_LOOSE = /\$\s*-?\s*\d[\d.,]*/g

  const money: number[] = []
  let sawNegative = false
  for (const m of run.matchAll(MONEY_STRICT)) {
    const minor = parseMoneyToMinor(`${m[3]}.${m[4]}`)
    if (minor === null) continue
    if (m[1] === '-' || m[2] === '-') { sawNegative = true }
    money.push(minorToMajor(minor))
  }
  // Any $-figure the strict pattern could not read is a reason to stop, not to
  // ignore: it is a number in the summary we do not understand.
  const looseCount = [...run.matchAll(MONEY_LOOSE)].length
  const percents = [...run.matchAll(/(\d+(?:\.\d+)?)\s?%/g)].map(m => Number(m[1]))
  const dateStrings = [...run.matchAll(/\b([A-Za-z]+\s+\d{1,2},\s*\d{4})\b/g)].map(m => m[1])
  const dates = dateStrings.map(longDateToIso).filter((d): d is string => !!d)
  const seen = { money, percents, dates }

  if (looseCount !== money.length) {
    return refuse(`The Financing Summary contains ${looseCount} dollar figures but only ${money.length} are in a readable format. Refusing rather than solving against a partial set.`, seen)
  }
  if (sawNegative) {
    return refuse('The Financing Summary contains a negative amount, which this reader does not know how to place. A credit must not be silently promoted to a payment obligation.', seen)
  }
  if (money.length < 4) return refuse(`Only ${money.length} money values found in the summary; expected at least 4.`, seen)

  // ── Identity 1: Total Repayment = Loan Amount + Fixed Fee ────────────────
  // Both addends strictly positive, neither equal to the sum — otherwise a
  // $0.00 prior balance makes every value trivially solve against itself.
  const triples: { a: number; b: number; sum: number }[] = []
  for (let i = 0; i < money.length; i++) {
    for (let j = i + 1; j < money.length; j++) {
      const a = money[i], b = money[j]
      if (a <= 0 || b <= 0) continue
      const sum = cents(a + b)
      if (Math.abs(sum - a) < 0.005 || Math.abs(sum - b) < 0.005) continue
      if (money.some(v => Math.abs(v - sum) < 0.005)) triples.push({ a, b, sum })
    }
  }
  const candidates = [...new Map(triples.map(t => {
    const [lo, hi] = t.a <= t.b ? [t.a, t.b] : [t.b, t.a]
    return [`${lo}|${hi}|${t.sum}`, { lo, hi, sum: t.sum }]
  })).values()]

  if (candidates.length === 0) {
    return refuse('No two summary amounts add up to a third, so Loan Amount + Fixed Fee = Total Repayment could not be confirmed.', seen)
  }

  // ── Identity 2: Net Loan Proceeds = Loan Amount − Prior Financing Balance ─
  // Run against DISTINCT LEFTOVER SLOTS and test BOTH orientations. The v1 bug:
  // the candidate list included the loan amount itself, so prior===loan gave
  // net===0, and the $0.00 prior balance present on every non-refinance
  // agreement satisfied it unconditionally. It confirmed whatever it was given.
  const orient = (loan: number, fee: number, sum: number) => {
    const left = subtractMultiset(money, [loan, fee, sum])
    const found: { prior: number; net: number }[] = []
    for (const prior of left) {
      const net = cents(loan - prior)
      const rest = subtractMultiset(left, [prior])
      if (!rest.some(v => Math.abs(v - net) < 0.005)) continue
      // `loan - prior = net` is SYMMETRIC in (prior, net): if (p, n) satisfies it
      // then so does (n, p). The mirror where prior === loan (so net === $0.00) is
      // the vacuous self-subtraction this module already refuses to be convinced
      // by, so it is dropped; anything else that survives is a real rival reading.
      if (Math.abs(prior - loan) < 0.005) continue
      if (!found.some(f => Math.abs(f.prior - prior) < 0.005)) found.push({ prior, net })
    }
    return found.length ? { ...found[0], rivals: found } : null
  }

  const solved: { loan: number; fee: number; sum: number; prior: number; net: number; rivals: { prior: number; net: number }[] }[] = []
  let ambiguousCandidates = 0
  for (const c of candidates) {
    const asHi = orient(c.hi, c.lo, c.sum)
    const asLo = orient(c.lo, c.hi, c.sum)
    if (asHi && asLo) ambiguousCandidates++
    else if (asHi) solved.push({ loan: c.hi, fee: c.lo, sum: c.sum, ...asHi })
    else if (asLo) solved.push({ loan: c.lo, fee: c.hi, sum: c.sum, ...asLo })
  }
  // A candidate that satisfies BOTH orientations is still a live reading of the
  // summary. Taking a different candidate just because it happened to resolve is
  // picking "the least ambiguous alternative", not the one the document supports.
  if (solved.length === 1 && ambiguousCandidates > 0) {
    return refuse(`${1 + ambiguousCandidates} different pairs of amounts in the Financing Summary each add up to a third, and only one of them narrows to a single orientation. Refusing rather than reading the one that happened to resolve.`, seen)
  }

  const unresolved: string[] = []
  const checks: string[] = []
  let loanAmount: number, fixedFee: number, totalRepayment: number
  let amountConfidence: TermConfidence
  let priorBalance: number | null = null
  let netProceeds: number | null = null
  let priorNetRivals: { prior: number; net: number }[] = []

  if (solved.length === 1) {
    ({ loan: loanAmount, fee: fixedFee, sum: totalRepayment, prior: priorBalance, net: netProceeds } = solved[0])
    priorNetRivals = solved[0].rivals
    amountConfidence = 'high'
    checks.push(`Loan Amount + Fixed Fee = Total Repayment Amount — $${fmt(loanAmount)} + $${fmt(fixedFee)} = $${fmt(totalRepayment)}.`)
    checks.push(`Net Loan Proceeds = Loan Amount − Prior Financing Balance — $${fmt(loanAmount)} − $${fmt(priorBalance!)} = $${fmt(netProceeds!)}. This is what confirms which of the two amounts is the Loan Amount and which is the Fixed Fee, rather than assuming the fee is the smaller one.`)
  } else if (solved.length > 1) {
    return refuse(`${solved.length} different readings of the Financing Summary all satisfy the agreement's own arithmetic. Refusing rather than picking one.`, seen)
  } else if (candidates.length === 1) {
    // The sum identity holds but the orientation could not be confirmed. Report
    // the amounts at LOW confidence with the ambiguity named, rather than
    // guessing "the fee is the smaller one" — which is only conventionally true
    // and is wrong on expensive short-term advances.
    loanAmount = candidates[0].hi; fixedFee = candidates[0].lo; totalRepayment = candidates[0].sum
    amountConfidence = 'low'
    checks.push(`Loan Amount + Fixed Fee = Total Repayment Amount — $${fmt(candidates[0].hi)} + $${fmt(candidates[0].lo)} = $${fmt(candidates[0].sum)}.`)
    unresolved.push(`Which of $${fmt(candidates[0].hi)} and $${fmt(candidates[0].lo)} is the Loan Amount and which is the Fixed Fee could not be confirmed from the document's own arithmetic — the Net Loan Proceeds identity did not resolve. They are reported the conventional way round (larger = Loan Amount) at low confidence and must be checked against the document by eye.`)
  } else {
    return refuse(`${candidates.length} different pairs of amounts each add up to a third value and none could be confirmed by the Net Loan Proceeds identity, so which pair is Loan Amount + Fixed Fee is ambiguous.`, seen)
  }

  // ── Identity 3: the dates ────────────────────────────────────────────────
  const distinctDates = [...new Set(dates)].sort()
  let origination: string | null = null
  let repaymentStart: string | null = null
  let finalRepayment: string | null = null
  let dateConfidence: TermConfidence = 'high'

  if (dateStrings.length !== dates.length) {
    unresolved.push(`${dateStrings.length - dates.length} date-like strings in the Financing Summary could not be read as calendar dates, so the term dates are not reported.`)
  } else if (distinctDates.length !== 3) {
    // Only `< 3` was checked in v1. A fourth long-form date — a signature line,
    // a "as of January 1, 2026" — displaced a real term date at HIGH
    // confidence, and the 7-day rule then certified the wrong pair.
    unresolved.push(`The Financing Summary contains ${distinctDates.length} distinct dates; exactly 3 are expected (Origination, Repayment Start, Final Repayment). The term dates are not reported, because sorting ${distinctDates.length} dates into 3 named slots would be a guess.`)
  } else {
    origination = distinctDates[0]
    repaymentStart = distinctDates[1]
    finalRepayment = distinctDates[2]

    const gap = daysBetween(origination, repaymentStart)
    const ruleStated = /seven\s*\(?\s*7?\s*\)?\s*days\s+after\s+the\s+Origination\s+Date/i.test(text)
    if (ruleStated && gap === 7) {
      checks.push(`Repayment Start Date is 7 days after the Origination Date (${origination} → ${repaymentStart}), which is the rule this agreement states in section 1.`)
    } else if (ruleStated) {
      dateConfidence = 'medium'
      unresolved.push(`The agreement says repayment starts 7 days after origination, but the two earliest summary dates are ${gap} days apart (${origination} → ${repaymentStart}). The dates are reported at reduced confidence.`)
    } else {
      // v1 raised confidence when the rule text was ABSENT — no corroboration
      // was read as no problem. Inverted: no corroboration means no confidence.
      dateConfidence = 'medium'
      unresolved.push('This agreement does not state the "repayment starts 7 days after origination" rule, so there was nothing to check the date assignment against. The dates are reported at reduced confidence.')
    }
    if (finalRepayment <= repaymentStart) {
      unresolved.push(`Final Repayment Date (${finalRepayment}) is not after the Repayment Start Date (${repaymentStart}); the date assignment cannot be trusted and the dates are not reported.`)
      origination = repaymentStart = finalRepayment = null
    }
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  const terms: ContractTerm[] = []
  const src = run.replace(/\s+/g, ' ').trim().slice(0, 900)
  const push = (t: ContractTerm) => terms.push(t)

  push({ term_key: 'loan_amount', value_numeric: loanAmount, source_text: src,
         basis: 'Solved from Loan Amount + Fixed Fee = Total Repayment Amount, with the orientation fixed by the Net Loan Proceeds identity', confidence: amountConfidence })
  push({ term_key: 'fixed_fee', value_numeric: fixedFee, source_text: src,
         basis: 'The other addend of the Total Repayment Amount', confidence: amountConfidence })
  push({ term_key: 'total_repayment_amount', value_numeric: totalRepayment, source_text: src,
         basis: 'The sum the other two amounts add up to', confidence: 'high' })
  if (netProceeds !== null && priorNetRivals.length > 1) {
    unresolved.push(`The Financing Summary's own arithmetic cannot tell the Prior Financing Balance from the Net Loan Proceeds: $${fmt(priorNetRivals[0].prior)} and $${fmt(priorNetRivals[0].net)} satisfy Loan Amount − Prior = Net either way round. Net Loan Proceeds is reported at reduced confidence and must be read off the document by eye.`)
    push({ term_key: 'net_loan_proceeds', value_numeric: netProceeds, source_text: src,
           basis: 'One of the two summary amounts that satisfy Loan Amount less Prior Financing Balance; the identity is symmetric and does not say which', confidence: 'low' })
  } else if (netProceeds !== null) {
    push({ term_key: 'net_loan_proceeds', value_numeric: netProceeds, source_text: src,
           basis: 'Loan Amount less the Prior Financing Balance, both confirmed by the same identity', confidence: 'high' })
  }

  // Minimum Payment Amount: only claimed when exactly one money slot remains.
  const consumed = [loanAmount, fixedFee, totalRepayment]
  if (priorBalance !== null) consumed.push(priorBalance)
  if (netProceeds !== null) consumed.push(netProceeds)
  const remaining = subtractMultiset(money, consumed).filter(v => v > 0)
  if (remaining.length === 1) {
    push({ term_key: 'minimum_payment_amount', value_numeric: remaining[0], source_text: src,
           basis: 'The only summary amount not accounted for by Loan Amount, Fixed Fee, Total Repayment, Prior Financing Balance and Net Loan Proceeds', confidence: 'high' })
  } else if (remaining.length > 1) {
    unresolved.push(`${remaining.length} summary amounts remain unaccounted for ($${remaining.map(fmt).join(', $')}), so the Minimum Payment Amount could not be identified.`)
  } else {
    unresolved.push('No summary amount was left over to be the Minimum Payment Amount. If the document shows one, a dollar figure in the summary block was not read.')
  }

  if (percents.length === 1) {
    push({ term_key: 'repayment_rate_percent', value_numeric: percents[0], source_text: src,
           basis: 'The only percentage in the Financing Summary', confidence: 'high' })
  } else if (percents.length > 1) {
    unresolved.push(`The Financing Summary contains ${percents.length} percentages (${percents.join('%, ')}%), so the Repayment Rate could not be identified.`)
  }

  if (origination) {
    push({ term_key: 'origination_date', value_date: origination, source_text: src,
           basis: 'Earliest of the three summary dates', confidence: dateConfidence })
    push({ term_key: 'repayment_start_date', value_date: repaymentStart, source_text: src,
           basis: 'Middle of the three summary dates', confidence: dateConfidence })
    push({ term_key: 'final_repayment_date', value_date: finalRepayment, source_text: src,
           basis: 'Latest of the three summary dates', confidence: dateConfidence })
  }

  const periodMatch = run.match(/Every\s+(\d+)\s+days/i)
  if (periodMatch) {
    push({ term_key: 'minimum_payment_period_days', value_numeric: Number(periodMatch[1]),
           source_text: periodMatch[0], basis: 'Stated verbatim in the Minimum Payment Period field', confidence: 'high' })
  }

  // Real Stripe account ids are ~21 chars of mixed case. A brochure's 'acct_EXAMPLE'
  // or 'acct_1234' must not read as a borrower identity -- see the borrower-identity
  // gate above, which this feeds.
  const acct = run.match(/\bacct_[A-Za-z0-9]{16,}/)
  if (acct) {
    push({ term_key: 'lender_account_ref', value_text: acct[0], source_text: acct[0],
           basis: 'The Stripe Account ID, matched by its acct_ prefix', confidence: 'high' })
  }

  const bank = text.match(/being\s+offered\s+by\s+([A-Z][A-Za-z .,&-]{2,40}?)\s*\./)
  if (bank) {
    push({ term_key: 'originating_bank', value_text: bank[1].trim(), source_text: bank[0],
           basis: 'Named as the offering bank on page 1', confidence: 'high' })
  }

  return { ok: true, lender_label: label, terms, checks_passed: checks, unresolved, refused_because: null, values_seen: seen }
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Remove each of `remove` from `from` once (multiset difference). */
function subtractMultiset(from: number[], remove: number[]): number[] {
  const out = [...from]
  for (const r of remove) {
    const i = out.findIndex(v => Math.abs(v - r) < 0.005)
    if (i >= 0) out.splice(i, 1)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The transaction export
// ─────────────────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'Effective Time (UTC)', 'Currency', 'Total amount',
  'Financing amount', 'Fee amount', 'Transaction type', 'Transaction description',
]

/**
 * Split a CSV document into records, honouring quoted fields that span lines.
 *
 * v1 did `text.split(/\r?\n/)` first, so `splitCsvLine` never got the chance to
 * see a quote spanning a newline. A description containing a line break made
 * one $10.00 payment parse as two rows totalling $510.00 — money fabricated out
 * of a text field, ok:true, zero rejections.
 */
export function splitCsvRecords(text: string): string[] {
  return splitCsvRecordsChecked(text).records
}

/** Records, plus whether the file ended inside an unclosed quote. */
export function splitCsvRecordsChecked(text: string): { records: string[]; unterminatedQuote: boolean } {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQ) {
      cur += ch
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      }
      continue
    }
    if (ch === '"') { inQ = true; cur += ch; continue }
    if (ch === '\r') { if (text[i + 1] === '\n') continue; out.push(cur); cur = ''; continue }
    if (ch === '\n') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.length) out.push(cur)
  return { records: out.filter(r => r.trim().length), unterminatedQuote: inQ }
}

/** Minimal RFC4180 field splitter for one record. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false }
      else cur += ch
    } else if (ch === '"') inQ = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

function headerCells(record: string): string[] {
  // Strip a UTF-8 BOM explicitly rather than relying on trim() happening to
  // treat U+FEFF as whitespace.
  return splitCsvLine(record.replace(/^﻿/, '')).map(c => c.trim())
}

export function detectStripeCapitalCsv(text: string): boolean {
  const recs = splitCsvRecords(text)
  if (!recs.length) return false
  const cols = headerCells(recs[0])
  return CSV_HEADERS.every(h => cols.includes(h))
}

export function parseStripeCapitalCsv(text: string): StripeCsvParseResult {
  const label = 'Stripe Capital transaction export'
  const base: StripeCsvParseResult = {
    ok: false, lender_label: label, rows_in_file: 0, rows_accepted: 0,
    rows_rejected_count: 0, rows_skipped_not_applicable: 0,
    rows_rejected_sample: [], currency: null, months: [], days: [],
    totals: null, first_date: null, last_date: null, accepted: [], refused_because: null,
  }
  if (!detectStripeCapitalCsv(text)) {
    return { ...base, refused_because: 'Header row does not match a Stripe Capital transaction export.' }
  }

  const split = splitCsvRecordsChecked(text)
  if (split.unterminatedQuote) {
    return { ...base, refused_because: 'This export ends inside an unclosed quotation mark, so every row after it was absorbed into a single record. Refusing rather than publishing a total that is silently missing payments.' }
  }
  const recs = split.records
  const header = headerCells(recs[0])

  // A duplicated column would make indexOf pick one arbitrarily.
  const dupes = header.filter((h, i) => CSV_HEADERS.includes(h) && header.indexOf(h) !== i)
  if (dupes.length) {
    return { ...base, refused_because: `The export has more than one '${dupes[0]}' column, so which one carries the figures is ambiguous.` }
  }

  const iTime = header.indexOf('Effective Time (UTC)')
  const iCur = header.indexOf('Currency')
  const iTotal = header.indexOf('Total amount')
  const iFin = header.indexOf('Financing amount')
  const iFee = header.indexOf('Fee amount')
  const iType = header.indexOf('Transaction type')

  const rejected: { line: number; reason: string }[] = []
  let rejectedCount = 0, skippedCount = 0
  const reject = (line: number, reason: string) => {
    rejectedCount++
    if (rejected.length < 50) rejected.push({ line, reason })
  }

  const accepted: StripeCsvRow[] = []
  const currencies = new Set<string>()
  let rowsInFile = 0

  for (let li = 1; li < recs.length; li++) {
    rowsInFile++
    const lineNo = li + 1
    const c = splitCsvLine(recs[li])
    if (c.length !== header.length) { reject(lineNo, `expected ${header.length} columns, found ${c.length}`); continue }

    const type = (c[iType] || '').trim().toLowerCase()
    // Not a repayment, so not part of "what was paid". Excluded, not rejected.
    if (type !== 'paydown') { skippedCount++; continue }

    const cur = (c[iCur] || '').trim().toLowerCase()
    if (cur) currencies.add(cur)

    const date = utcStampToPacificDate(c[iTime])
    if (!date) { reject(lineNo, `unreadable timestamp '${c[iTime]}'`); continue }

    // Integer cents, straight from the decimal string. Never a float.
    const total = parseMoneyToMinor(c[iTotal])
    const fin = parseMoneyToMinor(c[iFin])
    const fee = parseMoneyToMinor(c[iFee])
    if (total === null || fin === null || fee === null) {
      reject(lineNo, `unreadable amount (total '${c[iTotal]}', financing '${c[iFin]}', fee '${c[iFee]}')`)
      continue
    }

    // A paydown takes money OUT and is exported negative. A POSITIVE paydown is
    // a reversal, and Math.abs() would have counted it as another payment —
    // 40 reversals overstated a real file by $636.14 with zero rejections.
    if (total >= 0) { reject(lineNo, `paydown total ${c[iTotal]} is not negative — this looks like a reversal or adjustment, not a payment`); continue }

    if (fin + fee !== total) {
      reject(lineNo, `financing ${c[iFin]} + fee ${c[iFee]} does not equal total ${c[iTotal]}`)
      continue
    }

    accepted.push({ date, total_minor: -total, principal_minor: -fin, fee_minor: -fee })
  }

  if (currencies.size > 1) {
    return { ...base, rows_in_file: rowsInFile, rows_rejected_count: rejectedCount,
             rows_skipped_not_applicable: skippedCount, rows_rejected_sample: rejected,
             refused_because: `This export mixes ${currencies.size} currencies (${[...currencies].join(', ')}). Summing them would be meaningless.` }
  }
  const currency = currencies.size === 1 ? [...currencies][0] : null
  if (!currency && accepted.length) {
    return { ...base, rows_in_file: rowsInFile, rows_rejected_count: rejectedCount,
             rows_skipped_not_applicable: skippedCount, rows_rejected_sample: rejected,
             refused_because: 'No row in this export states a currency, so there is nothing to confirm the amounts are USD. Refusing rather than assuming.' }
  }
  if (currency && currency !== 'usd') {
    return { ...base, rows_in_file: rowsInFile, rows_rejected_count: rejectedCount,
             rows_skipped_not_applicable: skippedCount, rows_rejected_sample: rejected, currency,
             refused_because: `This export is in ${currency.toUpperCase()}. Only USD is handled — a currency with a different number of minor units would be read wrongly.` }
  }

  if (!accepted.length) {
    return { ...base, rows_in_file: rowsInFile, rows_rejected_count: rejectedCount,
             rows_skipped_not_applicable: skippedCount, rows_rejected_sample: rejected, currency,
             refused_because: 'No usable paydown rows in this file.' }
  }

  // Aggregate in integer minor units, divide once at the end.
  const byMonth = new Map<string, { n: number; t: number; p: number; f: number; first: string; last: string }>()
  // Same rows, same integer cents, bucketed by DAY as well as by month (session
  // 245). One extra Map, no second pass, and no second definition of what a
  // Pacific day is.
  const byDay = new Map<string, { n: number; t: number; p: number; f: number }>()
  let tT = 0, tP = 0, tF = 0, firstDate = accepted[0].date, lastDate = accepted[0].date
  for (const r of accepted) {
    const k = r.date.slice(0, 7)
    const m = byMonth.get(k) || { n: 0, t: 0, p: 0, f: 0, first: r.date, last: r.date }
    m.n++; m.t += r.total_minor; m.p += r.principal_minor; m.f += r.fee_minor
    if (r.date < m.first) m.first = r.date
    if (r.date > m.last) m.last = r.date
    byMonth.set(k, m)
    const dd = byDay.get(r.date) || { n: 0, t: 0, p: 0, f: 0 }
    dd.n++; dd.t += r.total_minor; dd.p += r.principal_minor; dd.f += r.fee_minor
    byDay.set(r.date, dd)
    tT += r.total_minor; tP += r.principal_minor; tF += r.fee_minor
    if (r.date < firstDate) firstDate = r.date
    if (r.date > lastDate) lastDate = r.date
  }

  const days: StripeCsvDay[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, d]) => ({
      date, transaction_count: d.n,
      total_paid: minorToMajor(d.t), principal_paid: minorToMajor(d.p), fee_paid: minorToMajor(d.f),
    }))

  const months: StripeCsvMonth[] = [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, m]) => ({
      month, transaction_count: m.n,
      total_paid: minorToMajor(m.t), principal_paid: minorToMajor(m.p), fee_paid: minorToMajor(m.f),
      first_date: m.first, last_date: m.last,
    }))

  // Any rejected row is money we cannot explain. ok:true would let a caller
  // publish a total that is quietly missing payments — a 400-row corruption
  // reported $7,893.46 against a true $11,192.29 while every field looked healthy.
  const okFlag = rejectedCount === 0
  return {
    ok: okFlag, lender_label: label,
    rows_in_file: rowsInFile, rows_accepted: accepted.length,
    rows_rejected_count: rejectedCount, rows_skipped_not_applicable: skippedCount,
    rows_rejected_sample: rejected,
    currency, months, days,
    totals: { total_paid: minorToMajor(tT), principal_paid: minorToMajor(tP), fee_paid: minorToMajor(tF) },
    first_date: firstDate, last_date: lastDate, accepted,
    refused_because: okFlag ? null
      : `${rejectedCount} of ${rowsInFile} rows in this export could not be read, so the totals below are incomplete. Every unread row is a payment this file cannot account for.`,
  }
}

/**
 * Does `fee = round(payment × fixedFee / totalRepayment)` hold for every row?
 *
 * This is the bridge between the agreement and the transaction file, and it is
 * why uploading both together is worth more than uploading either alone. The
 * agreement states a fixed fee and a total; the export states a per-transaction
 * split. If the ratio implied by the first reproduces the second to the cent on
 * every row, the decomposition rule stops being an assumption and becomes a
 * measured property of this lender — one that can be applied to payments which
 * are on the books but not in this file.
 *
 * Verified against David's July export: 1,352 rows, zero failures.
 *
 * Takes the ACCEPTED rows rather than re-reading the text. v1 re-parsed raw text
 * with looser filters, so it could report a rule "proven" over a population the
 * totals were never computed from — in the worst case proving it on 1,352 rows
 * of a file the parser had refused outright.
 *
 * Note the aggregate does NOT equal the sum of per-row roundings ($1,601.64 vs
 * $1,601.68 for July). Where the file is available its own summed fee is the
 * figure to use; the ratio is for payments the file does not cover.
 */
export function verifyDecompositionRule(
  rows: StripeCsvRow[], fixedFee: number, totalRepayment: number,
): DecompositionResult {
  if (!(fixedFee > 0) || !(totalRepayment > 0)) {
    return { holds: false, fee_over_total: null, rows_checked: 0, rows_failing: 0,
             note: 'No fixed fee and total repayment amount available to test a ratio against.' }
  }
  const ratio = fixedFee / totalRepayment
  let failing = 0
  for (const r of rows) {
    const expected = Math.round(r.total_minor * ratio)
    if (Math.abs(expected - r.fee_minor) > 0) failing++
  }
  const pct = (ratio * 100).toFixed(4)
  return {
    holds: rows.length > 0 && failing === 0,
    fee_over_total: ratio,
    rows_checked: rows.length,
    rows_failing: failing,
    note: rows.length === 0
      ? 'No paydown rows to test.'
      : failing === 0
        ? `Every one of the ${rows.length} payments in this file splits exactly ${pct}% fee / ${(100 - Number(pct)).toFixed(4)}% financing, rounded to the cent — which is the Fixed Fee over the Total Repayment Amount from the agreement. The rule is proven, not assumed.`
        : `${failing} of ${rows.length} payments do not match a flat ${pct}% fee split, so the fee is not a constant share of each payment on this loan.`,
  }
}
