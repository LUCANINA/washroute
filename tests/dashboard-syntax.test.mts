// tests/dashboard-syntax.test.mts — do the four SPAs PARSE? (session 272)
//
// tests/edge-function-syntax.test.mts asks this of every edge function, because
// on 2026-09-03 a duplicate `const` stopped reconciliation-run from booting for
// eleven hours while the suite stayed green. The four dashboards had no such
// check, and they are the bigger risk: they are single 2-3MB files edited by
// search-and-replace, a duplicate declaration anywhere in one kills the ENTIRE
// script, and the symptom is not an error message — it is a blank page, or a
// button that does nothing.
//
// This file exists because that happened during session 272. A new
// `const _bkMonthLabel` was added ten thousand lines away from the
// `function _bkMonthLabel` that already existed. Nothing in the suite could see
// it; the harness reported `showPage is not defined`, which is what a dead script
// looks like from the outside and names nothing useful.
//
// The check is cheap: pull each inline <script> out of the HTML and hand it to
// node's own syntax checker, which reports early errors — duplicate declarations
// among them. It cannot prove the page WORKS. It proves the page is a program,
// which is the thing that was being assumed.
//
// Run:  node --experimental-strip-types tests/dashboard-syntax.test.mts

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const APPS = ['admin-dashboard', 'customer-app', 'driver-app', 'pos']
const dir = mkdtempSync(join(tmpdir(), 'spa-syntax-'))

// Inline scripts only. A `src=` script is someone else's file, and a
// type="module"/JSON block is not the thing that breaks this way.
function inlineScripts(html: string): string[] {
  const out: string[] = []
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = m[1] || ''
    if (/type\s*=\s*["'](?!text\/javascript|application\/javascript)/i.test(attrs)) continue
    if (m[2].trim()) out.push(m[2])
  }
  return out
}

function checkSource(src: string): string | null {
  const file = join(dir, `chunk-${Math.random().toString(16).slice(2)}.js`)
  writeFileSync(file, src)
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); return null }
  catch (e: any) { return String(e.stderr || e.message || e) }
}

section('every SPA is a program')
let checked = 0
for (const app of APPS) {
  const path = new URL(`../${app}/index.html`, import.meta.url)
  let html: string
  try { html = readFileSync(path, 'utf8') } catch { ok(`${app}/index.html exists`, false); continue }
  const scripts = inlineScripts(html)
  ok(`${app}: has inline script to check`, scripts.length > 0, `found ${scripts.length}`)
  scripts.forEach((s, i) => {
    checked++
    const err = checkSource(s)
    // The first line of node's error names the identifier and the line, which is
    // the whole value of this test over "the page didn't work".
    ok(`${app}: inline script ${i + 1} parses (${s.length.toLocaleString()} chars)`, err === null,
      err ? err.split('\n').slice(0, 6).join(' / ') : '')
  })
}
ok('something was actually checked — a green run that tested nothing is not green', checked > 0)

section('IT DISCRIMINATES — the real defect, reproduced')
{
  // The exact shape from session 272: a `const` added far away from an existing
  // `function` of the same name. Both are legal alone; together they are fatal.
  const broken = `function _bkMonthLabel(ym) { return ym; }\n${'\n'.repeat(50)}const _bkMonthLabel = (ym) => ym;\n`
  const err = checkSource(broken)
  ok('a duplicate declaration is caught', err !== null)
  ok('...and named for what it is', !!err && /has already been declared/.test(err), (err || '').split('\n')[3])
  ok('...and the identifier is named', !!err && /_bkMonthLabel/.test(err))
  ok('the fixed shape passes', checkSource(`function _bkMonthLabel(ym) { return ym; }\n`) === null)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
