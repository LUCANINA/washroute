// tests/portal-figures.test.mts — figures transcribed off a lender's screen.
//
// The bug that caused this file: a loan-details screenshot and a deposit
// screenshot were uploaded in the same bundle. Both stated an "amount
// remaining". They disagreed. The merge kept the first one it saw and dropped
// the other silently, and the plan reported the lender's balance as $125,000.00
// against a true $123,091.66.
//
// Run:  npx tsx tests/portal-figures.test.mts

import { checkPortalTotals, mergePortal, describeScreenshot, type PortalTotals } from '../supabase/functions/_shared/portal-figures.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const blank = (o: Partial<PortalTotals> = {}): PortalTotals => ({
  as_of: null, amount_remaining: null, paid_to_date: null, principal_paid: null,
  fee_paid: null, total_amount_due: null, funds_deposited: null,
  funds_deposited_date: null, sources: [], checks: [], warnings: [], disputes: [], ...o,
})

section('the $125,000 bug, pinned')
{
  // The two real screens from session 242's bundle.
  const details = blank({ sources: ['Stripe loan details.png'], amount_remaining: 123091.66 })
  const deposit = blank({ sources: ['Stripe deposit.png'], amount_remaining: 125000.00, funds_deposited: 125000.00 })

  const m = mergePortal(details, deposit)
  ok('the disputed balance is DROPPED, not picked', m.amount_remaining === null, `got ${m.amount_remaining}`)
  ok('the disagreement is reported', m.disputes.some(w => /disagree about the balance still owed/.test(w)))
  ok('...naming both files', m.disputes.some(w => /Stripe loan details\.png/.test(w) && /Stripe deposit\.png/.test(w)))
  ok('...naming both figures', m.disputes.some(w => /\$123,091\.66/.test(w) && /\$125,000\.00/.test(w)))
  ok('a figure only ONE screen states still comes through', m.funds_deposited === 125000)
  // A cross-document dispute must NOT be filed as "this screen failed its own
  // arithmetic" — different problem, different fix, different question to ask.
  ok('the dispute is not filed as a self-check failure', m.warnings.length === 0)

  // Order must not change the answer — this is the property the old code broke.
  const rev = mergePortal(deposit, details)
  ok('reversing the upload order gives the same answer', rev.amount_remaining === null)
  ok('...and still warns', rev.disputes.length === m.disputes.length)
}

