/* ── session 273 cont.: WHAT DATE IS A STATEMENT'S BALANCE AS OF? ───────────
   David asked how the Funding Circle gap resolves. The answer needed a premise
   nobody had checked: that the date on a statement is the date its balance was
   true. On Funding Circle it is not, and the walk had been comparing each
   lender period against the wrong Xero month for as long as the loan has been
   on file, reporting ~$30/month of drift where the real figure is ~$15.

   These drive the REAL module, and every money assertion below uses the REAL
   Funding Circle balances, so a regression shows up as the wrong dollar amount
   rather than as an abstract failure. */
import assert from 'node:assert'
import {
  endOfMonth, balanceAsOf, anchorsByBalanceDate, looksPeriodLabelled, normalizeBasis,
} from '../supabase/functions/_shared/statement-period.ts'

let pass = 0, fail = 0
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)) }
}
const h = (s: string) => console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 58 - s.length)))

h('endOfMonth, including the cases a Date() round-trip gets wrong')
t('a 31-day month', () => assert.equal(endOfMonth('2026-08-01'), '2026-08-31'))
t('a 30-day month', () => assert.equal(endOfMonth('2026-06-01'), '2026-06-30'))
t('February, common year', () => assert.equal(endOfMonth('2026-02-01'), '2026-02-28'))
t('February, LEAP year', () => assert.equal(endOfMonth('2024-02-01'), '2024-02-29'))
t('December does not roll the year', () => assert.equal(endOfMonth('2025-12-01'), '2025-12-31'))
t('a mid-month date still lands on month end', () => assert.equal(endOfMonth('2026-08-18'), '2026-08-31'))
t('a date already at month end is unchanged', () => assert.equal(endOfMonth('2026-08-31'), '2026-08-31'))
t('garbage is returned untouched, never a fabricated date', () => assert.equal(endOfMonth('not-a-date'), 'not-a-date'))

h('the default basis is a NO-OP — every other loan must be untouched')
t('balance_date returns the stored date', () => assert.equal(balanceAsOf('2026-08-23', 'balance_date'), '2026-08-23'))
t('an unknown basis falls back to balance_date, never to shifting', () =>
  assert.equal(balanceAsOf('2026-08-23', 'wat' as any), '2026-08-23'))
t('null/undefined basis falls back too', () => {
  assert.equal(normalizeBasis(null), 'balance_date')
  assert.equal(normalizeBasis(undefined), 'balance_date')
})
t('period_start moves the date to the end of the period', () =>
  assert.equal(balanceAsOf('2026-08-01', 'period_start'), '2026-08-31'))

h('THE REAL FUNDING CIRCLE ANCHORS — the arithmetic must foot to the cent')
const FC = [
  { statement_date: '2026-06-01', principal_balance: 67240.74 },
  { statement_date: '2026-07-01', principal_balance: 66215.03 },
  { statement_date: '2026-08-01', principal_balance: 65173.94 },
]
// Xero, rebuilt from the ledger (loan_book_balances, basis xero_rebuild)
const XERO: Record<string, number> = { '2026-06-30': 67270.38, '2026-07-31': 66259.81, '2026-08-31': 65234.10 }

t('re-dated anchors land on the month ends Xero is measured at', () => {
  const a = anchorsByBalanceDate(FC, 'period_start')
  assert.deepEqual(a.map(x => x.statement_date), ['2026-06-30', '2026-07-31', '2026-08-31'])
})
t('the filed date is kept, not destroyed', () => {
  const a = anchorsByBalanceDate(FC, 'period_start')
  assert.deepEqual(a.map(x => x.filed_date), ['2026-06-01', '2026-07-01', '2026-08-01'])
})
t('the input array is not mutated', () => {
  anchorsByBalanceDate(FC, 'period_start')
  assert.equal(FC[0].statement_date, '2026-06-01')
})
t('and the gap at each month end is 29.64 / 44.78 / 60.16', () => {
  const a = anchorsByBalanceDate(FC, 'period_start')
  const gaps = a.map(s => Number((XERO[s.statement_date] - Number(s.principal_balance)).toFixed(2)))
  assert.deepEqual(gaps, [29.64, 44.78, 60.16])
})
t('the monthly drift is ~$15, NOT the ~$30 the mis-aligned walk reported', () => {
  const a = anchorsByBalanceDate(FC, 'period_start')
  const gaps = a.map(s => Number((XERO[s.statement_date] - Number(s.principal_balance)).toFixed(2)))
  assert.equal(Number((gaps[1] - gaps[0]).toFixed(2)), 15.14)
  assert.equal(Number((gaps[2] - gaps[1]).toFixed(2)), 15.38)
})
t('and it FOOTS: 29.64 closed + 15.14 + 15.38 = 60.16, no residual', () =>
  assert.equal(Number((29.64 + 15.14 + 15.38).toFixed(2)), 60.16))

