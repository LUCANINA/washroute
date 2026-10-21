// _shared/payroll-clearing.ts — which clearing account a payroll period draws on,
// and whether a draw overdraws it. ONE definition, imported by BOTH
// payroll-xero-post (which posts) and payroll-check-attention (which flags).
//
// ── WHY THIS FILE EXISTS (session 267, Sep 3 2026) ──────────────────────────
// These two functions have to agree, and until today the only thing making them
// agree was a COMMENT in payroll-check-attention saying "MUST mirror
// payroll-xero-post -- if that changes, change this too." A comment is not a
// mechanism. Both carried the same wrong model, and both had to be found and
// fixed by hand. A shared module makes the agreement structural: change it here
// and neither surface can drift.
//
// ── THE MODEL, AND WHY IT CHANGED ───────────────────────────────────────────
// v17 through v20 split the period's cash draw across two clearing accounts:
// employee California tax out of 171 Direct Payroll Taxes, everything else out
// of 170 Direct Wages. The premise was that the EDD remittance of employee CA
// tax lands in 171.
//
// It does not, and it never reliably did. Measured against Xero on 2026-09-03,
// every August EDD payment is coded to 170 -- Aug 7 $1,120.51, Aug 11 $1.63 and
// $1.87, Aug 14 $628.08, Aug 21 $639.18, Aug 28 $655.16 -- each matching its
// period's employee CA tax to the cent. July's landed in 171 only because they
// were deliberately coded there when 171 was wired in. 171 had been dormant
// since September 2021.
//
// So the cash and the claim on it sat in different accounts. 170 accumulated
// money nothing drew against; 171 was drawn against for money that never
// arrived, walking further negative every period, until the balance gate
// refused the 2026-08-21 payroll as "short $1,594.98" -- a payroll whose EDD
// remittances had every one been paid, on time, to the cent.
//
// A check that fires when nothing is wrong is not a check; it is something
// people learn to click past. The draw now comes wholly from 170, where the
// cash actually is.
//
// 171 is kept as a named zero rather than deleted so the overdraw gate still
// has both branches. If a future version reintroduces a 171 draw it gets
// checked, instead of silently skipping an account nobody is watching.

export const ACCT_DIRECT_WAGES = '170'
export const ACCT_DIRECT_PAYROLL_TAXES = '171'
export const BALANCE_TOLERANCE = 0.01

export const money = (n: number) => Math.round(n * 100) / 100

/** The employee/employer figures a single pay period contributes to the draw. */
export interface PeriodCash {
  netPay: number
  eeFederal: number   // income + social security + medicare
  eeCalifornia: number // CA income + SDI
  erTax: number       // all employer payroll tax
}

export interface CashDraw {
  from170: number
  from171: number
}

/**
 * How much this period draws from each clearing account.
 *
 * Employee withholding is ALREADY inside gross pay, so it is never an extra
 * department debit — it only decides which account the CREDIT comes from.
 * Debiting it again is the v14/v15 bug that put $4,465.21 of duplicate expense
 * into the ledger and had to be reversed by payroll-fix-ca-doublecount.
 */
export function cashDraw(p: PeriodCash): CashDraw {
  return {
    from170: money(p.netPay + p.eeFederal + p.eeCalifornia + p.erTax),
    from171: 0,
  }
}

/**
 * Does this draw overdraw the account?
 *
 * `available` is the account's real balance in Xero. The `draw > 0` guard is
 * load-bearing and is not defensive padding: with a zero draw against 171's
 * balance of -$955.80, `draw - available` is +955.80, so a naive comparison
 * reports a shortfall on an account the posting never touches — and blocks
 * every payroll forever. That is the exact false alarm this change removes,
 * reintroduced by arithmetic.
 *
 * A failed balance read (`ok: false`) blocks only a draw that is actually
 * being made: refusing to post blind is right, refusing to post because an
 * untouched account could not be read is not.
 */
export function overdraws(draw: number, balance: { ok: boolean; available?: number }): boolean {
  if (draw <= 0) return false
  if (!balance.ok) return true
  return money(draw - (balance.available ?? 0)) > BALANCE_TOLERANCE
}

/** Shortfall for display. Null when there is no draw or no readable balance. */
export function shortfall(draw: number, balance: { ok: boolean; available?: number }): number | null {
  if (draw <= 0 || !balance.ok) return null
  return money(draw - (balance.available ?? 0))
}

/**
 * Pay stubs that do not add up, TO THE CENT.
 *
 * A stub adds up when wage + tips + insurance reimbursement, minus every
 * withholding we read, equals Square's own Net Pay. The journal's debits are
 * built from the first side and its credits from the second, so a stub that is
 * off by a cent makes the whole journal off by a cent -- and Xero rejects any
 * manual journal that does not balance EXACTLY.
 *
 * No tolerance, deliberately. Oct 16, 2026: Andres Higuera's stub was $0.01
 * out, every check here allowed "up to $0.01", and the first thing to refuse it
 * was Xero, as a bare "Xero journal post failed" with no reason on screen.
 *
 * Used by payroll-ingest (refuses the upload), payroll-check-attention (flags
 * an already-imported period) and payroll-xero-post (refuses to post, naming
 * the employee). One test, three call sites -- do not reimplement it.
 *
 * Rows parsed before the full pay-stub parser (net_pay_amount null) cannot be
 * judged and are skipped; reimbursement-only rows carry no stub.
 */
export interface StubMismatch {
  employee: string
  derived_net_pay: number
  square_net_pay: number
  difference: number
}

export function stubMismatches(lines: any[]): StubMismatch[] {
  const n = (v: unknown) => Number(v ?? 0) || 0
  const out: StubMismatch[] = []
  for (const l of lines || []) {
    if (l.line_type === 'reimbursement_only') continue
    if (l.net_pay_amount === null || l.net_pay_amount === undefined) continue
    const derived = n(l.wage_amount) + n(l.paycheck_tips_amount) + n(l.insurance_reimbursement_amount)
      - n(l.ee_fed_income_amount) - n(l.ee_social_security_amount) - n(l.ee_medicare_amount)
      - n(l.ee_ca_state_income_amount) - n(l.ee_ca_state_disability_amount)
      - n(l.ee_health_amount) - n(l.ee_401k_amount)
    const diffCents = Math.round(derived * 100) - Math.round(n(l.net_pay_amount) * 100)
    if (diffCents !== 0) {
      out.push({
        employee: String(l.raw_full_name || 'Unnamed employee'),
        derived_net_pay: money(derived),
        square_net_pay: money(n(l.net_pay_amount)),
        difference: diffCents / 100,
      })
    }
  }
  return out
}

/** "Andres Higuera (off by $0.01)" -- one phrase for every surface that names them. */
export function describeStubMismatches(m: StubMismatch[]): string {
  return m.map(x => `${x.employee} (off by $${Math.abs(x.difference).toFixed(2)})`).join(', ')
}
