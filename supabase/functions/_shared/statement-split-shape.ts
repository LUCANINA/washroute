// _shared/statement-split-shape.ts — TWO RULES ABOUT DERIVED SPLITS (session 273)
//
// Both were found on Rapid Credit Line's real August 2026, and both were invisible
// because nobody was asking the question rather than because anyone got an answer
// wrong.
//
// Extracted rather than left inline for the reason paypal-history.ts was: a rule
// buried in a 1,400-line edge function that talks to Supabase and Xero on every
// path cannot be tested, and this module's own history says an untested rule about
// money is a rule waiting to be wrong. These are pure functions over plain data.

export type TxnRow = { date: string, amount: number }
export type Pair = { fee: TxnRow, payment: TxnRow }

export const r2 = (n: number) => Math.round(n * 100) / 100

// ── RULE 1: A PAIR MAY NEVER STRADDLE A MONTH BOUNDARY ──────────────────────
//
// Some lenders bill their interest as a fee that capitalises into the balance a
// day or two before the payment that clears it. Rapid is one: the balance goes UP
// by the fee, then DOWN by the payment, and the week's real principal reduction is
// the difference. Pairing them into one row is right — David, session 241: "to
// calculate the principal, deduct the interest/fee portion from the PAYMENT."
//
// But a combined row is dated on the PAYMENT. So pairing a fee dated 2026-08-31
// with the payment dated 2026-09-01 moves that fee into September, and August's
// books never see it. That is $457.14 that no month ever booked, and it is the
// same defect as session 272's transposition: two dates a day apart treated as one
// event, putting money in the wrong period.
//
// Within a month the exact day does not change any month-end figure and pairing is
// the better shape. Across a month end it changes one every time. So the rule is
// not "never pair" and not "always pair" — it is pair inside a month, split across
// one, which is the only version that is right in both directions.
//
// AMBIGUITY REFUSES. Two candidate payments equidistant from a fee is not a fact
// about which one it belongs to; both stay unpaired and visible. Same discipline
// as session 245's ledger dating and session 272's transposition check.
export function pairFeesToPayments(
  fees: TxnRow[],
  payments: TxnRow[],
  windowDays: number,
): { pairs: Pair[], unpairedFees: TxnRow[], unpairedPayments: TxnRow[] } {
  const claimed = new Set<TxnRow>(), paired = new Set<TxnRow>()
  const pairs: Pair[] = []
  const day = (d: string) => new Date(String(d) + 'T00:00:00Z').getTime()
  const sameMonth = (a: string, b: string) => String(a).slice(0, 7) === String(b).slice(0, 7)
  const sorted = fees.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
  for (const f of sorted) {
    const inWindow = payments
      .filter(p => !claimed.has(p))
      .filter(p => sameMonth(p.date, f.date))
      .map(p => ({ p, dist: Math.abs(day(p.date) - day(f.date)) }))
      .filter(x => x.dist <= windowDays * 86400000)
      .sort((a, b) => a.dist - b.dist)
    if (!inWindow.length) continue
    if (inWindow.length > 1 && inWindow[0].dist === inWindow[1].dist) continue
    claimed.add(inWindow[0].p); paired.add(f)
    pairs.push({ fee: f, payment: inWindow[0].p })
  }
  return {
    pairs,
    unpairedFees: fees.filter(f => !paired.has(f)),
    unpairedPayments: payments.filter(p => !claimed.has(p)),
  }
}

// ── RULE 2: A DERIVED SPLIT SET MUST FOOT TO ITS OWN STATEMENTS ─────────────
//
// `statement_delta` means "the difference between two lender balances". If the
// rows we derive do not sum to that difference, they are not a statement delta,
// whatever the column says.
//
// Rapid's 2026-09-02 upload derived three splits from two statements $4,792.62
// apart and claimed $5,721.18 of principal — inventing $928.56, exactly the two
// Balance Fees it never turned into rows. It sat unnoticed for a month because the
// arithmetic was never performed. This is "measured, never derived" (session 247)
// applied to ingest: the movement is MEASURED from the lender's own two figures,
// and the rows have to match it rather than being trusted to.
//
// Splits already on file inside the window count toward the total — otherwise a
// second upload covering the same weeks always looks short by whatever the first
// one already booked.
export function footingCheck(o: {
  openingBalance: number, closingBalance: number,
  from: string, to: string,
  principalOnFile: number, principalFromThisUpload: number,
  tol?: number,
}) {
  const tol = o.tol ?? 0.02
  const lenderMovement = r2(o.openingBalance - o.closingBalance)
  const accounted = r2(o.principalOnFile + o.principalFromThisUpload)
  const gap = r2(lenderMovement - accounted)
  return {
    from: o.from, to: o.to,
    opening_balance: r2(o.openingBalance), closing_balance: r2(o.closingBalance),
    lender_movement: lenderMovement,
    splits_on_file: r2(o.principalOnFile),
    splits_from_this_upload: r2(o.principalFromThisUpload),
    accounted, gap,
    foots: Math.abs(gap) < tol,
  }
}

// ── AND THE SAME ARITHMETIC PROVES THE BALANCE BASIS ────────────────────────
//
// A statement whose `balance_basis` is 'unknown' is excluded from every lender
// comparison in this module by design — and the column DEFAULTS to 'unknown', so a
// caller that simply does not mention it produces a document that lands, looks
// filed, and is invisible. David uploaded the same Rapid statement three times;
// every one was stored, none was used, and the close band quietly fell back to a
// figure from twenty days earlier.
//
// The schedule importer already solved this and said so: "the balance-continuity
// check that verified this parse IS the definition of a principal-only balance."
// The identical argument holds here. If the lender's own balance moved by exactly
// the payments less the fees we parsed, that balance is a current outstanding
// figure — it cannot be a total-payback number, because a payback figure does not
// move by the fee. The parse has PROVEN the basis rather than assumed it.
//
// Never overwrites a basis someone recorded deliberately, and never fires on a
// parse that did not foot.
export function basisProvenBy(footing: { foots: boolean }, currentBasis: string | null | undefined): 'principal_only' | null {
  if (!footing?.foots) return null
  if (currentBasis != null && currentBasis !== 'unknown') return null
  return 'principal_only'
}
