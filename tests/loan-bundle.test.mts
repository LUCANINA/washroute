// tests/loan-bundle.test.mts — the document readers and the basis detector.
//
// Run:  npx tsx tests/loan-bundle.test.mts
// Needs: npm i -D tsx pdfjs-dist@3.11.174   and the two source documents below.
//
// WHY THIS FILE EXISTS, AND WHY IT IS LONG
// Two red teams attacked the first version of these parsers and found 30 defects
// between them. Every assertion below is one of those defects, pinned so it
// cannot come back. The ones worth knowing by name:
//
//   * a fee LARGER than the loan silently swapped Loan Amount and Fixed Fee, at
//     high confidence, and the cross-check certified the swap (870 of 4,000
//     fuzzed agreements came back confidently wrong)
//   * a newline inside a quoted CSV description FABRICATED a payment: one real
//     $10.00 charge parsed as $510.00, ok:true, zero rejections
//   * an unterminated quote did the mirror — it swallowed the rest of the file
//     and reported $28.84 against a true $11,192.29
//   * a reversal exported as a positive paydown was counted as another payment
//   * `Number('-1,234.56')` is NaN, so a thousands separator moved real money
//     into a rejected list that was truncated at 50 while ok stayed true
//   * cents() double-rounded, turning 545.4545… into 545.46
//
// If an assertion here fails, do not adjust the expected value. Every number in
// this file came off a real document or an independent calculation.

import { createRequire } from 'module'
import * as SC from '../supabase/functions/_shared/stripe-capital.ts'
import { detectCarryingBasisDrift } from '../supabase/functions/_shared/carrying-basis-drift.ts'

const require = createRequire(import.meta.url)
const fs = require('fs')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')

const AGREEMENT_PDF = process.env.WR_AGREEMENT_PDF || './fixtures/Stripe_Capital_agreement.pdf'
const TRANSACTIONS_CSV = process.env.WR_STRIPE_CSV || './fixtures/Stripe_July.csv'

let pass = 0, fail = 0
const chk = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name}${ok ? '' : `  got=${got} want=${want}`}`)
}
const section = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`)

async function pdfText(path: string): Promise<string> {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(fs.readFileSync(path)), useSystemFonts: true }).promise
  let t = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent()
    t += c.items.map((x: any) => x.str).join(' ') + '\n'
  }
  return t
}

// ── The real agreement ──────────────────────────────────────────────────────
section('agreement: the real document')
const text = await pdfText(AGREEMENT_PDF)
const a = SC.parseStripeCapitalAgreement(text)
chk('parses', a.ok, true)
chk('nothing unresolved', a.unresolved.length, 0)
const T: Record<string, any> = {}
for (const t of a.terms) T[t.term_key] = { v: t.value_numeric ?? t.value_date ?? t.value_text, c: t.confidence }
chk('loan_amount', T.loan_amount?.v, 125000)
chk('fixed_fee', T.fixed_fee?.v, 20875)
chk('total_repayment_amount', T.total_repayment_amount?.v, 145875)
chk('net_loan_proceeds', T.net_loan_proceeds?.v, 125000)
chk('minimum_payment_amount', T.minimum_payment_amount?.v, 16208.34)
chk('repayment_rate_percent', T.repayment_rate_percent?.v, 8)
chk('origination_date', T.origination_date?.v, '2026-06-30')
chk('repayment_start_date', T.repayment_start_date?.v, '2026-07-07')
chk('final_repayment_date', T.final_repayment_date?.v, '2027-12-29')
chk('minimum_payment_period_days', T.minimum_payment_period_days?.v, 60)
chk('lender_account_ref', T.lender_account_ref?.v, 'acct_1MPrRDGACgbvEugH')
chk('originating_bank', T.originating_bank?.v, 'Celtic Bank')
for (const k of ['loan_amount', 'fixed_fee', 'total_repayment_amount', 'origination_date', 'repayment_start_date', 'final_repayment_date']) {
  chk(`${k} is high confidence`, T[k]?.c, 'high')
}

