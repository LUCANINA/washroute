// tests/loan-bundle-balances.test.mts — the two actions that write a BALANCE.
//
// Run:  npx tsx tests/loan-bundle-balances.test.mts
//
// WHY THIS FILE EXISTS
// The Stripe Capital bundle planned ten changes, applied all ten, and wrote no
// balance. Carrying basis, origination date, maturity date, twelve contract terms,
// four documents filed, thirty-five statement bases relabelled — and the loan still
// read "no opening balance" on the Loans page and was excluded from the month-end
// rollforward. The engine had read the lender's own figure off a screenshot, used
// it to settle the carrying basis, and then discarded it as a balance.
//
// Two actions close that gap, and each one is dangerous in its own direction:
//
//   open_at_origination   writes the figure every following month is measured
//                         FROM. Wrong basis, wrong number, permanently.
//   record_lender_balance writes the only row on the loan that is not our own
//                         arithmetic. Wrong date, silently wrong variance on the
//                         one screen whose job is to say "ready for your
//                         accountant".
//
// So the assertions below are mostly about REFUSING. Every one of them is a case
// where the cheap thing to do is to guess.
//
// The apply half is pinned the way tests/apply-bundle.test.mts pins its half: the
// pure decisions against the shipped module, and the wiring by reading
// loan-bundle/index.ts as text. Nothing here mocks PostgREST — a test that agrees
// with its own mock is the failure mode queue-hygiene.test.mts was rewritten to
// remove.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPlan, REAL_ANCHOR_SOURCES, ORIGINATION_SOURCE,
  type PlanContext, type BundlePlan, type PlannedAction,
} from '../supabase/functions/_shared/loan-bundle-plan.ts'
import {
  checkStatementPayload, statementRowWrite, checkApproveList,
  STATEMENT_SOURCE_BY_KIND, STATEMENT_BASES,
} from '../supabase/functions/_shared/loan-bundle-apply.ts'
import { dateFromLedger, paidFromOutstanding, type LedgerDay } from '../supabase/functions/_shared/ledger-dating.ts'
import { parsePayPalHistoryCsv } from '../supabase/functions/_shared/paypal-history.ts'
import { detectCarryingBasisDrift, describeBasisMiss, describeBasisObserved } from '../supabase/functions/_shared/carrying-basis-drift.ts'
import { parseStripeCapitalCsv } from '../supabase/functions/_shared/stripe-capital.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── The real loan, as the four documents describe it ────────────────────────
// Every figure below came off the Stripe Capital agreement, the July export or the
// portal screenshots. See tests/loan-bundle.test.mts, which reads them.
const term = (term_key: string, v: { n?: number; d?: string; t?: string }): any => ({
  term_key, value_numeric: v.n ?? null, value_date: v.d ?? null, value_text: v.t ?? null,
  source_text: `(${term_key})`, basis: 'test fixture', confidence: 'high',
})
const AGREEMENT: any[] = [
  term('loan_amount', { n: 125000 }),
  term('net_loan_proceeds', { n: 125000 }),
  term('fixed_fee', { n: 20875 }),
  term('total_repayment_amount', { n: 145875 }),
  term('origination_date', { d: '2026-06-30' }),
  term('final_repayment_date', { d: '2027-12-29' }),
]

const sweep = (statement_date: string, principal_balance: number, balance_basis = 'total_payback') =>
  ({ statement_date, principal_balance, balance_basis, source: 'xero_balance_snapshot' })

const ctxOf = (over: Partial<PlanContext> = {}): PlanContext => ({
  loan: {
    id: 'loan-stripe', lender: 'Stripe Capital', xero_account_name: 'Stripe Capital Loan',
    lender_account_number: 'STRIPE-CAPITAL', carrying_basis: 'unknown',
    original_amount: 125000, original_date: null, maturity_date: null, interest_rate: null,
    scheduled_monthly_payment: 13000, structure_note: null, xero_account_code: '304',
  },
  documents: [],
  agreementTerms: AGREEMENT, agreementChecks: [], agreementUnresolved: [],
  csv: null, feeSearch: null, decomposition: null, portal: null,
  // The shape that caused this: the automated sweep starts 2026-07-01 and the loan
  // originated 2026-06-30. It misses by one day.
  statements: [sweep('2026-07-01', 145875), sweep('2026-08-26', 125257.71, 'unknown')],
  splits: [], closeDate: null, todayPacific: '2026-08-27',
  ...over,
} as PlanContext)

const portalOf = (over: Record<string, unknown> = {}): PlanContext['portal'] => ({
  as_of: '2026-08-26', amount_remaining: 123091.66, paid_to_date: 22783.34,
  principal_paid: 1908.34, fee_paid: 20875, total_amount_due: 145875,
  corroborated: ['total_amount_due', 'paid_to_date', 'amount_remaining'],
  ...over,
} as any)

const of = (plan: BundlePlan, kind: string): PlannedAction | undefined =>
  plan.actions.find(a => a.kind === kind)
const all = (plan: BundlePlan, kind: string) => plan.actions.filter(a => a.kind === kind)

