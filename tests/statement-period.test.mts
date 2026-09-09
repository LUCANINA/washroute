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
  anchorRefusal, refusedAnchors, measuredDate, humanAnchorExclusion,
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

/* ── session 284, Tech Debt #46: A DUE DATE IS NOT A BALANCE DATE ──────────
   SBA EIDL issues its statement about three weeks AHEAD of the payment and
   dates it to the DUE date; the document prints the date its balance is true
   as "Last Payment Date". The real figures below are EIDL's own: the 09/25/2026
   statement, Last Payment Date 08/24/2026, Outstanding Balance $960,005.00. */

h('a measurement outranks every rule about what a filed date means')
t('a stated date wins over balance_date', () =>
  assert.equal(balanceAsOf('2026-09-25', 'balance_date', '2026-08-24'), '2026-08-24'))
t('...and over period_start, which would otherwise say month end', () =>
  assert.equal(balanceAsOf('2026-09-01', 'period_start', '2026-08-24'), '2026-08-24'))
t('...and over due_date, which is the case it was built for', () =>
  assert.equal(balanceAsOf('2026-09-25', 'due_date', '2026-08-24'), '2026-08-24'))
t('a timestamp is accepted by its date part, not rejected', () =>
  assert.equal(balanceAsOf('2026-09-25', 'due_date', '2026-08-24T00:00:00Z'), '2026-08-24'))

h('...and anything that is not a date is NOT a measurement')
for (const junk of [null, undefined, '', 'unknown', '08/24/2026', '2026-8-24', 'Last Payment Date', 0, {}])
  t(`measuredDate refuses ${JSON.stringify(junk)}`, () => assert.equal(measuredDate(junk), null))
t('...so an unmeasured due_date row falls back to the FILED date, never a guess', () =>
  // The tempting version walks back a month. That is right for a lender due on
  // the 25th and wrong for one due on the 5th, and nothing on screen would say
  // which — session 245. The row is refused instead; see below.
  assert.equal(balanceAsOf('2026-09-25', 'due_date'), '2026-09-25'))
t('due_date NEVER shifts a date by arithmetic', () => {
  for (const d of ['2026-09-05', '2026-09-25', '2026-01-31', '2024-02-29'])
    assert.equal(balanceAsOf(d, 'due_date'), d)
})

h('the refusal: it withholds a claim, and asks')
t('an unmeasured due_date row is refused', () => {
  const r = anchorRefusal('2026-09-25', 'due_date')
  assert.ok(r && /DUE DATE/i.test(r), r ?? 'no refusal')
  assert.ok(/2026-09-25/.test(r!), 'names the date it will not trust')
  assert.ok(/Last Payment Date/i.test(r!), 'ASKS for the field that settles it — session 262')
})
t('a MEASURED due_date row is not refused', () =>
  assert.equal(anchorRefusal('2026-09-25', 'due_date', '2026-08-24'), null))
t('no other basis is ever refused — this must not touch 13 of 14 loans', () => {
  assert.equal(anchorRefusal('2026-09-25', 'balance_date'), null)
  assert.equal(anchorRefusal('2026-09-01', 'period_start'), null)
  assert.equal(anchorRefusal('2026-09-25', 'wat' as any), null)
})

h('anchorsByBalanceDate and refusedAnchors are a PAIR — nothing is lost')
const EIDL = [
  { statement_date: '2026-08-25', principal_balance: 960005.00, balance_as_of: null },
  { statement_date: '2026-09-25', principal_balance: 960005.00, balance_as_of: null },
]
t('an unmeasured due-date row does not reach a caller as an anchor', () =>
  assert.equal(anchorsByBalanceDate(EIDL, 'due_date').length, 0))
t('...and comes back from refusedAnchors instead, with the reason', () => {
  const r = refusedAnchors(EIDL, 'due_date')
  assert.equal(r.length, 2)
  assert.ok(r.every(x => /DUE DATE/i.test(x.anchor_refusal)))
  // An exclusion nobody can see is evidence deleted (session 245). Every row
  // the filter dropped must be obtainable, with its document, from this side.
  assert.deepEqual(r.map(x => x.statement_date).sort(), ['2026-08-25', '2026-09-25'])
})
t('measure them and they anchor, on the date the DOCUMENT gave', () => {
  const measured = EIDL.map((s, i) => ({ ...s, balance_as_of: i ? '2026-08-24' : '2026-07-22' }))
  const a = anchorsByBalanceDate(measured, 'due_date')
  assert.equal(a.length, 2)
  assert.deepEqual(a.map(x => x.statement_date), ['2026-07-22', '2026-08-24'])
  // The filed date survives, because the three upload-dedupe checks compare
  // against the date a document was FILED under (session 282).
  assert.deepEqual(a.map(x => x.filed_date), ['2026-08-25', '2026-09-25'])
  assert.equal(refusedAnchors(measured, 'due_date').length, 0)
})
t('re-dating can REORDER, and the pair must survive it', () => {
  // A due-date loan whose two documents are filed in one order and measured in
  // the other. Sorting by the measured date is the whole point.
  const a = anchorsByBalanceDate([
    { statement_date: '2026-09-25', principal_balance: 2, balance_as_of: '2026-07-22' },
    { statement_date: '2026-08-25', principal_balance: 1, balance_as_of: '2026-08-24' },
  ], 'due_date')
  assert.deepEqual(a.map(x => x.statement_date), ['2026-07-22', '2026-08-24'])
})
t('THE CONTROL: on balance_date the same rows are untouched and none is refused', () => {
  const a = anchorsByBalanceDate(EIDL, 'balance_date')
  assert.deepEqual(a.map(x => x.statement_date), ['2026-08-25', '2026-09-25'])
  assert.equal(refusedAnchors(EIDL, 'balance_date').length, 0)
})

