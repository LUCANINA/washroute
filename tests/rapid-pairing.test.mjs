// Verifies the fee/payment pairing against the REAL Rapid Finance statement
// David photographed (period ending 2026-08-16) and against Rapid's own portal
// balances already on file. Pure arithmetic — no DB, no network.
//
// The statement's own control totals:
//     opening   57,377.83
//   + fees       1,969.61
//   - received   8,275.56
//   = closing   51,071.88

const round2 = (n) => Math.round(n * 100) / 100;
const PAIR_WINDOW_DAYS = 2;

// The block under test, lifted verbatim in shape from loan-ingest-statement.
function pair(fees, payments) {
  const claimed = new Set(), pairedFees = new Set(), pairs = [];   // keyed by identity
  const sorted = fees.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const f of sorted) {
    const t = new Date(f.date + 'T00:00:00Z').getTime();
    const inWin = payments
      .filter(p => !claimed.has(p))
      .map(p => ({ p, dist: Math.abs(new Date(p.date + 'T00:00:00Z').getTime() - t) }))
      .filter(x => x.dist <= PAIR_WINDOW_DAYS * 86400000)
      .sort((a, b) => a.dist - b.dist);
    if (!inWin.length) continue;
    if (inWin.length > 1 && inWin[0].dist === inWin[1].dist) continue;
    claimed.add(inWin[0].p); pairedFees.add(f);
    pairs.push({ fee: f, payment: inWin[0].p });
  }
  const rows = pairs.map(pr => ({
    period_label: pr.payment.date,
    principal_amount: round2(pr.payment.amount - pr.fee.amount),
    interest_amount: round2(pr.fee.amount),
    total_amount: round2(pr.payment.amount),
  }));
  for (const p of payments) if (!claimed.has(p))
    rows.push({ period_label: p.date, principal_amount: round2(p.amount), interest_amount: 0, total_amount: round2(p.amount) });
  for (const f of fees) if (!pairedFees.has(f))
    rows.push({ period_label: f.date, principal_amount: round2(-f.amount), interest_amount: round2(f.amount), total_amount: 0 });
  return rows;
}

let pass = 0, fail = 0;
const eq = (a, b, msg) => { const ok = Math.abs(a - b) < 0.005;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}${ok ? '' : `  (got ${a}, want ${b})`}`); ok ? pass++ : fail++; };
const is = (a, b, msg) => { const ok = a === b;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}${ok ? '' : `  (got ${a}, want ${b})`}`); ok ? pass++ : fail++; };

// ── The statement, as printed ────────────────────────────────────────────────
const OPENING = 57377.83, CLOSING = 51071.88;
const fees = [
  { date: '2026-08-03', amount: 513.28 },
  { date: '2026-08-10', amount: 499.42 },
  { date: '2026-08-17', amount: 485.49 },
  { date: '2026-08-24', amount: 471.42 },
];
const payments = [
  { date: '2026-08-04', amount: 2068.89 },
  { date: '2026-08-11', amount: 2068.89 },
  { date: '2026-08-18', amount: 2068.89 },
  { date: '2026-08-25', amount: 2068.89 },
];

console.log('\nRapid Finance — statement control totals');
eq(fees.reduce((n, f) => n + f.amount, 0), 1969.61, 'fees on the statement sum to the stated 1,969.61');
eq(payments.reduce((n, p) => n + p.amount, 0), 8275.56, 'payments sum to the stated 8,275.56');
eq(round2(OPENING + 1969.61 - 8275.56), CLOSING, 'opening + fees - received = the stated closing 51,071.88');

console.log('\nPairing');
const rows = pair(fees, payments);
is(rows.length, 4, 'four payments produce FOUR split rows, not eight');
is(rows.every(r => r.interest_amount > 0), true, 'every row carries interest — none is an all-principal payment');
eq(rows[0].principal_amount, 1555.61, "David's worked example: 2,068.89 - 513.28 = 1,555.61 principal");
eq(rows[0].interest_amount, 513.28, 'the fee becomes the interest');
is(rows[0].period_label, '2026-08-04', 'the row is dated the PAYMENT, not the fee');

console.log('\nThe double-entry invariant, on every row');
for (const r of rows)
  eq(round2(r.principal_amount + r.interest_amount), r.total_amount,
     `${r.period_label}: principal + interest = total (${r.total_amount})`);

console.log('\nAgainst the statement as a whole');
eq(rows.reduce((n, r) => n + r.interest_amount, 0), 1969.61, 'interest booked equals the fees charged');
eq(rows.reduce((n, r) => n + r.principal_amount, 0), round2(OPENING - CLOSING),
   'principal booked equals the balance actually retired (6,305.95)');

console.log("\nAgainst Rapid's own portal balances already on file");
// 2026-07-07 61,962.76 -> 2026-07-13 62,516.85 (+554.09 fee) -> 2026-07-14 60,447.96
const wk = pair([{ date: '2026-07-13', amount: 554.09 }], [{ date: '2026-07-14', amount: 2068.89 }]);
eq(wk[0].principal_amount, round2(61962.76 - 60447.96), 'one real week: principal matches the portal move (1,514.80)');
eq(wk[0].interest_amount, 554.09, 'and the interest matches the capitalised fee');

console.log('\nThe pairing must not invent pairs');
const far = pair([{ date: '2026-08-03', amount: 513.28 }], [{ date: '2026-08-20', amount: 2068.89 }]);
is(far.length, 2, 'a fee with no payment within 2 days stays its own row (no false pairing)');
const tie = pair([{ date: '2026-08-04', amount: 500 }],
                 [{ date: '2026-08-03', amount: 2068.89 }, { date: '2026-08-05', amount: 2068.89 }]);
is(tie.length, 3, 'an exact tie leaves everything unpaired rather than guessing');
const draw = pair([{ date: '2026-08-03', amount: 513.28 }, { date: '2026-08-03', amount: 4000 }],
                  [{ date: '2026-08-04', amount: 2068.89 }]);
is(draw.filter(r => r.total_amount === 0).length, 1, 'a second same-day fee (a draw fee) is not swallowed into the payment');

console.log(`\n${pass + fail} assertions · ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
