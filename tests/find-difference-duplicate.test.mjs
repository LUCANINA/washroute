// Session 336: loan-find-difference's duplicate check must find a journal whose
// narration had "Approved by …" appended after the check (post_recorded /
// post_writeoff). Loads the SHIPPED alreadyPostedInXero out of the edge-function
// source and runs it against a stubbed Xero — no transcription (s245).
import { readFileSync } from 'node:fs'
const src = readFileSync(new URL('../supabase/functions/loan-find-difference/index.ts', import.meta.url), 'utf8')
const start = src.indexOf('async function alreadyPostedInXero(')
const end = src.indexOf('\nconst duplicateJournalError', start)
let fnSrc = src.slice(start, end)
  .replace(/\(narration: string, date: string, headers: Record<string, string>, meter: XeroMeter\): Promise<any \| null>/, '(narration, date, headers, meter)')
  .replace(/\(j: any\)/g, '(j)').replace(/\(e as Error\)/g, '(e)').replace('let res: Response', 'let res')
const normDate = (s) => s
const make = new Function('normDate', `${fnSrc}; return alreadyPostedInXero`)
const alreadyPostedInXero = make(normDate)
const base = 'EIDL SBA Loan — $5.00 adjustment to agree with the lender, cause RECORDED. [WR-ADJUST 299 2026-09-30]'
const meterWith = (journals) => ({ fetch: async () => ({ ok: true, json: async () => ({ ManualJournals: journals }) }) })
let pass = 0, fail = 0
const t = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? '✓' : '✗'} ${name}`) }
t('finds a journal with "Approved by" appended',
  !!(await alreadyPostedInXero(base, '2026-09-30', {}, meterWith([{ ManualJournalID: 'a', Narration: base + ' Approved by David, posted to 800 Interest Expense.' }]))))
t('still finds an exact match',
  !!(await alreadyPostedInXero(base, '2026-09-30', {}, meterWith([{ ManualJournalID: 'a', Narration: base }]))))
t('does not match a different correction',
  !(await alreadyPostedInXero(base, '2026-09-30', {}, meterWith([{ ManualJournalID: 'a', Narration: base.replace('$5.00', '$6.00') + ' Approved by David.' }]))))
t('does not match when nothing is posted',
  !(await alreadyPostedInXero(base, '2026-09-30', {}, meterWith([]))))
// Discrimination: the old equality test must FAIL the first case.
const oldFn = new Function('normDate', `${fnSrc.replace(/return n === base \|\| n.startsWith\(base\)/, 'return n === base')}; return alreadyPostedInXero`)(normDate)
t('old exact-match version misses it (proves the test discriminates)',
  !(await oldFn(base, '2026-09-30', {}, meterWith([{ ManualJournalID: 'a', Narration: base + ' Approved by David.' }]))))
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1)