// ─────────────────────────────────────────────────────────────────────────────
section('1 — the opening balance appears only when the day is uncovered')
// ─────────────────────────────────────────────────────────────────────────────
{
  const base = buildPlan(ctxOf())
  const a = of(base, 'open_at_origination')
  ok('the missing-by-one-day case gets the action', !!a)
  ok('...dated the origination date, not the first sweep', (a!.payload as any).statement_date === '2026-06-30',
     String((a!.payload as any).statement_date))

  // ON the origination date counts as covered: a second row that day would be two
  // answers to the rollforward's one question.
  const onTheDay = buildPlan(ctxOf({ statements: [sweep('2026-06-30', 145875), sweep('2026-07-01', 145875)] }))
  ok('a row dated exactly at origination suppresses it', !of(onTheDay, 'open_at_origination'))
  const before = buildPlan(ctxOf({ statements: [sweep('2026-06-29', 145875), sweep('2026-07-01', 145875)] }))
  ok('a row before origination suppresses it too', !of(before, 'open_at_origination'))

  // No date, nothing to file against.
  const noDate = buildPlan(ctxOf({ agreementTerms: AGREEMENT.filter(t => t.term_key !== 'origination_date') }))
  ok('no origination date anywhere means no action at all', !of(noDate, 'open_at_origination'))

  // ...but the loan record's own date still counts when the agreement is silent.
  const fromRecord = buildPlan(ctxOf({
    agreementTerms: AGREEMENT.filter(t => t.term_key !== 'origination_date'),
    loan: { ...ctxOf().loan, original_date: '2026-06-30' },
  }))
  ok('the loan record supplies the date when the agreement does not', !!of(fromRecord, 'open_at_origination'))

  // A future origination date is bad data, not an opening balance. Verdant's whole
  // schedule ingested as statements once made a live $248k loan read as paid off.
  const future = buildPlan(ctxOf({
    agreementTerms: [...AGREEMENT.filter(t => t.term_key !== 'origination_date'), term('origination_date', { d: '2026-12-01' })],
    statements: [],
  }))
  ok('a future origination date is never filed as a balance', !of(future, 'open_at_origination'))

  ok('exactly one is ever proposed', all(base, 'open_at_origination').length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
section('2 — the day-one figure is the carrying basis, restated')
// ─────────────────────────────────────────────────────────────────────────────
{
  // Payoff basis: nothing repaid, so the balance is the WHOLE payback, fee
  // capitalised in. Not the $125,000 borrowed — that difference is the $20,875
  // phantom liability this module exists to have caught once already.
  const gross = of(buildPlan(ctxOf({ loan: { ...ctxOf().loan, carrying_basis: 'gross_payback' } })), 'open_at_origination')!
  ok('gross_payback opens at the total repayment amount', (gross.payload as any).principal_balance === 145875,
     String((gross.payload as any).principal_balance))
  ok('...labelled total_payback', (gross.payload as any).balance_basis === 'total_payback')
  ok('...and not blocked', !gross.blocked_reason, gross.blocked_reason || '')
  ok('...named in the title', /\$145,875\.00/.test(gross.title), gross.title)

  // Principal basis: the cash borrowed, financing cost held outside the balance.
  const net = of(buildPlan(ctxOf({
    loan: { ...ctxOf().loan, carrying_basis: 'net_principal' },
    statements: [sweep('2026-07-01', 125000, 'principal_only')],
  })), 'open_at_origination')!
  ok('net_principal opens at the amount borrowed', (net.payload as any).principal_balance === 125000,
     String((net.payload as any).principal_balance))
  ok('...labelled principal_only', (net.payload as any).balance_basis === 'principal_only')
  ok('...and reads loan_amount, the same term the basis detector compares against',
     (net.payload as any).derived_from === 'loan_amount')

  // net_loan_proceeds only when loan_amount is genuinely absent.
  const proceeds = of(buildPlan(ctxOf({
    loan: { ...ctxOf().loan, carrying_basis: 'net_principal' },
    agreementTerms: AGREEMENT.filter(t => t.term_key !== 'loan_amount'),
    statements: [],
  })), 'open_at_origination')!
  ok('net_loan_proceeds is the fallback, not the preference',
     (proceeds.payload as any).derived_from === 'net_loan_proceeds' &&
     (proceeds.payload as any).principal_balance === 125000)

  // Every basis maps to something the CHECK constraint accepts.
  for (const p of [gross, net, proceeds]) {
    ok(`balance_basis '${(p.payload as any).balance_basis}' satisfies the column's CHECK`,
       STATEMENT_BASES.includes(String((p.payload as any).balance_basis)))
  }

  // The corroboration the wording is supposed to carry: the sweep's own first
  // reading, one day later, to the cent.
  ok('the 2026-07-01 sweep row is quoted as corroboration', /2026-07-01/.test(gross.plain_english) &&
     /same figure to the cent/.test(gross.plain_english), gross.plain_english)
  ok('...and recorded in the payload, not just the prose',
     (gross.payload as any).corroborated_by?.statement_date === '2026-07-01')
  const uncorroborated = of(buildPlan(ctxOf({
    loan: { ...ctxOf().loan, carrying_basis: 'gross_payback' },
    statements: [sweep('2026-07-01', 140000)],
  })), 'open_at_origination')!
  ok('a first row that does NOT agree is not claimed as corroboration',
     (uncorroborated.payload as any).corroborated_by === null &&
     !/same figure to the cent/.test(uncorroborated.plain_english))
}

// ─────────────────────────────────────────────────────────────────────────────
section('3 — an unsettled basis blocks it rather than guessing')
// ─────────────────────────────────────────────────────────────────────────────
{
  // carrying_basis 'unknown' and nothing in the bundle establishing one: the two
  // candidate figures differ by the whole fee, and this is the row every following
  // month is measured from.
  const blocked = of(buildPlan(ctxOf({ statements: [] })), 'open_at_origination')!
  ok('an unknown basis still SURFACES the action', !!blocked)
  ok('...blocked', !!blocked.blocked_reason)
  ok('...unticked', blocked.default_checked === false)
  ok('...saying which two balances it is between',
     /\$145,875\.00/.test(blocked.blocked_reason!) && /\$125,000\.00/.test(blocked.blocked_reason!),
     blocked.blocked_reason)
  ok('...and naming no figure of its own', (blocked.payload as any).principal_balance === null)
  ok('...nor a basis label it cannot justify', (blocked.payload as any).balance_basis === 'unknown')
  // A greyed action on a screen is not a guard. Submitting its id directly has to
  // be refused too, or the block is decoration.
  ok('...and submitting its id anyway is refused, 409',
     checkApproveList(buildPlan(ctxOf({ statements: [] })), [blocked.id])?.code === 'blocked_actions')

  // Basis known but the term it names is missing: a different refusal, same rule.
  const noTerm = of(buildPlan(ctxOf({
    loan: { ...ctxOf().loan, carrying_basis: 'gross_payback' },
    agreementTerms: AGREEMENT.filter(t => t.term_key !== 'total_repayment_amount'),
    statements: [],
  })), 'open_at_origination')!
  ok('a basis with no figure behind it is blocked too', !!noTerm.blocked_reason)
  ok('...and says which figure is missing', /Total Repayment Amount/.test(noTerm.blocked_reason!), noTerm.blocked_reason)

  // Evidence pointing BOTH ways must not be rescued by the column on the loan —
  // that column is exactly what the conflict says may be wrong.
  const disputed = buildPlan(ctxOf({
    loan: { ...ctxOf().loan, carrying_basis: 'gross_payback' },
    // earliest balance = the amount borrowed (net) while the portal quotes gross
    statements: [sweep('2026-07-02', 125000)],
    portal: portalOf({ as_of: '2026-07-05' }),
  }))
  const hadConflict = disputed.conflicts.some(c => c.key === 'carrying_basis_evidence_conflict')
  const dis = of(disputed, 'open_at_origination')
  ok('documents disagreeing about the basis raises the conflict', hadConflict)
  ok('...and the opening balance refuses rather than trusting the loan record',
     !!dis && !!dis.blocked_reason, dis ? (dis.blocked_reason || 'not blocked') : 'no action')
}

// ─────────────────────────────────────────────────────────────────────────────
section('4 — the lender balance needs CORROBORATED, not merely present')
// ─────────────────────────────────────────────────────────────────────────────
{
  const good = of(buildPlan(ctxOf({ portal: portalOf() })), 'record_lender_balance')
  ok('a proven balance is proposed', !!good)
  ok('...as a portal_manual_pull', (good!.payload as any).source === 'portal_manual_pull')
  ok('...which is one of the three real anchors',
     REAL_ANCHOR_SOURCES.includes(String((good!.payload as any).source)))
  ok('...at the screen\'s own date', (good!.payload as any).statement_date === '2026-08-26')
  ok('...at the screen\'s own figure', (good!.payload as any).principal_balance === 123091.66)
  ok('...and not blocked', !good!.blocked_reason)

  // THE CASE THAT MATTERS. $125,000 of funding was read as $123,091.66 of balance
  // on this very loan, and it was PRESENT the whole time. Present is not proven.
  const merelyPresent = buildPlan(ctxOf({ portal: portalOf({ corroborated: ['funds_deposited'] }) }))
  ok('a balance nothing vouches for is not proposed at all',
     !of(merelyPresent, 'record_lender_balance'))
  const emptyCorrob = buildPlan(ctxOf({ portal: portalOf({ corroborated: [] }) }))
  ok('...and an empty corroboration list is not a pass either',
     !of(emptyCorrob, 'record_lender_balance'))
  const partial = buildPlan(ctxOf({ portal: portalOf({ corroborated: ['total_amount_due', 'paid_to_date'] }) }))
  ok('...nor is corroboration of the figures AROUND it',
     !of(partial, 'record_lender_balance'))
  const noBalance = buildPlan(ctxOf({ portal: portalOf({ amount_remaining: null }) }))
  ok('no balance on the screen, no action', !of(noBalance, 'record_lender_balance'))
  ok('no screenshot at all, no action', !of(buildPlan(ctxOf()), 'record_lender_balance'))
}

// ─────────────────────────────────────────────────────────────────────────────
section('5 — no as-of date: blocked, and asked about')
// ─────────────────────────────────────────────────────────────────────────────
{
  // The real screenshot: $145,875 due − $22,783.34 paid = $123,091.66 remaining,
  // all five figures agreeing, and NO DATE — it showed a period ("Jul 6 – Sep 4")
  // and a period-to-date total. The extractor returned as_of: null, correctly.
  const plan = buildPlan(ctxOf({ portal: portalOf({ as_of: null }) }))
  const a = of(plan, 'record_lender_balance')
  ok('the action is still SURFACED', !!a, 'a silent drop is how a person never learns what is missing')
  ok('...blocked', !!a!.blocked_reason)
  ok('...unticked', a!.default_checked === false)
  ok('...because the screen states no date', /states no balance date|no balance date/i.test(a!.blocked_reason!),
     a!.blocked_reason)
  ok('...saying why a wrong date is worse than none',
     /variance/i.test(a!.blocked_reason!) && /accountant/i.test(a!.blocked_reason!), a!.blocked_reason)
  ok('...and inventing no date in the payload', (a!.payload as any).statement_date === null)
  ok('...while still carrying the figure that WAS proven',
     (a!.payload as any).principal_balance === 123091.66)
  const refused = checkApproveList(plan, [a!.id])
  ok('...and it cannot be applied by submitting its id', refused?.code === 'blocked_actions')
  ok('...with a 409 and the reason quoted back', refused?.status === 409 &&
     /no balance date/i.test(refused?.message || ''), refused?.message || '')

  // A blocked action greyed on a screen is a dead end unless the question is asked.
  const q = plan.unresolved.find(u => /date/i.test(u.question) && /screenshot/i.test(u.question))
  ok('an Unresolved question asks for the date', !!q, JSON.stringify(plan.unresolved.map(u => u.question)))
  ok('...in the three parts every other question uses',
     !!q && !!q.question && !!q.why_it_matters && !!q.what_would_answer_it)
  ok('...and says what it costs to get it wrong', !!q && /variance/i.test(q.why_it_matters))
  ok('...and names the figure waiting on it', !!q && /\$123,091\.66/.test(q.what_would_answer_it))

  // The dated case must NOT raise the question, or it becomes noise.
  const dated = buildPlan(ctxOf({ portal: portalOf() }))
  ok('a dated screenshot asks nothing',
     !dated.unresolved.some(u => /date was this screenshot/i.test(u.question)))

  // The summary counts open actions; a blocked one must not inflate it.
  ok('a blocked action is not counted as ready to approve',
     /0 changes ready|1 change ready|\d+ changes ready/.test(plan.summary) &&
     plan.actions.filter(x => !x.blocked_reason).length < plan.actions.length,
     plan.summary)
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION 246 — the undated screen, dated from the lender's own ledger.
//
// Section 5 above is the fallback and it stays the fallback. What follows is the
// one case where the date does not have to be asked for: the bundle also holds
// the transaction export, so the date can be MEASURED. The screen says how much
// has been paid in the period; the export lists every withholding with a date;
// the day the running total equals the screen's figure is the day the screen was
// showing.
//
// ─── WHAT IS REAL HERE AND WHAT IS NOT ──────────────────────────────────────
// The July export is real: parsed from fixtures/Stripe_July.csv by the shipped
// parser at the time the test runs — 1,352 rows, 26 Pacific days, 2026-07-06 to
// 2026-07-31, $11,192.29 total / $9,590.61 financing / $1,601.68 fee.
//
// The August-to-date export is NOT in this checkout, so the August half of the
// ledger is CONSTRUCTED, and precisely this much is constructed: 26 days carrying
// the remainder the real screenshot implies ($11,591.05 total / $9,932.11
// financing / $1,658.94 fee), spread across 2026-08-01 to 2026-08-26 in the shape
// of July's own days, plus $348.43 on 2026-08-27. The daily shape underneath
// August is therefore invented; the CUMULATIVE the assertions match against is
// the real screenshot's own four figures. What is being tested is the matcher,
// over a ledger whose properties are stated here rather than measured — pinned by
// the first three assertions of §5a so that a change to the construction fails
// loudly instead of quietly moving the target.
// ═════════════════════════════════════════════════════════════════════════════

const JULY_CSV = process.env.WR_STRIPE_CSV || path.join(HERE, '..', 'fixtures', 'Stripe_July.csv')
// Loudly, not as a skip. An assertion that quietly stops firing reads exactly like
// an assertion that passes — settlement-lag.test.mts's rule, and the same file.
if (!fs.existsSync(JULY_CSV)) throw new Error(`the real July export is not at ${JULY_CSV} — these assertions cannot run against a substitute`)
const JULY = parseStripeCapitalCsv(fs.readFileSync(JULY_CSV, 'utf8'))
if (!JULY.ok || JULY.days.length !== 26) throw new Error(`the July fixture no longer parses to 26 clean days (ok=${JULY.ok}, days=${JULY.days.length})`)

const julyDays: LedgerDay[] = JULY.days.map(d => ({
  date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid,
}))

/** Split `totalCents` across `weights` in proportion, last entry absorbing the rounding. */
const spread = (weights: number[], totalCents: number): number[] => {
  const w = weights.reduce((a, b) => a + b, 0)
  const out = weights.map(x => Math.round(totalCents * x / w))
  out[out.length - 1] += totalCents - out.reduce((a, b) => a + b, 0)
  return out
}
const augWeights = julyDays.map(d => Math.round(d.total * 100))
const augTotals = spread(augWeights, 1_159_105)   // $22,783.34 − July's $11,192.29
const augFees = spread(augWeights, 165_894)       // $3,260.62  − July's $1,601.68
const augDays: LedgerDay[] = augTotals.map((t, i) => ({
  date: `2026-08-${String(i + 1).padStart(2, '0')}`,
  total: t / 100, financing: (t - augFees[i]) / 100, fee: augFees[i] / 100,
}))
// The day AFTER the screen, and the reason 2026-08-26 is not a coin flip.
augDays.push({ date: '2026-08-27', total: 348.43, financing: 298.57, fee: 49.86 })
const LEDGER: LedgerDay[] = [...julyDays, ...augDays]

/** A parsed export around a day list, shaped as PlanContext wants it. */
const csvOf = (days: LedgerDay[], over: Record<string, unknown> = {}): any => {
  const byMonth = new Map<string, { n: number; t: number; p: number; f: number; first: string; last: string }>()
  for (const d of days) {
    const k = d.date.slice(0, 7)
    const m = byMonth.get(k) || { n: 0, t: 0, p: 0, f: 0, first: d.date, last: d.date }
    m.n++; m.t += Math.round(d.total * 100); m.p += Math.round((d.financing ?? 0) * 100); m.f += Math.round((d.fee ?? 0) * 100)
    if (d.date < m.first) m.first = d.date
    if (d.date > m.last) m.last = d.date
    byMonth.set(k, m)
  }
  return {
    ok: true, lender_label: 'Stripe Capital transaction export',
    rows_in_file: days.length, rows_accepted: days.length, rows_rejected_count: 0,
    rows_skipped_not_applicable: 0, rows_rejected_sample: [], currency: 'usd',
    months: [...byMonth.entries()].sort().map(([month, m]) => ({
      month, transaction_count: m.n, total_paid: m.t / 100, principal_paid: m.p / 100,
      fee_paid: m.f / 100, first_date: m.first, last_date: m.last,
    })),
    days: days.map(d => ({
      date: d.date, transaction_count: 1,
      total_paid: d.total, principal_paid: d.financing ?? 0, fee_paid: d.fee ?? 0,
    })),
    totals: null, accepted: [],
    first_date: days.length ? days[0].date : null,
    last_date: days.length ? days[days.length - 1].date : null,
    refused_because: null,
    ...over,
  }
}

// The agreement AS THE PARSER RETURNS IT — with the Repayment Start Date, which is
// what tells the planner where the period begins and therefore whether the export
// covers all of it. AGREEMENT above omits it, and that omission is itself a case
// worth pinning (§5c): without it nothing can show the file starts at the start.
const AGREEMENT_DATED: any[] = [...AGREEMENT, term('repayment_start_date', { d: '2026-07-07' })]

// `Stripe overview.png` as portal-figures.test.mts reads it: financing paid
// $19,522.72, fee paid $3,260.62, no "paid to date" line (checkPortalTotals derives
// the $22,783.34 from the parts) and NO as-of date — it printed "Jul 6 – Sep 4".
//
// Deliberately not the same split as portalOf() above, which carries the same
// $22,783.34 as $1,908.34 financing / $20,875.00 fee. Both satisfy the screen's own
// identities; only one of them is the split the lender's transactions reproduce,
// which is exactly why the export and not the screen is what dates this.
const overviewOf = (over: Record<string, unknown> = {}): PlanContext['portal'] => ({
  as_of: null, amount_remaining: 123091.66, paid_to_date: 22783.34,
  principal_paid: 19522.72, fee_paid: 3260.62, total_amount_due: 145875,
  corroborated: ['total_amount_due', 'paid_to_date', 'amount_remaining', 'principal_paid', 'fee_paid'],
  ...over,
} as any)

const datedCtx = (over: Partial<PlanContext> = {}): PlanContext => ctxOf({
  agreementTerms: AGREEMENT_DATED, portal: overviewOf(), csv: csvOf(LEDGER), ...over,
})

// ─────────────────────────────────────────────────────────────────────────────
section('5a — the export dates the screenshot: the real 2026-08-26 case')
// ─────────────────────────────────────────────────────────────────────────────
{
  // The ledger this rests on, pinned first. Everything below is worthless if the
  // construction above has drifted.
  const cum = (through: string, k: 'total' | 'financing' | 'fee') =>
    Math.round(LEDGER.filter(d => d.date <= through).reduce((a, d) => a + Math.round((d[k] ?? 0) * 100), 0)) / 100
  ok('the ledger reaches $22,783.34 on 2026-08-26 — the screen\'s "paid this period"',
     cum('2026-08-26', 'total') === 22783.34, String(cum('2026-08-26', 'total')))
  ok('...decomposing $19,522.72 financing / $3,260.62 fee, the screen\'s own two lines',
     cum('2026-08-26', 'financing') === 19522.72 && cum('2026-08-26', 'fee') === 3260.62,
     `${cum('2026-08-26', 'financing')} / ${cum('2026-08-26', 'fee')}`)
  ok('...and $23,131.77 by 2026-08-27, $348.43 further on',
     cum('2026-08-27', 'total') === 23131.77, String(cum('2026-08-27', 'total')))
  ok('...with $145,875.00 − $22,783.34 = $123,091.66, the screen\'s "amount remaining"',
     Math.round((145875 - cum('2026-08-26', 'total')) * 100) / 100 === 123091.66)

  const r = dateFromLedger({
    days: LEDGER, complete: true, coversFrom: '2026-07-06', periodStart: '2026-07-07',
    target: { paid: 22783.34, financing: 19522.72, fee: 3260.62 },
  })
  ok('the export dates the screen to 2026-08-26', r.date === '2026-08-26', `${r.date} / ${r.refused_because}`)
  ok('...on all three figures', r.agreed.join() === 'paid_to_date,financing_paid,fee_paid', r.agreed.join())
  ok('...with nothing disagreeing', r.disagreed.length === 0)
  ok('...so it is corroborated, not a lone equality', r.corroborated === true)
  ok('...reporting the running totals it matched on',
     r.cumulative?.paid === 22783.34 && r.cumulative?.financing === 19522.72 && r.cumulative?.fee === 3260.62)
  ok('...and the day after, which is what makes it unambiguous',
     r.next_day?.date === '2026-08-27' && r.next_day?.cumulative === 23131.77 && r.next_day?.difference === 348.43,
     JSON.stringify(r.next_day))
  ok('...naming the day before too', r.previous_day?.date === '2026-08-25')
  ok('...and the working names the figures and the day they agreed on',
     /2026-08-26/.test(r.statement) && /\$22,783\.34/.test(r.statement) &&
     /\$19,522\.72/.test(r.statement) && /\$3,260\.62/.test(r.statement) && /\$348\.43/.test(r.statement),
     r.statement)
  ok('...and does not oversell three agreements it does not have',
     /two independent agreements rather than three/.test(r.statement))

  // THE NEAR MISS. 2026-08-27 is $348.43 away — close on a $145,875 loan, and not
  // close at all when the test is equality to the cent.
  ok('2026-08-27 is not what comes back', r.date !== '2026-08-27')
  const oneCent = dateFromLedger({
    days: LEDGER, complete: true, coversFrom: '2026-07-06', periodStart: '2026-07-07',
    target: { paid: 22783.35 },
  })
  ok('a target one cent off matches nothing at all', oneCent.date === null && oneCent.refused_because === 'between_days',
     `${oneCent.date} / ${oneCent.refused_because}`)
  const between = dateFromLedger({
    days: LEDGER, complete: true, coversFrom: '2026-07-06', periodStart: '2026-07-07',
    target: { paid: 23000 },
  })
  ok('a target between 08-26 and 08-27 is refused, not rounded to the nearer day',
     between.date === null && between.refused_because === 'between_days')
  ok('...naming both days it falls between',
     /2026-08-26/.test(between.statement) && /2026-08-27/.test(between.statement), between.statement)
  ok('...and saying plainly that it will not round',
     /preference, not a measurement/.test(between.statement))
}

// ─────────────────────────────────────────────────────────────────────────────
section('5b — every way the ledger can fail to say, and does not guess')
// ─────────────────────────────────────────────────────────────────────────────
{
  const flat = (firstDay: number, count: number, perDay: number): LedgerDay[] =>
    Array.from({ length: count }, (_, i) => ({
      date: `2026-05-${String(firstDay + i).padStart(2, '0')}`, total: perDay, financing: perDay, fee: 0,
    }))
  const FULL = flat(1, 30, 100)                      // $100/day, 2026-05-01 to 05-30
  const base = { complete: true, coversFrom: '2026-05-01', periodStart: '2026-05-01' }

  ok('the control: $1,000 lands on 2026-05-10',
     dateFromLedger({ ...base, days: FULL, target: { paid: 1000 } }).date === '2026-05-10')

  // ── THE CRITICAL ONE. A cumulative that starts late does not report "no
  // match" — it reports a real date from the wrong week, and nothing downstream
  // can tell the difference.
  const LATE = FULL.slice(3)                          // the first $300 is missing
  const naive = dateFromLedger({
    days: LATE, complete: true, coversFrom: '2026-05-04', periodStart: '2026-05-04',
    target: { paid: 1000, financing: 1000, fee: 0 },
  })
  ok('an export that starts late matches the WRONG day, not no day',
     naive.date === '2026-05-13', `${naive.date}`)
  ok('...and corroboration does NOT catch it — the split is short by exactly as much',
     naive.corroborated === true,
     'this is why the coverage gate exists: agreeing figures cannot detect a missing head')
  const gated = dateFromLedger({
    days: LATE, complete: true, coversFrom: '2026-05-04', periodStart: '2026-05-01',
    target: { paid: 1000, financing: 1000, fee: 0 },
  })
  ok('so an export that does not reach the period start is refused outright',
     gated.date === null && gated.refused_because === 'coverage_starts_late', String(gated.refused_because))
  ok('...naming both dates and what would fix it',
     /2026-05-04/.test(gated.statement) && /2026-05-01/.test(gated.statement), gated.statement)
  const opened = dateFromLedger({
    days: LATE, complete: true, coversFrom: '2026-05-04', periodStart: '2026-05-01',
    target: { paid: 1000, financing: 1000, fee: 0 }, openingCumulative: { paid: 300, financing: 300, fee: 0 },
  })
  ok('...unless the caller states the head of the period, which recovers the right day',
     opened.date === '2026-05-10' && opened.corroborated === true, String(opened.date))
  const wrongOpening = dateFromLedger({
    days: LATE, complete: true, coversFrom: '2026-05-04', periodStart: '2026-05-01',
    target: { paid: 1000 }, openingCumulative: { paid: 400 },
  })
  ok('...and an opening cumulative is taken at face value, wrong or right',
     wrongOpening.date === '2026-05-09',
     'a claim about money the file does not contain — which is why the planner never makes one')

  // ── A TIE. A day of zero withholding straight after a match leaves two dates
  // fitting equally, and there is nothing in the arithmetic to prefer either.
  const withGap: LedgerDay[] = [
    { date: '2026-05-01', total: 100, financing: 100, fee: 0 },
    { date: '2026-05-02', total: 0, financing: 0, fee: 0 },
    { date: '2026-05-03', total: 100, financing: 100, fee: 0 },
  ]
  const tie = dateFromLedger({ ...base, days: withGap, target: { paid: 100 } })
  ok('two days sharing a running total are ambiguous, and neither is returned',
     tie.date === null && tie.refused_because === 'ambiguous', `${tie.date} / ${tie.refused_because}`)
  ok('...naming both of them', /2026-05-01/.test(tie.statement) && /2026-05-02/.test(tie.statement), tie.statement)
  ok('...while the day after the gap is still reachable on its own figure',
     dateFromLedger({ ...base, days: withGap, target: { paid: 200 } }).date === '2026-05-03')

  // ── OUT OF RANGE, both ends.
  const beyond = dateFromLedger({ ...base, days: FULL, target: { paid: 5000 } })
  ok('a target the export never reaches is refused',
     beyond.date === null && beyond.refused_because === 'target_beyond_export')
  ok('...saying how far short the file falls', /\$2,000\.00 short/.test(beyond.statement), beyond.statement)
  const before = dateFromLedger({ ...base, days: FULL, target: { paid: 50 } })
  ok('a target already passed on the export\'s first day is refused',
     before.date === null && before.refused_because === 'target_precedes_export')
  const exact = dateFromLedger({ ...base, days: FULL, target: { paid: 3000 } })
  ok('...but the export\'s own final total is a legitimate answer', exact.date === '2026-05-30')

  // ── A MATCH IN THE WRONG PERIOD. The cumulative reached back before the period
  // the screen counts, so the date it found is real and is not the screen's.
  const early = dateFromLedger({
    days: FULL, complete: true, coversFrom: '2026-05-01', periodStart: '2026-05-15',
    target: { paid: 1000 },
  })
  ok('a match before the period the figure covers is refused',
     early.date === null && early.refused_because === 'match_precedes_period', String(early.refused_because))

  // ── A FILE THAT COULD NOT BE READ WHOLE. Understates the cumulative, so it
  // dates the screen LATE — the same defect as a late start, in a smaller dose.
  const incomplete = dateFromLedger({ ...base, days: FULL, complete: false, target: { paid: 1000 } })
  ok('an export with unreadable rows dates nothing',
     incomplete.date === null && incomplete.refused_because === 'export_incomplete')

  // ── DAYS THAT ARE NOT DAYS.
  const dup = dateFromLedger({ ...base, days: [...FULL, FULL[0]], target: { paid: 1000 } })
  ok('two entries for one date is a caller that did not total by day',
     dup.date === null && dup.refused_because === 'unusable_days')
  const neg = dateFromLedger({
    ...base, days: [...FULL.slice(0, 5), { date: '2026-05-06', total: -100, financing: -100, fee: 0 }, ...FULL.slice(6)],
    target: { paid: 1000 },
  })
  ok('a negative day is refused — a running total that dips can match twice',
     neg.date === null && neg.refused_because === 'unusable_days', String(neg.refused_because))
  const subCent = dateFromLedger({
    ...base, days: [{ date: '2026-05-01', total: 0.005, financing: 0.005, fee: 0 }], target: { paid: 0.005 },
  })
  ok('a sub-cent day is refused rather than rounded into the sum',
     subCent.date === null && subCent.refused_because === 'unusable_days')
  const badSplit = dateFromLedger({
    ...base, days: [{ date: '2026-05-01', total: 100, financing: 60, fee: 30 }], target: { paid: 100 },
  })
  ok('a day whose parts do not add up to its own total is refused',
     badSplit.date === null && badSplit.refused_because === 'unusable_days')
  const outside = dateFromLedger({
    days: FULL, complete: true, coversFrom: '2026-05-10', periodStart: '2026-05-10', target: { paid: 1000 },
  })
  ok('a day earlier than the coverage the export claims is a contradiction, not a bonus',
     outside.date === null && outside.refused_because === 'unusable_days', String(outside.refused_because))
  ok('no days at all is its own refusal',
     dateFromLedger({ ...base, days: [], target: { paid: 1 } }).refused_because === 'no_export')
  for (const bad of [0, -100, NaN, Infinity]) {
    ok(`a target of ${bad} dates nothing`,
       dateFromLedger({ ...base, days: FULL, target: { paid: bad } }).refused_because === 'unusable_target')
  }

  // ── ORDER AND CORROBORATION.
  const shuffled = [...FULL].reverse()
  ok('the days may arrive in any order', dateFromLedger({ ...base, days: shuffled, target: { paid: 1000 } }).date === '2026-05-10')
  const noSplit: LedgerDay[] = FULL.map(d => ({ date: d.date, total: d.total }))
  const bare = dateFromLedger({ ...base, days: noSplit, target: { paid: 1000, financing: 900, fee: 100 } })
  ok('an export that does not split its days still dates the total', bare.date === '2026-05-10')
  ok('...but cannot corroborate, and says so',
     bare.corroborated === false && bare.agreed.join() === 'paid_to_date' && bare.disagreed.length === 0)
  ok('...naming it as a single equality', /single equality/.test(bare.statement), bare.statement)
  const wrongSplit = dateFromLedger({ ...base, days: FULL, target: { paid: 1000, financing: 900, fee: 100 } })
  ok('a screen whose split the export contradicts still reports the day...',
     wrongSplit.date === '2026-05-10')
  ok('...and reports it as NOT corroborated, listing what disagreed',
     wrongSplit.corroborated === false && wrongSplit.disagreed.join() === 'financing_paid,fee_paid',
     wrongSplit.disagreed.join())
  ok('...saying the two are measuring the payments differently',
     /measuring the payments differently/.test(wrongSplit.statement), wrongSplit.statement)
}

// ─────────────────────────────────────────────────────────────────────────────
section('5c — the derived date reaches the action, the payload and the screen')
// ─────────────────────────────────────────────────────────────────────────────
{
  const plan = buildPlan(datedCtx())
  const a = of(plan, 'record_lender_balance')!
  ok('the undated screenshot now produces an action', !!a)
  ok('...unblocked', !a.blocked_reason, a.blocked_reason || '')
  ok('...ticked by default', a.default_checked === true)
  ok('...filed at the derived date', (a.payload as any).statement_date === '2026-08-26',
     String((a.payload as any).statement_date))
  ok('...carrying the screen\'s own figure, unchanged', (a.payload as any).principal_balance === 123091.66)
  ok('...still a portal_manual_pull', (a.payload as any).source === 'portal_manual_pull')
  ok('...on the payoff basis the screen\'s total proves', (a.payload as any).balance_basis === 'total_payback')

  // THE PAYLOAD CARRIES THE EVIDENCE, because apply reads the stored plan verbatim
  // and must never re-run this measurement against whatever file is there later.
  const ev = (a.payload as any).dated_by_export
  ok('the payload says where the date came from', (a.payload as any).date_source === 'transaction_export')
  ok('...and carries the derived date beside the evidence', ev?.date === '2026-08-26')
  ok('...the figures that agreed', ev?.agreed?.join() === 'paid_to_date,financing_paid,fee_paid')
  ok('...the running totals they agreed on',
     ev?.cumulative?.paid === 22783.34 && ev?.cumulative?.financing === 19522.72 && ev?.cumulative?.fee === 3260.62)
  ok('...the screen figures they were matched against',
     ev?.target?.paid_to_date === 22783.34 && ev?.target?.financing_paid === 19522.72)
  ok('...the next day, so the margin is on the record', ev?.next_day?.difference === 348.43)
  ok('...the period start the coverage was judged against', ev?.period_start === '2026-07-07')
  ok('...what the export covers', ev?.export_covers?.from === '2026-07-06' && ev?.export_covers?.through === '2026-08-27')
  ok('...and the working in words', /2026-08-26/.test(String(ev?.statement)))

  // SHOW THE WORKING. A person has to be able to check this rather than trust it.
  ok('the description names the day it was dated to', /2026-08-26/.test(a.plain_english))
  ok('...the figure that was matched', /\$22,783\.34/.test(a.plain_english))
  ok('...both halves of the split that agreed',
     /\$19,522\.72/.test(a.plain_english) && /\$3,260\.62/.test(a.plain_english))
  ok('...the next day and how far past it is',
     /\$23,131\.77/.test(a.plain_english) && /\$348\.43/.test(a.plain_english))
  ok('...says the date was measured rather than stated', /measured rather than guessed/.test(a.plain_english))
  ok('...and that the date is only as good as the export',
     /only as good as the export/.test(a.plain_english), a.plain_english)
  ok('the title says the date was derived, before anyone opens the description',
     /2026-08-26/.test(a.title) && /dated from the transaction export/.test(a.title), a.title)

  // The question is ANSWERED, so it must not still be asked.
  ok('the "what date was this taken" question is gone',
     !plan.unresolved.some(u => /date was this screenshot/i.test(u.question)),
     JSON.stringify(plan.unresolved.map(u => u.question)))
  ok('the action can actually be approved', checkApproveList(plan, [a.id]) === null)
  const checked = checkStatementPayload('record_lender_balance', a.payload)
  ok('...and apply reads the payload verbatim, deriving nothing',
     checked.ok === true && checked.row.statement_date === '2026-08-26' &&
     checked.row.principal_balance === 123091.66)

  // ── A DATED SCREENSHOT IGNORES ALL OF THIS ────────────────────────────────
  // The screen's own date wins even when the export would have said something
  // else. Measuring a date we were told is how a stated fact gets quietly
  // replaced by a derived one.
  const stated = buildPlan(datedCtx({ portal: overviewOf({ as_of: '2026-08-20' }) }))
  const sa = of(stated, 'record_lender_balance')!
  ok('a screenshot that states its date is filed at that date',
     (sa.payload as any).statement_date === '2026-08-20')
  ok('...even though the export would have said 2026-08-26',
     (sa.payload as any).date_source === 'screen' && (sa.payload as any).dated_by_export === null)
  ok('...and the description does not show working it never did',
     !/running total/.test(sa.plain_english), sa.plain_english)

  // ── NO EXPORT: BLOCKED, EXACTLY AS BEFORE ────────────────────────────────
  const bare = buildPlan(ctxOf({ agreementTerms: AGREEMENT_DATED, portal: overviewOf(), csv: null }))
  const ba = of(bare, 'record_lender_balance')!
  ok('with no export the action is blocked as it always was', !!ba.blocked_reason)
  ok('...with no date in the payload', (ba.payload as any).statement_date === null)
  ok('...and no evidence it does not have',
     (ba.payload as any).dated_by_export === null && (ba.payload as any).date_source === null)
  ok('...the Unresolved question is still asked',
     bare.unresolved.some(u => /date was this screenshot/i.test(u.question)))
  ok('...and the wording is untouched by all of this — no export, nothing to report',
     !/running total/.test(ba.blocked_reason!) && !/transaction export/.test(ba.blocked_reason!),
     ba.blocked_reason)
  ok('...ending exactly where it has always ended, with nothing appended',
     /and it can be filed\.$/.test(ba.blocked_reason!),
     'a note about an export that is not in the set would be a report on a search nobody ran')
  ok('...and the question ends where it always did too',
     bare.unresolved.some(u => /date was this screenshot/i.test(u.question) &&
       /lender anchor this loan has never had\.$/.test(u.what_would_answer_it)))
  ok('...and it still cannot be approved', checkApproveList(bare, [ba.id])?.code === 'blocked_actions')
}

// ─────────────────────────────────────────────────────────────────────────────
section('5d — when the export is there and still cannot say')
// ─────────────────────────────────────────────────────────────────────────────
{
  const blockedOf = (over: Partial<PlanContext>) => {
    const plan = buildPlan(datedCtx(over))
    return { plan, a: of(plan, 'record_lender_balance')! }
  }

  // ── THE SCREEN'S SPLIT DISAGREES WITH THE EXPORT'S. portalOf() carries the same
  // $22,783.34 as $1,908.34 financing / $20,875.00 fee — fee-first rather than
  // pro-rata. The total still lands on 2026-08-26; nothing else does, so the date
  // is offered as a candidate and not taken.
  const split = blockedOf({ portal: portalOf({ as_of: null }) })
  ok('a screen whose split the export contradicts does not unblock the action',
     !!split.a.blocked_reason)
  ok('...but the candidate date is handed over rather than withheld',
     /2026-08-26/.test(split.a.blocked_reason!), split.a.blocked_reason)
  ok('...saying one figure is not enough',
     /One figure agreeing is not enough/.test(split.a.blocked_reason!))
  ok('...and the question stays open, with the candidate in it',
     split.plan.unresolved.some(u => /date was this screenshot/i.test(u.question) &&
       /2026-08-26/.test(u.what_would_answer_it)))

  // ── ONLY THE AUGUST FILE. The critical case, end to end: the running total is
  // $11,192.29 light from the first day, so an unguarded match would be weeks out.
  const augOnly = blockedOf({ csv: csvOf(augDays) })
  ok('an export that starts after the period does not date anything',
     !!augOnly.a.blocked_reason && (augOnly.a.payload as any).statement_date === null)
  ok('...and says so, naming the day the file begins and the day the period does',
     /2026-08-01/.test(augOnly.a.blocked_reason!) && /2026-07-07/.test(augOnly.a.blocked_reason!),
     augOnly.a.blocked_reason)

  // ── NO REPAYMENT START DATE. Then nothing shows that the export begins where the
  // period does, and `origination` (2026-06-30) is six days before the file starts.
  const noStart = blockedOf({ agreementTerms: AGREEMENT })
  ok('without the agreement\'s repayment start date the export cannot be shown to cover the period',
     !!noStart.a.blocked_reason && (noStart.a.payload as any).statement_date === null)
  ok('...and the refusal names the six days nothing accounts for',
     /2026-06-30/.test(noStart.a.blocked_reason!) && /2026-07-06/.test(noStart.a.blocked_reason!),
     noStart.a.blocked_reason)
  // ...and asks for the term rather than for a file that cannot exist. Repayment
  // starts a week after origination on this lender, so "an export covering from
  // 2026-06-30" is not something anybody can produce.
  ok('...naming the missing Repayment Start Date as the thing to go and find',
     /does not state a Repayment Start Date/.test(noStart.a.blocked_reason!), noStart.a.blocked_reason)
  ok('...and that caveat is absent when the agreement DID state it',
     !/does not state a Repayment Start Date/.test(augOnly.a.blocked_reason!))

  // ── AN EXPORT THAT COULD NOT BE READ WHOLE.
  const torn = blockedOf({ csv: csvOf(LEDGER, { ok: false, rows_rejected_count: 4 }) })
  ok('an export with unreadable rows dates nothing', !!torn.a.blocked_reason)
  ok('...and says it would have dated the screen late',
     /dates a screen LATE|short by an unknown amount/.test(torn.a.blocked_reason!), torn.a.blocked_reason)

  // ── A PAID-TO-DATE THE SCREEN ITSELF NEVER PROVED. Dating a lender anchor off an
  // unchecked number would put the $125,000-read-as-$123,091.66 misread in charge of
  // the date as well as the figure.
  const unproven = blockedOf({
    portal: overviewOf({ corroborated: ['total_amount_due', 'amount_remaining'] }),
  })
  ok('an uncorroborated paid-to-date is not used to date anything',
     !!unproven.a.blocked_reason && (unproven.a.payload as any).statement_date === null)
  ok('...and nothing is reported about an export that was never consulted',
     !/running total/.test(unproven.a.blocked_reason!))

  // ── THE DERIVED DATE IS THE DATE THE SAME-DAY CHECKS USE. A lender figure already
  // on file for 2026-08-26 has to be seen, or the derived date files a second anchor
  // beside it and the authority ranking picks between them by accident of ordering.
  const anchor = (d: string, b: number) =>
    ({ statement_date: d, principal_balance: b, balance_basis: 'total_payback', source: 'lender_statement' })
  const clash = buildPlan(datedCtx({ statements: [sweep('2026-07-01', 145875), anchor('2026-08-26', 124000)] }))
  ok('a contradicting lender row on the DERIVED date blocks the action',
     !of(clash, 'record_lender_balance'))
  ok('...and is raised as the same conflict a stated date would raise',
     clash.conflicts.some(c => c.key === 'lender_balance_disagrees_with_file' && /2026-08-26/.test(c.statement)))
  const agreeing = buildPlan(datedCtx({ statements: [sweep('2026-07-01', 145875), anchor('2026-08-26', 123091.66)] }))
  ok('an agreeing lender row on the derived date proposes nothing and says so',
     !of(agreeing, 'record_lender_balance') &&
     agreeing.corroborations.some(c => /already on file from a lender document/.test(c.statement) && /2026-08-26/.test(c.statement)))
}

// ─────────────────────────────────────────────────────────────────────────────
section('6 — a lender figure already on file is a conflict, not an overwrite')
// ─────────────────────────────────────────────────────────────────────────────
{
  const anchor = (d: string, b: number, source = 'lender_statement') =>
    ({ statement_date: d, principal_balance: b, balance_basis: 'total_payback', source })

  const clash = buildPlan(ctxOf({
    portal: portalOf(),
    statements: [sweep('2026-07-01', 145875), anchor('2026-08-26', 124000)],
  }))
  ok('a real anchor on the same date with a different value blocks the action',
     !of(clash, 'record_lender_balance'))
  const c = clash.conflicts.find(x => x.key === 'lender_balance_disagrees_with_file')
  ok('...and is raised as a conflict instead', !!c)
  ok('...naming both figures', !!c && /\$123,091\.66/.test(c.expected) && /\$124,000\.00/.test(c.found),
     c ? `${c.expected} / ${c.found}` : '')
  ok('...and distinguishing it from the books-versus-lender gap',
     !!c && /two claims about what the LENDER says/i.test(c.caveat || ''), c?.caveat || '')

  // The same figure already filed is not a conflict and not a second row.
  const same = buildPlan(ctxOf({
    portal: portalOf(),
    statements: [sweep('2026-07-01', 145875), anchor('2026-08-26', 123091.66)],
  }))
  ok('a real anchor already agreeing proposes nothing', !of(same, 'record_lender_balance'))
  ok('...and says so as a corroboration', same.corroborations.some(x => /already on file from a lender document/.test(x.statement)))
  ok('...raising no conflict', !same.conflicts.some(x => x.key === 'lender_balance_disagrees_with_file'))

  // A row of OUR OWN on that date disagreeing is the books-versus-lender gap, which
  // section 5 already reports. Raising it twice in two vocabularies teaches people
  // to scroll past both.
  const ourOwn = buildPlan(ctxOf({
    portal: portalOf(),
    statements: [sweep('2026-07-01', 145875), sweep('2026-08-26', 125257.71)],
  }))
  ok('a snapshot of our own is not treated as a competing lender anchor',
     !!of(ourOwn, 'record_lender_balance'))
  ok('...and no duplicate conflict is raised for it',
     !ourOwn.conflicts.some(x => x.key === 'lender_balance_disagrees_with_file'))
}

// ─────────────────────────────────────────────────────────────────────────────
section('7 — the source value, and the allowlist it must stay off')
// ─────────────────────────────────────────────────────────────────────────────
{
  ok('the origination row is NOT a real anchor', !REAL_ANCHOR_SOURCES.includes(ORIGINATION_SOURCE),
     `${ORIGINATION_SOURCE} must never satisfy a statement checklist or close a rollforward`)
  ok('the real-anchor list is exactly the three the rest of the system means',
     REAL_ANCHOR_SOURCES.join() === 'lender_statement,email_pdf_upload,portal_manual_pull',
     REAL_ANCHOR_SOURCES.join())

  // REAL_ANCHOR_SOURCES is an alias of settlement-lag's RATE_SOURCES rather than a
  // tenth copy of the list. That saves a copy and buys a coupling: narrowing it for
  // a rate-measurement reason would silently narrow what counts as an anchor in the
  // planner. Pinned against the dashboard's own copy so the divergence is loud.
  const dash = fs.readFileSync(path.join(HERE, '..', 'admin-dashboard', 'index.html'), 'utf8')
  const m = dash.match(/const _VARIANCE_REAL_ANCHORS = \[([^\]]+)\]/)
  ok('the dashboard still holds the same three', !!m &&
     m[1].replace(/['\s]/g, '') === REAL_ANCHOR_SOURCES.join(','), m ? m[1] : 'not found')

  ok('...and the dashboard has not been taught to trust it either',
     !new RegExp(`_VARIANCE_REAL_ANCHORS = \\[[^\\]]*${ORIGINATION_SOURCE}`).test(dash))

  // WHAT AN UNRECOGNISED SOURCE DOES ON SCREEN, pinned because it is the reason
  // this value could be chosen at all. Every consumer degrades rather than breaks:
  // the allowlist above excludes it by omission, the statement table prints
  // `(s.source||'').replace(/_/g,' ')`, and _anchorSourceLabel ends in a fallback.
  ok('the real-anchor test is an allowlist, so an unknown source fails safe',
     /_VARIANCE_REAL_ANCHORS\.includes\(String\(s\.source \|\| ''\)\)/.test(dash))
  ok('the statement table renders any source, recognised or not',
     /esc\(\(s\.source \|\| ''\)\.replace\(\/_\/g, ' '\)\)/.test(dash))
  ok('_anchorSourceLabel falls through to the raw value rather than throwing',
     /_ANCHOR_SOURCE_LABEL\[src\] \|\| src \|\| 'unknown'/.test(dash))

  // The gap this section used to report is CLOSED (session 246). Until the label
  // existed, the close band's opening column read "30 Jun · contract_origination"
  // — a raw database enum on screen. The assertion that stood here was written to
  // FAIL the day someone added the label, and it did; this is what replaced it.
  ok('the close band has a human label for the day-one source',
     new RegExp(`${ORIGINATION_SOURCE}: 'signed agreement'`).test(dash),
     'the opening column will print the raw slug again')
}

// ─────────────────────────────────────────────────────────────────────────────
section('8 — apply: the payload is read, never repaired')
// ─────────────────────────────────────────────────────────────────────────────
{
  const good = { statement_date: '2026-06-30', principal_balance: 145875,
                 balance_basis: 'total_payback', source: 'contract_origination' }
  const r = checkStatementPayload('open_at_origination', good)
  ok('a well-formed payload is accepted', r.ok === true)
  ok('...verbatim, field for field', r.ok && r.row.principal_balance === 145875 &&
     r.row.statement_date === '2026-06-30' && r.row.balance_basis === 'total_payback')

  // THE ESCALATION. intake_bundles.plan is a jsonb column any admin or manager can
  // INSERT through PostgREST, and applyBundle holds the service role. Without the
  // whitelist, a hand-made plan mints a row every surface reads as a document the
  // LENDER sent.
  const forged = checkStatementPayload('open_at_origination', { ...good, source: 'lender_statement' })
  ok('an action cannot claim a source that is not its own', forged.ok === false)
  ok('...and the message names the one it may write', !forged.ok && /contract_origination/.test(forged.error))
  ok('the lender action may not claim the contract source',
     checkStatementPayload('record_lender_balance', good).ok === false)
  ok('...but may claim its own',
     checkStatementPayload('record_lender_balance', { ...good, source: 'portal_manual_pull' }).ok === true)
  ok('an unknown kind may write nothing', checkStatementPayload('set_carrying_basis', good).ok === false)
  ok('the map has exactly the two balance-writing kinds',
     Object.keys(STATEMENT_SOURCE_BY_KIND).join() === 'open_at_origination,record_lender_balance')

  // A blocked action can never be applied, but if its payload ever reached here the
  // one thing that must not happen is a date being invented.
  const undated = checkStatementPayload('record_lender_balance',
    { ...good, source: 'portal_manual_pull', statement_date: null })
  ok('a null date is refused, not filled in with today', undated.ok === false)
  ok('...and says what is missing', !undated.ok && /nothing to file the balance against/.test(undated.error))
  for (const bad of ['', '2026-6-30', '30/06/2026', '2026-06-30T00:00:00Z', '2026-02-31', 'today']) {
    ok(`'${bad}' is not a date this will file against`,
       checkStatementPayload('open_at_origination', { ...good, statement_date: bad }).ok === false)
  }
  ok('a missing balance is refused',
     checkStatementPayload('open_at_origination', { ...good, principal_balance: null }).ok === false)
  ok('...and a string that looks like one is not coerced',
     checkStatementPayload('open_at_origination', { ...good, principal_balance: '145875' }).ok === false)
  ok('a basis outside the CHECK constraint is refused',
     checkStatementPayload('open_at_origination', { ...good, balance_basis: 'gross_payback' }).ok === false)
  ok('...and is NOT quietly defaulted to unknown',
     checkStatementPayload('open_at_origination', { ...good, balance_basis: undefined }).ok === false,
     'an unlabelled balance is dropped from the lender checks — a silent default hides a plan defect in a row nothing examines')
  for (const b of STATEMENT_BASES) {
    ok(`'${b}' is accepted`, checkStatementPayload('open_at_origination', { ...good, balance_basis: b }).ok === true)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('9 — apply: idempotent, and never an overwrite')
// ─────────────────────────────────────────────────────────────────────────────
{
  const row = { statement_date: '2026-06-30', principal_balance: 145875,
                balance_basis: 'total_payback', source: 'contract_origination' }

  ok('nothing on file inserts', statementRowWrite([], row).verdict === 'insert')
  ok('...and null is the same as nothing', statementRowWrite(null, row).verdict === 'insert')

  // THE RETRY PATH. The insert committed, the reply was lost, the action landed in
  // `failed`, and `alreadyDone` — built from `applied` only — does not know. A bare
  // re-insert is a second balance for one day, and _rankByAuthority would then pick
  // between the two by accident of ordering.
  const again = statementRowWrite([{ principal_balance: 145875 }], row)
  ok('the same figure already there is adopted, not inserted again', again.verdict === 'already_filed')
  ok('...and reported as an adoption rather than as a filing',
     again.verdict === 'already_filed' && /kept the row already there/.test(again.message))
  ok('...tolerating the numeric coming back as a string from PostgREST',
     statementRowWrite([{ principal_balance: '145875.00' }], row).verdict === 'already_filed')

  // NEVER AN OVERWRITE. Somebody else's figure for this day is somebody else's
  // evidence; winning by writing last is what correct_statement_basis's
  // .eq('balance_basis','unknown') exists to prevent on the same table.
  const clash = statementRowWrite([{ principal_balance: 140000 }], row)
  ok('a different figure fails the action', clash.verdict === 'conflict')
  ok('...naming both', clash.verdict === 'conflict' &&
     /\$140,000\.00/.test(clash.message) && /\$145,875\.00/.test(clash.message), (clash as any).message)
  ok('...and saying nothing was changed', clash.verdict === 'conflict' && /Nothing was changed/.test(clash.message))
  ok('a cent of difference is still the same balance',
     statementRowWrite([{ principal_balance: 145875.004 }], row).verdict === 'already_filed')
  ok('...but a cent and a half is not',
     statementRowWrite([{ principal_balance: 145875.02 }], row).verdict === 'conflict')

  // Duplicate rows already exist on this table (one loan carries the same
  // screenshot three times); a lookup can legitimately return more than one.
  ok('one of several matching is enough to adopt',
     statementRowWrite([{ principal_balance: 140000 }, { principal_balance: 145875 }], row).verdict === 'already_filed')
  ok('...and none matching is still a conflict, not a third row',
     statementRowWrite([{ principal_balance: 140000 }, { principal_balance: 141000 }], row).verdict === 'conflict')
  // A row with a different LABEL but the same figure is left alone rather than
  // relabelled — correct_statement_basis owns that decision, and it refuses to
  // touch a basis somebody already established.
  ok('a different balance_basis on the same figure is not a conflict',
     statementRowWrite([{ principal_balance: 145875, balance_basis: 'unknown' }], row).verdict === 'already_filed')
}

// ─────────────────────────────────────────────────────────────────────────────
section('10 — the handlers are wired into the function that ships')
// ─────────────────────────────────────────────────────────────────────────────
// Read as text, for the parts inseparable from a PostgREST call. Everything above
// proves the decision is right; this proves applyBundle asks. A pure module that
// decides correctly beside a caller that ignores it is exactly as broken as no fix.
{
  const SRC = path.join(HERE, '..', 'supabase', 'functions', 'loan-bundle', 'index.ts')
  const src = fs.readFileSync(SRC, 'utf8')
  const applySrc = src.slice(src.indexOf('async function applyBundle'))
  if (!applySrc) throw new Error(`applyBundle is no longer in ${SRC} — this section cannot check anything`)

  ok('both kinds reach a handler',
     /act\.kind === 'open_at_origination' \|\| act\.kind === 'record_lender_balance'/.test(applySrc))
  ok('the payload goes through checkStatementPayload before anything else',
     /const checked = checkStatementPayload\(act\.kind, p\)/.test(applySrc) &&
     applySrc.indexOf('checkStatementPayload(act.kind, p)') < applySrc.indexOf("from('loan_statements').insert"))
  ok('...and a refusal throws rather than being patched up',
     /if \(!checked\.ok\) throw new Error\(checked\.error\)/.test(applySrc))
  // CHANGED, session 246. This asserted the lookup was scoped to (loan, date,
  // SOURCE) — which is what the module assumed the unique constraint was. It is
  // not: loan_statements carries UNIQUE (loan_account_id, statement_date). Asking
  // only about our own source found nothing on a day the books' sweep already
  // owned, returned 'insert', and let Postgres raise the duplicate at a person.
  // The lookup must key on what the CONSTRAINT keys on.
  ok('the existing row is looked up on (loan, date) — what the constraint keys on',
     /from\('loan_statements'\)[\s\S]{0,300}?\.eq\('loan_account_id', loanId\)[\s\S]{0,160}?\.eq\('statement_date', stmt\.statement_date\)/.test(applySrc))
  ok('...and it selects the source, so a foreign row can be named',
     /\.select\('id, principal_balance, balance_basis, source'\)/.test(applySrc))
  ok('...and is NOT narrowed to our own source',
     !/\.eq\('source', stmt\.source\)/.test(applySrc))
  ok('...before the insert, not after',
     applySrc.indexOf(".eq('statement_date', stmt.statement_date)") < applySrc.indexOf("from('loan_statements').insert"))
  ok('...and a failed lookup is not read as "no row is there"',
     /if \(exErr\) throw exErr/.test(applySrc))
  ok('the decision routes through statementRowWrite',
     /const write = statementRowWrite\(onFile \|\| \[\], stmt\)/.test(applySrc))
  ok('...a conflict OR a taken day fails the action instead of overwriting',
     /if \(write\.verdict === 'date_taken' \|\| write\.verdict === 'conflict'\) \{[\s\S]{0,400}?throw new Error\(write\.message\)/.test(applySrc))
  ok('...and an adoption is reported without an insert',
     /write\.verdict === 'already_filed'[\s\S]{0,300}?applied\.push/.test(applySrc))
  ok('there is exactly one insert into loan_statements',
     (applySrc.match(/from\('loan_statements'\)\s*\n?\s*\.insert\(/g) || []).length === 1)
  ok('the row is built from the checked payload, not from the raw action',
     /principal_balance: stmt\.principal_balance, balance_basis: stmt\.balance_basis/.test(applySrc) &&
     !/principal_balance: p\.principal_balance/.test(applySrc))
  ok('nothing recomputes a figure at apply time',
     !/total_repayment_amount/.test(applySrc) && !/amount_remaining/.test(applySrc),
     'a figure derived twice can differ between the screen approved and the row written')
  ok('the correct_statement_basis guard is still there beside it',
     /\.eq\('balance_basis', 'unknown'\)/.test(applySrc))
}


section('dating a screen that states what is still OWED (session 263, PayPal 2)')
{
  // PayPal 2's real figures. The contract: $157,000 advanced, $20,565.12 of fee,
  // $177,565.12 repaid in all. The screen on 2026-09-02: $46,144.59 of principal
  // and $1,661.55 of fee still owed, $47,806.14 together — and no as-of date
  // printed anywhere on it.
  const TERMS = { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177565.12 }
  const SCREEN = { principal_balance: 46144.59, fee_balance: 1661.55, total_balance: 47806.14 }

  const c = paidFromOutstanding(SCREEN, TERMS)
  ok('the conversion succeeds', c.refused_because === null, c.statement)
  ok('total paid is the contract less the balance',
     Math.abs(c.target!.paid - 129758.98) < 0.005, String(c.target?.paid))
  ok('financing paid is measured too', Math.abs(c.target!.financing! - 110855.41) < 0.005, String(c.target?.financing))
  ok('and the fee paid', Math.abs(c.target!.fee! - 18903.57) < 0.005, String(c.target?.fee))
  // The parts must foot to the whole, or the conversion has invented something.
  ok('the converted parts foot to the whole',
     Math.abs((c.target!.financing! + c.target!.fee!) - c.target!.paid) < 0.005)
  ok('the working is stated in full', /still owed is .* paid/.test(c.statement), c.statement)

  // REFUSALS — each one a date the module must decline to produce.
  ok('no terms on file -> refused',
     paidFromOutstanding(SCREEN, { loan_amount: null, fixed_fee: null, total_repayment_amount: null })
       .refused_because === 'no_terms')
  ok('terms that do not add up -> refused',
     paidFromOutstanding(SCREEN, { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177500 })
       .refused_because === 'terms_disagree')
  ok('...and it names both figures',
     /not the .*177,500\.00/.test(paidFromOutstanding(SCREEN,
       { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177500 }).statement))
  ok('a screen with no total still owed -> refused',
     paidFromOutstanding({ principal_balance: 46144.59 }, TERMS).refused_because === 'no_balance')
  ok('a balance bigger than the loan -> refused, not returned negative',
     paidFromOutstanding({ total_balance: 200000 }, TERMS).refused_because === 'impossible_result')
  ok('a sub-cent figure -> refused',
     paidFromOutstanding({ total_balance: 47806.145 }, TERMS).refused_because === 'unusable_amount')

  // The typed original_amount on this loan is $177,500 — wrong by $65.12 against
  // the lender's own CSV. That is precisely the shape 'terms_disagree' exists to
  // catch, and it is why a date is refused rather than produced 65 dollars late.
  ok('the loan record\'s own wrong total is caught by the same guard',
     paidFromOutstanding(SCREEN, { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177500 })
       .target === null)

  // DISCRIMINATION: the conversion must actually feed the dating engine, and the
  // dating engine must find the right day from it. A tiny ledger, exact.
  const days: LedgerDay[] = [
    { date: '2026-08-26', total: 3414.71, financing: 3165.30, fee: 249.41 },
    { date: '2026-09-02', total: 3414.71, financing: 3180.33, fee: 234.38 },
  ]
  const dated = dateFromLedger({
    days, complete: true, coversFrom: '2026-08-26', periodStart: '2026-08-26',
    target: { paid: 6829.42, financing: 6345.63, fee: 483.79 },
  })
  ok('the ledger dates the last payment day', dated.date === '2026-09-02', dated.statement)
  ok('and it is corroborated by the split', dated.corroborated === true)
  // And it refuses when the target lands between two days.
  const between = dateFromLedger({
    days, complete: true, coversFrom: '2026-08-26', periodStart: '2026-08-26',
    target: { paid: 5000 } })
  ok('a target between two days is still refused', between.date === null && between.refused_because === 'between_days')
}



section('the PayPal bundle, wired end to end (session 263 cont.)')
{
  // Everything the real bundle holds: the lender's history CSV and an undated
  // screenshot that itemises what is still owed. No agreement PDF — PayPal
  // sends none, which is exactly why the CSV has to be allowed to state terms.
  const HEAD = 'Date,Description,Amount,Principal,Fee,Other'
  const PAY: [string, string, string][] = [
    ['09/02/2026','3,180.33','234.38'], ['08/26/2026','3,165.30','249.41'],
    ['08/19/2026','3,150.32','264.39'], ['08/12/2026','3,135.43','279.28'],
  ]
  const CSV = [HEAD,
    ...PAY.map(([d,p,fe]) => `${d},Auto Draft Payment,"-$3,414.71","-$${p}","-$${fe}","$0.00"`),
    '08/05/2026,Wire,"$12,631.46","$12,631.46","$0.00","$0.00"',
    '08/05/2026,Total Loan Fee,"$1,027.46","$0.00","$1,027.46","$0.00"',
  ].join('\n')
  const pp = parsePayPalHistoryCsv(CSV)
  const paidAll = pp.totals!.total_paid            // 13,658.92
  const owed = pp.origination!.total_repayment_amount! - paidAll   // 0 after the last payment

  const ctx = ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_name: 'Paypal 2',
            lender_account_number: 'A00845102', original_amount: 177500, xero_account_code: '284' },
    agreementTerms: [],
    ledgerTerms: pp.terms as any,
    ledgerTermsSource: 'Paypal Loan.csv',
    csv: pp as any,
    documents: [{ filename: 'Paypal Loan.csv', kind: 'transaction_history', sha256: 'abc' }] as any,
    statements: [sweep('2026-08-12', 10244.21, 'principal_only')],
    portal: {
      as_of: null, amount_remaining: null, paid_to_date: null, principal_paid: null,
      fee_paid: null, total_amount_due: null, funds_deposited: null, funds_deposited_date: null,
      principal_balance: pp.origination!.loan_amount! - pp.totals!.principal_paid,
      fee_balance: pp.origination!.fixed_fee! - pp.totals!.fee_paid,
      total_balance: owed,
      amount_remaining_basis: null,
      corroborated: ['principal_balance', 'fee_balance', 'total_balance'],
    } as any,
  })
  const plan = buildPlan(ctx)

  const rec = all(plan, 'record_contract_terms')
  ok('the CSV terms are proposed for recording', rec.length === 1, String(rec.length))
  ok('and the action names the transaction history, not an agreement',
     /transaction history/.test(rec[0].title) && !/agreement/i.test(rec[0].title), rec[0].title)
  ok('the provenance travels with them',
     (rec[0].payload as any).extracted_by === 'deterministic_parser:paypal_loan_history_v1')
  ok('four opening figures', ((rec[0].payload as any).terms || []).length === 4)

  // A conflict between the two lender documents must remove the figure entirely.
  const conflicted = buildPlan(ctxOf({ ...ctx, termConflicts: ['total_repayment_amount: the agreement says 177500, the lender\'s transaction history says 177565.12'] } as any))
  ok('a term two documents contradict raises an unresolved question',
     conflicted.unresolved.some(u => /which of this lender's own documents/i.test(u.question)),
     JSON.stringify(conflicted.unresolved.map(u => u.question)))
  ok('...and it says neither figure was used',
     conflicted.unresolved.some(u => /Neither was used/.test(u.what_would_answer_it)))
}

section('the ledger and the agreement are not the same kind of evidence')
{
  // An agreement present alongside ledger terms: the agreement still wins the
  // lookup, and BOTH record actions appear, because they are different documents
  // making different claims and a person may want each on file.
  const pp = parsePayPalHistoryCsv([
    'Date,Description,Amount,Principal,Fee,Other',
    '09/02/2026,Auto Draft Payment,"-$3,414.71","-$3,180.33","-$234.38","$0.00"',
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
    '12/10/2025,Total Loan Fee,"$20,565.12","$0.00","$20,565.12","$0.00"',
  ].join('\n'))
  const withBoth = buildPlan(ctxOf({ ledgerTerms: pp.terms as any, ledgerTermsSource: 'pp.csv' } as any))
  const recs = all(withBoth, 'record_contract_terms')
  ok('both documents get their own record action', recs.length === 2, String(recs.length))
  ok('one names the agreement and one the transaction history',
     recs.some(r => /from the agreement/.test(r.title)) &&
     recs.some(r => /transaction history/.test(r.title)),
     recs.map(r => r.title).join(' | '))
}



// ─────────────────────────────────────────────────────────────────────────────
// Session 263 cont. 2 — the five defects the first live run exposed.
// Every one is asserted against the BROKEN behaviour as well as the fixed one,
// because a test that passes either way is decoration.
// ─────────────────────────────────────────────────────────────────────────────

const PP_CSV = [
  'Date,Description,Amount,Principal,Fee,Other',
  '09/02/2026,Auto Draft Payment,"-$3,414.71","-$3,180.33","-$234.38","$0.00"',
  '08/26/2026,Auto Draft Payment,"-$3,414.71","-$3,165.30","-$249.41","$0.00"',
  '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
  '12/10/2025,Total Loan Fee,"$20,565.12","$0.00","$20,565.12","$0.00"',
].join('\n')

// The screen as checkPortalTotals leaves it: itemised, no headline, no date.
const ppScreen = (over: Record<string, unknown> = {}) => ({
  as_of: null, amount_remaining: null, paid_to_date: null, principal_paid: null,
  fee_paid: null, total_amount_due: null, funds_deposited: null, funds_deposited_date: null,
  principal_balance: 46144.59, fee_balance: 1661.55, total_balance: 47806.14,
  amount_remaining_basis: null,
  lender_balance_net_principal: 46144.59, lender_balance_gross_payback: 47806.14,
  corroborated: ['principal_balance', 'fee_balance', 'total_balance'],
  ...over,
} as any)

section('A — an itemised screen with no headline can still be dated')
{
  const pp = parsePayPalHistoryCsv(PP_CSV)
  // The screen must describe THIS ledger, or the dating engine is right to refuse
  // and the test proves nothing. Built from the parse so the two cannot drift:
  // after both payments, $150,654.37 of principal and $20,081.33 of fee are owed.
  const owedPrincipal = pp.origination!.loan_amount! - pp.totals!.principal_paid
  const owedFee = pp.origination!.fixed_fee! - pp.totals!.fee_paid
  const owedTotal = Math.round((owedPrincipal + owedFee) * 100) / 100
  const ledgerScreen = (over: Record<string, unknown> = {}) => ppScreen({
    principal_balance: owedPrincipal, fee_balance: owedFee, total_balance: owedTotal,
    lender_balance_net_principal: owedPrincipal, lender_balance_gross_payback: owedTotal,
    ...over,
  })
  const base = ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_name: 'Paypal 2',
            lender_account_number: 'A00845102', original_amount: 177500, xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, ledgerTermsSource: 'Paypal Loan.csv',
    csv: pp as any, csvCoversFromOrigination: true,
    documents: [{ filename: 'Paypal Loan.csv', kind: 'transaction_history', sha256: 'abc' },
                { filename: 'Paypal today.png', kind: 'balance_screenshot', sha256: 'def' }] as any,
    statements: [sweep('2026-08-26', 153834.70, 'principal_only')],
    portal: ledgerScreen(),
  } as any)
  const plan = buildPlan(base)
  const dating = (plan as any).portal_dating ?? null

  // The anchor action is the observable proof the date was established: it is
  // blocked without one and offered with one.
  const anchor = of(plan, 'record_lender_balance')
  ok('the lender-balance row is proposed at all', !!anchor, JSON.stringify(plan.actions.map(a => a.kind)))
  ok('and it is NOT blocked for want of a date',
     !!anchor && !(anchor as any).blocked_reason,
     String((anchor as any)?.blocked_reason || '').slice(0, 160))
  ok('the date measured off the ledger is 2026-09-02',
     JSON.stringify(anchor?.payload || {}).includes('2026-09-02'),
     JSON.stringify(anchor?.payload))

  // DISCRIMINATION: strip the itemised figures and the row must go back to being
  // blocked — proving the fix is what carries it, not something else in the ctx.
  const noItems = buildPlan(ctxOf({ ...base,
    portal: ledgerScreen({ principal_balance: null, fee_balance: null, total_balance: null,
                       lender_balance_net_principal: null, lender_balance_gross_payback: null,
                       corroborated: [] }) } as any))
  ok('without the itemised figures there is no anchor to propose',
     !of(noItems, 'record_lender_balance'))
}

section('B — the balance is compared on the basis the books actually carry')
{
  const pp = parsePayPalHistoryCsv(PP_CSV)
  const mk = (bookBal: number, basis: string) => buildPlan(ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_name: 'Paypal 2',
            lender_account_number: 'A00845102', original_amount: 177500, xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, csv: pp as any,
    documents: [], statements: [sweep('2026-09-02', bookBal, basis)],
    portal: ppScreen({ as_of: '2026-09-02' }),
  } as any))

  // Principal-only books agree with the PRINCIPAL line, not the total.
  const net = mk(46144.59, 'principal_only')
  ok('a principal-only book balance ties to the principal line',
     net.corroborations.some(c => /agree on the balance/.test(c.statement) && /principal only/.test(c.statement)),
     JSON.stringify(net.corroborations.map(c => c.statement)).slice(0, 300))

  // The SAME book figure against a payoff-basis book row must NOT tie — that is
  // the comparison the old code made, and it is off by the unearned fee.
  const grossBooks = mk(47806.14, 'total_payback')
  ok('a payoff-basis book balance ties to the total instead',
     grossBooks.corroborations.some(c => /agree on the balance/.test(c.statement) && /whole payback/.test(c.statement)))

  // THE BUG, PINNED: comparing a principal-only book row against the gross figure
  // produces exactly the unearned fee as a phantom gap. It must not happen.
  const wrong = mk(46144.59, 'principal_only')
  ok('no phantom gap equal to the unearned fee is reported',
     !JSON.stringify(wrong.conflicts).includes('1,661.55'),
     JSON.stringify(wrong.conflicts).slice(0, 300))

  // An unlabelled book balance is not compared to anything — it is asked about.
  const unknown = mk(46144.59, 'unknown')
  ok('an unlabelled book balance raises a question rather than a comparison',
     unknown.unresolved.some(u => /Which balance should the lender's screen be compared against/.test(u.question)),
     JSON.stringify(unknown.unresolved.map(u => u.question)))
  ok('...and no books-vs-lender conflict is raised off it',
     !unknown.conflicts.some(c => c.key === 'books_vs_lender'))
}

section('C — the loan record is checked against terms from ANY lender document')
{
  const pp = parsePayPalHistoryCsv(PP_CSV)
  const plan = buildPlan(ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_name: 'Paypal 2',
            lender_account_number: 'A00845102', original_amount: 177500, original_date: null,
            xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, csv: pp as any,
    documents: [], statements: [], portal: null,
  } as any))

  const amt = plan.conflicts.find(c => c.key === 'term_original_amount')
  ok('the typed original amount is challenged with no agreement present', !!amt,
     JSON.stringify(plan.conflicts.map(c => c.key)))
  ok('...and BOTH lender figures are named', !!amt &&
     /157,000\.00 advanced/.test(amt.expected) && /177,565\.12 repaid/.test(amt.expected), amt?.expected)
  ok('...and the $65.12 is stated', !!amt && /\$65\.12/.test(amt.caveat || ''), amt?.caveat)
  ok('...and NO write is proposed for it, because choosing is the basis question',
     !plan.actions.some(a => a.kind === 'apply_term_to_loan' && (a.payload as any)?.field === 'original_amount'))

  // The origination date IS unambiguous, so that one does get an action.
  const dateAct = plan.actions.find(a => a.kind === 'apply_term_to_loan' && (a.payload as any)?.field === 'original_date')
  ok('the blank origination date is offered from the ledger', !!dateAct, JSON.stringify(plan.actions.map(a => a.title)))
  ok('...and the row names the transaction history, not an agreement',
     !!dateAct && /transaction history/.test(dateAct.plain_english), dateAct?.plain_english)

  // A record that already matches one basis is corroborated, not challenged.
  const right = buildPlan(ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', original_amount: 177565.12, xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, csv: pp as any,
    documents: [], statements: [], portal: null,
  } as any))
  ok('a record matching the gross figure is corroborated instead',
     !right.conflicts.some(c => c.key === 'term_original_amount') &&
     right.corroborations.some(c => /whole payback, fee included/.test(c.statement)),
     JSON.stringify(right.corroborations.map(c => c.statement)).slice(0, 260))
}