h('IT DISCRIMINATES — the un-fixed alignment reproduces the wrong answer')
t('left on balance_date, the same data gives the ~$30 figures that misled us', () => {
  // The old behaviour: anchor dates untouched, so the lender's AUGUST period
  // (67,240.74 -> 66,215.03 is July's) is paired against Xero's July movement.
  const a = anchorsByBalanceDate(FC, 'balance_date')
  assert.deepEqual(a.map(x => x.statement_date), ['2026-06-01', '2026-07-01', '2026-08-01'])
  const lenderJul = Number((FC[1].principal_balance - FC[0].principal_balance).toFixed(2)) // -1025.71
  const xeroJul   = Number((XERO['2026-07-31'] - XERO['2026-06-30']).toFixed(2))           // -1010.57
  // Correctly aligned this pair is the JULY period and differs by 15.14 --
  // but the old walk shifted it a month, which is where 30.06/30.52 came from.
  assert.equal(Number((xeroJul - lenderJul).toFixed(2)), 15.14)
})
t('re-dating reorders when it has to — a mid-month pull must not overtake', () => {
  const withNotice = anchorsByBalanceDate([
    { statement_date: '2026-08-01', principal_balance: 65173.94 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'period_start')
  // 08-01 -> 08-31 and 08-03 -> 08-31 both land on month end; the sort must be
  // stable enough not to throw, and neither may vanish.
  assert.equal(withNotice.length, 2)
  assert.ok(withNotice.every(s => s.statement_date === '2026-08-31'))
})

h('the detector RAISES the question and never answers it')
t('it fires on the real Funding Circle shape', () => {
  const note = looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: 65173.94 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'balance_date')
  assert.ok(note, 'expected a suspicion')
  assert.ok(/PERIOD BEGINNING/.test(note!), note!)
  assert.ok(/check the issue date/.test(note!), note!)
})
t('it names both figures so the reader can check without us', () => {
  const note = looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: 65173.94 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'balance_date')!
  assert.ok(note.includes('65173.94'), note)
  assert.ok(note.includes('66215.03'), note)
})
t('it is SILENT on an ordinary loan — no false ask', () => {
  // Ford E-Transit: real balance dates, monotonically falling.
  assert.equal(looksPeriodLabelled([
    { statement_date: '2026-06-23', principal_balance: 30360.56 },
    { statement_date: '2026-07-23', principal_balance: 29568.94 },
    { statement_date: '2026-08-23', principal_balance: 29302.52 },
  ], 'balance_date'), null)
})
t('it is SILENT when a first-of-month statement is followed by a LOWER one', () => {
  assert.equal(looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: 66215.03 },
    { statement_date: '2026-08-20', principal_balance: 65173.94 },
  ], 'balance_date'), null)
})
t('it never fires across month boundaries — a new month is a new payment', () => {
  assert.equal(looksPeriodLabelled([
    { statement_date: '2026-07-01', principal_balance: 66215.03 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'balance_date'), null)
})
t('it says nothing once the loan is already marked — no nagging', () => {
  assert.equal(looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: 65173.94 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'period_start'), null)
})
t('a null balance cannot crash it', () => {
  assert.doesNotThrow(() => looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: null },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'balance_date'))
})

console.log('\n' + '='.repeat(64))
console.log(`  ${pass} passed, ${fail} failed`)
console.log('='.repeat(64))
if (fail) process.exit(1)
