// tests/stripe-fee-classify.test.mjs — session 373
//
// Subject: Stripe's separately-billed processing fees go to 605, not 828.
// Loads the SHIPPED isProcessingFeeTxn and buildPlan out of the real sources and
// runs them (session 245: a transcribed copy only proves the copy agrees with itself).
//
// Fixture: payout po_1UekiHGACgbvEugHHb4FQAFQ (2026-11-23, $5,429.31). Bucket
// figures are its stored category_breakdown; the nine stripe_fee transactions are
// verbatim from the Stripe API (GET /v1/balance_transactions?payout=…&type=stripe_fee).
//
// Run: node tests/stripe-fee-classify.test.mjs

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const SYNC = 'supabase/functions/xero-payout-sync/index.ts'
const REALLOC = 'supabase/functions/xero-payout-reallocate/index.ts'
const SHARED = 'supabase/functions/_shared/stripe-fee-classify.ts'
const DISPUTE = 'supabase/functions/_shared/dispute-classify.ts'

let pass = 0
const ok = (name) => { pass++; console.log('  ok  ' + name) }

function slice(src, startNeedle) {
  const i = src.indexOf(startNeedle)
  assert.ok(i >= 0, 'could not find ' + startNeedle)
  const end = src.indexOf('\n}\n', i)
  assert.ok(end > i, 'could not find end of ' + startNeedle)
  return src.slice(i, end + 3)
}
const stripTypes = (s) => s
  .replace(/^(\s*const \w+)\s*:\s*[^=\n]+=/gm, '$1 =')
  .replace(/:\s*(any|number|string|boolean)\b/g, '')

function loadClassifier() {
  const src = readFileSync(SHARED, 'utf8')
  const re = (src.match(/^const PROCESSING_PRODUCTS = .*/m) || [''])[0]
  const fn = stripTypes(slice(src, 'export function isProcessingFeeTxn(').replace('export ', ''))
  return new Function(`${re}\n${fn}\nreturn isProcessingFeeTxn`)()
}
function loadBuildPlan(path) {
  const src = readFileSync(path, 'utf8')
  const consts = [
    /const XERO_STRIPE_CONTACT_ID = .*/, /const XERO_BANK_ACCOUNT_ID = .*/,
    /const STRIPE_CAPITAL_ACCOUNT_CODE = .*/, /const CREDITS_ACCOUNT = .*/,
    /const DISCOUNTS_ACCOUNT = .*/, /const REFUNDS_ACCOUNT = .*/, /const dollars = .*/,
  ].map((re) => (src.match(re) || [''])[0]).filter(Boolean).join('\n')
  const cats = slice(src, 'const CATS')
  const fn = stripTypes(slice(src, 'function buildPlan('))
  const disputeAcct = (readFileSync(DISPUTE, 'utf8').match(/export const DISPUTE_ACCOUNT = .*/) || [''])[0].replace('export ', '')
  return new Function(`${stripTypes(consts)}\n${stripTypes(cats)}\n${disputeAcct}\n${fn}\nreturn buildPlan`)()
}

// The nine real stripe_fee lines on the 2026-11-23 payout.
const FEES = [
  ['Terminal (2026-11-21): Per-authorization Services Fee', -35],
  ['Billing - Usage Fee (2026-11-21)', -578],
  ['Card (2026-11-21)', -19146],
  ['Terminal (2026-11-20): Per-authorization Services Fee', -65],
  ['Card (2026-11-20)', -16045],
  ['Billing - Usage Fee (2026-11-20)', -193],
  ['Terminal (2026-11-19): Per-authorization Services Fee', -35],
  ['Billing - Usage Fee (2026-11-19)', -770],
  ['Card (2026-11-19)', -16817],
].map(([description, net]) => ({ type: 'stripe_fee', reporting_category: 'fee', description, amount: net, fee: 0, net }))

console.log('\nisProcessingFeeTxn — the gate')
const isProc = loadClassifier()
assert.equal(isProc({ type: 'stripe_fee', description: 'Card (2026-11-18)' }), true); ok('daily card fee → processing')
assert.equal(isProc({ type: 'stripe_fee', description: 'Card (2026-11-01 - 2026-11-30)' }), true); ok('monthly card fee credit → processing')
assert.equal(isProc({ type: 'stripe_fee', description: 'Card Present (2026-11-01 - 2026-11-30)' }), true); ok('card-present → processing')
assert.equal(isProc({ type: 'stripe_fee', description: 'Terminal (2026-11-18): Per-authorization Services Fee' }), true); ok('Terminal per-auth → processing')
assert.equal(isProc({ type: 'stripe_fee', description: 'Billing - Usage Fee (2026-11-18)' }), false); ok('Billing usage fee stays an account fee')
assert.equal(isProc({ type: 'stripe_fee', description: 'Card Account Updater (CAU) (2026-11-01 - 2026-11-30): Updates' }), false); ok('Card Account Updater is NOT card processing despite starting "Card "')
assert.equal(isProc({ type: 'stripe_fee', description: 'Radar (2026-11-18)' }), false); ok('an unknown product stays in 828 (fail-safe)')
assert.equal(isProc({ type: 'stripe_fee' }), false); ok('no description stays in 828 (fail-safe)')
assert.equal(isProc({ type: 'charge', description: 'Card (2026-11-18)' }), false); ok('only stripe_fee rows are considered')