h("session 290 — A HUMAN'S EXCLUSION IS A REFUSAL, at the same convergence point")
/* The REAL Funding Circle rows. 2026-08-03 is byte-identical to the 2026-07-01
   statement and carries JULY's closing balance; a person established that and
   wrote it into anchor_exclusion_reason. Under 'period_start' BOTH August rows
   re-date to 2026-08-31, so leaving the excluded one in builds a span from a
   date to itself -- "Aug 31 -> Aug 31, off by $1,041.09", which is nothing but
   66,215.03 - 65,173.94 stated a second time. That phantom tripped the
   write-off's totalPeriodDiff fence and the card refused to propose anything. */
const FC290 = [
  { statement_date: '2026-07-01', principal_balance: 66215.03, anchor_exclusion_reason: null },
  { statement_date: '2026-08-01', principal_balance: 65173.94, anchor_exclusion_reason: null },
  { statement_date: '2026-08-03', principal_balance: 66215.03, anchor_exclusion_reason: 'Not a balance as of 2026-08-03. This is the SAME PDF as the 2026-07-01 row.' },
]
t('the excluded row does not reach a caller as an anchor', () => {
  const a = anchorsByBalanceDate(FC290, 'period_start')
  assert.equal(a.length, 2)
  assert.deepEqual(a.map(x => x.filed_date), ['2026-07-01', '2026-08-01'])
})
t('...so August has ONE anchor, not two on the same date', () => {
  const a = anchorsByBalanceDate(FC290, 'period_start')
  const aug = a.filter(x => x.statement_date === '2026-08-31')
  assert.equal(aug.length, 1, 'two anchors on 2026-08-31 is the phantom span')
  assert.equal(Number(aug[0].principal_balance), 65173.94)
})
t('THE DISCRIMINATOR: drop the exclusion and the phantom comes back', () => {
  // The inverse of the fix, applied to the INPUT rather than the code. If this
  // does not reproduce the two-anchors-one-date shape, the assertion above is
  // passing for some other reason and proves nothing.
  const unmarked = FC290.map(r => ({ ...r, anchor_exclusion_reason: null }))
  const aug = anchorsByBalanceDate(unmarked, 'period_start').filter(x => x.statement_date === '2026-08-31')
  assert.equal(aug.length, 2)
  // ...and it is exactly the $1,041.09 the card showed.
  const [hi, lo] = aug.map(x => Number(x.principal_balance)).sort((a, b) => b - a)
  assert.equal(Number((hi - lo).toFixed(2)), 1041.09)
})
t('...and comes back from refusedAnchors, in the HUMAN\'s own words', () => {
  const r = refusedAnchors(FC290, 'period_start')
  assert.equal(r.length, 1)
  // refusedAnchors deliberately does NOT re-date: a row whose balance date is
  // in dispute has no valid balance date, so it keeps the date it was FILED
  // under, which is the one a person will recognise on the document.
  assert.equal(r[0].statement_date, '2026-08-03')
  assert.equal((r[0] as any).filed_date, undefined)
  assert.ok(/a person ruled this document out/.test(r[0].anchor_refusal))
  // NOT truncated. The person's sentence is the entire value of the field, and
  // a cut that drops a claim is a lie rather than a trim (ce17).
  assert.ok(/SAME PDF as the 2026-07-01 row/.test(r[0].anchor_refusal))
})
t('the human objection is tested FIRST — a row that is both keeps their words', () => {
  const both = [{ statement_date: '2026-09-25', principal_balance: 1, balance_as_of: null,
                  anchor_exclusion_reason: 'a person looked at the PDF' }]
  assert.equal(anchorsByBalanceDate(both, 'due_date').length, 0)
  assert.ok(/a person looked at the PDF/.test(refusedAnchors(both, 'due_date')[0].anchor_refusal))
})
t('humanAnchorExclusion is null for every ordinary row — 13 of 14 loans untouched', () => {
  assert.equal(humanAnchorExclusion({ anchor_exclusion_reason: null }), null)
  assert.equal(humanAnchorExclusion({ anchor_exclusion_reason: '   ' }), null)
  assert.equal(humanAnchorExclusion({}), null)
  assert.equal(humanAnchorExclusion(undefined), null)
})
t('THE CONTROL: no exclusions anywhere and nothing changes', () => {
  const clean = FC290.slice(0, 2)
  assert.equal(anchorsByBalanceDate(clean, 'period_start').length, 2)
  assert.equal(refusedAnchors(clean, 'period_start').length, 0)
})

h('looksPeriodLabelled must not start nagging a due-date loan')
t('it is silent on due_date — that question is already answered', () =>
  assert.equal(looksPeriodLabelled([
    { statement_date: '2026-08-01', principal_balance: 65173.94 },
    { statement_date: '2026-08-03', principal_balance: 66215.03 },
  ], 'due_date'), null))

console.log('\n' + '='.repeat(64))
console.log(`  ${pass} passed, ${fail} failed`)
console.log('='.repeat(64))
if (fail) process.exit(1)
