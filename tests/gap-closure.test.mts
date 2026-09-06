// tests/gap-closure.test.mts — session 279
//
// The tie-out's "did the later entries account for the gap" test, measured over
// the right window. Every fixture below is a real shape off this book, with the
// figures confirmed against Xero's own line items on 2026-09-06.
//
// Run:  npx tsx tests/gap-closure.test.mts

import { walkToClosure, CLOSURE_TOL } from '../supabase/functions/_shared/gap-closure.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}`)

// The old test, kept verbatim so every claim below is measured against the thing
// it replaced rather than against a description of it.
const netClosed = (diff: number, es: { date: string; effect: number }[]) =>
  es.length > 0 && Math.abs(Math.round((diff + es.reduce((s, e) => s + e.effect, 0)) * 100) / 100) < 0.02

section('PCV 202555 — the first payment closes it, the second overshoots')
{
  const diff = 5335.52
  const entries = [
    { date: '2026-08-03', effect: -5335.52 },  // line on account 254, exact
    { date: '2026-09-01', effect: -5357.75 },
  ]
  const r = walkToClosure(diff, entries)
  ok('⭐ closed, on the day the money arrived', r.closed_on === '2026-08-03', String(r.closed_on))
  ok('...after exactly one entry', r.closed_after_entries === 1, String(r.closed_after_entries))
  ok('...and the full residual is still reported for anyone who needs it',
     Math.abs(r.residual_after_all - -5357.75) < 0.005, String(r.residual_after_all))
  ok('⭐ CONTROL: the old net test does NOT close this — the defect, reproduced',
     netClosed(diff, entries) === false)
}

section('BayFirst SBA Loan — same shape, and it is blocking a real close')
{
  const diff = 971.56
  const entries = [
    { date: '2026-08-06', effect: -971.56 },   // line on account 243, exact
    { date: '2026-08-20', effect: -1046.56 },
  ]
  const r = walkToClosure(diff, entries)
  ok('⭐ closed on 2026-08-06', r.closed_on === '2026-08-06', String(r.closed_on))
  ok('⭐ CONTROL: the old net test does NOT close this either',
     netClosed(diff, entries) === false)
}

section('the Fords cannot move — no later entries, by construction')
{
  for (const [name, diff] of [['4140', 415.88], ['E5-4751', 266.42], ['E4-9744', 182.00]] as [string, number][]) {
    const r = walkToClosure(diff, [])
    ok(`${name}: still an exception, and its prepared correction is untouched`,
       r.closed_on === null && r.closed_after_entries === 0 && Math.abs(r.residual_after_all - diff) < 0.005)
  }
}

section('MONOTONE — this can never un-explain something')
{
  // The full set is itself a prefix, so anything the old test closed must still
  // close. Asserted over a spread rather than one case, because "monotone" is a
  // property of the function and a single example is an anecdote.
  const spreads: { diff: number; es: { date: string; effect: number }[] }[] = [
    { diff: 100, es: [{ date: 'a', effect: -100 }] },
    { diff: 100, es: [{ date: 'a', effect: -40 }, { date: 'b', effect: -60 }] },
    { diff: 100, es: [{ date: 'a', effect: -60 }, { date: 'b', effect: -40 }] },
    { diff: 0.5, es: [{ date: 'a', effect: -0.5 }] },
    { diff: -250, es: [{ date: 'a', effect: 250 }] },
    { diff: 100, es: [{ date: 'a', effect: -100 }, { date: 'b', effect: -100 }, { date: 'c', effect: 100 }] },
    // The PCV / BayFirst shape: first entry closes it, a later one overshoots.
    // Without this the spread cannot tell the two tests apart at all, and the
    // "closes cases the old one could not" assertion is satisfied by nothing.
    { diff: 100, es: [{ date: 'a', effect: -100 }, { date: 'b', effect: -120 }] },
    { diff: 5335.52, es: [{ date: 'a', effect: -5335.52 }, { date: 'b', effect: -5357.75 }] },
  ]
  const broken = spreads.filter(s => netClosed(s.diff, s.es) && walkToClosure(s.diff, s.es).closed_on === null)
  ok('⭐ everything the old test explained, this still explains',
     broken.length === 0, JSON.stringify(broken))

  // And the reverse is exactly what it is for.
  const newlyClosed = spreads.filter(s => !netClosed(s.diff, s.es) && walkToClosure(s.diff, s.es).closed_on !== null)
  ok('...and it closes cases the old one could not', newlyClosed.length > 0,
     String(newlyClosed.length))
}

section('it does not close what it should not')
{
  const near = walkToClosure(100, [{ date: 'a', effect: -99.95 }])
  ok('a gap left 5c open is NOT closed — no tolerance creep',
     near.closed_on === null, JSON.stringify(near))
  ok('...and the tolerance is still the tie-out’s own 0.02', CLOSURE_TOL === 0.02)

  const wrongWay = walkToClosure(100, [{ date: 'a', effect: 100 }])
  ok('an entry moving the wrong way never closes a gap', wrongWay.closed_on === null)

  ok('no entries at all closes nothing', walkToClosure(100, []).closed_on === null)
  ok('...and a zero gap is the caller’s business, not this walk’s',
     walkToClosure(0, []).closed_on === null)
}

section('it stops at the FIRST close, not the last')
{
  // Two entries each of which would close it. Reporting the later date would
  // misdate the evidence a person is being asked to trust.
  const r = walkToClosure(100, [
    { date: '2026-01-01', effect: -100 },
    { date: '2026-02-01', effect: -100 },
    { date: '2026-03-01', effect: 100 },
  ])
  ok('⭐ the date reported is the first one', r.closed_on === '2026-01-01', String(r.closed_on))
  ok('...and the count matches that date', r.closed_after_entries === 1, String(r.closed_after_entries))
}

console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(60)}`)
process.exit(fail === 0 ? 0 : 1)
