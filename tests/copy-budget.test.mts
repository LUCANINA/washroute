// tests/copy-budget.test.mts — THE CARD IS THE DECISION, NOT THE EVIDENCE.
//
// An action card is read by someone deciding whether to tick a box, against the
// clock. The visible text gets a word budget; the working moves behind a
// disclosure where it stays complete. Nothing is deleted — see the rule in
// PROJECT-NOTES-BOOKKEEPING.md.
//
// This measures the RENDERED string, not the source literal, because the worst
// offenders are assembled at render time from four or five fragments and each
// fragment looks reasonable on its own. The 247-word lender-balance card was
// built from pieces none of which exceeded 90 words.
//
// Run:  npx tsx tests/copy-budget.test.mts

import { buildPlan, type PlanContext, type BundlePlan } from '../supabase/functions/_shared/loan-bundle-plan.ts'
import { parsePayPalHistoryCsv } from '../supabase/functions/_shared/paypal-history.ts'
import { diagnoseWorkedEntry } from '../supabase/functions/loan-find-difference/diagnose-exception.ts'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

export const WORD_BUDGET = 40
const words = (s: string) => String(s || '').trim().split(/\s+/).filter(Boolean).length

const PP_CSV = [
  'Date,Description,Amount,Principal,Fee,Other',
  '09/02/2026,Auto Draft Payment,"-$3,414.71","-$3,180.33","-$234.38","$0.00"',
  '08/26/2026,Auto Draft Payment,"-$3,414.71","-$3,165.30","-$249.41","$0.00"',
  '08/19/2026,Auto Draft Payment,"-$3,414.71","-$3,150.32","-$264.39","$0.00"',
  '08/12/2026,Auto Draft Payment,"-$3,414.71","-$3,135.43","-$279.28","$0.00"',
  '12/10/2025,Wire,"$157,000.00","$157,000.00","$0.00","$0.00"',
  '12/10/2025,Total Loan Fee,"$20,565.12","$0.00","$20,565.12","$0.00"',
].join('\n')
const pp = parsePayPalHistoryCsv(PP_CSV)

const term = (k: string, o: any = {}) => ({ term_key: k, value_numeric: o.n ?? null, value_date: o.d ?? null,
  value_text: o.t ?? null, source_text: 'x', basis: 'x', confidence: 'high' })
const AGREEMENT: any[] = [
  term('loan_amount', { n: 125000 }), term('fixed_fee', { n: 20875 }),
  term('total_repayment_amount', { n: 145875 }), term('origination_date', { d: '2026-06-30' }),
  term('final_repayment_date', { d: '2027-12-29' }),
]
const row = (d: string, bal: number, basis = 'principal_only', source = 'xero_derived') =>
  ({ statement_date: d, principal_balance: bal, balance_basis: basis, source })

const screen = (o: any = {}) => ({
  as_of: null, amount_remaining: null, paid_to_date: null, principal_paid: null,
  fee_paid: null, total_amount_due: null, funds_deposited: null, funds_deposited_date: null,
  principal_balance: 46144.59, fee_balance: 1661.55, total_balance: 47806.14,
  amount_remaining_basis: null,
  lender_balance_net_principal: 46144.59, lender_balance_gross_payback: 47806.14,
  lender_account_ref: 'A00845102',
  corroborated: ['principal_balance', 'fee_balance', 'total_balance'], ...o,
})

const ctx = (o: any = {}): PlanContext => ({
  loan: { id: 'l', lender: 'PayPal', xero_account_name: 'Paypal 2', lender_account_number: 'A00845102',
          carrying_basis: 'unknown', original_amount: 177500, original_date: null, maturity_date: null,
          interest_rate: null, scheduled_monthly_payment: null, structure_note: null, xero_account_code: '284' },
  documents: [{ filename: 'Paypal Loan.csv', kind: 'transaction_history', sha256: 'a' },
              { filename: 'Paypal today.png', kind: 'balance_screenshot', sha256: 'b' }],
  agreementTerms: [], agreementChecks: [], agreementUnresolved: [],
  ledgerTerms: pp.terms, csv: pp, csvCoversFromOrigination: true,
  feeSearch: null, decomposition: null, portal: screen(),
  statements: [], splits: [], closeDate: null, todayPacific: '2026-09-03',
  ...o,
} as any)

