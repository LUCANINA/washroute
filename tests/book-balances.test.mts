// tests/book-balances.test.mts — where our own books live, and that every
// consumer looks in both places (session 263 cont. 7).
//
// David: "I don't understand this. Don't we have instant access to our ledger?"
// He was right. PayPal 2 had $49,346.58 at 2026-08-31 in `loan_book_balances`,
// rebuilt from Xero the night before, while the plan told him nothing of the
// kind existed — because the check read `loan_statements` and nothing else.
//
// Run:  npx tsx tests/book-balances.test.mts

import { allBalancesForLoan, normaliseBookBalances } from '../supabase/functions/_shared/book-balances.ts'
import { chooseObservation } from '../supabase/functions/_shared/carrying-basis-drift.ts'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// PayPal 2's real rows on the day David asked.
const LENDER = [
  { statement_date: '2026-07-29', principal_balance: 61896.57, balance_basis: 'principal_only', source: 'portal_manual_pull' },
  { statement_date: '2026-08-05', principal_balance: 58775.97, balance_basis: 'principal_only', source: 'portal_manual_pull' },
]
const BOOKS = [
  { as_of: '2026-06-30', balance: '77301.26', basis: 'xero_rebuild' },
  { as_of: '2026-07-31', balance: '61918.23', basis: 'xero_rebuild' },
  { as_of: '2026-08-31', balance: '49346.58', basis: 'xero_rebuild' },
]

section('the rebuild is found, and it is our side')
{
  const n = normaliseBookBalances(BOOKS)
  ok('all three normalise', n.length === 3)
  ok('as_of becomes the statement date', n[2].statement_date === '2026-08-31')
  ok('balance parses from a numeric string', n[2].principal_balance === 49346.58)

  // THE TWO FIELDS THAT LOOK ALIKE. `basis` is where it came FROM; it must land
  // in `source`, never in `balance_basis` — which is what a figure MEASURES, and
  // these rows do not record that.
  ok('basis becomes source, not balance_basis',
     n[2].source === 'xero_rebuild' && n[2].balance_basis === 'unknown')

  // Which matters because the source allowlist is what makes it "ours".
  const chosen = chooseObservation(allBalancesForLoan(LENDER, BOOKS) as any)
  ok('the basis check now has a book balance to look at', chosen.chosen !== null,
     String(chosen.refused_because))
  ok('...and it is the newest rebuild, not the newest row',
     chosen.chosen?.statement_date === '2026-08-31' && chosen.chosen?.principal_balance === 49346.58,
     JSON.stringify(chosen.chosen))
  ok('...unlabelled, so both models get tested against it',
     chosen.chosen?.basis === 'unlabelled')
}

section('THE FALSE CLAIM, PINNED')
{
  // Lender rows only: the refusal is correct and must survive.
  const lenderOnly = chooseObservation(allBalancesForLoan(LENDER, []) as any)
  ok('with no rebuild it still refuses', lenderOnly.refused_because === 'no_book_balance')

  // One rebuild is enough to stop the refusal. This is the exact assertion that
  // would have caught what David caught.
  const withOne = chooseObservation(allBalancesForLoan(LENDER, [BOOKS[2]]) as any)
  ok('one rebuild is enough to answer', withOne.refused_because === null)
}

section('a same-date tie prefers the purpose-built rebuild')
{
  const merged = allBalancesForLoan(
    [{ statement_date: '2026-08-31', principal_balance: 999, balance_basis: 'unknown', source: 'xero_derived' }],
    [{ as_of: '2026-08-31', balance: 49346.58, basis: 'xero_rebuild' }])
  ok('both are kept in the list', merged.length === 2)
  ok('...and the rebuild sorts last, so a newest-row pick lands on it',
     merged[merged.length - 1].source === 'xero_rebuild')
  ok('...and the loser is still visible to anything auditing the set',
     merged.some(m => m.source === 'xero_derived'))
}

section('ordering and hygiene')
{
  const merged = allBalancesForLoan(LENDER, BOOKS)
  ok('oldest first', merged[0].statement_date <= merged[merged.length - 1].statement_date)
  ok('nothing is dropped', merged.length === LENDER.length + BOOKS.length)
  ok('an unreadable balance is skipped, not zeroed',
     normaliseBookBalances([{ as_of: '2026-01-01', balance: 'n/a', basis: 'xero_rebuild' } as any]).length === 0)
  ok('a row with no date is skipped',
     normaliseBookBalances([{ as_of: '', balance: 1, basis: 'xero_rebuild' } as any]).length === 0)
  ok('null input is fine', normaliseBookBalances(null).length === 0 && allBalancesForLoan(null, null).length === 0)
}

section('EVERY consumer looks in both tables')
{
  // The mistake this session kept making is fixing one caller. Three ask "what
  // do our books hold": the bundle's §5, the bundle's basis check, and
  // reconciliation-run's. A source-text assertion, for the same reason as
  // tests/transcriber-instructions — these are separate deployables.
  const plan = readFileSync(new URL('../supabase/functions/_shared/loan-bundle-plan.ts', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../supabase/functions/loan-bundle/index.ts', import.meta.url), 'utf8')
  const recon = readFileSync(new URL('../supabase/functions/reconciliation-run/index.ts', import.meta.url), 'utf8')

  ok('§5 merges both tables', /allBalancesForLoan\(ctx\.statements, ctx\.bookBalances\)/.test(plan))
  ok('the bundle loads loan_book_balances', /from\('loan_book_balances'\)/.test(bundle))
  ok('...and refuses the plan if that read fails', /bbRes\.error/.test(bundle))
  ok('...and passes it to the planner', /\bbookBalances,/.test(bundle))
  ok('the bundle basis check merges both', /balances: allBalancesForLoan\(/.test(bundle))
  ok('reconciliation-run loads it', /from\('loan_book_balances'\)\.select\('loan_account_id/.test(recon))
  ok('...and merges it into the basis check', /allBalancesForLoan\(mine,/.test(recon))

  // And nobody reads statements alone for this question any more.
  ok('§5 no longer filters ctx.statements directly for book rows',
     !/ctx\.statements \|\| \[\]\)\s*\.filter\(st => BOOK_BALANCE_SOURCES/.test(plan))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