section('two screens that AGREE are corroboration')
{
  const a = blank({ sources: ['a.png'], amount_remaining: 123091.66 })
  const b = blank({ sources: ['b.png'], amount_remaining: 123091.66 })
  const m = mergePortal(a, b)
  ok('the figure survives', m.amount_remaining === 123091.66)
  ok('and the agreement is said out loud', m.checks.some(c => /Two of the lender's own screens agree/.test(c)))
  ok('no warning raised', m.warnings.length === 0 && m.disputes.length === 0)

  // A cent of rounding between two screens is agreement, not a conflict.
  const near = mergePortal(a, blank({ sources: ['c.png'], amount_remaining: 123091.68 }))
  ok('a 2-cent difference is treated as agreement', near.amount_remaining === 123091.66)
}

section('filling gaps — the reason merging exists at all')
{
  const terms   = blank({ sources: ['terms.png'], total_amount_due: 145875, amount_remaining: 123091.66 })
  const funding = blank({ sources: ['funding.png'], funds_deposited: 125000, funds_deposited_date: '2026-06-30' })
  const m = mergePortal(terms, funding)
  ok('figures from both screens are present', m.total_amount_due === 145875 && m.funds_deposited === 125000)
  ok('the balance is untouched', m.amount_remaining === 123091.66)
  ok('the deposit date comes through', m.funds_deposited_date === '2026-06-30')
  ok('nothing is warned about', m.warnings.length === 0 && m.disputes.length === 0)
  ok('both sources are recorded', m.sources.length === 2)
}

section('dates')
{
  const a = blank({ sources: ['a.png'], as_of: '2026-07-31', amount_remaining: 123091.66 })
  const b = blank({ sources: ['b.png'], as_of: '2026-08-15' })
  const m = mergePortal(a, b)
  ok('the LATER date wins', m.as_of === '2026-08-15', `got ${m.as_of}`)
  ok('...and the person is told the figures span two moments',
     m.disputes.some(w => /different days/.test(w)))

  const same = mergePortal(a, blank({ sources: ['c.png'], as_of: '2026-07-31' }))
  ok('the same date raises nothing', same.disputes.length === 0)

  const dd = mergePortal(
    blank({ sources: ['a.png'], funds_deposited_date: '2026-06-30' }),
    blank({ sources: ['b.png'], funds_deposited_date: '2026-07-01' }))
  ok('conflicting deposit dates are dropped', dd.funds_deposited_date === null)
  ok('...and reported', dd.disputes.some(w => /different deposit dates/.test(w)))
}

section('a screen must agree with ITSELF first')
{
  const good = checkPortalTotals(blank({
    principal_paid: 20000, fee_paid: 1908.34, paid_to_date: 21908.34,
    total_amount_due: 145000, amount_remaining: 123091.66,
  }))
  ok('parts that add up are kept', good.paid_to_date === 21908.34)
  ok('...and the sum is stated', good.checks.some(c => /parts add up/.test(c)))

  const bad = checkPortalTotals(blank({
    principal_paid: 20000, fee_paid: 1908.34, paid_to_date: 99999,
  }))
  ok('parts that do not add up are dropped, all three',
     bad.principal_paid === null && bad.fee_paid === null && bad.paid_to_date === null)
  ok('...and the drop is explained', bad.warnings.some(w => /do not add up/.test(w)))

  const badBal = checkPortalTotals(blank({
    total_amount_due: 145000, paid_to_date: 21908.34, amount_remaining: 999999,
  }))
  ok('a balance that does not tie is dropped', badBal.amount_remaining === null)
  ok('...but the figures it was checked against survive',
     badBal.total_amount_due === 145000 && badBal.paid_to_date === 21908.34)
}

section('merging never invents')
{
  const empty = mergePortal(blank(), blank())
  ok('two empty screens stay empty',
     Object.entries(empty).every(([k, v]) => ['checks','warnings','disputes','sources'].includes(k) ? true : v === null))
  ok('...with nothing to report', empty.warnings.length === 0 && empty.disputes.length === 0 && empty.checks.length === 0)

  // A zero is a figure, not an absence. `?? ` handled this correctly; a truthiness
  // test would not, and this pins it.
  const z = mergePortal(blank({ sources: ['a.png'], amount_remaining: 0 }),
                        blank({ sources: ['b.png'], amount_remaining: 500 }))
  ok('a stated $0.00 conflicts with $500 rather than yielding to it', z.amount_remaining === null)
  const z2 = mergePortal(blank({ sources: ['a.png'], amount_remaining: 0 }), blank({ sources: ['b.png'] }))
  ok('a paid-off $0.00 balance survives on its own', z2.amount_remaining === 0)
}

section('a funding figure read into the balance field')
{
  // Exactly what Stripe deposit.png did: $125,000 reported as BOTH the funding
  // advanced and the balance still owed, with nothing else on the screen.
  const dep = checkPortalTotals(blank({
    sources: ['Stripe deposit.png'], funds_deposited: 125000, amount_remaining: 125000,
  }))
  ok('the balance is dropped', dep.amount_remaining === null)
  ok('the funding amount is kept', dep.funds_deposited === 125000)
  ok('and the reason is given', dep.warnings.some(w => /one number read twice on a funding screen/.test(w)))

  // The guard must NOT fire when the screen carries something to tell them apart.
  const real = checkPortalTotals(blank({
    sources: ['overview.png'], funds_deposited: 125000, amount_remaining: 123091.66,
    total_amount_due: 145875, paid_to_date: 22783.34,
  }))
  ok('a screen with real corroboration is untouched', real.amount_remaining === 123091.66)

  // Equal figures are fine when paid-to-date is there to make sense of them.
  const dayOne = checkPortalTotals(blank({
    sources: ['dayone.png'], funds_deposited: 125000, amount_remaining: 125000, paid_to_date: 0,
    total_amount_due: 125000,
  }))
  ok('equal figures survive when paid-to-date is shown', dayOne.amount_remaining === 125000)

  // A deposit screen with no balance claim at all is left alone.
  const clean = checkPortalTotals(blank({ sources: ['d.png'], funds_deposited: 125000 }))
  ok('a funding-only screen raises nothing', clean.warnings.length === 0 && clean.funds_deposited === 125000)

  // THE POINT: with the bad reading dropped at source, the good screen's balance
  // survives the merge instead of both being killed as a disagreement.
  const overview = blank({ sources: ['Stripe overview.png'], amount_remaining: 123091.66 })
  const merged = mergePortal(overview, dep)
  ok('the good balance now survives the merge', merged.amount_remaining === 123091.66)
  ok('...with no disagreement raised', merged.disputes.length === 0)
}

section('a screenshot is described by what is actually on it')
{
  ok('a funding screen is not called a statement of the balance',
     describeScreenshot(blank({ funds_deposited: 125000 })) ===
     `The lender's own screen — the funding it advanced. It says what arrived, not what is still owed.`)
  ok('a balance screen is called one',
     /what is still owed/.test(describeScreenshot(blank({ amount_remaining: 123091.66 }))))
  ok('a screen carrying both says both',
     /both what was advanced and what is still owed/.test(
       describeScreenshot(blank({ amount_remaining: 123091.66, funds_deposited: 125000 }))))
  ok('a screen with nothing readable says so',
     /nothing rests on it/.test(describeScreenshot(blank())))
  // The regression this replaces: the deposit screen used to get the balance
  // sentence, teaching the reader the very misreading the checks then caught.
  ok('the funding screen does NOT get the balance sentence',
     !/what is still owed, which is what the books/.test(describeScreenshot(blank({ funds_deposited: 125000 }))))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
