// ── THE ARITHMETIC GATE ON A TRANSCRIBED HISTORY ─────────────────────────────
//
// Lifted out of loan-document-intake in session 277 for one reason: it could not
// be tested. The edge function imports jsr: modules, so Node cannot load it, and
// the gate that decides whether money read off a photograph is safe to act on had
// no test of its own. Two defects were sitting in it, and both survived because
// the only way to exercise this code was to upload a file and look at the screen.
//
// It takes no client and touches no network, so `tests/extract-rows.test.mts`
// drives THIS function -- the one that ships.

export interface ExtractedRow {
  date: string
  principal: number | null
  interest: number | null
  payment: number | null
  balance: number | null
  kind?: string
  /** False when the model had to supply a year the document never printed. */
  yearPrinted?: boolean
  /** The date verbatim off the page, so a human can check the reading. */
  dateAsPrinted?: string | null
}

// The arithmetic gate. This, not the prompt, is what makes a transcribed figure
// safe to act on -- a misread digit has to survive a same-row identity AND
// agreement with its neighbour to get through.
export function validateExtractedRows(rows: ExtractedRow[], todayIso: string): {
  periods: Array<{ statementDate: string; principalBalance: number; totalAmountDue: number | null; explicitSplit: { principal: number; interest: number } | null }>
  rejected: Array<{ date: string; reason: string }>
} {
  const periods: any[] = []
  const rejected: Array<{ date: string; reason: string }> = []

  // ONE PAYMENT MAY ARRIVE AS SEVERAL ROWS. BayFirst's portal prints each payment
  // as three lines sharing a date -- 'PRINCIPAL PAYMENT SPLIT OUT',
  // 'INTEREST PAYMENT SPLIT OUT', and the payment itself -- each carrying its own
  // running balance. Read row-by-row that is three transactions, none of which has
  // both halves of a split, and the whole upload yields nothing (which is exactly
  // what happened first time).
  //
  // So rows are grouped by date and recombined here rather than by the model: the
  // model is asked only to LABEL each row for what it says it is, and the
  // arithmetic below still has to agree afterwards. The balance taken for the group
  // is the LOWEST one printed on that date -- the running balance after every part
  // of the payment has been applied, which is the only one that is the period's
  // closing balance.
  const grouped = new Map<string, ExtractedRow[]>()
  for (const r of rows) {
    if (!grouped.has(r.date)) grouped.set(r.date, [])
    grouped.get(r.date)!.push(r)
  }
  const merged: ExtractedRow[] = []
  for (const [date, rs] of grouped) {
    if (rs.length === 1) { merged.push(rs[0]); continue }
    const sum = (k: string, f: (r: ExtractedRow) => number | null) =>
      rs.filter((r) => r.kind === k).reduce((s, r) => s + (f(r) ?? 0), 0) || null
    const principal = sum('principal', (r) => r.principal ?? r.payment)
      ?? rs.map((r) => r.principal).find((v) => v !== null) ?? null
    const interest = sum('interest', (r) => r.interest ?? r.payment)
      ?? rs.map((r) => r.interest).find((v) => v !== null) ?? null
    const paymentRow = rs.find((r) => r.kind === 'payment')
    const payment = paymentRow?.payment ?? paymentRow?.principal
      ?? (principal !== null && interest !== null ? Math.round((principal + interest) * 100) / 100 : null)
    const balances = rs.map((r) => r.balance).filter((b): b is number => b !== null)
    merged.push({
      date, principal, interest, payment,
      balance: balances.length ? Math.min(...balances) : null,
      kind: 'payment',
    })
  }
  const sorted = merged.sort((a, b) => a.date.localeCompare(b.date))
  const horizon = new Date(new Date(todayIso).getTime() + 31 * 86400000).toISOString().slice(0, 10)

  // ── THE SIGN CONVENTION IS MEASURED FROM THE BALANCES, NOT ASSUMED ─────────
  // BayFirst's portal prints a payment's parts as NEGATIVE numbers (-695.23),
  // because on that screen they are decreases. The continuity check read them at
  // face value, so `prev.balance - (-695.23)` came out $1,390.46 above the printed
  // balance and the row was rejected as not following from its predecessor -- with
  // a message quoting arithmetic that is correct on magnitudes:
  //     135,901.60 - 695.23 = 135,206.37, exactly.
  // The one row that mattered was thrown out by the check meant to protect it, and
  // the row that survived was a different event with its payment sign flipped.
  //
  // The fix must not be Math.abs() everywhere. A negative principal legitimately
  // means a DRAW on some lenders, and flattening the sign would silently turn new
  // borrowing into a paydown -- a worse bug than the one being fixed, and exactly
  // the shape session 247 wrote up ("a rollforward has no term for borrowing
  // unless you give it one").
  //
  // So the convention is DETERMINED, per document, by which reading makes the
  // balances foot -- the same standard the module applies everywhere else: prefer
  // the interpretation the evidence can falsify. A draw document foots as printed
  // (prev - (-x) = prev + x, the balance rising); BayFirst's foots on magnitudes
  // and not as printed. If both readings foot equally, as-printed wins, because
  // that is the one the page actually says.
  const footCount = (rs: typeof sorted, useMagnitude: boolean) => {
    let hits = 0
    let prevBal: number | null = null
    for (const r of rs) {
      if (r.balance === null) continue
      if (prevBal !== null && r.principal !== null) {
        const p = useMagnitude ? Math.abs(r.principal) : r.principal
        if (Math.abs((prevBal - p) - r.balance) <= 0.01) hits++
      }
      prevBal = r.balance
    }
    return hits
  }
  const useMagnitude = footCount(sorted, true) > footCount(sorted, false)
  if (useMagnitude) {
    for (const r of sorted) {
      if (r.principal !== null) r.principal = Math.abs(r.principal)
      if (r.interest !== null) r.interest = Math.abs(r.interest)
      if (r.payment !== null) r.payment = Math.abs(r.payment)
    }
  }

  let prev: { date: string; balance: number } | null = null
  for (const r of sorted) {
    // ── A GUESSED YEAR IS NOT A DATE (session 277) ──────────────────────────
    // The tool schema demanded ISO dates from a screen that prints "Sep 2" and
    // nothing else, so the model had no way to comply except to invent a year --
    // and it invented 2024. The import would have filed a statement dated two
    // years back, which no arithmetic check downstream could catch, because the
    // figures were all fine. This module's rule already covered it and the schema
    // was quietly overriding it: A DATE IS MEASURED OR ASKED FOR, NEVER INFERRED.
    // THE SENTINEL OUTRANKS THE FLAG. The model was told to use 1900 when no year
    // is printed AND to set year_printed false. On a real BayFirst portal screenshot
    // it did the first and not the second for one of two rows, so that row arrived
    // as 1900-09-02 with year_printed TRUE and fell through to the generic
    // "date outside a plausible range" — a true statement about a cause it gets
    // wrong, which sends the reader looking for a bad date instead of a missing year.
    //
    // A flag is the model's CLAIM; the sentinel is what it actually wrote. Prefer the
    // harder evidence, and prefer it in the direction that refuses.
    const yearMissing = r.yearPrinted === false || r.date < '1900-12-31'
    if (yearMissing) {
      rejected.push({ date: r.dateAsPrinted ? `"${r.dateAsPrinted}"` : r.date,
        reason: 'the document prints no year for this row, and a year is never guessed -- add this one by hand with its date' })
      continue
    }
    if (r.date < '1990-01-01' || r.date > horizon) { rejected.push({ date: r.date, reason: 'date outside a plausible range' }); continue }
    if (r.balance === null) {
      // Not an error: a lump-sum row often shows no balance. It is simply not a
      // period this path can file, and loan-record-principal-payment owns it.
      rejected.push({ date: r.date, reason: 'no principal balance printed on this row -- an extra-principal payment is recorded separately' })
      continue
    }
    if (r.balance < 0) { rejected.push({ date: r.date, reason: 'negative balance' }); continue }

    const hasSplit = r.principal !== null && r.interest !== null && r.principal > 0 && r.interest > 0
    if (hasSplit && r.payment !== null && Math.abs((r.principal! + r.interest!) - r.payment) > 0.01) {
      rejected.push({ date: r.date, reason: `principal $${r.principal!.toFixed(2)} + interest $${r.interest!.toFixed(2)} does not equal the payment $${r.payment.toFixed(2)} printed on the same row` })
      continue
    }
    if (prev && r.principal !== null && Math.abs((prev.balance - r.principal) - r.balance) > 0.01) {
      rejected.push({ date: r.date, reason: `balance ${r.balance.toFixed(2)} does not follow from the previous balance ${prev.balance.toFixed(2)} less principal ${r.principal.toFixed(2)}` })
      continue
    }
    periods.push({
      statementDate: r.date,
      principalBalance: r.balance,
      totalAmountDue: r.payment ?? (hasSplit ? Math.round((r.principal! + r.interest!) * 100) / 100 : null),
      explicitSplit: hasSplit ? { principal: r.principal!, interest: r.interest! } : null,
    })
    prev = { date: r.date, balance: r.balance }
  }
  return { periods, rejected }
}
