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
//   2. Otherwise, walk the FUTURE payment rows of the latest schedule in order and
//      create a pending_review split for the first period that doesn't already have
//      a consumed split (posted / already_in_xero / anything else). Exactly one.
//      Period granularity follows the loan's cadence: a month with ONE payment row
//      is a monthly period (period_label 'YYYY-MM', the Verdant/Dexter/PCV shape); a
//      month with SEVERAL payment rows (PayPal 2's weekly drafts) gets one split PER
//      ROW, period_label 'YYYY-MM-DD' -- a staged transaction must equal exactly one
//      bank-feed line, and four separate weekly drafts can never match one monthly
//      aggregate. (Day labels also match how PayPal 2's 33 historical splits were
//      already labeled.) Cadence is judged from ALL of the month's payment rows,
//      not just the future ones -- otherwise the last remaining draft of a weekly
//      month would masquerade as a monthly period and flip the label convention
//      mid-month (caught in the session-226 end-of-session review).
//   3. Splits are created with the same shape loan-generate-schedule-split uses
//      (source='amortization_schedule') -- downstream stage/post code treats them
//      identically.
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

  // Newest schedule WITH future payment rows (session 226 close). "Latest wins"
  // alone would kill weekly staging on the next lender-CSV pull: a PayPal-style
  // actuals-history re-ingest lands as a NEW schedule (new generated date) that
  // contains ONLY past payments, and if the walk stopped there, no card would
  // ever appear again -- silently. So: schedules newest-first, use the first one
  // that still has a stageable future payment row. A schedule the walk skipped is
  // named in the result detail so the fallback is visible, never silent.
  // nullsFirst:false matters: Postgres puts NULLs first on a DESC order by
  // default, so a schedule ingested without a generated date would otherwise beat
  // every properly dated one.
  const { data: schedules, error: schedErr } = await supa
    .from('loan_amortization_schedules')
    .select('id, schedule_generated_date')
    .eq('loan_account_id', loanAccountId)
    .order('schedule_generated_date', { ascending: false, nullsFirst: false })
  if (schedErr) return { action: 'skipped', reason: 'lookup_failed', detail: schedErr.message }
  if (!schedules?.length) return { action: 'skipped', reason: 'no_schedule' }

  let allRows: any[] | null = null
  let futureRows: any[] = []
  let usedSchedule: any = null
  const skipped: string[] = []
  for (const sched of schedules) {
    // ALL payment rows -- the full set decides each month's cadence; only the
    // future ones are stageable.
    const { data: rows, error: rowsErr } = await supa
      .from('loan_amortization_rows')
      .select('*')
      .eq('schedule_id', sched.id)
      .eq('row_type', 'payment')
      .order('row_date', { ascending: true })
    if (rowsErr) return { action: 'skipped', reason: 'lookup_failed', detail: rowsErr.message }
    const future = (rows || []).filter((r: any) => String(r.row_date).slice(0, 10) >= today)
    if (future.length) { allRows = rows || []; futureRows = future; usedSchedule = sched; break }
    skipped.push(`gen ${sched.schedule_generated_date ?? 'undated'}`)
  }
  if (!usedSchedule) return { action: 'skipped', reason: 'no_future_payment_rows' }
  const fallbackNote = skipped.length
    ? `newest schedule${skipped.length > 1 ? 's' : ''} (${skipped.join(', ')}) had no future payment rows; used schedule gen ${usedSchedule.schedule_generated_date ?? 'undated'}`
    : undefined

  // Month cadence from the FULL row set; stageable units from the future rows.
  const monthCount = new Map<string, number>()
  for (const r of allRows || []) {
    const m = String(r.row_date).slice(0, 7)
    monthCount.set(m, (monthCount.get(m) || 0) + 1)
  }
  const byMonth = new Map<string, any[]>()
  for (const r of futureRows) {
    const label = String(r.row_date).slice(0, 7)
    if (!byMonth.has(label)) byMonth.set(label, [])
    byMonth.get(label)!.push(r)
  }
  const units: Array<{ label: string, rows: any[] }> = []
  for (const [monthLabel, rows] of byMonth) {
    if ((monthCount.get(monthLabel) || 0) > 1) for (const r of rows) units.push({ label: String(r.row_date).slice(0, 10), rows: [r] })
    else units.push({ label: monthLabel, rows })
  }

  // Rule 2: first unit without a consumed split gets the card.
  for (const { label: periodLabel, rows } of units) {
    const { data: existing, error: exErr } = await supa
      .from('loan_splits')
      .select('id, status, source')
      .eq('loan_account_id', loanAccountId)
      .eq('period_label', periodLabel)
      .limit(1)
    if (exErr) return { action: 'skipped', reason: 'lookup_failed', detail: exErr.message }
    const prior = existing?.[0]
    // Walk past a period that is consumed (posted / already_in_xero / ...) OR that
    // belongs to another flow: a statement_delta pending_review split must never be
    // silently converted into a schedule split by this upsert (rule 4).
    if (prior && (prior.status !== 'pending_review' || prior.source !== 'amortization_schedule')) continue

    const principal = Math.round(rows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
    const interest = Math.round(rows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
    const total = Math.round(rows.reduce((s: number, r: any) => s + Number(r.payment || 0), 0) * 100) / 100

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
        review_notes: null,
      }, { onConflict: 'loan_account_id,period_label' })
      .select()
      .single()
    if (splitErr) return { action: 'skipped', reason: 'lookup_failed', detail: splitErr.message }
    return { action: prior ? 'refreshed' : 'created', period_label: periodLabel, split_id: split?.id, detail: fallbackNote }
  }

  return { action: 'skipped', reason: 'no_future_payment_rows', detail: 'every future payment month already has a consumed split' }
}
