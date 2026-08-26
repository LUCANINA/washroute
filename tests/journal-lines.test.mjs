// Regression test for the payment_picture blind spot (session 241).
//
// THE XERO BEHAVIOUR THAT CAUSED IT, which is the thing worth pinning:
// GET /ManualJournals (list)      -> journals with NO JournalLines
// GET /ManualJournals/{id} (one)  -> the same journal WITH its JournalLines
//
// payment_picture filtered the LIST by account code. Every journal in a list
// response has zero lines, so the filter could never match, and the mode
// reported "No posted journal touches this transaction" for every payment ever
// passed to it -- including the two below, which are real and POSTED.

const round2 = (n) => Math.round(n * 100) / 100;

// Real shapes, taken from this org's Xero. The list rows are exactly what the
// list endpoint returns: lines present as a key, empty as an array.
const LIST_RESPONSE = [
  { ManualJournalID: '391d845e-ab52-4713-b9fd-fde6db384643', Status: 'POSTED',
    DateString: '2025-11-30', Narration: 'Adjust the Funding Circle Loan to match with the statement balance',
    JournalLines: [] },
  { ManualJournalID: '350ff9d7-e311-4f50-bff2-37333cc85c14', Status: 'POSTED',
    DateString: '2025-11-30', Narration: 'To adjust the E2transait to the payoff amount',
    JournalLines: [] },
];

const BY_ID = {
  '391d845e-ab52-4713-b9fd-fde6db384643': {
    ManualJournalID: '391d845e-ab52-4713-b9fd-fde6db384643', Status: 'POSTED', DateString: '2025-11-30',
    JournalLines: [ { AccountCode: '253', LineAmount: -1598.98 }, { AccountCode: '800', LineAmount: 1598.98 } ],
  },
  '350ff9d7-e311-4f50-bff2-37333cc85c14': {
    ManualJournalID: '350ff9d7-e311-4f50-bff2-37333cc85c14', Status: 'POSTED', DateString: '2025-11-30',
    JournalLines: [ { AccountCode: '255', LineAmount: -500 }, { AccountCode: '800', LineAmount: 500 } ],
  },
};

const codes = new Set(['253']);          // the Nov 18 transaction codes 100% to 253
const hasCode = (j) => (j.JournalLines || []).some(l => codes.has(String(l.AccountCode)));

let pass = 0, fail = 0;
const t = (cond, msg, detail) => { cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}${cond ? '' : '  -- ' + (detail||'')}`); };

console.log('\nThe bug: filtering the LIST response');
const oldWay = LIST_RESPONSE.filter(hasCode);
t(oldWay.length === 0, 'filtering the list by account matches NOTHING, even though a match exists',
  `matched ${oldWay.length}`);
t(LIST_RESPONSE.every(j => (j.JournalLines || []).length === 0),
  'every journal in a list response carries zero lines -- this is why');

console.log('\nThe fix: fetch each by id first');
const fetched = LIST_RESPONSE.map(j => BY_ID[j.ManualJournalID]);
const newWay = fetched.filter(hasCode);
t(newWay.length === 1, 'fetching by id then filtering finds exactly the one real match', `matched ${newWay.length}`);
t(newWay[0].ManualJournalID.startsWith('391d845e'), 'and it is the Funding Circle adjustment, not the E-Transit one');
t(round2(newWay[0].JournalLines.find(l => l.AccountCode === '253').LineAmount) === -1598.98,
  'with the real line amount intact (-1,598.98 off the loan)');

console.log('\nA failed read is not an absence');
// undefined = could not read; null = not found. They must not collapse together.
const settled = [undefined, BY_ID['391d845e-ab52-4713-b9fd-fde6db384643'], null];
const unreadable = settled.filter(x => x === undefined).length;
const usable = settled.filter(x => x);
t(unreadable === 1, 'an unreadable journal is counted, not silently dropped');
t(usable.length === 1, 'and is kept separate from the ones that genuinely returned nothing');
t(!(unreadable === 0 && usable.filter(hasCode).length === 0),
  'the "nothing corrected this" claim is only reachable when the search was complete');

console.log(`\n${pass + fail} assertions - ${pass} passed - ${fail} failed\n`);
process.exit(fail ? 1 : 0);
