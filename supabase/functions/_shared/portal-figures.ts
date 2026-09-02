// _shared/portal-figures.ts — the control totals printed on a lender's own screen.
//
// WHY THIS IS ITS OWN FILE
// Two things happen to a figure transcribed off a screenshot before anything is
// allowed to rest on it: it is checked against the other figures on ITS OWN
// screen (checkPortalTotals), and it is reconciled against what a DIFFERENT
// screenshot said about the same thing (mergePortal). Both are pure arithmetic
// over a small record, both decide whether a number is evidence or noise, and
// neither was testable while it sat inside an edge function next to storage
// uploads and a vision-model call.
//
// It was extracted the day a bug got through both of them in production: a loan
// screen and a deposit screen were uploaded together, both stated an "amount
// remaining", they disagreed by $1,908.34, and the merge silently kept the wrong
// one. The plan then told David the lender wanted $125,000.00 back when the
// lender's own screen said $123,091.66. mergePortal's own comment carries the rest.

export interface PortalTotals {
  as_of: string | null
  amount_remaining: number | null
  paid_to_date: number | null
  principal_paid: number | null
  fee_paid: number | null
  total_amount_due: number | null
  funds_deposited: number | null
  funds_deposited_date: string | null
  /**
   * OUTSTANDING balances, for a lender that itemises what is still owed rather
   * than what has been paid.
   *
   * Stripe's screen states amounts PAID and the fields above were built for it.
   * PayPal's states the mirror image — principal still owed, fee still owed,
   * and the two together — and every one of those figures came back null,
   * because there was no field to hold them. A screen whose three numbers
   * determine each other exactly proved nothing, which is the same failure
   * `paid_to_date` being absent used to cause on Stripe.
   *
   * These are kept SEPARATE from `amount_remaining` on purpose. A balance that
   * means "principal only" and one that means "principal plus the fee still to
   * run" are different quantities, and the nine months PayPal spent carrying an
   * unexplainable discrepancy is what treating them as one number costs.
   */
  principal_balance: number | null
  fee_balance: number | null
  total_balance: number | null
  /**
   * What `amount_remaining` MEASURES, established by the screen's own
   * arithmetic and never by assumption: 'gross_payback' when the headline
   * balance equals principal + fee, 'net_principal' when it equals the
   * principal line alone. Null whenever the screen did not itemise, which is
   * most screens — an unproven basis stays unstated.
   */
  amount_remaining_basis: 'gross_payback' | 'net_principal' | null
  /**
   * THE LENDER'S BALANCE ON EACH BASIS, where the screen itemises (session 263 cont.).
   *
   * `amount_remaining_basis` answers "what does the headline measure", and it can
   * only answer at all when a headline exists. PayPal's screen has none — it
   * labels its rows "Principal balance", "Fee balance", "Total balance" — so the
   * basis came back null and the balance came back unusable, on a screen that
   * states BOTH balances outright.
   *
   * That is the wrong question to have been asking. A screen that itemises does
   * not need to be classified onto one basis; it states them both, and the
   * comparison downstream should pick the one that matches whatever the books
   * are carrying. Which is the module's oldest bug, finally addressed at the
   * source rather than at the comparison: PayPal spent nine months carrying an
   * unexplainable discrepancy because two figures on two bases were compared as
   * though they were one quantity.
   *
   * Both are set only when the itemisation survived its own arithmetic. Null on
   * a screen that does not itemise, which is most of them.
   */
  lender_balance_net_principal: number | null
  lender_balance_gross_payback: number | null
  /**
   * The loan or account identifier printed on the screen, when it prints one.
   *
   * A HINT, never a match. loan-document-intake's standing rule is that a
   * vision-claimed account number matching a known loan is never an auto-match,
   * and the same applies here: this can confirm a match already made, and it can
   * contradict one, but it may not decide which loan money belongs to.
   */
  lender_account_ref?: string | null
  /** Which screenshot(s) these figures came from. Needed to say WHO disagreed. */
  sources: string[]
  /**
   * Figures dropped, each with the question a person should be shown.
   *
   * This was a bare string[] and every one of them was rendered under the same
   * fixed heading — "A figure read off a screenshot did not check out. A number
   * read from a picture is the least reliable input here, so one that fails its
   * own arithmetic is dropped rather than used." With two warnings the review
   * screen printed that identical heading twice, and for the deposit-date warning
   * it was simply untrue: that figure failed a check against the AGREEMENT, not
   * against its own arithmetic. A heading that misdescribes what is under it is
   * the same defect as a document description that misdescribes the document.
   */
  warnings: { question: string; detail: string }[]
  /** Figures dropped because two SCREENS contradicted each other. A different
   *  kind of problem with a different remedy, so it is reported separately
   *  rather than filed under "this screen does not add up". */
  disputes: string[]
  /** Field names whose value took part in an identity that CAME OUT RIGHT on this
   *  screen. This is the difference between a figure that has earned its place and
   *  one that merely appeared, and it is what settles a disagreement between two
   *  screens without a tie-break. */
  corroborated: string[]
  checks: string[]
}