section('E — the basis card says which shape was tried and by how much it missed')
{
  // The balance must be one the check is ALLOWED to look at, and unlabelled, or
  // it never reaches the two-model comparison this card describes. Updated with
  // Tech Debt #34 rather than left to go red on deploy for a reason that is not
  // a bug — the figures are PayPal 2's real ones, now as a book row.
  const drift = detectCarryingBasisDrift({
    loan_id: 'x', loan_label: 'Paypal 2', recorded_basis: 'unknown',
    terms: { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177565.12 },
    balances: [{ statement_date: '2026-08-05', principal_balance: 58775.97,
                 balance_basis: 'unknown', source: 'xero_derived' }],
    splits: [{ period_label: '2026-08-05', principal_amount: 117058.53, interest_amount: -958.39, total_amount: 116100.14 }],
  } as any)
  ok('a book balance matching neither model still comes back fits_neither',
     drift.verdict === 'fits_neither', drift.verdict)

  const expected = describeBasisMiss(drift.fits)
  ok('the placeholder is gone', !/one of the expected shapes/.test(expected), expected)
  ok('each model names its prediction', /would put it at/.test(expected), expected)
  ok('the gross miss is the unearned fee, and it is printed',
     /-\$2,689\.01/.test(expected), expected)
  ok('the net miss is printed too', /\$18,834\.50/.test(expected), expected)
  ok('money is formatted, not raw', !/61464\.98/.test(expected) && /\$61,464\.98/.test(expected), expected)

  const found = describeBasisObserved(drift.fits, '2026-08-05')
  ok('the observed balance is money-formatted', /\$58,775\.97/.test(found), found)
  ok('...and names the day it speaks for', /at 2026-08-05/.test(found), found)

  // When a model DOES fit, the old wording is what should appear.
  const fitting = describeBasisMiss([
    { basis: 'gross_payback', predicted: 1, observed: 1, difference: 0, fits: true, means: 'the fee sits inside the balance' } as any,
    { basis: 'net_principal', predicted: 9, observed: 1, difference: -8, fits: false, means: 'nope' } as any,
  ])
  ok('a fitting model is described by what it MEANS, not by its miss',
     fitting === 'the fee sits inside the balance', fitting)
  ok('nothing to predict from is said plainly',
     /opening figures are not on file/.test(describeBasisMiss([])))
}



