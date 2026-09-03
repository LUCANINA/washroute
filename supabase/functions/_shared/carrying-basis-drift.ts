// _shared/carrying-basis-drift.ts — does this loan still behave like the kind
// of loan we think it is?
//
// ─── WHY ────────────────────────────────────────────────────────────────────
// A loan's CARRYING BASIS decides how every one of its payments is booked:
//
//   gross_payback  the liability is the whole contractual payback, the fee
//                  capitalised at origination. A $100 withholding reduces it by
//                  $100 and carries no financing cost of its own.
//   net_principal  the liability is the cash borrowed, the fee held outside it.
//                  A $100 withholding is part principal, part financing cost,
//                  and MUST be split.
//
// The basis is not permanent. Reversing the origination entry that capitalised
// the fee converts a loan from the first to the second, in one journal, with no
// announcement. From that moment every payment needs splitting and none is
// being split — and the only visible symptom is a balance that suddenly
// disagrees with the lender by roughly the fee. A reconciliation with no
// concept of basis reports that as "the books and the lender disagree by
// $20,875", which is true, useless, and points at the wrong thing entirely.
//
// So this module asks a different question, continuously: given what the
// agreement says and what the balances actually do, WHICH BASIS IS THIS LOAN
// ON — and is it still the one we have recorded?
//
// ─── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
// It never changes the basis. It reports. Silently re-classifying a loan
// because a balance moved is the same class of inference that produced two
// near-misses in session 242, and a tool that quietly rewrites its own
// assumptions is not one anybody can check. The switch is one click away, in
// front of a human, with the evidence beside it.
//
// PURE MODULE. No I/O. Callable from reconciliation-run (on a schedule), from
// loan-bundle (when documents arrive), and from a test.

export type CarryingBasis = 'gross_payback' | 'net_principal' | 'unknown'

export interface BasisBalance {
  statement_date: string
  principal_balance: number
  balance_basis?: string
  source?: string
}

export interface BasisSplit {
  period_label: string
  principal_amount: number
  interest_amount: number
  total_amount: number
  source?: string
  voided_at?: string | null
}

export interface BasisTerms {
  loan_amount: number | null
  fixed_fee: number | null
  total_repayment_amount: number | null
}

export interface DriftInput {
  loan_id: string
  loan_label: string
  recorded_basis: CarryingBasis
  terms: BasisTerms
  /** Ascending by date. Only real, past-dated balances belong here. */
  balances: BasisBalance[]
  /** Non-voided splits. */
  splits: BasisSplit[]
  /** Dollars. A day's movement must clear this to count as a step. */
  stepTolerance?: number
  /** Dollars. How close a model must come to be called a fit. */
  fitTolerance?: number
}

/**
 * The three shapes a loan's balance can actually have.
 *
 * The third one is not a basis — it is a basis PLUS a mistake, and it is the
 * single most important state this module detects. It is what a loan looks like
 * the day after someone reverses the origination entry that capitalised the
 * fee: the liability is now the cash borrowed (net basis), but every payment is
 * still being booked as pure principal because nothing told the system the
 * basis moved. The balance is wrong by a little more every month, and both of
 * the honest models miss it, so a two-model check reports "fits neither" and
 * sends someone hunting for a rogue journal that does not exist.
 */
export type BasisModel = 'gross_payback' | 'net_principal' | 'net_principal_unsplit'

export interface BasisFit {
  basis: BasisModel
  predicted: number
  observed: number
  difference: number
  fits: boolean
  /** Plain-English name for the state this model represents. */
  means: string
}

export interface BasisStep {
  date: string
  movement: number
  direction: 'reduced_liability' | 'increased_liability'
  payments_that_day: number
  unexplained: number
  matches_fixed_fee: boolean
}

export type DriftVerdict =
  | 'consistent'             // behaves like the recorded basis
  | 'basis_changed'          // behaves like the OTHER basis
  | 'payments_unsplit'       // basis moved to net AND payments are not being split
  | 'fits_neither'           // behaves like none of the models
  | 'not_enough_evidence'    // cannot tell, and says so

export interface DriftResult {
  verdict: DriftVerdict
  /** The basis the numbers actually behave like, when one fits. */
  observed_basis: CarryingBasis
  recorded_basis: CarryingBasis
  /**
   * Set when the loan is on a net basis but payments are still being booked as
   * pure principal. Carries the exact amount that has accumulated in the wrong
   * account, so the message is a number rather than a worry.
   */
  payments_need_splitting: {
    total_paid: number
    financing_cost_in_principal: number
    fee_share_percent: number
  } | null
  fits: BasisFit[]
  /** Single-day movements that look like a fee being capitalised or reversed. */
  steps: BasisStep[]
  severity: 'info' | 'warn' | 'error'
  title: string
  /** Written for a business owner. */
  plain_english: string
  /** What a human should do. Never what the tool will do. */
  suggested_next_step: string
  detail: Record<string, unknown>
}