/**
 * Arithmetic-check a transcribed screenshot against ITSELF before trusting it.
 *
 * A model reading a picture is the least reliable input this system has, so a
 * figure off a screenshot only earns its place by participating in a sum that
 * comes out right. Two identities the lender's own screen must satisfy:
 *
 *     principal paid + fee paid = paid to date
 *     total due − paid to date  = amount remaining
 *
 * A number that fails one of these is dropped, not corrected. Session 242's
 * screenshots passed both to the cent, which is the only reason their figures
 * were allowed to establish the loan's carrying basis.
 */
export function checkPortalTotals(p: PortalTotals): PortalTotals {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.02
  const checks: string[] = []
  const warnings: PortalTotals["warnings"] = []
  const corroborated: string[] = []
  // Set only where the screen's own arithmetic establishes it. Stays null
  // otherwise; a basis nobody proved is worse than no basis at all.
  let basis: PortalTotals['amount_remaining_basis'] = null
  let netBalance: number | null = null
  let grossBalance: number | null = null
  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  // A caller that predates these fields hands us `undefined`, not `null`, and
  // every test below is `=== null`. An undefined would then read as "present"
  // and skip the identity silently — the quietest possible failure. Normalise
  // once, here, rather than defending against it at each comparison.
  p.principal_balance = p.principal_balance ?? null
  p.fee_balance = p.fee_balance ?? null
  p.total_balance = p.total_balance ?? null
  p.lender_balance_net_principal = p.lender_balance_net_principal ?? null
  p.lender_balance_gross_payback = p.lender_balance_gross_payback ?? null

  // A screen that states the PARTS but not the SUM.
  //
  // `Stripe overview.png` shows financing paid, fee paid, the total due and the
  // balance — everything except the "paid to date" line. Both identities below
  // need that line, so both stood down and the screen came back proving nothing,
  // even though its four numbers determine each other completely. The right
  // balance then survived only because a DIFFERENT screenshot happened to supply
  // the missing sum. That is luck, and luck is not a mechanism.
  //
  // So the sum is derived from its parts when the screen omits it. The identity
  // that then runs is not weaker for it — three figures printed on the screen
  // predicting a fourth is exactly the check that was wanted.
  let paidWasDerived = false
  if (p.paid_to_date === null && p.principal_paid !== null && p.fee_paid !== null) {
    p.paid_to_date = Math.round((p.principal_paid + p.fee_paid) * 100) / 100
    paidWasDerived = true
  }

  // Skipped when the sum was derived a moment ago: `a + b = a + b` proves nothing
  // and must never be allowed to look like corroboration.
  if (!paidWasDerived && p.principal_paid !== null && p.fee_paid !== null && p.paid_to_date !== null) {
    if (near(p.principal_paid + p.fee_paid, p.paid_to_date)) {
      checks.push(`The screen's own parts add up: ${fmt(p.principal_paid)} financing + ${fmt(p.fee_paid)} fee = ${fmt(p.paid_to_date)} paid.`)
      corroborated.push('principal_paid', 'fee_paid', 'paid_to_date')
    } else {
      warnings.push({ question: `A screenshot's own figures do not add up.`, detail: `The screen's parts do not add up (${fmt(p.principal_paid)} + ${fmt(p.fee_paid)} ≠ ${fmt(p.paid_to_date)}), so these three figures were dropped rather than used.` })
      p.principal_paid = p.fee_paid = p.paid_to_date = null
    }
  }
  if (p.total_amount_due !== null && p.paid_to_date !== null && p.amount_remaining !== null) {
    if (near(p.total_amount_due - p.paid_to_date, p.amount_remaining)) {
      checks.push(paidWasDerived
        ? `The screen's own parts predict its balance: ${fmt(p.principal_paid!)} financing + ${fmt(p.fee_paid!)} fee = ${fmt(p.paid_to_date)} paid, and ${fmt(p.total_amount_due)} due less that is ${fmt(p.amount_remaining)} — which is the balance printed on it.`
        : `The remaining balance ties to the total: ${fmt(p.total_amount_due)} − ${fmt(p.paid_to_date)} = ${fmt(p.amount_remaining)}.`)
      corroborated.push('total_amount_due', 'paid_to_date', 'amount_remaining')
      // The parts took part in the prediction, so they are proven too.
      if (paidWasDerived) corroborated.push('principal_paid', 'fee_paid')
    } else {
      warnings.push({ question: `A screenshot's own figures do not add up.`, detail: `The remaining balance does not tie to the total less what is paid (${fmt(p.total_amount_due)} − ${fmt(p.paid_to_date)} ≠ ${fmt(p.amount_remaining)}), so the remaining balance was dropped.` })
      p.amount_remaining = null
      // The sum was ours, not the screen's. If the prediction failed, the screen
      // never said it and it must not be reported as though it had.
      if (paidWasDerived) p.paid_to_date = null
    }
  }

  // ── WHAT IS STILL OWED, ITEMISED ─────────────────────────────────────────
  // The mirror of the two identities above, for a lender that prints balances
  // rather than payments:
  //
  //     principal still owed + fee still owed = total balance
  //
  // Same discipline throughout: a sum we derived may not vouch for its own
  // parts, and a figure that fails its identity is dropped rather than
  // corrected.
  let totalWasDerived = false
  if (p.total_balance === null && p.principal_balance !== null && p.fee_balance !== null) {
    p.total_balance = Math.round((p.principal_balance + p.fee_balance) * 100) / 100
    totalWasDerived = true
  }
  if (!totalWasDerived && p.principal_balance !== null && p.fee_balance !== null && p.total_balance !== null) {
    if (near(p.principal_balance + p.fee_balance, p.total_balance)) {
      checks.push(`The screen's own balances add up: ${fmt(p.principal_balance)} principal + ${fmt(p.fee_balance)} fee still owed = ${fmt(p.total_balance)}.`)
      corroborated.push('principal_balance', 'fee_balance', 'total_balance')
    } else {
      warnings.push({ question: `A screenshot's own figures do not add up.`, detail: `The balances it itemises do not add up (${fmt(p.principal_balance)} + ${fmt(p.fee_balance)} \u2260 ${fmt(p.total_balance)}), so these three figures were dropped rather than used.` })
      p.principal_balance = p.fee_balance = p.total_balance = null
    }
  }

  // ── WHICH BALANCE IS THE HEADLINE BALANCE? ───────────────────────────────
  // A screen that itemises can settle, by arithmetic on its own face, what its
  // headline "balance" actually measures. That is the one question this module
  // was never able to answer from a picture, and it is the question the basis
  // fields exist for. It is ANSWERED here, never assumed: if the headline
  // matches neither the total nor the principal line, it is dropped.
  if (p.amount_remaining !== null && p.total_balance !== null) {
    if (near(p.amount_remaining, p.total_balance)) {
      checks.push(totalWasDerived
        ? `The screen's itemised balances predict its headline: ${fmt(p.principal_balance!)} principal + ${fmt(p.fee_balance!)} fee = ${fmt(p.amount_remaining)}, which is the balance printed on it \u2014 so that balance is the whole payback, fee included.`
        : `The headline balance is the two lines together: ${fmt(p.principal_balance ?? 0)} principal + ${fmt(p.fee_balance ?? 0)} fee = ${fmt(p.amount_remaining)} \u2014 so it measures the whole payback, fee included.`)
      corroborated.push('amount_remaining', 'total_balance')
      if (totalWasDerived) corroborated.push('principal_balance', 'fee_balance')
      basis = 'gross_payback'
    } else if (p.principal_balance !== null && near(p.amount_remaining, p.principal_balance)) {
      // Not an error. A lender may headline the principal and itemise the fee
      // beside it, and saying WHICH is exactly the point.
      checks.push(`The headline balance equals the principal line alone (${fmt(p.amount_remaining)}), with ${fmt(p.fee_balance ?? 0)} of fee still owed shown separately \u2014 so it measures principal only.`)
      corroborated.push('amount_remaining', 'principal_balance')
      basis = 'net_principal'
    } else {
      warnings.push({ question: `A screenshot's own figures do not add up.`, detail: `The balance printed on this screen (${fmt(p.amount_remaining)}) is neither the total it itemises (${fmt(p.total_balance)}) nor the principal line (${p.principal_balance === null ? 'not shown' : fmt(p.principal_balance)}), so the headline balance was dropped and the itemised figures kept.` })
      p.amount_remaining = null
    }
  }

  // Both bases, stated, where the itemisation held. `total_balance` may have
  // been derived from the two printed parts a moment ago — that is the lender's
  // own arithmetic on its own two figures, and it is fine as a STATEMENT of the
  // gross quantity. What a derived sum may never do is CORROBORATE its own
  // parts, and it does not: `corroborated` is untouched here.
  if (p.principal_balance !== null && p.fee_balance !== null && p.total_balance !== null) {
    netBalance = p.principal_balance
    grossBalance = p.total_balance
    checks.push(`This screen states the balance on both bases: ${fmt(p.principal_balance)} of principal still owed, and ${fmt(p.total_balance)} including the ${fmt(p.fee_balance)} of fee still to run. Which one the books have to agree with depends on how this loan is carried.`)
  }

  // A funding figure transcribed into the balance field.
  //
  // On a funding screen the same number is routinely read twice — once correctly
  // as the amount advanced, once wrongly as the amount remaining, because the
  // reader is asked for both and the screen shows one. That is what put
  // $125,000.00 forward as the Stripe balance against a true $123,091.66.
  //
  // The first version of this guard also required the screen to carry NOTHING
  // else, on the theory that anything more would tell the two apart. It does not:
  // `Stripe deposit.png` carried a third figure, the guard stood down, and the
  // bad reading went through exactly as before. What matters is not whether other
  // figures are PRESENT but whether they PROVED anything — so the test is now
  // corroboration. Equality is treated as one number read twice unless an identity
  // on this very screen came out right and vouched for the balance.
  //
  // A genuine day-one screenshot (nothing repaid, balance still equal to the
  // advance) is dropped too unless it shows its own arithmetic. Nothing is lost:
  // a balance with no amount-paid-to-date beside it cannot establish the carrying
  // basis on its own, which is the only thing it would have been used for.
  // ── THE DERIVED SUM MUST NOT DEFEAT THIS GUARD (audit, session 242) ────────
  // The guard tested `!corroborated.includes('amount_remaining')`, and the
  // derived-sum path had just written that entry — so on Stripe Capital, where
  // total = funding + fee by construction, a screen reporting the DEPOSIT as the
  // balance and the printed "Fixed Fee" as fee_paid satisfied
  // `total − (0 + fee) = remaining` IDENTICALLY, by algebra rather than by
  // evidence. Verdict: $125,000 kept, fully corroborated, guard silent — the
  // original production bug restored, now carrying an arithmetic endorsement it
  // did not have the first time. The same collapse happens whenever the sum is
  // zero: `total − 0 = remaining` proves nothing at all.
  //
  // So only a sum the SCREEN ITSELF PRINTED, and a non-zero one, may vouch for a
  // balance that equals the funding advanced. A number we computed cannot license
  // the number it was computed from.
  // ── THE PROOF MAY COME FROM EITHER IDENTITY (session 263) ────────────────
  // This tested the PAID identity only, because that was the only one that
  // existed. A screen proving its balance by ITEMISING what is still owed
  // \u2014 principal + fee = total, printed, not derived \u2014 is proof of exactly
  // the same strength, and leaving it out would drop a balance the screen had
  // just demonstrated. Same shape as session 231's six bugs: the right check,
  // one branch away from the path that needed it.
  const provenByPaid = !paidWasDerived && (p.paid_to_date ?? 0) > 0
  const provenByBalances = !totalWasDerived && (p.total_balance ?? 0) > 0
  const provenBalance = corroborated.includes('amount_remaining') &&
                        (provenByPaid || provenByBalances)
  if (p.amount_remaining !== null && p.funds_deposited !== null &&
      near(p.amount_remaining, p.funds_deposited) &&
      !provenBalance) {
    warnings.push({
      question: `A funding amount was read as if it were the balance.`,
      detail:
      `This screen gives the same figure (${fmt(p.funds_deposited)}) as both the funding advanced ` +
      `and the balance still owed, and nothing on it proves the two really are equal — the mark of one ` +
      `number read twice on a funding screen. It was kept as the funding amount and dropped as the ` +
      `balance. If this really is the balance, it needs a screen showing the amount paid to date beside it.` })
    p.amount_remaining = null
    // The figure is gone; its endorsement must go with it, or the merge will
    // still prefer a value that no longer exists. The BASIS goes too: it was a
    // statement about what that number measured, and there is no longer a
    // number for it to be about.
    basis = null
    for (let i = corroborated.length - 1; i >= 0; i--) {
      if (corroborated[i] === 'amount_remaining') corroborated.splice(i, 1)
    }
  }

  return { ...p, checks, warnings, corroborated, disputes: p.disputes ?? [],
    amount_remaining_basis: basis ?? p.amount_remaining_basis ?? null,
    lender_balance_net_principal: netBalance ?? p.lender_balance_net_principal ?? null,
    lender_balance_gross_payback: grossBalance ?? p.lender_balance_gross_payback ?? null }
}

