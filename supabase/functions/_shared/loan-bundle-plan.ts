// _shared/loan-bundle-plan.ts — reading a SET of loan documents as one thing.
//
// ─── WHAT THIS IS FOR ───────────────────────────────────────────────────────
// One document at a time, each judged only against itself, is how this module
// worked until now. But a loan does not arrive as one document. It arrives as
// an agreement, a transaction export, a payment confirmation and a portal
// screenshot — four files, each holding a different piece, and the pieces check
// each other. Read together they answer questions no single one of them can:
//
//   * the agreement says the fee is $20,875 and the total payback $145,875
//   * the export says every payment splits 14.3102% fee / 85.6898% financing
//   * those two facts are THE SAME FACT, and each proves the other
//   * the portal screenshot's "amount remaining" then says which of the two
//     possible meanings the books' balance actually carries
//
// That last one is the whole point, and it is the thing that nearly went wrong.
//
// ─── THE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────────────────
// BEFORE proposing anything about principal and interest, establish HOW THE
// LOAN IS CARRIED. There are two ways, they are mutually exclusive, and the
// same payment is booked differently under each:
//
//   gross_payback  — the liability is the whole contractual payback, fee
//                    capitalised at origination. A $100 withholding reduces it
//                    by $100. NO interest component per payment; the financing
//                    cost was dealt with once, at the start.
//   net_principal  — the liability is the cash borrowed. A $100 withholding is
//                    part principal, part financing cost, and MUST be split.
//
// Session 242 built a fee-reclassification for Stripe Capital that was correct
// under net_principal and catastrophic under gross_payback: applied to a
// gross-booked loan it would have credited an extra $20,875 to the liability
// over the loan's life, leaving a phantom $20,875 owing after the lender said
// paid in full. It got as far as a costed, reviewed proposal before an
// adversarial pass caught it, and the only reason it was CATCHABLE is that
// somebody asked which basis the loan was on. Nothing in the schema recorded
// it. Now something does, and this planner refuses to propose a split until it
// is established.
//
// ─── AND THE RULE FOR WHAT IT WON'T DO ──────────────────────────────────────
// When the documents establish a PROBLEM but not its REMEDY, this planner emits
// an `unresolved` entry naming the missing evidence, and proposes nothing. The
// Stripe case again: the documents proved no financing cost was reaching the
// P&L, and could not say whether the fix was an amortisation entry, a reversal
// of a double-expensed fee, or a suspense clean-up — because the answer was in
// a June journal none of the four documents contained. Proposing any of the
// three would have been a coin flip wearing a proposal's clothes.
//
// This module is PURE. All I/O belongs to loan-bundle/index.ts, so that every
// judgement below can be tested without a database.

import type { ContractTerm, StripeCsvParseResult, DecompositionResult } from './stripe-capital.ts'
import { explainBalanceGap, dailyWithholdingFromMonths } from './settlement-lag.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Severity = 'info' | 'warn' | 'error'

export interface BundleDocument {
  filename: string
  sha256: string
  bytes: number
  /** Classification, from loan-document-intake's rungs. */
  kind: string
  lender_label: string | null
  confidence: 'high' | 'medium' | 'low'
  /** What this document contributes that the others cannot. */
  role: string
  /** Set when this file is byte-identical to one already on the loan. */
  duplicate_of: string | null
  /** For a screenshot: the figures actually read off it, exactly as they came,
   *  and which of them the screen's own arithmetic vouched for.
   *
   *  Kept because session 242 spent two rounds INFERRING what a screenshot had
   *  reported — the plan recorded the conclusions and never the readings, so a
   *  misread could only be diagnosed by guessing at it or uploading the file
   *  again. A figure that decides where money is booked should not be the one
   *  thing the audit trail cannot show. */
  figures?: {
    as_of: string | null
    amount_remaining: number | null
    paid_to_date: number | null
    principal_paid: number | null
    fee_paid: number | null
    total_amount_due: number | null
    funds_deposited: number | null
    funds_deposited_date: string | null
    corroborated: string[]
    dropped: string[]
  } | null
}

export interface Corroboration {
  statement: string
  sources: string[]
  tie: 'exact' | 'within_tolerance'
}

export interface Conflict {
  key: string
  statement: string
  expected: string
  found: string
  sources: string[]
  severity: Severity
  /** What this does NOT mean — kept because a conflict misread is its own bug. */
  caveat?: string
}

export type ActionKind =
  | 'attach_document'
  | 'record_contract_terms'
  | 'apply_term_to_loan'
  | 'set_carrying_basis'
  | 'correct_statement_basis'
  | 'write_structure_note'
  | 'raise_finding'