const DEFAULT_STEP_TOL = 0.02
const DEFAULT_FIT_TOL = 1.00   // a dollar of slack for cent-level rounding across many payments

function money(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (n < 0 ? '-$' : '$') + s
}

/**
 * Which basis do the numbers behave like?
 *
 * Two predictions, one observation:
 *
 *   gross:  balance should be  total_repayment − (everything paid)
 *   net:    balance should be  loan_amount     − (the principal part of what was paid)
 *
 * The second needs a principal figure. Where splits carry one it is used
 * directly; where every split is booked as pure principal — which is what a
 * gross-basis loan looks like — the fee share implied by the agreement is
 * applied instead, so the net model is given its fairest possible shot. Testing
 * a model against numbers arranged to favour the other one proves nothing.
 */
/**
 * WHICH BALANCE IS THIS CHECK ALLOWED TO LOOK AT (Tech Debt #34, session 263 cont. 3)
 *
 * The models below predict what OUR BOOKS should hold. For two years this
 * function then compared them against `balances[last]` — whatever row happened to
 * be newest, of any source, on any basis. On this book that is usually a LENDER
 * statement, so the check answered a question nobody asked ("does the lender's
 * figure match a model of our books?") and reported the answer as a diagnosis of
 * how we carry the loan. Two separate defects, and they compounded:
 *
 *   1. WRONG PARTY. A lender's balance says what the lender is owed. The
 *      carrying basis is a fact about our ledger. `balance_vs_lender` already
 *      compares those two properly and is better at it; this check has no
 *      business doing it badly alongside.
 *   2. WRONG QUANTITY. The gross model predicts a payoff figure. Compared with a
 *      `principal_only` balance it misses by the unearned fee — EVERY TIME, ON
 *      EVERY LOAN OF THAT SHAPE, FOREVER. The `balance_basis` sat on the very
 *      record being read and was never consulted. On PayPal 2 the miss was
 *      $2,689.01 and that is the unearned fee to the cent, which is what gave the
 *      bug away: a defect that lands on an exact meaningful quantity is not
 *      noise, it is arithmetic doing precisely what it was told.
 *
 * The result was `fits_neither` at severity ERROR on healthy loans, which is why
 * 21 of 22 carry `carrying_basis = 'unknown'` — the one check that could settle
 * it could not pass.
 *
 * So the observation is chosen deliberately, from the books, and its declared
 * basis decides which models may be compared to it at all.
 */
/**
 * Sources whose balances are OUR BOOKS speaking. Exported because §5 of
 * loan-bundle-plan.ts needs exactly the same answer to exactly the same
 * question, and two lists would drift — which is how the same loan came to be
 * diagnosed one way by the basis check and the opposite way by the comparison
 * eleven sections below it.
 */
export const BOOK_BALANCE_SOURCES = ['xero_derived', 'xero_balance_snapshot', 'xero_rebuild']

export type ObservationBasis = 'total_payback' | 'principal_only' | 'unlabelled'
export type ObservationRefusal = 'no_balances' | 'no_source_on_rows' | 'no_book_balance'

export interface ChosenObservation {
  statement_date: string
  principal_balance: number
  basis: ObservationBasis
  source: string
}

export interface ObservationChoice {
  chosen: ChosenObservation | null
  refused_because: ObservationRefusal | null
  /** Plain English, always populated, and it names the party and the quantity. */
  statement: string
}

/**
 * The newest BOOK balance, and what it says it measures.
 *
 * An allowlist, so a source nobody has thought about is excluded rather than
 * quietly trusted — the same shape as `_VARIANCE_REAL_ANCHORS`, pointed the
 * other way. `amortization_schedule` and `contract_origination` are excluded
 * deliberately as well: they are OUR OWN record of what should be true, and a
 * check whose inputs share a source cannot fail (§246).
 *
 * A row with no `source` at all is REFUSED rather than skipped. Skipping it
 * would turn a caller that forgot to pass the field into a check that silently
 * never runs, which is the failure this module keeps calling "an unlabelled
 * balance is an invisible one".
 */