/**
 * Combine the figures from two screenshots of the same loan.
 *
 * WHY THIS IS NOT A FIRST-NON-NULL PICK (session 242, found live)
 * It used to be. David uploaded a loan-details screen and a deposit screen
 * together, and the plan reported the lender's remaining balance as $125,000.00
 * — the FUNDING amount off the deposit screen — instead of $123,091.66. Both
 * screenshots stated an "amount remaining"; they disagreed by $1,908.34; the
 * merge kept whichever arrived first and threw the other away without a word.
 *
 * That is the one thing this whole module exists to not do. Reading documents
 * together is only worth anything if a disagreement between them SURVIVES the
 * reading. So:
 *
 *   * two screens agreeing on a figure  -> keep it, and say they agree (that is
 *     genuine corroboration, and the plan should show it)
 *   * two screens disagreeing           -> DROP the figure and say so, naming
 *     both files and both numbers. A figure two documents contradict is not
 *     evidence of anything, and choosing between them is a guess.
 *   * one screen silent                 -> take the other's value, as before
 *
 * Dropping is deliberately the outcome rather than "prefer the higher/later/
 * more-precise one". Every such rule is a tie-break dressed up as reasoning, and
 * this module's job when the documents do not settle a question is to hand the
 * question back, not to answer it.
 */
