// Session 353: stubMismatches() -- the to-the-cent pay-stub check shared by
// payroll-ingest, payroll-check-attention and payroll-xero-post.
// Run: node --experimental-strip-types tests/payroll-stub-mismatch.test.mts
// Rows are production-shaped: PostgREST returns numeric columns as STRINGS.
import { stubMismatches, describeStubMismatches, splitStubMismatches, roundingTotal, ACCT_ROUNDING } from '../supabase/functions/_shared/payroll-clearing.ts'

let pass = 0, fail = 0
const eq = (got: unknown, want: unknown, msg: string) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`)
}

// The real Oct 16, 2026 row that Xero rejected: pays $558.68, withholds $150.19,
// Square's Net Pay is $408.48 -- one cent short of $408.49.
const andres = { raw_full_name: 'Andres Higuera', line_type: 'employee', wage_amount: '558.68', paycheck_tips_amount: '0.00',
  insurance_reimbursement_amount: '0', ee_fed_income_amount: '16', ee_social_security_amount: '30.42', ee_medicare_amount: '7.12',
  ee_ca_state_income_amount: '0', ee_ca_state_disability_amount: '6.38', ee_health_amount: '67.93', ee_401k_amount: '22.34', net_pay_amount: '408.48' }
const andresFixed = { ...andres, net_pay_amount: '408.49' }
// A tipped stub with an insurance reimbursement -- every term of the identity in play.
const tipped = { raw_full_name: 'Tipped Worker', line_type: 'employee', wage_amount: '600.10', paycheck_tips_amount: '250.00',
  insurance_reimbursement_amount: '300', ee_fed_income_amount: '40.20', ee_social_security_amount: '52.77', ee_medicare_amount: '12.34',
  ee_ca_state_income_amount: '11.11', ee_ca_state_disability_amount: '9.19', ee_health_amount: '0', ee_401k_amount: '0', net_pay_amount: '1024.49' }

eq(stubMismatches([andres]).length, 1, 'flags the real one-cent stub that Xero rejected')
eq(stubMismatches([andres])[0].difference, 0.01, 'reports the cent, not float noise')
eq(describeStubMismatches(stubMismatches([andres])), 'Andres Higuera (off by $0.01)', 'names the employee and the amount')
eq(stubMismatches([andresFixed]), [], 'the same stub, corrected, passes')
eq(stubMismatches([tipped]), [], 'tips and insurance reimbursement are on the pay side of the identity')
eq(stubMismatches([{ ...tipped, paycheck_tips_amount: '0' }]).length, 1, 'dropping the tips breaks the identity (tips really are counted)')
eq(stubMismatches([{ ...andres, net_pay_amount: null }]), [], 'pre-parser rows (no net pay) are skipped, not judged')
eq(stubMismatches([{ ...andres, line_type: 'reimbursement_only' }]), [], 'reimbursement-only rows carry no stub')
eq(stubMismatches([andresFixed, tipped, andres]).map(m => m.employee), ['Andres Higuera'], 'picks out the one bad stub among good ones')

// Discrimination: the old rule (|derived - net| > 0.01) let this exact row through.
const oldRule = (l: any) => { const n = (v: any) => Number(v ?? 0); const d = n(l.wage_amount) + n(l.paycheck_tips_amount) + n(l.insurance_reimbursement_amount)
  - n(l.ee_fed_income_amount) - n(l.ee_social_security_amount) - n(l.ee_medicare_amount) - n(l.ee_ca_state_income_amount)
  - n(l.ee_ca_state_disability_amount) - n(l.ee_health_amount) - n(l.ee_401k_amount)
  return Math.abs(Math.round(d * 100) / 100 - Math.round(n(l.net_pay_amount) * 100) / 100) > 0.01 }
eq(oldRule(andres), false, 'the OLD one-cent tolerance passed this row -- which is the bug')

// Session 353 cont. -- David: "Square rounded the pay". One cent per stub is
// rounding (booked to 260); more than that is still a real mismatch.
const twoCents = { ...andres, raw_full_name: 'Two Cents', net_pay_amount: '408.47' }
const under = { ...andres, raw_full_name: 'Paid A Cent More', net_pay_amount: '408.50' }
const split = splitStubMismatches(stubMismatches([andres, twoCents, under, andresFixed]))
eq(split.rounding.map(m => m.employee), ['Andres Higuera', 'Paid A Cent More'], 'one cent either way is Square rounding')
eq(split.real.map(m => m.employee), ['Two Cents'], 'two cents on one stub is NOT rounding -- still refused')
eq(roundingTotal(split.rounding), 0, 'roundings in opposite directions net to zero')
eq(roundingTotal(splitStubMismatches(stubMismatches([andres])).rounding), 0.01, 'the Oct 16 journal needs exactly $0.01 of rounding')
eq(ACCT_ROUNDING, '260', "rounding posts to Xero's Rounding account, 260")
eq(splitStubMismatches(stubMismatches([andres, { ...andres, raw_full_name: 'B' }])).real, [], 'two stubs a cent each are two roundings, judged per stub, not per journal')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
