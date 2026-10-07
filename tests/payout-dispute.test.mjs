// tests/payout-dispute.test.mjs — session 330
//
// Subject: chargeback handling in xero-payout-sync / xero-payout-reallocate.
//
// This test LOADS THE SHIPPED buildPlan out of the real edge-function source and
// runs it. It does not transcribe it. Session 245's lesson: a test holding a copy
// of the function proves only that the copy agrees with itself.
//
// Fixture: the ACTUAL stored category_breakdown of payout po_1UNiQyGACgbvEugHk5z3P8NV
// (2026-10-07, $12,234.68), the payout this fix unblocked, read from
// xero_payout_syncs. The dispute figures are the real ones from
// txn_1UNaOgGACgbvEugHqIwYV82f.
//
// Run: node tests/payout-dispute.test.mjs

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const SYNC = 'supabase/functions/xero-payout-sync/index.ts'
const REALLOC = 'supabase/functions/xero-payout-reallocate/index.ts'
const SHARED = 'supabase/functions/_shared/dispute-classify.ts'

let pass = 0
const ok = (name) => { pass++; console.log('  ok  ' + name) }

// ── Load the real functions ────────────────────────────────────────────────
function slice(src, startNeedle) {
  const i = src.indexOf(startNeedle)
  assert.ok(i >= 0, 'could not find ' + startNeedle)
  const end = src.indexOf('\n}\n', i)
  assert.ok(end > i, 'could not find end of ' + startNeedle)
  return src.slice(i, end + 3)
}
const stripTypes = (s) => s
  // a typed const declaration: `const CATS: Record<...> = {`
  .replace(/^(\s*const \w+)\s*:\s*[^=\n]+=/gm, '$1 =')
  // plain parameter / property annotations
  .replace(/:\s*(any|number|string|boolean)\b/g, '')

function loadBuildPlan(path) {
  const src = readFileSync(path, 'utf8')
  const consts = [
    /const XERO_STRIPE_CONTACT_ID = .*/, /const XERO_BANK_ACCOUNT_ID = .*/,
    /const STRIPE_CAPITAL_ACCOUNT_CODE = .*/, /const CREDITS_ACCOUNT = .*/,
    /const DISCOUNTS_ACCOUNT = .*/, /const REFUNDS_ACCOUNT = .*/,
    /const dollars = .*/,
  ].map((re) => (src.match(re) || [''])[0]).filter(Boolean).join('\n')
  const cats = slice(src, 'const CATS')
  const fn = stripTypes(slice(src, 'function buildPlan('))
  // DISPUTE_ACCOUNT lives in the shared module — take it from there, not a copy.
  const shared = readFileSync(SHARED, 'utf8')
  const disputeAcct = (shared.match(/export const DISPUTE_ACCOUNT = .*/) || [''])[0]
    .replace('export ', '')
  const body = `${stripTypes(consts)}\n${stripTypes(cats)}\n${disputeAcct}\n${fn}\nreturn buildPlan`
  return new Function(body)()
}

function loadIsDisputeTxn() {
  const src = readFileSync(SHARED, 'utf8')
  const fn = stripTypes(slice(src, 'export function isDisputeTxn(').replace('export ', ''))
  return new Function(`${fn}\nreturn isDisputeTxn`)()
}

// ── Real production fixture ────────────────────────────────────────────────
const PAYOUT = { id: 'po_1UNiQyGACgbvEugHk5z3P8NV', amount: 1223468, arrival_date: 1791417600 }
const fixture = () => ({
  buckets: {
    delivery:     { fee: 32511, net: 973150, count: 110, gross: 1014756 },
    gift_card:    { fee: 0, net: 0, count: 0, gross: 0 },
    retail_wf:    { fee: 3837, net: 135059, count: 17, gross: 138896 },
    retail_vend:  { fee: 271, net: 7593, count: 12, gross: 8514 },
    subscription: { fee: 7452, net: 240048, count: 9, gross: 247500 },
    unclassified: { fee: 0, net: 0, count: 0, gross: 0 },
  },
  nonRevenue: {
    payout: { fee: 0, net: -1223468, count: 1, gross: -1223468 },
    stripe_fee: { fee: 0, net: -770, count: 1, gross: -770 },
    financing_paydown: { fee: 0, net: -112022, count: 148, gross: -112022 },
    payout_minimum_balance_hold: { fee: 0, net: -100000, count: 1, gross: -100000 },
    payout_minimum_balance_release: { fee: 0, net: 100000, count: 1, gross: 100000 },
  },
  refundsBucket: { fee: 0, net: -995, count: 1, gross: -995 },
  disputesBucket: { fee: 1500, net: -18595, count: 1, gross: -17095 },
  creditsTotalCents: 8000,
  discountsTotalCents: 1745,
})

