// tests/loan-matcher.test.mts — which loan do these documents belong to?
//
// The matcher decides where four documents get FILED. A wrong answer here is not
// a wrong number on a screen, it is an agreement attached to somebody else's
// loan. So the assertions below spend at least as much effort on the cases that
// must REFUSE to match as on the ones that must succeed.
//
// Run:  npx tsx tests/loan-matcher.test.mts

import { matchLoan, type MatchableLoan } from '../supabase/functions/_shared/loan-matcher.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// The real loan list, in the shape and with the collisions it actually has:
// four Ford loans, two BayFirst loans, and a Stripe loan whose stored account
// number is nothing like the reference its own agreement prints.
const LOANS: MatchableLoan[] = [
  { id: 'stripe', status: 'active', lender: 'Stripe Capital', xero_account_name: 'Stripe Capital Loan', lender_account_number: 'STRIPE-CAPITAL', original_amount: 125000 },
  { id: 'ford1',  status: 'active', lender: 'Ford Pro FinSimple', xero_account_name: 'Ford Transit 4140', lender_account_number: 'FORD-4140', original_amount: 52000 },
  { id: 'ford2',  status: 'active', lender: 'Ford Pro FinSimple', xero_account_name: 'Ford Transit 9921', lender_account_number: 'FORD-9921', original_amount: 51000 },
  { id: 'ford3',  status: 'active', lender: 'Ford Pro FinSimple', xero_account_name: 'Ford Transit 3310', lender_account_number: 'FORD-3310', original_amount: 49000 },
  { id: 'ford4',  status: 'active', lender: 'Ford Pro FinSimple', xero_account_name: 'Ford Transit 7702', lender_account_number: 'FORD-7702', original_amount: 48000 },
  { id: 'bay1',   status: 'active', lender: 'BayFirst National Bank', xero_account_name: 'BayFirst SBA 1', lender_account_number: 'BAY-1', original_amount: 150000 },
  { id: 'bay2',   status: 'active', lender: 'BayFirst National Bank', xero_account_name: 'BayFirst SBA 2', lender_account_number: 'BAY-2', original_amount: 90000 },
  { id: 'paypal', status: 'active', lender: 'PayPal', xero_account_name: 'PayPal Working Capital 2', lender_account_number: 'PP-2', original_amount: 60000 },
  { id: 'verdant',status: 'active', lender: 'Verdant Commercial Capital', xero_account_name: 'Verdant', lender_account_number: 'VC-77', original_amount: 80000 },
  { id: 'closed', status: 'closed', lender: 'Rapid Finance', xero_account_name: 'Rapid Finance (paid off)', lender_account_number: 'RF-1', original_amount: 30000 },
]

