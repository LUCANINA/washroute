// tests/evidence-gate.test.mts — the gate may pause a check, but it may never
// make one disappear (session 263 cont. 8).
//
// David: "only ONCE everything is in ... does the system do its calculations."
// The danger in that is silence, so most of what is asserted here is the LOUD
// half: that a paused check is always named, always attached to the document
// that would start it, and never simply absent.
//
// Run:  npx tsx tests/evidence-gate.test.mts

import {
  CHECK_NEEDS, ASK_OWNED_ELSEWHERE, emptyEvidence, gateFor, awaitingEvidenceFinding,
  type LoanEvidence, type GatedCheck,
} from '../supabase/functions/_shared/evidence-gate.ts'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const LOAN = { id: 'L1', xero_account_code: '280', xero_account_name: 'Paypal 2' }

const full = (): LoanEvidence => ({
  lender_document: { have: true, newest: '2026-08-31' },
  contract_terms: { have: true },
  amortization_schedule: { have: true },
  book_balance: { have: true, newest: '2026-08-31' },
})

// ── 1. The gate opens when the evidence is in ──────────────────────────────
section('evidence in — every registered check runs')

for (const key of Object.keys(CHECK_NEEDS)) {
  ok(`${key} is ready on complete, current evidence`, gateFor(key, full(), '2026-08-01').ready)
}
ok('nothing is paused, so there is no waiting row',
  awaitingEvidenceFinding(LOAN, Object.keys(CHECK_NEEDS).map(k => ({ check_key: k, verdict: gateFor(k, full(), '2026-08-01') })) as GatedCheck[]) === null)

// ── 2. FAIL OPEN: an unregistered check is never gated ─────────────────────
section('an unregistered check is never gated (noise is recoverable, silence is not)')

const none = emptyEvidence()
ok('a check with no declared needs runs even with zero evidence',
  gateFor('some_new_check_nobody_registered', none, '2026-08-01').ready)
ok('...and reports nothing missing',
  gateFor('some_new_check_nobody_registered', none).missing.length === 0)

// ── 3. The gate closes, per check, on what that check needs ────────────────
section('per check, not per loan')

const noTerms: LoanEvidence = { ...full(), contract_terms: { have: false } }
ok('carrying_basis pauses when the agreement figures are missing',
  gateFor('carrying_basis', noTerms, '2026-08-01').missing.includes('contract_terms'))
ok('balance_vs_lender still runs — it does not need the agreement',
  gateFor('balance_vs_lender', noTerms, '2026-08-01').ready)
ok('DISCRIMINATES: a loan is not gated wholesale by one missing document',
  gateFor('balance_vs_lender', noTerms, '2026-08-01').ready &&
  !gateFor('carrying_basis', noTerms, '2026-08-01').ready)

// ── 4. Coverage, not just presence ─────────────────────────────────────────
section('a document older than the period is not evidence for that period')

// The boundary is the month's FIRST day: a document dated inside the month is
// evidence for it. Using the month END would reject PayPal 2's own 5 August
// statement on an August close, which is a silent pause on good evidence.
const julyOnly: LoanEvidence = { ...full(), lender_document: { have: true, newest: '2026-07-31' } }
ok('a July statement does not satisfy an August close',
  gateFor('balance_vs_lender', julyOnly, '2026-08-01').stale.includes('lender_document'))
ok('...and that counts as not ready',
  !gateFor('balance_vs_lender', julyOnly, '2026-08-01').ready)
ok('INVERSE: the same statement satisfies a July close',
  gateFor('balance_vs_lender', julyOnly, '2026-07-01').ready)
// The regression this boundary exists to prevent, pinned with a real figure.
const midAugust: LoanEvidence = { ...full(), lender_document: { have: true, newest: '2026-08-05' } }
ok("PayPal 2's mid-month 2026-08-05 statement is NOT stale for an August close",
  gateFor('balance_vs_lender', midAugust, '2026-08-01').ready)
