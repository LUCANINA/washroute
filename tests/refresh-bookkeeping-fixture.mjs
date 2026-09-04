#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════════════════
 * Refresh tests/fixtures/bookkeeping-fixture.json — on this machine, over
 * PostgREST, read-only.
 *
 * WHY THIS EXISTS (session 265)
 * -----------------------------
 * `tests/refresh-bookkeeping-fixture.sql` is the specification and stays the
 * source of truth for every SHAPE below — read it first, and keep the two in
 * step. What it is not is runnable by an agent: it is seventeen SELECTs whose
 * results have to be pasted into a 3 MB JSON file by hand, which means the
 * fixture only gets refreshed when someone has an afternoon. It had not been
 * refreshed in six days when Tech Debt #39 needed it, and in those six days
 * production had gained a whole CLASS of row the fixture had never seen —
 * PayPal 2's five zero-cash `manual_adjustment` corrections, the exact rows
 * Tech Debt #38 was built to handle. A test suite that cannot see the rows the
 * code was written for is not testing the code.
 *
 * Every request here is a GET. There is no write path in this file.
 *
 * Usage:  node tests/refresh-bookkeeping-fixture.mjs            # writes the fixture
 *         node tests/refresh-bookkeeping-fixture.mjs --dry-run  # counts only
 *
 * The anon key is read out of admin-dashboard/index.html rather than stored
 * here: it is already public in that file (it is a browser app), and taking it
 * from the one place it lives means this script cannot drift onto a stale key.
 *
 * SEVEN TABLES ANON CANNOT READ, AND WHY THAT IS GOOD NEWS
 * -------------------------------------------------------
 * `loan_documents`, `loan_book_balances`, `bookkeeping_kpi_snapshots`,
 * `reconciliation_runs`, `reconciliation_findings`, `loan_tie_outs` and
 * `loan_attributions` all return 401 to the browser key. That is CORRECT and
 * must not be "fixed" by granting anon access — it is the opposite of Tech
 * Debt #14, which is about 63 tables that grant anon far too much. Never widen
 * a grant to make this script simpler.
 *
 * So those seven are supplied out of band, as a JSON side-car at
 * `tests/fixtures/.denied-tables.json` (gitignored — it is a scratch file, not
 * a fixture), pulled with a privileged connection. Regenerate it by running
 * the `SIDE_CAR_SQL` query at the bottom of this file against the project with
 * an admin connection and saving the single returned value.
 *
 * If the side-car is missing, this script REFUSES to write rather than
 * emitting a fixture whose loan_splits are from today and whose tie-outs are
 * from last week. An internally inconsistent fixture is worse than a stale
 * one: a tie-out dated before the splits it is compared against reads as a
 * real finding, and the suite goes red for a reason that is not a bug.
 * ════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { populationVerdict, SHRINK_LIMIT } from './fixture-population.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY  = process.argv.includes('--dry-run');
const PROJECT = 'umjpbuxrdydwejqtensq';
const BASE = `https://${PROJECT}.supabase.co/rest/v1`;

const html = fs.readFileSync(path.join(ROOT, 'admin-dashboard/index.html'), 'utf8');
const KEY = [...html.matchAll(/eyJhbGciOi[A-Za-z0-9_.-]+/g)]
  .map(m => m[0])
  .find(k => {
    try {
      const p = JSON.parse(Buffer.from(k.split('.')[1], 'base64').toString());
      return p.ref === PROJECT && p.role === 'anon';
    } catch { return false; }
  });
if (!KEY) throw new Error(`No anon key for ${PROJECT} found in admin-dashboard/index.html`);

/* PostgREST caps a response at 1,000 rows and says nothing about it — a silent
 * truncation would produce a fixture that looks complete and is not, which is
 * the single worst failure mode this file has. So every table is paged
 * explicitly and the page size is asserted against what came back. */