export function mergePortal(a: PortalTotals, b: PortalTotals): PortalTotals {
  const checks = [...a.checks, ...b.checks]
  const warnings = [...a.warnings, ...b.warnings]
  const disputes = [...(a.disputes ?? []), ...(b.disputes ?? [])]
  const corroborated: string[] = []
  const who = (p: PortalTotals) => p.sources.length ? p.sources.join(' + ') : 'another screenshot'
  const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const LABEL: Record<string, string> = {
    amount_remaining: 'the balance still owed',
    paid_to_date: 'the amount paid to date',
    principal_paid: 'the financing paid',
    fee_paid: 'the fee paid',
    total_amount_due: 'the total amount due',
    funds_deposited: 'the amount deposited',
    principal_balance: 'the principal still owed',
    fee_balance: 'the fee still owed',
    total_balance: 'the total still owed',
    lender_balance_net_principal: 'the principal still owed',
    lender_balance_gross_payback: 'the whole payback still owed',
  }

  const aOk = (k: string) => (a.corroborated ?? []).includes(k)
  const bOk = (k: string) => (b.corroborated ?? []).includes(k)

  const num = (k: keyof PortalTotals): number | null => {
    const key = k as string
    const av = a[k] as number | null, bv = b[k] as number | null
    // Corroboration must travel with the value. It did not, so a screen SILENT
    // about the balance erased the proof carried by a screen that had earned it —
    // and with three screenshots, two of the six upload orders then threw away a
    // proven $123,091.66 and told the user the screens disagreed. Merging is a
    // left fold, so whether that happens depended only on the order the files
    // happened to be listed in.
    if (av === null || av === undefined) {
      if (bv !== null && bv !== undefined && bOk(key)) corroborated.push(key)
      return (bv ?? null)
    }
    if (bv === null || bv === undefined) {
      if (aOk(key)) corroborated.push(key)
      return av
    }
    if (Math.abs(av - bv) <= 0.02) {
      checks.push(`Two of the lender's own screens agree on ${LABEL[key]}: ${fmt(av)}.`)
      if (aOk(key) || bOk(key)) corroborated.push(key)
      return av
    }

    // They disagree — but a disagreement is only a TIE when the two figures are
    // equally good. One that took part in an identity that came out right on its
    // own screen is not equal to one that merely appeared, and preferring it is a
    // reading of the evidence rather than a tie-break. This is what separates
    // Stripe overview.png's $123,091.66 from Stripe deposit.png's $125,000.00.
    if (aOk(key) !== bOk(key)) {
      const win = aOk(key) ? av : bv
      const winner = aOk(key) ? who(a) : who(b)
      const loser  = aOk(key) ? who(b) : who(a)
      const lost   = aOk(key) ? bv : av
      checks.push(
        `Two screenshots gave different figures for ${LABEL[key]} — ${winner} shows ${fmt(win)} and ` +
        `${loser} shows ${fmt(lost)}. ${winner}'s figure is the one its own screen proves by arithmetic, ` +
        `so that is the one used; the other was not checked by anything and was set aside.`)
      corroborated.push(key)
      return win
    }

    disputes.push(
      `Two screenshots disagree about ${LABEL[key]} — ${who(a)} shows ${fmt(av)}, ` +
      `${who(b)} shows ${fmt(bv)}, and neither screen proves its own figure. It was dropped rather ` +
      `than picking one, so nothing below rests on it. Re-upload the single screen that states the ` +
      `balance you want used.`)
    return null
  }

  // Dates. Two screens pulled at different times legitimately carry different
  // "as of" dates — that is not an error, but it does mean the merged figures
  // describe two moments, which the person approving deserves to be told.
  let as_of = a.as_of ?? b.as_of
  if (a.as_of && b.as_of && a.as_of !== b.as_of) {
    as_of = a.as_of > b.as_of ? a.as_of : b.as_of
    disputes.push(
      `These screenshots were taken on different days (${a.as_of} and ${b.as_of}), so their ` +
      `figures describe two different moments. The later date (${as_of}) was used.`)
  }
  // Two screens that itemise can disagree about what their headline balance
  // MEASURES, and that is not a tie to break \u2014 it is the single most expensive
  // disagreement this module can be handed, so it is dropped and said out loud.
  let amount_remaining_basis = a.amount_remaining_basis ?? b.amount_remaining_basis ?? null
  if (a.amount_remaining_basis && b.amount_remaining_basis &&
      a.amount_remaining_basis !== b.amount_remaining_basis) {
    disputes.push(
      `Two screenshots disagree about what their balance measures \u2014 ${who(a)} itemises it as ` +
      `${a.amount_remaining_basis === 'gross_payback' ? 'the whole payback, fee included' : 'principal only'} and ` +
      `${who(b)} as ${b.amount_remaining_basis === 'gross_payback' ? 'the whole payback, fee included' : 'principal only'}. ` +
      `Nothing below treats this loan as being on either basis.`)
    amount_remaining_basis = null
  }

  let funds_deposited_date = a.funds_deposited_date ?? b.funds_deposited_date
  if (a.funds_deposited_date && b.funds_deposited_date && a.funds_deposited_date !== b.funds_deposited_date) {
    disputes.push(
      `Two screenshots give different deposit dates (${a.funds_deposited_date} and ` +
      `${b.funds_deposited_date}); the date was dropped rather than picking one.`)
    funds_deposited_date = null
  }

  return {
    as_of,
    amount_remaining: num('amount_remaining'),
    paid_to_date: num('paid_to_date'),
    principal_paid: num('principal_paid'),
    fee_paid: num('fee_paid'),
    total_amount_due: num('total_amount_due'),
    funds_deposited: num('funds_deposited'),
    principal_balance: num('principal_balance'),
    fee_balance: num('fee_balance'),
    total_balance: num('total_balance'),
    lender_balance_net_principal: num('lender_balance_net_principal'),
    lender_balance_gross_payback: num('lender_balance_gross_payback'),
    amount_remaining_basis,
    funds_deposited_date,
    sources: [...a.sources, ...b.sources],
    checks, warnings, disputes, corroborated,
  }
}

