// ============================================================================
// The double-correction check, and the three things it needs.
//
// This lives in its own module for one reason: it is the check that was WRONG in
// production, and a check that cannot be run against a fixture cannot be trusted. See
// double-reallocation.test.ts for the four cases that must keep behaving.
// ============================================================================

export const INTEREST_CODE = '800'
export const money = (n: number) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export type Finding = {
  fingerprint: string; check_key: string; severity: 'info' | 'warn' | 'error'
  loan_account_id: string | null; title: string; plain_english: string
  detail: any; proposed_action?: any
}

// ── The double-correction check (session 232, rewritten session 233) ───────
// checkLumpedPayments below answers "was this payment ever split?" and stops the moment
// it sees an interest line — a payment split at source is assumed finished. That is the
// blind spot that cost $1,023.20 on Funding Circle 2026-07-20: the bank transaction was
// split at source ($1,010.57 loan / $1,023.20 interest) AND carried manual journal
// #52216 moving another $1,008.06 out of the same loan account. Two people corrected the
// same payment six days apart, neither able to see the other's work.
//
// The FIRST version of this check (session 232) paired a payment with any reallocation
// journal within ±40 days, mirroring checkLumpedPayments' window. On a loan that pays
// monthly, ±40 days reaches into the months either side, so every correctly-handled
// payment got blamed for its NEIGHBOUR's journal. It produced 33 findings on its first
// real run and every single one was false: BayFirst SBA 2's journal of 2026-07-03 (which
// names its own payment in the narration — "2026-07-02 reallocation") was cited against
// both the June 3 and the August 3 payments. Several findings reported a NEGATIVE
// principal remainder, which is arithmetically impossible and should have failed the
// check before it shipped.
//
// A date window cannot answer "which payment does this journal belong to". We do not
// have to guess: when this app posts a reallocation it records both ends of the link on
// the split — matched_xero_bank_transaction_id and xero_manual_journal_id. That link is
// the evidence. This check now reads it, and reports nothing about journals it cannot
// prove ownership of. Silence on a human's hand-written journal is correct: a false
// "this is overstated by $1,300" costs more than a missed one, because it teaches the
// reader to skim the FIX FIRST list.
//
// The remaining subtlety is the TOP-UP, which looks identical to a double count from the
// outside. Rapid Credit Line 2026-03-31: $742.60 of interest on the transaction itself,
// plus a $480.00 journal — and the period's real interest is $1,222.60, exactly the sum.
// The journal completed the split; it did not repeat it. So the test is not "both halves
// exist" but "both halves together exceed the interest this period actually owes".
export function checkDoubleReallocation(loan: any, ledger: any, mySplits: any[]): Finding[] {
  const code = loan.xero_account_code
  const rows = ledger[code] || []
  const out: Finding[] = []
  if (loan.ingestion_method === 'automatic') return []

  const byId: Record<string, any> = {}
  for (const r of rows) byId[String(r.srcId)] = r
  const cents = (n: number) => Math.round(n * 100) / 100
  const interestOn = (r: any) => cents((r?.lines || [])
    .filter((l: any) => l.c === INTEREST_CODE)
    .reduce((t: number, l: any) => t + Math.abs(Number(l.a || 0)), 0))

  // ── 1. a payment corrected at source AND by our own journal, beyond what it owes ──
  const linked = (mySplits || []).filter(s => !s.voided_at
    && s.matched_xero_bank_transaction_id && s.xero_manual_journal_id
    && ['posted', 'already_in_xero'].includes(String(s.status)))

  for (const s of linked) {
    const txn = byId[String(s.matched_xero_bank_transaction_id)]
    const jnl = byId[String(s.xero_manual_journal_id)]
    if (!txn || !jnl) continue                    // outside the loaded window; say nothing
    if (txn.srcType !== 'BankTransaction' || jnl.srcType !== 'ManualJournal') continue

    const atSource = interestOn(txn)
    const viaJournal = interestOn(jnl)
    if (!(atSource > 0) || !(viaJournal > 0)) continue   // corrected once — the normal case

    // The top-up test. The split itself carries what this period's interest actually is,
    // computed from the lender's own figures. Only the excess over that is double-counted.
    const owed = cents(Math.abs(Number(s.interest_amount || 0)))
    const overstated = cents(atSource + viaJournal - owed)
    if (overstated <= 0.01) continue              // the journal completed the split

    const total = cents(Math.abs(Number(txn.total || 0)))
    out.push({
      fingerprint: `double_reallocation:${code}:${txn.srcId}`,
      check_key: 'double_reallocation',
      severity: 'error',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — ${txn.date} payment of ${money(total)} was corrected twice`,
      plain_english:
        `This payment is split on the bank transaction itself (${money(atSource)} to interest), and manual `
        + `journal ${jnl.srcId} moves a further ${money(viaJournal)} of the same payment to interest. `
        + `The ${s.period_label} interest on this loan is ${money(owed)}, so ${money(overstated)} of it has been `
        + `booked twice: interest expense is overstated by that much and the loan balance is understated by the same. `
        + `Each half looks correct on its own, which is why this goes unnoticed — nothing on a bank transaction `
        + `says a journal has already reallocated it. Decide which correction to keep: void the journal, or `
        + `re-code the transaction to a single line.`,
      detail: {
        code, date: txn.date, bank_transaction_id: txn.srcId, total,
        split_id: s.id, period_label: s.period_label,
        interest_at_source: atSource,
        interest_from_journal: viaJournal,
        interest_owed_this_period: owed,
        overstated_by: overstated,
        manual_journal_id: jnl.srcId, journal_date: jnl.date,
        paired_by: 'loan_splits link',
      },
    })
  }

  // ── 2. two splits claiming the same payment ──────────────────────────────
  // E-Transit 4140: the 2026-05 and 2026-06 splits both point at the 2026-05-18 bank
  // transaction, so two reallocation journals landed on one $1,180.32 payment while the
  // June payment went uncorrected. This is how a period silently skips.
  const claims: Record<string, any[]> = {}
  for (const s of (mySplits || [])) {
    if (s.voided_at || !s.matched_xero_bank_transaction_id) continue
    if (!['posted', 'already_in_xero', 'staged'].includes(String(s.status))) continue
    ;(claims[String(s.matched_xero_bank_transaction_id)] ||= []).push(s)
  }
  for (const [btx, group] of Object.entries(claims)) {
    if (group.length < 2) continue
    const txn = byId[btx]
    const periods = group.map(g => g.period_label).sort()
    const totalInterest = cents(group.reduce((t, g) => t + Math.abs(Number(g.interest_amount || 0)), 0))
    out.push({
      fingerprint: `split_collision:${code}:${btx}`,
      check_key: 'split_collision',
      severity: 'error',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — ${group.length} periods are booked against the same ${txn?.date ?? ''} payment`.replace('  ', ' '),
      plain_english:
        `The splits for ${periods.join(' and ')} are both recorded against the same bank transaction`
        + `${txn ? ` (${txn.date}, ${money(cents(Math.abs(Number(txn.total || 0))))})` : ''}. `
        + `One payment cannot settle two periods, so ${money(totalInterest)} of interest has been reallocated out of `
        + `this single payment — and whichever period's real payment was skipped is still sitting unsplit, `
        + `counted entirely as principal. Re-match the later split to its own payment.`,
      detail: {
        code, bank_transaction_id: btx, date: txn?.date ?? null,
        periods, split_ids: group.map(g => g.id),
        interest_reallocated_total: totalInterest,
      },
    })
  }

  return out
}
