// tests/derive-anchor.test.mts — WHICH STATEMENT MAY ANCHOR A PROJECTION
//
// Run:  npx tsx tests/derive-anchor.test.mts
//
// Session 274. Three defects, one root cause, and two of the three were found by
// RUNNING the code rather than reading it — which is why they are written down as
// assertions and not as a comment.
//
//   1. derive-schedule chose its anchor with a DENYLIST (`!== 'total_payback'`)
//      and never applied `statement_date_basis`. `loan-find-difference` had both
//      rules already. Same logic, missing from the other branch — session 231.
//   2. The first fix filtered the stated PAYMENT by balance_basis too, and made
//      Funding Circle refuse outright. Two questions, one filter.
//   3. A re-dated month-end anchor tripped projectRows' minimum-gap guard and
//      dropped September from the schedule entirely — silently, into a schedule
//      whose rows get staged in Xero.
//
// EVERY assertion is paired with a DISCRIMINATION check: the pre-fix rule is run
// against the same fixture and asserted to give a DIFFERENT (wrong) answer. An
// assertion that passes against both the fixed and the broken code is decoration
// (session 245), and the transcription trap is the specific reason this file
// imports the shipped functions instead of restating them.
//
// 🧊 THE FIXTURE IS FROZEN. tests/fixtures/derive-anchor-2026-09-05.json is real
// production data pulled 2026-09-05 and must not be re-pulled: its subject is the
// state that exposed the bug. Re-pinning it to today's numbers turns a proof into
// a transcript.

import { readFileSync } from 'node:fs'
import { selectAnchorEvidence, deriveSchedule } from '../supabase/functions/_shared/derive-schedule.ts'
import {
  collapseDuplicateBalances, buildPeriods, classifyPeriods, chooseFit, projectRows,
  recurringPayment, statedPayment, medianDayOfMonth, paymentDayOfMonth,
} from '../supabase/functions/_shared/rate-fit.ts'
import { normalizeBasis } from '../supabase/functions/_shared/statement-period.ts'

const TODAY = '2026-09-05'
const fx = JSON.parse(readFileSync(new URL('./fixtures/derive-anchor-2026-09-05.json', import.meta.url), 'utf8'))

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const eq = (name: string, actual: any, expected: any) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)

const loan = (n: string) => {
  const l = fx.loans.find((x: any) => x.name === n)
  if (!l) throw new Error(`fixture has no loan "${n}"`)
  return l
}
const rowsOf = (l: any) => l.s.map((r: any[]) => ({
  statement_date: r[0], principal_balance: r[1], total_amount_due: r[2], balance_basis: r[3],
}))

// The rule as it stood BEFORE this change, kept here only to prove the new one
// differs. It is deliberately the old code's shape, not a re-statement of the new.
//
// ⚠ AND IT WAS WRONG ON ITS FIRST WRITING, WHICH IS WORTH KEEPING. The first
// version wrapped this in collapseDuplicateBalances(). The old code did call that
// — but into `stmts`, which feeds the RATE FIT, while the anchor was taken from
// the uncollapsed `usable`. Collapsing here made the pre-fix rule look like it
// already picked 2026-08-17 on 4140, i.e. made the defect look absent, and sent
// E4-9744's anchor back to a $5,000 lump payment in May. A discrimination check
// that mis-states the old behaviour proves nothing in either direction, and the
// only reason it surfaced is that the three CONTROL loans are asserted to agree
// with the old rule as well as the new one. Controls earn their keep here.
const preFixAnchors = (raw: any[]) =>
  raw.filter(s => s.balance_basis !== 'total_payback' && s.statement_date <= TODAY)

console.log('\n🧊 fixture')
eq('frozen at its pull date', fx._meta.pulled_at, '2026-09-05')
ok('covers all seven derived-schedule loans', fx.loans.length === 7)

