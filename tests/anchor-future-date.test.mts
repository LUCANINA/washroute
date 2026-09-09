// anchor-future-date.test.mts — session 289
// ============================================================================
// DAVID: "the last statement I uploaded is from Sept" — against a card saying
// August's was not on file. It was. So was September's.
//
// EIDL SBA is a `due_date` lender: its September document is filed under
// 2026-09-25, its PAYMENT DUE DATE, and prints that the balance is true as of
// 2026-08-24. loan-find-difference excluded it in SQL with
// `.lte('statement_date', today)` — the s196/s217 rule that a future-dated row
// is a projection, correctly motivated and applied to the WRONG DATE, one
// branch upstream of the re-dating that would have placed that balance a
// fortnight in the past.
//
// Consequences, all of them silent: the newest usable balance was 2026-07-22,
// August had no span at all, and the card asked a bookkeeper to upload a
// document filed the day before. reconciliation-run and derive-schedule never
// had that SQL filter, so two surfaces of this product disagreed about the
// newest balance on the book.
// ============================================================================
import { anchorsByBalanceDate, refusedAnchors } from '../supabase/functions/_shared/statement-period.ts'

let pass = 0, fail = 0
const ok = (c: unknown, name: string, obs = '') => {
  if (c) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${obs ? `\n        ${obs}` : ''}`) }
}
const sec = (t: string) => console.log(`\n── ${t} `)

const TODAY = '2026-09-09'
// The real rows, read off the database 2026-09-09.
const EIDL = [
  { id: 'sep', statement_date: '2026-09-25', balance_as_of: '2026-08-24', principal_balance: 960005 },
  { id: 'aug', statement_date: '2026-08-25', balance_as_of: '2026-07-22', principal_balance: 960005 },
  { id: 'aug-nomeasure', statement_date: '2026-08-25', balance_as_of: null, principal_balance: 960005 },
  { id: 'jul', statement_date: '2026-07-25', balance_as_of: '2026-06-22', principal_balance: 960005 },
  { id: 'apr', statement_date: '2026-04-25', balance_as_of: null, principal_balance: 960000 },
]

sec("⭐ the September statement is an anchor, dated when its balance was true")
const a = anchorsByBalanceDate(EIDL, 'due_date', TODAY)
const sep = a.find(x => (x as any).id === 'sep')
ok(sep, '⭐ the row filed 2026-09-25 SURVIVES — it is not a projection, its balance is a fortnight old')
ok(sep && sep.statement_date === '2026-08-24', '...re-dated to the balance date the document prints', sep?.statement_date)
ok(sep && sep.filed_date === '2026-09-25', '...with the filed date kept, because that is the one David recognises', sep?.filed_date)
ok(a[a.length - 1].statement_date === '2026-08-24',
   '⭐ so the NEWEST usable balance is 2026-08-24, not 2026-07-22', a[a.length - 1].statement_date)

sec('CONTROL: the old shape drops it, so this test can fail')
// Exactly what the SQL did: filter on the FILED date before re-dating.
const oldWay = anchorsByBalanceDate(EIDL.filter(s => s.statement_date <= TODAY), 'due_date')
ok(!oldWay.some(x => (x as any).id === 'sep'),
   '⭐ filtering on the filed date loses the September balance entirely')
ok(oldWay[oldWay.length - 1].statement_date === '2026-07-22',
   '...which is exactly the 2026-07-22 the card reported as "the newest"', oldWay[oldWay.length - 1].statement_date)

sec('a balance that really is in the future is still refused')
const future = anchorsByBalanceDate(
  [...EIDL, { id: 'oct', statement_date: '2026-10-25', balance_as_of: '2026-09-24', principal_balance: 1 }],
  'due_date', TODAY)
ok(!future.some(x => (x as any).id === 'oct'),
   '⭐ s196/s217 still holds — it is applied to the BALANCE date now, not weakened')
const refused = refusedAnchors(
  [{ id: 'oct', statement_date: '2026-10-25', balance_as_of: '2026-09-24', principal_balance: 1 }] as any,
  'due_date', TODAY)
ok(refused.length === 1 && /still in the future/.test(refused[0].anchor_refusal),
   '...and the refusal is REPORTABLE, not silent — the pair stays a pair (s245)', refused[0]?.anchor_refusal?.slice(0, 60))

sec('the due-date refusal for an unmeasured row is untouched')
ok(!a.some(x => (x as any).id === 'aug-nomeasure'),
   'a due_date row with no balance_as_of is still refused — it cannot be placed in time')
ok(!a.some(x => (x as any).id === 'apr'), '...same for April')

sec('a loan that is NOT due_date is unaffected in either direction')
const asFiled = anchorsByBalanceDate(
  [{ id: 'x', statement_date: '2026-08-23', balance_as_of: null, principal_balance: 1 },
   { id: 'y', statement_date: '2026-12-01', balance_as_of: null, principal_balance: 1 }] as any,
  'as_filed', TODAY)
ok(asFiled.length === 1 && (asFiled[0] as any).id === 'x',
   "⭐ Ford's statements still mean exactly what they say, and its future row is still a projection")

console.log(`\n${'='.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(64)}`)
process.exit(fail ? 1 : 0)
