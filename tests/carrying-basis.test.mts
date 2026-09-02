// tests/carrying-basis.test.mts — which balance the basis check is allowed to
// look at, and what it is allowed to conclude from it (Tech Debt #34).
//
// Run:  npx tsx tests/carrying-basis.test.mts

import { detectCarryingBasisDrift, chooseObservation, fitBasis } from '../supabase/functions/_shared/carrying-basis-drift.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// PayPal 2's real figures.
const TERMS = { loan_amount: 157000, fixed_fee: 20565.12, total_repayment_amount: 177565.12 }
const SPLITS = [{ period_label: '2026-08-05', principal_amount: 117058.53, interest_amount: -958.39, total_amount: 116100.14 }]
const base = (balances: any[], over: any = {}) => ({
  loan_id: 'pp', loan_label: 'Paypal 2', recorded_basis: 'unknown',
  terms: TERMS, balances, splits: SPLITS, ...over,
} as any)

const lenderRow = { statement_date: '2026-08-05', principal_balance: 58775.97, balance_basis: 'principal_only', source: 'portal_manual_pull' }
const bookGross = { statement_date: '2026-08-05', principal_balance: 61464.98, balance_basis: 'unknown', source: 'xero_derived' }
const bookNet   = { statement_date: '2026-08-05', principal_balance: 39941.47, balance_basis: 'unknown', source: 'xero_derived' }

