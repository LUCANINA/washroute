// tests/queue-hygiene.test.mts — the First Law, made executable.
//
// Two rules that decide whether a person's queue is worth reading, pinned against
// the REAL findings that were sitting in it on 2026-08-27.
//
// Run:  npx tsx tests/queue-hygiene.test.mts

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// ── copied verbatim from reconciliation-run/index.ts ────────────────────────
const MATERIAL_FLOOR = 25, MATERIAL_SHARE = 0.0025
const severity = (residual: number, lender: number, lagBenign = false) => {
  const share = Math.abs(lender) > 0 ? Math.abs(residual) / Math.abs(lender) : 1
  const material = Math.abs(residual) >= MATERIAL_FLOOR && share >= MATERIAL_SHARE
  return (!material || lagBenign) ? 'info' : 'error'
}

// ── copied verbatim from admin-dashboard/index.html ─────────────────────────
const substanceKey = (t: unknown) => String(t == null ? '' : t)
  .replace(/[0-9][0-9,.]*/g, '#')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
  .replace(/(\b[a-z]+?)s\b/g, '$1')
const dismissalHolds = (oldTitle: string, newTitle: string, isError: boolean) =>
  isError ? false : substanceKey(oldTitle) === substanceKey(newTitle)

section('materiality — the six real balance gaps of 2026-08-27')
{
  ok('Funding Circle  −$3,041.83 on $66,215 (4.6%)   -> error',
     severity(-3041.83, 66215.03) === 'error')
  ok('PCV             −$1,802.58 on $427,284 (0.42%) -> error',
     severity(-1802.58, 427284.34) === 'error')
  ok('E-Transit 4140   +$415.88 on $10,686 (3.9%)    -> error',
     severity(415.88, 10685.52) === 'error')
  ok('E-Transit E5     +$266.42 on $29,303 (0.9%)    -> error',
     severity(266.42, 29302.52) === 'error')
  ok('E-Transit E4     +$182.00 on $16,224 (1.1%)    -> error',
     severity(182.00, 16223.75) === 'error')
  // The one that started this.
  ok('EIDL SBA          −$5.00 on $960,005 (0.0005%) -> INFO',
     severity(-5.00, 960005.00) === 'info', severity(-5.00, 960005.00))

  ok('both bars must be cleared: $30 on $1,000,000 is immaterial by share',
     severity(30, 1_000_000) === 'info')
  ok('...and $20 on $1,000 is immaterial by amount, at 2%',
     severity(20, 1000) === 'info')
  ok('settlement lag still de-escalates a material gap',
     severity(-3041.83, 66215.03, true) === 'info')
  ok('a zero lender balance is treated as fully material, not divided by zero',
     severity(500, 0) === 'error')
}

section('a dismissal survives a bigger count, never a different sentence')
{
  // THE TREADMILL: David set all six aside on 2026-08-24 and every one returned,
  // because the CPA posted another correction and the counter moved.
  const v6 = 'Verdant Capital Loan — 6 hand-posted corrections totalling $572,400.13 since 2026-04-29'
  const v7 = 'Verdant Capital Loan — 7 hand-posted corrections totalling $580,112.44 since 2026-04-29'
  ok('6 corrections -> 7 corrections keeps the dismissal', dismissalHolds(v6, v7, false))

  // Singular to plural is still only a count change.
  const e1 = 'E-Transit Loan - 4140 — 1 hand-posted correction totalling $7,687.53 since 2026-04-29'
  const e2 = 'E-Transit Loan - 4140 — 2 hand-posted corrections totalling $9,000.00 since 2026-04-29'
  ok('1 correction -> 2 corrections keeps it too', dismissalHolds(e1, e2, false))

  // THE SESSION-233 CASE, which must still come back: same loan, same payment,
  // genuinely different claim. A dismissal here once hid ~$1,038 of missing
  // interest expense for four months.
  const oldFc = 'Funding Circle Loan — 2026-04-20 payment of $2,033.77 needs a statement from before 2026-08-03'
  const newFc = 'Funding Circle Loan — 2026-04-20 payment of $2,033.77 has no interest split'
  ok('a genuinely different sentence still comes back', !dismissalHolds(oldFc, newFc, false))

  // And escalation always wins, whatever the wording.
  ok('escalation to error breaks any dismissal', !dismissalHolds(v6, v6, true))
  ok('...even when the sentence is byte-identical', !dismissalHolds(v6, v6, true))

  // A different loan is a different finding.
  ok('a different loan does not share a dismissal',
     !dismissalHolds(v6, v6.replace('Verdant Capital', 'Dexter'), false))
  ok('an empty title does not match a real one', !dismissalHolds(v6, '', false))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