export function chooseObservation(balances: BasisBalance[]): ObservationChoice {
  const usable = balances.filter(b => Number.isFinite(Number(b.principal_balance)))
  if (!usable.length) {
    return { chosen: null, refused_because: 'no_balances',
      statement: `There is no balance on file for this loan, so there is nothing for a model to be checked against.` }
  }
  if (usable.some(b => !b.source)) {
    return { chosen: null, refused_because: 'no_source_on_rows',
      statement: `The balances handed to this check do not say where they came from, and a balance whose source is unknown cannot be told apart from the lender's own figure. Nothing was checked rather than checking the wrong party's number.` }
  }
  const books = usable
    .filter(b => BOOK_BALANCE_SOURCES.includes(String(b.source)))
    .slice().sort((a, b) => a.statement_date.localeCompare(b.statement_date))
  if (!books.length) {
    return { chosen: null, refused_because: 'no_book_balance',
      statement: `Every balance on file for this loan came from the lender or from our own schedule; none is a balance rebuilt from the books. How a loan is CARRIED is a fact about our ledger, so it cannot be established from the lender's statement of what it is owed.` }
  }
  const row = books[books.length - 1]
  const newestOverall = usable.slice().sort((a, b) => a.statement_date.localeCompare(b.statement_date))[usable.length - 1]
  // A book balance can be far behind the newest thing on file — EIDL's is from
  // 2024 while its lender rows run to 2026. The verdict is still valid: the
  // payments are cut to the same date. But it speaks for THAT day, and a reader
  // who is not told will take it for today's.
  const staleDays = Math.round(
    (Date.parse(newestOverall.statement_date) - Date.parse(row.statement_date)) / 86_400_000)
  const staleNote = Number.isFinite(staleDays) && staleDays > 120
    ? ` This is the most recent balance the books have produced for this account, and it is ${staleDays} days behind the newest figure on file — so this says how the loan was carried then, not necessarily now.`
    : ''
  const declared = String(row.balance_basis || '')
  const basis: ObservationBasis =
    declared === 'total_payback' ? 'total_payback'
    : declared === 'principal_only' ? 'principal_only'
    : 'unlabelled'
  return {
    chosen: { statement_date: row.statement_date, principal_balance: Number(row.principal_balance), basis, source: String(row.source) },
    refused_because: null,
    statement: basis === 'unlabelled'
      ? `Checked against the books' own balance at ${row.statement_date} (${money(Number(row.principal_balance))}), which does not record what it measures — so both ways of carrying this loan are tested against it, and whichever one predicts it is the answer.${staleNote}`
      : `Checked against the books' own balance at ${row.statement_date} (${money(Number(row.principal_balance))}), which records itself as ${basis === 'total_payback' ? 'the whole payback, fee included' : 'principal only'} — so only that way of carrying the loan is tested against it.${staleNote}`,
  }
}

/**
 * The splits that had happened by `asOf`, or null when they cannot be placed.
 *
 * Mirrors reconciliation-run's own windowing, deliberately and to the letter:
 * a 'YYYY-MM-DD' label is compared directly; a 'YYYY-MM' label carries no day,
 * so its month must have CLOSED before the balance date (unless the balance is
 * itself a month end, in which case its own month is complete and counts); and a
 * label naming no date at all — Verdant's 'Period 84' — makes the whole loan
 * unanswerable, because excluding it understates the payments and including it
 * overstates them, and neither is a judgement worth making silently.
 */
function splitsAsOf(splits: BasisSplit[], asOf: string): BasisSplit[] | null {
  const alive = splits.filter(s => !s.voided_at)
  if (alive.some(s => !/^\d{4}-\d{2}(-\d{2})?/.test(String(s.period_label || '')))) return null
  const asOfMonth = asOf.slice(0, 7)
  const asOfIsMonthEnd = (() => {
    const [y, m] = asOfMonth.split('-').map(Number)
    if (!y || !m) return false
    return asOf === new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  })()
  return alive.filter(s => {
    const label = String(s.period_label).slice(0, 10)
    if (label.length === 7) return asOfIsMonthEnd ? label <= asOfMonth : label < asOfMonth
    return label <= asOf
  })
}

/**
 * Sources whose rows record a movement the LENDER would recognise.
 *
 * A zero-cash row is ambiguous by shape and cannot be read by shape. On this
 * book two completely different things wear the same face — `principal` and
 * `interest` equal and opposite, `total_amount` zero:
 *
 *   BayFirst SBA 2, 2025-02-28   −2,155.49 / +2,155.49   interest capitalised;
 *                                the lender's own statement balance really rose
 *   PayPal 2,       2026-02-28   +2,544.96 / −2,544.96   the CPA correcting how
 *                                a draft was coded in Xero; nothing was paid
 *
 * The first must count — the amount owed changed. The second must not — the
 * payment it corrects is already on file, with its own row and its own split.
 * Only PROVENANCE separates them, which is this module's own standing rule:
 * never infer from shape what a document can be asked directly.
 *
 * So this is an allowlist, and deliberately the same shape as
 * `BOOK_BALANCE_SOURCES` above and `_VARIANCE_REAL_ANCHORS` in the dashboard: a
 * zero-cash row from a source nobody has thought about is left OUT of the
 * payments side rather than quietly counted as a repayment. That is the safe
 * direction here, because counting one is what produced Tech Debt #38 — a
 * $30,490.42 prediction on a loan whose lender says $49,325. Add a source here
 * when a new one genuinely records the lender's own balance moving, and only
 * then.
 */
export const ZERO_CASH_MOVEMENT_SOURCES = ['statement_delta']

/**
 * A row that moved no cash and is not the lender's own statement moving: a
 * bookkeeping reclassification, and never a repayment.
 *
 * `total_amount` is what left the bank. Zero, with a principal or interest leg,
 * is a journal moving an amount between two accounts — the loan is neither paid
 * down nor drawn on by a single cent. A correction that DID move cash (an extra
 * principal payment, a refund) is not caught here and should not be: it really
 * did change what is owed.
 */
