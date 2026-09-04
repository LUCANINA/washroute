// tests/fixture-population.test.mjs — the guard that would have stopped the
// 2026-09-03 fixture wipe, and proof that each half of it discriminates.
//
// Run:  node tests/fixture-population.test.mjs

import { populationVerdict, SHRINK_LIMIT } from './fixture-population.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ORDER = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_tie_outs'];
const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }));
const fx = o => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, rows(n)]));

const GOOD = fx({ loan_accounts: 14, loan_statements: 420, loan_splits: 300, loan_tie_outs: 60 });

console.log('\n  the case that actually happened');
// The whole pull came back empty because the anon key read nothing and RLS
// returning no rows is not an error, so every response was 200.
const wipe = populationVerdict(GOOD, fx({ loan_accounts: 0, loan_statements: 0, loan_splits: 0, loan_tie_outs: 0 }), ORDER);
ok('a pull that returns nothing at all is refused', wipe.ok === false);
ok('...and every emptied table is named, not just the first', wipe.emptied.length === 4);

// The narrower shape from the START HERE note: loan_accounts=0, rest fine.
const oneEmpty = populationVerdict(GOOD, fx({ loan_accounts: 0, loan_statements: 420, loan_splits: 300, loan_tie_outs: 60 }), ORDER);
ok('ONE table emptied is refused — "loan_accounts=0 and reports success"', oneEmpty.ok === false);
ok('...and names that table alone', JSON.stringify(oneEmpty.emptied) === '["loan_accounts"]');

console.log('\n  the defect this replaces, stated');
// `ORDER.filter(k => !fixture[k])` — the old check. [] is truthy, so it saw
// nothing wrong with the wipe above. Asserted here so the regression is on the
// page rather than in a comment.
const oldCheck = f => ORDER.filter(k => !f[k]).length === 0;
ok('the OLD check passed the total wipe — this is the bug', oldCheck(fx({ loan_accounts: 0, loan_statements: 0, loan_splits: 0, loan_tie_outs: 0 })) === true);
ok('...and the new one refuses it', wipe.ok === false);
ok('the two rules DISAGREE on exactly this input', oldCheck(fx({ loan_accounts: 0, loan_statements: 0, loan_splits: 0, loan_tie_outs: 0 })) !== wipe.ok);

console.log('\n  a normal refresh still writes — a guard that refuses everything is an outage');
ok('identical counts pass', populationVerdict(GOOD, GOOD, ORDER).ok === true);
ok('growth passes', populationVerdict(GOOD, fx({ loan_accounts: 14, loan_statements: 431, loan_splits: 312, loan_tie_outs: 63 }), ORDER).ok === true);
ok('a small, ordinary shrink passes', populationVerdict(GOOD, fx({ loan_accounts: 14, loan_statements: 400, loan_splits: 295, loan_tie_outs: 58 }), ORDER).ok === true);
ok('...and reports nothing to explain', populationVerdict(GOOD, fx({ loan_accounts: 14, loan_statements: 400, loan_splits: 295, loan_tie_outs: 58 }), ORDER).shrank.length === 0);

console.log('\n  the shrink limit is a real boundary, tested from both sides');
// A partial pull — PostgREST's 1,000-row cap, a dropped side-car table — is a
// shrink, not an empty, so the empty check alone would miss it.
const justUnder = Math.ceil(420 * (1 - SHRINK_LIMIT));      // exactly at the limit: allowed
const justOver = justUnder - 1;                              // one row past it: refused
ok(`${justUnder} of 420 is exactly at the ${SHRINK_LIMIT * 100}% limit and passes`,
  populationVerdict(GOOD, { ...GOOD, loan_statements: rows(justUnder) }, ORDER).ok === true);
ok(`${justOver} of 420 is past it and is refused`,
  populationVerdict(GOOD, { ...GOOD, loan_statements: rows(justOver) }, ORDER).ok === false);
ok('the refusal names the shrunken table',
  JSON.stringify(populationVerdict(GOOD, { ...GOOD, loan_statements: rows(justOver) }, ORDER).shrank) === '["loan_statements"]');
ok('half a table lost is refused',
  populationVerdict(GOOD, { ...GOOD, loan_splits: rows(150) }, ORDER).ok === false);

console.log('\n  emptied and shrank are different verdicts, because one is overridable');
const both = populationVerdict(GOOD, { ...GOOD, loan_accounts: rows(0), loan_splits: rows(100) }, ORDER);
ok('an emptied table is reported as emptied, never as a shrink',
  both.emptied.includes('loan_accounts') && !both.shrank.includes('loan_accounts'));
ok('...and a shrunken one only as a shrink',
  both.shrank.includes('loan_splits') && !both.emptied.includes('loan_splits'));

console.log('\n  the edges');
ok('a table that was empty and stayed empty is not a failure — it has no rows to lose',
  populationVerdict({ ...GOOD, loan_tie_outs: [] }, { ...GOOD, loan_tie_outs: [] }, ORDER).ok === true);
ok('a table that was empty and now has rows is fine',
  populationVerdict({ ...GOOD, loan_tie_outs: [] }, GOOD, ORDER).ok === true);
ok('a missing key counts as zero rows, not as absent',
  populationVerdict(GOOD, { ...GOOD, loan_accounts: undefined }, ORDER).emptied.includes('loan_accounts'));
ok('no previous fixture — a first run writes unchecked rather than being impossible',
  populationVerdict(null, fx({ loan_accounts: 0, loan_statements: 0, loan_splits: 0, loan_tie_outs: 0 }), ORDER).ok === true);
ok('...and says so by reporting nothing wrong rather than by hiding the row counts',
  populationVerdict(null, GOOD, ORDER).rows.length === ORDER.length);
ok('every table is in the report, whatever the verdict',
  wipe.rows.length === ORDER.length && wipe.rows.every(r => typeof r.was === 'number' && typeof r.now === 'number'));

console.log(`\n  ${pass} passing, ${fail} failing\n`);
if (fail) process.exit(1);
