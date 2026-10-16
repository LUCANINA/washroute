// Session 345 — date math for the one-month subscription pause.
// Pure functions (no Deno/Supabase imports) so tests/subscription-pause.test.mts can run them.

const BIZ_TZ = 'America/Los_Angeles'
const HOUR = 3600 * 1000

// One calendar month later, same clock time, day clamped to the month's length
// (Jan 31 → Feb 28), which is how Stripe advances a monthly billing period.
export function addOneMonth(d: Date): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate()
  const lastDay = new Date(Date.UTC(y, m + 2, 0)).getUTCDate()
  return new Date(Date.UTC(y, m + 1, Math.min(day, lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()))
}

function addInterval(d: Date, interval: string): Date | null {
  if (interval === 'weekly')   return new Date(d.getTime() + 7 * 24 * HOUR)
  if (interval === 'biweekly') return new Date(d.getTime() + 14 * 24 * HOUR)
  if (interval === 'monthly')  return addOneMonth(d)
  return null
}

export const ptDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: BIZ_TZ }) // YYYY-MM-DD

// Every future occurrence of each repeating series that falls inside [start, end).
// A series only ever has ONE future order; its successors are anchor + k·interval
// (trg_create_recurring_order_fn: next = COALESCE(recurring_anchor_at, pickup_window_start) + interval).
export function occurrencesInWindow(
  orders: { pickup_address_id: string | null, recurring_interval: string, recurring_anchor_at: string | null, pickup_window_start: string }[],
  start: Date, end: Date,
): { pickup_address_id: string | null, skip_date: string }[] {
  const out: { pickup_address_id: string | null, skip_date: string }[] = []
  const seen = new Set<string>()
  for (const o of orders) {
    let t = new Date(o.recurring_anchor_at || o.pickup_window_start)
    for (let k = 0; k < 12; k++) {
      const next = addInterval(t, o.recurring_interval)
      if (!next || next >= end) break
      t = next
      if (next >= start) {
        const key = `${o.pickup_address_id}|${ptDate(next)}`
        if (!seen.has(key)) { seen.add(key); out.push({ pickup_address_id: o.pickup_address_id, skip_date: ptDate(next) }) }
      }
    }
  }
  return out
}