export function isReclassification(s: BasisSplit): boolean {
  const cents = (n: unknown) => Math.round(Number(n || 0) * 100)
  if (cents(s.total_amount) !== 0) return false
  if (cents(s.principal_amount) === 0 && cents(s.interest_amount) === 0) return false
  return !ZERO_CASH_MOVEMENT_SOURCES.includes(String(s.source || ''))
}

/**
 * What was left out of the payments side, and how much of it. Reported rather
 * than merely done: an exclusion nobody can see is evidence deleted, and on this
 * book it is the difference between a $30,490.42 prediction and a $49,324.92 one.
 * Null when the splits cannot be placed in time — the same refusal `splitsAsOf`
 * makes, for the same reason.
 */
export function reclassificationsAsOf(
  splits: BasisSplit[], asOf: string,
): { count: number; principal_reclassified: number } | null {
  const cut = splitsAsOf(splits, asOf)
  if (cut === null) return null
  const rows = cut.filter(s => !s.voided_at && isReclassification(s))
  return {
    count: rows.length,
    principal_reclassified: Number(rows.reduce((a, s) => a + Number(s.principal_amount || 0), 0).toFixed(2)),
  }
}

export function fitBasis(input: DriftInput): BasisFit[] {
  return fitBasisAgainst(input, chooseObservation(input.balances).chosen)
}

/**
 * The models, restricted to those that predict the quantity the observation
 * actually measures.
 *
 * This restriction IS the fix. A `total_payback` book balance can only be
 * predicted by the gross model; running the net model against it and calling the
 * miss a finding is comparing two different quantities and reporting the
 * difference between them as a fault. An UNLABELLED book balance is the
 * productive case and the one this check exists for: the two models predict
 * genuinely different numbers, so whichever one lands names the basis.
 */
export function fitBasisAgainst(input: DriftInput, obs: ChosenObservation | null): BasisFit[] {
  const fitTol = input.fitTolerance ?? DEFAULT_FIT_TOL
  const { loan_amount, total_repayment_amount } = input.terms
  if (!obs) return []
  const observed = obs.principal_balance

  // BOTH SIDES CUT AT THE SAME DATE, AND THE DATE IS THE OBSERVATION'S.
  //
  // The balance is a point in time; the payments are a sum of movements. The
  // caller used to cut its splits at the newest balance of ANY source, which was
  // right while this function observed that same row — and became wrong the
  // moment it started choosing a book balance that can be older. EIDL's newest
  // book balance is from 2024-03-31 and its newest balance overall is 2026-08-25:
  // under the caller's window, two and a half years of payments would have been
  // subtracted from a 2024 balance.
  //
  // Doing the cut HERE makes the module correct whatever the caller does, and a
  // caller that also windows can only narrow it further, which is harmless.
  const cut = splitsAsOf(input.splits, obs.statement_date)
  if (cut === null) return []
  // A RECLASSIFICATION IS NOT A REPAYMENT (Tech Debt #38, session 263 cont. 9).
  //
  // These sums are the PAYMENTS side of every model below. A journal that moves
  // money between two accounts and settles nothing has no business in them, and
  // for seven months one did: PayPal 2's CPA corrected a Xero bank rule that
  // coded the weekly auto-drafts entirely to principal, and each correction was
  // backfilled here as its own row. The weekly row already carried the correct
  // split, so the correction restated a movement that was on file, and
  // $18,834.50 of principal was counted twice. The net model predicted
  // $30,490.42 against a lender principal of ~$49,325 and the card told a
  // bookkeeper "the balance does not match any expected shape", at severity
  // error, about a loan that agrees with its lender to $21.66.
  //
  // It is NOT enough to test for zero cash. Seven other loans on this book carry
  // zero-cash rows of exactly the same shape — BayFirst, Bluevine, Funding
  // Circle — and those are capitalised interest read off the lender's own
  // statement, where the amount owed genuinely rose. Excluding them would have
  // traded one wrong prediction for seven. Only provenance tells the two apart:
  // see `isReclassification` and `ZERO_CASH_MOVEMENT_SOURCES`.
  const alive = cut.filter(s => !s.voided_at && !isReclassification(s))
  const paidTotal = alive.reduce((a, s) => a + Number(s.total_amount || 0), 0)
  const bookedPrincipal = alive.reduce((a, s) => a + Number(s.principal_amount || 0), 0)
  // Interest on a reclassification row is the correction's own other leg, not
  // evidence that payments are being split. Counting it would let seven journals
  // vouch for a splitting practice that may not exist, which is the same
  // mistake pointed at the other model.
  const anyInterest = alive.some(s => Number(s.interest_amount || 0) !== 0)

  const fits: BasisFit[] = []
  const add = (basis: BasisModel, predicted: number, means: string) => {
    const difference = observed - predicted
    fits.push({ basis, predicted, observed, difference, fits: Math.abs(difference) <= fitTol, means })
  }

  const grossAllowed = obs.basis === 'total_payback' || obs.basis === 'unlabelled'
  const netAllowed = obs.basis === 'principal_only' || obs.basis === 'unlabelled'

  if (grossAllowed && total_repayment_amount !== null) {
    add('gross_payback', total_repayment_amount - paidTotal,
      'the fee sits inside the balance, and every payment correctly reduces it dollar for dollar')
  }

  if (netAllowed && loan_amount !== null) {
    // The correctly-split net model. Prefer the principal actually booked; if
    // nothing booked any interest, the splits cannot distinguish the models on
    // their own, so give this model its fairest shot using the agreement's own
    // fee share. Testing a model against numbers arranged to favour a rival
    // proves nothing.
    let principalPaid = bookedPrincipal
    if (!anyInterest && total_repayment_amount && total_repayment_amount > 0) {
      principalPaid = paidTotal * (loan_amount / total_repayment_amount)
    }
    add('net_principal', loan_amount - principalPaid,
      'the fee is held outside the balance, and every payment is being split into principal and financing cost')

    // The net basis with payments NOT being split. Only a distinct prediction
    // when a fee exists and no interest has been booked — otherwise it is the
    // same arithmetic as the model above and adding it would manufacture a
    // false ambiguity.
    if (!anyInterest && total_repayment_amount !== null && total_repayment_amount !== loan_amount) {
      add('net_principal_unsplit', loan_amount - paidTotal,
        'the fee has been taken out of the balance, but payments are still being booked as if they were all principal')
    }
  }

  return fits
}

