// derive-cause.test.mts — session 289
// ============================================================================
// THE FIRST CUT OF THIS DERIVATION WAS WRONG IN A WAY NO FIGURE WOULD SHOW.
//
// It said "no principal was applied in any of the N payments since <winFrom>".
// On EIDL SBA — the loan it was written for — the walk's window opens 2026-04
// and the payments on file run 2026-07 → 2026-09. So it claimed to have read
// three months it had never looked at, and then drew a conclusion about the
// month the difference actually arose in, which is earlier still.
//
// Every number in it would have been correct. That is the point: "a wrong word
// beside a right number is the harder mistake to catch" (s247), and it is why
// this file asserts on the SENTENCE and not only on whether the branch fires.
// ============================================================================
import { deriveIncreaseCause, bracketIncrease } from '../supabase/functions/loan-find-difference/derive-cause.ts'

let pass = 0, fail = 0
const ok = (c: unknown, name: string, obs = '') => {
  if (c) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${obs ? `\n        ${obs}` : ''}`) }
}
const sec = (t: string) => console.log(`\n── ${t} `)

// The real EIDL rows, read off the database 2026-09-08 — INCLUDING `source`,
// which the first version of this file omitted and which turned out to be the
// whole point. 2026-07 is statement_delta (ours); 08 and 09 are explicit_split
// (the lender's own "Applied to Principal" line).
const EIDL = [
  { period_label: '2026-07', source: 'statement_delta', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2026-08', source: 'explicit_split', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2026-09', source: 'explicit_split', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2024-03-22', source: 'statement_delta', principal_amount: 4791, interest_amount: 0 },
  { period_label: '2024-02-22', source: 'statement_delta', principal_amount: 1802.21, interest_amount: 2988.79 },
]
const HEAD = { difference: -5 }          // our books BELOW the lender
const WIN = '2026-04-25'                 // earliest usable statement

// The real statement rows. 2026-04-25 carries NO balance_as_of, so on a
// due_date lender it is refused as an ANCHOR — and it is still the document
// that states $960,000.00, which is the whole point of bracketing.
const STMTS = [
  { statement_date: '2026-04-25', principal_balance: 960000, balance_basis: 'principal_only', source: 'portal_manual_pull' },
  { statement_date: '2026-05-25', principal_balance: 960005, balance_basis: 'principal_only', source: 'portal_manual_pull' },
  { statement_date: '2026-06-25', principal_balance: 960005, balance_basis: 'principal_only', source: 'portal_manual_pull' },
  { statement_date: '2026-09-25', principal_balance: 960005, balance_basis: 'principal_only', source: 'portal_manual_pull' },
  // ours, not the lender's — must never enter the bracket (s246)
  { statement_date: '2024-03-31', principal_balance: 960000, balance_basis: 'unknown', source: 'xero_derived' },
]

sec('it fires on the case it was written for')
const eidl = deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: -5 })!
ok(eidl, 'EIDL produces a cause')
ok(eidl.months === 2, '⭐ it counts the TWO the lender stated, not the three rows on file', String(eidl?.months))

sec('⭐ IT NAMES THE MONTHS IT READ — NOT THE WINDOW IT MEANT TO READ')
ok(eidl.sentence.includes('from 2026-08 to 2026-09'),
   'the range is the months the LENDER spoke about', eidl.sentence)
ok(!eidl.sentence.includes('2026-07'),
   '⭐ 2026-07 is absent from the claim — its "principal" IS the balance delta, so citing it is s246 circularity', eidl.sentence)
ok(/^The lender added \$5\.00 to the balance/.test(eidl.sentence),
   '⭐ THE FIGURE LEADS — the sentence says what the difference IS before it argues about it', eidl.sentence)
ok(/Its own statements from/.test(eidl.sentence),
   '...and then says whose figures back it', eidl.sentence)
ok(!eidl.sentence.includes('since 2026-04'),
   '⭐ CONTROL: the old overclaim is gone — it never says "since <window start>"', eidl.sentence)
ok(!/\b2026-05\b|\b2026-06\b/.test(eidl.sentence),
   '...and it names no month it did not read', eidl.sentence)

sec('⭐ THE INFERENCE IS NOT CLAIMED OVER MONTHS OUTSIDE THE EVIDENCE')
ok(eidl.covers_event === false, 'a residual means the difference predates the evidence')
ok(/predates 2026-04/.test(eidl.sentence),
   'and the card says so, which is also the honest ground for asking for the earlier statements (s262)', eidl.sentence)
ok(!/did so through/.test(eidl.sentence),
   '⭐ it does NOT assert what this particular rise "did" — only the general rule', eidl.sentence)

const covered = deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: null })!
ok(covered.covers_event === true && /did so through a fee or capitalised interest/.test(covered.sentence),
   'CONTROL: with no residual the evidence DOES cover the event, and then it states it outright', covered.sentence)

sec('the working says whose books these are')
ok(/Stated by the lender/.test(eidl.working), 'the working leads with whose figures carry the claim')
ok(/2026-08 \$0\.00 principal \/ \$4,791\.00 interest/.test(eidl.working), 'every lender-stated row is in the working', eidl.working)
ok(/Not counted.*2026-07 \(statement delta\)/.test(eidl.working),
   '⭐ the discounted row is NAMED and its reason given — dropped from the claim, not from the card (ce17)', eidl.working)
ok(/the balance did not move — which is the question, not an answer to it/.test(eidl.working),
   'and it explains WHY our own delta cannot be evidence here', eidl.working)

sec('it refuses where it has no business speaking')
ok(deriveIncreaseCause({ splits: EIDL, headline: { difference: 5 }, winFrom: WIN, residual: null }) === null,
   'our books ABOVE the lender is a different question — no cause offered')
ok(deriveIncreaseCause({ splits: EIDL, headline: { difference: -0.01 }, winFrom: WIN, residual: null }) === null,
   'a difference inside tolerance is not a difference')
ok(deriveIncreaseCause({ splits: [EIDL[1]], headline: HEAD, winFrom: WIN, residual: null }) === null,
   'one lender-stated month is arithmetic, not a pattern — two is the minimum')
ok(deriveIncreaseCause({ splits: [EIDL[0], { period_label: '2026-08', source: 'statement_delta', principal_amount: 0, interest_amount: 4791 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   '⭐⭐ TWO of OUR OWN delta rows say nothing — the claim needs the lender, however many rows we hold')
ok(deriveIncreaseCause({ splits: [{ period_label: '2026-08', source: 'amortization_schedule', principal_amount: 0, interest_amount: 10 },
                                  { period_label: '2026-09', source: 'amortization_schedule', principal_amount: 0, interest_amount: 10 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   'a schedule is ours too — and on most of this book one we derived from statements')
ok(deriveIncreaseCause({
     splits: [EIDL[1], { period_label: '2026-09', source: 'explicit_split', principal_amount: 120, interest_amount: 4671 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   '⭐ ONE month applying principal kills the claim — "every one" has to mean every one')
ok(deriveIncreaseCause({
     splits: [{ period_label: 'Period 84', source: 'explicit_split', principal_amount: 0, interest_amount: 10 },
              { period_label: 'Period 85', source: 'explicit_split', principal_amount: 0, interest_amount: 10 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   'a period label carrying no date cannot be placed, so it is not counted (s230)')

sec('⭐ WHEN IT APPEARED — bracketed between two documents (David)')
const withStmts = deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: -5,
                                        statements: STMTS, lenderBalance: 960005 })!
const b = withStmts.bracket
ok(b, '⭐ the change is located, from documents the WALK cannot use as anchors')
ok(b && b.fromFiled === '2026-04-25' && b.fromBalance === 960000,
   '...the last statement reading the old balance', JSON.stringify(b))
ok(b && b.toFiled === '2026-05-25' && b.toBalance === 960005,
   '...and the first reading the new one', JSON.stringify(b))
ok(!/2026-04-25|960,000/.test(withStmts.sentence),
   '⭐ the figures are NOT in the prose — the card draws them as a citation line, stated once (s279)',
   withStmts.sentence)
ok(!/those months are not among the ones read here/.test(withStmts.sentence),
   '⭐ and the hedge is GONE: it apologised for not knowing when, and now we know',
   withStmts.sentence)

sec('the bracket refuses rather than flatter')
ok(bracketIncrease({ statements: STMTS.filter(x => x.source === 'xero_derived'), lenderBalance: 960005 }) === null,
   '⭐ our own xero_derived row can never bracket anything (s246)')
ok(bracketIncrease({ statements: [
     { statement_date: '2026-01-25', principal_balance: 960005, balance_basis: 'principal_only', source: 'portal_manual_pull' },
     { statement_date: '2026-02-25', principal_balance: 960000, balance_basis: 'principal_only', source: 'portal_manual_pull' },
     { statement_date: '2026-03-25', principal_balance: 960005, balance_basis: 'principal_only', source: 'portal_manual_pull' },
   ], lenderBalance: 960005 }) === null,
   '⭐ a balance that reached this figure TWICE has a history, not a moment — no bracket')
ok(bracketIncrease({ statements: [STMTS[1]], lenderBalance: 960005 }) === null,
   'one statement cannot bracket anything')
ok(deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: -5 })!.bracket === null,
   'CONTROL: with no statements passed, there is no bracket and the hedge returns')
ok(/those months are not among the ones read here/.test(
     deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: -5 })!.sentence),
   '...which is the honest fallback, not a silent drop')

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
process.exit(fail ? 1 : 0)
