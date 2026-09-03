// tests/edge-function-syntax.test.mts — does it PARSE (session 265)
//
// On 2026-09-03 reconciliation-run was dead for eleven and a half hours. Not
// subtly wrong: it did not start. Commit 6adff69 added a `loan_book_balances`
// read destructured as `bookBalances`, into the same scope as the run's own
// `const bookBalances: any[] = []`, and Deno refused the module:
//
//     worker boot error: Uncaught SyntaxError:
//     Identifier 'bookBalances' has already been declared
//
// Every call answered 503 on the CORS preflight, which the dashboard renders as
// "Check failed: Failed to fetch".
//
// THE PART THAT MATTERS FOR THIS FILE. The suite was green throughout, and
// tests/book-balances.test.mts specifically asserted that reconciliation-run
// "loads it" — by grepping the source for `from('loan_book_balances')`. That
// string was present. The function could not run. A grep proves a line exists;
// it cannot prove the file is a program. So does the START HERE deploy note,
// which recorded the deploy as done because the version number had changed.
//
// This suite closes that gap the cheapest way there is: strip the types, then
// hand the result to node's own syntax checker, which reports early errors —
// duplicate declarations among them.
//
// Run:  node --experimental-strip-types tests/edge-function-syntax.test.mts

import { stripTypeScriptTypes } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const FUNCTIONS = new URL('../supabase/functions/', import.meta.url)
const scratch = mkdtempSync(join(tmpdir(), 'wr-syntax-'))

/** Returns null when the source is a valid module, or the error message. */
function syntaxErrorIn(source: string, label: string): string | null {
  let stripped: string
  try {
    stripped = stripTypeScriptTypes(source)
  } catch (e) {
    return `type-strip failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`
  }
  const f = join(scratch, label.replace(/[^\w.-]/g, '_') + '.mjs')
  writeFileSync(f, stripped)
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (e) {
    const err = String((e as { stderr?: Buffer })?.stderr ?? e)
    const line = err.split('\n').find(l => /Error:/.test(l)) ?? err.slice(0, 200)
    return line.trim()
  }
}

section('every edge function is a program')
{
  const dirs = readdirSync(FUNCTIONS, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '_shared')
    .map(d => d.name)
    .sort()

  ok('there are edge functions to check', dirs.length > 0, String(dirs.length))

  let checked = 0
  const broken: string[] = []
  for (const name of dirs) {
    const path = new URL(`${name}/index.ts`, FUNCTIONS)
    if (!existsSync(path)) continue     // deployed-only functions are not in the repo
    checked++
    const err = syntaxErrorIn(readFileSync(path, 'utf8'), name)
    if (err) broken.push(`${name}: ${err}`)
  }
  ok(`${checked} functions parsed`, checked > 20, `checked=${checked}`)
  ok('none has a syntax error', broken.length === 0, broken.join(' | '))
}

section('every shared module is a program')
{
  const shared = readdirSync(new URL('_shared/', FUNCTIONS))
    .filter(f => f.endsWith('.ts')).sort()
  const broken: string[] = []
  for (const f of shared) {
    const err = syntaxErrorIn(readFileSync(new URL(`_shared/${f}`, FUNCTIONS), 'utf8'), `shared-${f}`)
    if (err) broken.push(`${f}: ${err}`)
  }
  ok(`${shared.length} shared modules parsed`, shared.length > 0)
  ok('none has a syntax error', broken.length === 0, broken.join(' | '))
}

section('IT DISCRIMINATES — the real defect, reproduced')
{
  // Not a synthetic example: this is the exact shape of 6adff69, a destructured
  // binding colliding with an accumulator declared later in the same scope. An
  // assertion that stays green against the broken code is decoration.
  const defect = `
    export async function run(supa: any) {
      const [{ data: bookBalances }] = await Promise.all([supa.from('loan_book_balances').select('*')])
      const tieOuts: any[] = []
      const bookBalances: any[] = []
      return { bookBalances, tieOuts }
    }
  `
  const err = syntaxErrorIn(defect, 'defect')
  ok('the duplicate declaration is caught', err !== null, 'no error reported')
  ok('...and named for what it is',
     /already been declared/.test(String(err)), String(err))

  // And the same file WITHOUT the collision must come back clean, or the check
  // is just refusing everything.
  const fixed = defect.replace('data: bookBalances', 'data: bookBalanceRows')
  ok('the fixed shape passes', syntaxErrorIn(fixed, 'fixed') === null)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail === 0 ? 0 : 1)