/**
 * Say what a screenshot ACTUALLY carries, from the figures read off it.
 *
 * Every image used to get one sentence — "the lender's own screen, its statement
 * of what is still owed" — whether it showed a balance or not. So a funding
 * confirmation was introduced to the reader as a statement of the balance, which
 * is the same false premise that let $125,000 of DEPOSIT be taken for $123,091.66
 * of BALANCE. The document list is the first thing a person reads; it should not
 * be teaching them the misreading the checks below then have to catch.
 */
export function describeScreenshot(p: PortalTotals): string {
  // "What is still owed" means amount_remaining and nothing else. total_amount_due
  // is the whole contractual repayment and paid_to_date is what has gone — neither
  // is a balance. Counting them here is how `Stripe deposit.png` kept being
  // introduced as a screen that "states what is still owed" AFTER its balance had
  // been dropped for being a funding figure read twice: the reader was told the
  // screen says a thing the tool had just refused to believe.
  const hasBalance = p.amount_remaining !== null
  const hasDeposit = p.funds_deposited !== null
  const hasOther = p.total_amount_due !== null || p.paid_to_date !== null
  const itemised = p.principal_balance !== null && p.fee_balance !== null
  // A screen that breaks its balance into principal and fee says more than one
  // that states a single figure, and the reader should be told which they have.
  if (itemised) {
    const which = p.amount_remaining_basis === 'gross_payback'
      ? ' Its headline balance is the two together.'
      : p.amount_remaining_basis === 'net_principal'
        ? ' Its headline balance is the principal alone.'
        : ''
    return `The lender's own screen \u2014 it itemises what is still owed, principal and fee separately.${which}`
  }
  if (hasBalance && hasDeposit) {
    return `The lender's own screen — it states both what was advanced and what is still owed.`
  }
  if (hasBalance) {
    return `The lender's own screen — its statement of what is still owed, which is what the books have to agree with.`
  }
  if (hasDeposit) {
    return `The lender's own screen — the funding it advanced. It says what arrived, not what is still owed.`
  }
  if (hasOther) {
    return `The lender's own screen. It carries figures about this loan but no usable balance, so nothing about what is still owed rests on it.`
  }
  return `A screenshot of the lender's screen. No figure on it could be checked, so nothing rests on it.`
}

