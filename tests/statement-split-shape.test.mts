// tests/statement-split-shape.test.mts — Rapid's real August, to the cent (session 273)
//
// David: "I keep uploading the transactions to date from the lender but they don't
// stick... could it be because the shape of this loan is so unusual?"
//
// The shape was never the problem — it had been handled correctly in July. Three
// things were: a fee paired across a month end so August never saw it, a fee
// filtered out of the pairing because Xero already had it (which left its payment
// booked gross), and nobody ever checking that derived rows add up to the balance
// movement they were derived from.
//
// Every figure below is transcribed from the Rapid Finance statement for
// 11/01/2025–09/04/2026 and from the Xero account 247 export David supplied. None
// of it is invented, and the numbers are the point: this file is the record that
// the arithmetic was actually performed against the real document.
//
// Run:  node --experimental-strip-types tests/statement-split-shape.test.mts

import { pairFeesToPayments, footingCheck, basisProvenBy, r2 } from '../supabase/functions/_shared/statement-split-shape.ts'

let pass = 0, fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}`)

const WINDOW = 3   // DIRECT_SPLIT_PAIR_WINDOW_DAYS

// Rapid Finance, account 2134616. Weekly Balance Fee capitalises Monday; the
// $2,068.89 payment clears Tuesday.
const AUG_FEES = [
  { date: '2026-08-03', amount: 513.28 }, { date: '2026-08-10', amount: 499.42 },
  { date: '2026-08-17', amount: 485.49 }, { date: '2026-08-24', amount: 471.42 },
  { date: '2026-08-31', amount: 457.14 },
]
const AUG_PAYMENTS = [
  { date: '2026-08-04', amount: 2068.89 }, { date: '2026-08-11', amount: 2068.89 },
  { date: '2026-08-18', amount: 2068.89 }, { date: '2026-08-25', amount: 2068.89 },
  { date: '2026-09-01', amount: 2068.89 },
]

section('THE MONTH BOUNDARY — the $457.14 that no month booked')
{
  const { pairs, unpairedFees, unpairedPayments } = pairFeesToPayments(AUG_FEES, AUG_PAYMENTS, WINDOW)
  ok('four fees pair inside their own month', pairs.length === 4,
    JSON.stringify(pairs.map(p => `${p.fee.date}->${p.payment.date}`)))
  ok('every pair stays inside one month',
    pairs.every(p => p.fee.date.slice(0, 7) === p.payment.date.slice(0, 7)),
    JSON.stringify(pairs.map(p => `${p.fee.date}->${p.payment.date}`)))
  ok('⭐ the 08-31 fee is NOT paired with the 09-01 payment',
    !pairs.some(p => p.fee.date === '2026-08-31'),
    JSON.stringify(pairs.map(p => `${p.fee.date}->${p.payment.date}`)))
  ok('...it stays a row of its own, dated in August',
    unpairedFees.length === 1 && unpairedFees[0].date === '2026-08-31',
    JSON.stringify(unpairedFees))
  ok('...and the September payment stays a row of its own too',
    unpairedPayments.length === 1 && unpairedPayments[0].date === '2026-09-01',
    JSON.stringify(unpairedPayments))

  // The whole point, stated as money: August's interest must be all five fees.
  const augInterest = r2(pairs.filter(p => p.payment.date.slice(0, 7) === '2026-08')
    .reduce((n, p) => n + p.fee.amount, 0)
    + unpairedFees.filter(f => f.date.slice(0, 7) === '2026-08').reduce((n, f) => n + f.amount, 0))
  ok('⭐ August books all five Balance Fees — $2,426.75', Math.abs(augInterest - 2426.75) < 0.005,
    String(augInterest))

  // And August's principal reduction must be the lender's own: 57,377.83 → 51,529.02.
  const augPrincipal = r2(pairs.filter(p => p.payment.date.slice(0, 7) === '2026-08')
    .reduce((n, p) => n + (p.payment.amount - p.fee.amount), 0)
    - unpairedFees.filter(f => f.date.slice(0, 7) === '2026-08').reduce((n, f) => n + f.amount, 0))
  ok('⭐ ...and $5,848.81 of principal, which is exactly what Rapid says it moved',
    Math.abs(augPrincipal - 5848.81) < 0.005, String(augPrincipal))
  ok('...so the month closes at $51,529.02',
    Math.abs(r2(57377.83 - augPrincipal) - 51529.02) < 0.005, String(r2(57377.83 - augPrincipal)))
}

section('IT DISCRIMINATES — pairing across the month end loses the fee')
{
  // The shipped rule with the month test removed is just "nearest within window",
  // which is what the code did before. Reproduced here to show what it produced.
  const day = (d: string) => new Date(d + 'T00:00:00Z').getTime()
  const claimed = new Set<any>(); const pairs: any[] = []
  for (const f of AUG_FEES.slice().sort((a, b) => a.date.localeCompare(b.date))) {
    const w = AUG_PAYMENTS.filter(p => !claimed.has(p))
      .map(p => ({ p, dist: Math.abs(day(p.date) - day(f.date)) }))
      .filter(x => x.dist <= WINDOW * 86400000).sort((a, b) => a.dist - b.dist)
    if (!w.length || (w.length > 1 && w[0].dist === w[1].dist)) continue
    claimed.add(w[0].p); pairs.push({ fee: f, payment: w[0].p })
  }
  ok('without the month test, 08-31 pairs with 09-01',
    pairs.some(p => p.fee.date === '2026-08-31' && p.payment.date === '2026-09-01'),
    JSON.stringify(pairs.map(p => `${p.fee.date}->${p.payment.date}`)))
  const augInterest = r2(pairs.filter(p => p.payment.date.slice(0, 7) === '2026-08')
    .reduce((n, p) => n + p.fee.amount, 0))
  ok('...and August books only $1,969.61 of fees, $457.14 short',
    Math.abs(augInterest - 1969.61) < 0.005, String(augInterest))
}

section('AMBIGUITY REFUSES — it does not guess')
{
  // A fee equidistant from two unclaimed payments in the same month.
  const { pairs, unpairedFees } = pairFeesToPayments(
    [{ date: '2026-08-11', amount: 100 }],
    [{ date: '2026-08-10', amount: 500 }, { date: '2026-08-12', amount: 500 }], WINDOW)
  ok('an equidistant tie pairs nothing', pairs.length === 0)
  ok('...and the fee stays visible as its own row', unpairedFees.length === 1)
}

section('THE FOOTING CHECK — Rapid’s 2026-09-02 upload, exactly as it happened')
{
  // Two statements $4,792.62 apart; the three splits it derived claimed $5,721.18.
  const f = footingCheck({
    openingBalance: 54252.75, closingBalance: 49460.13,
    from: '2026-08-16', to: '2026-09-02',
    principalOnFile: 0, principalFromThisUpload: r2(1583.40 + 2068.89 + 2068.89),
  })
  ok('the lender moved $4,792.62', Math.abs(f.lender_movement - 4792.62) < 0.005, String(f.lender_movement))
  ok('the rows claimed $5,721.18', Math.abs(f.accounted - 5721.18) < 0.005, String(f.accounted))
  ok('⭐ it does not foot', f.foots === false)
  ok('⭐ ...and the gap is $928.56 — the two Balance Fees that never became rows',
    Math.abs(f.gap + 928.56) < 0.005, String(f.gap))
  ok('which is 08-24 $471.42 plus 08-31 $457.14 exactly',
    Math.abs(928.56 - (471.42 + 457.14)) < 0.005)
}

section('...and it passes once those two fees are rows')
{
  const f = footingCheck({
    openingBalance: 54252.75, closingBalance: 49460.13,
    from: '2026-08-16', to: '2026-09-02',
    principalOnFile: 0,
    // 08-18 paired, 08-24 fee, 08-25 paired, 08-31 fee, 09-01 payment gross
    principalFromThisUpload: r2(1583.40 + (-471.42) + 2068.89 + (-457.14) + 2068.89),
  })
  ok('the same window now foots to the cent', f.foots === true, JSON.stringify(f))
  ok('...with a gap of $0.00', Math.abs(f.gap) < 0.005, String(f.gap))
}

section('SPLITS ALREADY ON FILE COUNT — a second upload is not short')
{
  const f = footingCheck({
    openingBalance: 54252.75, closingBalance: 49460.13,
    from: '2026-08-16', to: '2026-09-02',
    principalOnFile: r2(1583.40 - 471.42 + 2068.89),   // booked by the first upload
    principalFromThisUpload: r2(-457.14 + 2068.89),     // the rest
  })
  ok('a partial re-upload still foots', f.foots === true, JSON.stringify(f))
}

section('THE BASIS IS PROVEN BY THAT SAME ARITHMETIC')
{
  const good = footingCheck({ openingBalance: 100, closingBalance: 90, from: 'a', to: 'b',
    principalOnFile: 0, principalFromThisUpload: 10 })
  const bad = footingCheck({ openingBalance: 100, closingBalance: 90, from: 'a', to: 'b',
    principalOnFile: 0, principalFromThisUpload: 7 })
  ok('a parse that foots proves principal_only', basisProvenBy(good, 'unknown') === 'principal_only')
  ok('⭐ a parse that does NOT foot proves nothing', basisProvenBy(bad, 'unknown') === null)
  ok('a null basis is upgraded the same way', basisProvenBy(good, null) === 'principal_only')
  ok('⭐ a basis someone recorded deliberately is never overwritten',
    basisProvenBy(good, 'total_payback') === null)
  ok('...not even to the same value', basisProvenBy(good, 'principal_only') === null)
}

section('THE SEPTEMBER CARRY — the 09-01 payment is not stranded')
{
  // With 08-31 unpaired, the 09-01 payment must still be bookable in September at
  // its gross amount, and September's own fee (09-07) pairs with 09-08 as usual.
  const sep = pairFeesToPayments(
    [{ date: '2026-08-31', amount: 457.14 }, { date: '2026-09-07', amount: 442.71 }],
    [{ date: '2026-09-01', amount: 2068.89 }, { date: '2026-09-08', amount: 2068.89 }], WINDOW)
  ok('September pairs its own fee with its own payment',
    sep.pairs.length === 1 && sep.pairs[0].fee.date === '2026-09-07', JSON.stringify(sep.pairs))
  ok('the 09-01 payment is unpaired and keeps its full amount',
    sep.unpairedPayments.length === 1 && sep.unpairedPayments[0].date === '2026-09-01')
  ok('and the August fee is still August’s', sep.unpairedFees.some(f => f.date === '2026-08-31'))
}

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