// A spread wide enough that every action builder is exercised at least once.
const PLANS: { name: string; plan: BundlePlan }[] = [
  { name: 'paypal, no book balance', plan: buildPlan(ctx()) },
  { name: 'paypal, book balance same day', plan: buildPlan(ctx({ statements: [row('2026-09-02', 46144.59)] })) },
  { name: 'paypal, book balance earlier', plan: buildPlan(ctx({ statements: [row('2026-08-12', 55640.54)] })) },
  { name: 'paypal, real gap', plan: buildPlan(ctx({ statements: [row('2026-09-02', 50000)] })) },
  { name: 'with an agreement', plan: buildPlan(ctx({ agreementTerms: AGREEMENT,
      documents: [{ filename: 'a.pdf', kind: 'agreement', sha256: 'c' }] })) },
  { name: 'screen with a date', plan: buildPlan(ctx({ portal: screen({ as_of: '2026-09-02' }),
      statements: [row('2026-09-02', 46144.59)] })) },
  { name: 'no csv at all', plan: buildPlan(ctx({ csv: null, csvCoversFromOrigination: false })) },
  { name: 'terms in conflict', plan: buildPlan(ctx({ agreementTerms: AGREEMENT, termConflicts: ['loan_amount: 125000 vs 157000'] })) },
]

section(`every action card fits ${WORD_BUDGET} words`)
{
  const over: string[] = []
  let counted = 0
  for (const { name, plan } of PLANS) {
    for (const a of plan.actions) {
      counted++
      const n = words(a.plain_english)
      if (n > WORD_BUDGET) over.push(`${n}w  ${a.kind} (${name}): ${String(a.plain_english).slice(0, 90)}…`)
    }
  }
  ok(`${counted} action cards measured`, counted > 0)
  ok('none exceeds the budget', over.length === 0, '\n      ' + over.join('\n      '))
}

section('the first sentence says what will be written')
{
  // An ALLOWLIST, so an action that writes a figure cannot quietly join the
  // exemption. `attach_document` files a named file and writes no figure at all;
  // its title carries the filename, which is the whole of what it does.
  const WRITES_NO_FIGURE = ['attach_document']
  const bad: string[] = []
  for (const { name, plan } of PLANS) {
    for (const a of plan.actions) {
      if (WRITES_NO_FIGURE.includes(a.kind)) continue
      const first = String(a.plain_english || '').split(/(?<=[.!?])\s/)[0] || ''
      // A card that makes you read to sentence three to learn what it writes has
      // failed even inside the budget. A figure, a date, or a count.
      if (!/\$[\d,]+\.\d{2}|\d{4}-\d{2}-\d{2}|\b\d+\b/.test(first)) bad.push(`${a.kind} (${name}): ${first.slice(0, 80)}`)
    }
  }
  ok('every card names its figure, date or count up front', bad.length === 0, '\n      ' + bad.join('\n      '))
}

section('the working is relocated, never deleted')
{
  // The whole rule rests on this. A card that trimmed its evidence rather than
  // moving it is a lie, not a trim — session 250's ce17 limit, applied to length.
  const trimmed = PLANS.flatMap(p => p.plan.actions).filter(a => (a as any).working)
  ok('some cards carry a working section', trimmed.length > 0, String(trimmed.length))
  for (const a of trimmed.slice(0, 3)) {
    ok(`${a.kind}'s working is substantive`, words((a as any).working) > 20,
       String(words((a as any).working)))
  }
}

section('questions and conflicts are read at the same speed')
{
  const overQ: string[] = []
  for (const { name, plan } of PLANS) {
    for (const u of plan.unresolved) {
      if (words(u.why_it_matters) > WORD_BUDGET) overQ.push(`${words(u.why_it_matters)}w why_it_matters (${name}): ${u.question.slice(0, 60)}`)
      if (words(u.what_would_answer_it) > WORD_BUDGET) overQ.push(`${words(u.what_would_answer_it)}w what_would_answer_it (${name}): ${u.question.slice(0, 60)}`)
    }
    for (const c of plan.conflicts) {
      if (c.caveat && words(c.caveat) > WORD_BUDGET) overQ.push(`${words(c.caveat)}w caveat (${name}): ${String(c.statement).slice(0, 60)}`)
    }
  }
  ok('no question or caveat exceeds the budget', overQ.length === 0, '\n      ' + overQ.join('\n      '))
}