// ── 1. THE ANCHOR ──────────────────────────────────────────────────────────
console.log('\n1. which statement anchors the projection')
{
  const fc = loan('Funding Circle Loan'), raw = rowsOf(fc)
  const { usable, skippedForBasis } = selectAnchorEvidence(raw, fc.basis, TODAY)
  const last: any = usable[usable.length - 1]
  eq('FC anchors on the labelled month-end balance', Number(last.principal_balance), 65173.94)
  eq('FC anchor is dated when its balance is TRUE', last.statement_date, '2026-08-31')
  eq('FC anchor keeps the date the DOCUMENT carries', last.filed_date, '2026-08-01')
  ok('FC names the unlabelled row it refused to anchor on',
    skippedForBasis.some((s: any) => s.date === '2026-08-03' && s.basis === 'unknown'))

  // DISCRIMINATION: the pre-fix rule picks the mid-month pull, one month stale.
  const before: any = preFixAnchors(raw).slice(-1)[0]
  eq('pre-fix rule anchored on the unlabelled mid-month pull', before.statement_date, '2026-08-03')
  ok('...carrying a balance one whole payment stale',
    Math.abs(Number(before.principal_balance) - Number(last.principal_balance) - 1041.09) < 0.005,
    `${before.principal_balance} vs ${last.principal_balance}`)
}
{
  // The same defect on a balance_date loan: an unlabelled duplicate pull 11 days
  // late shortens the first accrual window rather than shifting the month.
  const f = loan('E-Transit Loan - 4140'), raw = rowsOf(f)
  const { usable } = selectAnchorEvidence(raw, f.basis, TODAY)
  const last: any = usable[usable.length - 1]
  eq('4140 anchors on its labelled statement', last.statement_date, '2026-08-17')
  eq('...at the same balance the unlabelled pull showed', Number(last.principal_balance), 10685.52)
  eq('pre-fix rule anchored 11 days late', preFixAnchors(raw).slice(-1)[0].statement_date, '2026-08-28')
}
{
  // CONTROLS. A change that moves every loan is not targeted, it is broad — and a
  // check that cannot stay still cannot show that it discriminates.
  for (const [name, want] of [
    ['E-Transit Loan E4 -9744', '2026-08-20'],
    ['BayFirst SBA Loan', '2026-08-05'],
    ['BayFirst SBA 2', '2026-07-31'],
  ] as const) {
    const l = loan(name), raw = rowsOf(l)
    const { usable } = selectAnchorEvidence(raw, l.basis, TODAY)
    const after: any = usable[usable.length - 1]
    eq(`${name} is untouched`, after.statement_date, want)
    eq(`${name} agrees with the pre-fix rule`, preFixAnchors(raw).slice(-1)[0].statement_date, want)
  }
}

// ── 2. THE PAYMENT AMOUNT IS A DIFFERENT QUESTION ──────────────────────────
console.log('\n2. balance_basis gates the BALANCE, not the stated payment')
{
  const fc = loan('Funding Circle Loan'), raw = rowsOf(fc)
  const { paymentEvidence, stmts } = selectAnchorEvidence(raw, fc.basis, TODAY)
  eq('FC reads the lender\'s own stated instalment', statedPayment(paymentEvidence), 2033.77)

  // DISCRIMINATION: gating the payment by balance_basis loses the ONLY row that
  // states one, and the loan becomes underivable. This is the bug this change
  // introduced and then removed; the assertion is what stops it coming back.
  eq('gating the payment by basis leaves nothing to measure against', statedPayment(stmts), null)
  ok('...which is a refusal, not a degradation — there is no typed fallback',
    statedPayment(stmts) === null && Number(fc.scheduled) === 2000)
}