// Build the breakdown exactly as classifyPayout does: processing fees peeled off first.
const procNet = FEES.filter(isProc).reduce((s, t) => s + t.net, 0)
const acctNet = FEES.filter((t) => !isProc(t)).reduce((s, t) => s + t.net, 0)
assert.equal(procNet, -52143); assert.equal(acctNet, -1541)
ok('real payout splits to $521.43 processing / $15.41 account fees')

const PAYOUT = { id: 'po_1UekiHGACgbvEugHHb4FQAFQ', amount: 542931, arrival_date: 1795392000 }
const fixture = (split) => ({
  buckets: {
    delivery: { fee: 383, net: 490206, count: 56, gross: 498959 },
    gift_card: { fee: 0, net: 0, count: 0, gross: 0 },
    retail_wf: { fee: 1261, net: 48131, count: 5, gross: 49392 },
    retail_vend: { fee: 13, net: 319, count: 1, gross: 332 },
    subscription: { fee: 0, net: 110000, count: 4, gross: 110000 },
    unclassified: { fee: 0, net: 0, count: 0, gross: 0 },
  },
  nonRevenue: {
    payout: { fee: 0, net: -542931, count: 1, gross: -542931 },
    stripe_fee: split ? { fee: 0, net: acctNet, count: 3, gross: acctNet } : { fee: 0, net: -53684, count: 9, gross: -53684 },
    ...(split ? { stripe_processing_fee: { fee: 0, net: procNet, count: 6, gross: procNet } } : {}),
    financing_paydown: { fee: 0, net: -52041, count: 66, gross: -52041 },
    payout_minimum_balance_hold: { fee: 0, net: -100000, count: 1, gross: -100000 },
    payout_minimum_balance_release: { fee: 0, net: 100000, count: 1, gross: 100000 },
  },
  refundsBucket: { fee: 0, net: 0, count: 0, gross: 0 },
  disputesBucket: { fee: 0, net: 0, count: 0, gross: 0 },
  creditsTotalCents: 8000, discountsTotalCents: 370,
})
const run = (bp, f) => bp(PAYOUT, f.buckets, f.nonRevenue, f.refundsBucket, f.creditsTotalCents, f.discountsTotalCents, f.disputesBucket)
const on = (plan, code) => plan.lineItems.filter((l) => l.AccountCode === code)

for (const [label, path] of [['xero-payout-sync', SYNC], ['xero-payout-reallocate', REALLOC]]) {
  console.log(`\n${label} — buildPlan, 2026-11-23 payout`)
  const bp = loadBuildPlan(path)
  const plan = run(bp, fixture(true))
  assert.equal(plan.balances, true); assert.equal(plan.total, 5429.31)
  ok('balances to the cent at $5,429.31')
  assert.equal(on(plan, '605').length, 1); assert.equal(on(plan, '605')[0].UnitAmount, -538)
  ok('605 carries one line: $16.57 per-charge + $521.43 billed separately = -$538.00')
  assert.equal(on(plan, '828')[0].UnitAmount, -15.41)
  ok('828 keeps only the true account fees: -$15.41')

  // DISCRIMINATION: the pre-373 classification (everything in stripe_fee) must
  // still balance but put the processing money in 828 — that is the bug.
  const old = run(bp, fixture(false))
  assert.equal(old.total, 5429.31)
  assert.equal(on(old, '828')[0].UnitAmount, -536.84)
  ok('DISCRIMINATES: unsplit, 828 would carry -$536.84 — the inflated figure on the P&L')

  // A credit back from Stripe (2026-11-12 shape) must REDUCE 605, not add to it.
  const credit = fixture(true); credit.nonRevenue.stripe_processing_fee.net = procNet + 19117 + 587
  credit.nonRevenue.payout.net += 19704; credit.nonRevenue.payout.gross += 19704
  const cp = run(bp, credit)
  assert.equal(on(cp, '605')[0].UnitAmount, -340.96)
  ok('a fee credit from Stripe reduces 605 (signed, not -Math.abs)')
}
console.log(`\n${pass} assertions passed\n`)