// ─────────────────────────────────────────────────────────────────────────────
// The same rule, on the dashboard's own surfaces.
//
// The bundle expresses it as a 40-word budget with `working` behind a
// disclosure. The Overview queue expresses it as `_bkOneLine()` plus a
// `detailHtml` expander, which is the same rule with a character cap — it got
// there first, in session 249, and it is why the Issues page reads well while
// the bundle modal did not. What matters is that neither surface can quietly
// start rendering a paragraph.
//
// Source-text assertions, like tests/transcriber-instructions: the dashboard
// cannot be imported here, and the defect is structural rather than behavioural.
// ─────────────────────────────────────────────────────────────────────────────
section('the queue rows stay one line, with the rest one click away')
{
  const dash = readFileSync(new URL('../admin-dashboard/index.html', import.meta.url), 'utf8')

  // Every queue summary is either passed through the truncator or authored
  // short. A bare `explain: f.plain_english` is the exact shape that drops a
  // paragraph into a row, and it is the one this asserts against — scoped to
  // `explain:` rather than every `reason:` in a 3 MB file, because the blunt
  // version matched an RPC payload and a diagnostic and proved nothing.
  const explains = [...dash.matchAll(/\bexplain:\s*([^\n]+)/g)].map(m => m[1].trim())
  const untruncated = explains.filter(v =>
    !/^_bkOneLine\(/.test(v) && !/^[`'"]/.test(v) && !/\?/.test(v))
  ok('no queue row assigns an untruncated variable to `explain`',
     untruncated.length === 0, untruncated.join(' | '))

  // And the authored ones obey the same budget the bundle does.
  const authored = explains
    .filter(v => /^`/.test(v))
    .map(v => v.replace(/\$\{[^}]*\}/g, ' X ').replace(/[`,]/g, ''))
    .filter(v => words(v) > WORD_BUDGET)
  ok('authored queue summaries fit the budget too',
     authored.length === 0, authored.map(a => `${words(a)}w ${a.slice(0, 70)}`).join(' | '))

  // The truncator's cap is the queue's expression of the budget. If someone
  // raises it, this says so rather than letting rows quietly grow.
  const cap = dash.match(/maxLen\s*=\s*maxLen\s*\|\|\s*(\d+)/)?.[1]
  ok('the one-line cap is still 130 characters', cap === '130', String(cap))

  // And the full text must still be reachable. A truncated row with nowhere to
  // expand is the failure this whole rule exists to avoid.
  ok('the queue still carries a detail expander', /detailHtml/.test(dash))

  // The bundle modal must actually render `working`, on all three surfaces that
  // carry it. A field written and never rendered is evidence deleted.
  ok('actions render their working', /\$\{working\(a\.working\)\}/.test(dash))
  ok('questions render their working', /\$\{working\(u\.working\)\}/.test(dash))
  ok('conflicts render their working', /c\.working \?/.test(dash))
  ok('...behind a real disclosure, not a paragraph', /<details/.test(dash) && /Show the working/.test(dash))

  // AND IT MUST BE DECLARED BEFORE IT IS CALLED (session 263 cont. 6, found live).
  //
  // `const` is block-scoped and hoisted into a temporal dead zone, so calling the
  // helper from a `.map()` that runs EARLIER in the same function does not read
  // undefined — it throws. On this surface that means the modal spins forever
  // while the edge function has already returned a perfectly good plan. David sat
  // through it; the row was in `intake_bundles` the whole time.
  //
  // The three "does it render" assertions above passed on the broken build,
  // because they prove the code is THERE, not that it RUNS. That is the standing
  // limitation of a source-text assertion, and this is the cheapest thing that
  // closes it without a browser.
  const declAt = dash.indexOf('const working = (w, label)')
  const calls = [...dash.matchAll(/\$\{working\(/g)].map(m => m.index ?? -1)
  ok('the working helper is declared', declAt > -1)
  ok('...before every call site', calls.length > 0 && calls.every(i => i > declAt),
     `declared at ${declAt}, calls at ${calls.join(', ')}`)
}


// ─────────────────────────────────────────────────────────────────────────────
// ── session 279: A CLAIM IS STATED ONCE PER SCREEN ──────────────────────────
//
// David ran "find the difference" on E-Transit 4140 and got a card that was
// correct, thorough, and 420 visible words. Nothing in it was over-written:
// four sections had each been authored to stand alone, so each restated the
// whole diagnosis. Every figure appeared at least twice; $415.88 and the three
// month labels appeared FIVE times each. The 40-word budget above cannot see
// that, because it measures ONE card and this screen was four in-budget cards
// saying the same thing.
//
// The rendered measurement lives in tests/bookkeeping-harness.mjs, group
// `fdiff-copy-budget` — it needs a DOM, because "visible" means "not inside a
// <details>". What belongs HERE is the half that can be checked against the
// real generators: the exception note, produced by the real function, and the
// bullet templates, read out of the real source. The harness transcribes those
// sentences into a fixture; these assertions are what stop that transcription
// drifting away from the code (s245: a test that transcribes is not a test —
// so the transcription has to be pinned to something that is not a copy).
// ─────────────────────────────────────────────────────────────────────────────
section('the exception note states the decision, and relocates the rest')
{
  const d = diagnoseWorkedEntry({
    lines: [{ c: '242', a: 764.44 }, { c: '800', a: 415.88 }],
    loanCode: '242', interestCode: '800', paymentPeriod: '2026-06',
    loanName: 'E-Transit Loan - 4140', gap: 283.07,
    postingDate: '2026-09-30', postingWhy: 'books are closed through 2026-06-30',
    ownJournalInSpan: false,
    splits: [
      { period_label: '2026-04', interest_amount: 147.43, status: 'posted', xero_manual_journal_id: '31ad48e9-43fb-4d38-9b88-44006c53c2b8' },
      { period_label: '2026-05', interest_amount: 135.64, status: 'posted', xero_manual_journal_id: '7ce60981-76f6-4824-bdf4-64203ad78021' },
      { period_label: '2026-06', interest_amount: 132.81, status: 'posted', xero_manual_journal_id: '12ef542c-17d5-4f4f-b108-185d8ac1f441' },
    ] as any,
  } as any)

  ok('the 4140 shape still diagnoses as a duplicated reallocation',
     d.shape === 'duplicated_reallocation' || d.shape === 'partly_duplicated', d.shape)
  ok('the visible note fits the budget',
     words(d.note) <= WORD_BUDGET, `${words(d.note)}w: ${d.note}`)

  // NOTHING IS DELETED — the ce17 limit. Each of these left the visible note in
  // session 279 and has to be somewhere: in `note_working`, or on a surface the
  // client renders beside it. The first three are the working's job; the rest
  // are asserted where they landed, by the harness group.
  for (const claim of ['$147.43', '$135.64', '$132.81', '31ad48e9', '7ce60981', '12ef542c', '$132.81 that this period actually owes']) {
    ok(`...and "${claim}" survives in the working`, d.note_working.includes(claim))
  }
  ok('the working actually has content to show', words(d.note_working) > 20)

  // And the note does not re-state what sits directly beneath it: the split
  // figure is the table footer's, the journal ids are the table's own column,
  // the date and its reason are the prepared block's.
  ok('the note does not repeat the journal ids', !/31ad48e9|7ce60981|12ef542c/.test(d.note))
  ok('the note does not repeat the posting date', !d.note.includes('2026-09-30'))
  ok('the note does not repeat "her entry is not touched"',
     !/entry (stays|is not touched)/i.test(d.note), d.note)
}

section('the conclusion bullets no longer restate the table below them')
{
  const src = readFileSync(new URL('../supabase/functions/loan-find-difference/index.ts', import.meta.url), 'utf8')

  // The exception bullet used to spell out the month list and the at-source
  // figure — both of which are the exception table, a few centimetres down.
  ok('the exception bullet no longer lists the months',
     !src.includes("comps.map((c: any) => c.period).join(' + ')"))
  ok('...nor repeats the at-source figure',
     !src.includes('interest (${money(dg.at_source)})'))

  // The closed-books sentence is the span table's own fold summary now. It must
  // still SHIP — in no_action_detail — or the cut deleted a claim.
  ok('the closed-books sentence is still built', src.includes('has already settled those months'))
  ok('...and is excluded from the visible bullets by index, not by position',
     src.includes('noAction.filter((_, i) => i !== closedCarriedByFold)'))
  ok('...and still ships in no_action_detail', /no_action_detail:\s*noActionDetail/.test(src)
     || src.includes('noActionDetail'))

  // The harness fixture transcribes these sentences. If a template changes and
  // nobody updates the fixture, the harness measures a card that no longer
  // exists — so pin the shapes the fixture depends on.
  const harness = readFileSync(new URL('./bookkeeping-harness.mjs', import.meta.url), 'utf8')
  ok('the harness fixture still quotes the focus-tie sentence the source builds',
     src.includes('ties to the cent.`)') &&
     harness.includes('Every span in August 2026 ties to the cent.'))
  ok('the harness fixture still quotes the approve sentence the source builds',
     src.includes('Approve the prepared ${money(cpaException.proposed_entry.amount)} correction below') &&
     harness.includes('Approve the prepared $415.88 correction below'))
}


console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