// ── 3. A RE-DATED ANCHOR MUST NOT SKIP A MONTH ─────────────────────────────
console.log('\n3. the minimum-gap guard is about ambiguity, not distance')
{
  const fc = loan('Funding Circle Loan'), raw = rowsOf(fc)
  const basis = normalizeBasis(fc.basis)
  const { usable, stmts, paymentEvidence } = selectAnchorEvidence(raw, fc.basis, TODAY)
  const periods = buildPeriods(stmts, statedPayment(paymentEvidence)!)
  const { clean, medianDays } = classifyPeriods(periods)
  const { best } = chooseFit(clean, 4)
  const last: any = usable[usable.length - 1]
  const filedFor = new Map<string, string>(
    (usable as any[]).map((s: any) => [String(s.statement_date), String(s.filed_date ?? s.statement_date)]))
  const payDom = medianDayOfMonth(clean.map(p => String(filedFor.get(p.to) ?? p.to)))

  eq('the payment day is measured from the FILED dates', payDom, 1)
  // DISCRIMINATION: measured off the re-dated dates it is the month end, which is
  // an artefact of our own arithmetic and would move every payment a month.
  ok('...measuring it off the re-dated dates gives a month end instead',
    (paymentDayOfMonth(clean) ?? 0) >= 28, String(paymentDayOfMonth(clean)))

  const opts = {
    anchorDate: last.statement_date, anchorBalance: Number(last.principal_balance),
    payment: recurringPayment(clean, fc.scheduled)!, fit: best, medianDays,
    maturity: fc.maturity, maxPeriods: 240, paymentDom: payDom,
  }
  const fixed = projectRows({ ...opts, anchorIsPeriodEnd: basis === 'period_start' })
  const broken = projectRows(opts)

  eq('September is projected', fixed[0].row_date, '2026-09-01')
  eq('...at the lender\'s own next split', [fixed[0].interest, fixed[0].principal], [977.07, 1056.7])
  // DISCRIMINATION: without the flag the guard rejects 09-01 for being one day
  // past a month-end anchor, and the schedule silently has no September row.
  eq('without the flag September vanishes entirely', broken[0].row_date, '2026-10-01')
  ok('...and nothing else in the schedule marks the gap',
    !broken.some((r: any) => String(r.row_date).slice(0, 7) === '2026-09'))
}
{
  // The flag must be inert on a balance_date loan, or it is not a fix, it is a
  // second behaviour. BayFirst SBA 2 anchors on the 31st and pays on the 2nd —
  // the shape most likely to be disturbed.
  const l = loan('BayFirst SBA 2'), raw = rowsOf(l)
  const { usable, stmts, paymentEvidence } = selectAnchorEvidence(raw, l.basis, TODAY)
  const { clean, medianDays } = classifyPeriods(buildPeriods(stmts, statedPayment(paymentEvidence)!))
  const { best } = chooseFit(clean, 4)
  const last: any = usable[usable.length - 1]
  const o = {
    anchorDate: last.statement_date, anchorBalance: Number(last.principal_balance),
    payment: recurringPayment(clean, l.scheduled)!, fit: best, medianDays,
    maturity: l.maturity, maxPeriods: 240, paymentDom: paymentDayOfMonth(clean),
  }
  eq('the flag changes nothing on a balance_date loan',
    JSON.stringify(projectRows(o).slice(0, 3)),
    JSON.stringify(projectRows({ ...o, anchorIsPeriodEnd: false }).slice(0, 3)))
  eq('BayFirst SBA 2 still starts where it did', projectRows(o)[0].row_date, '2026-09-02')
}

// ── 4. THE STALENESS GUARD MUST STILL BE ABLE TO FIRE ──────────────────────
console.log('\n4. anchor_statement_date stores the FILED date, and must')
{
  // loan-xero-post compares loan_amortization_schedules.anchor_statement_date
  // against the newest FILED statement date and refuses to stage when the anchor
  // is older. Storing the re-dated balance date would make Funding Circle's anchor
  // read 2026-08-31 against a filed maximum of 2026-08-03 — permanently "newer
  // than any statement", so a genuinely stale projection would stage. A guard that
  // cannot fail is worse than none (session 246), and this one must fail CLOSED.
  const fc = loan('Funding Circle Loan'), raw = rowsOf(fc)
  const { usable } = selectAnchorEvidence(raw, fc.basis, TODAY)
  const last: any = usable[usable.length - 1]
  const newestFiled = raw.map((r: any) => r.statement_date).sort().slice(-1)[0]
  const stored = String(last.filed_date ?? last.statement_date)
  ok('the stored anchor never post-dates the newest document on file', stored <= newestFiled,
    `${stored} vs ${newestFiled}`)
  // DISCRIMINATION: the value we did NOT store would break exactly that property.
  ok('storing the re-dated date instead would disable the guard for ever',
    String(last.statement_date) > newestFiled,
    `${last.statement_date} vs ${newestFiled}`)
}