const run = (buildPlan, f) => buildPlan(
  PAYOUT, f.buckets, f.nonRevenue, f.refundsBucket,
  f.creditsTotalCents, f.discountsTotalCents, f.disputesBucket,
)
const lineOn = (plan, code) => plan.lineItems.find((l) => l.AccountCode === code)
const linesOn = (plan, code) => plan.lineItems.filter((l) => l.AccountCode === code)

console.log('\nisDisputeTxn — the gate')
{
  const isDisputeTxn = loadIsDisputeTxn()
  // The real transaction, verbatim from the Stripe API.
  assert.equal(isDisputeTxn({ type: 'adjustment', reporting_category: 'dispute', source: 'du_1UNaNmGACgbvEugHHNvqFHyJ' }), true)
  ok('the real 2026-10-07 chargeback is recognised')
  assert.equal(isDisputeTxn({ type: 'adjustment', reporting_category: 'dispute_reversal' }), true)
  ok('a dispute we WIN is recognised (money coming back must not re-block the payout)')

  // THE POINT OF GATING ON reporting_category. A non-dispute `adjustment` must
  // keep falling through to unclassified so it still blocks for a human.
  assert.equal(isDisputeTxn({ type: 'adjustment', reporting_category: 'adjustment' }), false)
  ok('a NON-dispute adjustment is refused — it still blocks rather than being booked as a chargeback')
  assert.equal(isDisputeTxn({ type: 'adjustment' }), false)
  ok('an adjustment with no reporting_category is refused (fail-safe: refuses to post, never posts a guess)')
  assert.equal(isDisputeTxn({ type: 'charge', reporting_category: 'charge' }), false)
  ok('an ordinary charge is not a dispute')
}

for (const [label, path] of [['xero-payout-sync', SYNC], ['xero-payout-reallocate', REALLOC]]) {
  console.log(`\n${label} — buildPlan against the real payout`)
  const buildPlan = loadBuildPlan(path)

  const plan = run(buildPlan, fixture())
  assert.equal(plan.safetyFailed, false)
  ok('safety check passes (nothing left unclassified)')
  assert.equal(plan.balances, true)
  ok('line items balance')
  assert.equal(plan.total, 12234.68)
  ok('total is exactly $12,234.68, the payout amount')
  assert.equal(plan.blockedReason, null)
  ok('not blocked')

  // Chargebacks have their own account now (606), so 691 keeps only the refund.
  const on691 = linesOn(plan, '691')
  assert.equal(on691.length, 1)
  ok('691 keeps only the refund — chargebacks no longer land there')
  assert.equal(on691[0].UnitAmount, -9.95)
  ok('the pre-existing refund line is untouched at -$9.95')

  const on606 = linesOn(plan, '606')
  assert.equal(on606.length, 1)
  ok('606 Chargebacks carries exactly one line')
  // net, not gross: the reversed sale (-170.95) AND the $15 dispute fee.
  assert.equal(on606[0].UnitAmount, -185.95)
  ok('606 carries the whole cost of the chargeback: -$185.95')
  assert.match(on606[0].Description, /Chargebacks/)
  ok('the 606 line names itself')

  // The dispute fee rides inside the 606 line, so 828 must NOT also pick it up --
  // double-counting it would leave the plan out of balance by $15 and, worse,
  // scatter the cost of one chargeback across two accounts.
  const fees = lineOn(plan, '828')
  assert.equal(fees.UnitAmount, -7.7)
  ok('828 Stripe Fees is unchanged at -$7.70 — the dispute fee is not double-counted')

  // ── DISCRIMINATION: the old behaviour must FAIL this fixture ──────────────
  // Before the fix the dispute's money was absent from the plan entirely (it sat
  // in `unclassified`). Zeroing disputesBucket reproduces that, and the plan must
  // come up short by exactly the $185.95 net.
  const old = fixture()
  old.disputesBucket = { fee: 0, net: 0, count: 0, gross: 0 }
  const before = run(buildPlan, old)
  assert.equal(before.balances, false)
  ok('DISCRIMINATES: with the dispute dropped, the plan no longer balances')
  assert.equal(Number((before.total - plan.total).toFixed(2)), 185.95)
  ok('…and it is short by exactly $185.95 — the chargeback plus its fee')

  // A dispute we won must post positively, not be abs()'d into another loss.
  const won = fixture()
  won.disputesBucket = { fee: 0, net: 17095, count: 1, gross: 17095 } // dispute WON: money back
  const wonPlan = run(buildPlan, won)
  const wonLine = linesOn(wonPlan, '606')[0]
  assert.equal(wonLine.UnitAmount, 170.95)
  ok('a won dispute posts a POSITIVE 606 line (not forced negative by Math.abs)')
}

console.log(`\n${pass} assertions passed\n`)
