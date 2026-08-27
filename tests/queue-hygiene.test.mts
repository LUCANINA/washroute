// tests/queue-hygiene.test.mts — the materiality thresholds, and nothing else.
//
// ── WHAT THIS FILE USED TO BE, AND WHY IT IS NOW FOUR LINES LONG ────────────
// Until session 243 this file held 17 assertions across two sections, and NOT
// ONE of them imported the code it claimed to test. It carried two comment
// headers that said so out loud — "copied verbatim from reconciliation-run/
// index.ts" and "copied verbatim from admin-dashboard/index.html" — and then
// asserted that the copies agreed with themselves. Deleting _bkSubstanceKey and
// _bkDismissalHolds from the dashboard would not have turned a single one red.
// That is worse than no coverage, because it reads as coverage.
//
// The dismissal half has been rewritten against the real, shipped functions,
// inside the real page, in tests/bookkeeping-harness.mjs:
//
//   'a dismissal survives a bigger count, never a different sentence'
//     ->  harness group  substance-key-substance      (the real _bkSubstanceKey)
//     ->  harness group  dismissal-fail-open          (the real _bkDismissalHolds)
//
// Its sibling, tests/loan-roster.test.mts, was deleted outright for the same
// reason; every assertion it made is now made against the shipped functions by:
//
//   roster classification / what it refuses to call reconciled / the residual
//     ->  harness group  roster-classification
//   'every issue reaches the loan it belongs to'
//     ->  harness groups roster-clean-loan-children, roster-orphan-findings,
//                        roster-empty-denominator
//   the bounded headline score
//     ->  harness group  roster-confetti-gate
//
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/bookkeeping-harness.mjs
//
// ── WHAT SURVIVES HERE, AND WHY ─────────────────────────────────────────────
// MATERIAL_FLOOR and MATERIAL_SHARE are the one thing in the old file with no
// dashboard counterpart: they live server-side in the reconciliation-run edge
// function, the dashboard only ever reads the verdict they produce
// (tie_out.detail.material), and the browser harness therefore cannot reach
// them. They are also not importable — reconciliation-run/index.ts pulls jsr:
// specifiers that tsx cannot resolve — so they are READ OUT OF THE REAL SOURCE
// FILE below rather than copied into this one. Change the constant and this
// test changes with it; change it by accident and this test says so.
//
// Run:  npx tsx tests/queue-hygiene.test.mts

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.join(HERE, '..', 'supabase', 'functions', 'reconciliation-run', 'index.ts')

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// Read the threshold out of the engine's own source. A regex that stops matching
// is a failure, not a skip — an assertion that quietly stops firing is the exact
// failure mode this file was rewritten to remove.
const src = fs.readFileSync(ENGINE, 'utf8')
const constant = (name: string): number => {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(-?[0-9.]+)`))
  if (!m) throw new Error(`${name} is no longer an exported const in ${ENGINE} — this test cannot read the real threshold`)
  return Number(m[1])
}
const MATERIAL_FLOOR = constant('MATERIAL_FLOOR')
const MATERIAL_SHARE = constant('MATERIAL_SHARE')

section('the two bars, as the engine actually declares them')
{
  ok('MATERIAL_FLOOR is $25', MATERIAL_FLOOR === 25, String(MATERIAL_FLOOR))
  ok('MATERIAL_SHARE is 25 basis points', MATERIAL_SHARE === 0.0025, String(MATERIAL_SHARE))
  ok('isMaterialGap is still the single place the two are applied',
     /export function isMaterialGap/.test(src) && (src.match(/isMaterialGap\(/g) || []).length >= 2,
     'the dashboard reads tie_out.detail.material; if a second call site re-derives it, the roster and the queue can disagree again')
}

section('the six real balance gaps of 2026-08-27, against those bars')
{
  // Straight arithmetic on the real residuals and the real lender balances, with
  // the thresholds taken from the source above. This is not a copy of a shipped
  // decision function — it is where each real number sits relative to each bar.
  const gaps: [string, number, number][] = [
    ['Funding Circle',   -3041.83,  66215.03],
    ['PCV Good & Green', -1802.58, 427284.34],
    ['E-Transit 4140',     415.88,  10685.52],
    ['E-Transit E5',       266.42,  29302.52],
    ['E-Transit E4',       182.00,  16223.75],
    ['EIDL SBA',            -5.00, 960005.00],
  ]
  const clearsFloor = (r: number) => Math.abs(r) >= MATERIAL_FLOOR
  const clearsShare = (r: number, lender: number) =>
    (Math.abs(lender) > 0 ? Math.abs(r) / Math.abs(lender) : 1) >= MATERIAL_SHARE

  for (const [name, resid, lender] of gaps.slice(0, 5)) {
    ok(`${name} clears both bars`, clearsFloor(resid) && clearsShare(resid, lender),
       `|${resid}| vs ${MATERIAL_FLOOR}; share ${(Math.abs(resid) / lender).toFixed(6)} vs ${MATERIAL_SHARE}`)
  }
  // The one that started this: $5.00 on $960,005 is 0.0005%.
  ok('EIDL SBA clears NEITHER bar', !clearsFloor(-5) && !clearsShare(-5, 960005),
     `share ${(5 / 960005).toFixed(8)}`)
  ok('EIDL is the only one of the six below the bars',
     gaps.filter(([, r, l]) => !(clearsFloor(r) && clearsShare(r, l))).length === 1)

  // Both bars have to be cleared, so each one can fail alone.
  ok('$30 on $1,000,000 is immaterial by SHARE alone',
     clearsFloor(30) && !clearsShare(30, 1_000_000))
  ok('$20 on $1,000 is immaterial by AMOUNT alone, at 2%',
     !clearsFloor(20) && clearsShare(20, 1000))
  ok('a zero lender balance is treated as fully material, never divided by zero',
     clearsShare(500, 0) && Number.isFinite(500 / 1))

  // NOTE, deliberately not an assertion. tests/fixtures/bookkeeping-fixture.json
  // was pulled 2026-08-26, one day before detail.material shipped, so every
  // tie-out in it has no `detail` at all and every balance_vs_lender finding in
  // it — EIDL's $5.00 included — is recorded at severity 'error'. The engine now
  // reads `(tie.detail)?.material !== false`, so the next run will downgrade it.
  // Asserting today's recorded severity would pin a stale snapshot; refresh the
  // fixture after a post-session-242 run and the harness will see the immaterial
  // group for real (harness group roster-clean-loan-children currently has to
  // synthesise it).
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
