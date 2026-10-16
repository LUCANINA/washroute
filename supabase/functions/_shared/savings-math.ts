// Session 346 — numbers behind the monthly savings emails. Pure (testable from node).

export type Prices = { perBag: number, deliveryFee: number, planPrice: number, planLbs: number, overagePerLb: number }
export type Usage = { orders: number, bags: number, lbs: number }

const r2 = (n: number) => Math.round(n * 100) / 100

// What these orders cost at pay-per-bag prices: every bag at the bag price, every order a delivery fee.
export function perBagCost(u: Usage, p: Prices): number {
  return r2(u.bags * p.perBag + u.orders * p.deliveryFee)
}

// What the same usage costs on the plan: the monthly price plus overage above the pound allowance.
export function planCost(u: Usage, p: Prices): number {
  return r2(p.planPrice + Math.max(0, u.lbs - p.planLbs) * p.overagePerLb)
}

// Subscriber variant. `history` = savings (perBag − paid) of up to two previous periods.
//   no_orders   — nothing picked up this period → suggest a pause
//   switch      — three full periods of history and the 3-period total is negative
//   light_month — this period negative, but not a 3-period pattern
//   saved       — came out ahead this period
export function subscriberVariant(u: Usage, savedThis: number, history: number[]): 'no_orders' | 'switch' | 'light_month' | 'saved' {
  if (u.orders === 0) return 'no_orders'
  const total3 = savedThis + history.reduce((a, b) => a + b, 0)
  if (history.length >= 2 && total3 < 0) return 'switch'
  return savedThis >= 0 ? 'saved' : 'light_month'
}

export const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Month arithmetic with Stripe's clamp (Jan 31 + 1 month = Feb 28).
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate()
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
}
