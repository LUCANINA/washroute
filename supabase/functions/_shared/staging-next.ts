// staging-next.ts -- the one place that decides "which amortization period should be
// offered to a human for staging next" for a loan. Session 226 (2026-08-21), part of
// the Staging Engine: ingest a schedule -> a "ready to stage" card appears; a staged
// payment matches in Xero -> the NEXT period's card appears. Both entry points
// (loan-ingest-amortization after ingest, loan-xero-post's stage sweep after a match)
// call ensureUpcomingSplit so they can never disagree about what "next" means.
//
// Writes are DB-only (loan_splits / loan_accounts). Nothing here touches Xero --
// staging a split in Xero remains a human clicking the Stage button after reviewing
// the preview. The auto-stage cron (Task 7) stays parked until the PCV Sep-1 match
// proves the full loop.
//
// Rules, in order:
//   1. One active card per loan. If ANY schedule-sourced split is currently
//      pending_review / staged / needs_attention, do nothing -- the human already has
//      a card (or a problem) for this loan in front of them. Stacking future months
//      would turn the Approvals queue into a wall.
//   2. Otherwise, walk the FUTURE payment months of the latest schedule in order and
//      create a pending_review split for the first month that doesn't already have a
//      consumed split (posted / already_in_xero / anything else). Exactly one.
//   3. Splits are created with the same shape loan-generate-schedule-split uses
//      (source='amortization_schedule', amounts summed across the month's payment
//      rows, aggregate months flagged in review_notes) -- downstream stage/post code
//      treats them identically.
//   4. NEVER overwrite a split whose status isn't pending_review (Tech Debt #21 is
//      loan-generate-schedule-split's blind upsert doing exactly that; this helper is
//      written not to repeat it). The upsert here only ever lands on a row this same
//      walk just verified is absent or still pending_review.

export function stagingPacificToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

export type EnsureUpcomingResult = {
  action: 'created' | 'refreshed' | 'skipped'
  reason?: 'active_card_exists' | 'no_schedule' | 'no_future_payment_rows' | 'lookup_failed'
  period_label?: string
  split_id?: string
  detail?: string
}

export async function ensureUpcomingSplit(supa: any, loanAccountId: string): Promise<EnsureUpcomingResult> {
  const today = stagingPacificToday()

  // Rule 1: one active card per loan.
  const { data: active, error: activeErr } = await supa
    .from('loan_splits')
    .select('id, period_label, status')
    .eq('loan_account_id', loanAccountId)
    .eq('source', 'amortization_schedule')
    .in('status', ['pending_review', 'staged', 'needs_attention'])
    .limit(1)
  if (activeErr) return { action: 'skipped', reason: 'lookup_failed', detail: activeErr.message }
  if (active?.length) {
    return { action: 'skipped', reason: 'active_card_exists', period_label: active[0].period_label, split_id: active[0].id }
  }

  // Latest schedule (same "most recent generated date wins" rule as loan-generate-schedule-split).
  const { data: schedules, error: schedErr } = await supa
    .from('loan_amortization_schedules')
    .select('id, schedule_generated_date')
    .eq('loan_account_id', loanAccountId)
    .order('schedule_generated_date', { ascending: false })
    .limit(1)
  if (schedErr) return { action: 'skipped', reason: 'lookup_failed', detail: schedErr.message }
  if (!schedules?.length) return { action: 'skipped', reason: 'no_schedule' }

  const { data: futureRows, error: rowsErr } = await supa
    .from('loan_amortization_rows')
    .select('*')
    .eq('schedule_id', schedules[0].id)
    .eq('row_type', 'payment')
    .gte('row_date', today)
    .order('row_date', { ascending: true })
  if (rowsErr) return { action: 'skipped', reason: 'lookup_failed', detail: rowsErr.message }
  if (!futureRows?.length) return { action: 'skipped', reason: 'no_future_payment_rows' }

  // Group future payment rows by month, in date order.
  const byMonth = new Map<string, any[]>()
  for (const r of futureRows) {
    const label = String(r.row_date).slice(0, 7)
    if (!byMonth.has(label)) byMonth.set(label, [])
    byMonth.get(label)!.push(r)
  }

  // Rule 2: first month without a consumed split gets the card.
  for (const [periodLabel, rows] of byMonth) {
    const { data: existing, error: exErr } = await supa
      .from('loan_splits')
      .select('id, status')
      .eq('loan_account_id', loanAccountId)
      .eq('period_label', periodLabel)
      .limit(1)
    if (exErr) return { action: 'skipped', reason: 'lookup_failed', detail: exErr.message }
    const prior = existing?.[0]
    if (prior && prior.status !== 'pending_review') continue // consumed (posted / already_in_xero / ...) -- walk on

    const principal = Math.round(rows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
    const interest = Math.round(rows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
    const total = Math.round(rows.reduce((s: number, r: any) => s + Number(r.payment || 0), 0) * 100) / 100
    const isAggregate = rows.length > 1

    const { data: split, error: splitErr } = await supa
      .from('loan_splits')
      .upsert({
        loan_account_id: loanAccountId,
        period_label: periodLabel,
        prior_statement_id: null,
        current_statement_id: null,
        source: 'amortization_schedule',
        amortization_row_id: rows[0].id,
        principal_amount: principal,
        interest_amount: interest,
        total_amount: total,
        status: 'pending_review',
        review_notes: isAggregate ? `Aggregated from ${rows.length} schedule rows in ${periodLabel} (e.g. origination month with multiple partial payments).` : null,
      }, { onConflict: 'loan_account_id,period_label' })
      .select()
      .single()
    if (splitErr) return { action: 'skipped', reason: 'lookup_failed', detail: splitErr.message }
    return { action: prior ? 'refreshed' : 'created', period_label: periodLabel, split_id: split?.id }
  }

  return { action: 'skipped', reason: 'no_future_payment_rows', detail: 'every future payment month already has a consumed split' }
}