/**
 * A funding date read off a screenshot, against the date the agreement was signed.
 *
 * `Stripe deposit.png` reported its deposit as 2024-06-30 — TWO YEARS before a
 * loan originated 2026-06-30. Nothing looked at it, so a figure that cannot be
 * true was stored as though it were. It happened to be unused, which is not a
 * reason to keep it: an unchecked field is one refactor away from being load
 * bearing, and a record that carries an impossible date has stopped being a
 * record of anything.
 *
 * A year misread by a digit or two is the ordinary failure of reading dates off
 * pictures, so the window is deliberately generous — this is meant to catch the
 * impossible, not to second-guess the plausible.
 */
export function checkDepositDate(p: PortalTotals, originationDate: string | null): PortalTotals {
  const d = p.funds_deposited_date
  if (!d || !originationDate) return p
  const warnings = [...p.warnings]
  const days = (Date.parse(d) - Date.parse(originationDate)) / 86_400_000
  if (!Number.isFinite(days)) return p
  // Funding lands on or just after origination — never before it, and never
  // months after.
  if (days < -3 || days > 120) {
    warnings.push({
      question: `A date read off a screenshot contradicts the signed agreement.`,
      detail:
      `The deposit date read off this screen (${d}) cannot be right: this loan was originated ` +
      `${originationDate}, and money does not arrive ${days < 0 ? 'before the agreement exists' : 'that long after it'}. ` +
      `The date was dropped; the amount was kept.` })
    return { ...p, funds_deposited_date: null, warnings }
  }
  return p
}
