// tests/xero-metered.test.mts — every call to Xero goes through the meter.
//
// Run:  node --experimental-strip-types tests/xero-metered.test.mts
//
// WHY A GREP IS THE RIGHT TOOL HERE, AND WHAT IT HAS TO PROVE.
// The property is "no bare fetch to api.xero.com survives in a metered function".
// That is a fact about the SOURCE, not about a value any test can compute — running
// the function would only tell you about the branches that ran, and the dangerous
// call site is always the one on the branch nobody took (s231). So it greps.
//
// A grep-guard has to name its REGION and its COUNT (s289), because both failure
// modes are silent: a guard pointed at the wrong file passes forever, and one that
// finds zero call sites passes because there is nothing left to check. This asserts
// how many metered calls it FOUND as well as how many bare ones it did not, so
// deleting the integration turns it red instead of green.

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// THE REGION, named. These are the functions that spend the tenant's daily Xero
// budget in bulk. loan-xero-post and loan-bundle are NOT yet metered and are
// deliberately absent rather than silently passing: add them here when they are.
const METERED = [
  'reconciliation-run',
  'loan-find-difference',
  'xero-read',
]
const read = (fn: string) =>
  readFileSync(new URL(`../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8')

// A call to api.xero.com that does NOT go through the meter. Both spellings the
// codebase actually uses -- a template literal and a quoted string -- and the
// `${XERO}` / `${baseUrl}` forms, which is how every one of these is really written.
const BARE = /(?<!meter\.)\bfetch\(\s*[`'"](?:https:\/\/api\.xero\.com|\$\{XERO\})/g
const METERED_CALL = /meter\.fetch\(/g

console.log('\n  every Xero call in a metered function is counted')
let totalMetered = 0
for (const fn of METERED) {
  const src = read(fn)
  const bare = [...src.matchAll(BARE)]
  const counted = [...src.matchAll(METERED_CALL)]
  totalMetered += counted.length
  ok(`${fn}: no bare fetch to Xero`, bare.length === 0,
    bare.length ? `${bare.length} unmetered call site(s)` : '')
  // The population guard. Without it, a file that stopped calling Xero at all --
  // or a path typo above -- would satisfy the assertion by having nothing to find.
  ok(`${fn}: and it actually has metered calls to check (${counted.length})`, counted.length > 0)
  ok(`${fn}: creates its own meter per invocation, not at module scope`,
    /createXeroMeter\(/.test(src) && !/^const\s+\w*[Mm]eter\s*=\s*createXeroMeter/m.test(src))
  ok(`${fn}: flushes in a finally — a call that threw still spent what it spent`,
    /\}\s*finally\s*\{[\s\S]{0,600}?meter\.flush\(/.test(src))
}
ok(`the region is not empty: ${totalMetered} metered call sites across ${METERED.length} functions`,
  totalMetered >= 10, String(totalMetered))

console.log('\n  IT DISCRIMINATES — a bare call reintroduced')
const withBare = read('reconciliation-run')
  .replace('await meter.fetch(`https://api.xero.com/api.xro/2.0/Reports/TrialBalance', 'await fetch(`https://api.xero.com/api.xro/2.0/Reports/TrialBalance')
ok('the mutation actually changed the source', withBare !== read('reconciliation-run'))
ok('...and the pattern catches it', [...withBare.matchAll(BARE)].length === 1,
  String([...withBare.matchAll(BARE)].length))
ok('the ${XERO} spelling is caught too — xero-read writes them that way',
  [...'const r = await fetch(`${XERO}/Accounts`)'.matchAll(BARE)].length === 1)
ok('and meter.fetch is NOT mistaken for a bare one',
  [...'await meter.fetch(`https://api.xero.com/x`)'.matchAll(BARE)].length === 0)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
