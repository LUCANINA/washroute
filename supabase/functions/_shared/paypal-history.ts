// _shared/paypal-history.ts — PayPal's loan-history CSV, read as a LEDGER and as
// a statement of the loan's opening terms.
//
// ─── WHY THIS EXISTS (session 263 cont.) ────────────────────────────────────
// `loan-bundle` could read exactly one transaction export: Stripe Capital's. So
// when David uploaded PayPal's loan-history CSV and its portal screenshot in one
// bundle and asked the two to be read together, the bundle held every fact
// needed to date that screenshot and used none of them:
//
//   * the screen states $47,806.14 still owed and prints NO as-of date;
//   * the CSV states the contract — a $157,000.00 wire and a $20,565.12 fee, so
//     $177,565.12 repaid in all — which turns that balance into $129,758.98 paid;
//   * and the CSV lists every payment with a date, so the day its cumulative
//     reaches $129,758.98 is the day the screen was showing.
//
// Every piece was in the bundle. Nothing joined them, because the CSV was not
// recognised as a ledger and the terms were not recognised as terms.
//
// ─── THE PROVENANCE POINT, WHICH IS THE WHOLE DESIGN ────────────────────────
// The terms here are NOT agreement terms and this module refuses to let them be
// mistaken for some. `agreementTerms` in loan-bundle-plan.ts means the SIGNED
// DOCUMENT, and its action says "Record N contract terms from the agreement".
// A transaction export stating an advance and a fee is good evidence — it is the
// lender's own record of what it actually sent and actually charged — but it is
// a different KIND of evidence from a contract, and this module has learnt more
// than once (Tech Debt #31) that a mechanism name silently standing in for a
// provenance is how our own arithmetic ends up speaking in the lender's voice.
// So these come back under their own key, are recorded with their own
// `extracted_by`, and the plan names the CSV when it proposes them.
//
// ─── AND WHY DATING OFF THIS FILE IS NOT CIRCULAR ───────────────────────────
// §246's rule is that a check whose inputs share a source cannot fail. Here the
// terms and the days both come from this one CSV — but the TARGET does not. The
// target is the balance printed on a screenshot, and the question asked is "does
// any day in this ledger reach it?". A screenshot that disagreed with the CSV
// would match no day at all, which is precisely the failure a circular check
// cannot produce. The independent input is the screen, and without it there is
// no target and no answer. `tests/paypal-history.test.mts` asserts both halves.
//
// Money is read to the cent and summed in integer cents, same as everywhere in
// this module: a cumulative sum is where float drift accumulates fastest, and an
// exact-match dating engine downstream will simply report "no day matches" for a
// file that matched perfectly.

import type { ContractTerm, StripeCsvDay, StripeCsvParseResult } from './stripe-capital.ts'

/** What the origination rows state, when the file carries them. */
export interface PayPalOrigination {
  loan_amount: number | null
  fixed_fee: number | null
  total_repayment_amount: number | null
  origination_date: string | null
}

/**
 * Structurally a `StripeCsvParseResult` — deliberately not a subclass and not a
 * shared parser. Same precedent as settlement-lag.ts and ledger-dating.ts: the
 * next lender of this shape will have its own reader and the same days.
 */
export interface PayPalHistoryParseResult extends StripeCsvParseResult {
  origination: PayPalOrigination | null
  /** The opening figures as recordable terms. Empty when the file has no origination rows. */
  terms: ContractTerm[]
}

const REQUIRED = ['Date', 'Description', 'Amount', 'Principal', 'Fee']
const PAYMENT_DESC = 'Auto Draft Payment'
const ADVANCE_DESC = 'Wire'
const FEE_DESC = 'Total Loan Fee'

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQuotes = false
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

const MDY = /^(\d{2})\/(\d{2})\/(\d{4})$/
function mdyToIso(s: string): string | null {
  const m = MDY.exec(String(s).trim())
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null
}

