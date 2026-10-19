// tests/savings-math.test.mts — session 346 savings email numbers
// Run:  node --experimental-strip-types tests/savings-math.test.mts
import { perBagCost, planCost, subscriberVariant, addMonths, money, orderBagOverLbs } from '../supabase/functions/_shared/savings-math.ts'
let pass = 0, fail = 0
const ok = (l: string, c: boolean, d = '') => { if (c) { pass++; console.log('  ok  ' + l) } else { fail++; console.log('  FAIL ' + l + (d ? ' — ' + d : '')) } }
const P = { perBag: 65, deliveryFee: 9.95, planPrice: 275, planLbs: 100, overagePerLb: 2.75, bagLbs: 25, bagOverPerLb: 3 }

ok('mockup subscriber: 5 bags / 3 orders = $354.85', perBagCost({ orders: 3, bags: 5, lbs: 88 }, P) === 354.85)
ok('mockup per-bag: 8 bags / 4 orders = $559.80', perBagCost({ orders: 4, bags: 8, lbs: 170 }, P) === 559.8)
ok('plan with 70 lbs over = $467.50', planCost({ orders: 4, bags: 8, lbs: 170 }, P) === 467.5)
ok('plan under allowance = $275', planCost({ orders: 2, bags: 3, lbs: 52 }, P) === 275)
ok('no orders → no_orders', subscriberVariant({ orders: 0, bags: 0, lbs: 0 }, -275, [10, 20]) === 'no_orders')
ok('ahead → saved', subscriberVariant({ orders: 3, bags: 5, lbs: 88 }, 79.85, []) === 'saved')
ok('one light month, ahead overall → light_month', subscriberVariant({ orders: 2, bags: 3, lbs: 52 }, -60.1, [80, 40]) === 'light_month')
ok('negative over 3 periods → switch', subscriberVariant({ orders: 2, bags: 3, lbs: 52 }, -60.1, [-40, -40]) === 'switch')
ok('negative but only 2 periods of history → light_month, not switch', subscriberVariant({ orders: 2, bags: 3, lbs: 52 }, -60.1, [-40]) === 'light_month')
ok('positive month inside a negative 3-period run → switch', subscriberVariant({ orders: 3, bags: 4, lbs: 70 }, 20, [-100, -100]) === 'switch')
ok('Oct 31 − 1 month = Sep 30', addMonths(new Date('2026-10-31T10:00:00Z'), -1).toISOString() === '2026-09-30T10:00:00.000Z')
ok('Oct 18 − 2 months = Aug 18', addMonths(new Date('2026-10-18T10:00:00Z'), -2).toISOString() === '2026-08-18T10:00:00.000Z')
// Session 347 — pay-per-bag overweight, order by order (Jennifer Helfrich's Sep 17–Oct 17 orders: 23/33/28/25/31 lbs, 1 bag each)
const jen = [23, 33, 28, 25, 31].reduce((a, w) => a + orderBagOverLbs(w, 1, 25), 0)
ok('Jennifer: 17 lbs over (8+3+6), not pooled 15', jen === 17, String(jen))
ok('Jennifer: pay-per-bag = $425.75', perBagCost({ orders: 5, bags: 5, lbs: 140, bagOverLbs: jen }, P) === 425.75, String(perBagCost({ orders: 5, bags: 5, lbs: 140, bagOverLbs: jen }, P)))
ok('unweighed order adds no overweight', orderBagOverLbs(null, 2, 25) === 0)
ok('2 bags at 50 lbs = no overweight', orderBagOverLbs(50, 2, 25) === 0)
ok('money formats', money(1219.5) === '$1,219.50' && money(-60.1) === '$60.10')
console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1)