// ── Agreement: refusals that must stay refusals ─────────────────────────────
section('agreement: refusals')
const bare = text.slice(text.search(/Final\s+Repayment\s+Date\s*\*\*/i))
chk('brochure with a fake account id refuses',
  SC.parseStripeCapitalAgreement(text.replace(/acct_1MPrRDGACgbvEugH/g, 'acct_EXAMPLE')).ok, false)
chk('specimen wording refuses',
  SC.parseStripeCapitalAgreement(text.replace('Loan Agreement', 'Loan Agreement (illustrative example only)')).ok, false)
chk('two agreements in one file refuses',
  SC.parseStripeCapitalAgreement(text + '\n' + text).ok, false)
chk('missing footnote boundary refuses',
  SC.parseStripeCapitalAgreement(text.replace(/\*\s*If you have a Prior Outstanding Balance/, 'X')).ok, false)
chk('negative amount in the summary refuses',
  SC.parseStripeCapitalAgreement(text.replace('$16,208.34', '-$16,208.34')).ok, false)
chk('three-decimal amount refuses',
  SC.parseStripeCapitalAgreement(text.replace('$16,208.34', '$16,208.345')).ok, false)
chk('a fourth date drops the term dates, does not displace them', (() => {
  const r = SC.parseStripeCapitalAgreement(text.replace('December 29, 2027', 'December 29, 2027 December 31, 2027'))
  return r.ok && !r.terms.some(t => t.term_key === 'final_repayment_date') && r.unresolved.length > 0
})(), true)

// ── The real transaction export ─────────────────────────────────────────────
section('transactions: the real export')
const raw: string = fs.readFileSync(TRANSACTIONS_CSV, 'utf8')
const p = SC.parseStripeCapitalCsv(raw)
chk('parses', p.ok, true)
chk('rows accepted', p.rows_accepted, 1352)
chk('rows rejected', p.rows_rejected_count, 0)
chk('currency', p.currency, 'usd')
// UTC -> Pacific. In UTC this file straddles two months and understates July by
// $28.84; in Pacific it is one clean month.
chk('first date (Pacific)', p.first_date, '2026-07-06')
chk('last date (Pacific)', p.last_date, '2026-07-31')
chk('one month', p.months.length, 1)
chk('total paid', p.totals!.total_paid, 11192.29)
chk('principal paid', p.totals!.principal_paid, 9590.61)
chk('fee paid', p.totals!.fee_paid, 1601.68)

section('transactions: attacks')
chk('positive paydown (a reversal) is rejected', (() => {
  const lines = raw.split('\n')
  const evil = [lines[0], lines[1].replace(/-/g, ''), ...lines.slice(1)].join('\n')
  const r = SC.parseStripeCapitalCsv(evil)
  return r.rows_rejected_count >= 1 && r.ok === false
})(), true)
chk('unterminated quote refuses (never silently truncates)', (() => {
  const lines = raw.split('\n'); lines[3] = lines[3].replace('Automatic', '"Automatic')
  return SC.parseStripeCapitalCsv(lines.join('\n')).ok
})(), false)
chk('newline inside a quoted field does not fabricate a row', (() => {
  const hdr = raw.split('\n')[0]
  const one = `${hdr}\n2026-07-15 12:00,usd,-10.00,-8.57,-1.43,paydown,"Automatic\nfinancing payment"`
  const r = SC.parseStripeCapitalCsv(one)
  return r.rows_accepted === 1 && r.totals!.total_paid === 10
})(), true)
chk('thousands separators are read, not dropped', (() => {
  const hdr = raw.split('\n')[0]
  const r = SC.parseStripeCapitalCsv(`${hdr}\n2026-07-15 12:00,usd,"-1,234.56","-1,058.00","-176.56",paydown,x`)
  return r.rows_accepted === 1 && r.totals!.total_paid === 1234.56
})(), true)
chk('impossible date is rejected, not rolled over', SC.utcStampToPacificDate('2026-06-31 12:00'), null)
chk('month 13 is rejected', SC.utcStampToPacificDate('2026-13-01 12:00'), null)
chk('hour 25 is rejected', SC.utcStampToPacificDate('2026-07-15 25:00'), null)
chk('a trailing offset is rejected, not read as UTC', SC.utcStampToPacificDate('2026-07-15 12:00:00-07:00'), null)
chk('a real leap day is accepted', SC.utcStampToPacificDate('2024-02-29 12:00'), '2024-02-29')
chk('blank amount is rejected, not read as zero', SC.parseMoneyToMinor(''), null)
chk('mixed currencies refuse', (() => {
  const hdr = raw.split('\n')[0]
  return SC.parseStripeCapitalCsv(`${hdr}\n2026-07-15 12:00,usd,-10.00,-8.57,-1.43,paydown,x\n2026-07-15 13:00,eur,-10.00,-8.57,-1.43,paydown,y`).ok
})(), false)

