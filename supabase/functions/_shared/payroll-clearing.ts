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