section('the case David hit: Stripe, by name')
{
  // The agreement prints acct_1MPrRD..., which matches no loan's stored number.
  const r = matchLoan({ loans: LOANS, acctRef: 'acct_1MPrRDLkdIwHu7ix', lenderHints: ['Stripe Capital'], agreementLoanAmount: 125000 })
  ok('matches the Stripe loan', r.loan?.id === 'stripe', `got ${r.loan?.id}`)
  ok('reports it matched on the lender name', r.rung === 'lender_name', `rung=${r.rung}`)
  ok('says the amount corroborates', /matches the agreement's Loan Amount to the cent/.test(r.matchedOn || ''))
  ok('names the lender in the sentence', /Stripe Capital/.test(r.matchedOn || ''))
}

section('the cases that must REFUSE rather than guess')
{
  const ford = matchLoan({ loans: LOANS, lenderHints: ['Ford Pro FinSimple'], agreementLoanAmount: 52000 })
  ok('four Ford loans -> no match', ford.loan === null, `got ${ford.loan?.id}`)
  ok('...and no explanation to show', ford.matchedOn === null)

  const bay = matchLoan({ loans: LOANS, lenderHints: ['BayFirst National Bank'] })
  ok('two BayFirst loans -> no match', bay.loan === null, `got ${bay.loan?.id}`)

  // A matching amount must NOT rescue an ambiguous lender. The amount is only
  // ever corroboration for a match already made; promoting it to a tie-breaker
  // would file documents against a loan on the strength of a coincidence.
  ok('a unique amount does not break the Ford tie', ford.loan === null)

  const nobody = matchLoan({ loans: LOANS, lenderHints: ['Nonexistent Bank'] })
  ok('an unknown lender -> no match', nobody.loan === null)

  const nothing = matchLoan({ loans: LOANS })
  ok('no reference and no hint -> no match', nothing.loan === null)

  const emptyHint = matchLoan({ loans: LOANS, lenderHints: [''] })
  ok('an empty hint matches nothing', emptyHint.loan === null)
}

section('the account number, when it really is the account number')
{
  const r = matchLoan({ loans: LOANS, acctRef: 'FORD-9921' })
  ok('exact account number wins outright', r.loan?.id === 'ford2', `got ${r.loan?.id}`)
  ok('...reported as an exact match', r.rung === 'account_number')

  // The old matcher also accepted "the last 8 characters agree". FORD-9921 and
  // FORD-3310 share no suffix, but this is the shape that made it dangerous:
  const suffixy: MatchableLoan[] = [
    { id: 'a', status: 'active', lender: 'X', lender_account_number: 'AAAA-00012345' },
    { id: 'b', status: 'active', lender: 'Y', lender_account_number: 'BBBB-00012345' },
  ]
  const s = matchLoan({ loans: suffixy, acctRef: '99999-00012345' })
  ok('a shared suffix no longer matches anything', s.loan === null, `got ${s.loan?.id}`)
}

section('the learned reference — the self-healing rung')
{
  // Second Stripe bundle: the first one filed acct_... as a contract term.
  const r = matchLoan({ loans: LOANS, acctRef: 'acct_1MPrRDLkdIwHu7ix', learnedRefLoanIds: ['stripe'] })
  ok('recognised from a document filed earlier', r.loan?.id === 'stripe', `got ${r.loan?.id}`)
  ok('...reported as the learned rung', r.rung === 'learned_ref')
  ok('...with no lender hint needed at all', /recorded against this loan from a document filed earlier/.test(r.matchedOn || ''))

  // If two loans somehow learned the same reference, that is a data problem, and
  // guessing between them would bury it.
  const two = matchLoan({ loans: LOANS, acctRef: 'acct_x', learnedRefLoanIds: ['stripe', 'paypal'] })
  ok('the same reference on two loans -> no match', two.loan === null)

  // A learned reference pointing at a loan that is no longer active is not a match.
  const stale = matchLoan({ loans: LOANS, acctRef: 'RF-OLD', learnedRefLoanIds: ['closed'] })
  ok('a learned ref on a closed loan -> no match', stale.loan === null)
}

section('rung order — stronger evidence wins')
{
  // The account number points at PayPal; the lender name points at Stripe.
  // Rung 1 must win, because an exact account number is the stronger claim.
  const r = matchLoan({ loans: LOANS, acctRef: 'PP-2', lenderHints: ['Stripe Capital'] })
  ok('exact account number beats a lender-name hint', r.loan?.id === 'paypal', `got ${r.loan?.id}`)
  ok('...and says so', r.rung === 'account_number')

  // Rung 2 beats rung 3 for the same reason.
  const r2 = matchLoan({ loans: LOANS, acctRef: 'acct_z', learnedRefLoanIds: ['paypal'], lenderHints: ['Stripe Capital'] })
  ok('a learned reference beats a lender-name hint', r2.loan?.id === 'paypal', `got ${r2.loan?.id}`)
}

section('closed loans are never matched')
{
  ok('by lender name', matchLoan({ loans: LOANS, lenderHints: ['Rapid Finance'] }).loan === null)
  ok('by account number', matchLoan({ loans: LOANS, acctRef: 'RF-1' }).loan === null)
  ok('empty loan list is handled', matchLoan({ loans: [], lenderHints: ['Stripe Capital'] }).loan === null)
}

section('the short-name floor')
{
  // A loan recorded under a 2-character lender would otherwise be "contained in"
  // almost every hint. The floor is what stops it.
  const shorty: MatchableLoan[] = [{ id: 'sh', status: 'active', lender: 'PC', xero_account_name: 'PC Loan', lender_account_number: 'PC-1' }]
  ok('a 2-char lender is not matched by an unrelated hint',
     matchLoan({ loans: shorty, lenderHints: ['Stripe Capital'] }).loan === null)
  // ...but it still matches its own name.
  ok('...and still matches its own name', matchLoan({ loans: shorty, lenderHints: ['PC'] }).loan?.id === 'sh')
}

section('punctuation and case are not evidence')
{
  ok('"stripe capital." matches', matchLoan({ loans: LOANS, lenderHints: ['stripe capital.'] }).loan?.id === 'stripe')
  ok('"STRIPE  CAPITAL" matches', matchLoan({ loans: LOANS, lenderHints: ['STRIPE  CAPITAL'] }).loan?.id === 'stripe')
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