export interface PlannedAction {
  id: string
  kind: ActionKind
  title: string
  /** Written for a business owner, not an accountant. */
  plain_english: string
  payload: Record<string, unknown>
  default_checked: boolean
  /** Set when the action cannot be offered at all; it is shown greyed with this reason. */
  blocked_reason?: string
}

export interface Unresolved {
  question: string
  why_it_matters: string
  what_would_answer_it: string
}

export interface BundlePlan {
  loan: {
    id: string
    lender: string
    xero_account_name: string | null
    lender_account_number: string
    carrying_basis: string
  }
  documents: BundleDocument[]
  established: { key: string; value: string; how: string }[]
  corroborations: Corroboration[]
  conflicts: Conflict[]
  actions: PlannedAction[]
  unresolved: Unresolved[]
  /** One paragraph a human can read instead of the whole plan. */
  summary: string
}

/** Everything the planner needs, already fetched. */
export interface PlanContext {
  loan: {
    id: string
    lender: string
    xero_account_name: string | null
    lender_account_number: string
    carrying_basis: string
    original_amount: number | null
    original_date: string | null
    maturity_date: string | null
    interest_rate: number | null
    scheduled_monthly_payment: number | null
    structure_note: string | null
    xero_account_code: string | null
  }
  documents: BundleDocument[]
  /** Terms read off an agreement, if the bundle contained one. */
  agreementTerms: ContractTerm[]
  agreementChecks: string[]
  agreementUnresolved: string[]
  /** Parsed transaction export, if the bundle contained one. */
  csv: StripeCsvParseResult | null
  decomposition: DecompositionResult | null
  /** Control totals read off a portal screenshot, if one was present. */
  portal: {
    as_of: string | null
    amount_remaining: number | null
    paid_to_date: number | null
    principal_paid: number | null
    fee_paid: number | null
    total_amount_due: number | null
  } | null
  /** Existing statement rows, newest last. */
  statements: { statement_date: string; principal_balance: number; balance_basis: string; source: string }[]
  /** Existing non-voided splits. */
  splits: { period_label: string; principal_amount: number; interest_amount: number; total_amount: number; status: string; source: string }[]
  /** settings.books_closed_through, resolved. */
  closeDate: string | null
  todayPacific: string
}

const TOL = 0.01