ok('a kind carrying no date is a presence question, never a staleness one',
  gateFor('carrying_basis', { ...full(), book_balance: { have: true, newest: null } }, '2026-08-01').stale.length === 0)

// ── 5. THE LOUD HALF — a paused check is never silent ──────────────────────
section('THE LOUD HALF: paused is a state, not a blank')

const gated: GatedCheck[] = [
  { check_key: 'carrying_basis', verdict: gateFor('carrying_basis', noTerms, '2026-08-01') },
  { check_key: 'balance_vs_lender', verdict: gateFor('balance_vs_lender', noTerms, '2026-08-01') },
]
const w = awaitingEvidenceFinding(LOAN, gated, { periodClosed: true })
ok('a paused check ALWAYS produces a row', w !== null)
ok('the row names the loan', !!w && w.title.includes('Paypal 2'))
ok('the row names the paused check in its detail', !!w && w.detail.paused_checks.includes('carrying_basis'))
ok('the row does NOT list the check that still ran', !!w && !w.detail.paused_checks.includes('balance_vs_lender'))
ok('the row names the missing evidence', !!w && w.detail.missing.includes('contract_terms'))
ok('the row says nothing is wrong, in words', !!w && /cannot tell yet/.test(w.plain_english))
ok('the row says how it resumes', !!w && /resumes? on the next run/.test(w.plain_english))
ok('a month being closed makes it warn, not info', w?.severity === 'warn')
ok('INVERSE: outside a close it is info', awaitingEvidenceFinding(LOAN, gated, { periodClosed: false })?.severity === 'info')

// ── 6. Asking once ─────────────────────────────────────────────────────────
section('the same document is never asked for twice')

const noStatement: LoanEvidence = { ...emptyEvidence(), contract_terms: { have: true }, book_balance: { have: true, newest: '2026-08-31' } }
const g2: GatedCheck[] = [{ check_key: 'balance_vs_lender', verdict: gateFor('balance_vs_lender', noStatement, '2026-08-01') }]
const w2 = awaitingEvidenceFinding(LOAN, g2, {})
ok('the lender document is still REPORTED as missing', !!w2 && w2.detail.missing.includes('lender_document'))
ok('...but not asked for here — stale_anchor owns that ask',
  !!w2 && !w2.detail.asked_here.includes('lender_document'))
ok('...and the row records who does own it',
  !!w2 && w2.detail.asked_elsewhere.some((a: any) => a.kind === 'lender_document' && a.check_key === 'stale_anchor'))
ok('ASK_OWNED_ELSEWHERE is the single source for that', ASK_OWNED_ELSEWHERE.lender_document === 'stale_anchor')

// ── 7. No dollar figure may ride along ─────────────────────────────────────
section('a waiting row may never carry a variance')

const all = [w, w2].filter(Boolean) as any[]
for (const f of all) {
  const text = `${f.title} ${f.plain_english}`
  ok(`no dollar amount in "${f.check_key}" copy`, !/\$[\d,]/.test(text), text.slice(0, 90))
}
ok('the fingerprint is stable across runs for the same paused set',
  awaitingEvidenceFinding(LOAN, gated, {})!.fingerprint === awaitingEvidenceFinding(LOAN, gated, {})!.fingerprint)
ok('...and CHANGES when a different check is paused',
  awaitingEvidenceFinding(LOAN, gated, {})!.fingerprint !== w2!.fingerprint)

// ── 8. The needs table is honest about the real checks ─────────────────────
section('the needs table names checks that actually exist')

const recon = readFileSync(new URL('../supabase/functions/reconciliation-run/index.ts', import.meta.url), 'utf8')
for (const key of Object.keys(CHECK_NEEDS)) {
  ok(`check_key '${key}' appears in reconciliation-run`, recon.includes(`'${key}'`) || recon.includes(`\`${key}`))
}
ok("carrying_basis needs BOTH terms and a book balance",
  CHECK_NEEDS.carrying_basis.includes('contract_terms') && CHECK_NEEDS.carrying_basis.includes('book_balance'))

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