/**
 * Dollars to integer cents, or null when the cell is not a cent amount.
 *
 * Returns null rather than 0 on a cell it cannot read. The browser's own
 * `_parsePayPalHistoryCsv` uses `|| 0`, which turns an unreadable amount into a
 * silent zero and a short cumulative — survivable when the output is a display
 * balance, not survivable when the output is a DATE.
 */
function toCents(raw: unknown): number | null {
  const s = String(raw ?? '').trim().replace(/[$,]/g, '')
  if (!s || !/^-?\d+(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  const c = Math.round(n * 100)
  return Number.isSafeInteger(c) ? c : null
}

const major = (cents: number) => cents / 100
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function detectPayPalHistoryCsv(text: string): boolean {
  const first = String(text ?? '').trim().split(/\r?\n/)[0]
  if (!first) return false
  const cols = first.split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return REQUIRED.every(h => cols.includes(h))
}

export function parsePayPalHistoryCsv(text: string): PayPalHistoryParseResult {
  const label = 'PayPal loan history export'
  const base: PayPalHistoryParseResult = {
    ok: false, lender_label: label, rows_in_file: 0, rows_accepted: 0,
    rows_rejected_count: 0, rows_skipped_not_applicable: 0,
    rows_rejected_sample: [], currency: 'USD', months: [], days: [],
    totals: null, first_date: null, last_date: null, accepted: [],
    refused_because: null, origination: null, terms: [],
  }
  if (!detectPayPalHistoryCsv(text)) {
    return { ...base, refused_because: 'This file does not carry PayPal loan-history columns.' }
  }

  const lines = String(text).trim().split(/\r?\n/)
  const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  const idx: Record<string, number> = {}
  header.forEach((h, i) => { idx[h] = i })

  const rejected: { line: number; reason: string }[] = []
  let rowsInFile = 0, skipped = 0
  let advanceC: number | null = null, feeC: number | null = null
  let advanceDate: string | null = null, feeDate: string | null = null

  // One entry per DAY, not per row: a lender can draft twice on one date, and a
  // staged transaction must equal exactly one bank-feed line either way.
  const byDay = new Map<string, { total: number; principal: number; fee: number; n: number }>()

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue
    rowsInFile++
    const cols = splitCsvLine(raw)
    const iso = mdyToIso(cols[idx['Date']])
    const desc = String(cols[idx['Description']] ?? '').trim()
    if (!iso) { rejected.push({ line: i + 1, reason: 'the date could not be read' }); continue }

    if (desc === ADVANCE_DESC) {
      const c = toCents(cols[idx['Principal']])
      if (c === null) { rejected.push({ line: i + 1, reason: 'the advance amount could not be read' }); continue }
      // Two advances would mean a drawdown facility, and one summed opening
      // figure would misstate the contract. Refuse rather than add them up.
      if (advanceC !== null) { rejected.push({ line: i + 1, reason: 'a second advance row — this reader states one opening advance or none' }); continue }
      advanceC = c; advanceDate = iso; skipped++
      continue
    }
    if (desc === FEE_DESC) {
      const c = toCents(cols[idx['Fee']])
      if (c === null) { rejected.push({ line: i + 1, reason: 'the fee amount could not be read' }); continue }
      if (feeC !== null) { rejected.push({ line: i + 1, reason: 'a second total-fee row' }); continue }
      feeC = c; feeDate = iso; skipped++
      continue
    }
    if (desc !== PAYMENT_DESC) {
      // Not a payment and not an origination row. Skipped, counted, never
      // silently folded into the totals — the distinction between an excluded
      // row and an unread one is the one stripe-capital.ts had to learn.
      skipped++
      continue
    }

    const total = toCents(cols[idx['Amount']])
    const principal = toCents(cols[idx['Principal']])
    const fee = toCents(cols[idx['Fee']])
    if (total === null || principal === null || fee === null) {
      rejected.push({ line: i + 1, reason: 'an amount on this payment row could not be read' }); continue
    }
    // The file signs payments negative. A payment whose parts do not foot to its
    // total is not a payment this reader will state anything about.
    const t = Math.abs(total), p = Math.abs(principal), f = Math.abs(fee)
    if (p + f !== t) {
      rejected.push({ line: i + 1, reason: `the split does not foot: ${money(major(p))} + ${money(major(f))} is not ${money(major(t))}` }); continue
    }
    const d = byDay.get(iso) ?? { total: 0, principal: 0, fee: 0, n: 0 }
    d.total += t; d.principal += p; d.fee += f; d.n++
    byDay.set(iso, d)
  }

  const days: StripeCsvDay[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date, transaction_count: v.n,
      total_paid: major(v.total), principal_paid: major(v.principal), fee_paid: major(v.fee),
    }))

  const accepted = days.reduce((a, d) => a + d.transaction_count, 0)
  const totalC = [...byDay.values()].reduce((a, v) => a + v.total, 0)
  const princC = [...byDay.values()].reduce((a, v) => a + v.principal, 0)
  const feePaidC = [...byDay.values()].reduce((a, v) => a + v.fee, 0)

  const origination: PayPalOrigination | null = (advanceC !== null || feeC !== null)
    ? {
        loan_amount: advanceC === null ? null : major(advanceC),
        fixed_fee: feeC === null ? null : major(feeC),
        // Stated only when BOTH halves are on the file. A total repayment built
        // from one of them plus an assumption is exactly the figure downstream
        // would date a balance against.
        total_repayment_amount: (advanceC !== null && feeC !== null) ? major(advanceC + feeC) : null,
        origination_date: advanceDate ?? feeDate,
      }
    : null

  const terms: ContractTerm[] = []
  if (origination) {
    const src = `PayPal loan history CSV, origination rows${origination.origination_date ? ` dated ${origination.origination_date}` : ''}`
    if (origination.loan_amount !== null) {
      terms.push({ term_key: 'loan_amount', value_numeric: origination.loan_amount, source_text: `${ADVANCE_DESC} ${money(origination.loan_amount)}`,
        basis: `The cash the lender actually sent, as its own transaction history records it.`, confidence: 'high' })
    }
    if (origination.fixed_fee !== null) {
      terms.push({ term_key: 'fixed_fee', value_numeric: origination.fixed_fee, source_text: `${FEE_DESC} ${money(origination.fixed_fee)}`,
        basis: `The whole fee charged at origination, as the lender's own transaction history records it.`, confidence: 'high' })
    }
    if (origination.total_repayment_amount !== null) {
      terms.push({ term_key: 'total_repayment_amount', value_numeric: origination.total_repayment_amount,
        source_text: `${ADVANCE_DESC} ${money(origination.loan_amount!)} + ${FEE_DESC} ${money(origination.fixed_fee!)}`,
        basis: `The advance plus the fee — the two origination rows added, not a figure the file prints.`, confidence: 'high' })
    }
    if (origination.origination_date) {
      terms.push({ term_key: 'origination_date', value_date: origination.origination_date, source_text: `${ADVANCE_DESC} ${origination.origination_date}`,
        basis: `The date the lender's own history gives its advance row.`, confidence: 'high' })
    }
  }

  const ok = rejected.length === 0 && days.length > 0
  return {
    ...base,
    ok,
    rows_in_file: rowsInFile,
    rows_accepted: accepted,
    rows_rejected_count: rejected.length,
    rows_skipped_not_applicable: skipped,
    rows_rejected_sample: rejected.slice(0, 50),
    days,
    totals: days.length ? { total_paid: major(totalC), principal_paid: major(princC), fee_paid: major(feePaidC) } : null,
    first_date: days.length ? days[0].date : null,
    last_date: days.length ? days[days.length - 1].date : null,
    origination,
    terms,
    refused_because: ok ? null : (days.length === 0
      ? 'No readable payment rows in this file.'
      : `${rejected.length} row${rejected.length === 1 ? '' : 's'} could not be read.`),
  }
}
