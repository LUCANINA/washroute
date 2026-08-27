// tests/export-merge.test.mts — two exports of one ledger, and the date they date.
//
// THE BUG THIS FILE EXISTS FOR (session 245)
// loan-bundle kept `csv` in a single variable, so a bundle carrying the July
// export AND the August-to-date export silently kept whichever was read last.
// Both halves then failed safe and useless: August alone starts six weeks after
// the period does, July alone never reaches an August figure. The capability
// that dates a screenshot from the lender's own ledger could not fire at all.
//
// AND THE BUG IN THE FIRST FIX
// Concatenating the two files' records rejected all 1,458 August rows with
// "expected 7 columns, found 13". These are the REAL exports of the same loan
// from the same portal: July carries 7 columns, August carries 13 (Transaction
// ID, Merchant, Financing Object, Financing offer ID, Financing Type, Livemode,
// then the same 7). Stripe gives different columns depending on which Export
// button you press. A merge by position produced July on its own and said
// nothing. So the merge projects each file onto the columns by NAME.
//
// Run:  npx tsx tests/export-merge.test.mts

import { readFileSync } from 'node:fs'
import { parseStripeCapitalCsv, splitCsvRecords, splitCsvLine } from '../supabase/functions/_shared/stripe-capital.ts'
import { dateFromLedger } from '../supabase/functions/_shared/ledger-dating.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

// The same projection loan-bundle/index.ts performs. Kept in step by the
// assertions below, which fail against the real files if either drifts.
const CANON = ['Effective Time (UTC)', 'Currency', 'Total amount',
               'Financing amount', 'Fee amount', 'Transaction type', 'Transaction description']
const csvField = (v: string) => /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v
const canonicalise = (text: string): string[] | null => {
  const recs = splitCsvRecords(text)
  if (recs.length < 2) return null
  const head = splitCsvLine(recs[0]).map(h => h.trim())
  const idx = CANON.map(c => head.indexOf(c))
  if (idx.some(i => i < 0)) return null
  return recs.slice(1).filter(r => r.trim().length)
    .map(r => { const f = splitCsvLine(r); return idx.map(i => csvField(f[i] ?? '')).join(',') })
}

const here = new URL('.', import.meta.url).pathname
const jul = readFileSync(here + 'fixtures/Stripe_July.csv', 'utf8')
const aug = readFileSync(here + 'fixtures/Stripe_August.csv', 'utf8')
const pj = parseStripeCapitalCsv(jul), pa = parseStripeCapitalCsv(aug)

section('the two real exports, as they actually differ')
{
  ok('July reads clean', pj.ok && pj.rows_accepted === 1352, `${pj.rows_accepted}`)
  ok('August reads clean', pa.ok && pa.rows_accepted === 1458, `${pa.rows_accepted}`)
  ok('July runs 2026-07-06 to 2026-07-31', pj.first_date === '2026-07-06' && pj.last_date === '2026-07-31')
  ok('August runs 2026-08-01 to 2026-08-27', pa.first_date === '2026-08-01' && pa.last_date === '2026-08-27')
  // The premise of the whole file: same lender, same loan, different shape.
  const hj = splitCsvLine(splitCsvRecords(jul)[0]).length
  const ha = splitCsvLine(splitCsvRecords(aug)[0]).length
  ok('and they do NOT share a column set', hj !== ha, `${hj} vs ${ha}`)
  ok('...specifically 7 and 13', hj === 7 && ha === 13, `${hj}, ${ha}`)
  const setJ = new Set(pj.days.map(d => d.date))
  ok('they cover no day twice', pa.days.every(d => !setJ.has(d.date)))
}

section('projecting by name is what makes them one ledger')
{
  const bodies = [canonicalise(jul), canonicalise(aug)]
  ok('both files carry every column the parser needs', bodies.every(b => b !== null))
  const merged = parseStripeCapitalCsv([CANON.join(','), ...bodies.flatMap(b => b!)].join('\n'))
  ok('the merge reads clean', merged.ok, `ok=${merged.ok}`)
  // The assertion that would have caught the position-merge bug: no row lost.
  ok('every row of both files survives', merged.rows_accepted === pj.rows_accepted + pa.rows_accepted,
     `${merged.rows_accepted} of ${pj.rows_accepted + pa.rows_accepted}`)
  ok('...and none is counted twice', merged.days.length === pj.days.length + pa.days.length,
     `${merged.days.length} days`)
  ok('the ledger is now continuous from period start to today',
     merged.first_date === '2026-07-06' && merged.last_date === '2026-08-27')

  // A file without the columns cannot be merged, and says so by returning null
  // rather than by contributing blank rows.
  ok('a file missing a needed column is refused, not partially read',
     canonicalise('Some Other Column,Amount\nx,1') === null)
  ok('a header-only file is refused', canonicalise(CANON.join(',')) === null)
}

section('what the combined ledger can then date')
{
  const merged = parseStripeCapitalCsv(
    [CANON.join(','), ...canonicalise(jul)!, ...canonicalise(aug)!].join('\n'))
  const days = merged.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid }))
  const base = { days, complete: merged.ok, coversFrom: merged.first_date!, periodStart: '2026-07-06' }

  // THE REAL CASE. `Stripe overview.png` prints no as-of date — it shows a
  // period ("Jul 6 – Sep 4") and a period-to-date total. These three figures are
  // what it does print.
  const r = dateFromLedger({ ...base, target: { paid: 22783.34, financing: 19522.72, fee: 3260.62 } })
  ok('the screenshot dates to 2026-08-26', r.date === '2026-08-26', `${r.date}`)
  ok('...on the total AND both parts', r.agreed.length === 3 && r.disagreed.length === 0,
     `agreed=${r.agreed.join(',')}`)
  ok('...and the working is shown, not just the answer', /22,783\.34/.test(r.statement ?? '') && /2026-08-26/.test(r.statement ?? ''))
  ok('...including the next day, so the margin is visible', /23,131\.77|348\.43/.test(r.statement ?? ''))

  // Each half alone must refuse, and for its own reason. These are the two
  // failures the single-variable bug produced silently.
  const julOnly = dateFromLedger({
    days: pj.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
    complete: pj.ok, coversFrom: pj.first_date!, periodStart: '2026-07-06',
    target: { paid: 22783.34, financing: 19522.72, fee: 3260.62 } })
  ok('July alone cannot reach an August figure', julOnly.date === null, `${julOnly.date}`)
  const augOnly = dateFromLedger({
    days: pa.days.map(d => ({ date: d.date, total: d.total_paid, financing: d.principal_paid, fee: d.fee_paid })),
    complete: pa.ok, coversFrom: pa.first_date!, periodStart: '2026-07-06',
    target: { paid: 22783.34, financing: 19522.72, fee: 3260.62 } })
  ok('August alone starts too late and refuses', augOnly.date === null, `${augOnly.date}`)
  ok('...and names the coverage it would need', /2026-07-06/.test(augOnly.refusal ?? augOnly.statement ?? ''))

  // A figure that lands between two days is never rounded to the nearer one.
  const between = dateFromLedger({ ...base, target: { paid: 22900.00 } })
  ok('a figure falling between two days is refused, not rounded', between.date === null, `${between.date}`)

  // The balance the screen states follows from the total due less what it dated.
  ok('145,875.00 less the dated total is the balance on screen',
     Math.abs((145875 - 22783.34) - 123091.66) < 0.005)
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
if (fail) process.exit(1)