section('cents(): half-up on the decimal, rounded once')
for (const [i, o] of [[2.135, 2.14], [4.015, 4.02], [8.165, 8.17], [1.005, 1.01],
                      [1000.005, 1000.01], [125000.005, 125000.01],
                      [545.4545454545454, 545.45], [9.99499, 9.99]] as [number, number][]) {
  chk(`cents(${i})`, SC.cents(i), o)
}

section('the decomposition rule: agreement x export')
const d = SC.verifyDecompositionRule(p.accepted, T.fixed_fee.v, T.total_repayment_amount.v)
chk('holds', d.holds, true)
chk('checked every accepted row', d.rows_checked, p.rows_accepted)
chk('none failing', d.rows_failing, 0)

// ── The carrying-basis detector ─────────────────────────────────────────────
section('carrying basis: the states that matter')
const TERMS = { loan_amount: 125000, fixed_fee: 20875, total_repayment_amount: 145875 }
const bal = (v: number) => [
  { statement_date: '2026-07-01', principal_balance: 145875 },
  { statement_date: '2026-08-26', principal_balance: v },
]
const unsplitSplits = [
  { period_label: '2026-07', principal_amount: 9296.75, interest_amount: 0, total_amount: 9296.75 },
  { period_label: '2026-08', principal_amount: 11320.54, interest_amount: 0, total_amount: 11320.54 },
]
const drift = (recorded: any, balance: number, splits = unsplitSplits) =>
  detectCarryingBasisDrift({ loan_id: 'x', loan_label: 'L', recorded_basis: recorded, terms: TERMS, balances: bal(balance), splits })

chk('unrecorded basis on a payoff-basis loan is spotted', drift('unknown', 125257.71).observed_basis, 'gross_payback')
chk('correctly recorded payoff basis is silent', drift('gross_payback', 125257.71).verdict, 'consistent')
// The scenario that matters: someone reverses the origination fee entry.
const rev = drift('gross_payback', 125257.71 - 20875)
chk('fee reversal -> payments_unsplit', rev.verdict, 'payments_unsplit')
chk('  ...is an error', rev.severity, 'error')
chk('  ...names the amount in the wrong account', rev.payments_need_splitting?.financing_cost_in_principal, 2950.37)
chk('  ...and the share of every payment', rev.payments_need_splitting?.fee_share_percent, 14.3102)
chk('properly split net basis is silent', drift('net_principal', 125000 - 17666.92, [
  { period_label: '2026-07', principal_amount: 7966.36, interest_amount: 1330.39, total_amount: 9296.75 },
  { period_label: '2026-08', principal_amount: 9700.57, interest_amount: 1619.97, total_amount: 11320.54 },
]).verdict, 'consistent')
chk('a rogue journal fits no model', drift('gross_payback', 125257.71 - 5000).verdict, 'fits_neither')
chk('no terms on file -> stays quiet rather than guessing', detectCarryingBasisDrift({
  loan_id: 'x', loan_label: 'L', recorded_basis: 'unknown',
  terms: { loan_amount: null, fixed_fee: null, total_repayment_amount: null },
  balances: bal(125257.71), splits: unsplitSplits,
}).verdict, 'not_enough_evidence')

console.log(`\n${'═'.repeat(64)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(64)}`)
process.exit(fail ? 1 : 0)