/**
 * Single-day movements that look like a fee being capitalised or un-capitalised.
 *
 * A basis change leaves a fingerprint: the liability moves by about the fixed
 * fee on one date, with no payment of that size behind it. Finding the DATE is
 * what turns "something is off by $20,875" into "on 15 September someone
 * reversed the origination fee entry" — which is the difference between a
 * question anyone can answer and one nobody can.
 */
export function detectSteps(input: DriftInput): BasisStep[] {
  const tol = input.stepTolerance ?? DEFAULT_STEP_TOL
  const fee = input.terms.fixed_fee
  const out: BasisStep[] = []
  const bal = [...input.balances].sort((a, b) => a.statement_date.localeCompare(b.statement_date))

  // Payments keyed by date, so a movement can be checked against what actually
  // moved that day rather than assumed to be unexplained.
  //
  // This only works for loans whose splits are labelled by DATE. On a loan with
  // 'YYYY-MM' labels — most of them — a month key can never match a statement
  // date, so every payment would read as zero and a whole month's principal
  // movement would look unexplained. A monthly movement within half a percent of
  // the fixed fee would then be reported as a basis change on a perfectly healthy
  // loan. Step detection is simply not available at day resolution there, and
  // saying nothing beats saying something wrong: fitBasis still answers the real
  // question, it just cannot name the date.
  const alive = input.splits.filter(s => !s.voided_at)
  const dateLabelled = alive.filter(s => /^\d{4}-\d{2}-\d{2}/.test(s.period_label))
  if (alive.length && dateLabelled.length < alive.length) return []

  const paidOn = new Map<string, number>()
  for (const s of dateLabelled) {
    const d = s.period_label.slice(0, 10)
    paidOn.set(d, (paidOn.get(d) || 0) + Number(s.total_amount || 0))
  }

  for (let i = 1; i < bal.length; i++) {
    const prev = Number(bal[i - 1].principal_balance)
    const cur = Number(bal[i].principal_balance)
    const movement = prev - cur                       // positive = liability fell
    const payments = paidOn.get(bal[i].statement_date) || 0
    const unexplained = movement - payments
    if (Math.abs(unexplained) < Math.max(tol, 1)) continue

    // Only a movement on the scale of the fee is interesting here. Ordinary
    // timing noise between a payout date and a balance snapshot is not a basis
    // change, and reporting it as one would bury the real signal.
    const matches = fee !== null && Math.abs(Math.abs(unexplained) - fee) <= Math.max(tol, fee * 0.005)
    if (!matches) continue

    out.push({
      date: bal[i].statement_date,
      movement: Number(movement.toFixed(2)),
      direction: unexplained > 0 ? 'reduced_liability' : 'increased_liability',
      payments_that_day: Number(payments.toFixed(2)),
      unexplained: Number(unexplained.toFixed(2)),
      matches_fixed_fee: true,
    })
  }
  return out
}