const PAGE = 1000;
async function fetchAll(table, query) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const url = `${BASE}/${table}?${query}`;
    const res = await fetch(url, {
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items',
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) throw new Error(`${table} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

/* ── the shapes, one per key, mirroring refresh-bookkeeping-fixture.sql ───── */
const SELECT_SPLITS =
  '*,loan_accounts(lender_account_number,xero_account_name,lender)';
const SELECT_AMORT_ROWS =
  'id,schedule_id,row_date,row_type,balance,principal,interest,payment,rate,loan_amt,' +
  'loan_amortization_schedules(id,storage_path,contract_id,schedule_generated_date,' +
  'created_at,loan_account_id,balance_basis,amort_type)';
const SELECT_PAYROLL_LINES =
  'id,import_id,raw_full_name,department_key,matched_employee_id,wage_amount,' +
  'er_tax_amount,er_health_amount,er_401k_amount,paycheck_tips_amount,line_type';

const fixture = {};

fixture.loan_accounts   = await fetchAll('loan_accounts',   'select=*&order=lender_account_number');
fixture.loan_statements = await fetchAll('loan_statements', 'select=*&order=statement_date.desc,id');

/* `pre_split_line_items_snapshot` is dropped exactly as the SQL drops it: it is
 * large, it is never read by the page, and it dominates the diff. */
fixture.loan_splits = (await fetchAll('loan_splits',
  `select=${SELECT_SPLITS}&order=period_label.desc,id`))
  .map(({ pre_split_line_items_snapshot, ...rest }) => rest);

/* Deliberately unordered — see the SQL's comment. The Dexter 2026-08-31 tie
 * between a rate_change row and the real payment row is a coin flip production
 * leaves open, and imposing an order here would resolve it silently and hide
 * the hazard from the test. */
fixture.loan_amortization_rows = await fetchAll('loan_amortization_rows', `select=${SELECT_AMORT_ROWS}`);


fixture.payroll_imports               = await fetchAll('payroll_imports',   'select=*&order=pay_period_end.desc,id');
fixture.payroll_import_employee_lines = await fetchAll('payroll_import_employee_lines', `select=${SELECT_PAYROLL_LINES}&order=id`);
fixture.payroll_departments           = await fetchAll('payroll_departments', 'select=*&order=sort_order');
fixture.payroll_employees             = await fetchAll('payroll_employees',   'select=*&order=full_name');
fixture.payroll_notices               = await fetchAll('payroll_notices',     'select=*&active=is.true');
fixture.bk_issue_dismissals           = await fetchAll('bk_issue_dismissals', 'select=*&order=item_key');
/* ── the seven tables anon cannot read — from the side-car ───────────────── */
const SIDE_CAR = path.join(ROOT, 'tests/fixtures/.denied-tables.json');
if (!fs.existsSync(SIDE_CAR)) {
  console.error(`Missing ${SIDE_CAR}.`);
  console.error('Run SIDE_CAR_SQL (bottom of this file) with an admin connection and save the value there.');
  console.error('Refusing to write a fixture whose tables come from two different moments.');
  process.exit(1);
}
const sideCar = JSON.parse(fs.readFileSync(SIDE_CAR, 'utf8'));
const DENIED = ['loan_documents', 'loan_book_balances', 'bookkeeping_kpi_snapshots',
                'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
                'loan_attributions'];
for (const t of DENIED) {
  if (!Array.isArray(sideCar[t])) throw new Error(`side-car is missing "${t}" — regenerate it`);
  fixture[t] = sideCar[t];
}

/* `_meta.pulled_at` IS THE HARNESS CLOCK (session 262). The suite freezes the
 * page's "now" to it, so refreshing the fixture moves the clock in the same
 * commit and there is no second place to update. A fixture with no pulled_at is
 * a hard failure in the harness rather than a silent fall back to today. */
const meta = {
  pulled_at: new Date().toISOString().replace(/\.\d+Z$/, '.000Z'),
  project: PROJECT,
  note: 'REAL production rows, read-only SELECT. Refresh with tests/refresh-bookkeeping-fixture.mjs (shapes specified in refresh-bookkeeping-fixture.sql).',
};

/* Key order matches the old fixture so a refresh diff is readable. */
const ORDER = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows',
  'loan_documents', 'loan_book_balances', 'payroll_imports', 'payroll_import_employee_lines',
  'payroll_departments', 'payroll_employees', 'payroll_notices', 'bk_issue_dismissals',
  'bookkeeping_kpi_snapshots', 'reconciliation_runs', 'reconciliation_findings',
  'loan_tie_outs', 'loan_attributions'];
const missing = ORDER.filter(k => !Array.isArray(fixture[k]));
if (missing.length) throw new Error('no array pulled for: ' + missing.join(', '));

const out = { _meta: meta };
for (const k of ORDER) out[k] = fixture[k];

const dest = path.join(ROOT, 'tests/fixtures/bookkeeping-fixture.json');

/* ── THE POPULATION GUARD (session 268) ──────────────────────────────────────
 * This script once wrote `loan_accounts=0` AND REPORTED SUCCESS, destroying the
 * live fixture; it was recovered with `git show HEAD:...` because `git checkout
 * --` fails on the device mount. The check above was meant to stop that and
 * could not: it read `!fixture[k]`, and `[]` IS TRUTHY. It tested whether a key
 * was PRESENT, never whether anything came back in it — the same array-truthiness
 * shape as session 267's staging comparator, in a different file, four days apart.
 *
 * Presence and population are different questions and this script needs the
 * second one. The comparison is against THE FIXTURE ALREADY ON DISK, because
 * that is the only independent statement of how many rows these tables ought to
 * have — deriving an expected count from the pull itself is the mistake this
 * module has a rule about (MEASURED, NEVER DERIVED).
 *
 * Two refusals, and the first is absolute:
 *   - a table that came back EMPTY when the outgoing fixture had rows is a
 *     failed pull, full stop. No flag overrides it.
 *   - a table that lost more than SHRINK_LIMIT of its rows is a failed pull
 *     until a person says otherwise, because real deletions on this book are
 *     rare and partial pulls (the PostgREST 1,000-row cap, an RLS change, a
 *     dropped side-car table) all look exactly like this.
 *
 * `res.ok` was 200 on every empty response — RLS returning no rows is not an
 * error — so status can never answer this. Only row counts can. */
const ALLOW_SHRINK = process.argv.includes('--allow-shrink');

const previous = fs.existsSync(dest) ? JSON.parse(fs.readFileSync(dest, 'utf8')) : null;

console.log('pulled_at', meta.pulled_at);
if (previous) {
  console.log('table                              was     now    change');
  for (const k of ORDER) {
    const was = Array.isArray(previous[k]) ? previous[k].length : 0;
    const now = out[k].length;
    const d = was ? ((now - was) / was * 100) : 0;
    const mark = (now === 0 && was > 0) ? '  EMPTY'
      : (was && (was - now) / was > SHRINK_LIMIT) ? '  SHRANK'
      : '';
    console.log(`${k.padEnd(34)}${String(was).padStart(5)}${String(now).padStart(8)}` +
      `${(was ? (d >= 0 ? '+' : '') + d.toFixed(1) + '%' : 'new').padStart(10)}${mark}`);
  }
} else {
  console.log(ORDER.map(k => `${k}=${out[k].length}`).join(' '));
  console.log('\nNo fixture on disk to compare against — writing the first one unchecked.');
}

const verdict = populationVerdict(previous, out, ORDER);

if (verdict.emptied.length) {
  console.error(`\nREFUSING TO WRITE. These tables came back EMPTY and were not empty before:`);
  for (const k of verdict.emptied) console.error(`  ${k}: ${previous[k].length} rows -> 0`);
  console.error(`\nA pull that returns nothing is a broken connection, not a change in the books.`);
  console.error(`Check the side-car (tests/fixtures/.denied-tables.json) and the anon key's RLS.`);
  console.error(`The fixture on disk is UNCHANGED. There is no flag that overrides this.`);
  process.exit(1);
}
if (verdict.shrank.length && !ALLOW_SHRINK) {
  console.error(`\nREFUSING TO WRITE. These tables lost more than ${SHRINK_LIMIT * 100}% of their rows:`);
  for (const k of verdict.shrank) console.error(`  ${k}: ${previous[k].length} -> ${out[k].length}`);
  console.error(`\nA partial pull looks exactly like this. If the rows really did go away,`);
  console.error(`re-run with --allow-shrink and say so in the commit message.`);
  console.error(`The fixture on disk is UNCHANGED.`);
  process.exit(1);
}
if (verdict.shrank.length) console.log(`\n--allow-shrink: writing anyway despite ${verdict.shrank.join(', ')}.`);

if (DRY) { console.log('\n--dry-run: nothing written'); process.exit(0); }

fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log('wrote', dest, (fs.statSync(dest).size / 1e6).toFixed(2) + ' MB');

/* ── SIDE_CAR_SQL — run with an admin connection, save the single value to
 *    tests/fixtures/.denied-tables.json ─────────────────────────────────────
select jsonb_build_object(
  'loan_documents',            (select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb) from (select * from loan_documents) x),
  'loan_book_balances',        (select coalesce(jsonb_agg(to_jsonb(x) order by x.as_of desc, x.loan_account_id),'[]'::jsonb) from (select * from loan_book_balances) x),
  'bookkeeping_kpi_snapshots', (select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select captured_at,payload from bookkeeping_kpi_snapshots where error is null order by captured_at desc limit 1) x),
  'reconciliation_runs',       (select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (select * from reconciliation_runs order by started_at desc limit 10) x),
  'reconciliation_findings',   (select coalesce(jsonb_agg(to_jsonb(x) order by x.last_seen_at desc, x.id),'[]'::jsonb) from (select * from reconciliation_findings where status in ('open','resolved')) x),
  'loan_tie_outs',             (select coalesce(jsonb_agg(to_jsonb(x) order by x.loan_account_id),'[]'::jsonb) from (select loan_account_id,status,difference,xero_balance,lender_balance,as_of,anchor_source,run_id,detail from loan_tie_outs where run_id=(select id from reconciliation_runs where finished_at is not null and status<>'failed' order by started_at desc limit 1)) x),
  'loan_attributions',         (select coalesce(jsonb_agg(to_jsonb(x) order by x.loan_account_id),'[]'::jsonb) from (select * from loan_attributions) x)
)::text;
 * ───────────────────────────────────────────────────────────────────────── */