// ── 5. THE WHOLE FUNCTION, NOT ITS PARTS ───────────────────────────────────
// ⚠ WHY THIS SECTION EXISTS, AND IT IS THE MOST IMPORTANT ONE IN THE FILE.
//
// Everything above exercises the PIECES. Session 275 also wrote a dry-run that
// composed those pieces by hand to print a before/after for all seven loans, and
// it agreed with the fix beautifully. Then the deployed function returned
// `fallbackPayment is not defined` on its first real call.
//
// The dry run never executed that line, because it re-implemented deriveSchedule
// instead of calling it. That is session 245's transcription trap — a copy
// agreeing with itself — arriving inside the verification written to prove the
// change was safe, one commit after a test file whose header warns about exactly
// this. Testing the parts is not testing the whole.
//
// So: drive the REAL deriveSchedule, with a stub standing in only for Supabase.
// No network, no DB, dry run (`confirm` omitted) so it can never write.
console.log('\n5. deriveSchedule itself, end to end')
{
  const fc = loan('Funding Circle Loan')
  const rows = rowsOf(fc).map((r: any, i: number) => ({ id: `s${i}`, source: 'portal_manual_pull', ...r }))

  // The narrowest thing that can stand in for the client: it answers the one
  // SELECT deriveSchedule makes before the fit, and records anything else.
  const seen: string[] = []
  const stub: any = {
    from(table: string) {
      seen.push(table)
      const q: any = {
        select: () => q, eq: () => q, in: () => q, not: () => q, lte: () => q, gte: () => q,
        lt: () => q, order: () => q, limit: () => q, maybeSingle: async () => ({ data: null }),
        single: async () => ({ data: null, error: null }),
        insert: () => { throw new Error('a dry run must not write') },
        update: () => { throw new Error('a dry run must not write') },
        upsert: () => { throw new Error('a dry run must not write') },
        then: (res: any) => res({ data: table === 'loan_statements' ? rows : [], error: null }),
      }
      return q
    },
  }
  const loanRow = {
    id: 'fc', status: 'active', xero_account_name: 'Funding Circle Loan', lender: 'iBusiness',
    statement_date_basis: fc.basis, maturity_date: fc.maturity,
    scheduled_monthly_payment: fc.scheduled, interest_rate: 20.0,
  }

  let out: any = null, threw: any = null
  try { out = await deriveSchedule(stub, loanRow, {}) } catch (e) { threw = e }

  ok('it does not throw', threw === null, threw ? String(threw && (threw as Error).message) : '')
  ok('it returns a result', !!out && out.ok === true, JSON.stringify(out).slice(0, 300))
  if (out?.ok) {
    eq('the anchor is the labelled month-end balance', out.anchor.balance, 65173.94)
    eq('...dated when that balance is true', out.anchor.statement_date, '2026-08-31')
    eq('...while the DOCUMENT date is kept for the staleness guard', out.anchor.filed_date, '2026-08-01')
    eq('the payment is the lender\'s own stated instalment', out.anchor.payment, 2033.77)
    eq('the unlabelled row is named as skipped',
      out.anchor.skipped_for_basis.map((x: any) => x.date), ['2026-08-03'])
    // ⚠ CAUGHT BY THIS ASSERTION BEING WRONG FIRST, AND WORTH THE WORDS.
    // `first_future_rows` filters on `row_date >= today`, so on 2026-09-05 the
    // 2026-09-01 row is correctly NOT a future row — September's payment has
    // already happened and belongs in the ordinary review flow, not staging. The
    // row is still generated and still written; only this REPORT excludes it.
    // Session 275's hand-composed dry run appeared to show September here only
    // because it widened that filter by hand, which is the sort of difference a
    // re-implementation hides and calling the real function exposes.
    eq('the first FUTURE row is October, September having already been paid',
      out.first_future_rows?.[0]?.row_date, '2026-10-01')
    // DISCRIMINATION: under the OLD anchor, October carried 977.07/1056.70 —
    // September's true figures, one period late. Getting 961.23/1072.54 here is
    // the whole fix, visible in the one place a projection is actually read.
    eq('...at the figures the corrected anchor gives it',
      [out.first_future_rows[0].interest, out.first_future_rows[0].principal], [961.23, 1072.54])
    ok('...which is NOT the stale value the old anchor produced',
      !(out.first_future_rows[0].interest === 977.07 && out.first_future_rows[0].principal === 1056.7))
    ok('it wrote nothing', out.dry_run === true && out.wrote_nothing === true)
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
