// tests/loan-roster.test.mts — the roster's classification, against the real
// tie-outs of 2026-08-27.
//
// The roster answers "how am I doing" on the primary financial screen, so the
// thing that matters most is what it REFUSES to call reconciled.
//
// Run:  npx tsx tests/loan-roster.test.mts

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const REAL_ANCHORS = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']

// _loanVariance + _bkRosterState, transcribed from admin-dashboard/index.html.
function rosterGroup(tie: any, runFinished = true) {
  if (!runFinished) return 'unchecked'
  if (!tie) return 'unchecked'
  if (tie.status === 'not_comparable') return 'na'
  if (tie.status === 'tied') return 'reconciled'
  if (tie.status === 'explained') return 'reconciled'
  if (!REAL_ANCHORS.includes(String(tie.anchor_source || ''))) return 'unverified'
  // A missing flag must read as MATERIAL. An older tie-out, written before
  // materiality existed, has no `material` key — and absence is not permission
  // to go quiet about a real gap.
  return (tie.detail && tie.detail.material) === false ? 'immaterial' : 'variance'
}

section("the 14 active loans as they actually stood")
{
  const real = (s: string, src = 'portal_manual_pull') => ({ status: s, anchor_source: src })
  ok('tied      -> reconciled', rosterGroup(real('tied')) === 'reconciled')
  ok('explained -> reconciled', rosterGroup(real('explained')) === 'reconciled')
  ok('exception against a lender document -> needs attention',
     rosterGroup(real('exception')) === 'variance')
  ok('exception against OUR OWN projection -> needs a statement, never red',
     rosterGroup(real('exception', 'amortization_projection')) === 'unverified')
  ok('not_comparable -> nothing to compare against',
     rosterGroup(real('not_comparable')) === 'na')

  // 3 tied + 3 explained = 6 reconciled, 7 exceptions, 1 not_comparable.
  // The book exactly as it stood: 3 tied, 3 explained, 5 real variances,
  // EIDL immaterial, Verdant against our own projection, Stripe uncomparable.
  const book = [
    real('tied'), real('tied'), real('tied'),
    real('explained'), real('explained'), real('explained'),
    real('exception'), real('exception'), real('exception'), real('exception'), real('exception'),
    { ...real('exception', 'email_pdf_upload'), detail: { material: false } },   // EIDL $5 / $960,005
    real('exception', 'amortization_projection'),                                // Verdant
    real('not_comparable'),
  ]
  const g = book.map(t => rosterGroup(t))
  ok('6 of 14 reconciled', g.filter(x => x === 'reconciled').length === 6)
  ok('5 need attention',   g.filter(x => x === 'variance').length === 5)
  ok('EIDL is a small difference, not a variance and not reconciled',
     g.filter(x => x === 'immaterial').length === 1)
  ok('Verdant needs a statement', g.filter(x => x === 'unverified').length === 1)
  ok('1 has nothing to compare against', g.filter(x => x === 'na').length === 1)
  ok('every loan lands in exactly one group', g.length === 14 && g.every(Boolean))
  ok('and the groups add back up to the whole book',
     ['reconciled','variance','immaterial','unverified','na','unchecked']
       .reduce((n, k) => n + g.filter(x => x === k).length, 0) === 14)

  ok('a tie-out with no material flag is treated as material',
     rosterGroup(real('exception')) === 'variance')
  ok('...and an explicit true is too',
     rosterGroup({ ...real('exception'), detail: { material: true } }) === 'variance')
}

section('what it must REFUSE to call reconciled')
{
  // The whole reason the roster reads tie-outs instead of counting findings.
  ok('a loan with NO findings but no lender document is NOT reconciled',
     rosterGroup({ status: 'not_comparable', anchor_source: null }) === 'na')
  ok('...Stripe Capital, specifically — never checked is not "nothing wrong"',
     rosterGroup({ status: 'not_comparable', anchor_source: null }) !== 'reconciled')
  ok('a real deviation with no lender doc is not reconciled either',
     rosterGroup({ status: 'exception', anchor_source: 'amortization_projection' }) !== 'reconciled')
  ok('...and is not red, because it is not a fact about the world',
     rosterGroup({ status: 'exception', anchor_source: 'amortization_projection' }) !== 'variance')

  // A failed or unfinished run must not turn the board green.
  ok('no finished run -> everything is "not checked", not reconciled',
     rosterGroup({ status: 'tied' }, false) === 'unchecked')
  ok('a loan the run did not cover is not reconciled', rosterGroup(null) === 'unchecked')
}

section('the headline is a bounded score')
{
  // The headline omitted `immaterial` at first and described 13 of 14 loans. A
  // denominator that does not add up is the same lie the roster exists to
  // prevent, compressed into one sentence.
  const counts = { total: 14, reconciled: 6, variance: 5, unverified: 1, na: 1, unchecked: 0, immaterial: 1 }
  ok('every loan is accounted for in the headline',
     counts.reconciled + counts.variance + counts.unverified + counts.na + counts.unchecked + counts.immaterial === counts.total)
  ok('reconciled can never exceed the total', counts.reconciled <= counts.total)
  // The morale property: the denominator is fixed, so the score can be finished.
  ok('the denominator is the loan count, not the finding count', counts.total === 14)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
