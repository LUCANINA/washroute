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
import { deriveIncreaseCause } from '../supabase/functions/loan-find-difference/derive-cause.ts'

let pass = 0, fail = 0
const ok = (c: unknown, name: string, obs = '') => {
  if (c) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${obs ? `\n        ${obs}` : ''}`) }
}
const sec = (t: string) => console.log(`\n── ${t} `)

// The real EIDL rows, read off the fixture pulled 2026-09-08.
const EIDL = [
  { period_label: '2026-07', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2026-08', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2026-09', principal_amount: 0, interest_amount: 4791 },
  { period_label: '2024-03-22', principal_amount: 4791, interest_amount: 0 },
  { period_label: '2024-02-22', principal_amount: 1802.21, interest_amount: 2988.79 },
]
const HEAD = { difference: -5 }          // our books BELOW the lender
const WIN = '2026-04-25'                 // earliest usable statement

sec('it fires on the case it was written for')
const eidl = deriveIncreaseCause({ splits: EIDL, headline: HEAD, winFrom: WIN, residual: -5 })!
ok(eidl, 'EIDL produces a cause')
ok(eidl.months === 3, 'it read the three payments on file, not the six months of window', String(eidl?.months))

sec('⭐ IT NAMES THE MONTHS IT READ — NOT THE WINDOW IT MEANT TO READ')
ok(eidl.sentence.includes('from 2026-07 to 2026-09'),
   'the range is the payments that exist', eidl.sentence)
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
ok(/not the lender's/.test(eidl.working), "it is our record, and it says so — a check whose inputs share a source (s246)")
ok(/2026-07 \$0\.00 principal \/ \$4,791\.00 interest/.test(eidl.working), 'every row it read is in the working', eidl.working)
ok(/Tech Debt #46/.test(eidl.working), 'and it names what would give the claim an outside witness')

sec('it refuses where it has no business speaking')
ok(deriveIncreaseCause({ splits: EIDL, headline: { difference: 5 }, winFrom: WIN, residual: null }) === null,
   'our books ABOVE the lender is a different question — no cause offered')
ok(deriveIncreaseCause({ splits: EIDL, headline: { difference: -0.01 }, winFrom: WIN, residual: null }) === null,
   'a difference inside tolerance is not a difference')
ok(deriveIncreaseCause({ splits: [EIDL[0]], headline: HEAD, winFrom: WIN, residual: null }) === null,
   'one payment is arithmetic, not a pattern — two is the minimum')
ok(deriveIncreaseCause({
     splits: [EIDL[0], { period_label: '2026-08', principal_amount: 120, interest_amount: 4671 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   '⭐ ONE month applying principal kills the claim — "every one" has to mean every one')
ok(deriveIncreaseCause({
     splits: [{ period_label: 'Period 84', principal_amount: 0, interest_amount: 10 },
              { period_label: 'Period 85', principal_amount: 0, interest_amount: 10 }],
     headline: HEAD, winFrom: WIN, residual: null }) === null,
   'a period label carrying no date cannot be placed, so it is not counted (s230)')

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
process.exit(fail ? 1 : 0)