export function detectCarryingBasisDrift(input: DriftInput): DriftResult {
  const observation = chooseObservation(input.balances)
  const fits = fitBasisAgainst(input, observation.chosen)
  const steps = detectSteps(input)
  const recorded = input.recorded_basis
  const fee = input.terms.fixed_fee
  const label = input.loan_label
  const { loan_amount, total_repayment_amount } = input.terms

  const passing = fits.filter(f => f.fits)
  const winner: BasisModel | null = passing.length === 1 ? passing[0].basis : null
  const unsplit = winner === 'net_principal_unsplit'
  // A book balance that RECORDS what it measures has already answered the
  // question. The models are then a consistency check on the arithmetic, not a
  // vote on the basis, and the answer comes from the label either way.
  const declaredBasis: CarryingBasis | null =
    observation.chosen?.basis === 'total_payback' ? 'gross_payback'
    : observation.chosen?.basis === 'principal_only' ? 'net_principal'
    : null
  const observed: CarryingBasis =
    declaredBasis ??
    (winner === 'gross_payback' ? 'gross_payback'
     : winner === 'net_principal' || unsplit ? 'net_principal'
     : 'unknown')

  // How much financing cost is sitting in the loan account because payments
  // were never split. A number beats an adjective.
  let needsSplitting: DriftResult['payments_need_splitting'] = null
  if (unsplit && loan_amount !== null && total_repayment_amount && total_repayment_amount > 0) {
    const paidTotal = input.splits.filter(s => !s.voided_at)
      .reduce((a, s) => a + Number(s.total_amount || 0), 0)
    const share = (total_repayment_amount - loan_amount) / total_repayment_amount
    needsSplitting = {
      total_paid: Number(paidTotal.toFixed(2)),
      financing_cost_in_principal: Number((paidTotal * share).toFixed(2)),
      fee_share_percent: Number((share * 100).toFixed(4)),
    }
  }

  const detail = {
    loan_id: input.loan_id,
    recorded_basis: recorded,
    observed_basis: observed,
    payments_unsplit: unsplit,
    payments_need_splitting: needsSplitting,
    fits: fits.map(f => ({
      basis: f.basis,
      predicted: Number(f.predicted.toFixed(2)),
      observed: Number(f.observed.toFixed(2)),
      difference: Number(f.difference.toFixed(2)),
      fits: f.fits,
      means: f.means,
    })),
    steps,
    terms: input.terms,
    balances_considered: input.balances.length,
    splits_considered: input.splits.length,
    // What the payments side deliberately did NOT count, and how much of it.
    reclassifications_excluded: observation.chosen
      ? reclassificationsAsOf(input.splits, observation.chosen.statement_date)
      : null,
    // WHICH balance this verdict actually spoke about. Its absence is how a
    // finding could claim to diagnose our ledger from the lender's figure and
    // leave nothing behind to show it had.
    observation: observation.chosen,
    observation_refused_because: observation.refused_because,
    observation_statement: observation.statement,
  }

  const stepSentence = steps.length
    ? ` The change is visible on ${steps.map(s => s.date).join(', ')}, where the balance moved by ${steps.map(s => money(Math.abs(s.unexplained))).join(' and ')} with no payment behind it${fee !== null ? ` — which is the fixed fee of ${money(fee)}` : ''}.`
    : ''

  // ── The payments cannot be placed in time ───────────────────────────────
  if (observation.chosen && splitsAsOf(input.splits, observation.chosen.statement_date) === null) {
    return {
      verdict: 'not_enough_evidence', observed_basis: 'unknown', recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'info',
      title: `${label}: how this loan is carried cannot be checked yet`,
      plain_english:
        `Some of this loan's payments are labelled with a period that names no date, so they cannot be placed either side of a balance date. Counting them would overstate what has been repaid and leaving them out would understate it, so nothing was checked rather than checking against a number that is wrong in a direction nobody can predict.`,
      suggested_next_step:
        `Give those periods real dates — a payment that cannot be placed in time cannot take part in any balance check, not just this one.`,
      detail,
    }
  }

  // ── Nothing to check against ────────────────────────────────────────────
  // Distinct from "not enough terms", and it used to be indistinguishable from
  // it: the old code compared against whatever balance was newest, so this
  // branch could not be reached and a loan with no book balance at all was
  // silently diagnosed off the lender's figure instead.
  if (observation.refused_because) {
    return {
      verdict: 'not_enough_evidence', observed_basis: 'unknown', recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'info',
      title: `${label}: how this loan is carried cannot be checked yet`,
      plain_english: observation.statement,
      suggested_next_step: observation.refused_because === 'no_book_balance'
        ? `Nothing to fix on the loan. This check needs a balance rebuilt from your own ledger; until the books produce one for this account, how it is carried has to be recorded by a person rather than measured.`
        : `Nothing to do here — this is a gap in what the check was given, not a problem with the loan.`,
      detail,
    }
  }

  // ── Not enough to say ───────────────────────────────────────────────────
  // Only when a TERM is missing. A single model because the book balance
  // declares its own basis is not a shortage of evidence — it is the evidence.
  // `fits.length === 0` FIRST, unconditionally. With `&& declaredBasis === null`
  // alone, a book balance that declares its basis on a loan whose terms are not
  // on file skipped this branch, skipped the declared-basis branch below (which
  // needs exactly one fit), and fell into the closest-of-N branch — where
  // `closest` is undefined and the whole check throws a TypeError instead of
  // returning a verdict. Not reachable on today's data only because every
  // xero-sourced row currently carries `balance_basis = 'unknown'`; it becomes
  // reachable the day the rebuild starts labelling them, which is the direction
  // this work is going. Found by an adversarial pass over the new branches, not
  // by a failing test — so there is now a failing-first test for it too.
  if (fits.length === 0 || (fits.length < 2 && declaredBasis === null)) {
    return {
      verdict: 'not_enough_evidence', observed_basis: 'unknown', recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'info',
      title: `${label}: not enough on file to confirm how this loan is carried`,
      plain_english:
        `To tell whether this loan's balance means "everything still owed including the fee" or "cash still owed", the amount borrowed and the total repayable both need to be on file. ${fits.length === 0 ? 'Neither is.' : 'Only one of them is.'} Until then, nothing can check that payments are being booked the right way.`,
      suggested_next_step: `Upload the loan agreement. The amounts come straight off its first page and everything else follows from them.`,
      detail,
    }
  }

  // ── The books declare their basis, and the arithmetic agrees ────────────
  if (declaredBasis !== null && fits.length === 1 && passing.length === 1) {
    if (recorded === declaredBasis) {
      return {
        verdict: 'consistent', observed_basis: declaredBasis, recorded_basis: recorded,
        payments_need_splitting: null, fits, steps, severity: 'info',
        title: `${label}: carried the way it is recorded`,
        plain_english: `${observation.statement} It comes to ${money(fits[0].predicted)} on that basis, and the books hold ${money(fits[0].observed)}.`,
        suggested_next_step: `Nothing to do.`,
        detail,
      }
    }
    return {
      verdict: 'basis_changed', observed_basis: declaredBasis, recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: recorded === 'unknown' ? 'warn' : 'error',
      title: recorded === 'unknown'
        ? `${label}: how this loan is carried has never been recorded, and the books say which it is`
        : `${label}: this loan is not carried the way it is recorded`,
      plain_english: `${observation.statement} It comes to ${money(fits[0].predicted)} on that basis, and the books hold ${money(fits[0].observed)} — so this loan is carried as ${declaredBasis === 'gross_payback' ? 'the whole payback, fee included' : 'principal only, with the fee held outside it'}${recorded === 'unknown' ? ', and that has never been written down' : `, not as ${recorded === 'gross_payback' ? 'the whole payback' : 'principal only'} as recorded`}.`,
      suggested_next_step: `Confirm the basis on the loan so every payment from here on is booked the right way.`,
      detail,
    }
  }

  if (passing.length > 1) {
    // Two models predicting the same balance happens before enough has been
    // repaid for them to separate. Not a problem, just not yet answerable.
    return {
      verdict: 'not_enough_evidence', observed_basis: 'unknown', recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'info',
      title: `${label}: too early to tell how this loan is carried`,
      plain_english:
        `More than one way of carrying this loan currently predicts the same balance, so the numbers cannot yet tell them apart. That is normal early on, before enough has been repaid for them to separate.`,
      suggested_next_step: `Nothing to do. This resolves itself once repayments accumulate.`,
      detail,
    }
  }

  // ── Behaves like none of them ───────────────────────────────────────────
  if (passing.length === 0) {
    const closest = fits.slice().sort((a, b) => Math.abs(a.difference) - Math.abs(b.difference))[0]
    return {
      verdict: 'fits_neither', observed_basis: 'unknown', recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'error',
      title: `${label}: the balance does not match any expected shape for this loan`,
      plain_english:
        `Given the agreement and the payments recorded, this loan's balance should be one of: ${fits.map(f => `${money(f.predicted)} (${f.means})`).join('; ')}. It is actually ${money(closest.observed)} — ${money(Math.abs(closest.difference))} from the nearest of them. Something has been posted to this loan that is neither a payment nor the fee.${stepSentence}`,
      suggested_next_step:
        `Look at every entry posted to this loan's account that is not one of its payments. A manual journal, an adjustment, or a payment coded to the wrong account will all show up this way.`,
      detail,
    }
  }

  // ── The net basis, with payments not being split ────────────────────────
  // The state a fee reversal leaves behind. Worth its own message because the
  // instruction is completely different from a plain basis change: the basis
  // needs recording AND the payments already booked need correcting, and the
  // gap grows every month until both happen.
  if (unsplit) {
    const n = needsSplitting!
    return {
      verdict: 'payments_unsplit', observed_basis: 'net_principal', recorded_basis: recorded,
      payments_need_splitting: n, fits, steps, severity: 'error',
      title: `${label}: the fee is no longer inside the balance, but payments are still being booked as if it were`,
      plain_english:
        `This loan's balance now behaves like cash still owed, with the financing cost held outside it — which means every payment ought to be split into a principal part and a financing-cost part. None of them are. All ${money(n.total_paid)} paid so far has gone against the loan balance, so about ${money(n.financing_cost_in_principal)} of financing cost is sitting in the loan account instead of showing up as a cost in your profit and loss. That is ${n.fee_share_percent}% of every payment, and it grows with each one.${stepSentence}`,
      suggested_next_step:
        `Two things, in this order. First confirm the basis on the loan, so payments from here on are split correctly. Then decide with your accountant what to do about the ${money(n.financing_cost_in_principal)} already booked — months your books have closed are a prior-period adjustment and are theirs to make, not this tool's.`,
      detail,
    }
  }

  // ── Never recorded ──────────────────────────────────────────────────────
  if (recorded === 'unknown') {
    return {
      verdict: 'basis_changed', observed_basis: observed, recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'warn',
      title: `${label}: how this loan is carried has never been recorded`,
      plain_english: observed === 'gross_payback'
        ? `The balance behaves like a payoff figure — everything still owed, with the fee already inside it. On that basis each payment correctly reduces the balance dollar for dollar and carries no separate financing cost. Recording it stops anything in the system from proposing a split that would leave a phantom balance behind at payoff.`
        : `The balance behaves like cash still owed, with the financing cost held outside it, and payments are being split accordingly. Recording it keeps the checks pointed at the right model.`,
      suggested_next_step: `Confirm it on the loan and every check below starts running against the right model.`,
      detail,
    }
  }

  // ── Changed under us ────────────────────────────────────────────────────
  if (observed !== recorded) {
    const other = fits.find(f => f.basis === recorded)!
    return {
      verdict: 'basis_changed', observed_basis: observed, recorded_basis: recorded,
      payments_need_splitting: null, fits, steps, severity: 'error',
      title: `${label}: this loan is no longer carried the way the system has it recorded`,
      plain_english:
        `This loan is recorded as ${recorded === 'gross_payback' ? 'a payoff balance — the fee sitting inside the amount owed' : 'a principal balance — the fee held outside the amount owed'}, but the numbers now behave the other way round. On the recorded basis the balance should be ${money(other.predicted)}; it is ${money(other.observed)}, out by ${money(Math.abs(other.difference))}.${stepSentence}` +
        (observed === 'net_principal'
          ? ` If the fee was deliberately taken back out of the loan balance, that is a real change and every payment from that date forward needs splitting into principal and financing cost.`
          : ` If the fee was deliberately added into the loan balance, that is a real change and payments from that date forward should stop being split.`),
      suggested_next_step:
        `Two possibilities, needing different answers. If this was intentional — an entry your accountant reversed or added — change the basis on the loan and payments will be handled the new way from here. If it was not intentional, find the entry on the date above and reverse it. Nothing has been changed automatically either way.`,
      detail,
    }
  }

  // ── Consistent ──────────────────────────────────────────────────────────
  const good = fits.find(f => f.basis === recorded)!
  return {
    verdict: 'consistent', observed_basis: observed, recorded_basis: recorded,
    payments_need_splitting: null, fits, steps, severity: 'info',
    title: `${label}: carried as recorded`,
    plain_english:
      `The balance is ${money(good.observed)}, which is what a ${recorded === 'gross_payback' ? 'payoff' : 'principal'} balance should be given the agreement and the payments on file${Math.abs(good.difference) > 0.005 ? ` (out by ${money(Math.abs(good.difference))}, within rounding)` : ' — to the cent'}. Payments are being booked the right way.`,
    suggested_next_step: `Nothing to do.`,
    detail,
  }
}

