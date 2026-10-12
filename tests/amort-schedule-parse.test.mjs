// Session 344 -- the dashboard's amortization-schedule reader, tested against the
// SHIPPED code (no transcription): the three functions are cut out of
// admin-dashboard/index.html and evaluated as-is, then fed the text pdf.js 3.11.174
// extracts from real lender PDFs (tests/fixtures/amort-text/*.txt, extracted exactly
// as _extractPdfText does: items joined by ' ', pages by '\n').
//
// Why it exists: Dexter Financial's 2026-10-07 schedule (rate 6.64% -> 9.39% -> 9.64%)
// could not be read -- a "Cash Payment" label sits between each date and its figures,
// and Dexter prints interest before principal -- so the upload fell through to "keep on
// file", the loan kept staging off the superseded schedule, and a re-upload hit the
// file-hash unique index as a raw Postgres error.
//
//   node tests/amort-schedule-parse.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'admin-dashboard/index.html'), 'utf8')
const fx = (n) => fs.readFileSync(path.join(root, 'tests/fixtures/amort-text', n), 'utf8')

function grab(marker) {
  const i = src.indexOf(marker)
  if (i < 0) throw new Error('not found in index.html: ' + marker)
  if (marker.startsWith('const')) return src.slice(i, src.indexOf('];', i) + 2)
  let k = src.indexOf('{', i), d = 0
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) break }
  return src.slice(i, k + 1)
}
const code = ['function _deGarblePdfText(', 'const _AMORT_LAYOUTS', 'function _parseAmortizationSchedule(', 'function _scoreAmortLayout(']
  .map(grab).join('\n')
// `layoutFilter` lets the discrimination check run the SAME shipped code with a layout removed.
const build = (layoutFilter) => new Function('layoutFilter', code.replace('const _AMORT_LAYOUTS', 'const _AMORT_LAYOUTS_ALL') +
  '\nconst _AMORT_LAYOUTS = layoutFilter ? _AMORT_LAYOUTS_ALL.filter(layoutFilter) : _AMORT_LAYOUTS_ALL;' +
  '\nreturn _parseAmortizationSchedule;')(layoutFilter)
const parse = build(null)

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++ } else { fail++; console.log('FAIL', msg) } }
const hash = (rows) => crypto.createHash('md5').update(JSON.stringify(rows)).digest('hex')

// 1. Dexter 2, schedule dated 2026-10-07
const dx = parse(fx('dexter2-2026-10-07.txt'))
ok(dx && dx.verified, 'Dexter schedule verifies')
ok(dx && dx.layout === 'payment,interest,principal,balance', 'Dexter column order is payment,interest,principal,balance -- got ' + (dx && dx.layout))
ok(dx && dx.rows.length === 86, '86 payment rows (3 in Sep 2021 + Oct 2021..Aug 2028) -- got ' + (dx && dx.rows.length))
ok(dx && dx.checks.balance_continuity === '85/85' && dx.checks.principal_plus_interest === '86/86', 'every row adds up: ' + JSON.stringify(dx && dx.checks))
const row = (d) => dx && dx.rows.find(r => r.row_date === d)
const sep = row('2026-09-30'), oct = row('2026-10-31')
ok(sep && sep.payment === 3947.35 && sep.interest === 673.47 && sep.principal === 3273.88 && sep.balance === 82792.73, 'Sep 2026 = 3,947.35 (673.47 int / 3,273.88 prin): ' + JSON.stringify(sep))
ok(oct && oct.payment === 3956.84 && oct.interest === 664.55 && oct.principal === 3292.29, 'Oct 2026 = 3,956.84 at the 9.64% rate: ' + JSON.stringify(oct))
ok(dx && dx.rows.every(r => r.payment != null && r.balance > 0 || r.row_date === '2028-08-31'), 'rate-change rows (balance printed 0.00) are not read as payments')
ok(dx && dx.lastDate === '2028-08-31' && dx.closingBalance === 0, 'pays off 2028-08-31')

// 2. The schedules that already imported read EXACTLY as before (md5 of the rows the
//    pre-344 parser produced from the same text).
const pinned = {
  'pcv-2026-08-04.txt': ['56adfc13d95150f53478725f7e4f08fb', 'starting,payment,principal,interest,ending'],
  'verdant-2025-06-12.txt': ['d8dc5318bf266fbd8a24d10498e42da2', 'payment,principal,interest,balance'],
  'pcv-2026-09-03.txt': ['1ce4923389217530e36b3f2ef1fb8e84', 'starting,payment,principal,interest,ending'],
}
for (const [f, [h, layout]] of Object.entries(pinned)) {
  const r = parse(fx(f))
  ok(r && r.verified && r.layout === layout && hash(r.rows) === h, `${f} unchanged (${r && r.layout}, ${r && hash(r.rows)})`)
}

// 3. Discrimination -- each half of the fix is load-bearing.
const noDexterLayout = build(l => l.name !== 'payment,interest,principal,balance')(fx('dexter2-2026-10-07.txt'))
ok(!noDexterLayout || !noDexterLayout.verified, 'without the interest-first layout, Dexter must NOT verify')
const oldRegex = src.includes("(?:\\s+[A-Za-z][A-Za-z.&'\\/-]*")
ok(oldRegex, 'label-tolerant row regex is present')
const labelStripped = /(\d{1,2}\/\d{1,2}\/\d{4})((?:\s+\$?-?[\d,]+\.\d{2})+)/g
ok(!(fx('dexter2-2026-10-07.txt').match(labelStripped) || []).length, 'the pre-344 row regex matches zero Dexter rows (the original failure)')

// 4. Ambiguity is refused, not guessed: a table where interest == principal on every row
//    satisfies both 4-wide layouts.
const amb = ['01/31/2026 200.00 100.00 100.00 900.00', '02/28/2026 200.00 100.00 100.00 800.00',
  '03/31/2026 200.00 100.00 100.00 700.00', '04/30/2026 200.00 100.00 100.00 600.00'].join(' ')
const a = parse(amb)
ok(a && !a.verified && /ambiguous/.test(a.failures[0]), 'two layouts that both add up are refused as ambiguous')

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
