// _shared/close-date.ts — session 230
// =============================================================================
// THE CLOSE DATE: the line past which this product stops asking for work.
//
// David, on the Ford and Rapid corrections: "when mistakes are made in the past,
// our CPA will make an adjustment in order to close our books. When that happens,
// and if the numbers pencil out, the system SHOULD work on projecting future
// splits, not those way past a certain point."
//
// A closed month is settled. An approval raised inside one asks for work nobody
// can do -- the adjustment is made, the period is locked -- and the only lasting
// effect is a queue people learn to ignore. Funding Circle was carrying five such
// approvals going back to 2025-11 when this was written.
//
// ── WHY XERO'S LOCK DATE, AND NOT A FIELD OF OUR OWN ────────────────────────
// Xero already has this concept and the CPA already sets it when she closes. If we
// invented a second one, the two would drift, and the day they disagree is the day
// somebody trusts the wrong one. So hers is the input; ours is a fallback for when
// she closes without setting a lock date.
//
// EFFECTIVE = the LATER of the two. A stale manual entry can therefore only ever
// close MORE, never re-open something Xero has locked. Getting that backwards would
// let a forgotten field silently un-close the books.

export interface CloseDate {
  /** ISO date, or null when nothing is closed. */
  date: string | null
  source: 'xero_lock_date' | 'manual' | 'both_agree' | 'none'
  xero: string | null
  manual: string | null
  note: string | null
}

export async function effectiveCloseDate(supa: any): Promise<CloseDate> {
  const { data } = await supa.from('settings')
    .select('books_closed_through, books_closed_through_note, xero_period_lock_date')
    .eq('id', 1).maybeSingle()
  const manual = data?.books_closed_through ? String(data.books_closed_through).slice(0, 10) : null
  const xero = data?.xero_period_lock_date ? String(data.xero_period_lock_date).slice(0, 10) : null
  const note = data?.books_closed_through_note ?? null
  if (!manual && !xero) return { date: null, source: 'none', xero, manual, note }
  if (manual && xero) {
    if (manual === xero) return { date: xero, source: 'both_agree', xero, manual, note }
    return manual > xero
      ? { date: manual, source: 'manual', xero, manual, note }
      : { date: xero, source: 'xero_lock_date', xero, manual, note }
  }
  return manual
    ? { date: manual, source: 'manual', xero, manual, note }
    : { date: xero, source: 'xero_lock_date', xero, manual, note }
}

// Is a split's period inside the closed range?
//
// period_label comes in three shapes and each answers this differently:
//   'YYYY-MM-DD'  a single dated payment -- closed when that day is on or before
//                 the close date.
//   'YYYY-MM'     a whole month -- closed only when the close date reaches the END
//                 of it. Closing through the 15th does not close that month; half
//                 its transactions are still open, and treating it as closed would
//                 bury the ones that still need booking.
//   anything else Verdant's 'Period 84' and friends carry no date at all. UNKNOWN,
//                 and unknown must mean OPEN: silently filing a period we cannot
//                 place would hide real work. Callers that can resolve a date (via
//                 the linked amortization row) should pass it explicitly.
export function isPeriodClosed(periodLabel: string, closeDate: string | null, resolvedDate?: string | null): boolean {
  if (!closeDate) return false
  const label = String(periodLabel ?? '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return label <= closeDate
  if (/^\d{4}-\d{2}$/.test(label)) return endOfMonth(label) <= closeDate
  if (resolvedDate && /^\d{4}-\d{2}-\d{2}$/.test(resolvedDate)) return resolvedDate <= closeDate
  return false
}

export function endOfMonth(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map((x) => parseInt(x, 10))
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${yyyymm}-${String(last).padStart(2, '0')}`
}

// The sentence a human reads. Written so it says WHO decided, because "the system
// hid this" and "your CPA closed this month" are very different messages.
export function closedNote(cd: CloseDate, periodLabel: string): string {
  const who = cd.source === 'manual'
    ? 'the close date set in Bookkeeping'
    : "Xero's lock date"
  return `${periodLabel} falls inside books closed through ${cd.date} (${who}). `
    + `Filed rather than queued: a closed period is settled by the CPA's own adjustment, so there is nothing to approve here. `
    + `It stays in this loan's split history.`
}