function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function near(a: number, b: number, tol = TOL): boolean {
  return Math.abs(a - b) <= tol
}
/** Is this period label inside the closed range? Mirrors _shared/close-date.ts. */
function isClosed(label: string, closeDate: string | null): boolean {
  if (!closeDate) return false
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return label <= closeDate
  if (/^\d{4}-\d{2}$/.test(label)) {
    const [y, m] = label.split('-').map(Number)
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    return end <= closeDate
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// The planner
// ─────────────────────────────────────────────────────────────────────────────

export function buildPlan(ctx: PlanContext): BundlePlan {
  const established: BundlePlan['established'] = []
  const corroborations: Corroboration[] = []
  const conflicts: Conflict[] = []
  const actions: PlannedAction[] = []
  const unresolved: Unresolved[] = []
  let n = 0
  const nextId = (k: string) => `${k}_${++n}`

  const termOf = (key: string) => ctx.agreementTerms.find(t => t.term_key === key)
  const num = (key: string) => {
    const t = termOf(key)
    return typeof t?.value_numeric === 'number' ? t.value_numeric : null
  }
  const date = (key: string) => termOf(key)?.value_date ?? null

  const loanAmount = num('loan_amount')
  const fixedFee = num('fixed_fee')
  const totalRepayment = num('total_repayment_amount')
  const origination = date('origination_date')
  const finalRepayment = date('final_repayment_date')
  const minPayment = num('minimum_payment_amount')
  const minPeriodDays = num('minimum_payment_period_days')

  const hasAgreement = ctx.agreementTerms.length > 0
  const hasCsv = !!ctx.csv?.ok
  const hasPortal = !!ctx.portal

  // ── 1. Documents ────────────────────────────────────────────────────────
  const fresh = ctx.documents.filter(d => !d.duplicate_of)
  for (const d of fresh) {
    actions.push({
      id: nextId('attach'),
      kind: 'attach_document',
      title: `File "${d.filename}" against this loan`,
      plain_english: `Stores the file with the loan so it can be opened from the loan's page later. ${d.role}`,
      payload: { filename: d.filename, sha256: d.sha256, kind: d.kind },
      default_checked: true,
    })
  }

  // ── 2. Terms from the agreement ─────────────────────────────────────────
  if (hasAgreement) {
    actions.push({
      id: nextId('terms'),
      kind: 'record_contract_terms',
      title: `Record ${ctx.agreementTerms.length} contract terms from the agreement`,
      plain_english:
        `Saves what the signed agreement actually says — the amounts, the dates, the payment rules — each with the line of the document it was read from. This is kept separately from the notes already on the loan, so a figure someone typed in by hand can never quietly overwrite what the lender put in writing.`,
      // Which document these came from, so the evidence row can point at the
      // AGREEMENT rather than whichever file happened to be attached first.
      // source_document_id is the whole difference between a term that is
      // evidence and a term that is an assertion.
      payload: {
        terms: ctx.agreementTerms,
        source_sha256: ctx.documents.find(d => d.kind === 'agreement')?.sha256 ?? null,
      },
      default_checked: true,
    })

    // Terms that CONTRADICT the loan record. Each is a separate tick, because
    // agreeing that the maturity date is wrong is a different decision from
    // agreeing what the payment schedule is.
    const compare: { term: string; field: string; label: string; onFile: unknown; fromDoc: unknown }[] = []
    if (finalRepayment) compare.push({ term: 'final_repayment_date', field: 'maturity_date', label: 'Maturity date', onFile: ctx.loan.maturity_date, fromDoc: finalRepayment })
    if (origination) compare.push({ term: 'origination_date', field: 'original_date', label: 'Origination date', onFile: ctx.loan.original_date, fromDoc: origination })
    if (loanAmount !== null) compare.push({ term: 'loan_amount', field: 'original_amount', label: 'Original amount', onFile: ctx.loan.original_amount, fromDoc: loanAmount })

    for (const c of compare) {
      const same = c.onFile !== null && String(c.onFile).slice(0, 10) === String(c.fromDoc).slice(0, 10)
      if (same) {
        corroborations.push({
          statement: `${c.label} on file matches the agreement (${c.fromDoc}).`,
          sources: ['loan record', 'agreement'], tie: 'exact',
        })
        continue
      }
      const wasBlank = c.onFile === null || c.onFile === undefined || c.onFile === ''
      conflicts.push({
        key: `term_${c.field}`,
        statement: wasBlank
          ? `${c.label} is blank on the loan record; the agreement states it.`
          : `${c.label} on the loan record disagrees with the agreement.`,
        expected: String(c.fromDoc), found: wasBlank ? '(blank)' : String(c.onFile),
        sources: ['loan record', 'agreement'],
        severity: wasBlank ? 'info' : 'warn',
      })
      actions.push({
        id: nextId('applyterm'),
        kind: 'apply_term_to_loan',
        title: `${c.label}: ${wasBlank ? 'set to' : 'change to'} ${c.fromDoc}${wasBlank ? '' : ` (currently ${c.onFile})`}`,
        plain_english: wasBlank
          ? `The loan record has no ${c.label.toLowerCase()}. The agreement gives it as ${c.fromDoc}.`
          : `The loan record says ${c.onFile}. The signed agreement says ${c.fromDoc}. The agreement is the better evidence.`,
        // The source document rides along so the apply step can mark THIS
        // document's term applied rather than every document's term for this key.
        payload: {
          field: c.field, term_key: c.term, value: c.fromDoc, previous: c.onFile,
          source_sha256: ctx.documents.find(d => d.kind === 'agreement')?.sha256 ?? null,
        },
        default_checked: true,
      })
    }

    // The scheduled-payment field is a monthly figure, and this lender does not
    // have one. Saying so is more useful than overwriting it with a number that
    // means something else.
    if (minPayment !== null && minPeriodDays !== null && minPeriodDays !== 30) {
      conflicts.push({
        key: 'scheduled_payment_shape',
        statement: `The loan record carries a monthly payment figure, but this lender does not bill monthly.`,
        expected: `${money(minPayment)} minimum every ${minPeriodDays} days`,
        found: ctx.loan.scheduled_monthly_payment !== null ? `${money(ctx.loan.scheduled_monthly_payment)} per month` : '(blank)',
        sources: ['loan record', 'agreement'],
        severity: 'warn',
        caveat: `This is not a missed payment. The obligation is a floor over a ${minPeriodDays}-day window, not a fixed monthly amount, and repayment actually happens as a percentage of each sale.`,
      })
    }
  }

  // ── 3. Establish the carrying basis ─────────────────────────────────────
  // Three independent ways to reach the same answer. Requiring more than one is
  // the point: a single coincidence is how the wrong basis gets recorded, and
  // the wrong basis is what turns a correct entry into a phantom liability.
  // Each piece of evidence is TAGGED with the basis it supports. The first
  // version collected untagged sentences and required two of them, which meant a
  // reading could be corroborated by evidence pointing the OTHER way — and the
  // joined text then went verbatim into carrying_basis_evidence, the column whose
  // entire job is to be the audit answer months later.
  const basisEvidence: { basis: 'gross_payback' | 'net_principal'; text: string }[] = []
  let proposedBasis: 'gross_payback' | 'net_principal' | null = null

  const openingStmt = ctx.statements.length ? ctx.statements[0] : null
  if (totalRepayment !== null && openingStmt && near(Number(openingStmt.principal_balance), totalRepayment)) {
    proposedBasis = 'gross_payback'
    basisEvidence.push({ basis: 'gross_payback', text: `The earliest balance on file (${openingStmt.statement_date}, ${money(Number(openingStmt.principal_balance))}) is the agreement's Total Repayment Amount to the cent, not the amount borrowed — so the books carry the fee inside the loan balance.` })
  } else if (loanAmount !== null && openingStmt && near(Number(openingStmt.principal_balance), loanAmount)) {
    proposedBasis = 'net_principal'
    basisEvidence.push({ basis: 'net_principal', text: `The earliest balance on file (${openingStmt.statement_date}, ${money(Number(openingStmt.principal_balance))}) is the amount borrowed, not the total payback — so the fee is carried outside the loan balance.` })
  }

  if (hasPortal && ctx.portal!.amount_remaining !== null && ctx.portal!.paid_to_date !== null && totalRepayment !== null) {
    const implied = totalRepayment - ctx.portal!.paid_to_date!
    if (near(implied, ctx.portal!.amount_remaining!)) {
      basisEvidence.push({ basis: 'gross_payback', text: `The lender's own screen reports ${money(ctx.portal!.amount_remaining!)} remaining, which is the Total Repayment Amount less ${money(ctx.portal!.paid_to_date!)} paid — so the lender quotes the balance on the same gross basis.` })
      if (!proposedBasis) proposedBasis = 'gross_payback'
    }
  }

  if (ctx.decomposition?.holds && fixedFee !== null && totalRepayment !== null) {
    corroborations.push({
      statement: ctx.decomposition.note,
      sources: ['agreement', 'transaction export'], tie: 'exact',
    })
    established.push({
      key: 'fee_share_of_each_payment',
      value: `${((fixedFee / totalRepayment) * 100).toFixed(4)}%`,
      how: `Proven on all ${ctx.decomposition.rows_checked} payments in the export, against the Fixed Fee and Total Repayment Amount in the agreement.`,
    })
  }

  const agreeing = basisEvidence.filter(e => e.basis === proposedBasis)
  const dissenting = basisEvidence.filter(e => e.basis !== proposedBasis)
  // Split the two meanings apart. `proposedBasis` is the leading hypothesis and
  // may be reported as such; `establishedBasis` is set ONLY when two independent
  // pieces of evidence agree, and is the only one anything confident may rest on.
  let establishedBasis: 'gross_payback' | 'net_principal' | null = null

  if (dissenting.length) {
    // Evidence pointing both ways is not corroboration, it is a conflict, and
    // recording either reading would put a sentence in the audit trail that
    // argues against the value beside it.
    conflicts.push({
      key: 'carrying_basis_evidence_conflict',
      statement: `These documents disagree about how this loan is carried, so no basis was recorded.`,
      expected: agreeing.map(e => e.text).join(' ') || '(nothing)',
      found: dissenting.map(e => e.text).join(' '),
      sources: ['agreement', 'loan history', 'lender portal'], severity: 'warn',
      caveat: `Recording a basis on split evidence is how the wrong one gets locked in. Resolve which reading is right before setting it.`,
    })
    proposedBasis = null
  }
  if (proposedBasis && agreeing.length >= 2) {
    establishedBasis = proposedBasis
    established.push({
      key: 'carrying_basis',
      value: proposedBasis === 'gross_payback' ? 'Payoff basis (fee included in the balance)' : 'Principal basis (fee held outside the balance)',
      how: agreeing.map(e => e.text).join(' '),
    })
    if (ctx.loan.carrying_basis !== proposedBasis) {
      actions.push({
        id: nextId('basis'),
        kind: 'set_carrying_basis',
        title: proposedBasis === 'gross_payback'
          ? 'Record that this loan is carried on a payoff basis'
          : 'Record that this loan is carried on a principal basis',
        plain_english: proposedBasis === 'gross_payback'
          ? `The balance on this loan means "everything still owed including the fee", not "cash still owed". That matters because it decides whether each payment needs splitting into principal and interest — on this basis it does not, and every payment correctly reduces the balance dollar for dollar. Recording it stops anything in the system from proposing a split that would leave a phantom balance behind at payoff.`
          : `The balance on this loan means "cash still owed", with the financing cost held outside it. Every payment therefore has to be split into a principal part and a cost part.`,
        payload: { carrying_basis: proposedBasis, evidence: agreeing.map(e => e.text).join(' ') },
        default_checked: true,
      })
    } else {
      corroborations.push({
        statement: `The loan is already recorded as ${proposedBasis === 'gross_payback' ? 'payoff basis' : 'principal basis'}, and these documents confirm it.`,
        sources: ['loan record', 'agreement', 'lender portal'], tie: 'exact',
      })
    }
  } else if (proposedBasis && agreeing.length === 1) {
    unresolved.push({
      question: `Is this loan carried on a payoff basis or a principal basis?`,
      why_it_matters: `It decides whether every payment has to be split into principal and financing cost. Get it wrong in one direction and the loan never clears; get it wrong in the other and no financing cost ever reaches the profit and loss.`,
      what_would_answer_it: `Only one piece of evidence pointed to an answer (${basisEvidence[0].text}). A lender statement or portal screenshot showing the balance and the amount paid to date would confirm it.`,
    })
  }

  // ── 4. Statement rows whose basis was never established ─────────────────
  {
    // Derived from the labels already on this loan's own history, NOT from the
    // agreement — which is what the action's own wording promises, and which
    // means it stands whether or not the carrying basis was established. Only a
    // unanimous existing basis counts; a loan whose history already disagrees
    // with itself is not one to add more labels to.
    const labelled = ctx.statements.map(s => s.balance_basis).filter(b => b && b !== 'unknown')
    const distinct = [...new Set(labelled)]
    const wanted = distinct.length === 1 ? distinct[0] : null
    const wrong = ctx.statements.filter(s => s.balance_basis === 'unknown')
    if (wanted && wrong.length) {
      const from = wrong[0].statement_date, to = wrong[wrong.length - 1].statement_date
      conflicts.push({
        key: 'statement_basis_unknown',
        statement: `${wrong.length} balance${wrong.length === 1 ? '' : 's'} on file (${from} to ${to}) do not say what they measure, while the rest of this loan's history does.`,
        expected: wanted, found: 'unknown', sources: ['loan history'], severity: 'warn',
        caveat: `An unlabelled balance is quietly excluded from the checks that compare your books to the lender, so a real discrepancy in this range would not have been reported.`,
      })
      actions.push({
        id: nextId('basisfix'),
        kind: 'correct_statement_basis',
        title: `Label ${wrong.length} unlabelled balance${wrong.length === 1 ? '' : 's'} (${from} to ${to})`,
        plain_english: `These balances came from the same place, on the same basis, as every other balance on this loan — they were just never labelled. Labelling them puts them back inside the lender-comparison checks.`,
        payload: { statement_dates: wrong.map(s => s.statement_date), balance_basis: wanted },
        default_checked: true,
      })
    }
  }

  // ── 5. Does the lender agree with the books? ────────────────────────────
  if (hasPortal && ctx.portal!.amount_remaining !== null) {
    const asOf = ctx.portal!.as_of
    const book = asOf
      ? ctx.statements.filter(s => s.statement_date <= asOf).slice(-1)[0]
      : ctx.statements.slice(-1)[0]
    if (book) {
      const diff = Number(book.principal_balance) - ctx.portal!.amount_remaining!
      if (near(diff, 0, 0.02)) {
        corroborations.push({
          statement: `Your books and the lender agree on the balance at ${book.statement_date} (${money(Number(book.principal_balance))}).`,
          sources: ['loan history', 'lender portal'], tie: 'exact',
        })
      } else {
        // WHICH WAY the gap runs decides what it probably is, and saying so is
        // the difference between a useful flag and an alarm.
        //
        //   books show MORE owing  -> the lender has counted payments the books
        //                             have not. On a loan repaid out of settled
        //                             payouts that is the normal state of affairs:
        //                             the lender counts a withholding when the sale
        //                             happens, the books when the payout lands two
        //                             days later. Real, worth watching, rarely urgent.
        //
        //   books show LESS owing  -> the books have credited payments the lender
        //                             has not acknowledged. Nothing benign explains
        //                             that, and it is the direction that means money.
        const booksLagLender = diff > 0

        // On a loan repaid out of settled card receipts the two balances are
        // SUPPOSED to differ, because the lender's clock starts at the sale and
        // the books' clock starts at the payout two or three business days later.
        // The old code said exactly that, in prose, and then raised the finding
        // anyway — which on every such loan means an alarm that can never be
        // cleared and that people learn to scroll past.
        //
        // So the claim is now tested rather than asserted: the gap either is a
        // few business days of this loan's own withholding or it is not. See
        // _shared/settlement-lag.ts.
        const rate = ctx.csv?.ok ? dailyWithholdingFromMonths(ctx.csv.months) : null
        const lag = explainBalanceGap({
          gap: diff,
          lenderAsOf: asOf,
          dailyWithholding: rate?.rate ?? null,
          rateBasis: rate?.basis ?? 'no transaction export in this set',
          repaysContinuously: rate?.continuous ?? false,
        })

        if (lag.benign) {
          // Explained by arithmetic. It is not a discrepancy, so it does not go
          // in front of anyone as one — it goes in the corroborations, where a
          // thing that checks out belongs.
          corroborations.push({
            statement:
              `Your books and the lender differ by ${money(Math.abs(diff))} at ${book.statement_date}, and that is expected. ${lag.statement}`,
            sources: ['loan history', 'lender portal', 'transaction export'],
            tie: 'within_tolerance',
          })
        } else {
          conflicts.push({
            key: 'balance_vs_lender',
            statement: booksLagLender
              ? `Your books show more still owing than the lender does.`
              : `Your books show less still owing than the lender does.`,
            expected: `${money(ctx.portal!.amount_remaining!)} (lender, ${asOf ?? 'as shown'})`,
            found: `${money(Number(book.principal_balance))} (books, ${book.statement_date})`,
            sources: ['loan history', 'lender portal'],
            severity: 'error',
            caveat: booksLagLender
              ? lag.statement
              : `This is the direction that matters. Your books have credited payments the lender does not acknowledge, and nothing routine explains that. Check it before this loan is relied on in a close.`,
          })
          actions.push({
            id: nextId('finding'),
            kind: 'raise_finding',
            title: `Flag the ${money(Math.abs(diff))} difference between your books and the lender`,
            plain_english: `The lender says ${money(ctx.portal!.amount_remaining!)} is still owed; your books say ${money(Number(book.principal_balance))}. That is a ${money(Math.abs(diff))} difference and it needs explaining before this loan is relied on in a close. ${lag.statement} Raising it puts it in Needs Attention, where it stays until someone resolves it.`,
            payload: {
              check_key: 'balance_vs_lender', severity: 'error',
              title: `${ctx.loan.xero_account_name ?? ctx.loan.lender}: books and lender disagree by ${money(Math.abs(diff))}`,
              detail: { book_balance: Number(book.principal_balance), book_date: book.statement_date,
                        lender_balance: ctx.portal!.amount_remaining, lender_date: asOf, difference: Number(diff.toFixed(2)),
                        settlement_lag: { verdict: lag.verdict, implied_calendar_days: lag.impliedCalendarDays,
                                          implied_business_days: lag.impliedBusinessDays,
                                          implied_books_through: lag.impliedBooksThrough } },
            },
            default_checked: true,
          })
        }
      }
    }
  }

  // ── 6. Does the export cover what the books recorded? ───────────────────
  // A difference here is usually TIMING, not loss: the lender dates a
  // withholding when the sale happens, the books date it when the payout
  // settles, and a payout lands a day or two later. Saying "missing" when the
  // truth is "in transit" sends someone hunting for a payment that is not lost.
  if (hasCsv && ctx.csv!.months.length) {
    for (const m of ctx.csv!.months) {
      const booked = ctx.splits
        .filter(s => s.period_label.startsWith(m.month) && s.source !== 'principal_payment')
        .reduce((a, s) => a + Number(s.total_amount), 0)
      if (booked === 0) {
        // The largest possible gap, and the first version skipped it silently.
        conflicts.push({
          key: `coverage_none_${m.month}`,
          statement: `${m.month}: the lender withheld money this month and your books recorded none of it.`,
          expected: `${money(m.total_paid)} across ${m.transaction_count} withholdings (${m.first_date} to ${m.last_date})`,
          found: 'nothing recorded for this month',
          sources: ['transaction export', 'loan history'],
          severity: m.last_date < ctx.todayPacific ? 'error' : 'warn',
          caveat: `This is not the usual settlement-timing difference — that shifts a few days at a month boundary. A whole month absent means the payments never reached the books at all.`,
        })
        continue
      }
      const diff = Number((m.total_paid - booked).toFixed(2))
      if (near(diff, 0, 0.02)) {
        corroborations.push({
          statement: `${m.month}: the lender's export and your books agree on ${money(booked)} of payments.`,
          sources: ['transaction export', 'loan history'], tie: 'exact',
        })
      } else {
        conflicts.push({
          key: `coverage_${m.month}`,
          statement: `${m.month}: the lender's export shows more withheld than your books recorded.`,
          expected: `${money(m.total_paid)} across ${m.transaction_count} withholdings (${m.first_date} to ${m.last_date})`,
          found: `${money(booked)} recorded`,
          sources: ['transaction export', 'loan history'],
          severity: 'warn',
          caveat: `Almost certainly timing, not missing money: the lender dates each withholding to the sale, your books date it to the payout that settles a day or two later. The end of the month is where the two always differ. Worth confirming, not worth alarm.`,
        })
      }
    }
  }

  // ── 7. Splits that carry no financing cost ──────────────────────────────
  // The check that started all this, and the one most easily got wrong.
  const zeroInterest = ctx.splits.filter(s => Number(s.interest_amount) === 0 && Number(s.total_amount) !== 0)
  if (zeroInterest.length && zeroInterest.length === ctx.splits.length && fixedFee !== null) {
    if (establishedBasis === 'gross_payback') {
      // CORRECT, and worth saying out loud so nobody "fixes" it later. Gated on
      // the ESTABLISHED basis: if the basis is only a hypothesis, so is this, and
      // "correct as booked" is not a sentence to write on a hypothesis.
      established.push({
        key: 'payments_carry_no_interest',
        value: 'Correct as booked',
        how: `Every payment on this loan is recorded as pure principal with no interest, and on a payoff basis that is right: the balance already includes the ${money(fixedFee)} fee, so each payment reduces it dollar for dollar. Splitting these payments would credit the fee back into the loan a second time and leave ${money(fixedFee)} still owing after the lender says paid in full.`,
      })
    } else if (proposedBasis === 'gross_payback') {
      // Leaning payoff-basis but not established. Say what it would mean and why
      // it is not being asserted, rather than either asserting it or going silent.
      unresolved.push({
        question: `Every payment on this loan is booked as pure principal, with no financing cost. Is that right?`,
        why_it_matters:
          `It depends entirely on the question above. If this loan is carried at payoff — the balance already including the ${money(fixedFee)} fee — then booking each payment as pure principal is correct, and splitting them would credit the fee back into the loan a second time. If it is carried at principal, then no financing cost is reaching your profit and loss at all. The same rows are either right or wrong depending on an answer these documents do not settle.`,
        what_would_answer_it: `The same evidence: a lender statement or portal screen showing both the balance still owed and the amount paid to date.`,
      })
    } else if (establishedBasis === 'net_principal') {
      const openMonths = [...new Set(ctx.splits.map(s => s.period_label.slice(0, 7)))]
        .filter(mth => !isClosed(mth, ctx.closeDate)).sort()
      unresolved.push({
        question: `No financing cost is being recorded on this loan's payments. Should the open months be corrected?`,
        why_it_matters: `On a principal basis every payment carries a financing cost, and none is reaching the profit and loss. ${openMonths.length ? `Months still open: ${openMonths.join(', ')}.` : 'Every affected month is already closed.'}`,
        what_would_answer_it: `Confirmation of how the fee was booked at origination. If it was expensed in full at the start, the cost is already recognised and nothing further is due. If it was capitalised, each open month needs a correcting entry.`,
      })
    }
  }

  // ── 7b. Where did the fee's offsetting debit go? ─────────────────────────
  // On a payoff-basis loan the fee was capitalised INTO the liability at
  // origination, which means something was debited for it on the same day. That
  // entry decides whether the loan's cost is in the profit and loss at all, and
  // it is not in any of these documents — it is in the ledger.
  //
  // This question took a full session to answer for Stripe Capital, and until it
  // was answered three mutually exclusive remedies all looked reasonable: an
  // amortisation entry, a reversal of a double-expensed fee, or a suspense
  // clean-up. Proposing any of them would have been a coin flip wearing a
  // proposal's clothes. So the engine asks instead.
  if (proposedBasis === 'gross_payback' && fixedFee !== null && fixedFee > 0) {
    const feeDocumented = /fixed fee|loan fee|financing cost|fee was/i.test(ctx.loan.structure_note || '')
    if (!feeDocumented) {
      unresolved.push({
        question: `The ${money(fixedFee)} fee was added into this loan's balance at the start. What was debited on the other side of that entry?`,
        why_it_matters:
          `It decides whether this loan's cost ever reaches your profit and loss, and these documents cannot say. If it was expensed at origination, the cost is recognised — all in one month, which flatters every month after it. If it went to a prepaid or deferred asset, something has to amortise it and nothing is. If it was plugged to a suspense account, there is ${money(fixedFee)} unexplained in your ledger. Three different answers, three different fixes, and no way to tell them apart from the outside.`,
        what_would_answer_it:
          `The journal dated on or around ${origination ?? 'the origination date'} that credited ${money(fixedFee)} to this loan's account. Whatever account took the matching debit is the answer. Once you know, record it in this loan's note so nobody has to ask again.`,
      })
    }
  }

  // ── 8. The structure note ───────────────────────────────────────────────
  if (hasAgreement && establishedBasis && loanAmount !== null && fixedFee !== null && totalRepayment !== null) {
    const pct = ((fixedFee / totalRepayment) * 100).toFixed(4)
    const note = [
      `${money(loanAmount)} borrowed with a fixed fee of ${money(fixedFee)}, repaid as ${money(totalRepayment)} in total${origination ? `, originated ${origination}` : ''}${finalRepayment ? ` and due in full by ${finalRepayment}` : ''}. There is no interest rate — the whole cost of this loan is that one fixed fee.`,
      num('repayment_rate_percent') !== null
        ? `Repayment is automatic: the lender withholds ${num('repayment_rate_percent')}% of every sale${minPayment !== null && minPeriodDays !== null ? `, with a floor of ${money(minPayment)} every ${minPeriodDays} days` : ''}. There is no monthly payment, so a monthly figure on this record is a rough guide only.`
        : '',
      establishedBasis === 'gross_payback'
        ? `In the books: account ${ctx.loan.xero_account_code ?? '(unset)'} carries the FULL payback of ${money(totalRepayment)}, fee included, so every payment is pure principal and no interest is booked per payment. Balances on file are payoff figures, not principal — never compare them against a principal-only balance from anywhere else.`
        : `In the books: account ${ctx.loan.xero_account_code ?? '(unset)'} carries principal only, so every payment splits into principal and financing cost. Balances on file are principal-only.`,
      ctx.decomposition?.holds
        ? `Each withholding splits ${pct}% fee / ${(100 - Number(pct)).toFixed(4)}% financing, rounded to the cent — proven against ${ctx.decomposition.rows_checked} of the lender's own transactions, not assumed.`
        : '',
    ].filter(Boolean).join('\n\n')

    actions.push({
      id: nextId('note'),
      kind: 'write_structure_note',
      title: ctx.loan.structure_note ? 'Update the plain-English note on this loan' : 'Write a plain-English note explaining how this loan works',
      plain_english: `A short description of the loan and how it is booked, shown on the loan's page. It is what stops the next person — or the next session — from having to work all this out again.`,
      payload: { structure_note: note, previous: ctx.loan.structure_note },
      default_checked: true,
    })
  }

  // ── 9. Nothing may be proposed against a closed period ──────────────────
  for (const a of actions) {
    const p: any = a.payload
    // The first version looked only at `period_label`, which NO action in this
    // file carries — so the whole block-and-grey mechanism, which both the apply
    // step and the review screen honour correctly, never once activated. A guard
    // is only as good as the branch it sits on. The action that actually reaches
    // into closed months is correct_statement_basis, via statement_dates.
    const dates: string[] = Array.isArray(p?.statement_dates) ? p.statement_dates : []
    const closedDates = dates.filter(d => isClosed(d, ctx.closeDate))
    const label: string | undefined = p?.period_label ?? closedDates[closedDates.length - 1]
    if (label && isClosed(label, ctx.closeDate)) {
      a.blocked_reason = `${label} is inside the closed books (closed through ${ctx.closeDate}). A correction there is a prior-period adjustment and belongs with your accountant, not a button here.`
      a.default_checked = false
    }
  }

  // ── 10. Assemble ────────────────────────────────────────────────────────
  const plan: BundlePlan = {
    loan: {
      id: ctx.loan.id, lender: ctx.loan.lender,
      xero_account_name: ctx.loan.xero_account_name,
      lender_account_number: ctx.loan.lender_account_number,
      carrying_basis: ctx.loan.carrying_basis,
    },
    documents: ctx.documents,
    established, corroborations, conflicts, actions,
    unresolved: [
      ...unresolved,
      ...ctx.agreementUnresolved.map(u => ({
        question: 'A term on the agreement could not be read with confidence.',
        why_it_matters: 'A figure read wrongly off a signed document is worse than one not read at all.',
        what_would_answer_it: u,
      })),
    ],
    summary: '',
  }
  return summarisePlan(plan)
}

/**
 * Write the one-line summary from the FINISHED plan.
 *
 * Separated out and exported because loan-bundle/index.ts appends more
 * corroborations after buildPlan returns — the agreement's own arithmetic
 * checks and the portal screenshot's. Counting inside buildPlan meant the header
 * said "2 things checked out against each other" above a list of five. A number
 * on screen that disagrees with the list beneath it is exactly the class of bug
 * this module keeps finding in itself; the fix, as ever, is one function that
 * every surface calls rather than a count taken at a convenient moment.
 *
 * Call this again after mutating a plan.
 */
export function summarisePlan(plan: BundlePlan): BundlePlan {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  const errCount = plan.conflicts.filter(c => c.severity === 'error').length
  const warnCount = plan.conflicts.filter(c => c.severity === 'warn').length
  const open = plan.actions.filter(a => !a.blocked_reason).length
  plan.summary = [
    `${n(plan.documents.length, 'document', 'documents')} read together for ${plan.loan.xero_account_name ?? plan.loan.lender}.`,
    plan.corroborations.length ? `${n(plan.corroborations.length, 'thing', 'things')} checked out against each other.` : '',
    errCount ? `${errCount} need${errCount === 1 ? 's' : ''} attention.` : '',
    warnCount ? `${warnCount} worth a look.` : '',
    plan.unresolved.length ? `${n(plan.unresolved.length, 'question', 'questions')} these documents cannot answer on their own.` : '',
    `${n(open, 'change', 'changes')} ready for you to approve.`,
  ].filter(Boolean).join(' ')
  return plan
}