/**
 * How to describe a basis check on the card a person actually reads (session 263).
 *
 * The caller used to build this inline as
 * `fits.filter(f => f.fits).map(f => f.means).join('; ') || 'one of the expected shapes'`
 * — a list of the models that FIT, rendered on a card that only appears when
 * none of them does. So the branch that ran when the tool could not explain a
 * loan was the one branch that explained nothing, every single time.
 *
 * A model that MISSED is the useful thing here: which shape was tried, what it
 * predicted, and by how much it was out. On the loan that exposed this, the
 * gross model misses by exactly the unearned fee — the fingerprint of a defect
 * in the check rather than of anything wrong with the loan — and that is only
 * visible if the misses are printed.
 *
 * Pure, so it can be tested. It is a sentence about money and it was wrong.
 */
export function describeBasisMiss(fits: BasisFit[]): string {
  const fitting = fits.filter(f => f.fits)
  if (fitting.length) return fitting.map(f => f.means).join('; ')
  if (!fits.length) return `nothing to predict from — this loan's opening figures are not on file`
  const name = (b: BasisModel) =>
    b === 'gross_payback' ? 'the whole payback'
      : b === 'net_principal' ? 'principal only'
      : 'principal only, payments unsplit'
  return fits
    .map(f => `${name(f.basis)} would put it at ${money(f.predicted)}, out by ${money(f.difference)}`)
    .join(' · ')
}

/** The book balance a basis check actually spoke about, formatted, with its date. */
export function describeBasisObserved(fits: BasisFit[], asOfDate: string | null): string {
  const observed = fits[0]?.observed
  if (observed === undefined || observed === null || !Number.isFinite(observed)) {
    return 'no book balance to compare'
  }
  return `${money(observed)} on the books${asOfDate ? ` at ${asOfDate}` : ''}`
}
