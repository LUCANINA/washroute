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
export function fitBasis(input: DriftInput): BasisFit[] {
  const fitTol = input.fitTolerance ?? DEFAULT_FIT_TOL
  const { loan_amount, total_repayment_amount } = input.terms
  // Sort rather than trust the caller's "ascending by date" contract. detectSteps
  // already sorts; this one did not, and picking the wrong row as "latest"
  // silently compares a mid-history balance against all-time payments.
  const live = input.balances
    .filter(b => Number.isFinite(Number(b.principal_balance)))
    .slice().sort((a, b) => a.statement_date.localeCompare(b.statement_date))
  if (!live.length) return []
  const observed = Number(live[live.length - 1].principal_balance)

  const alive = input.splits.filter(s => !s.voided_at)
  const paidTotal = alive.reduce((a, s) => a + Number(s.total_amount || 0), 0)
  const bookedPrincipal = alive.reduce((a, s) => a + Number(s.principal_amount || 0), 0)
  const anyInterest = alive.some(s => Number(s.interest_amount || 0) !== 0)

  const fits: BasisFit[] = []
  const add = (basis: BasisModel, predicted: number, means: string) => {
    const difference = observed - predicted
    fits.push({ basis, predicted, observed, difference, fits: Math.abs(difference) <= fitTol, means })
  }

  if (total_repayment_amount !== null) {
    add('gross_payback', total_repayment_amount - paidTotal,
      'the fee sits inside the balance, and every payment correctly reduces it dollar for dollar')
  }

  if (loan_amount !== null) {
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
  const fits = fitBasis(input)
  const steps = detectSteps(input)
  const recorded = input.recorded_basis
  const fee = input.terms.fixed_fee
  const label = input.loan_label
  const { loan_amount, total_repayment_amount } = input.terms

  const passing = fits.filter(f => f.fits)
  const winner: BasisModel | null = passing.length === 1 ? passing[0].basis : null
  const unsplit = winner === 'net_principal_unsplit'
  const observed: CarryingBasis =
    winner === 'gross_payback' ? 'gross_payback'
    : winner === 'net_principal' || unsplit ? 'net_principal'
    : 'unknown'

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
  }

  const stepSentence = steps.length
    ? ` The change is visible on ${steps.map(s => s.date).join(', ')}, where the balance moved by ${steps.map(s => money(Math.abs(s.unexplained))).join(' and ')} with no payment behind it${fee !== null ? ` — which is the fixed fee of ${money(fee)}` : ''}.`
    : ''

  // ── Not enough to say ───────────────────────────────────────────────────
  if (fits.length < 2) {
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