section('§5 — whose balance is "your books", and is it the same day (cont. 4)')
{
  // A LEDGER THAT COVERS THE WINDOW THESE ASSERTIONS TALK ABOUT. The two-payment
  // PP_CSV above starts 2026-08-26, so a book balance dated 2026-08-12 legitimately
  // predates it and every roll-forward here would be refused — correctly, and while
  // proving nothing. Real August figures, real origination rows.
  const PP_CSV_AUG = [
    'Date,Description,Amount,Principal,Fee,Other',
    '09/02/2026,Auto Draft Payment,"-$3,414.71","-$3,180.33","-$234.38","$0.00"',
    '08/26/2026,Auto Draft Payment,"-$3,414.71","-$3,165.30","-$249.41","$0.00"',
    '08/19/2026,Auto Draft Payment,"-$3,414.71","-$3,150.32","-$264.39","$0.00"',
    '08/12/2026,Auto Draft Payment,"-$3,414.71","-$3,135.43","-$279.28","$0.00"',
    '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
    '12/10/2025,Total Loan Fee,"$20,565.12","$0.00","$20,565.12","$0.00"',
  ].join('\n')
  const pp = parsePayPalHistoryCsv(PP_CSV_AUG)
  const lenderRow = (d: string, bal: number) =>
    ({ statement_date: d, principal_balance: bal, balance_basis: 'principal_only', source: 'portal_manual_pull' })
  const bookRow = (d: string, bal: number, basis = 'principal_only') =>
    ({ statement_date: d, principal_balance: bal, balance_basis: basis, source: 'xero_derived' })

  const mk = (statements: any[], over: any = {}) => buildPlan(ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_name: 'Paypal 2',
            lender_account_number: 'A00845102', original_amount: 177565.12, xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, csv: pp as any, csvCoversFromOrigination: true,
    documents: [], statements,
    portal: ppScreen({ as_of: '2026-09-02' }),
    ...over,
  } as any))

  // ── THE LIVE FALSE ALARM, PINNED ──────────────────────────────────────
  // Every row on this loan is a lender pull. The old code took the newest one,
  // called it "your books", and reported $12,631.38 — which is exactly the four
  // payments between 2026-08-05 and 2026-09-02, to the cent.
  const lenderOnly = mk([lenderRow('2026-07-29', 61896.57), lenderRow('2026-08-05', 58775.97)])
  ok('a lender row is never "your books"',
     !lenderOnly.conflicts.some(c => c.key === 'balance_vs_lender' || c.key === 'balance_vs_lender_unconfirmed'),
     JSON.stringify(lenderOnly.conflicts.map(c => c.key)))
  ok('...and specifically the $12,631.38 phantom is gone',
     !JSON.stringify(lenderOnly.conflicts).includes('12,631.38'))
  ok('...replaced by a question naming what is missing',
     lenderOnly.unresolved.some(u => /Do your books agree with the lender/.test(u.question) &&
                                     /rebuilt from your own ledger/.test(u.what_would_answer_it)),
     JSON.stringify(lenderOnly.unresolved.map(u => u.question)))

  // ── SAME DAY, BOOK-SOURCED: compares exactly as before ────────────────
  const sameDay = mk([bookRow('2026-09-02', 46144.59)])
  ok('a same-dated book balance ties to the lender',
     sameDay.corroborations.some(c => /agree on the balance/.test(c.statement)),
     JSON.stringify(sameDay.corroborations.map(c => c.statement)).slice(0, 200))
  ok('...and no conflict is raised', !sameDay.conflicts.some(c => c.key === 'balance_vs_lender'))

  // A real disagreement on the same day must STILL be reported.
  const realGap = mk([bookRow('2026-09-02', 50000)])
  ok('a genuine same-day gap is still raised',
     realGap.conflicts.some(c => c.key === 'balance_vs_lender' || c.key === 'balance_vs_lender_unconfirmed'),
     JSON.stringify(realGap.conflicts.map(c => c.key)))

  // ── DIFFERENT DAYS, EXPORT COVERS: roll forward and tie ───────────────
  // The book balance is the truth at 2026-08-12; the lender's is at 2026-09-02.
  // The ledger took 3,150.32 + 3,165.30 + 3,180.33 = 9,495.95 of principal in
  // between, which brings 55,640.54 to 46,144.59 — the lender's figure exactly.
  const rolled = mk([bookRow('2026-08-12', 55640.54)])
  ok('a book balance on an earlier day is rolled forward and ties',
     rolled.corroborations.some(c => /agree on the balance/.test(c.statement)),
     JSON.stringify(rolled.corroborations.map(c => c.statement)).slice(0, 320))
  ok('...and the roll-forward shows its working',
     rolled.corroborations.some(c => /Between those days the lender's own ledger took/.test(c.statement)))
  ok('...and no phantom gap is raised', !rolled.conflicts.some(c => c.key === 'balance_vs_lender'))

  // THE ROLL CAN ONLY REDUCE A CLAIM: a residual after rolling is still reported.
  const residual = mk([bookRow('2026-08-12', 56640.54)])
  ok('a residual after rolling forward is still a real gap',
     residual.conflicts.some(c => c.key === 'balance_vs_lender' || c.key === 'balance_vs_lender_unconfirmed'),
     JSON.stringify(residual.conflicts.map(c => c.key)))
  // The figure compared is the ROLLED one. Raw would be $56,640.54 and the gap
  // would read $10,495.95 — the residual plus the payments, which is the bug.
  ok('...and it is the ROLLED figure that is compared, not the raw one',
     residual.conflicts.some(c => /lender/.test(c.key) && /47,144\.59/.test(String(c.found)) &&
                                  /rolled to 2026-09-02/.test(String(c.found))),
     JSON.stringify(residual.conflicts.map(c => c.found)))

  // ── DIFFERENT DAYS, NO EXPORT COVERING THE WINDOW: no verdict ─────────
  const uncovered = mk([bookRow('2026-01-05', 120000)], { csv: null })
  ok('two different days with no export reaches no verdict',
     !uncovered.conflicts.some(c => c.key === 'balance_vs_lender'),
     JSON.stringify(uncovered.conflicts.map(c => c.key)))
  ok('...and asks for the thing that would settle it',
     uncovered.unresolved.some(u => /balance is dated 2026-01-05 and the lender's is dated 2026-09-02/.test(u.why_it_matters)),
     JSON.stringify(uncovered.unresolved.map(u => u.why_it_matters)).slice(0, 260))

  // A gross-basis book row must be rolled by the TOTAL taken, not the principal.
  const grossRolled = mk([bookRow('2026-08-12', 57000, 'total_payback')])
  // 57,000 less the TOTAL taken (3 x 3,414.71 = 10,244.13) is 46,755.87.
  // Rolled by the principal instead it would be 47,504.05 — a different number,
  // so this assertion actually discriminates between the two quantities.
  ok('a payoff-basis book row is rolled by the total, not the principal',
     grossRolled.conflicts.some(c => /lender/.test(c.key) && /46,755\.87/.test(String(c.found))),
     JSON.stringify(grossRolled.conflicts.map(c => c.found)))
  ok('...and it is compared against the lender GROSS balance',
     grossRolled.conflicts.some(c => /lender/.test(c.key) && /47,806\.14/.test(String(c.expected))),
     JSON.stringify(grossRolled.conflicts.map(c => c.expected)))
}

section('the itemised screen is not described by the paid identity (cont. 4)')
{
  const pp = parsePayPalHistoryCsv(PP_CSV)
  const plan = buildPlan(ctxOf({
    loan: { ...ctxOf().loan, id: 'loan-pp', lender: 'PayPal', xero_account_code: '284' },
    agreementTerms: [], ledgerTerms: pp.terms as any, csv: pp as any, csvCoversFromOrigination: true,
    documents: [], statements: [],
    portal: ppScreen({ as_of: '2026-09-02' }),
  } as any))
  const anchor = of(plan, 'record_lender_balance')
  const text = JSON.stringify(anchor || {})
  ok('the anchor is proposed', !!anchor)
  ok('it does NOT claim the screen states total-due-less-paid',
     !/total due less the amount paid to date/.test(text), text.slice(0, 200))
  ok('it describes what this screen actually prints',
     /two lines add up/.test(text), text.slice(0, 260))
}


console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
