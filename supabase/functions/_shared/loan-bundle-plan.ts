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
import { explainBalanceGap, dailyWithholdingFromMonths, lenderExportFromCsv, RATE_SOURCES } from './settlement-lag.ts'
import { dateFromLedger, paidFromOutstanding, type LedgerDatingResult, type LedgerDatingFigures } from './ledger-dating.ts'
import { BOOK_BALANCE_SOURCES } from './carrying-basis-drift.ts'

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
    principal_balance: number | null
    fee_balance: number | null
    total_balance: number | null
    amount_remaining_basis: 'gross_payback' | 'net_principal' | null
    lender_balance_net_principal: number | null
    lender_balance_gross_payback: number | null
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
  // The two that write a BALANCE. Everything above establishes facts ABOUT the
  // loan; these two put a figure on the line the rollforward reads. They are still
  // not money entries — no split, no journal — but they are the only actions here
  // whose output another screen does arithmetic ON, which is why both of them
  // refuse rather than guess when a date or a basis is missing.
  | 'open_at_origination'
  | 'record_lender_balance'
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
  /**
   * Terms stated by a lender's TRANSACTION HISTORY rather than by a signed
   * agreement — PayPal's export carries its advance and its fee as rows.
   *
   * Separate from `agreementTerms` on purpose. Both are the lender speaking and
   * both belong in `loan_contract_terms`, but one is a contract and the other is
   * a record of what actually moved, and this module has learnt (Tech Debt #31)
   * that letting a mechanism stand in for a provenance is how our own reading
   * ends up speaking in the lender's voice. The action that records these names
   * the CSV.
   */
  /**
   * True when the transaction export CONTAINS this loan's origination row, and
   * therefore begins at the loan's own beginning.
   *
   * This is the evidence for `openingCumulative: 0` when dating a screenshot.
   * ledger-dating.ts calls that "a claim, not a convenience" — passing zero
   * asserts nothing was withheld between the period start and the file's first
   * day — and an export carrying the advance itself is exactly the evidence for
   * the claim: there is no earlier activity for the file to be missing.
   *
   * Without it, a loan originated 2025-12-10 whose first payment is 2025-12-17
   * refuses with `coverage_starts_late` on a file that is demonstrably complete,
   * because the period start falls a week before the first withholding. That is
   * the refusal doing its job with the wrong input, not a file that is short.
   */
  csvCoversFromOrigination?: boolean
  ledgerTerms?: ContractTerm[]
  /** The file those terms were read from, for the action's title. */
  ledgerTermsSource?: string | null
  /**
   * Keys where the agreement and the transaction history DISAGREE. Such a key
   * appears in neither, because a figure two lender documents contradict is not
   * evidence — and this one feeds a conversion that puts a date on a balance.
   */
  termConflicts?: string[]
  agreementChecks: string[]
  agreementUnresolved: string[]
  /** Parsed transaction export, if the bundle contained one. */
  csv: StripeCsvParseResult | null
  /**
   * What happened when the bundle carried MORE THAN ONE export: combined into one
   * ledger, or refused and why. Null when there was only one.
   *
   * It is a field rather than a silent behaviour because whether two exports were
   * combined decides whether a screenshot can be dated at all, and this module's
   * standing rule is that an optional step may fail silently in its EFFECT, never
   * in its RECORD. A person told "the date could not be established" needs to know
   * that two files were uploaded and one was dropped.
   */
  csvNote?: string | null
  /**
   * What the LEDGER says about the capitalised fee. null when no search was made
   * (no fee, no account code, no origination date); a result with verdict
   * 'incomplete' when one was attempted and could not be finished.
   *
   * The plan used to ask "what was debited on the other side" and answer its own
   * question with "these documents cannot say" — true, and beside the point, since
   * the ledger can. See _shared/origination-fee.ts.
   */
  feeSearch: {
    verdict: 'found' | 'ambiguous' | 'not_found' | 'incomplete'
    statement: string
    journal_id: string | null
    journal_date: string | null
    debit_account: string | null
    debit_account_name: string | null
    /** 'expensed' | 'capitalised' | 'suspense' | 'unusual' | 'unknown' */
    treatment_kind?: string | null
  } | null
  decomposition: DecompositionResult | null
  /** Control totals read off a portal screenshot, if one was present. */
  portal: {
    as_of: string | null
    amount_remaining: number | null
    paid_to_date: number | null
    principal_paid: number | null
    fee_paid: number | null
    total_amount_due: number | null
    /** What is still OWED, where the lender itemises it rather than what is paid. */
    principal_balance: number | null
    fee_balance: number | null
    total_balance: number | null
    /**
     * What `amount_remaining` MEASURES, established by the screen's own
     * arithmetic. Null unless the screen itemised and the identity came out —
     * the planner must never assume a basis, and this is the one field that can
     * tell it, from evidence, whether the balance beside it includes the fee.
     */
    amount_remaining_basis: 'gross_payback' | 'net_principal' | null
    /**
     * The lender's balance on EACH basis, where the screen itemised. This is what
     * lets §5 compare like for like instead of classifying the screen onto one
     * basis it may never have stated.
     */
    lender_balance_net_principal: number | null
    lender_balance_gross_payback: number | null
    /**
     * Which of the figures above took part in an identity that CAME OUT RIGHT —
     * checkPortalTotals' own verdict, carried through the merge.
     *
     * It was dropped on the way into the planner, and that omission is why a
     * balance could only ever be judged PRESENT here. Present is not proven: on
     * this very loan $125,000 of funding was read as $123,091.66 of balance and
     * was present the whole time. Section 5b will not file a lender anchor on a
     * figure nothing vouches for, and it needs this list to tell the difference.
     */
    corroborated: string[]
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

/**
 * The three sources that mean "a document the LENDER issued". Everything else on
 * loan_statements — xero_derived, xero_balance_snapshot, amortization_schedule —
 * is our own arithmetic wearing a statement's clothes, and a loan checked against
 * one of those is a loan checked against itself.
 *
 * ALIASED, NOT RETYPED. RATE_SOURCES in _shared/settlement-lag.ts is already
 * exactly these three, and its own comment says it is deliberately the same set
 * the engine anchors on (REAL_ANCHOR_SOURCES in reconciliation-run/index.ts) and
 * the dashboard trusts (_VARIANCE_REAL_ANCHORS in admin-dashboard/index.html).
 * That list existed NINE times before session 239 went and found them all; typing
 * it once more here is the cheapest possible route to ten.
 *
 * The coupling is real and worth naming: narrowing RATE_SOURCES for a
 * rate-measurement reason would silently narrow what counts as an anchor HERE,
 * and section 5b would then stop seeing a conflicting lender row it should have
 * seen. tests/loan-bundle-balances.test.mts pins the three values and pins them
 * against the dashboard's own copy, so that divergence fails loudly instead.
 */
export const REAL_ANCHOR_SOURCES = RATE_SOURCES

/**
 * What section 4b writes into loan_statements.source.
 *
 * The column is free text with no CHECK constraint, so the choice is entirely
 * ours — and it is load-bearing. A day-one balance is the CONTRACT's statement of
 * what was owed before anything happened; it is not a lender statement of a period
 * balance, and the dashboard's real-anchor allowlist above must keep saying so.
 * Anything not on that list fails safe: it can open a rollforward but can never
 * close one, never satisfies the statement checklist, and never anchors a
 * reconciliation. Which is precisely the standing this row deserves.
 *
 * Every dashboard surface degrades rather than breaks on a value it does not know
 * — the anchor test is an allowlist, the statement table prints the raw source
 * with underscores swapped for spaces, and _anchorSourceLabel ends in a fallback.
 * ONE OUTSTANDING NIT, recorded here so it is not rediscovered: that fallback is
 * the close band's opening column, so until admin-dashboard/index.html adds
 *
 *     contract_origination: 'signed agreement',
 *
 * to _ANCHOR_SOURCE_LABEL, that column reads "30 Jun · contract_origination". The
 * figure, the date and the not-authoritative styling are all correct; only the
 * word is a slug. Pinned in tests/loan-bundle-balances.test.mts §7, which will
 * fail the day somebody fixes it and tell them to delete the note.
 */
export const ORIGINATION_SOURCE = 'contract_origination'

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

  // The agreement first, the lender's own transaction history where the
  // agreement is silent. index.ts has already removed any key the two contradict,
  // so a conflicted term is absent here rather than resolved here — one place
  // decides, and it is not this lookup.
  const ledgerTerms = ctx.ledgerTerms ?? []
  const termConflicts = ctx.termConflicts ?? []
  const termOf = (key: string) =>
    ctx.agreementTerms.find(t => t.term_key === key) ?? ledgerTerms.find(t => t.term_key === key)
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

  }

  // ── 2c. Terms that CONTRADICT the loan record ───────────────────────────
  //
  // UNGATED FROM THE AGREEMENT (session 263 cont.). This whole block sat inside
  // `if (hasAgreement)`, so a lender that sends no agreement PDF — PayPal sends
  // none — could state its terms in its own transaction history and never have
  // them held up against what is typed on the loan record. On the loan that
  // exposed it, the record says $177,500 where the lender's own rows say
  // $157,000.00 + $20,565.12 = $177,565.12, and nothing said a word.
  //
  // Third time in one day I have added a source of truth and left a consumer
  // keyed to the old one. The rule I wrote into the notes this morning is that a
  // guard is only as good as the branch it sits on; the same is true of a reader.
  {
    // Which document a term came from, so the row can name it. A term is the
    // agreement's if it is in that list; anything else reached us through the
    // lender's own ledger.
    const sourceOf = (key: string) =>
      ctx.agreementTerms.some(t => t.term_key === key) ? 'the agreement' : `the lender's transaction history`
    const compare: { term: string; field: string; label: string; onFile: unknown; fromDoc: unknown }[] = []
    if (finalRepayment) compare.push({ term: 'final_repayment_date', field: 'maturity_date', label: 'Maturity date', onFile: ctx.loan.maturity_date, fromDoc: finalRepayment })
    if (origination) compare.push({ term: 'origination_date', field: 'original_date', label: 'Origination date', onFile: ctx.loan.original_date, fromDoc: origination })
    // `original_amount` IS AMBIGUOUS AND MUST NOT BE SET FROM ONE BASIS.
    //
    // The field can mean the cash advanced or the whole payback, and the record
    // does not say which. Proposing `loan_amount` into it whenever they differ
    // would, on a fee-based loan, silently restate a gross figure as a net one —
    // this module's oldest bug, in the form of a helpful-looking one-tap.
    //
    // So: if it equals either figure, say which basis it is on and move on. If it
    // equals NEITHER, that is worth reporting and nobody here can choose — the
    // choice IS the carrying-basis question, and it is settled elsewhere or not
    // at all. Report both candidates, propose no write.
    const onFileAmt = ctx.loan.original_amount === null || ctx.loan.original_amount === undefined
      ? null : Number(ctx.loan.original_amount)
    if (loanAmount !== null || totalRepayment !== null) {
      const matchesNet = onFileAmt !== null && loanAmount !== null && near(onFileAmt, loanAmount, 0.02)
      const matchesGross = onFileAmt !== null && totalRepayment !== null && near(onFileAmt, totalRepayment, 0.02)
      if (matchesNet || matchesGross) {
        corroborations.push({
          statement: `The original amount on the loan record (${money(onFileAmt!)}) is ${matchesGross ? 'the whole payback, fee included' : 'the cash advanced, with the fee held outside it'}, and ${sourceOf(matchesGross ? 'total_repayment_amount' : 'loan_amount')} agrees to the cent.`,
          sources: ['loan record', matchesGross ? 'total_repayment_amount' : 'loan_amount'], tie: 'exact',
        })
      } else if (onFileAmt === null) {
        conflicts.push({
          key: 'term_original_amount',
          statement: `The loan record has no original amount; ${sourceOf('loan_amount')} states this loan's opening figures.`,
          expected: [loanAmount !== null ? `${money(loanAmount)} advanced` : null,
                     totalRepayment !== null ? `${money(totalRepayment)} repaid in total` : null].filter(Boolean).join(' · '),
          found: '(blank)',
          sources: ['loan record', "lender's own documents"],
          severity: 'info',
          caveat: `Which of the two belongs in that field depends on how this loan is carried, so nothing is proposed for it here.`,
        })
      } else {
        conflicts.push({
          key: 'term_original_amount',
          statement: `The original amount on the loan record matches neither figure the lender states.`,
          expected: [loanAmount !== null ? `${money(loanAmount)} advanced` : null,
                     totalRepayment !== null ? `${money(totalRepayment)} repaid in total` : null].filter(Boolean).join(' · '),
          found: `${money(onFileAmt)} on the loan record`,
          sources: ['loan record', "lender's own documents"],
          severity: 'warn',
          caveat: `A typed note, and it is out by ${totalRepayment !== null ? money(Math.abs(totalRepayment - onFileAmt)) : money(Math.abs(loanAmount! - onFileAmt))} against the closer of the two. Nothing is proposed for it: the field can hold either the cash advanced or the whole payback, and choosing between them is the carrying-basis question rather than a typo to correct. Recording ${sourceOf('loan_amount')}'s figures above puts both on file with the row each was read from, which is the durable fix — the typed note stops being the only thing anyone can consult.`,
        })
      }
    }

    for (const c of compare) {
      const same = c.onFile !== null && String(c.onFile).slice(0, 10) === String(c.fromDoc).slice(0, 10)
      if (same) {
        corroborations.push({
          statement: `${c.label} on file matches ${sourceOf(c.term)} (${c.fromDoc}).`,
          sources: ['loan record', sourceOf(c.term)], tie: 'exact',
        })
        continue
      }
      const wasBlank = c.onFile === null || c.onFile === undefined || c.onFile === ''
      conflicts.push({
        key: `term_${c.field}`,
        statement: wasBlank
          ? `${c.label} is blank on the loan record; ${sourceOf(c.term)} states it.`
          : `${c.label} on the loan record disagrees with ${sourceOf(c.term)}.`,
        expected: String(c.fromDoc), found: wasBlank ? '(blank)' : String(c.onFile),
        sources: ['loan record', sourceOf(c.term)],
        severity: wasBlank ? 'info' : 'warn',
      })
      actions.push({
        id: nextId('applyterm'),
        kind: 'apply_term_to_loan',
        title: `${c.label}: ${wasBlank ? 'set to' : 'change to'} ${c.fromDoc}${wasBlank ? '' : ` (currently ${c.onFile})`}`,
        plain_english: wasBlank
          ? `The loan record has no ${c.label.toLowerCase()}. ${sourceOf(c.term) === 'the agreement' ? 'The agreement' : "The lender's own transaction history"} gives it as ${c.fromDoc}.`
          : `The loan record says ${c.onFile}. ${sourceOf(c.term) === 'the agreement' ? 'The signed agreement' : "The lender's own transaction history"} says ${c.fromDoc}, and a document from the lender is better evidence than a note someone typed.`,
        // The source document rides along so the apply step can mark THIS
        // document's term applied rather than every document's term for this key.
        payload: {
          field: c.field, term_key: c.term, value: c.fromDoc, previous: c.onFile,
          // The document this term actually came from. It was hardcoded to the
          // agreement, so a ledger-sourced term would have marked an agreement's
          // term applied — or nothing at all, on a bundle with no agreement in it.
          source_sha256: (sourceOf(c.term) === 'the agreement'
            ? ctx.documents.find(d => d.kind === 'agreement')?.sha256
            : ctx.documents.find(d => d.kind === 'transaction_history')?.sha256) ?? null,
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

  // ── 2b. Terms the lender's own LEDGER states (session 263 cont.) ─────────
  // PayPal sends no agreement PDF here; its loan-history CSV carries the wire
  // and the fee as rows, which is the lender's record of what it actually sent
  // and actually charged. Proposed under its own title so nobody reads a
  // transaction export as a signed contract.
  if (ledgerTerms.length) {
    const src = ctx.ledgerTermsSource ? ` from ${ctx.ledgerTermsSource}` : ''
    actions.push({
      id: nextId('ledgerterms'),
      kind: 'record_contract_terms',
      title: `Record ${ledgerTerms.length} opening figure${ledgerTerms.length === 1 ? '' : 's'} from the lender's transaction history`,
      plain_english:
        `The lender's own export${src} states what it advanced and what it charged, so those figures are recorded as this loan's terms — each with the row it was read from. This is the lender's record of what actually moved, not a signed agreement, and it is filed as exactly that. It matters beyond the record: without these figures nothing can turn a balance still owed into an amount paid, which is what lets an undated screenshot be dated against this same ledger.`,
      payload: {
        terms: ledgerTerms,
        extracted_by: 'deterministic_parser:paypal_loan_history_v1',
        source_sha256: ctx.documents.find(d => d.kind === 'transaction_history')?.sha256 ?? null,
      },
      default_checked: true,
    })
  }

  // Two of the lender's own documents contradicting each other about the same
  // term. This is an UNRESOLVED QUESTION, not a finding: the figure is already
  // absent from every calculation above, and the module's job when documents do
  // not settle a question is to hand the question back rather than answer it.
  if (termConflicts.length) {
    unresolved.push({
      question: `Which of this lender's own documents states this loan's terms correctly?`,
      why_it_matters: `These figures are what turn a balance still owed into an amount paid, which is how an undated screenshot gets a date. A date built on a contested figure does not fail loudly — it moves the variance on the one screen whose job is to say this loan is ready for the accountant.`,
      what_would_answer_it: `Two documents disagree: ${termConflicts.join('; ')}. Neither was used and nothing below rests on either. Decide which document is the operative one, and remove or supersede the other.`,
    })
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

  // The basis anything below is allowed to rest on. `establishedBasis` first —
  // two independent pieces of evidence agreeing — then the column already on the
  // loan, which somebody set with evidence of their own. `proposedBasis` is
  // deliberately NOT consulted: it is a leading hypothesis, and the whole of
  // section 3 exists to stop confident things being built on one. The recorded
  // column is dropped the moment these documents contradict themselves about the
  // basis, because that conflict is exactly the case where the column may be the
  // thing that is wrong.
  const basisDisputed = conflicts.some(c => c.key === 'carrying_basis_evidence_conflict')
  const recordedBasis: 'gross_payback' | 'net_principal' | null =
    ctx.loan.carrying_basis === 'gross_payback' ? 'gross_payback'
    : ctx.loan.carrying_basis === 'net_principal' ? 'net_principal' : null
  const settledBasis: 'gross_payback' | 'net_principal' | null =
    establishedBasis ?? (basisDisputed ? null : recordedBasis)

  // ── 4b. The balance on day one ──────────────────────────────────────────
  // The Stripe Capital bundle planned ten changes, every one of them applied, and
  // NOT ONE OF THEM WROTE A BALANCE. The engine read the lender's own figure off a
  // screenshot, used it to establish the carrying basis, and then discarded it as
  // a balance. The loan still said "no opening balance" on the Loans page and was
  // left out of the month-end rollforward altogether.
  //
  // The rollforward opens each month with _loanBalanceAsOf(loan, priorMonthEnd).
  // This loan originated 2026-06-30 and the automated Xero sweep's first row is
  // dated 2026-07-01, so that lookup finds nothing: it MISSES BY ONE DAY. One day
  // is the whole difference between a loan that rolls forward and a loan nobody
  // can close.
  //
  // Day one is not a measurement, it is the contract. Nothing has been repaid, so
  // the balance is whatever the books carry this loan AT — which is why this
  // action will not name a figure until the carrying basis is settled. On a payoff
  // basis day one is the whole payback; on a principal basis it is the cash
  // borrowed; the two differ by the fee, and guessing between them writes this
  // module's own $20,875 phantom liability into the one row every month-end opens
  // on. A missing opening balance is a visible gap. A wrong one is not.
  //
  // NOT subject to the closed-period guard in section 9, and that is a decision
  // rather than an oversight. Section 9 blocks corrections that reach into closed
  // months; this row is not a correction and moves no money — and by construction
  // it is the OLDEST row on the loan, so a loan originated before the close date
  // (which is most of them) would have the one action that can give it an opening
  // balance permanently greyed out. That is the bug being fixed, reintroduced as a
  // guard.
  {
    // The agreement's date first. The loan record is a fallback, not a preference:
    // section 2 is already offering to copy the agreement's date onto the record
    // precisely because the record's copy can be a hand-typed guess, and a balance
    // filed on the wrong day is a balance filed against the wrong month.
    const dayOneDate = origination ?? ctx.loan.original_date

    // ON the origination date counts as covered. A row dated exactly 2026-06-30
    // already answers the rollforward's question, and a second row that day would
    // be two answers to it.
    const covered = dayOneDate ? ctx.statements.some(s => s.statement_date <= dayOneDate) : false

    // A future origination date is bad data, not an opening balance. The dashboard
    // has a long history of future-dated rows winning "latest balance" picks —
    // Verdant's whole amortization schedule ingested as statements made a live
    // $248k loan read as paid off — and this is not the place to add another one.
    if (dayOneDate && !covered && dayOneDate <= ctx.todayPacific) {
      // The day-one figure IS the carrying basis restated, so it is read from the
      // term that basis names and from no other. For net_principal that is
      // `loan_amount` ahead of `net_loan_proceeds`, which is the same figure
      // section 3's detector compares the earliest balance against — writing a
      // day-one row that the detector would then read as evidence for the OTHER
      // basis is a loop this module can do without.
      const netPrincipal = loanAmount ?? num('net_loan_proceeds')
      const dayOne = settledBasis === 'gross_payback' ? totalRepayment
                   : settledBasis === 'net_principal' ? netPrincipal
                   : null
      const derivedFrom = settledBasis === 'gross_payback' ? 'total_repayment_amount'
                        : settledBasis === 'net_principal' ? (loanAmount !== null ? 'loan_amount' : 'net_loan_proceeds')
                        : null
      // Must satisfy loan_statements' CHECK (balance_basis IN ('principal_only',
      // 'total_payback','payoff_quote','unknown')) AND mean the same thing as the
      // loan's carrying basis. A payoff figure labelled principal_only is not a
      // mislabelled row, it is a wrong number in every check that reads the label.
      const balanceBasis = settledBasis === 'gross_payback' ? 'total_payback'
                         : settledBasis === 'net_principal' ? 'principal_only' : 'unknown'

      const blockedReason = !settledBasis
        ? `The day-one balance depends on how this loan is carried, and that is not settled. On a payoff basis it is the whole ${totalRepayment !== null ? money(totalRepayment) : 'contractual'} payback; on a principal basis it is the ${netPrincipal !== null ? money(netPrincipal) : 'cash'} borrowed. Those are two different balances, nothing in these documents chooses between them, and this is the figure every month afterwards is measured from. Settle the carrying basis first.`
        : dayOne === null
        ? `This loan is carried on a ${settledBasis === 'gross_payback' ? 'payoff basis, so day one is the agreement’s Total Repayment Amount' : 'principal basis, so day one is the amount borrowed'} — and that figure is not among the terms these documents state.`
        : undefined

      // The sweep's own first reading, when it agrees to the cent. Worth saying
      // out loud rather than merely computing with: a contract figure that matches
      // the first independent reading of the same account is a measurement that
      // happened to arrive a day late, not an assumption.
      const firstOnFile = ctx.statements.length ? ctx.statements[0] : null
      const corroboratedBy = (dayOne !== null && firstOnFile && near(Number(firstOnFile.principal_balance), dayOne))
        ? firstOnFile : null

      actions.push({
        id: nextId('openbal'),
        kind: 'open_at_origination',
        title: dayOne !== null
          ? `Record the opening balance of ${money(dayOne)} at ${dayOneDate}`
          : `Record this loan's opening balance at ${dayOneDate}`,
        plain_english: [
          dayOne !== null
            ? `On the day this loan was signed nothing had been repaid, so the balance was ${money(dayOne)} — ${settledBasis === 'gross_payback' ? 'the whole payback, fee included, which is what this loan is carried at' : 'the cash borrowed, with the financing cost carried outside the balance'}.`
            : `This would record what this loan's balance was on the day it was signed.`,
          `Your books hold no balance on or before ${dayOneDate}, so the month-end rollforward has nothing to open on and this loan drops out of the close entirely.`,
          corroboratedBy
            ? `The earliest balance already on file (${corroboratedBy.statement_date}, ${money(Number(corroboratedBy.principal_balance))}) is the same figure to the cent, arrived at independently — this fills in the day before it.`
            : '',
          `It is filed as the contract's own statement of day one, not as a lender statement, so it can open a month but can never stand in for a figure the lender actually sent.`,
        ].filter(Boolean).join(' '),
        // Everything the apply step needs and nothing it has to work out. The
        // figure is decided HERE, on screen, in front of the person approving it;
        // re-deriving it at apply time is how what was approved and what happened
        // become two different things with no audit trail showing it.
        payload: {
          statement_date: dayOneDate,
          principal_balance: dayOne,
          balance_basis: balanceBasis,
          source: ORIGINATION_SOURCE,
          carrying_basis: settledBasis,
          derived_from: derivedFrom,
          corroborated_by: corroboratedBy
            ? { statement_date: corroboratedBy.statement_date,
                principal_balance: Number(corroboratedBy.principal_balance),
                source: corroboratedBy.source }
            : null,
        },
        default_checked: !blockedReason,
        ...(blockedReason ? { blocked_reason: blockedReason } : {}),
      })
    }
  }

  // ── 5a. WHICH DAY IS THE LENDER'S BALANCE FOR? ──────────────────────────
  //
  // Derived ONCE, here, above every section that needs it. It used to be computed
  // inside §5b, which meant §5 ran first without it, and the two sections then
  // contradicted each other on screen in the same plan:
  //
  //   §5  "There is no lender as-of date here, so there is no window to measure
  //        an export against."          -> raised a finding asking for an export
  //   §5b "...the running total is $22,783.34 on 2026-08-26, and on no other day
  //        in the file."                -> had just measured the date FROM the
  //                                        export that was already in the bundle
  //
  // David hit exactly that: the plan asked him to upload the file he had uploaded,
  // and the answer was in the item directly beneath the question. It fails the
  // third gate of the First Law — could the system have answered it itself? It
  // could, and it had, eleven lines lower.
  //
  // The screen's OWN date always wins; the ledger only speaks when the screen is
  // silent, and only on a corroborated, unique, exact match (see ledger-dating.ts
  // for every way it refuses). One value, one definition, every consumer.
  const repaymentStart = date('repayment_start_date') ?? origination ?? ctx.loan.original_date

  // ── THE SCREEN MAY STATE WHAT IS OWED RATHER THAN WHAT IS PAID (session 263)
  //
  // Everything below dates a PAID figure, because Stripe's screen states paid
  // figures. PayPal's states the mirror — principal owed, fee owed, and the two
  // together — and it prints no as-of date either, so it was exactly as
  // undatable and for no better reason. The conversion is the contract's own
  // arithmetic and lives in ledger-dating.ts, which refuses it whenever the
  // terms are absent, contradict each other, or produce something impossible.
  //
  // The screen's own paid figures WIN where it prints them. This only fills a
  // silence, and only from figures the screen's own arithmetic vouched for —
  // dating an anchor off a number nothing checked would put a misread in charge
  // of the date, which is the failure §5b already exists to prevent.
  const portalCorrob = (ctx.portal?.corroborated || [])
  const paidTargetFromScreen: LedgerDatingFigures | null =
    (hasPortal && ctx.portal!.paid_to_date !== null && portalCorrob.includes('paid_to_date'))
      ? { paid: ctx.portal!.paid_to_date!, financing: ctx.portal!.principal_paid, fee: ctx.portal!.fee_paid }
      : null
  const outstandingConversion =
    (!paidTargetFromScreen && hasPortal &&
     ctx.portal!.total_balance !== null && portalCorrob.includes('total_balance'))
      ? paidFromOutstanding(
          { principal_balance: ctx.portal!.principal_balance,
            fee_balance: ctx.portal!.fee_balance,
            total_balance: ctx.portal!.total_balance },
          { loan_amount: loanAmount, fixed_fee: num('fixed_fee'),
            total_repayment_amount: num('total_repayment_amount') })
      : null
  const portalPaidTarget: LedgerDatingFigures | null =
    paidTargetFromScreen ?? outstandingConversion?.target ?? null

  const portalDating: LedgerDatingResult | null =
    // THE GATE IS `portalPaidTarget`, AND NOTHING ELSE ABOUT WHICH FIGURE IT CAME
    // FROM (session 263 cont.). This used to also demand `amount_remaining` be
    // present and corroborated — which was the same requirement stated twice for
    // the Stripe path and an outright block on the PayPal one, whose screen has
    // no headline balance at all: it labels its rows "Total balance", so
    // `amount_remaining` is correctly null and the date was refused on a screen
    // that states its figures more completely than Stripe's does.
    //
    // `portalPaidTarget` already carries the whole requirement. It is non-null
    // only from a corroborated `paid_to_date` or a corroborated `total_balance`,
    // so a figure nothing on the screen vouched for can never reach `target`.
    // Session 231's shape, and I committed it myself adding the second path: the
    // right check, one branch away from the road that needed it.
    (hasPortal && !ctx.portal!.as_of && ctx.csv && ctx.csv.days.length > 0 && ctx.csv.first_date &&
     repaymentStart && portalPaidTarget !== null)
      ? dateFromLedger({
          days: ctx.csv.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
          // `ok` false means rows could not be read, which understates the running
          // total and therefore dates the screen LATE. Passed through rather than
          // filtered out so the refusal can say so.
          complete: ctx.csv.ok === true,
          coversFrom: ctx.csv.first_date,
          periodStart: repaymentStart,
          // Zero, asserted from evidence: the export carries the loan's own
          // origination row, so nothing precedes its first day. Never passed on
          // a partial export, where the head is genuinely unknown and the
          // coverage refusal is the correct answer.
          openingCumulative: ctx.csvCoversFromOrigination ? { paid: 0, financing: 0, fee: 0 } : null,
          // The target must be a figure the screen's own arithmetic vouched for.
          // Dating a lender anchor off a number nothing on the screen checked would
          // put the misread this module already caught once ($125,000 of funding
          // read as $123,091.66 of balance) in charge of the date as well.
          target: portalPaidTarget!,
        })
      : null
  const portalDerivedDate = portalDating?.corroborated ? portalDating.date : null
  const portalAsOf = (hasPortal ? ctx.portal!.as_of : null) ?? portalDerivedDate

  // ── 5. Does the lender agree with the books? ────────────────────────────
  //
  // WHICH LENDER FIGURE, MEASURED AGAINST WHICH BOOK FIGURE (session 263 cont.).
  //
  // This compared `amount_remaining` against `book.principal_balance` and asked
  // no questions about what either one measured. On Stripe that was survivable
  // because both are payoff figures; on a loan whose books are principal-only it
  // is the module's oldest bug, the one that left PayPal carrying an
  // unexplainable discrepancy for nine months — two quantities on two bases
  // subtracted from each other and the difference reported as a problem.
  //
  // A screen that ITEMISES states both, so there is nothing to classify: pick the
  // one matching whatever the book row says it is carrying. Where the book row is
  // unlabelled (`balance_basis` 'unknown'), no comparison is made at all — an
  // unlabelled balance cannot be compared to anything without guessing, and a
  // guess here manufactures a gap or hides one.
  const lenderBalanceFor = (bookBasis: string | null | undefined): { value: number; basis: string } | null => {
    const p = ctx.portal!
    const net = p.lender_balance_net_principal ?? null
    const gross = p.lender_balance_gross_payback ?? null
    if (bookBasis === 'principal_only' && net !== null) return { value: net, basis: 'principal only' }
    if (bookBasis === 'total_payback' && gross !== null) return { value: gross, basis: 'the whole payback, fee included' }
    // No itemisation to pick from: fall back to the headline, carrying whatever
    // basis its own arithmetic established, and refuse when the two are known to
    // disagree rather than subtracting them anyway.
    if (p.amount_remaining === null) return null
    const hb = p.amount_remaining_basis
    if (hb === 'gross_payback' && bookBasis === 'principal_only') return null
    if (hb === 'net_principal' && bookBasis === 'total_payback') return null
    return { value: p.amount_remaining, basis: hb === 'gross_payback' ? 'the whole payback, fee included' : hb === 'net_principal' ? 'principal only' : 'an unstated basis' }
  }
  if (hasPortal && (ctx.portal!.amount_remaining !== null ||
                    ctx.portal!.lender_balance_net_principal !== null ||
                    ctx.portal!.lender_balance_gross_payback !== null)) {
    const asOf = portalAsOf

    // ── WHOSE BALANCE IS "YOUR BOOKS"? (session 263 cont. 4) ────────────────
    //
    // This read `ctx.statements` with no source filter and took the newest row.
    // That table holds BOTH parties: lender pulls, statements, our own schedule
    // AND balances rebuilt from Xero. On a loan whose rows are mostly lender
    // pulls — which is most of this book — the newest row IS the lender, so the
    // check compared the lender's August figure against the lender's September
    // screen and reported it as your books disagreeing with the lender.
    //
    // Live on PayPal 2: "$46,144.59 (lender) vs $58,775.97 (books)", a claimed
    // $12,631.38 gap, where the $58,775.97 was a `portal_manual_pull` — the
    // lender's own row. Same defect Tech Debt #34 fixed inside the basis check,
    // in a section I did not carry it to.
    //
    // The books side is now book-sourced or there is no comparison, using the
    // same allowlist and for the same reason: a source nobody has classified is
    // excluded rather than assumed to be ours.
    const bookRows = (ctx.statements || [])
      .filter(st => BOOK_BALANCE_SOURCES.includes(String((st as any).source || '')))
      .filter(st => !asOf || st.statement_date <= asOf)
    const book = bookRows.slice(-1)[0]

    if (!book) {
      unresolved.push({
        question: `Do your books agree with the lender on this loan?`,
        why_it_matters: `This is the check a close rests on, and it is the one thing these documents cannot answer by themselves.`,
        what_would_answer_it: `Nothing on file for this loan is a balance rebuilt from your own ledger — every row came from the lender or from a schedule. The lender's figure has been recorded${asOf ? ` at ${asOf}` : ''}; what it needs to be measured against is what your books actually hold on the same day.`,
      })
    }

    // ── AND ARE THE TWO ABOUT THE SAME DAY? ────────────────────────────────
    //
    // A balance is a point in time. Comparing one dated 2026-08-05 with one
    // dated 2026-09-02 reports every payment in between as a disagreement — on
    // PayPal 2, to the cent: four payments, $12,631.38 of principal, exactly the
    // gap the old code called a problem.
    //
    // When the lender's own ledger covers the window, the books side is rolled
    // forward by what the lender actually took in it, and the residual is the
    // real question. That is amount-matching, which this module is wary of, and
    // it is admissible for the reasons session 247 set out: the pairing is
    // same-loan and same-window, the mechanic is documented rather than found in
    // data, both figures stay on the row, and IT CAN ONLY EVER REDUCE A CLAIMED
    // GAP, never create one. With no export covering the window there is no
    // verdict — session 245's rule, unchanged.
    const bookBasis = book ? String((book as any).balance_basis || '') : ''
    const picked = book ? lenderBalanceFor(bookBasis) : null
    let bookValue = book ? Number(book.principal_balance) : null
    let rollNote = ''
    let rollBlocked = false
    if (book && picked && asOf && book.statement_date !== asOf) {
      const days = ctx.csv?.days || []
      const covers = ctx.csv?.ok === true && !!ctx.csv?.first_date && !!ctx.csv?.last_date &&
        String(ctx.csv!.first_date) <= book.statement_date && String(ctx.csv!.last_date) >= asOf
      if (covers) {
        // Match the quantity to the basis the book row declares, or the roll
        // forward moves a principal balance by a gross figure.
        const grossSide = bookBasis === 'total_payback'
        const moved = days
          .filter(d => d.date > book.statement_date && d.date <= asOf)
          .reduce((a, d) => a + Number(grossSide ? d.total_paid : d.principal_paid), 0)
        const rolled = Math.round((bookValue! - moved) * 100) / 100
        rollNote = ` Your books' most recent balance is dated ${book.statement_date}, ${money(bookValue!)}; the lender's figure is dated ${asOf}. Between those days the lender's own ledger took ${money(moved)}${grossSide ? '' : ' of principal'}, which brings the books to ${money(rolled)} — so the two dates are accounted for before anything is called a difference.`
        bookValue = rolled
      } else {
        rollBlocked = true
        unresolved.push({
          question: `Do your books agree with the lender on this loan?`,
          why_it_matters: `A balance is a point in time. Your books' most recent balance is dated ${book.statement_date} and the lender's is dated ${asOf}; everything repaid in between would read as a disagreement, when it is simply time passing.`,
          what_would_answer_it: `There is no lender export in this set covering ${book.statement_date} to ${asOf}, so what moved between those days cannot be measured and no verdict was reached. A balance from your books dated ${asOf}, or the lender's transaction export covering that window, settles it.`,
        })
      }
    }

    if (book && !picked) {
      unresolved.push({
        question: `Which balance should the lender's screen be compared against?`,
        why_it_matters: `A balance that includes the fee still to run and one that does not are different quantities. Subtracting one from the other reports a gap that is really just the fee — this loan's own history is the reason that rule exists here.`,
        what_would_answer_it: (book as any).balance_basis === 'unknown' || !(book as any).balance_basis
          ? `The book balance on file at ${book.statement_date} does not record what it measures, so nothing can be compared to it without guessing. Settle this loan's carrying basis, and the comparison follows.`
          : `The lender's screen and your books state balances on different bases and the screen does not state the one your books use. A screen showing both principal and fee still owed would settle it.`,
      })
    }
    if (book && picked && !rollBlocked) {
      const diff = bookValue! - picked.value
      if (near(diff, 0, 0.02)) {
        corroborations.push({
          statement: `Your books and the lender agree on the balance${book.statement_date === asOf ? ` at ${asOf}` : ''} (${money(bookValue!)}), measured on the same basis — ${picked.basis}.${rollNote}`,
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
        //
        // ── AND THE TEST IS THE EXPORT, NOT A RATE (session 245) ───────────
        // "A few business days of this loan's own withholding" used to mean the
        // gap divided by a mean daily rate, which is a division and not a test —
        // it returns a number of days for any gap at all. This is the one call
        // site that can do better, because the bundle may contain the lender's
        // own transactions: the window is summed out of them, per day, for the
        // actual days between the books' cut-off and the portal's as-of date.
        //
        // THE BASIS IS THE BOOK ROW'S OWN, and it is not a detail. `diff` is this
        // balance minus the portal's, so the withholding it is compared against
        // has to measure the same thing the balance does:
        //
        //   principal_only  -> principal withheld. Summing totals would count the
        //                      fee as settlement lag and inflate the window by 14%
        //                      on this lender ($2,393.23 against $2,050.75 over the
        //                      dearest three-business-day window in the July file) —
        //                      enough to flip a real $2,166.05 gap from ruled-out to
        //                      confirmed.
        //   total_payback   -> the whole withholding, because a payoff-basis balance
        //     / payoff_quote   falls by the full amount of each payment.
        //   unknown         -> no export is offered at all. An unlabelled balance is
        //                      already excluded from every check that compares the
        //                      books to the lender (see 4 above); guessing its basis
        //                      here to reach a benign verdict is the one direction
        //                      this module must never guess in.
        const bookBasis = String(book.balance_basis ?? '')
        const exportBasis: 'principal_only' | 'total_paid' | null =
          bookBasis === 'principal_only' ? 'principal_only'
            : (bookBasis === 'total_payback' || bookBasis === 'payoff_quote') ? 'total_paid'
              : null
        const rate = ctx.csv?.ok ? dailyWithholdingFromMonths(ctx.csv.months) : null
        const lag = explainBalanceGap({
          gap: diff,
          lenderAsOf: asOf,
          dailyWithholding: rate?.rate ?? null,
          rateBasis: rate?.basis ?? 'no transaction export in this set',
          repaysContinuously: rate?.continuous ?? false,
          // Offered even when it is stale or incomplete: explainBalanceGap judges
          // freshness itself, and a refusal that can NAME the date the last export
          // ends is the difference between an answerable finding and a shrug.
          lenderExport: exportBasis ? lenderExportFromCsv(ctx.csv, exportBasis) : null,
        })

        if (lag.benign) {
          // Explained by MEASUREMENT: the lender's own export shows it withheld at
          // least this much over the window. It is not a discrepancy, so it does
          // not go in front of anyone as one — it goes in the corroborations,
          // where a thing that checks out belongs.
          corroborations.push({
            statement:
              `Your books and the lender differ by ${money(Math.abs(diff))} at ${book.statement_date}, and that is expected. ${lag.statement}`,
            sources: ['loan history', 'lender portal', 'transaction export'],
            tie: 'within_tolerance',
          })
        } else if (lag.verdict === 'unconfirmed_no_export') {
          // ── THE REFUSAL, AND WHY IT IS ITS OWN BRANCH (session 245) ────────
          // This is the case that used to be a corroboration. The gap is the size
          // of a few days of withholding, no export covers those days, and the
          // only thing that made it "expected" was an average. It is not an error
          // — nothing here says the money is missing — so it is not filed as one;
          // it is filed as a question with exactly one answer, and the answer is a
          // file the person reading this can produce in a minute.
          conflicts.push({
            key: 'balance_vs_lender_unconfirmed',
            statement: `Your books show ${money(Math.abs(diff))} more still owing than the lender does, which is the size of settlement timing on this loan — but nothing in this set confirms it.`,
            expected: `${money(picked.value)} (lender, ${asOf ?? 'as shown'})`,
            found: `${money(bookValue!)} (books, ${book.statement_date}${rollNote ? ` rolled to ${asOf}` : ''})`,
            sources: ['loan history', 'lender portal'],
            severity: 'warn',
            caveat: lag.statement,
          })
          actions.push({
            id: nextId('finding'),
            kind: 'raise_finding',
            title: `Ask for a current transaction export before calling the ${money(Math.abs(diff))} difference settlement timing`,
            plain_english:
              `The lender says ${money(picked.value)} is still owed; your books say ${money(bookValue!)}.${rollNote} ` +
              `On this loan a difference of about that size is what settlement timing looks like — the lender counts a withholding when the sale clears and your books count it when the payout lands. ` +
              `But "about that size" is an assumption until the lender's own transactions for those days are added up, and this lender withholds a percentage of every sale, so no two days are alike. ` +
              `${lag.statement} Raising it puts it in Needs Attention, where it stays until an export settles it either way.`,
            payload: {
              check_key: 'balance_vs_lender', severity: 'warn',
              title: `${ctx.loan.xero_account_name ?? ctx.loan.lender}: ${money(Math.abs(diff))} difference is unconfirmed settlement timing`,
              detail: { book_balance: bookValue, book_balance_as_filed: Number(book.principal_balance), book_date: book.statement_date, rolled_to: rollNote ? asOf : null,
                        lender_balance: picked.value, lender_date: asOf, difference: Number(diff.toFixed(2)),
                        settlement_lag: { verdict: lag.verdict, implied_calendar_days: lag.impliedCalendarDays,
                                          implied_business_days: lag.impliedBusinessDays,
                                          implied_books_through: lag.impliedBooksThrough,
                                          export_evidence: lag.exportEvidence, export_through: lag.exportThrough,
                                          window_from: lag.windowFrom, window_withholding: lag.windowWithholding } },
            },
            default_checked: true,
          })
        } else {
          conflicts.push({
            key: 'balance_vs_lender',
            statement: booksLagLender
              ? `Your books show more still owing than the lender does.`
              : `Your books show less still owing than the lender does.`,
            expected: `${money(picked.value)} (lender, ${asOf ?? 'as shown'})`,
            found: `${money(bookValue!)} (books, ${book.statement_date}${rollNote ? ` rolled to ${asOf}` : ''})`,
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
            plain_english: `The lender says ${money(picked.value)} is still owed; your books say ${money(bookValue!)}.${rollNote} That is a ${money(Math.abs(diff))} difference and it needs explaining before this loan is relied on in a close. ${lag.statement} Raising it puts it in Needs Attention, where it stays until someone resolves it.`,
            payload: {
              check_key: 'balance_vs_lender', severity: 'error',
              title: `${ctx.loan.xero_account_name ?? ctx.loan.lender}: books and lender disagree by ${money(Math.abs(diff))}`,
              detail: { book_balance: bookValue, book_balance_as_filed: Number(book.principal_balance), book_date: book.statement_date, rolled_to: rollNote ? asOf : null,
                        lender_balance: picked.value, lender_date: asOf, difference: Number(diff.toFixed(2)),
                        settlement_lag: { verdict: lag.verdict, implied_calendar_days: lag.impliedCalendarDays,
                                          implied_business_days: lag.impliedBusinessDays,
                                          implied_books_through: lag.impliedBooksThrough,
                                          export_evidence: lag.exportEvidence, export_through: lag.exportThrough,
                                          window_from: lag.windowFrom, window_withholding: lag.windowWithholding } },
            },
            default_checked: true,
          })
        }
      }
    }
  }

  // ── 5b. The lender's own balance, filed as an anchor ────────────────────
  // A portal screenshot is the only thing in a Stripe Capital bundle that is not
  // our own arithmetic. Reading it, using it to settle the carrying basis and then
  // throwing it away is how a loan ends up with 35 balances and no ANCHOR: every
  // figure on file derived from Xero, checked against Xero, agreeing with Xero.
  //
  // `portal_manual_pull` is the source the rest of the system already means by
  // "the lender said so" — 285 rows across the other loans, and one of the three
  // in REAL_ANCHOR_SOURCES above. It is what makes a loan checkable at all, and it
  // is the difference between the close band printing a variance and printing
  // "n/a — swept from Xero".
  //
  // ── AND WHY THIS ONE FAILS CLOSED ON THE DATE ───────────────────────────
  // The screenshot that prompted all this carried a fully corroborated balance —
  // $145,875 due less $22,783.34 paid leaves $123,091.66, all five figures
  // agreeing — and NO AS-OF DATE. It showed a period ("Jul 6 – Sep 4") and a
  // period-to-date total; it never said which day the balance belonged to. The
  // extractor returned as_of: null, correctly; its schema says to report a date
  // ONLY if the image prints one and never to infer one.
  //
  // So an undated balance is offered BLOCKED and asked about, never filed on a
  // guessed date. Getting a lender anchor's date wrong does not fail loudly — the
  // row is a real anchor by source, so it silently moves the variance on the one
  // screen whose job is to say this loan is ready for your accountant. No anchor
  // is a gap somebody can see. A wrong anchor is a gap nobody can.
  // A SCREEN THAT ITEMISES NEEDS NO HEADLINE (session 263 cont.). This required
  // `amount_remaining`, so a lender whose screen states principal owed and fee
  // owed as separate lines — and therefore says MORE than one that prints a
  // single figure — could never file an anchor at all. The itemised principal is
  // taken in preference: it is unambiguous, it needs no basis to be settled
  // first, and it is directly comparable to the principal-only history already
  // on file. Same corroboration bar, applied to the figure actually used.
  const itemisedNet = ctx.portal?.lender_balance_net_principal ?? null
  const usingItemised = itemisedNet !== null
  if (hasPortal && (ctx.portal!.amount_remaining !== null || usingItemised)) {
    const bal = usingItemised ? itemisedNet! : ctx.portal!.amount_remaining!
    const asOf = ctx.portal!.as_of
    // PRESENT is not PROVEN, and only proven earns a row. checkPortalTotals lists
    // a figure in `corroborated` only when an identity printed on the screen came
    // out right for it; a balance that merely appeared has already been the wrong
    // number on this loan, when $125,000 of funding was read as $123,091.66 of
    // balance and was present the entire time. A figure nothing vouches for may
    // inform a plan. It may not become the row the whole system measures against.
    const proven = (ctx.portal!.corroborated || []).includes(
      usingItemised ? 'principal_balance' : 'amount_remaining')

    // The date comes from §5a, which derived it once for the whole plan. It used
    // to be computed here, below §5, which is why §5 could ask for an export
    // while this section was busy measuring a date out of that very export.
    const dating = portalDating
    const derivedDate = portalDerivedDate
    const asOfDate = portalAsOf

    if (proven) {
      // Only LENDER rows are compared. A xero_derived or snapshot row on the same
      // date disagreeing with the lender is not a duplicate anchor, it is the
      // books-versus-lender gap section 5 has just reported — raising it twice, in
      // two vocabularies, is how a screen teaches people to scroll.
      const sameDay = asOfDate
        ? ctx.statements.filter(s => s.statement_date === asOfDate && REAL_ANCHOR_SOURCES.includes(s.source))
        : []
      const already = sameDay.find(s => near(Number(s.principal_balance), bal))
      const contradicting = sameDay.filter(s => !near(Number(s.principal_balance), bal))

      if (already) {
        corroborations.push({
          statement: `The lender's balance at ${asOfDate} (${money(bal)}) is already on file from a lender document, and this screenshot says the same thing.`,
          sources: ['loan history', 'lender portal'], tie: 'exact',
        })
      } else if (contradicting.length) {
        // A conflict to raise, not a row to write. Overwriting the row already
        // there would destroy the evidence for whichever reading is right, and
        // filing a second would leave the loan with two lender anchors on one day
        // and let the authority ranking pick between them by accident of ordering.
        const c = contradicting[0]
        conflicts.push({
          key: 'lender_balance_disagrees_with_file',
          statement: `A lender figure is already on file for ${asOfDate}, and this screenshot does not agree with it.`,
          expected: `${money(bal)} (this screenshot)`,
          found: `${money(Number(c.principal_balance))} (already on file, ${String(c.source).replace(/_/g, ' ')})`,
          sources: ['lender portal', 'loan history'],
          severity: 'warn',
          caveat: `Two lender figures for the same day cannot both be right, so no balance was proposed. This is not the usual books-versus-lender difference — that is a gap between what you recorded and what the lender says, and it is reported separately. This is two claims about what the LENDER says, and only one of them can stand.`,
        })
      } else {
        // What the lender's figure MEASURES, which is not automatically what the
        // books carry. When the screen's own total is the agreement's Total
        // Repayment Amount, the balance beside it is a payoff figure and nothing
        // else — the same identity section 3 uses to establish the basis, read
        // here for what it says about the LENDER's number rather than about ours.
        // Failing that, the settled carrying basis; failing that 'unknown', which
        // is a legal value and the one that fails safe: an unlabelled balance is
        // left out of the rate measurement and the published-total check rather
        // than being counted on a basis nobody proved.
        const lenderQuotesGross = totalRepayment !== null && ctx.portal!.total_amount_due !== null &&
          near(ctx.portal!.total_amount_due!, totalRepayment)
        // An itemised screen states what its principal line measures on its own
        // face, so nothing has to be settled first and nothing is inferred. This
        // sits ABOVE the hierarchy below deliberately: those branches all reason
        // from what we believe about the loan, and this one reads what the lender
        // printed. 'unknown' remains the fail-safe for a screen that states one
        // figure and does not say what it is.
        const lenderBasis = usingItemised ? 'principal_only'
          : lenderQuotesGross ? 'total_payback'
          : settledBasis === 'gross_payback' ? 'total_payback'
          : settledBasis === 'net_principal' ? 'principal_only'
          : 'unknown'
        const screens = ctx.documents.filter(d => d.kind === 'balance_screenshot').map(d => d.filename)

        // What the export had to say when it could not settle the date, appended to
        // the refusal and to the question below. "We looked, and here is what we
        // found" is the difference between an answerable question and a shrug — and
        // in the total-only case it hands over a candidate date the person can
        // confirm in seconds. WITH NO EXPORT IN THE SET THIS IS EMPTY and both
        // wordings below are byte-identical to what they have always been, which is
        // what keeps the no-export path the same refusal it was before.
        //
        // The coverage refusal gets one more sentence when the period start was a
        // FALLBACK. With no Repayment Start Date on the agreement the planner falls
        // back to the origination date, and on this lender that asks for something
        // no export can supply: repayment starts a week after origination, so the
        // file legitimately begins six days later (2026-07-06 against a 2026-06-30
        // origination) and the refusal would otherwise read "an export covering
        // from 2026-06-30 would date it" — a file that cannot exist. The missing
        // TERM is the thing to go and get, and the sentence should say so.
        const startWasStated = date('repayment_start_date') !== null
        const startCaveat = !startWasStated && dating?.refused_because === 'coverage_starts_late'
          ? ` The period was taken to begin ${repaymentStart} only because this agreement does not state a Repayment Start Date. That term is the thing worth finding: repayment usually starts days after origination, and with it the export may well cover the whole period after all.`
          : ''
        const exportNote = !dating || derivedDate ? ''
          : dating.date
          ? ` The transaction export in this set gets close but does not settle it. ${dating.statement} One figure agreeing is not enough to date a row the whole system measures against, so it was not taken — but if ${dating.date} is the day the screen was captured, say so and this can be filed.`
          : ` The transaction export in this set cannot date it either. ${dating.statement}${startCaveat}`

        const blockedReason = asOfDate ? undefined
          : `This screen states no balance date. Every figure on it checks out — ${usingItemised ? `${money(bal)} of principal and ${money(ctx.portal!.fee_balance ?? 0)} of fee still owed add to the ${money(ctx.portal!.lender_balance_gross_payback ?? 0)} it prints` : `${money(bal)} is the total due less the amount paid, to the cent`} — but it never says which day the ${money(bal)} belongs to. Nothing here will invent one: this row would become the figure your books are checked against, and filed against the wrong day it does not fail — it quietly moves the variance on the month-end screen, the one screen whose job is to tell you this loan is ready for your accountant. Tell us the date the screenshot was taken and it can be filed.${exportNote}`

        actions.push({
          id: nextId('lenderbal'),
          kind: 'record_lender_balance',
          title: asOf
            ? `Record the lender's balance of ${money(bal)} at ${asOf}`
            // Named as derived on the review screen itself. A date that was measured
            // rather than printed is a different kind of fact from one the lender
            // wrote down, and the person ticking the box is entitled to know which
            // of the two they are approving before they open the description.
            : derivedDate
            ? `Record the lender's balance of ${money(bal)} at ${derivedDate}, dated from the transaction export`
            : `Record the lender's balance of ${money(bal)} — needs the date it was taken`,
          plain_english: [
            asOf
              ? `The lender's own screen says ${money(bal)} was still owed at ${asOf}, and the screen proves it: ${usingItemised
              ? `its two lines add up: ${money(bal)} of principal and ${money(ctx.portal!.fee_balance ?? 0)} of fee still owed come to the ${money(ctx.portal!.lender_balance_gross_payback ?? 0)} it prints`
              : `the total due less the amount paid to date comes to exactly that`}.`
              : derivedDate
              // SHOW THE WORKING. This module's standing rule is that a derived
              // number says how it was derived, and a derived DATE is the sharpest
              // case for it: nothing downstream can tell a measured date from a
              // typed one, so the only place the difference can be seen is here.
              // The sentence names the figures that agreed, the day they agreed on
              // and the next day's total, which is enough for a person to check it
              // against the export by hand rather than take it on trust.
              ? `The lender's own screen says ${money(bal)} is still owed, and the screen proves it: ${usingItemised
              ? `its two lines add up: ${money(bal)} of principal and ${money(ctx.portal!.fee_balance ?? 0)} of fee still owed come to the ${money(ctx.portal!.lender_balance_gross_payback ?? 0)} it prints`
              : `the total due less the amount paid to date comes to exactly that`}. What the screen never says is which day that is the balance for — so it was measured rather than guessed. ${dating!.statement} That is why this is filed at ${derivedDate}. The date is only as good as the export it was measured from, which is why it was taken only when more than one figure landed on the same day; if that export later turns out to be missing transactions, this date moves with it.`
              : `The lender's own screen says ${money(bal)} is still owed, and the screen proves it: ${usingItemised
              ? `its two lines add up: ${money(bal)} of principal and ${money(ctx.portal!.fee_balance ?? 0)} of fee still owed come to the ${money(ctx.portal!.lender_balance_gross_payback ?? 0)} it prints`
              : `the total due less the amount paid to date comes to exactly that`}. What it does not say is which day that is the balance for.`,
            `Filing it as a lender balance is what makes this loan checkable. Every balance currently on file for it was swept out of your own ledger, so today the books are only ever compared with themselves — the month-end screen says "n/a" against this loan rather than a figure your accountant can sign.`,
            screens.length ? `Read from ${screens.join(' and ')}.` : '',
          ].filter(Boolean).join(' '),
          // Everything the apply step needs and nothing it has to work out. The date
          // is decided HERE, in front of the person approving it, and the evidence
          // rides along with it: applyBundle reads the stored plan verbatim and must
          // never re-run this measurement, because a date derived twice can differ
          // between the screen somebody approved and the row that got written — and
          // it would differ silently, since the export it re-read may by then be a
          // different file. checkStatementPayload ignores the extra keys.
          payload: {
            statement_date: asOfDate,
            principal_balance: bal,
            balance_basis: lenderBasis,
            source: 'portal_manual_pull',
            read_from: screens,
            date_source: asOf ? 'screen' : derivedDate ? 'transaction_export' : null,
            dated_by_export: derivedDate ? {
              date: derivedDate,
              method: 'cumulative_withholding_match',
              period_start: repaymentStart,
              export_covers: dating!.covers,
              target: {
                paid_to_date: ctx.portal!.paid_to_date,
                financing_paid: ctx.portal!.principal_paid,
                fee_paid: ctx.portal!.fee_paid,
              },
              cumulative: dating!.cumulative,
              agreed: dating!.agreed,
              previous_day: dating!.previous_day,
              next_day: dating!.next_day,
              statement: dating!.statement,
            } : null,
          },
          default_checked: !blockedReason,
          ...(blockedReason ? { blocked_reason: blockedReason } : {}),
        })

        // A blocked action greyed on a review screen is a dead end on its own. The
        // question is what turns it back into a row, so it is asked where the
        // other unanswerable questions are asked, in the same three parts.
        //
        // Asked on `asOfDate`, not on `asOf`: a screen the export has dated is no
        // longer an open question, and leaving it in the list would be the module
        // asking for something it is holding — the same defect §7b was fixed for
        // when the ledger answered the fee question and the plan asked it anyway.
        if (!asOfDate) {
          unresolved.push({
            question: `What date was this screenshot of the lender's screen taken?`,
            why_it_matters:
              `The lender's balance is the one figure on this loan that is not our own arithmetic, and a balance means nothing without the day it belongs to. Filed on the wrong date it does not look wrong: it counts as a real lender anchor, so it silently shifts the variance on the month-end close screen — the screen whose entire job is to say this loan is ready for your accountant. Left out, this loan simply has no lender figure at all, which is at least visible.`,
            what_would_answer_it:
              `The date the screen was captured, or a screenshot that prints an "as of" date beside the ${money(bal)}. The screen we have shows a period and a period-to-date total, which is why it was not read off it. With a date this becomes the lender anchor this loan has never had.${exportNote}`,
          })
        }
      }
    }
  }

  // ── 5c. More than one export in the bundle ──────────────────────────────
  // Said out loud either way. Combining two exports is what makes a running
  // total reach an August figure from a July start; refusing to combine them is
  // why a date could not be established. Both are facts about the evidence, so
  // both belong on the page rather than in a log nobody reads.
  if (ctx.csvNote) {
    if (/were combined/.test(ctx.csvNote)) {
      corroborations.push({ statement: ctx.csvNote, sources: ['transaction export'], tie: 'exact' })
    } else {
      conflicts.push({
        key: 'exports_not_combined',
        statement: `More than one transaction export was uploaded and they could not be read as one ledger.`,
        expected: 'one continuous ledger', found: ctx.csvNote,
        sources: ['transaction export'], severity: 'warn',
        caveat: `Nothing was lost and nothing was double-counted — the fullest single export was used. But a balance can only be dated from the lender's ledger when that ledger runs unbroken from the start of the period, so this may be why a screenshot's date could not be established.`,
      })
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
        // The SAME settlement lag as the balance check above, at a month boundary
        // instead of an as-of date: the last few days' withholdings settle in the
        // following month, so the books fall short by roughly that much.
        //
        // This branch used to assert "almost certainly timing... worth
        // confirming, not worth alarm" in prose while its sibling forty lines up
        // had been taught to PROVE it. One check reasoning and one check
        // hand-waving about the identical mechanism is how a module ends up with
        // two answers to the same question — so it gets the same arithmetic, on
        // this month's own rate.
        //
        // Session 245: and here the month rate is only the SENTENCE. The file in
        // hand covers this month's own last days by construction, so the window is
        // summed out of it day by day rather than extrapolated from the month's
        // average — which on this export is a 24x-swinging quantity pretending to
        // be a constant. TOTAL basis, because `booked` and `m.total_paid` are both
        // totals; the balance check above compares principal and passes principal.
        const monthDays = Math.round(
          (Date.parse(m.last_date + 'T00:00:00Z') - Date.parse(m.first_date + 'T00:00:00Z')) / 86_400_000) + 1
        const monthRate = monthDays > 0 ? Math.round((m.total_paid / monthDays) * 100) / 100 : null
        const lag = explainBalanceGap({
          gap: diff,
          lenderAsOf: m.last_date,
          dailyWithholding: monthRate,
          rateBasis: `${m.transaction_count.toLocaleString('en-US')} withholdings totalling ${money(m.total_paid)} over ${monthDays} days in this month's export`,
          repaysContinuously: m.transaction_count >= 20,
          lenderExport: lenderExportFromCsv(ctx.csv, 'total_paid'),
        })

        if (lag.benign) {
          corroborations.push({
            statement:
              `${m.month}: the lender's export shows ${money(m.total_paid)} and your books recorded ${money(booked)}, a difference of ${money(Math.abs(diff))} — which is what a month boundary looks like here. ${lag.statement}`,
            sources: ['transaction export', 'loan history'], tie: 'within_tolerance',
          })
        } else {
          conflicts.push({
            key: `coverage_${m.month}`,
            statement: diff > 0
              ? `${m.month}: the lender's export shows more withheld than your books recorded.`
              : `${m.month}: your books recorded more than the lender's export shows withheld.`,
            expected: `${money(m.total_paid)} across ${m.transaction_count} withholdings (${m.first_date} to ${m.last_date})`,
            found: `${money(booked)} recorded`,
            sources: ['transaction export', 'loan history'],
            severity: 'warn',
            caveat: lag.statement,
          })
        }
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
    const fs = ctx.feeSearch
    if (!feeDocumented && fs?.verdict === 'found') {
      // The ledger answered it. This is no longer a question, and treating it as
      // one would be the module asking for something it is holding.
      established.push({
        key: 'fee_debit_account',
        value: fs.debit_account_name ? `${fs.debit_account_name} (${fs.debit_account})` : `Account ${fs.debit_account}`,
        how: fs.statement,
      })
      // Deliberately NOT its own action. The structure note below is already the
      // designated home for "record it so nobody has to ask again", and a second
      // action writing the same column is a clobber waiting for the day both are
      // ticked. The fact goes into the note; section 8 picks it up.
    } else if (!feeDocumented) {
      unresolved.push({
        question: `The ${money(fixedFee)} fee was added into this loan's balance at the start. What was debited on the other side of that entry?`,
        why_it_matters:
          `It decides whether this loan's cost ever reaches your profit and loss. If it was expensed at origination, the cost is recognised — all in one month, which flatters every month after it. If it went to a prepaid or deferred asset, something has to amortise it and nothing is. If it was plugged to a suspense account, there is ${money(fixedFee)} unexplained in your ledger. Three different answers, three different fixes.`,
        // Say what was actually SEARCHED. "These documents cannot say" was true and
        // useless; a person needs to know whether the ledger was looked at, and
        // with what result, before spending an afternoon on it.
        what_would_answer_it: fs
          ? `${fs.statement} ${fs.verdict === 'ambiguous' ? 'Pick the one that capitalised the fee and record it in this loan\'s note.' : 'Once you know, record it in this loan\'s note so nobody has to ask again.'}`
          : `The journal dated on or around ${origination ?? 'the origination date'} that credited ${money(fixedFee)} to this loan's account. Whatever account took the matching debit is the answer. Once you know, record it in this loan's note so nobody has to ask again.`,
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
      // The other side of the capitalised fee, once the ledger has answered it.
      // This sentence is the whole point of the search: it is what stops the
      // question being asked again by the next person and the next session.
      ctx.feeSearch?.verdict === 'found'
        ? `The ${money(fixedFee)} fee was debited to ${ctx.feeSearch.debit_account_name ? `${ctx.feeSearch.debit_account_name} (${ctx.feeSearch.debit_account})` : `account ${ctx.feeSearch.debit_account}`}${ctx.feeSearch.journal_date ? ` by the journal dated ${ctx.feeSearch.journal_date}` : ''}${ctx.feeSearch.journal_id ? ` (${ctx.feeSearch.journal_id})` : ''}, found in the ledger rather than assumed${ctx.feeSearch.treatment_kind === 'expensed' ? ' — booked as a cost at origination, which is settled and needs no revisiting' : ''}.`
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
    //
    // The two balance-writing actions carry `statement_date`, singular, and are
    // deliberately out of this guard's reach — see 4b for why. In short: they
    // insert evidence rather than correct an entry, they move no money, and 4b's
    // row is by construction the OLDEST on the loan, so blocking it on the close
    // date would grey out the only action that can give an opening balance to any
    // loan that originated before the books were closed. That is most of them,
    // and it is the defect being fixed rather than a guard against it.
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