section('the observation is chosen from the BOOKS, never from the lender')
{
  const only = chooseObservation([lenderRow] as any)
  ok('a lender statement is not an observation', only.chosen === null)
  ok('...and the refusal names the reason', only.refused_because === 'no_book_balance')
  ok('...and says whose figure it declined to use',
     /How a loan is CARRIED is a fact about our ledger/.test(only.statement), only.statement)

  // THE BUG, PINNED. The old code took the newest row of any source. Here the
  // lender row IS the newest, and it must still be passed over.
  const mixed = chooseObservation([
    { ...bookGross, statement_date: '2026-07-01' },
    { ...lenderRow, statement_date: '2026-08-05' },
  ] as any)
  ok('a newer lender row does not displace an older book row',
     mixed.chosen?.source === 'xero_derived' && mixed.chosen?.statement_date === '2026-07-01',
     JSON.stringify(mixed.chosen))

  // Our own schedule is our own record — §246, a check whose inputs share a
  // source cannot fail.
  const ours = chooseObservation([
    { statement_date: '2026-08-05', principal_balance: 58775.97, balance_basis: 'principal_only', source: 'amortization_schedule' },
  ] as any)
  ok('our own schedule is not an outside check either', ours.refused_because === 'no_book_balance')

  // A source nobody has thought about is EXCLUDED, not trusted.
  const novel = chooseObservation([
    { statement_date: '2026-08-05', principal_balance: 1, balance_basis: 'unknown', source: 'some_new_importer' },
  ] as any)
  ok('an unrecognised source fails safe', novel.refused_because === 'no_book_balance')

  // A row with NO source is refused loudly rather than skipped silently.
  const bare = chooseObservation([{ statement_date: '2026-08-05', principal_balance: 1 }] as any)
  ok('a row with no source refuses rather than disappearing', bare.refused_because === 'no_source_on_rows')
  ok('...and says why that matters',
     /cannot be told apart from the lender's own figure/.test(bare.statement), bare.statement)
}

section('the model must predict the quantity the observation measures')
{
  // A principal-only BOOK balance can only be predicted by the net model.
  const net = fitBasis(base([{ ...bookNet, balance_basis: 'principal_only' }]))
  ok('a principal-only book balance gets only the net models',
     net.length > 0 && net.every(f => f.basis !== 'gross_payback'), JSON.stringify(net.map(f => f.basis)))

  // A payoff BOOK balance can only be predicted by the gross model.
  const gross = fitBasis(base([{ ...bookGross, balance_basis: 'total_payback' }]))
  ok('a payoff book balance gets only the gross model',
     gross.length === 1 && gross[0].basis === 'gross_payback', JSON.stringify(gross.map(f => f.basis)))

  // THE ORIGINAL DEFECT: the gross model against a principal-only balance misses
  // by exactly the unearned fee. It must no longer be run at all.
  ok('the gross model is never compared to a principal-only balance',
     !net.some(f => f.basis === 'gross_payback'))

  // An UNLABELLED book balance is the productive case: both models, and whichever
  // lands names the basis.
  const both = fitBasis(base([bookGross]))
  ok('an unlabelled book balance gets both models',
     both.some(f => f.basis === 'gross_payback') && both.some(f => f.basis === 'net_principal'))
}

section('what it concludes')
{
  ok('no book balance -> not enough evidence, at INFO not ERROR',
     (() => { const r = detectCarryingBasisDrift(base([lenderRow]))
              return r.verdict === 'not_enough_evidence' && r.severity === 'info' })())

  // Before this fix, that same input produced fits_neither at severity error.
  ok('...and specifically NOT fits_neither',
     detectCarryingBasisDrift(base([lenderRow])).verdict !== 'fits_neither')

  const g = detectCarryingBasisDrift(base([lenderRow, bookGross]))
  ok('an unlabelled book balance shaped like the payback identifies gross',
     g.observed_basis === 'gross_payback', g.observed_basis)
  const n = detectCarryingBasisDrift(base([lenderRow, bookNet]))
  ok('...and one shaped like principal identifies net',
     n.observed_basis === 'net_principal', n.observed_basis)

  // A labelled book balance settles it from the label, and the models become a
  // consistency check rather than a vote.
  const lab = detectCarryingBasisDrift(base([{ ...bookGross, balance_basis: 'total_payback' }]))
  ok('a labelled book balance settles the basis outright', lab.observed_basis === 'gross_payback')
  ok('...and with the basis already recorded it is simply consistent',
     detectCarryingBasisDrift(base([{ ...bookGross, balance_basis: 'total_payback' }],
       { recorded_basis: 'gross_payback' })).verdict === 'consistent')

  // A labelled book balance whose arithmetic does NOT hold is a real finding.
  const off = detectCarryingBasisDrift(base([{ ...bookGross, principal_balance: 90000, balance_basis: 'total_payback' }],
    { recorded_basis: 'gross_payback' }))
  ok('a labelled balance that does not foot is still reported',
     off.verdict === 'fits_neither', off.verdict)
}

section('the crash: an empty fit set must never reach the closest-of branch')
{
  // Found by an adversarial pass, not by a failure: a book balance that DECLARES
  // its basis on a loan whose terms are not on file. `declaredBasis` is non-null
  // so the not-enough-terms guard was skipped; `fits` is empty so the declared
  // branch was skipped; and the closest-of branch then read `closest.observed`
  // off undefined. It threw instead of answering.
  let threw: string | null = null
  let verdict = ''
  try {
    const r = detectCarryingBasisDrift({
      loan_id: 'x', loan_label: 'No terms', recorded_basis: 'unknown',
      terms: { loan_amount: null, fixed_fee: null, total_repayment_amount: null },
      balances: [{ statement_date: '2026-08-05', principal_balance: 1000, balance_basis: 'principal_only', source: 'xero_derived' }],
      splits: [{ period_label: '2026-08-05', principal_amount: 0, interest_amount: 0, total_amount: 0 }],
    } as any)
    verdict = r.verdict
  } catch (e) { threw = String(e) }
  ok('it does not throw', threw === null, String(threw))
  ok('...and it answers not_enough_evidence', verdict === 'not_enough_evidence', verdict)
}

section('both sides are cut at the OBSERVATION date, not the newest balance')
{
  // EIDL's shape: a book balance years behind the newest lender figure. Every
  // payment since must be excluded, or a 2026 sum is subtracted from a 2024
  // balance. 157,000 - 0 = 157,000 is what the net model must predict here.
  const stale = detectCarryingBasisDrift(base([
    { statement_date: '2024-03-31', principal_balance: 157000, balance_basis: 'principal_only', source: 'xero_derived' },
    { ...lenderRow, statement_date: '2026-08-05' },
  ]))
  const netFit = stale.detail && (stale.detail as any).fits?.find((f: any) => f.basis === 'net_principal')
  ok('payments after the observation are excluded',
     !!netFit && Math.abs(netFit.predicted - 157000) < 0.02, JSON.stringify(netFit))
  ok('...so an old book balance is CONSISTENT, not an error',
     stale.verdict !== 'fits_neither', stale.verdict)
  ok('and the reader is told the verdict speaks for that older day',
     /days behind the newest figure on file/.test((stale.detail as any).observation_statement || ''),
     (stale.detail as any)?.observation_statement)

  // DISCRIMINATION: without the cut, all 116,100.14 of payments would apply and
  // the net model would predict 39,941.47 instead — nowhere near 157,000.
  ok('...and the uncut figure is genuinely different',
     Math.abs(157000 - 39941.47) > 100000)
}

section('a payment that cannot be placed in time stops the check')
{
  const r = detectCarryingBasisDrift(base([bookGross], {
    splits: [{ period_label: 'Period 84', principal_amount: 1, interest_amount: 0, total_amount: 1 }],
  }))
  ok('an undateable period label refuses rather than guessing',
     r.verdict === 'not_enough_evidence', r.verdict)
  ok('...and says which way the error would have gone',
     /overstate .* understate|understate .* overstate/.test(r.plain_english), r.plain_english.slice(0, 140))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
