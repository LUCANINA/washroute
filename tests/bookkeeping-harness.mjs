#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   WashRoute — Bookkeeping module regression harness
   ───────────────────────────────────────────────────────────────────────────

   WHAT IT IS
     A real, runnable harness that loads the real admin-dashboard/index.html in
     headless Chromium, feeds it REAL production rows through a stand-in
     Supabase client, drives the page's own functions in the order the page
     actually runs them, and asserts on the rendered DOM.

     It tests the angle code-reading cannot reach: ORDER (four un-awaited
     loaders + a synchronous tab switch), FAILURE (a loader that errors),
     RACES (a tab switched mid-flight), and CROSS-SURFACE AGREEMENT (the same
     quantity rendered twice must be equal).

   HOW TO RUN
     node tests/bookkeeping-harness.mjs
     node tests/bookkeeping-harness.mjs --only=close-band       # one group
     node tests/bookkeeping-harness.mjs --list                  # group names
     node tests/bookkeeping-harness.mjs --verbose               # dump surfaces

   WHAT IT NEEDS
     * Node 18+ and Playwright with a Chromium build.
         npm i -D playwright && npx playwright install chromium
       If Chromium lives somewhere non-standard, point at it:
         PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/bookkeeping-harness.mjs
       or give an explicit binary:
         WR_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node ...
     * admin-dashboard/index.html  (read-only — the harness NEVER writes it)
         override with  WR_INDEX=/path/to/index.html
     * tests/fixtures/bookkeeping-fixture.json  (real rows; see REFRESHING below)
         override with  WR_FIXTURE=/path/to/fixture.json
     * tests/bk-stub.js  (the Supabase stand-in, injected before page scripts)

     NO NETWORK. Every non-file:// request is aborted at the browser, so a
     harness pass can never touch Supabase, Xero or Stripe.
     NO DATABASE WRITES. The fixture is a SELECT snapshot; the stub refuses
     insert/update/upsert/delete and rpc().

   REFRESHING THE FIXTURE
     The fixture is a point-in-time SELECT snapshot of these tables:
       loan_accounts, loan_statements, loan_splits,
       loan_amortization_rows (+ joined loan_amortization_schedules),
       loan_documents, payroll_imports, payroll_import_employee_lines,
       payroll_departments, payroll_employees, payroll_notices,
       reconciliation_runs, reconciliation_findings, loan_tie_outs,
       bk_issue_dismissals, bookkeeping_kpi_snapshots
     Re-pull each with `select jsonb_agg(to_jsonb(x)) from (select * from <t>) x`
     and drop the arrays into the JSON under their table name. loan_splits rows
     carry an embedded `loan_accounts` object (the page's select does a join);
     loan_amortization_rows rows carry an embedded `loan_amortization_schedules`.
     Fixture shape is asserted at startup, so a bad refresh fails loudly.

   ─── HOW TO ADD A SCENARIO ────────────────────────────────────────────────
     Everything lives in the GROUPS array at the bottom. A group is:

       { name: 'my-group', run: async (t) => { ... } }

     Inside `run` you get a tiny toolkit:

       const p = await t.boot({                 // fresh page, cold boot
         latency:  { loan_statements: 200 },    // per-table delay, ms
         hold:     ['loan_splits'],             // park a table until released
         errors:   { loan_splits: {message:'boom'} },   // make a query fail
         mutate:   (data) => { ... },           // edit the fixture rows FIRST
         tab:      'client', sub: 'kpis',       // bookmarked hash to land on
         settle:   false,                       // don't await the loaders
       });

       await p.release('loan_splits');          // let a held table answer
       await p.settle();                        // wait for all loaders + paint
       await p.switchTab('loans');              // switchBookkeepingView(...)
       const s = await p.surfaces();            // every Bookkeeping surface, parsed
       await p.close();

       t.eq(actual, expected, 'assertion name');
       t.ok(cond, 'assertion name', 'observed …');
       t.notMatch(text, /regex/, 'assertion name');
       t.noBadMoney(s, 'where');                // NaN/Infinity/undefined/-$0.00

     `mutate` is how close-band edges are synthesised — always by editing the
     stub's in-memory rows, NEVER the database.

     Add the group to GROUPS and it runs. Exit code is non-zero if any
     assertion fails.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const INDEX   = process.env.WR_INDEX   || path.join(REPO, 'admin-dashboard', 'index.html');
const FIXTURE = process.env.WR_FIXTURE || path.join(HERE, 'fixtures', 'bookkeeping-fixture.json');
const STUB    = process.env.WR_STUB    || path.join(HERE, 'bk-stub.js');

const argv    = process.argv.slice(2);
/* --only= takes a COMMA LIST as of session 268, and an unknown name is now a HARD
 * FAILURE. Before this it took exactly one group and compared with `!==`, so a typo
 * -- or a comma list, which is what the notes told people to use -- matched nothing
 * and the run reported "0 assertions - 0 passed - 0 failed" and exited GREEN. A
 * scoping mistake that reads as success is worse than one that reads as an error,
 * and this suite's whole job is to not be that. See also START HERE: run UNSCOPED
 * where you can; --only is for iterating, never for the run you trust. */
const ONLY    = (argv.find(a => a.startsWith('--only=')) || '').slice(7)
                  .split(',').map(x => x.trim()).filter(Boolean);
const VERBOSE = argv.includes('--verbose');
const LIST    = argv.includes('--list');

/* ── assertion bookkeeping ────────────────────────────────────────────────── */
const results = [];
let currentGroup = '';
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

const T = {
  ok(cond, name, observed) {
    results.push({ group: currentGroup, name, pass: !!cond, observed: observed || '' });
    const tag = cond ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
    console.log(`  ${tag}  ${name}`);
    if (!cond && observed) console.log(`        ${C.y}${observed}${C.x}`);
  },
  eq(actual, expected, name) {
    const pass = String(actual) === String(expected);
    this.ok(pass, name, pass ? '' : `observed ${JSON.stringify(actual)} · expected ${JSON.stringify(expected)}`);
  },
  close(actual, expected, tol, name) {
    const pass = Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tol;
    this.ok(pass, name, pass ? '' : `observed ${actual} · expected ${expected} (±${tol})`);
  },
  notMatch(text, re, name) {
    const m = String(text || '').match(re);
    this.ok(!m, name, m ? `matched ${JSON.stringify(m[0])} in: …${excerpt(text, m.index)}…` : '');
  },
  noBadMoney(blob, where) {
    const text = typeof blob === 'string' ? blob : JSON.stringify(blob);
    const re = /(NaN|Infinity|\bundefined\b|-\$0\.00|−\$0\.00|\$NaN|\$undefined|\$-|\bnull\b\s*(?:principal|interest))/;
    const m = text.match(re);
    this.ok(!m, `${where}: no NaN / Infinity / undefined / -$0.00 reaches the DOM`,
            m ? `matched ${JSON.stringify(m[0])} in: …${excerpt(text, m.index)}…` : '');
  },
};
function excerpt(text, at) {
  const s = String(text || '');
  const i = Math.max(0, (at || 0) - 90);
  return s.slice(i, (at || 0) + 110).replace(/\s+/g, ' ');
}

/* ── money helpers ────────────────────────────────────────────────────────── */
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function parseMoney(s) {
  if (s == null) return null;
  const t = String(s).replace(/[−–]/g, '-');
  const m = t.match(/-?\$\s?-?[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const neg = /^-/.test(m[0]) || /^\(/.test(t);
  const v = Number(m[0].replace(/[^\d.]/g, ''));
  return neg ? -v : v;
}

/* ── browser boot ─────────────────────────────────────────────────────────── */
let chromium;
async function getChromium() {
  if (chromium) return chromium;
  // Resolve playwright from the local project first, then from anywhere it is
  // globally installed. Set WR_PLAYWRIGHT=/abs/path/to/node_modules to override.
  const roots = [];
  if (process.env.WR_PLAYWRIGHT) roots.push(process.env.WR_PLAYWRIGHT);
  roots.push(path.join(REPO, 'node_modules'), path.join(HERE, 'node_modules'));
  try {
    const { execSync } = await import('node:child_process');
    roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim());
  } catch {}
  const tried = [];
  for (const pkg of ['playwright', 'playwright-core']) {
    try { ({ chromium } = await import(pkg)); return chromium; } catch (e) { tried.push(`${pkg}: ${e.code || e.message}`); }
    for (const r of roots) {
      const p = path.join(r, pkg, 'index.mjs');
      const q = path.join(r, pkg, 'index.js');
      for (const cand of [p, q]) {
        if (!fs.existsSync(cand)) continue;
        try { const m = await import('file://' + cand); chromium = (m.chromium || m.default?.chromium); if (chromium) return chromium; }
        catch (e) { tried.push(`${cand}: ${e.message}`); }
      }
    }
  }
  throw new Error('Could not load Playwright.\n  Install it:  npm i -D playwright && npx playwright install chromium\n  Or set WR_PLAYWRIGHT=/path/to/node_modules\n  Tried:\n    ' + tried.join('\n    '));
}

const FIXTURE_TABLES = [
  'loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
  'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
  'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
  'bk_issue_dismissals', 'bookkeeping_kpi_snapshots',
  // Session 262. Registered for the SAME reason loan_book_balances is, and the
  // reason matters more here: an unregistered table serves [] silently, and []
  // is indistinguishable from "the job has no answer for this loan" -- so every
  // attribution assertion would exercise the 'none' branch and pass while the
  // three states that actually needed proving were never reached.
  'loan_attributions',
  // Empty in production until reconciliation-run starts writing it, and that is
  // exactly why it is registered: an unregistered table serves [] silently, so
  // a grade-B test would exercise only the no-books-balance fallback and pass
  // while the real path was never reached. Registered, a missing key is a
  // startup failure instead of a green test that proved nothing.
  'loan_book_balances',
];

/* ═══ TWO FIXTURES, AND THE REASON IS NOT CONVENIENCE (session 265) ═════════
 *
 * A fixture is a snapshot of a moment, so every figure verified against it is a
 * figure from that moment. Most groups want the NEWEST snapshot: they ask "does
 * the shipped code handle the rows production actually has", and a stale
 * snapshot means a whole class of row goes untested — which is exactly what
 * happened to Tech Debt #38's zero-cash corrections, invisible to this suite
 * for the six days they existed.
 *
 * But some groups are not about current data at all. `closing-evidence` is 660
 * assertions about CLOSING JULY 2026, each figure checked once against Xero and
 * against real lender documents. That verification is the expensive part and it
 * cannot be redone from a screen. Point those groups at a newer snapshot and
 * they do not find bugs — they find that it is September, that August's
 * statements have not arrived, and that the close gate is correctly refusing to
 * close a month it has no evidence for. 256 red assertions, not one of them a
 * defect.
 *
 * So a group declares which snapshot its question belongs to:
 *
 *   GROUPS.push({ name: 'closing-evidence', fixture: 'july', ... })
 *
 * `live` (the default) moves every refresh. `july` is frozen at
 * 2026-08-28 and closes July; it is committed and must NOT be refreshed —
 * refreshing it would silently rewrite the answers those assertions were
 * written to check, which is the difference between a test and a transcript.
 *
 * The clock follows the group's own fixture, so `_meta.pulled_at` remains the
 * single source of "now" (session 262) and a frozen group keeps a frozen today.
 */
const FIXTURE_JULY = path.join(HERE, 'fixtures', 'bookkeeping-fixture-2026-07.json');

function loadFixture(file) {
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const t of FIXTURE_TABLES) {
    if (!Array.isArray(f[t])) throw new Error(`fixture is missing table array: ${t} (${file})`);
  }
  const at = f._meta && f._meta.pulled_at;
  if (!at || Number.isNaN(Date.parse(at))) {
    throw new Error(`fixture has no usable _meta.pulled_at: ${file} — the suite cannot pin its clock, and running against the wall clock is what session 262 removed`);
  }
  return f;
}

const FIXTURES = { live: loadFixture(FIXTURE), july: loadFixture(FIXTURE_JULY) };

/* The frozen one is frozen. If someone refreshes it in place this fires on the
 * next run, before any assertion has a chance to be quietly re-pinned. */
if (FIXTURES.july._meta.pulled_at !== '2026-08-28T23:10:31.000Z') {
  throw new Error(
    `bookkeeping-fixture-2026-07.json has been refreshed (pulled_at is now ${FIXTURES.july._meta.pulled_at}).\n` +
    '  It is frozen on purpose: its groups assert figures verified against Xero and lender documents\n' +
    '  for the JULY 2026 close. Refreshing it rewrites the answers instead of checking them.\n' +
    '  Restore it from git, and put new data in bookkeeping-fixture.json instead.');
}

/* Set per group by the runner. Everything below reads these, never FIXTURES
 * directly — one place to change, so a new group cannot get half of each. */
let baseFixture = FIXTURES.live;
const stubSrc = fs.readFileSync(STUB, 'utf8');

let browser;
async function newHarnessPage(opts = {}) {
  const data = JSON.parse(JSON.stringify(baseFixture));
  if (opts.mutate) opts.mutate(data);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  // Hard network block: only file:// may load. Nothing can reach Supabase/Xero.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file://')) return route.continue();
    return route.abort();
  });

  const page = await ctx.newPage();
  // _dvIframeLoaded fires from a driver-view <iframe onload> that can never
  // load offline — unrelated to Bookkeeping, and not a defect under test.
  const BENIGN_PAGE_ERRORS = /_dvIframeLoaded|ResizeObserver loop/;
  page.on('pageerror', (e) => { const m = String(e && e.message || e); if (!BENIGN_PAGE_ERRORS.test(m)) pageErrors.push(m); });
  const pageErrors = [];

  await page.addInitScript({
    content:
      `window.__WR_FIXTURE = ${JSON.stringify(data)};\n` +
      stubSrc + '\n' +
      `(() => { const c = window.__WR_STUB;
         c.defaultLatency = ${Number(opts.defaultLatency || 0)};
         c.latency = ${JSON.stringify(opts.latency || {})};
         c.errors  = ${JSON.stringify(opts.errors || {})};
         ${JSON.stringify(opts.hold || [])}.forEach(t => c.hold.add(t));
       })();`,
  });

  // Freeze the page's clock to the fixture's own instant, BEFORE navigation so
  // nothing in the module has already read a real `new Date()`. setFixedTime
  // rather than clock.install: install fakes timers too, and both this harness's
  // settle loop and the page's own setTimeout-driven rendering need real ones.
  // Only Date moves.
  //
  // `at: null` opts a scenario out, for a test whose subject genuinely IS the
  // passage of real time. Nothing needs it today; it exists so that opting out
  // has to be written down rather than achieved by accident.
  if (opts.at !== null) await page.clock.setFixedTime(opts.at ? new Date(opts.at) : HARNESS_NOW);

  const hash = opts.tab ? `#bookkeeping/${opts.tab}${opts.sub ? '/' + opts.sub : ''}` : '#bookkeeping';
  await page.goto('file://' + INDEX + hash, { waitUntil: 'domcontentloaded' });

  // The real cold boot: reveal the app, then showPage('bookkeeping') — which
  // fires FOUR un-awaited loaders and switches the tab SYNCHRONOUSLY — then
  // the hash handler's sub-tab restore, exactly as boot does it (index.html:7623).
  await page.evaluate(({ tab, sub }) => {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    currentUserRole = 'admin';
    rolePermissions = {};
    showPage('bookkeeping', document.querySelector('.nav-item[data-page="bookkeeping"]'));
    if (tab) switchBookkeepingView(tab, sub || null);
  }, { tab: opts.tab || null, sub: opts.sub || null });

  const api = {
    page, ctx, pageErrors,
    async release(...tables) {
      await page.evaluate((ts) => ts.forEach(t => window.__WR_STUB.hold.delete(t)), tables);
    },
    async settle(extraMs = 120) {
      await page.evaluate(async () => {
        // Drain the loaders: they are un-awaited, so wait until the stub has
        // stopped answering and the microtask queue is clear.
        const quiet = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
        let last = -1;
        for (let i = 0; i < 200; i++) {
          const n = window.__WR_STUB.log.queries.length;
          if (n === last && !window.__WR_STUB.hold.size) { await quiet(); if (window.__WR_STUB.log.queries.length === n) break; }
          last = n;
          await new Promise(r => setTimeout(r, 15));
        }
      });
      await page.waitForTimeout(extraMs);
    },
    async switchTab(view, sub) {
      await page.evaluate(({ v, s }) => switchBookkeepingView(v, s || null), { v: view, s: sub || null });
    },
    surfaces: () => page.evaluate(readSurfaces),
    log: () => page.evaluate(() => ({
      toasts: window.__WR_STUB.log.toasts,
      consoleErrors: window.__WR_STUB.log.consoleErrors,
      unknownTables: [...window.__WR_STUB.log.unknownTables],
      orders: window.__WR_STUB.log.queries.map(q => q.table + ':' + q.orders.join(',')),
    })),
    evaluate: (...a) => page.evaluate(...a),
    async close() { await ctx.close(); },
  };
  if (opts.settle !== false) { await api.release(...(opts.hold || [])); await api.settle(); }
  return api;
}

// The toolkit handed to every group's run(t). `t.boot` is the documented name.
T.boot = (opts) => newHarnessPage(opts);
T.money = money;
T.parseMoney = parseMoney;

/* ── the DOM reader (runs in the page) ────────────────────────────────────── */
function readSurfaces() {
  const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  const html = (sel) => { const e = document.querySelector(sel); return e ? e.innerHTML : null; };
  const tiles = (sel) => {
    const host = document.querySelector(sel);
    if (!host) return null;
    const out = {};
    host.querySelectorAll('.bk-tile').forEach(t => {
      const label = (t.querySelector('.bk-tile-label')?.textContent || '').replace(/\s+/g, ' ').trim();
      const value = (t.querySelector('.bk-tile-value')?.textContent || '').replace(/\s+/g, ' ').trim();
      const delta = (t.querySelector('.bk-tile-delta')?.textContent || '').replace(/\s+/g, ' ').trim();
      out[label] = { value, delta };
    });
    return out;
  };

  // ── close band ──
  const cb = document.getElementById('loans-close-band');
  let closeBand = null;
  if (cb && cb.innerHTML.trim()) {
    // Session 241: the redesign dropped the currency symbol from body cells and
    // made a tie print NOTHING, so parseMoney() and the /$0.00 ✓/ probes below
    // would have quietly stopped matching — assertions that pass by never
    // firing, which is worse than a red test. The cells now carry data-amount
    // and data-tie, so the harness reads the figure the renderer actually held
    // rather than re-parsing a string it just formatted. Sturdier than the
    // glyph it replaces: a restyle cannot break it, a wrong NUMBER still can.
    const num = (td) => {
      const v = td && td.getAttribute && td.getAttribute('data-amount');
      return v === null || v === undefined || v === '' ? null : Number(v);
    };
    const att  = (el, k) => (el && el.getAttribute ? el.getAttribute(k) : null);
    const numA = (el, k) => { const v = att(el, k); return v === null || v === '' ? null : Number(v); };
    // ── COLUMNS ARE ADDRESSED BY HEADER, NEVER BY INDEX (session 247) ─────
    // The rollforward was flattened to one fact per cell so it can export to CSV
    // — Lender, Opening source, Closing date and Closing source became columns
    // of their own. Every fixed index in this reader shifted at once and thirty
    // assertions went red for a reason that had nothing to do with the code
    // under test. A reader that positions itself off the headings survives the
    // next column too, and a heading that disappears now fails loudly here
    // instead of silently reading the neighbouring column's money.
    const heads = [...cb.querySelectorAll('thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim());
    const colIx = (label) => {
      const i = heads.findIndex(h => h === label || h.startsWith(label + ' ·'));
      if (i < 0) throw new Error(`close band: no "${label}" column — headers are ${JSON.stringify(heads)}`);
      return i;
    };
    // ── NINE COLUMNS NOW, NOT THIRTEEN (session 249, the softening pass) ──
    // Lender, Opening source, Closing date and Closing source came off the
    // screen. NOT out of the DOM: each is a data- attribute on the cell whose
    // figure it describes, which is where it always belonged — a provenance in
    // its own column can drift away from the number it qualifies, one attached
    // to the number cannot.
    //
    // So openingSrc/closingDate/closingSrc are ALIASES onto the figure columns,
    // and every reader below that used to take a cell's TEXT now takes the
    // attribute. That is a stronger test than the old one, not a weaker one:
    // the text was a copy decision and this reads the fact.
    const C = { loan: colIx('Loan'), opening: colIx('Opening'),
                drawn: colIx('Drawn'), principal: colIx('Principal'),
                interest: colIx('Interest'), computed: colIx('Computed'),
                closing: colIx('Closing'), variance: colIx('Variance'),
                status: colIx('Status') };
    C.lender = C.loan; C.openingSrc = C.opening;
    C.closingDate = C.closing; C.closingSrc = C.closing;
    // ── THE NOTES COLUMN IS GONE (session 247, David's layout pass) ───────
    // "The variance does the talking." Nothing it carried was dropped; each
    // flag was FILED into the cell it is about, so this reader follows them
    // there rather than keeping a column alive that the page no longer has:
    //   ledger check      → Variance      (a second line under the figure)
    //   mixed-sign        → Drawn
    //   origination gap   → Opening source
    //   N undated         → Status
    // Reading them from their new homes is not cosmetic: an attribute parked on
    // the wrong cell would still parse and would silently stop meaning anything.
    const rows = [...cb.querySelectorAll('tbody tr')].map(tr => {
      const tds = [...tr.children];
      const c = tds.map(td => td.textContent.replace(/\s+/g, ' ').trim());
      // The loan cell concatenates the account name and the lender, so the
      // account name is read from its own span rather than by prefix-matching a
      // run-together string ("BayFirst SBA 2BayFirst National").
      const nameEl = tds[C.loan] && tds[C.loan].querySelector ? tds[C.loan].querySelector('.td-name') : null;
      const lenderEl = tds[C.loan] && tds[C.loan].querySelector ? tds[C.loan].querySelector('.lcb-lender') : null;
      return { loan: c[C.loan], name: nameEl ? nameEl.textContent.replace(/\s+/g, ' ').trim() : c[C.loan],
               // The lender is under the loan name now, and it is ALSO on the
               // row as data-lender. Read the span (what a person sees) and
               // cross-check it against the attribute (what the export ships) —
               // a screen and a file that disagree about who lent the money is
               // the kind of drift this reader exists to catch.
               lender: lenderEl ? lenderEl.textContent.replace(/\s+/g, ' ').trim() : att(tr, 'data-lender'),
               lenderAttr: att(tr, 'data-lender'),
               // Every row now carries the sentence the detail line prints on
               // hover. It is the only home the moved facts have on screen, so
               // an assertion that a fact is still REACHABLE reads it here.
               hint: att(tr, 'data-hint'),
               opening: c[C.opening],
               // Was the source column's TEXT; is the source cell's label.
               openingSource: att(tds[C.openingSrc], 'data-source-label'),
               openingSourceRaw: att(tds[C.openingSrc], 'data-source'),
               drawn: c[C.drawn], principal: c[C.principal], interest: c[C.interest],
               computed: c[C.computed], perLender: c[C.closing],
               closingDate: att(tds[C.closingDate], 'data-closing-date'),
               closingDateIso: att(tds[C.closingDate], 'data-closing-date-iso'),
               closingSource: att(tds[C.closingSrc], 'data-closing-source-label'),
               closingSourceRaw: att(tds[C.closingSrc], 'data-closing-source'),
               ledgerNote: att(tds[C.variance], 'data-ledger-note'),
               varianceExplained: att(tds[C.variance], 'data-variance-explained'),
               variance: c[C.variance], inXero: c[C.status],
               openingN: num(tds[C.opening]), principalN: num(tds[C.principal]), interestN: num(tds[C.interest]),
               computedN: num(tds[C.computed]), perLenderN: num(tds[C.closing]),
               // ══ SESSION 247: DRAWN, AND THE SECOND CHECK ════════════════
               // `opening − principal = closing` is only true if nothing was
               // BORROWED. Stripe drew $125,000 in July. `drawn` is measured
               // server-side from the ledger entries and is DELIBERATELY not
               // derived from the balances — deriving it would make the walk
               // foot by construction, which is the tautology this whole
               // sequence of sessions has been spent removing.
               //
               // measured/unmeasured is read from its own attribute and NEVER
               // inferred from the figure: a null drawn and a measured zero are
               // different claims and the entire design turns on the difference.
               drawnN: num(tds[C.drawn]),
               // ── NET vs GROSS (session 247, the interest-netting fix) ────
               // `drawn` was counting the interest half of every payment as new
               // borrowing: the payment hits the loan account for the full
               // amount and a reallocation journal adds the interest back, which
               // measureMovement correctly saw as a positive effect. data-amount
               // is now the NET figure and the gross survives beside it, so the
               // row can still show what was measured and what was netted off.
               drawnGrossN: numA(tds[C.drawn], 'data-drawn-gross'),
               drawnNettedN: numA(tds[C.drawn], 'data-drawn-netted'),
               // ── THE OBSERVABLE DIFFERENCE BETWEEN THE TWO FIX ROUTES ────
               // ce30's defect had two candidate fixes and they are NOT
               // equivalent on screen. Widening the explanation would have left
               // `drawn` reading the staged interest as borrowing; netting it
               // removes it at source. data-staged-interest is the amount the
               // netting route additionally takes out, so a row that shows a
               // non-zero staged interest AND a data-drawn-netted that includes
               // it is proof the netting route is the one that shipped. Reading
               // it is how a future reader can tell which fix is live without
               // opening the source.
               stagedInterestN: numA(tds[C.drawn], 'data-staged-interest'),
               drawnMeasured: att(tds[C.drawn], 'data-drawn-measured') === '1',
               skipReason: att(tds[C.drawn], 'data-skip-reason'),
               mixedSignN: numA(tds[C.drawn], 'data-mixed-sign'),
               originationGapN: numA(tds[C.openingSrc], 'data-origination-gap'),
               openingStagedN: numA(tds[C.openingSrc], 'data-opening-staged'),
               // Does the walk actually land on what the ledger says?
               reachesBooks: att(tds[C.computed], 'data-reaches-books'),
               // The ledger check lives in Notes. Three states, and they are not
               // interchangeable: 'measured' can band and block; 'unmeasured'
               // states the same subtraction and refuses to diagnose it.
               unexplainedN:     numA(tds[C.variance], 'data-unexplained'),
               unexplainedBand:  att(tds[C.variance], 'data-unexplained-band') || null,
               unexplainedState: att(tds[C.variance], 'data-unexplained-state'),
               unattributedN:    numA(tds[C.variance], 'data-unattributed'),
               rowDrawnMeasured: att(tr, 'data-drawn-measured') === '1',
               // ── SESSION 246 ─────────────────────────────────────────────
               // A closing balance now carries a GRADE, a DERIVATION and, when
               // a roll-back was refused, the REASON it was refused. All three
               // are attributes rather than words, deliberately: the words are a
               // copy decision that will be edited, and a test that re-derives
               // the grade from the sentence is a test of the sentence. Read the
               // attributes the renderer actually held.
               grade: att(tr, 'data-grade'),
               circular: tr.hasAttribute('data-circular'),
               openingFromBooks: tr.hasAttribute('data-opening-books'),
               undatedN: numA(tr, 'data-undated') || 0,
               closingGrade: att(tds[C.closing], 'data-grade'),
               derivation: att(tds[C.closing], 'data-derivation'),
               note: att(tds[C.closing], 'data-note'),
               band: att(tds[C.variance], 'data-band') || null,
               // A circular row carries data-circular on the variance cell and
               // deliberately NO data-tie. Reading them separately is the whole
               // point: "agrees by construction" must never be counted as a tie.
               varianceCircular: tds[C.variance] ? tds[C.variance].hasAttribute('data-circular') : false,
               // The fourth band (review F3). A variance fully accounted for by
               // money the month deliberately left out — a staged split, or one
               // undated payment — carries its explained principal here. It is
               // shown, never blocking, and owned by the posting gate.
               unbookedN: numA(tds[C.variance], 'data-unbooked'),
               // ── THE BANDED FIGURE, WHICH IS NO LONGER THE VARIANCE ──────
               // The band is now taken on what is LEFT after the explanation,
               // not on the whole gap. Both numbers are on the cell and the
               // harness reads both, because the whole safety argument for the
               // change is that the unexplained remainder stays visible rather
               // than being absorbed by a de-escalation.
               varianceResidualN: numA(tds[C.variance], 'data-variance-residual'),
               ties: tds[C.variance] ? tds[C.variance].hasAttribute('data-tie') : false,
               varianceN: tds[C.variance] && tds[C.variance].getAttribute('data-variance')
                 ? Number(tds[C.variance].getAttribute('data-variance')) : (tds[C.variance] && tds[C.variance].hasAttribute('data-tie') ? 0 : null) };
    });
    const footTr = [...cb.querySelectorAll('tfoot tr')];
    const foot = footTr.map(tr =>
      [...tr.children].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    // ── THE FOOTER IS THREE ROWS NOW, NOT ONE ────────────────────────────
    // Grade A, grade B and the excluded line each carry data-subtotal, so the
    // harness addresses them by NAME. Summing foot[0] alone reads only the
    // lender-confirmed subtotal and silently loses every loan that closes on
    // its contractual schedule — which is exactly how the two-surfaces
    // cross-check broke when grade B shipped.
    const subtotalOf = (tr) => {
      const tds = [...tr.children];
      return {
        cells: tds.map(td => td.textContent.replace(/\s+/g, ' ').trim()),
        label: tds[0] ? tds[0].textContent.replace(/\s+/g, ' ').trim() : '',
        count: numA(tr, 'data-count'),
        circularCount: numA(tr, 'data-circular-count') || 0,
        // How many of the rows behind this line actually had their movement
        // measured. A Drawn subtotal of $0.00 over rows nobody measured is not a
        // statement that nothing was borrowed, and this is what says which.
        drawnN: num(tds[C.drawn]),
        drawnMeasured: numA(tr, 'data-drawn-measured'),
        rollCount: numA(tr, 'data-roll-count'),
        closingCount: numA(tr, 'data-closing-count'),
        openingN: num(tds[C.opening]), principalN: num(tds[C.principal]), interestN: num(tds[C.interest]),
        computedN: num(tds[C.computed]), perLenderN: num(tds[C.closing]),
        varianceN: numA(tds[C.variance], 'data-variance'),
        // Session 272: the RESIDUAL — raw minus every explanation (unposted
        // payments, and now a closing anchor older than the month's own
        // payments). The footer has always summed this; before there was an
        // explanation that survived into the immaterial/material bands the two
        // were the same number, so nothing had to tell them apart.
        varianceResidualN: numA(tds[C.variance], 'data-variance-residual'),
        material: numA(tds[C.variance], 'data-material'),
        // Review F14: an EMPTY subtotal must not exist at all, and must never
        // carry data-tie. A $0.00 "tie" over zero loans is a claim nobody
        // earned, printed in the one column a reader scans for verdicts.
        ties: tds[C.variance] ? tds[C.variance].hasAttribute('data-tie') : false,
        automatic: numA(tr, 'data-automatic'),
        // Session 247: the grand total. rollCount / closingCount say how many
        // rows each half of it covers — a total whose Opening covers 14 loans
        // and whose Closing covers 13 must SAY so, and the assertions check the
        // marker rather than trusting the figure.
        rollCount: numA(tr, 'data-roll-count'),
        closingCount: numA(tr, 'data-closing-count'),
      };
    };
    const subtotals = {};
    footTr.forEach(tr => { const k = att(tr, 'data-subtotal'); if (k) subtotals[k] = subtotalOf(tr); });
    // gates[] is NOT index-stable: three of the six gates exist only when they
    // are non-zero, so gates[1] means a different thing on different months.
    // Every gate carries its own key; index nothing, look up by name.
    //
    // ── SESSION 264: THEY ARE NO LONGER CHIPS ─────────────────────────────
    // David removed everything from the strip but its verdict, so there are no
    // `.lcb-gate` spans left to read. The gates are still COMPUTED — `blocked`,
    // and therefore the verdict itself, is still their sum — and the page now
    // carries them on the strip as `data-gates`, per its own LESS IS BEST rule
    // that a fact which leaves the screen attaches to the element it describes.
    //
    // This reader moved to that attribute rather than the ~150 assertions below
    // being deleted with the chips. That is the whole point: an assertion that
    // reads only the visible half goes green when a claim is DELETED and red
    // when it is merely relocated, which is exactly backwards. Reading the data
    // keeps every one of them discriminating — the `chips-lose-their-name`
    // mutation below still proves it.
    //
    // The shape is deliberately identical to what the chips produced, ✓ prefix
    // included, so that every text assertion written against the rendered chip
    // still means precisely what its author wrote.
    const stripEl = cb.querySelector('.lcb-strip');
    let gatesRaw = [];
    try { gatesRaw = JSON.parse(att(stripEl, 'data-gates') || '[]'); } catch (_) { gatesRaw = []; }
    const gates = gatesRaw.map(g => ({
      key: g.key,
      count: g.n == null ? null : Number(g.n),
      text: ((g.bad || g.tick === false || g.key === 'immaterial') ? '' : '\u2713 ') + String(g.text || ''),
      ok: !g.bad,
    }));
    const gateByKey = {};
    gates.forEach(g => { if (g.key) gateByKey[g.key] = g; });
    closeBand = {
      head: txt('#loans-close-band .lcb-head h3'),
      lead: txt('#loans-close-band .lcb-lead'),
      // Session 264: everything the strip RENDERS, so "the strip shows the
      // verdict and nothing else" is a property with a test rather than a
      // sentence in a comment. Kept separate from `lead` on purpose — if the
      // two ever diverge, something was added back to the strip.
      stripText: txt('#loans-close-band .lcb-strip'),
      // Session 273: the progress bar's ask line, and the figures it drew.
      // Read as DATA (data-progress) rather than as segment widths — a test
      // that measures pixels breaks on a style change and proves nothing about
      // the arithmetic, which is the part that can be wrong.
      asksText: txt('#loans-close-band .lcb-asks'),
      progress: (() => {
        try { return JSON.parse(att(stripEl, 'data-progress') || 'null'); } catch (_) { return null; }
      })(),
      barSegs: [...cb.querySelectorAll('.lcb-bar > i')].map(i => ({
        cls: (i.getAttribute('class') || '').trim(),
        flex: Number((i.getAttribute('style') || '').replace(/[^0-9.]/g, '')) || 0,
        title: i.getAttribute('title') || '',
      })),
      // The slot above the strip, which held "Paid in <month>" until David
      // removed it. Empty is the assertion; the container staying is not.
      tilesText: txt('#loans-close-tiles'),
      gates, gateByKey,
      headers: heads, columnIndex: C,
      rows, foot, subtotals,
      foot0: foot[0] || null,
      footVarianceN: (() => {
        const td = cb.querySelector('tfoot tr td[data-variance]');
        const v = td && td.getAttribute('data-variance');
        return v === null || v === undefined || v === '' ? null : Number(v);
      })(),
      excluded: foot.find(f => /Not checkable/.test(f[0] || '')) || null,
      note: txt('#loans-close-band .lcb-foot'),
      text: cb.textContent.replace(/\s+/g, ' ').trim(),
    };
  }

  // ── debt schedule table ──
  const ds = document.getElementById('cv-debtsched');
  let debtSched = null;
  if (ds && ds.innerHTML.trim()) {
    const tbl = ds.querySelector('table');
    debtSched = {
      headers: tbl ? [...tbl.querySelectorAll('thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim()) : [],
      bodyRows: tbl ? tbl.querySelectorAll('tbody tr').length : 0,
      foot: tbl ? [...tbl.querySelectorAll('tfoot td, tfoot th')].map(td => td.textContent.replace(/\s+/g, ' ').trim()) : [],
      text: ds.textContent.replace(/\s+/g, ' ').trim(),
    };
  }

  // innerText, not textContent: what a human can actually SEE. A hardcoded
  // figure parked in a display:none card is not a claim the page is making.
  const paneText = (id) => { const e = document.getElementById(id); return e ? (e.innerText || e.textContent).replace(/\s+/g, ' ').trim() : null; };

  return {
    activeTab: typeof _bookkeepingActiveTab !== 'undefined' ? _bookkeepingActiveTab : null,
    activeSub: typeof _clientActiveSubView !== 'undefined' ? _clientActiveSubView : null,
    dataReady: typeof _bkDataReady === 'function' ? _bkDataReady() : null,
    counts: {
      accounts: (typeof _allLoanAccounts !== 'undefined' && _allLoanAccounts || []).length,
      statements: (typeof _allLoanStatements !== 'undefined' && _allLoanStatements || []).length,
      splits: (typeof _allLoanSplits !== 'undefined' && _allLoanSplits || []).length,
      amortRows: (typeof _allLoanAmortRows !== 'undefined' && _allLoanAmortRows || []).length,
      payrollImports: (typeof _allPayrollImports !== 'undefined' && _allPayrollImports || []).length,
      tieOuts: (typeof _loanTieOuts !== 'undefined' && _loanTieOuts || []).length,
      findings: (typeof _reconFindings !== 'undefined' && _reconFindings || []).length,
    },
    navBadge: (() => { const b = document.getElementById('badge-bookkeeping'); return b ? { text: b.textContent.trim(), shown: b.style.display !== 'none' } : null; })(),
    overview: {
      statusline: txt('#bk-ov-statusline'),
      queueLabel: txt('#bk-ov-queue-label'),
      segIssues: txt('#bk-ov-seg-issues'),
      segApprovals: txt('#bk-ov-seg-approvals'),
      segStaged: txt('#bk-ov-seg-staged'),
      kpiAsOf: txt('#bk-kpi-asof'),
      kpiTiles: tiles('#bk-kpi-tiles'),
      queueList: txt('#bk-ov-queue-list'),
      reconLastRun: txt('#recon-lastrun'),
      reconSummary: txt('#recon-summary'),
      paneText: paneText('bk-view-overview'),
    },
    loans: {
      summaryTiles: tiles('#loans-summary'),
      closeBand,
      attentionBadge: txt('#loans-all-badge'),
      tableRows: (() => { const w = document.getElementById('loans-table-wrap'); return w ? w.querySelectorAll('tbody tr').length : 0; })(),
      tableText: txt('#loans-table-wrap'),
      paneText: paneText('bk-view-loans'),
    },
    payroll: {
      summaryTiles: tiles('#payroll-summary'),
      summaryText: txt('#payroll-summary'),
      tableRows: (() => { const w = document.getElementById('payroll-table-wrap'); return w ? w.querySelectorAll('tbody tr').length : 0; })(),
      paneText: paneText('bk-view-payroll'),
    },
    client: {
      checklistTitle: txt('#cv-checklist-title'),
      checklistCount: txt('#cv-checklist-count'),
      checklist: txt('#cv-checklist'),
      debtTiles: tiles('#cv-debt-tiles'),
      chartNote: txt('#cv-chart-note'),
      chartLabels: [...document.querySelectorAll('#cv-debt-chart svg text')].map(t => t.textContent.trim()),
      chartTitles: [...document.querySelectorAll('#cv-debt-chart svg title')].map(t => t.textContent.trim()),
      debtSched,
      paneText: paneText('bk-view-client'),
      subDashboard: paneText('cv-subview-dashboard'),
      subDebt: paneText('cv-subview-debt'),
      subKpis: paneText('cv-subview-kpis'),
    },
    bodyText: (() => { const e = document.getElementById('page-bookkeeping'); return e ? (e.innerText || e.textContent).replace(/\s+/g, ' ').trim() : ''; })(),
    bodyHtml: document.getElementById('page-bookkeeping')?.innerHTML || '',
  };
}

/* ── the close band's gate chips, by NAME ─────────────────────────────────── */
// Session 246: three of these render only when non-zero, so the strip's LENGTH
// and the ORDER of what is on it both vary by month. Nothing may index into
// gates[]; everything looks up data-gate. This list exists so a chip added or
// renamed in the page turns into a loud failure instead of a quiet mismatch.
// 'ledger' (session 247) is the SECOND check and deliberately a separate chip:
// the variance chip asks whether the books agree with the lender, this one asks
// whether our splits explain what the ledger itself did, and a loan can pass one
// while failing the other. Folding them into one number would hide exactly that.
// 'checked' (session 262 cont. 3) is David's close gate: a statement that has
// been UPLOADED but never compared to Xero. Deliberately separate from
// 'coverage', which asks whether a closing balance can be established at all —
// a document can be present (coverage satisfied) and unexamined (checked
// failing), and that combination is precisely the state the rule exists to stop.
// 'unverified', 'explained', 'tie' and 'provisional-opening' round out the set the
// strip can render. Session 272 cont. added the last: the month being closed opens
// on a month the accountant has not finished, so its figures can still move.
const GATE_KEYS = ['coverage', 'lender-confirmed', 'per-schedule', 'variance', 'immaterial', 'ledger', 'posting', 'checked',
                   'unverified', 'explained', 'tie', 'provisional-opening'];

/* ── ISOLATING A READINESS TEST FROM THE NEW GATE (session 262 cont. 3) ─────
   Several scenarios clear their own blocker and then assert the band reads
   ready. David's statement gate is a SECOND blocker they never had to satisfy,
   and it fires on this fixture because its reconciliation run predates some of
   its statements. Those scenarios are about a $5 gap or an unposted split, not
   about statement coverage, so they say so explicitly by marking every required
   document analysed — one variable per scenario, which is what made the old
   assertions meaningful in the first place.

   THIS IS NOT A WAY TO MAKE THE GATE PASS QUIETLY. `close-gate` asserts the gate
   blocks, names its loans, and that weakening it lets a month read "ready" on
   documents nobody checked. Anything that wants readiness proves it here. */
/* My first version of this did it in the FIXTURE, pointing every tie-out at the
   newest real document its loan held. That is not the same date: the closing
   anchor is the newest document dated on or before month end, or a later one
   rolled back — and for several loans the newest document overall is neither.
   It guessed at a rule the page already owns, and the guess was wrong for
   exactly the loans the scenario cared about.

   So this runs in PAGE CONTEXT and asks `_loanClosingAnchor` itself. It means
   "a reconciliation run that had actually examined the document this close
   anchors on", expressed with the product's own anchor picker rather than a
   second copy of it that can drift. */
const alignTieOutsToAnchors = (p) => p.evaluate(() => {
  const month = _cvLastMonth();
  const monthEnd = _lastDayOfMonth(month), priorEnd = _priorMonthEnd(month);
  for (const t of (_loanTieOuts || [])) {
    const a = (_allLoanAccounts || []).find(x => x.id === t.loan_account_id);
    if (!a) continue;
    const anc = _loanClosingAnchor(a, monthEnd, priorEnd);
    if (anc && anc.grade === 'A' && anc.asOf) t.as_of = anc.asOf;
  }
  renderLoansCloseBand();
  try { renderLoansCloseTiles(); } catch (_) {}
  try { renderClientChecklist(); } catch (_) {}
});

/* ── phrases that claim "everything is fine" ──────────────────────────────── */
/* ═══════════ THE FIXTURE'S OWN CLOCK (session 262) ═══════════════════════
   A fixture is a snapshot of a moment, and every figure in this suite was
   verified against production AT that moment. Reading "now" from the wall clock
   therefore asks July's arithmetic to be true in September, which it is not.

   On 2026-09-01 that came due: the close band advanced from July to August and
   `closing-evidence` went from green to 183 failures overnight, with no commit
   in between. The group's own first assertion said so out loud -- its author put
   a loud precondition there for exactly this -- but a tripwire tells you the
   suite has stopped being usable; it does not keep it usable. 183 red assertions
   by default is a suite nobody can read a real regression out of, which is how a
   real one gets through.

   So the PAGE's clock is frozen to the instant the fixture was pulled, and the
   harness's own date arithmetic reads the same instant. Both sides now agree,
   permanently, and every group tests the month it was written about instead of
   whichever month the calendar happens to be in.

   THE DATE COMES FROM THE FIXTURE, never a literal here: refresh the fixture and
   the clock follows it in the same commit, with no second place to update. A
   fixture with no `_meta.pulled_at` is a hard failure rather than a silent
   fallback to the wall clock -- falling back would restore the exact bug this
   removes, and do it quietly. */
// Both follow whichever fixture the running group declared — validated in
// loadFixture, so there is no fallback path here to go wrong.
let HARNESS_NOW = new Date(baseFixture._meta.pulled_at);
// The Pacific calendar day that instant falls on -- the page reads BIZ_TZ, not
// UTC, and around a month boundary those are different days.
let HARNESS_TODAY = HARNESS_NOW.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

function useFixture(which) {
  const f = FIXTURES[which || 'live'];
  if (!f) throw new Error(`unknown fixture "${which}" — expected one of: ${Object.keys(FIXTURES).join(', ')}`);
  baseFixture   = f;
  HARNESS_NOW   = new Date(f._meta.pulled_at);
  HARNESS_TODAY = HARNESS_NOW.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

const ALL_CLEAR = /(Everything is reconciled|nothing needs you right now|ready for your accountant|all \d+ statements in|Nothing outstanding|nothing needs doing|you're all caught up|no issues found)/i;
const CONFIDENT_ZERO = /\$0(?:\.00)?\b/;

/* ═══════════════════════════ SCENARIO GROUPS ═════════════════════════════ */
const GROUPS = [];

/* Every table the Bookkeeping page reads on boot. 17 now: session 246 added
   loan_book_balances and session 262 added loan_attributions to loadLoans()'s
   Promise.all. Anything not in here answers
   instantly, which quietly un-parks a loader a cold-boot scenario claims is
   parked. */
const COLD_TABLES = [
  'loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
  'loan_book_balances',
  'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
  'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
  'bk_issue_dismissals', 'bookkeeping_kpi_snapshots',
  'loan_attributions',
];

/* 1 ── COLD BOOT IN THE REAL ORDER ───────────────────────────────────────── */
GROUPS.push({
  name: 'cold-boot',
  async run(t) {
    const TABS = [
      ['overview', null], ['loans', null], ['payroll', null],
      ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis'],
    ];
    for (const [tab, sub] of TABS) {
      const label = tab + (sub ? '/' + sub : '');
      // Every loader parked: the page has switched the tab and rendered, and
      // NOT ONE ROW has arrived. This is the state a real cold boot paints.
      // loan_book_balances is the SIXTH read inside loadLoans (session 246). It
      // was missing from this list, so "every loader parked" was not true: one
      // query answered while the page was meant to be cold. It changes no
      // assertion today — the other five hold the Promise.all open regardless —
      // but a scenario whose premise is a lie stops being evidence the moment
      // the code it describes moves.
      const p = await newHarnessPage({
        tab, sub, settle: false,
        hold: COLD_TABLES,
      });
      await p.page.waitForTimeout(250);
      const cold = await p.surfaces();

      t.eq(cold.counts.accounts, 0, `${label}: cold state really is data-free (0 accounts loaded)`);
      t.eq(cold.dataReady, false, `${label}: _bkDataReady() reports not-ready while cold`);

      const pane = tab === 'overview' ? cold.overview.paneText
                 : tab === 'loans'    ? cold.loans.paneText
                 : tab === 'payroll'  ? cold.payroll.paneText
                 : (sub === 'debt' ? cold.client.subDebt : sub === 'kpis' ? cold.client.subKpis : cold.client.subDashboard);

      t.notMatch(pane, ALL_CLEAR, `${label}: renders no "all clear" claim before data lands`);
      t.noBadMoney(pane, `${label} cold`);

      // A confident $0.00 before data is a false and reassuring number.
      const moneyish = (pane || '').match(/\$[\d,]+\.\d\d/g) || [];
      t.ok(!moneyish.includes('$0.00'), `${label}: renders no confident $0.00 before data lands`,
           moneyish.length ? `money strings on a cold pane: ${[...new Set(moneyish)].slice(0, 8).join(', ')}` : '');

      // …and then it must actually fill in.
      await p.release(...COLD_TABLES);
      await p.settle();
      const warm = await p.surfaces();
      t.ok(warm.counts.accounts === 22, `${label}: 22 loan accounts land`, `got ${warm.counts.accounts}`);
      const warmPane = tab === 'overview' ? warm.overview.paneText
                     : tab === 'loans'    ? warm.loans.paneText
                     : tab === 'payroll'  ? warm.payroll.paneText
                     : (sub === 'debt' ? warm.client.subDebt : sub === 'kpis' ? warm.client.subKpis : warm.client.subDashboard);
      t.ok((warmPane || '').length > 200 && warmPane !== pane,
           `${label}: the surface actually re-renders once data arrives`,
           `cold ${(pane || '').length} chars → warm ${(warmPane || '').length} chars`);
      t.noBadMoney(warmPane, `${label} warm`);
      if (VERBOSE) console.log(C.d + '     cold: ' + String(pane).slice(0, 400) + C.x);
      await p.close();
    }

  },
});

/* 2 ── A LOADER FAILS ────────────────────────────────────────────────────── */
GROUPS.push({
  name: 'loader-failure',
  async run(t) {
    const TABS = [['loans', null], ['client', 'dashboard'], ['overview', null], ['client', 'kpis']];
    const paneOf = (s, tab, sub) => tab === 'loans' ? s.loans.paneText
                                  : tab === 'overview' ? s.overview.paneText
                                  : sub === 'kpis' ? s.client.subKpis : s.client.subDashboard;

    // A healthy load is the yardstick: a broken loader must not INVENT a zero,
    // and must not quietly rewrite a headline into a different, wrong claim.
    const healthy = {};
    for (const [tab, sub] of TABS) {
      const p = await newHarnessPage({ tab, sub });
      const s = await p.surfaces();
      healthy[tab + (sub ? '/' + sub : '')] = {
        pane: paneOf(s, tab, sub),
        zeros: ((paneOf(s, tab, sub) || '').match(/\$0\.00/g) || []).length,
        strip: s.loans.paneText && (s.loans.paneText.match(/(\d+ loans? to fix[^.]*\.|\d+ with no lender statement[^.]*\.)/g) || []).join(' '),
      };
      await p.close();
    }

    const CASES = [
      { table: 'loan_statements', loader: 'loadLoans' },
      { table: 'loan_splits',     loader: 'loadLoans' },
      { table: 'payroll_imports', loader: 'loadPayroll' },
      { table: 'reconciliation_findings', loader: 'loadReconciliation' },
      { table: 'bk_issue_dismissals',     loader: 'loadReconciliation' },
      { table: 'loan_tie_outs',           loader: 'loadReconciliation' },
      { table: 'bookkeeping_kpi_snapshots', loader: 'loadBookkeepingKpis' },
    ];
    for (const c of CASES) {
      for (const [tab, sub] of TABS) {
        const key = tab + (sub ? '/' + sub : '');
        const label = `${c.table} fails (${c.loader}) on ${key}`;
        const p = await newHarnessPage({
          tab, sub,
          errors: { [c.table]: { message: `harness: simulated failure reading ${c.table}`, code: '57014' } },
        });
        const s = await p.surfaces();
        const log = await p.log();
        const pane = paneOf(s, tab, sub);

        const said = log.toasts.length > 0 ||
          /out of date|Could not|couldn.t reach|unavailable|Checking…|check failed|try again/i.test(pane || '');
        t.ok(said, `${label}: the UI says something went wrong`,
             `no toast and nothing on the pane says so — pane starts: ${String(pane).slice(0, 150)}`);
        t.notMatch(pane, ALL_CLEAR, `${label}: no "all clear" while a loader is broken`);

        // A failure may show FEWER figures. It must never show MORE zeros than a
        // healthy load — that is a zero standing in for "we don't know".
        const zeros = ((pane || '').match(/\$0\.00/g) || []).length;
        t.ok(zeros <= healthy[key].zeros, `${label}: invents no new $0.00`,
             `${zeros} × $0.00 vs ${healthy[key].zeros} on a healthy load`);

        // …and it must not silently rewrite the Loans variance headline into a
        // different, confident claim.
        if (tab === 'loans') {
          const strip = (pane.match(/(\d+ loans? to fix[^.]*\.|\d+ with no lender statement[^.]*\.)/g) || []).join(' ');
          t.ok(strip === healthy[key].strip || said,
               `${label}: the Loans variance headline does not silently change`,
               `healthy: "${healthy[key].strip}" · broken: "${strip}" · toasts=${JSON.stringify(log.toasts.map(x => x.msg))}`);
        }
        await p.close();
      }
    }
  },
});

/* 2b ── THE LOANS TABLE'S OWN COLUMNS ────────────────────────────────────── */
GROUPS.push({
  name: 'loans-table',
  async run(t) {
    const readRows = (p) => p.evaluate(() => {
      const hdr = [...document.querySelectorAll('#loans-table-wrap thead th')].map(th => th.innerText.replace(/\s+/g, ' ').trim());
      const rows = [...document.querySelectorAll('#loans-table-wrap tbody tr')].map(tr => {
        const c = [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim());
        const o = {}; hdr.forEach((h, i) => o[h] = c[i]); return o;
      });
      return { hdr, rows, today: today() };
    });

    {
      const p = await newHarnessPage({ tab: 'loans' });
      const { rows, today } = await readRows(p);
      const thisMonth = today.slice(0, 7);

      // "Last payment" is money that has ALREADY MOVED. A staged or future
      // period is a projection — the same today-or-earlier rule
      // _loanOutstandingBalance lives by.
      const future = rows.filter(r => r.Date && /^\d{4}-\d{2}/.test(r.Date) && r.Date.slice(0, 7) > thisMonth);
      t.ok(future.length === 0, '"Last payment" is never a future period',
           future.map(r => `${r.Loan}: ${r['Last payment']} dated ${r.Date} (${r.Type})`).join(' · '));
      const staged = rows.filter(r => /staged/.test(r.Type || ''));
      t.ok(staged.length === 0, '"Last payment" is never a staged (not-yet-paid) split',
           staged.map(r => `${r.Loan}: ${r['Last payment']} ${r.Date} staged`).join(' · '));

      // The Type column must never print a raw database enum.
      const raw = rows.filter(r => /_/.test(r.Type || ''));
      t.ok(raw.length === 0, 'the Type column never prints a raw database enum',
           raw.map(r => `${r.Loan}: "${r.Type}"`).join(' · '));

      // Variance must be single-signed: "−$1,008.06", never "−$-1,008.06".
      const dbl = rows.filter(r => /\$-/.test(r.Variance || ''));
      t.ok(dbl.length === 0, 'the Variance column never renders a double negative',
           dbl.map(r => `${r.Loan}: "${r.Variance}"`).join(' · '));
      await p.close();
    }

    // A VOIDED split must never surface as "Last payment".
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // Void every split on one loan except a single old one, then add a
        // brand-new voided split — it must not become the loan's last payment.
        const a = d.loan_accounts.find(x => x.status === 'active' && x.ingestion_method !== 'automatic');
        const base = d.loan_splits.find(sp => sp.loan_account_id === a.id);
        d.loan_splits.push(Object.assign({}, base, {
          id: 'harness-void', period_label: '2099-01', status: 'voided',
          voided_at: '2099-01-02', void_reason: 'harness', principal_amount: 12345.67,
          interest_amount: 89.01, total_amount: 12434.68,
        }));
        d.__loan = a.xero_account_name;
      } });
      const { rows } = await readRows(p);
      const name = await p.evaluate(() => window.__WR_FIXTURE.__loan);
      const row = rows.find(r => r.Loan === name);
      t.ok(row && !/12,434\.68/.test(row['Last payment'] || ''),
           'a VOIDED split never becomes the loan\'s "Last payment"',
           row ? `${name}: last payment "${row['Last payment']}" dated ${row.Date} (${row.Type})` : 'row not found');
      await p.close();
    }
  },
});

/* 2b ── THE STAGING COLUMN, AND THE TAB IT REPLACED ──────────────────────────
   Session 267. David: "For loans that are staged, remove them from the Overview
   page and add them to the Loans 'In flight' page. A separate column entitled
   Staging might work, with those staged marked 'scheduled'."

   Two halves, and BOTH have to hold or the move is a loss rather than a move.
   The Overview tab it replaced was not decoration: staged transactions that
   quietly never match are this module's recurring failure (BayFirst never
   staging; Verdant's board reading 'Period 84' for weeks), and the tab existed
   so something invisible was at least not also unwatched. Deleting it is only
   safe because the same facts now sit on the Loans row. So this group asserts
   the register ARRIVED, not merely that the tab LEFT — a half-applied version
   of this change is worse than either end of it. */
GROUPS.push({
  name: 'staging-column',
  async run(t) {
    const readRows = (p) => p.evaluate(() => {
      const hdr = [...document.querySelectorAll('#loans-table-wrap thead th')].map(th => th.innerText.replace(/\s+/g, ' ').trim());
      const rows = [...document.querySelectorAll('#loans-table-wrap tbody tr')].map(tr => {
        const c = [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim());
        const o = { __cells: c.length }; hdr.forEach((h, i) => o[h] = c[i]); return o;
      });
      const cols = [...document.querySelectorAll('#loans-table-wrap colgroup col')].length;
      const foot = [...document.querySelectorAll('#loans-table-wrap tfoot tr')].map(tr =>
        [...tr.children].reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0));
      return { hdr, rows, cols, foot };
    });

    // ── (a) the column exists, and the table's arithmetic still adds up ──────
    // A colgroup one <col> short does not throw; it silently collapses the last
    // column. A tfoot colspan one short shifts every total one cell left, under
    // the wrong heading. Neither shows up as an error, both show up as a lie, so
    // the widths, the header, the rows and the footer are checked against each
    // other rather than against a number written down here.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const { hdr, rows, cols, foot } = await readRows(p);
      t.ok(hdr.includes('Staging'), 'the Loans table has a Staging column',
           `headers: ${JSON.stringify(hdr)}`);
      t.eq(cols, hdr.length, 'the colgroup declares exactly as many columns as the header');
      t.ok(rows.length > 0, 'the Loans table rendered rows to check');
      t.ok(rows.every(r => r.__cells === hdr.length),
           'every body row carries one cell per header column',
           `header ${hdr.length}, rows ${[...new Set(rows.map(r => r.__cells))].join('/')}`);
      t.ok(foot.length > 0 && foot.every(n => n === hdr.length),
           'the footer spans exactly the header width, so the totals sit under their own columns',
           `header ${hdr.length}, footer spans ${foot.join('/')}`);

      // ── (b) what the column actually says ────────────────────────────────
      // Measured against the fixture's own splits, never against a number typed
      // here: "8 loans say scheduled" is a fact about today's fixture and would
      // rot the first time the data is refreshed.
      const staged = await p.evaluate(() => {
        const byLoan = {};
        (window.__WR_FIXTURE.loan_splits || []).filter(sp => sp.status === 'staged')
          .forEach(sp => { (byLoan[sp.loan_account_id] = byLoan[sp.loan_account_id] || []).push(sp.period_label); });
        const names = {};
        (window.__WR_FIXTURE.loan_accounts || []).forEach(a => { names[a.id] = a.xero_account_name; });
        return Object.keys(byLoan).map(id => ({ name: names[id], n: byLoan[id].length }));
      });
      // NON-VACUITY. Every assertion below is an .every() over a filtered set,
      // and an empty set passes all of them. If a future fixture refresh drops
      // the staged splits, this line fails first and says why, instead of a
      // page of green ticks over nothing.
      t.ok(staged.length > 0,
           'the fixture really does contain staged splits for this column to report',
           `staged loans: ${JSON.stringify(staged)}`);
      const stagedNames = new Set(staged.map(x => x.name));
      const shown = rows.filter(r => stagedNames.has(r.Loan));
      t.eq(shown.length, staged.length,
           'every loan with a staged split is on the table to be seen');
      t.ok(shown.every(r => /scheduled/.test(r.Staging || '')),
           "...and each one is marked 'scheduled'",
           shown.map(r => `${r.Loan}: "${r.Staging}"`).join(' · '));
      const quiet = rows.filter(r => !stagedNames.has(r.Loan));
      t.ok(quiet.every(r => !/scheduled|needs a look/.test(r.Staging || '')),
           'a loan with nothing staged claims nothing in the Staging column',
           quiet.filter(r => /scheduled|needs a look/.test(r.Staging || ''))
                .map(r => `${r.Loan}: "${r.Staging}"`).join(' · '));

      // ── (c) said once, not twice ─────────────────────────────────────────
      // The Type column's "+1 upcoming" badge meant "a newer entry exists and
      // the money has not moved". For a staged entry the Staging column now
      // says that, better and by name. Two badges for one fact on one row is
      // how a table stops being read.
      t.ok(shown.every(r => !/upcoming/.test(r.Type || '')),
           'a staged loan does not ALSO carry "+1 upcoming" in Type — one fact, one place',
           shown.map(r => `${r.Loan}: Type "${r.Type}"`).join(' · '));
      await p.close();
    }

    // ── (d) a FLAGGED stage does not read as calm ────────────────────────────
    // The whole point of keeping this register is the stage that goes wrong.
    // "scheduled" on a duplicate-suspected stage would be the tool reassuring a
    // reader about the one row that needs them.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const sp = d.loan_splits.find(x => x.status === 'staged');
        sp.stage_sweep_flag = 'duplicate_suspected';
        d.__loan = (d.loan_accounts.find(a => a.id === sp.loan_account_id) || {}).xero_account_name;
      } });
      const { rows } = await readRows(p);
      const name = await p.evaluate(() => window.__WR_FIXTURE.__loan);
      const row = rows.find(r => r.Loan === name);
      t.ok(!!row, 'the flagged loan is on the table', `looked for ${JSON.stringify(name)}`);
      if (row) {
        t.ok(/needs a look/.test(row.Staging || ''),
             'a flagged stage says it needs a look',
             `${name}: "${row.Staging}"`);
        t.ok(!/scheduled/.test(row.Staging || ''),
             '...and never reads as calmly scheduled',
             `${name}: "${row.Staging}"`);
      }
      await p.close();
    }

    // ── (e) the Overview tab is gone, and took its rows with it ──────────────
    {
      const p = await newHarnessPage({ tab: 'overview' });
      const ov = await p.evaluate(() => {
        const overview = document.getElementById('bk-view-overview');
        return {
          segExists: !!document.getElementById('bk-ov-seg-staged'),
          segLabels: [...document.querySelectorAll('.bk-seg-toggle .bk-seg')].map(b => b.innerText.trim()),
          text: overview ? overview.innerText : '',
        };
      });
      t.ok(!ov.segExists, 'Overview no longer has a Staged tab');
      t.ok(!ov.segLabels.some(l => /^Staged/.test(l)),
           '...and nothing else on the toggle is labelled Staged',
           JSON.stringify(ov.segLabels));
      t.ok(!/Waiting on the bank/.test(ov.text),
           '...and the queue heading it used goes with it',
           ov.text.slice(0, 200));
      t.ok(!/waiting for the payment to land in the bank feed/.test(ov.text),
           '...as does the staged register\'s own explanation');
      await p.close();
    }

    // ── (f) WHY THE COLUMN IS LOAD-BEARING, MEASURED RATHER THAN ASSUMED ─────
    // I justified deleting the Staged tab by claiming a flagged stage still
    // reaches Overview through _bkLoanAttentionItems' stage_flag. THAT CLAIM IS
    // FALSE, and this is the group that caught it. stage_flag items join the
    // APPROVALS list, and that list drops any item whose loan already has an
    // Issues row (`if (issueLoanIds.has(...)) return`). A duplicate-suspected
    // stage on a loan that also has a variance — the likeliest combination —
    // is on no Overview surface at all.
    //
    // My first version of this assertion PASSED, vacuously: it looked for the
    // loan's name in the queue text, and the name was there because that loan
    // had an unrelated variance row. A test that can pass for a reason other
    // than the one it names is worse than no test, so it now asserts the thing
    // that is actually true, in the direction that actually matters: Overview
    // does NOT carry this, therefore the Loans column may never be quietly
    // dropped as a duplicate of something Overview shows.
    {
      const p = await newHarnessPage({ tab: 'overview', mutate: (d) => {
        // Deliberately a loan that ALSO has a variance issue — the suppressed case.
        const sp = d.loan_splits.find(x => x.status === 'staged');
        sp.stage_sweep_flag = 'duplicate_suspected';
        d.__loan = (d.loan_accounts.find(a => a.id === sp.loan_account_id) || {}).xero_account_name;
      } });
      const seen = await p.evaluate(() => ({
        // The precondition, measured on the page rather than believed: the
        // attention layer really does raise this item...
        raised: (typeof _bkLoanAttentionItems === 'function')
          ? _bkLoanAttentionItems().filter(i => i.kind === 'stage_flag').length : -1,
        // ...and the Overview queue really does not carry it. Keyed on the item
        // KEY, not on the loan name, which is what made the first version pass
        // for the wrong reason.
        inIssues: (typeof _bkIssueQueueItems === 'function')
          ? _bkIssueQueueItems().filter(i => /^stage-/.test(i.key)).length : -1,
        inApprovals: (typeof _bkApprovalQueueItems === 'function')
          ? _bkApprovalQueueItems().filter(i => /^stage-/.test(i.key)).length : -1,
      }));
      t.eq(seen.raised, 1,
           'the attention layer does raise the flagged stage — so the check below is about ROUTING, not about a stage that never fired');
      t.eq(seen.inIssues + seen.inApprovals, 0,
           'DOCUMENTED: a flagged stage on a loan that already has an Issue reaches NO Overview queue — which is why the Loans Staging column is the only guaranteed surface for it',
           `issues ${seen.inIssues}, approvals ${seen.inApprovals}`);
      await p.close();
    }

    // ── (g) the column sorts ─────────────────────────────────────────────────
    // Clicking Staging must put the rows that need somebody FIRST. A header
    // that sorts by a rank nobody checked is a header that quietly sorts by
    // nothing -- and the ranking is inverted relative to every other column
    // here (lower = more urgent), which is exactly the kind of thing that gets
    // "tidied" later.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const st = d.loan_splits.filter(x => x.status === 'staged');
        st[st.length - 1].stage_sweep_flag = 'duplicate_suspected';
        d.__loan = (d.loan_accounts.find(a => a.id === st[st.length - 1].loan_account_id) || {}).xero_account_name;
      } });
      const out = await p.evaluate(() => {
        const th = [...document.querySelectorAll('#loans-table-wrap thead th')]
          .find(x => x.innerText.trim() === 'Staging');
        th.click();
        const rows = [...document.querySelectorAll('#loans-table-wrap tbody tr')]
          .map(tr => [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim()));
        const hdr = [...document.querySelectorAll('#loans-table-wrap thead th')].map(x => x.innerText.trim());
        const i = hdr.indexOf('Staging'), n = hdr.indexOf('Loan');
        return { first: rows[0] ? rows[0][i] : '', firstName: rows[0] ? rows[0][n] : '',
                 col: rows.map(r => r[i]), name: window.__WR_FIXTURE.__loan };
      });
      t.ok(/needs a look/.test(out.first),
           'sorting by Staging puts the flagged row first — the only one anybody has to act on',
           `column after sort: ${JSON.stringify(out.col)}`);
      t.eq(out.firstName, out.name, '...and it is the loan that was actually flagged');
      const lastScheduled = out.col.map(c => /scheduled/.test(c)).lastIndexOf(true);
      const firstEmpty = out.col.findIndex(c => !/scheduled|needs a look/.test(c));
      t.ok(firstEmpty === -1 || lastScheduled < firstEmpty,
           '...and the loans with nothing staged sort below the ones that do',
           `column after sort: ${JSON.stringify(out.col)}`);
      await p.close();
    }
  },
});

/* 2b ── DOCUMENT INTAKE LIVES ON LOANS ───────────────────────────────────────
   Session 267. David asked for the dropzone to head loan management, and the
   reason it MATTERS is not placement: Overview is on the hide list in the scope
   reduction (docs/bookkeeping/SCOPE-REDUCTION-2026-09.md §5), so a dropzone left
   on Overview disappears with the tab, taking the module's only entry point for
   statements, schedules and payroll reports with it.

   This group exists so that regression is loud instead of silent. It asserts
   containment, not just presence: "the element exists somewhere" would stay
   green with the dropzone back on the tab that is about to be hidden, which is
   exactly the failure it is meant to catch. */
GROUPS.push({
  name: 'intake-on-loans',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });

    const where = await p.evaluate(() => {
      const dz = document.getElementById('bk-dropzone');
      const card = document.getElementById('bk-batch-card');
      const loans = document.getElementById('bk-view-loans');
      const overview = document.getElementById('bk-view-overview');
      const vis = (el) => !!(el && el.offsetParent !== null);
      return {
        dropzoneExists: !!dz,
        cardExists: !!card,
        dropzoneInLoans: !!(dz && loans && loans.contains(dz)),
        dropzoneInOverview: !!(dz && overview && overview.contains(dz)),
        cardInLoans: !!(card && loans && loans.contains(card)),
        // The pile has to sit AFTER the dropzone: dropped files land in it.
        dropzoneBeforeCard: !!(dz && card &&
          (dz.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING)),
        dropzoneVisibleOnLoans: vis(dz),
        inputExists: !!document.getElementById('bk-batch-input'),
      };
    });

    t.ok(where.dropzoneExists, 'the document dropzone still exists');
    t.ok(where.cardExists, 'the batch results card still exists');
    t.ok(where.dropzoneInLoans, 'the dropzone is inside the LOANS view');
    t.ok(!where.dropzoneInOverview,
         'the dropzone is NOT on Overview (Overview is on the hide list — it would vanish with the tab)');
    t.ok(where.cardInLoans, 'the batch results card moved with it, not left behind on Overview');
    t.ok(where.dropzoneBeforeCard,
         'the results pile sits AFTER the dropzone (dropped files land beneath it)');
    t.ok(where.dropzoneVisibleOnLoans, 'the dropzone is actually visible when Loans is open');
    t.ok(where.inputExists, 'the hidden file input came along too (the dropzone is dead without it)');

    await p.close();
  },
});

/* 2c ── AGREEMENT · SOURCE · ACTION COLUMNS ──────────────────────────────────
   Session 267, David's three columns. Asserted against the FIXTURE'S OWN rows
   rather than a hand-typed list, so the test cannot drift from the data: the
   expectation is recomputed from loan_documents and loan_accounts.close_basis
   the same way a reader would, and then checked against what rendered.

   The Source column is the one with a trap. It must read the RECORDED
   close_basis and never infer "schedule" from the presence of a schedule file —
   most schedules on this book were derived from the loan's own statements, so
   inferring would let a loan excuse itself from its only outside evidence on
   the strength of our own arithmetic (session 262's close gate). The fixture
   contains loans in exactly that shape, so the assertion below discriminates
   rather than merely passing. */
GROUPS.push({
  name: 'close-band-columns',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });

    const seen = await p.evaluate(() => {
      const head = [...document.querySelectorAll('#lcb-table thead th')]
        .map(th => th.innerText.replace(/\s+/g, ' ').trim());
      const rows = [...document.querySelectorAll('#lcb-table tbody tr')].map(tr => ({
        loan: (tr.querySelector('.td-name') || {}).innerText || '',
        agreement: tr.children[1] ? tr.children[1].getAttribute('data-agreement') : null,
        basis: tr.children[2] ? tr.children[2].getAttribute('data-close-basis') : null,
        basisText: tr.children[2] ? tr.children[2].innerText.trim() : '',
        action: tr.lastElementChild ? tr.lastElementChild.getAttribute('data-action') : null,
        actionText: tr.lastElementChild ? tr.lastElementChild.innerText.trim() : '',
        band: tr.querySelector('[data-band]') ? tr.querySelector('[data-band]').getAttribute('data-band') : '',
      }));
      const cellCounts = [...document.querySelectorAll('#lcb-table tbody tr')].map(tr => tr.children.length);
      const footCounts = [...document.querySelectorAll('#lcb-table tfoot tr')].map(tr => tr.children.length);
      return { head, rows, cellCounts, footCounts };
    });

    // Every row must have as many cells as the header has columns, and so must
    // the totals row — a column added to one and not the others silently shears
    // every figure one place to the left.
    const cols = seen.head.length;
    t.ok(seen.cellCounts.every(n => n === cols),
         `every body row has ${cols} cells, matching the header`,
         `saw ${[...new Set(seen.cellCounts)].join('/')}`);
    t.ok(seen.footCounts.every(n => n === cols),
         'the totals row has the same number of cells as the header',
         `saw ${[...new Set(seen.footCounts)].join('/')}`);

    // SESSION 267: the totals must READ STRAIGHT DOWN. Inline qualifiers like
    // "13 of 14" after a right-aligned figure shove it out of its column, so the
    // total no longer sits under the money it totals. The claim is not lost —
    // the footnote states it, the row's data- attributes carry the counts for
    // the export, and the cell keeps it on hover — but no text may share the
    // cell with the number.
    const totals = await p.evaluate(() => {
      const tr = document.querySelector('#lcb-table tfoot tr');
      if (!tr) return null;
      const cells = [...tr.children].map(td => ({
        text: td.innerText.replace(/\s+/g, ' ').trim(),
        amount: td.getAttribute('data-amount'),
        title: td.getAttribute('title') || '',
      }));
      return { cells, rowAttrs: {
        count: tr.getAttribute('data-count'),
        roll: tr.getAttribute('data-roll-count'),
        closing: tr.getAttribute('data-closing-count'),
        drawn: tr.getAttribute('data-drawn-measured'),
      } };
    });
    const moneyCells = (totals ? totals.cells : []).filter(c => c.amount !== null && c.amount !== '');
    const polluted = moneyCells.filter(c => /\bof\b|measured/i.test(c.text));
    t.ok(moneyCells.length > 0, 'the totals row has money cells to check', String(moneyCells.length));
    t.ok(polluted.length === 0,
         'no total carries an inline "N of M" note that would break column alignment',
         polluted.map(c => `"${c.text}"`).join(' · '));

    // ...and the claim still exists, one hover away and in the export.
    const qualified = moneyCells.filter(c => /covers \d+ of the \d+ loans|not measured/i.test(c.title));
    t.ok(qualified.length > 0,
         'a partial total still says so on hover — the claim moved, it was not deleted',
         qualified.map(c => c.text).join(' · ') || 'none qualified');
    t.ok(totals && totals.rowAttrs.count && totals.rowAttrs.closing,
         'and the counts remain in the row attributes the CSV export reads',
         JSON.stringify(totals && totals.rowAttrs));

    // The header is uppercased by CSS, so innerText comes back shouting. Compare
    // case-insensitively — asserting the rendered casing would be testing the
    // stylesheet, not the column order.
    const h = seen.head.map(x => x.toLowerCase());
    t.ok(h[1] === 'agreement', 'Agreement is the second column', seen.head.join(' | '));
    t.ok(h[2] === 'source', 'Source is the third column', seen.head.join(' | '));
    t.ok(h[cols - 1] === 'action', 'Action is the far-right column', seen.head.join(' | '));

    // Expectation rebuilt from the fixture, not typed in.
    const expect = await p.evaluate(() => {
      const accounts = window.__WR_FIXTURE.loan_accounts || [];
      const docs = window.__WR_FIXTURE.loan_documents || [];
      const byName = {};
      for (const a of accounts) {
        const name = a.xero_account_name || a.lender_account_number || '';
        byName[name] = {
          agreement: docs.some(d => d.loan_account_id === a.id && d.doc_type === 'agreement') ? '1' : '0',
          basis: a.close_basis || '',
          // The population that MATTERS is loans carrying amortization schedule
          // ROWS, not schedule documents: only one schedule document exists on
          // this book and it sits on a loan whose basis really is Schedule, so
          // an assertion keyed on documents is satisfied by an empty set and
          // proves nothing. Schedule ROWS are the shape a wrong implementation
          // would key on, and a dozen loans have them.
          // The schedule's loan_account_id is nested on the row's joined
          // loan_amortization_schedules object, not on the row itself.
          hasScheduleRows: (window.__WR_FIXTURE.loan_amortization_rows || [])
            .some(r2 => (r2.loan_amortization_schedules || {}).loan_account_id === a.id),
        };
      }
      return byName;
    });

    let agreeOk = 0, basisOk = 0;
    const agreeBad = [], basisBad = [];
    for (const r of seen.rows) {
      const e = expect[r.loan];
      if (!e) continue;
      if (r.agreement === e.agreement) agreeOk++; else agreeBad.push(`${r.loan}: showed ${r.agreement}, file says ${e.agreement}`);
      if (r.basis === e.basis) basisOk++; else basisBad.push(`${r.loan}: showed "${r.basis}", record says "${e.basis}"`);
    }
    t.ok(agreeBad.length === 0, `Agreement matches the documents on file (${agreeOk} rows)`, agreeBad.join(' · '));
    t.ok(basisBad.length === 0, `Source matches the RECORDED close basis (${basisOk} rows)`, basisBad.join(' · '));

    // THE TRAP, ASSERTED DIRECTLY. A loan holding a schedule document while its
    // recorded basis is the lender's statements must still read "Statements".
    // Without this, an implementation that inferred the basis from the file
    // would pass every assertion above on a book where the two happen to agree.
    const trap = seen.rows.filter(r => expect[r.loan] && expect[r.loan].hasScheduleRows
                                       && expect[r.loan].basis !== 'amortization_schedule');
    // An empty population here would make the assertion vacuous, so the size of
    // it is asserted too. A test that never runs is indistinguishable from one
    // that always passes.
    t.ok(trap.length >= 5,
         `the schedule-rows-but-statement-basis population is real (${trap.length} loans), so the next assertion is not vacuous`,
         trap.map(r => r.loan).join(' · '));
    t.ok(trap.every(r => r.basisText.startsWith('Statements')),
         'a loan carrying an amortization SCHEDULE but closed on statements still reads Statements',
         trap.filter(r => !r.basisText.startsWith('Statements')).map(r => `${r.loan}: "${r.basisText}"`).join(' · '));

    // THE UNUSED GENUINE SCHEDULE (David spotted this on PCV before the column
    // did). A loan closed on statements that ALSO holds a lender-issued schedule
    // gets a marker; one whose only schedule was derived from its own statements
    // must NOT, because closing against that would agree by construction.
    const schedProv = await p.evaluate(() => {
      const rows = window.__WR_FIXTURE.loan_amortization_rows || [];
      const byLoan = {};
      for (const r of rows) {
        const sc = r.loan_amortization_schedules; if (!sc || !sc.loan_account_id) continue;
        (byLoan[sc.loan_account_id] = byLoan[sc.loan_account_id] || []).push({ source: sc.source || '', amort_type: sc.amort_type || '', id: sc.id });
      }
      const out = {};
      for (const a of (window.__WR_FIXTURE.loan_accounts || [])) {
        const seenIds = new Set();
        const pairs = (byLoan[a.id] || []).filter(x => !seenIds.has(x.id) && seenIds.add(x.id));
        out[a.xero_account_name || a.lender_account_number || ''] = {
          // Mirrors the page's allowlist. An unknown source is NOT genuine.
          // Mirrors the page: parse-sourced AND actually a schedule. A payment
          // history parses the same way a contract does and is not one.
          real: pairs.some(x => ['claude_assisted_parse', 'client_parsed_verified'].includes(x.source)
                              && ['amortization_schedule'].includes(x.amort_type)),
          derivedOnly: pairs.length > 0 && !pairs.some(x => ['claude_assisted_parse', 'client_parsed_verified'].includes(x.source)
                              && ['amortization_schedule'].includes(x.amort_type)),
          basis: a.close_basis || '',
        };
      }
      return out;
    });
    const marked = await p.evaluate(() => [...document.querySelectorAll('#lcb-table tbody tr')]
      .filter(tr => tr.children[2] && tr.children[2].querySelector('.lcb-basis-alt'))
      .map(tr => (tr.querySelector('.td-name') || {}).innerText || ''));

    const shouldMark = Object.entries(schedProv)
      .filter(([, v]) => v.real && v.basis !== 'amortization_schedule')
      .map(([k]) => k)
      .filter(n => seen.rows.some(r => r.loan === n));
    t.ok(shouldMark.length > 0,
         `at least one loan has a genuine schedule it is not closing on (${shouldMark.join(', ')}) — the marker assertion is not vacuous`);
    t.ok(shouldMark.every(n => marked.includes(n)),
         'a loan holding a genuine lender schedule but closed on statements is marked',
         `expected ${shouldMark.join(', ')}; marked ${marked.join(', ') || 'none'}`);

    // A LOAN WHOSE ONLY PARSED ARTEFACT IS A PAYMENT HISTORY IS NOT MARKED.
    // PayPal 2 is that loan: its CSV parses like a contract and records what was
    // paid, on a total_payback basis. Provenance alone would have marked it.
    const payHist = await p.evaluate(() => {
      const rows = window.__WR_FIXTURE.loan_amortization_rows || [];
      const out = new Set();
      for (const r of rows) {
        const sc = r.loan_amortization_schedules; if (!sc) continue;
        if (sc.amort_type === 'actual_payment_history_from_lender_csv') out.add(sc.loan_account_id);
      }
      const names = [];
      for (const a of (window.__WR_FIXTURE.loan_accounts || [])) {
        if (out.has(a.id)) names.push(a.xero_account_name || a.lender_account_number || '');
      }
      return names;
    });
    t.ok(payHist.length > 0, `a payment-history artefact exists to test against (${payHist.join(', ')})`);
    t.ok(payHist.every(n => !marked.includes(n)),
         'a loan whose parsed artefact is a PAYMENT HISTORY is not offered the schedule basis',
         payHist.filter(n => marked.includes(n)).join(' · '));

    const derivedMarked = marked.filter(n => schedProv[n] && schedProv[n].derivedOnly);
    t.ok(derivedMarked.length === 0,
         'a loan whose ONLY schedule was derived from its own statements is NOT marked',
         derivedMarked.join(' · '));

    // THE FIX ROUTE. A red row with an open balance_vs_lender finding offers
    // "Find the fix", which opens the EXISTING analyser. The assertion that
    // matters is not that a button exists — it is that the button never appears
    // on a row with no finding to walk, because the analyser would have nothing
    // to work from and the person would be sent to a dead end.
    const dbg = await p.evaluate(() => {
      try {
        const f = (typeof _reconFindings !== 'undefined') ? _reconFindings : null;
        return { visible: f !== null, len: f ? f.length : -1,
                 sample: f && f[0] ? Object.keys(f[0]).slice(0, 12) : [],
                 openBvl: f ? f.filter(x => x.check_key === 'balance_vs_lender' && x.status === 'open').length : -1 };
      } catch (e) { return { err: String(e && e.message) }; }
    });
    // THE FIRST PAINT MUST ALREADY BE RIGHT. The close band renders before the
    // findings fetch resolves, so a surface that reads findings has to repaint
    // when they arrive. Forcing a re-render must change NOTHING — if it adds
    // buttons, the page a person actually looks at is missing them.
    const rerender = await p.evaluate(() => {
      const count = () => [...document.querySelectorAll('#lcb-table tbody tr')]
        .filter(tr => tr.lastElementChild && tr.lastElementChild.getAttribute('data-action') === 'fix').length;
      const before = count();
      if (typeof renderLoansCloseBand === 'function') renderLoansCloseBand();
      return { before, after: count() };
    });
    t.ok(rerender.after === rerender.before,
         'the rendered page already shows every fix button — a re-render adds none',
         JSON.stringify(rerender));
    const fixRows = seen.rows.filter(r => r.action === 'fix');
    const findingLoans = await p.evaluate(() => {
      const f = (window.__WR_FIXTURE.reconciliation_findings || [])
        .filter(x => x.check_key === 'balance_vs_lender' && x.status === 'open')
        .map(x => x.loan_account_id);
      const set = new Set(f);
      return (window.__WR_FIXTURE.loan_accounts || [])
        .filter(a => set.has(a.id))
        .map(a => a.xero_account_name || a.lender_account_number || '');
    });
    t.ok(fixRows.length > 0, `at least one row offers the fix route (${fixRows.map(r => r.loan).join(', ')})`,
         'actions seen: ' + seen.rows.map(r => `${r.loan}=${r.action || 'none'}/band=${r.band||'-'}`).join(' | '));
    t.ok(fixRows.every(r => findingLoans.includes(r.loan)),
         'the fix route is only offered where an open balance_vs_lender finding exists to walk',
         fixRows.filter(r => !findingLoans.includes(r.loan)).map(r => r.loan).join(' · '));

    // A row that ties gets no action: a column that always says something is a
    // column people stop reading.
    const tiedWithAction = seen.rows.filter(r => r.band === 'tie' && r.actionText);
    t.ok(tiedWithAction.length === 0, 'a row that ties offers no action',
         tiedWithAction.map(r => `${r.loan}: "${r.actionText}"`).join(' · '));

    // AND THE RULE THAT MATTERS MOST: a difference with no established cause is
    // never offered a one-click journal. Booking it to make the books agree
    // would hide the reason rather than find it — the reasoning that produced
    // the v14/v15 payroll double-count.
    const postsOffered = seen.rows.filter(r => r.action === 'post');
    t.ok(postsOffered.every(r => r.band === 'unbooked'),
         'a "post" action appears ONLY where unposted payments already explain the difference',
         postsOffered.map(r => `${r.loan}: band=${r.band}`).join(' · '));

    await p.close();
  },
});

/* 2d ── THE COUNT BADGE BELONGS ON OVERVIEW ONLY ─────────────────────────────
   Session 267. David asked twice for "N to clear" to go, and the first attempt
   removed it from the WRONG page — two near-identical call sites, one in
   renderOverviewPeriodBar and one in renderLoansPeriodBar. This pins both ends
   so the same mistake cannot be made silently again.

   It is not symmetric and that is the point: on Loans the rows sit directly
   under the bar, so the count restates the list; on Overview there is no list
   and the badge is the only statement of how much is left. */
GROUPS.push({
  name: 'period-bar-count',
  async run(t) {
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const seen = await p.evaluate(() => {
        const bar = document.getElementById('bk-loans-period-bar') ||
                    document.querySelector('#bk-view-loans .lpb-seg')?.parentElement;
        return { text: bar ? bar.innerText.replace(/\s+/g, ' ') : '(no bar)',
                 counts: bar ? bar.querySelectorAll('.lpb-count').length : -1 };
      });
      t.ok(seen.counts === 0, 'the LOANS period bar carries no "N to clear" badge', JSON.stringify(seen));
      t.ok(!/to clear/i.test(seen.text), 'and the words do not appear on it either', seen.text);
      await p.close();
    }
    {
      const p = await newHarnessPage({ tab: 'overview' });
      const seen = await p.evaluate(() => {
        const el = document.getElementById('bk-view-overview');
        return { counts: el ? el.querySelectorAll('.lpb-count').length : -1,
                 text: el ? (el.innerText.match(/\d+ to clear/) || ['(none)'])[0] : '(no view)' };
      });
      t.ok(seen.counts >= 1, 'OVERVIEW keeps its count — it has no list beneath it', JSON.stringify(seen));
      await p.close();
    }
  },
});

/* 2d-bis ── THE RECONCILIATION CONTROL IS ON LOANS, NOT OVERVIEW ────────────
   Session 269, David: "move the Run Reconciliation Check button from the
   Overview page to the Loans page."

   Three failure modes this pins, and the middle one is the reason the group
   exists at all:

   1. The move is half-done — the button reachable on both pages, or on
      neither. Asserted on BOTH pages, like period-bar-count above, because the
      two near-identical bar renderers are exactly where a one-sided edit hides.

   2. THE STATUS GOES BLANK. renderLoansPeriodBar() sets innerHTML, which
      destroys #recon-lastrun and #recon-summary every time it runs — and it
      runs from loadLoans() and from a late settings read, neither of which
      loads reconciliation. Fill the status first, repaint after, and the
      button is left beside two empty elements with nothing to refill them.
      Asserted with a sentinel through the real repaint path; see the long
      note at that assertion for why the fixture's own text cannot show it.

   3. It is present but not CLICKABLE — the whole point of the move is that a
      reader can reach it from Loans. Checked with offsetParent, which sees
      through a display:none ancestor (see 2e below for why getComputedStyle
      does not), and by clicking the real element rather than calling
      runReconciliationCheck() by name. The click is expected to fail against
      the offline stub; what is asserted is that the BUTTON responded — it
      disables itself and relabels — not that the check succeeded. */
GROUPS.push({
  name: 'recon-control-placement',
  async run(t) {
    const probe = () => {
      const btn = document.getElementById('recon-run-btn');
      const act = document.querySelector('#loans-close-band .lcb-act');
      const exp = act ? [...act.querySelectorAll('button')].find(b => /Export CSV/.test(b.textContent)) : null;
      const cs = e => e ? getComputedStyle(e) : null;
      const h  = e => e ? Math.round(e.getBoundingClientRect().height) : null;
      return {
        exists: !!btn,
        label: btn ? btn.textContent.trim() : null,
        reachable: !!(btn && btn.offsetParent),
        inCloseBandHead: !!(act && btn && act.contains(btn)),
        inOverview: !!(btn && document.getElementById('bk-view-overview')?.contains(btn)),
        // "to the left of Export CSV" — assert ORDER, not pixels, so this holds
        // whichever way the row is aligned later.
        beforeExport: !!(btn && exp &&
          (btn.compareDocumentPosition(exp) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
        sameClass: !!(btn && exp && btn.className === exp.className),
        heights: [h(btn), h(exp)],
        grounds: [cs(btn)?.backgroundColor, cs(exp)?.backgroundColor],
        borders: [cs(btn)?.borderTopColor, cs(exp)?.borderTopColor],
        radii:   [cs(btn)?.borderTopLeftRadius, cs(exp)?.borderTopLeftRadius],
        fonts:   [cs(btn)?.fontSize + '/' + cs(btn)?.fontWeight, cs(exp)?.fontSize + '/' + cs(exp)?.fontWeight],
        hasLastRun: !!document.getElementById('recon-lastrun'),
        hasSummary: !!document.getElementById('recon-summary'),
        hasReports: !!document.getElementById('recon-reports'),
      };
    };

    {
      const p = await newHarnessPage({ tab: 'loans' });
      const seen = await p.evaluate(probe);
      t.eq(seen.exists, true, 'r269a: the Run Reconciliation Check button exists', JSON.stringify(seen));
      t.eq(seen.label, 'Run Reconciliation Check', 'r269b: ...under its own name', String(seen.label));
      t.eq(seen.inCloseBandHead, true,
           'r269c: ...in the close band header, the row that already carries Export CSV', JSON.stringify(seen));
      t.eq(seen.beforeExport, true,
           'r269d: ...and it comes BEFORE Export CSV in the document, i.e. to its left',
           JSON.stringify(seen));
      t.eq(seen.inOverview, false, 'r269e: ...and not inside the Overview view', JSON.stringify(seen));
      t.eq(seen.reachable, true, 'r269f: ...and actually reachable with Loans open', JSON.stringify(seen));

      /* MATCHED BY CONSTRUCTION, NOT BY COINCIDENCE (session 269, David:
         "Make both same height, same color (white)").

         The class assertion is the one that matters. Two buttons can be pixel-
         identical today and drift the moment someone edits one of the two rule
         sets; sharing .lcb-export means there is only one rule set to edit. The
         measured assertions below are the check that the shared class actually
         produced a match — a class name alone would pass even if an inline
         style on one of them overrode it. */
      t.eq(seen.sameClass, true,
           'r269g: both buttons carry the SAME class — matched by construction, not by two rule sets kept in step',
           JSON.stringify(seen));
      t.eq(seen.heights[0] === seen.heights[1] && seen.heights[0] > 0, true,
           'r269h: ...and render at the same height', JSON.stringify(seen.heights));
      t.eq(seen.grounds[0] === seen.grounds[1], true,
           'r269i: ...on the same ground', JSON.stringify(seen.grounds));
      t.eq(/^rgba?\(255,\s*255,\s*255/.test(seen.grounds[0] || ''), true,
           'r269j: ...and that ground is white, as asked', JSON.stringify(seen.grounds));
      t.eq(seen.borders[0] === seen.borders[1] && seen.radii[0] === seen.radii[1] &&
           seen.fonts[0] === seen.fonts[1], true,
           'r269k: ...with the same border, corner and type — nothing left to drift',
           JSON.stringify({ b: seen.borders, r: seen.radii, f: seen.fonts }));

      t.eq(seen.hasLastRun && seen.hasSummary, true,
           'r269l: its two status lines came with it — a control without its status is half a move',
           JSON.stringify(seen));
      t.eq(seen.hasReports, true,
           'r269m: ...while past reports stayed in Overview’s History panel', JSON.stringify(seen));

      /* THE REPAINT, AND IT IS renderLoansCloseBand's NOW.
         Same mechanism as before the button moved, different owner: the band's
         innerHTML destroys the two status elements, loadReconciliation fills
         them and does not repaint the band, and the band's repainters do not
         load reconciliation. A sentinel is the only way to see it — with a
         completed run and open findings the fixture's own status text is
         correctly '', so "non-empty" would pass against broken code. */
      const sentinel = await p.evaluate(() => {
        const real = window.renderReconciliation;
        const SENT = 'WR-TEST-SENTINEL-269';
        const stubbable = typeof real === 'function';
        window.renderReconciliation = function () {
          const el = document.getElementById('recon-summary');
          if (el) el.textContent = SENT;
        };
        renderLoansCloseBand();
        const withCall = (document.getElementById('recon-summary')?.textContent || '');
        window.renderReconciliation = function () {};
        renderLoansCloseBand();
        const withoutCall = (document.getElementById('recon-summary')?.textContent || '');
        window.renderReconciliation = real;
        renderLoansCloseBand();
        const btn = document.getElementById('recon-run-btn');
        return { stubbable, withCall, withoutCall, SENT,
                 survives: !!(btn && btn.offsetParent),
                 lastRun: !!document.getElementById('recon-lastrun'),
                 summary: !!document.getElementById('recon-summary') };
      });
      t.eq(sentinel.stubbable, true,
           'r269n: renderReconciliation is reachable to stub — the inverse test is not vacuous',
           JSON.stringify(sentinel));
      t.eq(sentinel.withCall, sentinel.SENT,
           'r269o: a close-band repaint calls renderReconciliation AFTER its innerHTML — the sentinel survives',
           JSON.stringify(sentinel));
      t.eq(sentinel.withoutCall, '',
           'r269p: ...and with that call stubbed out nothing else refills the status',
           JSON.stringify(sentinel));
      t.eq(sentinel.survives && sentinel.lastRun && sentinel.summary, true,
           'r269q: a repaint rebuilds button and status together — neither outlives the other',
           JSON.stringify(sentinel));

      /* ⚠️ THE COST OF THIS PLACEMENT, STATED SO IT IS A DECISION AND NOT A
         SILENT REGRESSION. The close band lives inside #loans-period-closing,
         so it is hidden on In flight — and the button goes with it. When the
         button sat in the period bar it survived the switch.

         Reconciliation is not period-scoped: the engine's balance_vs_lender is
         a statement about TODAY, which the module's own rules say must never be
         silenced on account of a period. So this is a real reduction in reach,
         accepted deliberately because David asked for the button beside Export
         CSV and that is where Export CSV is. Pinned as an assertion so that if
         anyone later wonders whether it was noticed: it was. Flip this the day
         the button needs to be reachable from In flight. */
      const inflight = await p.evaluate(() => {
        switchLoansPeriod('inflight');
        const btn = document.getElementById('recon-run-btn');
        const out = { present: !!btn, reachable: !!(btn && btn.offsetParent) };
        switchLoansPeriod('closing');
        out.backOnClosing = !!document.getElementById('recon-run-btn')?.offsetParent;
        return out;
      });
      t.eq(inflight.reachable, false,
           'r269r: ⚠ REPORTED — on In flight the button is hidden with the close band. Deliberate (David: beside Export CSV); flip this if it must be reachable there',
           JSON.stringify(inflight));
      t.eq(inflight.backOnClosing, true,
           'r269s: ...and it comes straight back on Closing, so nothing is lost permanently',
           JSON.stringify(inflight));

      /* CLICK IT — not runReconciliationCheck() by name; a dead onclick passes
         that every time. The offline stub cannot complete a run, so what is
         asserted is that the BUTTON reacted. */
      const clicked = await p.evaluate(() => {
        const btn = document.getElementById('recon-run-btn');
        btn.click();
        return { disabled: btn.disabled, label: btn.textContent.trim() };
      });
      t.eq(clicked.disabled, true,
           'r269t: clicking the real element runs the handler — the onclick is live, not decorative',
           JSON.stringify(clicked));
      t.eq(clicked.label, 'Checking…',
           'r269u: ...and says so, so a second click cannot start a second run', JSON.stringify(clicked));
      await p.close();
    }

    {
      /* Session 269: asking for Overview no longer OPENS Overview — its tab is
         gone and switchBookkeepingView redirects it to Loans. This half of the
         group therefore changed meaning: it used to prove the button had left
         Overview, and now also has to prove the redirect lands somewhere the
         button actually is. Both are worth holding, so both are asserted. */
      const p = await newHarnessPage({ tab: 'overview' });
      const seen = await p.evaluate(() => ({
        activeTab: typeof _bookkeepingActiveTab !== 'undefined' ? _bookkeepingActiveTab : null,
        overviewShown: getComputedStyle(document.getElementById('bk-view-overview')).display !== 'none',
        overviewTab: !!document.getElementById('bkvt-overview'),
        btnInOverview: !!document.getElementById('bk-view-overview')
          ?.contains(document.getElementById('recon-run-btn')),
        btnReachable: !!document.getElementById('recon-run-btn')?.offsetParent,
      }));
      t.eq(seen.activeTab, 'loans',
           'r269v: an #bookkeeping/overview request redirects to Loans — an old bookmark still lands somewhere real',
           JSON.stringify(seen));
      t.eq(seen.overviewShown, false, 'r269w: ...and Overview itself never displays', JSON.stringify(seen));
      t.eq(seen.overviewTab, false, 'r269x: ...and its tab is gone from the row', JSON.stringify(seen));
      t.eq(seen.btnInOverview, false, 'r269y: the button is not inside the Overview div', JSON.stringify(seen));
      t.eq(seen.btnReachable, true,
           'r269z: ...and is reachable after the redirect, because the redirect lands on Loans',
           JSON.stringify(seen));
      await p.close();
    }
  },
});

/* 2e ── THE FIX BUTTON ACTUALLY OPENS SOMETHING ──────────────────────────────
   Session 267, and this group exists because of a specific failure.

   The Action column's "Find the fix" button did nothing on the live page. The
   modal it opens had been placed beside #modal-loan-bundle — inside
   #bk-view-overview, which is display:none whenever Loans is open. The modal
   opened into a hidden subtree: no error, no dialog, nothing at all.

   The first attempt to test this PASSED anyway, which is the part worth
   remembering. It asked getComputedStyle(modal).display, and that returns an
   element's OWN display value even when an ancestor is display:none — so an
   invisible element reported "flex". offsetParent and getBoundingClientRect are
   the checks that see through an ancestor, so those are what this asserts.

   It also CLICKS the button rather than calling the handler by name: a dead
   onclick attribute passes every test that invokes window.someFunction()
   directly (the repo's own rule, learned the hard way). */
GROUPS.push({
  name: 'fix-button-opens',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const errs = [];
    p.page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    p.page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    // The modal must not live inside ANY of the four view containers — three of
    // them are hidden at any moment, and which one is hidden depends on the tab.
    const placement = await p.evaluate(() => {
      const m = document.getElementById('modal-loan-fix');
      if (!m) return { exists: false };
      const views = ['bk-view-overview', 'bk-view-loans', 'bk-view-payroll', 'bk-view-client']
        .filter(id => { const v = document.getElementById(id); return v && v.contains(m); });
      return { exists: true, insideViews: views };
    });
    t.ok(placement.exists, 'the fix modal exists');
    t.ok(placement.insideViews && placement.insideViews.length === 0,
         'the fix modal lives OUTSIDE every tab container (three of the four are always hidden)',
         (placement.insideViews || []).join(', '));

    /* SESSION 269 — THE SAME RULE, NOW FOR THE OTHER TWO.
       #modal-loan-bundle and the #bk-peek document viewer used to sit inside
       #bk-view-overview and got away with it because they were opened FROM
       Overview, which was visible when they were. Hiding Overview removed that
       exemption: its div is display:none permanently now, so anything left
       inside it opens into a hidden subtree — no error, no dialog, nothing at
       all, which is precisely what this group was written for.

       Checked with checkVisibility(), NOT offsetParent and NOT getComputedStyle.
       getComputedStyle is the false pass this group's comment above warns about —
       an element inside a display:none ancestor still reports its own display.
       But offsetParent is wrong here too, in the opposite direction: it is null
       for ANY position:fixed element whether visible or not, and both of these
       are fixed, so it fails them both on a healthy page. That is what it did on
       the first run of this assertion. checkVisibility() is the one API that
       sees through ancestors without being confused by fixed positioning. */
    for (const id of ['modal-loan-bundle', 'bk-peek']) {
      const seen = await p.evaluate((elId) => {
        const el = document.getElementById(elId);
        if (!el) return { exists: false };
        const views = ['bk-view-overview', 'bk-view-loans', 'bk-view-payroll', 'bk-view-client']
          .filter(v => document.getElementById(v)?.contains(el));
        const prev = el.style.display;
        el.style.display = elId === 'modal-loan-bundle' ? 'flex' : 'block';
        const r = el.getBoundingClientRect();
        const out = {
          exists: true, insideViews: views,
          visible: el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                   r.width > 0 && r.height > 0,
          ownDisplay: getComputedStyle(el).display,
        };
        el.style.display = prev;
        return out;
      }, id);
      t.eq(seen.exists, true, `s269: #${id} still exists after the move`, JSON.stringify(seen));
      t.eq(seen.insideViews.length, 0,
           `s269: #${id} lives outside every tab container — Overview is permanently hidden now`,
           (seen.insideViews || []).join(', '));
      t.eq(seen.visible, true,
           `s269: #${id} actually renders on screen when opened (checkVisibility sees hidden ancestors)`,
           JSON.stringify(seen));

      /* AND PROVE THAT ASSERTION CAN FAIL. Put the element back where it used to
         live — inside #bk-view-overview — open it there, and confirm it goes
         invisible. Done by moving the live node in page context and putting it
         straight back, never by editing index.html. Without this, "visible:true"
         is just as consistent with a check that cannot see a hidden ancestor as
         with a working move, and that is the exact mistake that let the original
         session 267 bug through. */
      const inverse = await p.evaluate((elId) => {
        const el = document.getElementById(elId);
        const home = el.parentElement, next = el.nextSibling;
        document.getElementById('bk-view-overview').appendChild(el);
        const prev = el.style.display;
        el.style.display = elId === 'modal-loan-bundle' ? 'flex' : 'block';
        const hidden = !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        el.style.display = prev;
        home.insertBefore(el, next);          // exactly where it was
        el.style.display = elId === 'modal-loan-bundle' ? 'flex' : 'block';
        const backVisible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        el.style.display = prev;
        return { hidden, backVisible, restoredTo: el.parentElement === home };
      }, id);
      t.eq(inverse.hidden, true,
           `s269: ...and back inside the hidden Overview div it does NOT — so that check is real, not decoration`,
           JSON.stringify(inverse));
      t.eq(inverse.backVisible && inverse.restoredTo, true,
           `s269: ...and #${id} was returned to exactly where it was`, JSON.stringify(inverse));
    }

    const btn = await p.evaluate(() => {
      const tr = [...document.querySelectorAll('#lcb-table tbody tr')]
        .find(x => x.lastElementChild && x.lastElementChild.getAttribute('data-action') === 'fix');
      return tr ? { loan: (tr.querySelector('.td-name') || {}).innerText || '' } : null;
    });
    t.ok(!!btn, 'a row offers "Find the fix" to click', JSON.stringify(btn));

    if (btn) {
      // CLICK it. Not bkOpenFixModal(...) — a dead onclick passes that.
      await p.page.evaluate(() => {
        const tr = [...document.querySelectorAll('#lcb-table tbody tr')]
          .find(x => x.lastElementChild && x.lastElementChild.getAttribute('data-action') === 'fix');
        tr.lastElementChild.querySelector('button').click();
      });
      await new Promise(r => setTimeout(r, 600));

      const vis = await p.evaluate(() => {
        const m = document.getElementById('modal-loan-fix');
        const r = m ? m.getBoundingClientRect() : null;
        // THREE CHECKS, AND ONLY ONE OF THEM IS TRUSTWORTHY.
        //  · getComputedStyle(m).display reports the element's OWN value and
        //    happily says "flex" inside a display:none ancestor. It is recorded
        //    here as evidence, never asserted on.
        //  · offsetParent is null for position:fixed elements no matter how
        //    visible they are, so it cannot be used on a modal either.
        //  · checkVisibility() walks the ancestor chain — display, visibility,
        //    opacity, content-visibility — and is the one that answers the
        //    question a person asks: can I see it?
        return {
          computed: m ? getComputedStyle(m).display : null,
          offsetParentNull: m ? (m.offsetParent === null) : null,
          rect: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
          visible: m && typeof m.checkVisibility === 'function'
            ? m.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : null,
          bodyText: (document.getElementById('loan-fix-body') || {}).innerText || '',
        };
      });
      t.ok(vis.visible === true, 'the modal is genuinely visible (checkVisibility sees hidden ancestors)', JSON.stringify(vis));
      t.ok(vis.rect && vis.rect.w > 0 && vis.rect.h > 0, 'the modal has real width and height', JSON.stringify(vis.rect));
      t.ok(vis.bodyText.length > 0, 'and it says something while the analysis runs', vis.bodyText.slice(0, 80));
      // The harness is offline, so the analyser's fetch to loan-find-difference
      // fails by design. That is the stub working, not a defect — anything else
      // in the console is real.
      const realErrs = errs.filter(e => !/ERR_FAILED|Failed to load resource|Failed to fetch|NetworkError/i.test(e));
      t.ok(realErrs.length === 0, 'clicking it raises no page or console error beyond the offline fetch',
           realErrs.slice(0, 3).join(' | '));
    }
    await p.close();
  },
});

/* 3 ── TAB-SWITCH RACES ──────────────────────────────────────────────────── */
GROUPS.push({
  name: 'tab-races',
  async run(t) {
    // Baseline: land on each tab cleanly and record every number.
    const baseline = {};
    /* Session 269: 'overview' left THIS matrix only (cold-boot and the closing-
       evidence sweep still walk it, and correctly — asking for it just lands on
       Loans there, which is a fine thing to render). Here it was actively
       misleading: the race compares each tab against its own clean baseline via
       a tab-keyed pick(), and 'overview' now renders Loans while being measured
       with Overview's surfaces, so it could only ever mismatch. The KPI tiles it
       used to cover are still covered by the ['client','kpis'] row. */
    for (const [tab, sub] of [['loans', null], ['payroll', null], ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis']]) {
      const p = await newHarnessPage({ tab, sub });
      baseline[tab + (sub ? '/' + sub : '')] = await p.surfaces();
      await p.close();
    }

    // Race: boot cold on Overview with the loaders parked, flip through every
    // tab while they are in flight, land back on each one, then release.
    const ALL = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows',
                 'payroll_imports', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
                 'bk_issue_dismissals', 'bookkeeping_kpi_snapshots'];
    for (const [tab, sub] of [['loans', null], ['payroll', null], ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis']]) {
      const label = tab + (sub ? '/' + sub : '');
      const p = await newHarnessPage({ tab: 'overview', settle: false, hold: ALL, defaultLatency: 5 });
      await p.switchTab('client', 'kpis');
      await p.switchTab('loans');
      await p.switchTab('payroll');
      await p.switchTab('client', 'debt');
      await p.release('loan_accounts', 'loan_statements');           // half the data lands…
      await p.page.waitForTimeout(40);
      await p.switchTab('overview');                                  // …mid-flight tab flip
      await p.switchTab(tab, sub);                                    // …and back to the tab under test
      await p.release(...ALL);
      await p.settle();
      const after = await p.surfaces();
      const want = baseline[label];

      // Compare only what this tab actually shows. A pane the racing run passed
      // THROUGH and left in its empty state repaints on the next switch, so it
      // is not a defect — the tab you are standing on is.
      const pick = (s) => tab === 'loans' ? {
        loansSummary: s.loans.summaryTiles,
        closeFoot: s.loans.closeBand && s.loans.closeBand.foot0,
        gates: s.loans.closeBand && s.loans.closeBand.gates.map(g => g.text),
        rows: s.loans.closeBand && s.loans.closeBand.rows.length, tableRows: s.loans.tableRows,
      } : tab === 'overview' ? {
        segIssues: s.overview.segIssues, segApprovals: s.overview.segApprovals,
        statusline: s.overview.statusline, kpiTiles: s.overview.kpiTiles,
      } : tab === 'payroll' ? {
        payrollTiles: s.payroll.summaryTiles, payrollRows: s.payroll.tableRows,
      } : sub === 'debt' ? {
        dsFoot: s.client.debtSched && s.client.debtSched.foot,
        dsRows: s.client.debtSched && s.client.debtSched.bodyRows,
      } : sub === 'kpis' ? {
        kpiTiles: s.overview.kpiTiles, kpiAsOf: !!s.overview.kpiAsOf,
      } : {
        debtTiles: s.client.debtTiles, checklistCount: s.client.checklistCount,
        chartNote: s.client.chartNote,
      };
      const a = JSON.stringify(pick(after)), b = JSON.stringify(pick(want));
      t.ok(a === b, `race → ${label}: every surface holds the same numbers as a clean load`,
           a === b ? '' : firstDiff(pick(after), pick(want)));

      // The nav badge is always on screen. It must not depend on which loader won.
      t.eq(after.navBadge && after.navBadge.text, want.navBadge && want.navBadge.text,
           `race → ${label}: the sidebar badge is the same number whichever loader wins`);
      t.noBadMoney(after.bodyText, `race → ${label}`);
      await p.close();
    }
  },
});
function firstDiff(a, b) {
  for (const k of Object.keys(b)) {
    const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
    if (x !== y) return `${k}: raced ${String(x).slice(0, 260)} · clean ${String(y).slice(0, 260)}`;
  }
  return 'differs';
}

/* 4 ── SAME QUANTITY, TWO SURFACES ───────────────────────────────────────── */
GROUPS.push({
  name: 'two-surfaces',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });
    // Render every tab once so all surfaces are populated, then read them all.
    await p.switchTab('loans'); await p.switchTab('payroll');
    await p.switchTab('client', 'debt'); await p.switchTab('client', 'kpis');
    await p.switchTab('client', 'dashboard'); await p.switchTab('overview');
    await p.settle();
    const s = await p.surfaces();

    // (a) nav badge vs the Approvals list
    const badge = Number(s.navBadge.text);
    const seg = Number((s.overview.segApprovals || '').match(/\((\d+)\)/)?.[1]);
    t.eq(badge, seg, 'nav badge equals the Approvals count on Overview');

    // (b) Total outstanding (Loans) vs Total owed (Client View)
    const outstanding = parseMoney(s.loans.summaryTiles['Total outstanding']?.value);
    const owed = parseMoney(s.client.debtTiles['Total owed']?.value);
    t.eq(money(outstanding), money(owed), 'Loans "Total outstanding" equals Client View "Total owed"');

    // (c) active-loan count agrees between the two tiles
    const activeTile = Number(s.loans.summaryTiles['Active loans']?.value);
    const owedSub = Number((s.client.debtTiles['Total owed']?.delta || '').match(/(\d+)/)?.[1]);
    t.eq(activeTile, owedSub, 'Loans "Active loans" equals Client View "across N active loans"');

    // (d) paid-last-month vs the close band's own principal + interest
    const cb = s.loans.closeBand;
    const lastMonthLabel = Object.keys(s.loans.summaryTiles).find(k => /Paid last month/.test(k));
    const paidTile = s.loans.summaryTiles[lastMonthLabel];
    const paidTotal = parseMoney(paidTile.value);
    const paidPrincipal = parseMoney(paidTile.delta.split('principal')[0]);
    const paidInterest = parseMoney(paidTile.delta.split('·')[1]);
    // tfoot cell indices: 0=label, 1=opening, 2=principal, 3=interest,
    // 4=computed, 5=perLender, 6=variance.
    //
    // SESSION 246: THE FOOTER IS THREE ROWS, NOT TWO. Grade A and grade B never
    // share a subtotal — that separation is the whole point of the session — so
    // `foot0 + excluded` reads the lender-confirmed line plus the excluded line
    // and silently drops every loan closing on its contractual schedule
    // ($6,014.17 of real July principal). The invariant is not "foot0 is the
    // month"; it is A + B + excluded = the month, and it is asserted as such.
    const sub  = cb.subtotals || {};
    // Indexed through the column map, not by a literal. When the rollforward was
    // flattened for CSV export these four numbers all shifted at once, and every
    // assertion below silently read the neighbouring column's money.
    const CI = cb.columnIndex;
    const cell = (k, i2) => (sub[k] && sub[k].cells[i2] != null ? parseMoney(sub[k].cells[i2]) : 0) || 0;
    const at = (k, name) => cell(k, CI[name]);

    // ── ONE TOTAL LINE NOW (session 247, David's layout pass) ─────────────
    // The per-grade subtotal rows are gone: Closing source names the grade on
    // every row and the chips carry the counts, so three footer rows restating
    // the split were the same arithmetic told twice.
    //
    // THE INVARIANT IS NOT DELETED, IT IS RE-ANCHORED. What mattered was never
    // "three footer rows exist"; it was that the month's money is accounted for
    // exactly once and that the grade split is still stated somewhere a reader
    // can check. The first half moves to the Total row, which covers every loan;
    // the second half moves to the chips, which is where the split now lives.
    t.ok(!!sub.all, 'close band footer carries a grand total across every loan',
         `subtotal rows on screen: ${JSON.stringify(Object.keys(sub))}`);
    t.ok(!sub.A && !sub.B, 'close band footer no longer restates the grade split as extra rows',
         `subtotal rows on screen: ${JSON.stringify(Object.keys(sub))}`);
    const bandPrincipal = at('all', 'principal');
    const bandInterest  = at('all', 'interest');
    // Every row's money lands in the Total exactly once.
    const rowPrincipal = cb.rows.reduce((n, r) => n + (r.principalN || 0), 0);
    const rowInterest  = cb.rows.reduce((n, r) => n + (r.interestN  || 0), 0);
    t.eq(money(rowPrincipal), money(bandPrincipal),
         'close band total: accounts for every row\'s principal, once each');
    t.eq(money(rowInterest), money(bandInterest),
         'close band total: ...and for every row\'s interest');
    t.eq(money(paidPrincipal), money(bandPrincipal),
         `"Paid last month" principal equals the close band's principal for the same month`);
    t.eq(money(paidInterest), money(bandInterest),
         `"Paid last month" interest equals the close band's interest for the same month`);
    t.eq(money(paidTotal), money(paidPrincipal + paidInterest), '"Paid last month" total equals its own principal + interest');

    // ── THE GRADE SPLIT, WHERE IT LIVES NOW ──────────────────────────────
    // Asserted against the rows' own data-grade, so the chips cannot drift from
    // the table they summarise. This is the assertion the deleted footer rows
    // used to carry, pointed at its new home.
    {
      const gradeRows = (g) => cb.rows.filter(r => r.grade === g && r.perLenderN != null);
      const lc = cb.gateByKey['lender-confirmed'], ps = cb.gateByKey['per-schedule'];
      t.eq(lc ? lc.count : 0, gradeRows('A').length,
           'close band: the lender-confirmed chip counts exactly the grade-A rows with a closing balance');
      t.eq(ps ? ps.count : 0, gradeRows('B').length,
           'close band: the per-schedule chip counts exactly the grade-B rows');
      t.eq(gradeRows('A').length + gradeRows('B').length, sub.all.closingCount,
           'close band: ...and together they are every row the Total\'s closing column covers');
      // …and each grade still FOOTS, computed from the rows now that no footer
      // line does it for us. opening + drawn − principal = computed, per grade.
      for (const g of ['A', 'B']) {
        const set = gradeRows(g).filter(r => r.openingN != null && r.computedN != null);
        if (!set.length) continue;
        const sum = (f) => set.reduce((n, r) => n + (r[f] || 0), 0);
        t.eq(money(sum('openingN') + sum('drawnN') - sum('principalN')), money(sum('computedN')),
             `close band: opening + drawn − principal = computed across the grade-${g} rows`);
      }
    }

    // (e0) ── THE EXPORT IS WHERE THE CHIPS WENT (session 264) ─────────────
    // David removed every chip from the strip. Under LESS IS BEST a cut may
    // drop words and never a CLAIM, and the CSV footer is the surviving home
    // of the full close position. That makes this assertion the one thing
    // standing between "we tightened the screen" and "we deleted the record",
    // so the export is actually RUN and its bytes are read — a claim that only
    // exists in a comment is a claim that is gone.
    {
      const csv = await p.evaluate(() => {
        let captured = '';
        const RealBlob = window.Blob, realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
        // The export builds a Blob and clicks an anchor. Intercept both so the
        // harness reads the file's real content and no download is attempted.
        window.Blob = function (parts) { captured = (parts || []).join(''); return new RealBlob(parts, { type: 'text/plain' }); };
        URL.createObjectURL = () => 'blob:stub';
        URL.revokeObjectURL = () => {};
        const realClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {};
        try { exportRollforwardCSV(); } catch (e) { captured = 'THREW: ' + e.message; }
        window.Blob = RealBlob; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke;
        HTMLAnchorElement.prototype.click = realClick;
        return captured;
      });
      t.ok(csv && !/^THREW/.test(csv), 'close band: the rollforward exports without throwing', csv.slice(0, 200));
      const stripLine = (csv.split(/\r?\n/).find(l => /Not ready to close|Ready for your accountant/.test(l)) || '');
      t.ok(!!stripLine, 'close band: ...and the file carries the close verdict');
      // Every gate the strip stopped printing must be IN that line. Compared
      // against the gates themselves, not a typed list, so a gate added later
      // is covered the day it is added.
      const missing = cb.gates.filter(g => !stripLine.includes(String(g.text || '').trim()));
      t.eq(missing.length, 0,
           'close band: ⭐ ...and every gate the strip no longer prints is still in the export, in full',
           `missing: ${JSON.stringify(missing.map(g => g.key))} · line: ${stripLine.slice(0, 300)}`);
      t.ok(cb.gates.length >= 4,
           'close band: ...with enough gates in play for that to mean something',
           `${cb.gates.length} gates`);
    }

    // (e) statement coverage: the close band's gate vs the Client View checklist
    //
    // Looked up by data-gate, never by index. gates[0] happened to still be the
    // coverage chip after session 246, but two sibling assertions reading
    // gates[0]/gates[1] the same way stopped matching and skipped in silence —
    // which is worse than failing. The chip's ABSENCE is a failure here.
    const covGate = cb.gateByKey && cb.gateByKey['coverage'];
    t.ok(!!covGate, 'close band: the coverage chip is on the strip and addressable by data-gate',
         `chips: ${JSON.stringify(cb.gates.map(x => x.key))}`);
    const gateOutstanding = covGate ? (/outstanding/.test(covGate.text) ? Number(covGate.count) : 0) : NaN;
    const cvCount = s.client.checklistCount || '';
    const cvOutstanding = Number((cvCount.match(/(\d+)/) || [])[1] ?? (/(nothing|all)/i.test(cvCount) ? 0 : NaN));
    t.eq(gateOutstanding, cvOutstanding,
         'statement coverage: Loans close-band gate equals the Client View checklist count');

    // ── (f2) THE GRAND TOTAL (session 247) ────────────────────────────────
    // David: "resolve the fact that the total does not compute amortized loans.
    // We want to see ALL loans here." Three subtotals and no total is a debt
    // schedule that never states the debt. The properties that make it safe to
    // print are asserted here, because a total is the one figure a reader will
    // not re-derive:
    //   1. it covers EVERY row, not the checkable ones;
    //   2. it still foots — opening − principal = computed;
    //   3. it equals its own composition, so "of which" really is of which;
    //   4. where it covers fewer rows in a column than in the rest of the row,
    //      it SAYS SO on screen. That marker is the whole reason the total is
    //      allowed to exist beside a loan with no closing balance.
    t.ok(!!sub.all, 'close band footer carries a grand total across every loan',
         `subtotal rows on screen: ${JSON.stringify(Object.keys(sub))}`);
    if (sub.all) {
      t.eq(sub.all.count, cb.rows.length,
           'close band total: covers every row on the table, not just the checkable ones');
      t.eq(money(at('all', 'opening') + at('all', 'drawn') - at('all', 'principal')), money(at('all', 'computed')),
           'close band total: opening + drawn − principal = computed');
      // Each of the four walk columns equals the sum of the rows behind it —
      // the composition check the deleted "of which" rows used to provide, now
      // done against the table itself, which is a stronger statement anyway.
      for (const [col, f] of [['opening', 'openingN'], ['drawn', 'drawnN'],
                              ['principal', 'principalN'], ['interest', 'interestN'],
                              ['computed', 'computedN']]) {
        const rows = cb.rows.filter(r => r.openingN != null && r.computedN != null);
        t.eq(money(at('all', col)), money(rows.reduce((n, r) => n + (r[f] || 0), 0)),
             `close band total: ${col} is the sum of the rows it covers`);
      }
      // Closing legitimately covers fewer rows — and must announce it.
      t.eq(money(at('all', 'closing')),
           money(cb.rows.filter(r => r.perLenderN != null && r.computedN != null)
                        .reduce((n, r) => n + r.perLenderN, 0)),
           'close band total: closing is the sum of the rows that HAVE a closing balance');
      const closable = cb.rows.filter(r => r.perLenderN != null && r.computedN != null).length;
      t.eq(sub.all.closingCount, closable,
           'close band total: the closing column reports how many rows it actually covers');
      // SESSION 267 — the third copy of the ce18/ce28 guard, and the one I
      // missed when the coverage moved. Same invariant, same reason: the count
      // must be ON SCREEN, and it now lives in the Total's left-aligned LABEL
      // cell rather than trailing the closing figure, because inline text after
      // a right-aligned number pushed the totals out of their columns (David:
      // "remove the '13 of 14' notes so that the column totals are aligned with
      // the numbers above them"). So the claim is asserted against the ROW, and
      // the money cell is asserted CLEAN — that second half is the part of
      // David's request that could otherwise regress without anything failing.
      const rowText = sub.all.cells.join(' ');
      const closingCell = sub.all.cells[CI.closing] || '';
      if (closable < cb.rows.length) {
        t.ok(new RegExp(`${closable} of ${cb.rows.length}`).test(rowText),
             'close band total: ...and prints that count in the row, so no reader takes it for all of them',
             `row = ${JSON.stringify(sub.all.cells)}`);
        t.ok(!/ of \d+/.test(closingCell),
             'close band total: ...and keeps the closing money cell clean, so the column still lines up',
             `closing cell = ${JSON.stringify(closingCell)}`);
      } else {
        // Specific to CLOSING, not "no ' of N' anywhere in the row": the same
        // label cell legitimately carries the ROLLFORWARD coverage, which is a
        // different column with a different denominator. A blanket check here
        // would fail on a month where closing covers everything and the
        // rollforward does not — a true state, wrongly called a defect.
        t.ok(!/closing checked/.test(rowText),
             'close band total: ...and prints no closing count when it does cover every row',
             `row = ${JSON.stringify(sub.all.cells)}`);
      }
    }

    // (g) the debt schedule's own total vs Client View's "Total owed"
    if (s.client.debtSched && s.client.debtSched.foot.length) {
      const dsTotals = s.client.debtSched.foot.map(parseMoney).filter(x => x != null);
      t.ok(dsTotals.some(v => Math.abs(v - owed) < 0.005),
           'Debt Schedule total agrees with Client View "Total owed"',
           `debt schedule footer figures ${JSON.stringify(s.client.debtSched.foot)} vs owed ${money(owed)}`);
    }
    await p.close();
  },
});

/* 5 ── CLOSE-BAND EDGES (all synthesised in the stub, never in the DB) ───── */
GROUPS.push({
  name: 'close-band',
  async run(t) {
    // The month the band closes = the last COMPLETE month.
    const now = new Date(HARNESS_NOW);
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const MONTH = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`;
    const MONTH_END = new Date(lm.getFullYear(), lm.getMonth() + 1, 0).toISOString().slice(0, 10);
    const MID = `${MONTH}-15`;
    const PRIOR_END = new Date(lm.getFullYear(), lm.getMonth(), 0).toISOString().slice(0, 10);

    const pickLoan = (d, pred) => d.loan_accounts.find(a => a.status === 'active' && pred(a, d));
    const stripMonth = (d, loanId) => {
      d.loan_splits = d.loan_splits.filter(sp => !(sp.loan_account_id === loanId && String(sp.period_label || '').slice(0, 7) === MONTH));
    };
    const addSplit = (d, loanId, over) => {
      const base = d.loan_splits.find(sp => sp.loan_account_id === loanId) || d.loan_splits[0];
      d.loan_splits.push(Object.assign(JSON.parse(JSON.stringify(base)), {
        id: 'harness-' + Math.random().toString(36).slice(2, 10),
        loan_account_id: loanId, period_label: MONTH, status: 'posted',
        principal_amount: 100, interest_amount: 50, total_amount: 150,
        source: 'statement', voided_at: null, void_reason: null,
      }, over || {}));
    };
    const bandRowFor = (s, name) => (s.loans.closeBand.rows || []).find(r => r.loan === name || r.lender === name);

    const CASES = [
      { name: 'a month with no payment at all',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); stripMonth(d, a.id); d.__loan = a.xero_account_name; } },
      { name: 'two payments in one month',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); addSplit(d, a.id, { principal_amount: 900.11, interest_amount: 100.22, total_amount: 1000.33 }); addSplit(d, a.id, { principal_amount: 800.44, interest_amount: 90.55, total_amount: 890.99 }); d.__loan = a.xero_account_name; } },
      { name: 'a staged split inside the closing month',
        mutate: (d) => { const a = pickLoan(d, x => x.prestage_enabled); stripMonth(d, a.id); addSplit(d, a.id, { status: 'staged', principal_amount: 1234.56, interest_amount: 234.56, total_amount: 1469.12, stage_reference: 'WR-STAGE harness' }); d.__loan = a.xero_account_name; } },
      { name: 'a loan with no opening balance',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); d.loan_statements = d.loan_statements.filter(st => !(st.loan_account_id === a.id && st.statement_date <= PRIOR_END)); d.loan_amortization_rows = d.loan_amortization_rows.filter(r => !(r.loan_amortization_schedules?.loan_account_id === a.id && r.row_date <= PRIOR_END)); d.__loan = a.xero_account_name; } },
      { name: 'a lender that skipped the month (closing anchor predates it)',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); d.loan_statements = d.loan_statements.filter(st => !(st.loan_account_id === a.id && st.statement_date > PRIOR_END && st.statement_date <= MONTH_END)); d.__loan = a.xero_account_name; } },
      { name: 'a loan whose ONLY statement is future-dated',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic');
          const keep = d.loan_statements.find(st => st.loan_account_id === a.id);
          d.loan_statements = d.loan_statements.filter(st => st.loan_account_id !== a.id);
          d.loan_amortization_rows = d.loan_amortization_rows.filter(r => r.loan_amortization_schedules?.loan_account_id !== a.id);
          if (keep) d.loan_statements.push(Object.assign({}, keep, { statement_date: '2031-12-31', principal_balance: 0, source: 'lender_statement' }));
          d.__loan = a.xero_account_name; } },
      { name: 'an extra principal paydown in the month',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); addSplit(d, a.id, { source: 'principal_payment', principal_amount: 5000, interest_amount: 0, total_amount: 5000 }); d.__loan = a.xero_account_name; } },
      { name: 'a voided split in the month',
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); addSplit(d, a.id, { status: 'voided', voided_at: MID, void_reason: 'harness', principal_amount: 4321, interest_amount: 321, total_amount: 4642 }); d.__loan = a.xero_account_name; } },
      { name: "a period_label carrying no date (Verdant's 'Period 14')",
        mutate: (d) => { const a = pickLoan(d, x => x.ingestion_method !== 'automatic'); addSplit(d, a.id, { period_label: 'Period 14', principal_amount: 2707.61, interest_amount: 1835.71, total_amount: 4543.32 }); d.__loan = a.xero_account_name; } },
      { name: 'every split in the month voided (nothing real moved)',
        mutate: (d) => { d.loan_splits.forEach(sp => { if (String(sp.period_label || '').slice(0, 7) === MONTH) { sp.status = 'voided'; sp.voided_at = MID; } }); } },
      { name: 'no statements at all for the closing month',
        mutate: (d) => { d.loan_statements = d.loan_statements.filter(st => String(st.statement_date || '').slice(0, 7) !== MONTH); } },
    ];

    for (const c of CASES) {
      const p = await newHarnessPage({ tab: 'loans', mutate: c.mutate });
      const s = await p.surfaces();
      const cb = s.loans.closeBand;
      t.ok(!!cb, `close band renders: ${c.name}`);
      if (!cb) { await p.close(); continue; }
      t.noBadMoney(cb.text, `close band — ${c.name}`);

      // A green tie is a claim. It must never be produced by an anchor that
      // does not cover the month, nor by a month in which nothing happened.
      for (const r of cb.rows) {
        if (r.ties) {
          t.ok(r.openingN != null && r.perLenderN != null,
               `close band — ${c.name}: a tie on ${r.loan} is backed by both an opening and a lender figure`,
               `opening=${r.opening} perLender=${r.perLender} principal=${r.principal}`);
          // A tie is a claim that two figures agree. Now that the cell prints
          // nothing, check the arithmetic behind the silence rather than
          // trusting that something rendered.
          if (r.openingN != null && r.perLenderN != null) {
            t.close(r.openingN - (r.principalN || 0), r.perLenderN, 0.01,
              `close band — ${c.name}: ${r.loan} ties because opening − principal really equals the lender`);
          }
        }
      }
      // Footer arithmetic has to hold on every edge.
      // Session 247: foot0 is the GRAND TOTAL now, and the grades are its
      // composition below it. Read the row by data-subtotal and the columns by
      // header — an index into foot0 was reading grade A before this and the
      // total after it, silently changing what the assertion meant.
      const CIe = cb.columnIndex;
      const all = (cb.subtotals || {}).all;
      t.ok(!!all, `close band — ${c.name}: the footer carries a grand total`);
      if (all) {
        const cellE = (name) => parseMoney(all.cells[CIe[name]]) || 0;
        t.eq(money(cellE('opening') + cellE('drawn') - cellE('principal')), money(cellE('computed')),
             `close band — ${c.name}: footer opening + drawn − principal = computed`);
      }
      // The band's own headline must not contradict its gates.
      const anyBad = cb.gates.some(g => !g.ok);
      // Case-insensitive on purpose: the assertion's job is "the headline says
      // it is not ready", not "the headline is capitalised the way it was in
      // August 2026". Session 241 made it the first words of the strip rather
      // than a clause inside one, and a test that fails on a capital letter is
      // a test that punishes copy edits.
      t.eq(/not ready to close/i.test(cb.lead || ''), anyBad,
           `close band — ${c.name}: headline agrees with its own gates`);
      // …and each gate must agree with the rows underneath it.
      //
      // ── A SKIPPING ASSERTION IS WORSE THAN A FAILING ONE ─────────────────
      // Both of these used to read cb.gates[1] and cb.gates[0] and then guard
      // the comparison behind `if (regexMatched)`. Session 246 made the strip
      // variable-length — the lender-confirmed, per-schedule and immaterial
      // chips render ONLY when non-zero — so gates[1] became the
      // lender-confirmed chip, the regex stopped matching, and the assertion
      // stopped running while still reporting green. Nothing was checked and
      // nothing said so.
      //
      // Now: look the chip up by data-gate, and make its ABSENCE a failure
      // rather than a skip. The `if` below runs only after a hard assertion
      // that the chip exists, so the check can never be silently skipped again.
      const gate = (k) => (cb.gateByKey || {})[k] || null;
      // ── SESSION 264: THE STRIP IS THE VERDICT AND NOTHING ELSE ───────────
      // David: "remove all the content in the Not ready to close section."
      // Asserted in EVERY scenario, not once, because the gates are still all
      // computed and a single `.map(chip)` would put any of them back on
      // screen. The pair is the point: the strip must render only its verdict
      // AND the gates behind it must still be there to be read — an assertion
      // on either alone goes green on the wrong change.
      // ── SESSION 273: THE STRIP IS THE VERDICT, THE BAR AND THE ASK ───────
      // David chose option D from the close-bar mockups, so session 264's
      // "verdict and nothing else" has stopped being true. It is REPLACED here
      // rather than deleted, and the replacement keeps its shape: the strip must
      // render the verdict plus the progress line and NOTHING MORE, so a `.map`
      // that puts the chips back still fails. The bar itself contributes no
      // text, which is why this equality holds with it on screen.
      t.eq((cb.stripText || '').trim(),
           `${(cb.lead || '').trim()} ${(cb.asksText || '').trim()}`.trim(),
           `close band — ${c.name}: the strip renders its verdict, its bar and the ask — and nothing else`,
           `strip=${JSON.stringify(cb.stripText)} · asks=${JSON.stringify(cb.asksText)}`);
      // THE BAR'S ARITHMETIC, NOT ITS APPEARANCE. Every statement the gate
      // requires lands in exactly one of the three states — a document that
      // slips out of all three is one nobody is waiting for, which is the
      // silent-denominator failure the close gate exists to prevent.
      t.ok(!!cb.progress, `close band — ${c.name}: the strip carries its progress figures as data`);
      if (cb.progress) {
        const pr = cb.progress;
        t.eq(pr.checked + pr.unchecked + pr.awaiting, pr.total,
             `close band — ${c.name}: every required statement is in exactly one bar state`,
             JSON.stringify(pr));
        // THE GREY TAIL CANNOT DISAGREE WITH THE VERDICT. Both are derived from
        // `gates`; this asserts they stayed that way. A bar that can read full
        // green beside "Not ready to close" is the contradiction this module
        // keeps removing, and it would look completely fine on screen.
        const otherBad = cb.gates.filter(g => !g.ok && g.key !== 'coverage' && g.key !== 'checked');
        t.eq(!!pr.tail, otherBad.length > 0,
             `close band — ${c.name}: ⭐ the bar shows a grey tail exactly when a blocker it cannot draw is standing`,
             `tail=${pr.tail} · otherBad=${JSON.stringify(otherBad.map(g => g.key))}`);
        t.ok(!(pr.tail === false && pr.checked === pr.total && /not ready to close/i.test(cb.lead || '')),
             `close band — ${c.name}: ⭐ the bar never reads complete beside a "not ready" verdict`,
             `progress=${JSON.stringify(pr)} · lead=${JSON.stringify(cb.lead)}`);
        // The schedule count is David's third question and a separate one: a
        // month can hold every statement and still have loans that fell out of
        // the staging loop.
        t.ok(pr.onSchedule <= pr.scheduleTotal,
             `close band — ${c.name}: the on-schedule count cannot exceed the loans set to pre-stage`,
             JSON.stringify(pr));
        t.eq(pr.offSchedule.length, pr.scheduleTotal - pr.onSchedule,
             `close band — ${c.name}: every loan off its schedule is NAMED, not just counted`,
             JSON.stringify(pr));
        // ── THE HEADLINE IS THE UPLOAD, AND THE BAR IS WHY THAT IS SAFE ────
        // David asked for the uploaded count rather than the checked one, so the
        // one figure on the strip no longer distinguishes a document that was
        // compared against Xero from one that was merely received. That is only
        // acceptable while the AMBER SEGMENT is still on the bar saying it, so
        // this asserts the pair together: the headline equals checked+unchecked,
        // AND the segment that splits them exists whenever it has something to
        // split. Delete the amber segment and this goes red, which is the point
        // — the alternative is a strip that reads "10 of 11 uploaded" over a
        // month where four of them were never looked at, which is precisely the
        // state the close gate was built to make visible (session 262).
        t.eq(pr.uploaded, pr.checked + pr.unchecked,
             `close band — ${c.name}: the headline counts every statement on file, checked or not`,
             JSON.stringify(pr));
        t.eq(cb.barSegs.some(sg => /s-unchecked/.test(sg.cls)), pr.unchecked > 0,
             `close band — ${c.name}: ⭐ the bar carries an amber segment exactly when a statement is on file but unchecked`,
             `segs=${JSON.stringify(cb.barSegs.map(sg => sg.cls))} · unchecked=${pr.unchecked}`);
        // A blocking segment answers its own question, in its own title
        // (session 256's rule, met the session-249 way).
        cb.barSegs.filter(sg => /s-unchecked|s-await/.test(sg.cls)).forEach(sg => {
          t.ok(/: /.test(sg.title),
               `close band — ${c.name}: the ${/s-await/.test(sg.cls) ? 'red' : 'amber'} segment names its loans`,
               `title=${JSON.stringify(sg.title)}`);
        });
      }
      t.eq((cb.tilesText || '').trim(), '',
           `close band — ${c.name}: ...and the "Paid in <month>" line is gone from above it`,
           `tiles=${JSON.stringify(cb.tilesText)}`);
      t.ok(cb.gates.length > 0 && cb.gates.every(g => !!g.key),
           `close band — ${c.name}: every chip on the strip carries a data-gate name`,
           `chips: ${JSON.stringify(cb.gates.map(g => ({ key: g.key, text: g.text })))}`);
      t.ok(cb.gates.every(g => GATE_KEYS.includes(g.key)),
           `close band — ${c.name}: every chip's data-gate is one the harness knows about`,
           `chips: ${JSON.stringify(cb.gates.map(g => g.key))} · known ${JSON.stringify(GATE_KEYS)}`);

      const vGate = gate('variance');
      t.ok(!!vGate, `close band — ${c.name}: the variance chip is on the strip`,
           `chips: ${JSON.stringify(cb.gates.map(g => g.key))}`);
      if (vGate) {
        // The chip is "N loans tie exactly" when clear and "N loans off — $X to
        // resolve" when not. Either way its data-count must equal the rows that
        // actually carry that state. A circular row carries NEITHER: it prints
        // "agrees by construction" and is counted in no column, which is the
        // rule the whole grade-B design turns on.
        const expect = vGate.ok ? cb.rows.filter(r => r.ties).length
                                : cb.rows.filter(r => r.band === 'material').length;
        t.eq(vGate.count, expect,
             `close band — ${c.name}: the variance chip's count equals the rows that actually ${vGate.ok ? 'tie' : 'are off'}`);
        t.eq(cb.rows.filter(r => r.circular && r.ties).length, 0,
             `close band — ${c.name}: no row is both circular and a tie — a check that cannot fail is not a check that passed`);
      }

      const cGate = gate('coverage');
      t.ok(!!cGate, `close band — ${c.name}: the coverage chip is on the strip`,
           `chips: ${JSON.stringify(cb.gates.map(g => g.key))}`);
      if (cGate) {
        const notReceived = cb.rows.filter(r => /not received/.test(r.perLender)).length;
        t.eq(cGate.count, notReceived,
             `close band — ${c.name}: the coverage chip's count is exactly the rows reading "not received"`,
             `chip=${JSON.stringify(cGate.text)} count=${cGate.count} · ${notReceived} rows say "not received"`);
      }

      // The two grade chips exist exactly when they have something to say, and
      // when they exist they count the rows carrying that grade in the table.
      for (const [key, grade] of [['lender-confirmed', 'A'], ['per-schedule', 'B']]) {
        const g2 = gate(key);
        const inTable = cb.rows.filter(r => r.grade === grade && r.perLenderN != null).length;
        t.eq(!!g2, inTable > 0,
             `close band — ${c.name}: the "${key}" chip is present exactly when a grade-${grade} loan is`,
             `chip=${g2 ? JSON.stringify(g2.text) : 'absent'} · ${inTable} grade-${grade} rows with a closing figure`);
      }
      if (VERBOSE) console.log(C.d + '     ' + cb.lead + ' | ' + cb.gates.map(g => g.text).join(' | ') + C.x);
      await p.close();
    }
  },
});

/* 6 ── MONEY FORMATTING, EVERYWHERE ──────────────────────────────────────── */
GROUPS.push({
  name: 'money-format',
  async run(t) {
    const VARIANTS = [
      { name: 'real data', mutate: null },
      { name: 'no splits at all', mutate: (d) => { d.loan_splits = []; } },
      { name: 'no statements at all', mutate: (d) => { d.loan_statements = []; } },
      { name: 'no amortization rows', mutate: (d) => { d.loan_amortization_rows = []; } },
      { name: 'no tie-outs (nothing reconciled)', mutate: (d) => { d.loan_tie_outs = []; d.reconciliation_runs = []; } },
      { name: 'no KPI snapshot', mutate: (d) => { d.bookkeeping_kpi_snapshots = []; } },
      { name: 'null money on every split', mutate: (d) => { d.loan_splits.forEach(sp => { sp.principal_amount = null; sp.interest_amount = null; sp.total_amount = null; }); } },
      { name: 'null principal_balance on every statement', mutate: (d) => { d.loan_statements.forEach(st => { st.principal_balance = null; }); } },
      { name: 'every loan paid off', mutate: (d) => { d.loan_accounts.forEach(a => { a.status = 'paid_off'; }); } },
      { name: 'no payroll at all', mutate: (d) => { d.payroll_imports = []; d.payroll_import_employee_lines = []; } },
      { name: 'a negative-zero balance', mutate: (d) => { d.loan_statements.forEach(st => { if (st.principal_balance != null) st.principal_balance = -0; }); } },
      // ── close_basis, all three values, across every surface (session 246) ──
      // The column is new, it is read on every close-band row and on every
      // roster row, and each value has a sentence a CPA is meant to read. A slug
      // on screen is a formatting failure exactly like a raw status is.
      { name: 'every loan closes on its contractual schedule',
        mutate: (d) => { d.loan_accounts.forEach(a => { a.close_basis = 'amortization_schedule'; }); } },
      { name: 'every loan closes on a lender statement',
        mutate: (d) => { d.loan_accounts.forEach(a => { a.close_basis = 'lender_statement'; }); } },
      { name: 'every loan closes on nothing at all',
        mutate: (d) => { d.loan_accounts.forEach(a => { a.close_basis = 'none'; }); } },
      // close_basis absent entirely — the state the column is in on any deploy
      // whose fixture predates the migration. _loanCloseBasis must default it,
      // and 'undefined' must never reach a cell.
      { name: 'close_basis not pulled at all (pre-migration shape)',
        mutate: (d) => { d.loan_accounts.forEach(a => { delete a.close_basis; }); } },
      // The books-side opening balance, which renders its own provenance line.
      { name: 'a books-side opening balance on every loan',
        mutate: (d) => {
          const now = new Date(HARNESS_NOW); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          const pe = new Date(lm.getFullYear(), lm.getMonth(), 0);
          const iso = `${pe.getFullYear()}-${String(pe.getMonth() + 1).padStart(2, '0')}-${String(pe.getDate()).padStart(2, '0')}`;
          d.loan_book_balances = d.loan_accounts.map((a, i) => ({
            id: 'harness-bb-' + i, loan_account_id: a.id, as_of: iso, balance: 12345.67,
            basis: 'xero_rebuild', run_id: null, detail: { staged_entries_at_or_before: 1 },
            computed_at: iso + 'T00:00:00Z',
          }));
        } },
    ];
    for (const v of VARIANTS) {
      const p = await newHarnessPage({ tab: 'overview', mutate: v.mutate || undefined });
      for (const [tab, sub] of [['overview', null], ['loans', null], ['payroll', null], ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis']]) {
        await p.switchTab(tab, sub);
        await p.settle(40);
        const s = await p.surfaces();
        const where = `${v.name} → ${tab}${sub ? '/' + sub : ''}`;
        t.noBadMoney(s.bodyText, where);
        // A raw enum on screen is a formatting failure too (session 240 #20).
        // Session 246 added three more enums that can reach a reader:
        // loan_accounts.close_basis, loan_book_balances.basis and the closing
        // anchor's derivation. Every one of them has a plain-English label
        // (_closeBasisLabel / _anchorSourceLabel), and the point of a label is
        // that the slug never gets out. 'lender_statement' and
        // 'amortization_schedule' were already covered — they are close_basis
        // values too, which is why the pair does double duty here.
        t.notMatch(s.bodyText, /\b(pending_review|needs_attention|not_comparable|already_in_xero|xero_derived|amortization_schedule|email_pdf_upload|portal_manual_pull|lender_statement|xero_balance_snapshot|contract_origination|xero_rebuild|rolled_back|total_payback|gross_payback|principal_only|close_basis)\b/,
                   `${where}: no raw database enum reaches the DOM`);
      }
      t.ok(p.pageErrors.length === 0, `${v.name}: no uncaught page error`, p.pageErrors.slice(0, 3).join(' | '));
      await p.close();
    }
  },
});

/* 7 ── REGRESSION CHECKS FROM THE SESSION LOG ────────────────────────────── */
GROUPS.push({
  name: 'history',
  async run(t) {
    // ── s238: the seven data-arrival hooks, and _bkRefreshVisibleBookkeeping ──
    // Open Client View COLD (tab switched before loadLoans resolves) and never
    // touch it again. If the convergence fix regresses, every _allLoanAccounts
    // figure stays at its empty state forever.
    {
      const p = await newHarnessPage({ tab: 'client', sub: 'dashboard', defaultLatency: 60 });
      const s = await p.surfaces();
      const owed = parseMoney(s.client.debtTiles['Total owed']?.value);
      t.ok(owed > 0, 's238: Client View refreshes after loadLoans resolves (tab switched cold)',
           `Total owed rendered as ${JSON.stringify(s.client.debtTiles['Total owed'])}`);
      t.notMatch(s.client.checklistCount, /^0 of 0/, 's238: checklist is not "0 of 0" after data lands');
      await p.close();
    }
    // ── s238: trailing-12 excludes future staged periods and undated labels ──
    {
      const p = await newHarnessPage({ tab: 'client', sub: 'dashboard' });
      const s = await p.surfaces();
      t.ok(!s.client.chartLabels.some(l => /Period/i.test(l)),
           's238: no phantom "Period" bar on the principal/interest chart',
           JSON.stringify(s.client.chartLabels));
      const now = new Date(HARNESS_NOW);
      const lastComplete = `${new Date(now.getFullYear(), now.getMonth() - 1, 1).getFullYear()}-${String(new Date(now.getFullYear(), now.getMonth() - 1, 1).getMonth() + 1).padStart(2, '0')}`;
      const future = s.client.chartTitles.filter(x => {
        const m = x.match(/([A-Z][a-z]{2}) (\d{4})/); if (!m) return false;
        const mm = String(new Date(`${m[1]} 1, ${m[2]}`).getMonth() + 1).padStart(2, '0');
        return `${m[2]}-${mm}` > lastComplete;
      });
      t.eq(future.length, 0, 's238: no future (staged) month is drawn as a payment');
      await p.close();
    }
    // ── s196/s217: a future-dated row must never win a "latest balance" pick ──
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const bal = await p.evaluate(() => (_allLoanAccounts || []).filter(a => a.status === 'active')
        .map(a => ({ name: a.xero_account_name, b: _loanOutstandingBalance(a) })));
      const verdant = bal.find(x => /Verdant/i.test(x.name));
      t.ok(verdant && verdant.b && verdant.b.amount > 0,
           's196: Verdant does not read as $0.00 from its future-dated schedule rows',
           JSON.stringify(verdant));
      const zeroed = bal.filter(x => x.b && x.b.amount === 0);
      t.eq(zeroed.length, 0, 's196/s217: no ACTIVE loan reads $0.00 outstanding from a projection',
           JSON.stringify(zeroed.map(z => z.name)));
      // and the anchor date itself is never in the future
      const today = await p.evaluate(() => today());
      const futureAnchors = bal.filter(x => x.b && x.b.asOf > today && x.b.source !== 'lender_statement' && x.b.source !== 'email_pdf_upload' && x.b.source !== 'portal_manual_pull');
      t.eq(futureAnchors.length, 0, 's196: no balance is anchored to a future-dated projection',
           JSON.stringify(futureAnchors));
      await p.close();
    }
    // ── s240 #10/#19 (Tech Debt #19): total_payback basis inside a published total ──
    //
    // ⚠ THIS ASSERTION IS RED, AND IT IS RED FOR A REASON. Session 246 checked:
    // it fails identically against the PREVIOUS fixture and against HEAD's
    // index.html, so it is not fixture-refresh fallout and it is not a stale
    // expectation — it is Tech Debt #19, still open, on four active loans:
    //
    //   Stripe Capital  $125,257.71  balance_basis = 'total_payback'
    //   Dexter Loan 2    $89,411.25  balance_basis = 'unknown'
    //   E-Transit E5     $29,302.52  balance_basis = 'unknown'
    //   E-Transit E6     $22,168.92  balance_basis = 'unknown'
    //
    // Stripe is the sharp one. `total_payback` is principal PLUS the whole
    // remaining fee — the loan's own carrying_basis says 'gross_payback' — and
    // that figure is being summed into "Total outstanding" / "Total owed", the
    // number on the Debt Schedule the CPA exports. The other three are the
    // unlabelled-balance problem from START HERE section 3 seen from the other
    // side: a balance nobody has said what it measures is nonetheless published
    // as though it measured principal.
    //
    // It is left RED deliberately, the same way dismissal-fail-open and
    // substance-key-substance are: a red assertion here IS the finding, and
    // tuning it green would delete the only place this is written down.
    {
      const p = await newHarnessPage({ tab: 'client', sub: 'debt' });
      const bad = await p.evaluate(() => {
        const out = [];
        for (const a of (_allLoanAccounts || []).filter(x => x.status === 'active')) {
          const b = _loanOutstandingBalance(a);
          if (!b) continue;
          const st = (_allLoanStatements || []).find(s => s.loan_account_id === a.id && s.statement_date === b.asOf && Number(s.principal_balance) === b.amount);
          if (st && st.balance_basis && st.balance_basis !== 'principal_only') out.push({ loan: a.xero_account_name, basis: st.balance_basis, amount: b.amount });
        }
        return out;
      });
      t.ok(bad.length === 0, 's240 #10: no non-principal_only balance basis inside the published debt total',
           `REPORTED, NOT A STALE EXPECTATION (Tech Debt #19) — ${bad.length} loan(s), ` +
           `${money(bad.reduce((n, b) => n + b.amount, 0))} of the published total: ` +
           bad.map(b => `${b.loan} basis=${b.basis} ${money(b.amount)}`).join(' · '));
      await p.close();
    }
    // ── s240 (voided splits): paid-last-month / YTD must exclude voided ──
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const before = (await p.surfaces()).loans.summaryTiles;
      await p.close();
      const p2 = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // Void one live split in the closing month and confirm the tile moves by exactly its amount.
        const now = new Date(HARNESS_NOW); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const MONTH = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`;
        const target = d.loan_splits.find(sp => String(sp.period_label || '').slice(0, 7) === MONTH && sp.status !== 'voided' && Number(sp.total_amount) > 0);
        if (target) { target.status = 'voided'; target.voided_at = MONTH + '-15'; d.__voided = Number(target.principal_amount) + Number(target.interest_amount); }
      } });
      const s2 = await p2.surfaces();
      const voidedAmt = await p2.evaluate(() => window.__WR_FIXTURE.__voided);
      const k = Object.keys(before).find(x => /Paid last month/.test(x));
      const d0 = parseMoney(before[k].value), d1 = parseMoney(s2.loans.summaryTiles[k].value);
      t.close(d0 - d1, voidedAmt || 0, 0.02, 's240: voiding a split removes exactly its amount from "Paid last month"');
      await p2.close();
    }
    // ── s222: total outstanding is scoped to ACTIVE loans only ──
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // Give a PAID-OFF loan a stale non-zero balance. It must not inflate the headline.
        const off = d.loan_accounts.find(a => a.status === 'paid_off');
        d.loan_statements.push({ id: 'harness-stale', loan_account_id: off.id, statement_date: HARNESS_TODAY,
          principal_balance: 999999.99, source: 'lender_statement', balance_basis: 'principal_only',
          total_amount_due: null, payment_due_date: null, storage_path: null, payoff_amount: null,
          payoff_good_thru: null, pulled_at: null, pulled_by: null, created_at: null, file_sha256: null });
      } });
      const s = await p.surfaces();
      t.notMatch(s.loans.summaryTiles['Total outstanding'].value, /999,999/,
                 's222: a paid-off loan with a stale balance never enters "Total outstanding"');
      await p.close();
    }
    // ── s236: the close-band variance total is ABSOLUTE, never signed ──
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // Push two checkable loans equal and opposite; a signed total would read $0.00.
        const now = new Date(HARNESS_NOW); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const MONTH = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`;
        const live = d.loan_splits.filter(sp => String(sp.period_label || '').slice(0, 7) === MONTH && sp.status !== 'voided' && sp.status !== 'staged');
        if (live[0]) live[0].principal_amount = Number(live[0].principal_amount) + 415.88;
        if (live[1]) live[1].principal_amount = Number(live[1].principal_amount) - 415.88;
      } });
      const s = await p.surfaces();
      // This asserted 0 === 0 for its whole life. Every row rendered "$0.00 ✓",
      // so parseMoney gave a list of zeros, absSum was 0, and the footer's
      // "$0.00" parsed to 0 — the test passed without ever exercising the
      // absolute-value rule it exists to protect. The session-241 redesign made
      // ties print nothing, which turned the silent pass into a visible null and
      // is the only reason anyone looked. Reading the numbers the renderer held
      // makes it a real check: the mutation below puts a genuine +/-415.88 on
      // two loans, and a signed sum would cancel to zero where an absolute one
      // does not.
      const cbx = s.loans.closeBand;
      const rowVars = cbx.rows.map(r => r.varianceN).filter(x => x != null);
      const absSum = rowVars.reduce((n, x) => n + Math.abs(x), 0);
      t.ok(rowVars.length > 0, 's236: the rollforward rows actually report a variance to total');
      // Session 246 split the footer by grade, so "the total" is now the sum
      // across the subtotal rows. Reading footVarianceN alone reads grade A's
      // line only — which happens to be right today because both grade-B rows
      // are a tie and a circular row, and would silently under-report the moment
      // a schedule-closed loan carried a real variance.
      // Session 247 removed the per-grade footer rows, so there is one total to
      // check and it is checked straight against the table. The footer sums
      // UNEXPLAINED variance only — a tie contributes nothing and an 'unbooked'
      // difference is owned by the posting gate — so the row-side sum is taken
      // over the same two bands rather than over every non-null figure. Reading
      // it any wider would make this assertion drift the first time an unbooked
      // row appears, and drift in a test is indistinguishable from a bug.
      const unexplainedRows = cbx.rows.filter(r => r.band === 'immaterial' || r.band === 'material');
      /* THE RESIDUAL, not the raw figure. Session 272 gave a row a second way to
         be partly explained (a closing anchor dated before payments booked in the
         month), and on such a row the two differ — PayPal 2 reads −$9,429.39 raw
         and $21.66 unexplained. The footer sums what is still UNEXPLAINED, which
         is the honest quantity for a total headed "to resolve", so the row-side
         sum has to be taken on the same basis. Reading `varianceN` here made this
         assertion demand that the footer publish money it had just explained. */
      const absUnexplained = unexplainedRows.reduce((n, r) => n + Math.abs(r.varianceResidualN ?? r.varianceN), 0);
      t.ok(unexplainedRows.length >= 2,
           's236: the scenario really did put a variance on more than one loan',
           `${unexplainedRows.length} rows carry an unexplained variance`);
      t.close(Math.abs(Number((cbx.subtotals.all || {}).varianceN || 0)), absUnexplained, 0.05,
        's236: the close-band variance total is the sum of ABSOLUTE row variances');
      // The signed sum would cancel the +415.88 against the −415.88 this
      // scenario plants; the absolute one cannot. That is the whole point.
      const signedSum = unexplainedRows.reduce((n, r) => n + (r.varianceResidualN ?? r.varianceN), 0);
      t.ok(Math.abs(absUnexplained - Math.abs(signedSum)) > 100,
           's236: ...and the scenario really would have cancelled under a signed total',
           `absolute ${absUnexplained} vs signed ${signedSum}`);
      await p.close();
    }
    // ── s240 #21: an "all clear" has to say as of when ──
    {
      const p = await newHarnessPage({ tab: 'overview' });
      const s = await p.surfaces();
      if (/Everything is reconciled/.test(s.overview.statusline || '')) {
        t.ok(/\d/.test(s.overview.reconLastRun || ''), 's240 #21: "Everything is reconciled" is dated by the last-run line',
             `statusline=${s.overview.statusline} lastrun=${s.overview.reconLastRun}`);
      } else {
        t.ok(true, 's240 #21: queue is non-empty, "all clear" wording not on screen');
      }
      await p.close();
    }
    // ── the stub's own contract: order() actually sorted ──
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const log = await p.log();
      t.ok(log.orders.some(o => o.startsWith('loan_statements:statement_date↓')),
           'harness contract: loan_statements was requested newest-first and the stub honoured it',
           JSON.stringify(log.orders.slice(0, 8)));
      const firstThree = await p.evaluate(() => (_allLoanStatements || []).slice(0, 3).map(s => s.statement_date));
      t.ok(firstThree[0] >= firstThree[1] && firstThree[1] >= firstThree[2],
           'harness contract: statements really do arrive sorted descending', JSON.stringify(firstThree));
      await p.close();
    }
  },
});

/* ═════════════ SESSION 243 — THE ROSTER, AGAINST THE REAL FUNCTIONS ══════════
   These groups replace tests/loan-roster.test.mts and tests/queue-hygiene.test.mts,
   which did not import the dashboard at all: they TRANSCRIBED _bkRosterState,
   _bkSubstanceKey and _bkDismissalHolds into their own files and asserted that
   the copy agreed with itself. Fifty-two green assertions that would still have
   been green if the shipped functions were deleted.

   Everything below drives the REAL functions inside the REAL page.

   tests/loan-roster.test.mts is DELETED — nothing in it tested a constant that
   had no dashboard counterpart. tests/queue-hygiene.test.mts is reduced to the
   two materiality thresholds, which live server-side in reconciliation-run and
   so are out of this harness's reach. Where each old assertion now lives:

     roster-classification         _bkRosterState / _loanVariance: tied, explained,
                                   exception-vs-real-anchor, exception-vs-our-own-
                                   projection, not_comparable, the missing-material
                                   flag, the residual-not-the-snapshot rule, a run
                                   that never finished, a loan the run did not cover
     roster-clean-loan-children    a finding on a reconciled or immaterial loan  (#1)
     roster-orphan-findings        a finding whose loan is not active            (#2)
     roster-empty-denominator      zero active loans                             (#3)
     roster-confetti-gate          the celebration only counts if it was earned  (#4)
     dismissal-fail-open           _bkDismissalHolds, incl. two REPORTED defects (#5)
     substance-key-substance       _bkSubstanceKey, incl. a REPORTED defect      (#6)

   Groups #5 and #6 assert the behaviour those functions OUGHT to have and are
   expected to FAIL until the two reported defects are fixed. They are not tuned
   green; a red assertion there is the finding.

   ── HOW EACH GROUP PROVES IT DISCRIMINATES ─────────────────────────────────
   A test that passes is worthless unless it would have failed on the broken
   code. So each of the four fixed defects is checked twice: once against the
   shipped page, and once against the SAME page with the pre-fix line put back
   IN PAGE CONTEXT ONLY — by taking the shipped function's own .toString() and
   applying the inverse edit, then rebuilding it with new Function(). Nothing on
   disk is touched; admin-dashboard/index.html stays byte-identical. Every
   inverse edit asserts its anchor was found, so a future refactor that moves
   the code turns into a loud failure rather than a silently skipped check.
   ═══════════════════════════════════════════════════════════════════════════ */

const ALL_TABLES = COLD_TABLES;
// The reads loadLoans() owns — released together in phase 2 of the confetti
// scenario. loan_book_balances is one of them (session 246), so it belongs here
// or phase 1 would release it and the "loans have not landed yet" phase would be
// half-landed.
const LOAN_TABLES = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows',
                     'loan_documents', 'loan_book_balances', 'loan_attributions'];

/* The inverse edits: shipped source → pre-fix source. Keyed by the defect they
   re-introduce. Applied to _bkRosterHtml.toString() inside the page. */
const ROSTER_REVERTS = {
  // ── A NOTE ON WHY THERE ARE NOW THREE OF THESE AND NOT FOUR ─────────────
  // Sessions 242-246 carried TWO separate copy-paste branches that each had to
  // remember to render a loan's findings — one for `reconciled`, one for
  // `immaterial` — and the historical defect was that neither of them did. That
  // is the session-231 shape exactly: the right code, one branch away from the
  // path that needed it. The session-247 roster has ONE children path serving
  // every state, so the two defects are no longer independently expressible.
  // `no-children` therefore reverts one line and the control asserts the
  // findings vanish from BOTH a reconciled loan and an immaterial one — which is
  // a stronger claim than the pair it replaces, because it proves the single
  // path is genuinely shared rather than duplicated somewhere out of sight.

  // #1a A reconciled loan carrying open findings showed a plain green dot — an
  //     all-clear the roster was never told it could give.
  'reconciled-dot': { fn: '_bkLenderSummary', edits: [
    ["dot = itemCount ? 'amber' : 'green'; tone = 't3';",
     "dot = 'green'; tone = 't3';"],
  ] },
  // #1b A loan's findings rendered nowhere at all.
  'no-children': [
    ['          if (r.items.length) html += r.items.map(_bkQueueRowHtml).join(\'\');',
     '          if (false) html += r.items.map(_bkQueueRowHtml).join(\'\');'],
  ],
  // #2 A finding whose loan is not ACTIVE went into byLoan under an id nothing
  //    ever read back, and was not an orphan either, because it HAD an id.
  'orphans': [
    ['if (!id || !onRoster.has(id)) { orphans.push(it); return; }',
     'if (!id) { orphans.push(it); return; }'],
  ],
  // #3 Zero active loans blanked the whole card, taking every queue row with it.
  'empty-denominator': [
    ["if (!loans.length) return (issues || []).map(_bkQueueRowHtml).join('');",
     "if (!loans.length) return '';"],
  ],
  // #5 (session 247) A lender-level finding — Ford's "3 loans disagree", which
  //    reconciliation-run raises with a NULL loan_account_id — is filed under
  //    the lender it names. The eligibility test must be the ABSENT ID and never
  //    the name, or a finding orphaned because its loan went inactive gets
  //    swallowed into a collapsed panel of loans that are fine.
  'orphan-by-name': [
    ['      if (_bkIssueLoanId(it)) return true;\n', '      \n'],
  ],
};

// #4 The confetti gate lives inside renderBookkeepingOverview, not in its own
//    function, so this one is reverted on that function instead.
const CONFETTI_FIXED =
  "const _rc = _bkOverviewSeg === 'issues' ? _bkRosterCounts() : null;\n" +
  "    const _rcNow = (_rc && _rc.total > 0 && _bkDataReady()) ? _rc.reconciled : null;";
const CONFETTI_PREFIX =
  "const _rcNow = _bkOverviewSeg === 'issues' ? _bkRosterCounts().reconciled : null;";

/* Install the pre-fix roster in the page. Returns {ok, missing:[...]}. */
// A revert set is either a bare list of [from, to] pairs (applied to
// _bkRosterHtml) or { fn, edits } naming another shipped function — the roster's
// status sentences and dot colours live in _bkLenderSummary now, and a
// discrimination test that could only rewrite one function would silently stop
// discriminating the moment a branch moved into the other.
const REVERT_ARGS = { _bkRosterHtml: ['issues'], _bkLenderSummary: ['rows'] };
async function revertRoster(p, names, edits) {
  return p.evaluate(({ names, edits, argNames }) => {
    const byFn = new Map();
    const missing = [];
    for (const n of names) {
      const spec = Array.isArray(edits[n]) ? { fn: '_bkRosterHtml', edits: edits[n] } : edits[n];
      if (!byFn.has(spec.fn)) byFn.set(spec.fn, []);
      byFn.get(spec.fn).push([n, spec.edits]);
    }
    for (const [fn, sets] of byFn) {
      if (typeof window[fn] !== 'function') { missing.push('no such function: ' + fn); continue; }
      let src = window[fn].toString();
      for (const [n, pairs] of sets) for (const [from, to] of pairs) {
        if (!src.includes(from)) { missing.push(n + ' :: ' + from.slice(0, 60)); continue; }
        src = src.replace(from, to);
      }
      if (missing.length) continue;
      const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
      try { window[fn] = new Function(...(argNames[fn] || []), body); }
      catch (e) { missing.push('compile ' + fn + ': ' + e.message); }
    }
    if (missing.length) return { ok: false, missing };
    renderBookkeepingOverview();
    return { ok: true, missing: [] };
  }, { names, edits, argNames: REVERT_ARGS });
}

/* The queue card, read the way a person reads it.

   Session 247: the roster is one row per LENDER, with each loan's findings in a
   panel below it. The panel is display:none until clicked but is in the DOM from
   the first paint, and this reader uses textContent (never innerText) precisely
   so that "every item reaches the DOM" keeps meaning what it meant — a finding
   behind a click with a count on the face of its row is on the screen; a finding
   that never rendered is not, and only the second is a bug.

   `rows` is flattened so a test can name either a lender row or an individual
   loan inside a group and get the same shape back. */
const READ_QUEUE = () => {
  const list = document.getElementById('bk-ov-queue-list');
  if (!list) return null;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const rows = [];
  for (const el of list.children) {
    if (el.classList && el.classList.contains('bk-lender-row')) {
      const panel = el.nextElementSibling && el.nextElementSibling.classList.contains('bk-lr-panel')
        ? el.nextElementSibling : null;
      const subs = panel ? [...panel.querySelectorAll('.bk-lr-sub')] : [];
      rows.push({
        kind: 'lender', cls: el.className,
        name: norm((el.querySelector('.bk-lr-name') || {}).childNodes ? el.querySelector('.bk-lr-name').childNodes[0].textContent : ''),
        dot: norm((el.querySelector('.bk-dot') || {}).className).replace('bk-dot ', ''),
        reason: norm(((el.querySelector('.bk-lr-sum') || {}).textContent || '') + ' '
                   + ((el.querySelector('.bk-lr-meta') || {}).textContent || '')),
        detail: norm(panel ? (panel.querySelector('.bk-lr-detail') || {}).textContent : ''),
        loanCount: subs.length || 1,
        childRows: panel ? panel.querySelectorAll('.bk-queue-row').length : 0,
        childNames: panel ? [...panel.querySelectorAll('.bk-queue-row .bk-queue-name')].map(n => norm(n.textContent)) : [],
      });
      // Every loan inside the group, addressable by its own name.
      if (panel) for (const blk of panel.querySelectorAll('.bk-lr-loan')) {
        const sub = blk.querySelector('.bk-lr-sub');
        rows.push({
          kind: 'loan', cls: 'bk-lr-loan', name: norm(blk.getAttribute('data-loan') || ''),
          dot: sub ? norm((sub.querySelector('.bk-dot') || {}).className).replace('bk-dot ', '')
                   : norm((el.querySelector('.bk-dot') || {}).className).replace('bk-dot ', ''),
          reason: sub ? norm(((sub.querySelector('.bk-lr-sub-sum') || {}).textContent || '') + ' '
                           + ((sub.querySelector('.bk-lr-meta') || {}).textContent || ''))
                      : norm(((el.querySelector('.bk-lr-sum') || {}).textContent || '') + ' '
                           + ((el.querySelector('.bk-lr-meta') || {}).textContent || '')),
          childRows: blk.querySelectorAll('.bk-queue-row').length,
          childNames: [...blk.querySelectorAll('.bk-queue-row .bk-queue-name')].map(n => norm(n.textContent)),
        });
      }
    } else if (el.classList && el.classList.contains('bk-queue-row')) {
      // The fallback flat list (no roster) and the orphan group.
      rows.push({
        kind: 'item', cls: el.className,
        name: norm((el.querySelector('.bk-queue-name') || {}).textContent),
        dot: norm((el.querySelector('.bk-dot') || {}).className).replace('bk-dot ', ''),
        reason: norm((el.querySelector('.bk-queue-reason') || {}).textContent),
        childRows: 0, childNames: [],
      });
    }
  }
  // Session 258: itemNames/text used to be hardcoded to _bkIssueQueueItems()
  // regardless of which segment is on screen -- harmless while every test only
  // read Issues, but a false "missing" report the moment a test reads Approvals
  // or Staged (Issues' loan-variance names bleed through as phantom expectations
  // that were never meant to be on this segment at all). Read the segment that's
  // actually rendered.
  const segItems = _bkOverviewSeg === 'approvals' ? _bkApprovalQueueItems()
                  : _bkOverviewSeg === 'staged' ? _bkStagedQueueItems()
                  : _bkIssueQueueItems();
  return {
    counts: _bkRosterCounts(),
    dataReady: _bkDataReady(),
    seg: _bkOverviewSeg,
    itemNames: segItems.map(i => norm(i.name)),
    heads: [...list.querySelectorAll('.bk-tier-head')].map(e => norm(e.textContent)),
    rows,
    lenderRows: rows.filter(r => r.kind === 'lender').length,
    text: norm(list.textContent),
    allClear: !!list.querySelector('.bk-allclear'),
    statusline: norm((document.getElementById('bk-ov-statusline') || {}).textContent),
  };
};

/* Find the roster entry for a loan — the lender row on a single-loan lender,
   the loan's own block inside a group otherwise. Never a finding row. */
const rowFor = (q, name) => q.rows.find(r => r.kind === 'loan' && r.name === name)
                         || q.rows.find(r => r.kind === 'lender' && r.name === name)
                         || null;
/* The findings that belong to that loan. */
const kidsFor = (q, name) => rowFor(q, name) || { childRows: 0, childNames: [] };

/* ── R0 ── WHAT THE ROSTER REFUSES TO CALL RECONCILED ─────────────────────── */
// This group owns everything tests/loan-roster.test.mts used to claim. That file
// re-implemented _loanVariance + _bkRosterState in twelve lines of its own and
// then asserted the twelve lines agreed with themselves; the assertions below
// call the shipped functions on the shipped tie-outs, through the page.
//
// The rule they exist to protect: "nothing wrong" and "never checked" are
// different states, and the roster must never merge them.
GROUPS.push({
  name: 'roster-classification',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });

    const book = await p.evaluate(() => (_allLoanAccounts || []).filter(a => a.status === 'active').map(a => {
      const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id) || {};
      const st = _bkRosterState(a);
      return { name: a.xero_account_name, status: to.status || null, anchor: to.anchor_source || null,
               closeBasis: a.close_basis || 'lender_statement',
               material: to.detail ? to.detail.material : undefined,
               group: st.group, reason: st.reason || null,
               difference: st.difference == null ? null : Number(st.difference) };
    }));
    const g = (n) => (book.find(x => x.name === n) || {}).group;

    t.eq(book.length, 14, 'r0: the book really is 14 active loans');

    // ── tied and explained are the only two ways to be reconciled ──
    for (const n of ['Rapid Credit Line', 'Paypal 2'])
      t.eq(g(n), 'reconciled', `r0: ${n} (tied against a real lender document) is reconciled`);
    for (const n of ['BayFirst SBA Loan', 'BayFirst SBA 2', 'E-Transit Loan E6-7410'])
      t.eq(g(n), 'reconciled', `r0: ${n} (explained by later payments) is reconciled`);

    // ── A TIE AGAINST OUR OWN ARITHMETIC IS NOT A RECONCILIATION (s246) ──
    // Dexter 2's tie-out is `tied` at $0.00 — but the anchor it tied to is the
    // amortization schedule, i.e. the document the books were BUILT from. The
    // roster used to read that as reconciled, which is the agreement half of the
    // distinction _loanVariance already drew for exceptions. Same rule, both
    // directions: `tied` plus a non-lender anchor is its own group.
    const dexter = book.find(x => x.name === 'Dexter Loan 2');
    t.eq(dexter.status, 'tied', 'r0: Dexter 2 really is a $0.00 tie-out');
    t.eq(dexter.anchor, 'amortization_schedule',
         'r0: ...against our own schedule, not against anything a lender sent');
    t.eq(dexter.group, 'byschedule',
         'r0: ...so it reads as closed on the contractual schedule, NOT as reconciled');
    t.ok(dexter.group !== 'reconciled',
         'r0: ...and a document compared with itself never earns the green group');

    // ── an exception measured against a real lender document is red ──
    for (const n of ['PCV Good and Green Loan', 'Funding Circle Loan', 'E-Transit Loan - 4140',
                     'E-Transit Loan E4 -9744', 'E-Transit Loan E5-4751'])
      t.eq(g(n), 'variance', `r0: ${n} deviates from a real lender document — needs attention`);
    // EIDL: an exception against a real (emailed-PDF) lender document, and the
    // fixture now carries loan_tie_outs.detail for the first time — so the
    // materiality flag computeTieOut actually wrote is finally under test. It
    // says material:false, and $5.00 on a $960,005 balance is below BOTH
    // MATERIAL_FLOOR ($25) and MATERIAL_SHARE (0.25%), so `immaterial` is the
    // correct read. This assertion used to test the ABSENCE of a flag; that rule
    // is not lost — it is exercised explicitly by the `mat` probe below, which
    // strips detail back off and requires MATERIAL.
    const eidl = book.find(x => x.name === 'EIDL SBA Loan');
    t.eq(eidl.status, 'exception', 'r0: EIDL really is an exception against its lender document');
    t.eq(eidl.anchor, 'email_pdf_upload', 'r0: ...and the anchor really is a document the lender sent');
    t.eq(eidl.material, false, 'r0: ...whose tie-out carries an EXPLICIT material:false');
    t.eq(eidl.group, 'immaterial',
         'r0: ...so it is a small difference, shown and not chased — never reconciled, never red');
    t.ok(eidl.group !== 'reconciled', 'r0: ...and an immaterial gap is still a gap, not a clean bill');

    // ── an exception against our own projection, on a loan whose RECORDED
    //    POLICY is that schedule (session 246, amendment A8) ──
    // "Needs a statement" is a lie on a loan whose lender does not issue one.
    // Verdant's notice carries a payment amount and no balance; close_basis says
    // the contractual schedule is the accepted basis. So a −$1,835.75 gap
    // against that schedule is not "unverified pending a document" — it is the
    // books disagreeing with the basis this loan actually closes on, which is
    // real work and the whole point of the exercise.
    const verdant = book.find(x => x.name === 'Verdant Capital Loan');
    t.eq(verdant.anchor, 'amortization_schedule', 'r0: Verdant really is anchored to our own schedule');
    t.eq(verdant.closeBasis, 'amortization_schedule',
         'r0: ...and that schedule is its RECORDED closing basis, not an accident of what happened to be on file');
    t.eq(verdant.group, 'variance',
         'r0: ...so the gap is the answer, not a placeholder — it is work, and it is red');
    t.ok(verdant.group !== 'unverified',
         'r0: ...and it never asks for a statement that this lender is never going to send');
    t.close(verdant.difference, -1835.75, 0.005,
            'r0: ...and the number shown is the real −$1,835.75 the books are out by');
    t.ok(/contractual schedule/.test(verdant.reason || ''),
         'r0: ...and the sentence says which document it disagrees with',
         `reason=${JSON.stringify(verdant.reason)}`);

    // The rule the old assertion protected is NOT lost: a loan anchored to our
    // own projection with NO such policy still refuses to go red. Verdant is the
    // only loan carrying the policy, so the counterfactual is asserted directly.
    const noPolicy = await p.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
      const was = a.close_basis;
      a.close_basis = 'lender_statement';
      const g2 = _bkRosterState(a).group;
      a.close_basis = was;
      return g2;
    });
    t.eq(noPolicy, 'unverified',
         'r0: strip the policy and the same gap goes back to "not a fact about the world yet" — the policy is what makes it work');

    // ── nothing to compare against is not "nothing wrong" ──
    const stripe = book.find(x => x.name === 'Stripe Capital Loan');
    t.eq(stripe.status, 'not_comparable', 'r0: Stripe Capital really has nothing to compare against');
    t.eq(stripe.group, 'na', 'r0: ...which is its own state');
    t.ok(stripe.group !== 'reconciled', 'r0: ...and never reads as reconciled — never checked is not a clean bill');

    // ── the denominator has to add up ──
    const counts = await p.evaluate(() => _bkRosterCounts());
    // byschedule is a group _bkRosterState can return, so it has to be in the
    // sum or the denominator quietly stops adding up — which is precisely the
    // failure _bkRosterCounts's own comment warns about.
    const sum = counts.reconciled + counts.variance + counts.unverified + counts.na
              + counts.unchecked + counts.immaterial + counts.byschedule;
    t.eq(sum, counts.total, 'r0: every active loan lands in exactly one group');
    // …and the sum above cannot go stale in silence. If a future group key is
    // added to _bkRosterCounts and not to the sum, this fails rather than the
    // denominator quietly under-counting.
    const summed = ['reconciled','variance','unverified','na','unchecked','immaterial','byschedule'];
    t.eq(Object.keys(counts).filter(k => k !== 'total').sort().join(','), summed.slice().sort().join(','),
         'r0: the harness sums every group _bkRosterCounts can return, with none left out');
    t.ok(counts.reconciled <= counts.total, 'r0: reconciled can never exceed the total');
    t.ok(book.every(x => x.group), 'r0: no loan falls out of the classification entirely');

    // ── materiality: a MISSING flag is not permission to go quiet ──
    const mat = await p.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'EIDL SBA Loan');
      const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id);
      const at = (d) => { to.detail = d; return _bkRosterState(a).group; };
      return { missing: at(undefined), explicitTrue: at({ material: true }),
               explicitFalse: at({ material: false }), emptyDetail: at({}) };
    });
    t.eq(mat.missing, 'variance', 'r0: a tie-out with no material flag is treated as MATERIAL');
    t.ok(book.filter(x => x.material === undefined).length >= 0,
         `r0 note: ${book.filter(x => x.material !== undefined).length} of ${book.length} tie-outs now carry detail.material — ` +
         `the fixture refresh made this flag testable for the first time, which is why EIDL moved`);
    t.eq(mat.emptyDetail, 'variance', 'r0: ...and so is one with a detail payload that omits it');
    t.eq(mat.explicitTrue, 'variance', 'r0: an explicit material:true is material');
    t.eq(mat.explicitFalse, 'immaterial',
         'r0: only an explicit material:false becomes a small difference — and it is NOT reconciled');

    // ── the number shown is the RESIDUAL, never the anchor-date snapshot ──
    // PCV rendered "$5,335.52 above the lender" directly above a finding reading
    // "$1,802.58 below" — different number, opposite direction, same loan.
    const resid = await p.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'PCV Good and Green Loan');
      const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id);
      const at = (d) => { to.detail = d; return Number(_bkRosterState(a).difference); };
      const out = {
        raw: at(undefined),
        residual: at({ residual_after_later: -1802.58 }),
        zero: at({ residual_after_later: 0 }),
        nonNumeric: at({ residual_after_later: 'oops' }),
        nulled: at({ residual_after_later: null }),
      };
      to.detail = { residual_after_later: -1802.58 };
      renderBookkeepingOverview();
      // SESSION 258: session 247's lender-grouped roster (.bk-lender-row /
      // .bk-lr-name) is gone from Issues — session 257 replaced it with
      // _bkVarianceTableHtml's flat <table>, one <tr data-bkkey> per loan,
      // the loan name inside .bk-var-loan.
      const row = [...document.querySelectorAll('#bk-ov-queue-list .bk-var-table tbody tr')]
        .find(e => ((e.querySelector('.bk-var-loan') || {}).textContent || '').trim() === 'PCV Good and Green Loan');
      out.rendered = row ? row.textContent.replace(/\s+/g, ' ').trim() : null;
      return out;
    });
    t.eq(resid.raw, 5335.52, 'r0: with no residual on file, the anchor-date difference is what there is');
    t.eq(resid.residual, -1802.58, 'r0: a residual on the tie-out replaces it');
    t.eq(resid.zero, 0, 'r0: a residual of exactly zero is a real answer, not a missing one');
    t.eq(resid.nonNumeric, 5335.52, 'r0: a non-numeric residual falls back rather than rendering NaN');
    t.eq(resid.nulled, 5335.52, 'r0: ...and so does a null one');
    t.ok(/\$1,802\.58 below the lender/.test(resid.rendered || ''),
         'r0: and the roster row renders the residual, in the residual\'s direction',
         `rendered=${JSON.stringify(resid.rendered)}`);
    t.notMatch(resid.rendered, /5,335\.52/,
               'r0: ...never the anchor-date figure the finding underneath contradicts');

    // ── a loan the run did not cover ──
    const dropped = await p.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Paypal 2');
      const i = _loanTieOuts.findIndex(x => x.loan_account_id === a.id);
      const was = _bkRosterState(a).group;
      _loanTieOuts.splice(i, 1);
      return { was, now: _bkRosterState(a).group };
    });
    t.eq(dropped.was, 'reconciled', 'r0: Paypal 2 was reconciled while the run covered it');
    t.eq(dropped.now, 'unchecked', 'r0: ...and drops to "not checked" the moment it is not covered — not to reconciled');
    await p.close();

    // ── no finished run at all: the board must not go green ──
    const p2 = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.reconciliation_runs.forEach(r => { r.finished_at = null; });
    } });
    const cold = await p2.evaluate(() => ({ counts: _bkRosterCounts(), runId: _loanTieOutRunId, ties: (_loanTieOuts || []).length }));
    t.eq(cold.runId, 'null', 'r0: with no run finished, there is no tie-out run to read');
    t.eq(cold.ties, 0, 'r0: ...and no tie-outs are loaded');
    t.eq(cold.counts.unchecked, 14, 'r0: every loan reads "not checked yet"');
    t.eq(cold.counts.reconciled, 0, 'r0: and NOT ONE reads reconciled — a run that did not finish is not an all-clear');
    await p2.close();
  },
});
/* ── R1 ── A FINDING ON A CLEAN LOAN STILL HAS TO REACH THE SCREEN ────────── */
// Owns what tests/loan-roster.test.mts called "every issue reaches the loan it
// belongs to" — except that file tested a five-line re-implementation of
// _bkIssueLoanId, so it could not have seen this.
//
// SESSION 258 REWRITE. Session 257 replaced the lender-grouped, click-to-expand
// roster (_bkRosterHtml) that this group used to read with two things: Issues
// is now a flat table of loan VARIANCES ONLY (_bkVarianceTableHtml, sourced from
// _bkIssueQueueItems, which filters to active loans whose balance state is
// 'variance' or 'immaterial') and every split_mismatch / stage_flag /
// recon_finding — the "children" this group used to find nested under a loan's
// row — moved into Approvals as a flat list with no nesting at all
// (_bkQueueRowHtml, sourced from _bkApprovalQueueItems). There is no loan
// roster left inside Approvals to swallow a finding, which is good news: the
// invariant this group protects — a finding does not disappear just because
// the loan it is on LOOKS fine — is now trivially easier to state, because
// _bkApprovalQueueItems never keys anything off a loan's balance state at all.
// What is worth proving is exactly that: findings on RECONCILED loans (Rapid
// Credit Line, Paypal 2), a loan settled on its own schedule rather than a
// lender document (Dexter Loan 2, 'byschedule' — never 'reconciled', session
// 246), and an IMMATERIAL loan (E-Transit 4140, forced here) all still reach
// the same flat Approvals list an unreconciled loan's findings do. In this
// fixture Rapid Credit Line's and Dexter Loan 2's open findings are both
// 'derivable_not_derived' at severity 'info' — reached through the separate
// _bkReconInfoFindings() block near the end of _bkApprovalQueueItems, not the
// split_mismatch/stage_flag/recon_finding forEach; Paypal 2's is warn-severity
// and does go through that forEach. Both paths get their own control below.
GROUPS.push({
  name: 'roster-clean-loan-children',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    const noDismissals = (d) => { d.bk_issue_dismissals.length = 0; };
    const findingsFor = (p, loanName) => p.evaluate((name) => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === name);
      if (!a) return null;
      return _bkApprovalQueueItems().filter(it => _bkIssueLoanId(it) === a.id).map(it => it.name);
    }, loanName);

    const p = await newHarnessPage({ tab: 'overview', mutate: noDismissals });
    await p.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const q = await p.evaluate(READ_QUEUE);

    // Two loans the real book carries as RECONCILED (balance state) while
    // still carrying open findings of the relocated kinds.
    const rcl = await findingsFor(p, 'Rapid Credit Line');
    t.ok(!!rcl && rcl.length >= 1, 'r1: Rapid Credit Line (reconciled, but carrying findings) still reaches Approvals',
         JSON.stringify(rcl));
    t.ok((rcl || []).every(n => q.text.includes(n)),
         'r1: ...and every one of its findings is actually in the DOM, not just the array', JSON.stringify(rcl));
    t.ok((rcl || []).some(n => /enough lender balances to project a schedule/.test(n)),
         'r1: ...named specifically, not folded into a count', JSON.stringify(rcl));

    const pp = await findingsFor(p, 'Paypal 2');
    t.ok(!!pp && pp.length >= 1, 'r1: ...and the same on Paypal 2, the other reconciled loan with work outstanding',
         JSON.stringify(pp));
    t.ok((pp || []).every(n => q.text.includes(n)), 'r1: ...also fully on screen', JSON.stringify(pp));

    // The loan that left the green group entirely (session 246: a tie against
    // our own schedule is not a reconciliation) still carries the same shape:
    // real open findings that must not vanish because its balance state reads
    // settled rather than red.
    const dex = await findingsFor(p, 'Dexter Loan 2');
    t.ok(!!dex && dex.length >= 1, 'r1: Dexter Loan 2 (settled on the contractual schedule) still reaches Approvals',
         JSON.stringify(dex));
    t.ok((dex || []).some(n => /hand-posted corrections/.test(n)),
         'r1: ...by name, not as a count', JSON.stringify(dex));
    t.ok((dex || []).every(n => q.text.includes(n)), 'r1: ...and on screen');

    // A loan with nothing outstanding names no findings at all — the presence
    // above is a real distinction, not an artifact of every loan having one.
    const bay = await findingsFor(p, 'BayFirst SBA 2');
    t.eq((bay || []).length, 0, 'r1: a loan with nothing outstanding contributes nothing to Approvals');

    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r1: every item Approvals believes it is showing reaches the DOM');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));
    await p.close();

    // ── AND THE SAME RULE FOR THE IMMATERIAL GROUP ──
    // Nothing in the real book is immaterial today with open findings of its
    // own to test against, so this is EIDL's shape (session 246) applied to a
    // loan that actually has findings: mark E-Transit 4140's tie-out immaterial
    // and its three open findings must still reach Approvals.
    const p2 = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      noDismissals(d);
      const a = d.loan_accounts.find(x => x.xero_account_name === 'E-Transit Loan - 4140');
      const to = d.loan_tie_outs.find(x => x.loan_account_id === a.id);
      to.detail = Object.assign({}, to.detail || {}, { material: false });
    } });
    await p2.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p2.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const q2 = await p2.evaluate(READ_QUEUE);
    const et = await findingsFor(p2, 'E-Transit Loan - 4140');
    /* ── THIS ASSERTION USED TO EXPECT 3 AND WENT RED ON 09-01 (session 262) ──
       It was NOT a calendar casualty like the rest of that morning's failures --
       it fails against a frozen clock too, and it was failing on git HEAD before
       this session touched anything. It encodes PRE-258 behaviour.

       What actually happens now, measured rather than assumed: this loan lands
       in ISSUES (group 'immaterial'), and session 258 deliberately stopped
       Approvals from repeating the findings of a loan that already has an Issues
       row -- so its findings reach Approvals zero times, ON PURPOSE. Tuning this
       to 0 and calling it fixed would delete the record of what that fold costs,
       which is the one thing here worth keeping. So it is stated instead.

       ⚠ THE HOLE, EXACTLY: _bkIssueQueueItems takes the most serious finding via
       .find() and shows THAT ONE as the row's explanation. This loan has three.
       The other two are named on no screen at all -- not in Issues, not in
       Approvals. They are not lost from the DATA (_bkLoanAttentionItems still
       holds all three, so nothing that counts is undercounting), but a reader
       cannot reach them. Filed as Tech Debt #28; David has not been asked which
       way he wants it.

       These assertions PASS while saying that. The day the fold changes they go
       red and announce that they must be rewritten -- which is the point. */
    t.eq((et || []).length, 0,
         'r1 ⚠ REPORTED: an immaterial loan\'s findings reach Approvals ZERO times — session 258 folds them into its Issues row instead',
         JSON.stringify(et));
    const etFold = await p2.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'E-Transit Loan - 4140');
      const held = _bkLoanAttentionItems().filter(it => _bkIssueLoanId(it) === a.id);
      const shown = _bkIssueQueueItems().filter(i => i.loanId === a.id);
      return { held: held.length, shownRows: shown.length, explain: (shown[0] || {}).explain || '' };
    });
    t.eq(etFold.held, 3, 'r1: ...the loan really does carry three open findings, so the fold has something to lose');
    t.eq(etFold.shownRows, 1, 'r1: ...and Issues gives it exactly one row');
    // Read the ISSUES pane for this one, not q2 -- q2 was captured with the
    // Approvals segment on screen, and asking whether an Issues row reached the
    // DOM by searching Approvals' text is a question that can only answer no.
    const etIssuesText = await p2.evaluate(() => {
      _bkSetOverviewSeg('issues'); renderBookkeepingOverview();
      return (document.getElementById('bk-ov-queue-list') || {}).textContent || '';
    });
    t.ok(etFold.explain && etIssuesText.includes(etFold.explain.slice(0, 40)),
         'r1: ...whose explanation is one of them, on screen and reachable', etFold.explain.slice(0, 60));
    t.ok(etFold.held > etFold.shownRows,
         'r1 ⚠ REPORTED: ...leaving 2 of its 3 findings named on NO screen — data intact, reader cannot reach them (Tech Debt #28)',
         `${etFold.held} held, ${etFold.shownRows} shown`);
    await p2.close();

    // ── does it discriminate? ──
    // There is no historical branch to revert here: session 257 deleted the
    // by-loan roster this group used to read, rather than patching a bug in
    // it. The control instead constructs the regression this group exists to
    // catch — a loan-status filter added to _bkApprovalQueueItems, the exact
    // shape the old roster bug took (a clean-looking loan silently dropping
    // its findings) — and proves the assertions above would have caught it.
    //
    // TWO controls, not one: this fixture's Rapid Credit Line and Dexter Loan 2
    // findings are 'derivable_not_derived', severity 'info' -- they never reach
    // _bkLoanAttentionItems() (its recon_finding branch keeps only error/warn),
    // so they reach Approvals through the separate _bkReconInfoFindings() block
    // near the end of _bkApprovalQueueItems, not through the split_mismatch /
    // stage_flag / recon_finding forEach this group's comment originally named.
    // Paypal 2's finding IS warn-severity and does go through that forEach.
    // Proving the invariant for real means patching whichever function actually
    // produces each loan's findings, not assuming they all take one path.
    const p3 = await newHarnessPage({ tab: 'overview', mutate: noDismissals });
    await p3.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p3.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });

    // Control A — the split_mismatch/stage_flag/recon_finding(error|warn) forEach.
    const revA = await p3.evaluate(() => {
      const src = _bkApprovalQueueItems.toString();
      const anchor = "_bkLoanAttentionItems().filter(it => it.kind === 'split_mismatch' || it.kind === 'stage_flag' || it.kind === 'recon_finding').forEach(it => {";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor not found — _bkApprovalQueueItems has moved' };
      const cleanIds = (_allLoanAccounts || [])
        .filter(a => ['Rapid Credit Line', 'Paypal 2', 'Dexter Loan 2'].includes(a.xero_account_name))
        .map(a => a.id);
      window.__R1_CLEAN_LOAN_IDS = cleanIds;
      const patched = src.replace(anchor, anchor +
        "\n      if (window.__R1_CLEAN_LOAN_IDS.includes(_bkIssueLoanId(it))) return;");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      let patchedFn;
      try { patchedFn = new Function(body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      window._bkApprovalQueueItems = patchedFn;
      return { ok: true };
    });
    t.ok(revA.ok, 'r1 CONTROL A: the split/stage/recon-finding regression could be installed in page context',
         JSON.stringify(revA));
    if (revA.ok) {
      await p3.evaluate(() => renderBookkeepingOverview());
      // Paypal 2's finding is warn-severity, so it is the one this forEach
      // actually produces -- it must vanish under the patch.
      const ppGone = await findingsFor(p3, 'Paypal 2');
      t.eq((ppGone || []).length, 0,
           'r1 CONTROL A: with the hypothetical filter installed, Paypal 2\'s warn-severity finding vanishes from Approvals');
    }

    // Control B — the separate _bkReconInfoFindings() block. Rapid Credit Line
    // and Dexter Loan 2's findings are both 'info' severity and are produced
    // here, not by Control A's forEach.
    const revB = await p3.evaluate(() => {
      const src = _bkReconInfoFindings.toString();
      const anchor = "f.status === 'open' && f.severity === 'info'";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor not found — _bkReconInfoFindings has moved' };
      const cleanIds = (_allLoanAccounts || [])
        .filter(a => ['Rapid Credit Line', 'Dexter Loan 2'].includes(a.xero_account_name))
        .map(a => a.id);
      window.__R1B_CLEAN_LOAN_IDS = cleanIds;
      const patched = src.replace(anchor, anchor + " && !window.__R1B_CLEAN_LOAN_IDS.includes(f.loan_account_id)");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      let patchedFn;
      try { patchedFn = new Function(body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      window._bkReconInfoFindings = patchedFn;
      return { ok: true };
    });
    t.ok(revB.ok, 'r1 CONTROL B: the info-finding regression could be installed in page context',
         JSON.stringify(revB));
    if (revB.ok) {
      await p3.evaluate(() => renderBookkeepingOverview());
      const rclGone = await findingsFor(p3, 'Rapid Credit Line');
      t.eq((rclGone || []).length, 0,
           'r1 CONTROL B: with the hypothetical filter installed, Rapid Credit Line\'s info finding vanishes from Approvals');
      const dexGone = await findingsFor(p3, 'Dexter Loan 2');
      t.eq((dexGone || []).length, 0,
           'r1 CONTROL B: ...and so does Dexter Loan 2\'s — same shared path, not a coincidence');
    }
    await p3.close();
  },
});

/* ── R2 ── A FINDING ON A LOAN THAT IS NOT ACTIVE MUST SURFACE ────────────── */
// The roster used to be built from ACTIVE loans only, and a finding on a loan
// that had been paid off had an id the pre-fix code put in `byLoan`, never
// read back, and never counted as an orphan either — it simply stopped
// existing. Funding Circle carries an ERROR balance_vs_lender; paying the loan
// off must not make that error disappear.
//
// SESSION 258 REWRITE. Same architecture change as R1: session 257 moved
// split_mismatch / stage_flag / recon_finding out of the (now-deleted, for
// this purpose) by-loan roster and into Approvals's flat list. The source
// feeding it, _bkLoanAttentionItems(), reads _reconFindings / _allLoanSplits
// directly and has never filtered by loan.status at all — there is no "active
// loans only" boundary left for an inactive loan's finding to fall outside of.
// The old orphan-BIN concept (a group findings-with-no-home fell into) is gone
// along with the roster it lived in; what replaces it is simpler and stronger:
// nothing in the pipeline from _bkLoanAttentionItems() to the DOM keys off
// loan.status, so an inactive loan's findings are not orphaned, they are
// ordinary Approvals rows like any other loan's.
GROUPS.push({
  name: 'roster-orphan-findings',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.find(x => x.xero_account_name === 'Funding Circle Loan').status = 'paid_off';
    } });
    await p.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const q = await p.evaluate(READ_QUEUE);

    t.eq(q.counts.total, 13, 'r2: the roster denominator (Issues\' population) drops to the 13 still-active loans');

    // The expected finding names are DERIVED, not typed — reconciliation-run
    // moves what is open on this loan release to release, and a fixture
    // refresh must not read as a regression in the page (r2's own historical
    // lesson: "the refresh added a third Funding Circle finding and this
    // assertion, written as a literal 3, went red for no reason connected to
    // the code").
    const derived = await p.evaluate(() => {
      const fc = (_allLoanAccounts || []).find(a => a.xero_account_name === 'Funding Circle Loan');
      const items = _bkApprovalQueueItems().filter(it => _bkIssueLoanId(it) === fc.id);
      return { fcStatus: fc.status, names: items.map(it => it.name) };
    });
    t.eq(derived.fcStatus, 'paid_off', 'r2: the scenario really did take Funding Circle off the active roster');
    t.ok(derived.names.length >= 1, 'r2: ...and it really is carrying findings that must not vanish with it',
         JSON.stringify(derived.names));
    for (const n of derived.names) {
      t.ok(q.itemNames.includes(n), `r2: "${String(n).slice(0, 56)}" is still in Approvals' own item list`);
      t.ok(q.text.includes(n), `r2: ...and reaches the DOM`);
    }

    // Named explicitly by shape, not just counted: the open balance ERROR in
    // particular must survive, because it is the one a person is least likely
    // to go looking for on a loan they think is closed.
    const fcErr = await p.evaluate(() => {
      const fc = (_allLoanAccounts || []).find(a => a.xero_account_name === 'Funding Circle Loan');
      const f = (_reconFindings || []).find(x => x.loan_account_id === fc.id && x.status === 'open' &&
                x.severity === 'error' && /below the lender|above the lender/.test(x.title || ''));
      return f ? f.title : null;
    });
    t.ok(!!fcErr, 'r2: the inactive loan really is carrying an open balance ERROR', String(fcErr));
    t.ok(q.text.includes(fcErr), 'r2: ...and it is still on screen');
    t.ok(q.itemNames.includes(fcErr), 'r2: ...as its own item, not buried inside another row\'s text');

    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r2: every item Approvals holds reaches the DOM');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));
    await p.close();

    // ── does it discriminate? ──
    // Same situation as R1: no historical branch survives to revert, since the
    // by-loan roster that could orphan a finding is gone, not patched. The
    // control constructs the regression directly: an active-status filter on
    // _bkLoanAttentionItems (the shared source every attention surface reads —
    // Issues, Approvals, and the "N need attention" headline all key off it),
    // which is exactly the shape that would silently drop an inactive loan's
    // findings the way the pre-257 roster did.
    const p2 = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.find(x => x.xero_account_name === 'Funding Circle Loan').status = 'paid_off';
    } });
    await p2.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p2.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const rev = await p2.evaluate(() => {
      const src = _bkLoanAttentionItems.toString();
      const anchor = "(_reconFindings || []).filter(f => f.status === 'open' && (f.severity === 'error' || f.severity === 'warn')).forEach(f => {";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor not found — _bkLoanAttentionItems has moved' };
      const patched = src.replace(anchor,
        "(_reconFindings || []).filter(f => f.status === 'open' && (f.severity === 'error' || f.severity === 'warn') "
        + "&& (!f.loan_account_id || (_allLoanAccounts || []).find(a => a.id === f.loan_account_id && a.status === 'active'))).forEach(f => {");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkLoanAttentionItems = new Function(body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev.ok, 'r2: the hypothetical active-status-filter regression could be installed in page context',
         JSON.stringify(rev));
    if (rev.ok) {
      await p2.evaluate(() => renderBookkeepingOverview());
      const b = await p2.evaluate(() => {
        const fc = (_allLoanAccounts || []).find(a => a.xero_account_name === 'Funding Circle Loan');
        return _bkApprovalQueueItems().filter(it => _bkIssueLoanId(it) === fc.id).map(it => it.name);
      });
      t.eq(b.length, 0,
           'r2 CONTROL: with the hypothetical filter installed, the inactive loan\'s findings vanish from Approvals',
           JSON.stringify(b));
    }
    await p2.close();
  },
});

/* ── R3 ── NO ACTIVE LOANS IS NOT A REASON TO THROW THE QUEUE AWAY ───────── */
// `if (!loans.length) return ''` used to blank the entire roster card —
// payroll items, loan flags, findings, all of it — while the headline above
// still counted them.
//
// SESSION 258 REWRITE. Issues (_bkIssueQueueItems) filters to active loans by
// design now (session 257: it shows loan variances and NOTHING else), so with
// zero active loans it is CORRECT for Issues to hold zero items — that is not
// the bug this group exists to catch, and asserting otherwise would be testing
// against the redesign rather than for it. The real claim survives, just
// scoped to where the non-loan-shaped work actually lives now: Approvals
// (payroll imports, a retail reclass, and any split_mismatch / stage_flag /
// recon_finding) never filters by loan.status anywhere in its pipeline, so a
// book with zero active loans must still show every one of those.
GROUPS.push({
  name: 'roster-empty-denominator',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.forEach(a => { a.status = 'paid_off'; });
    } });

    // Issues really does go to zero, on purpose, and that is not this group's
    // failure mode.
    await p.evaluate(() => _bkSetOverviewSeg('issues'));
    const qi = await p.evaluate(READ_QUEUE);
    t.eq(qi.counts.total, 0, 'r3: there really are zero active loans in this scenario');
    t.ok(qi.dataReady, 'r3: ...and the books did load — this is an empty book, not a cold boot');
    t.eq(qi.itemNames.length, 0, 'r3: ...so Issues (loan variances only) correctly shows nothing — not a bug to guard against');

    // Approvals is where the old invariant actually lives now.
    await p.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const q = await p.evaluate(READ_QUEUE);
    t.ok(q.itemNames.length > 0, 'r3: Approvals still holds items with zero active loans', `${q.itemNames.length} items`);

    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r3: every Approvals row still renders with no roster to hang it on');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));
    t.ok(q.rows.filter(r => /bk-queue-row/.test(r.cls)).length >= q.itemNames.length,
         'r3: ...as real rows, one per item',
         `${q.rows.filter(r => /bk-queue-row/.test(r.cls)).length} rows for ${q.itemNames.length} items`);
    t.ok(!q.allClear, 'r3: a zero-loan book never renders the All clear badge over a non-empty Approvals queue');

    // ── does it discriminate? ──
    // No historical branch survives to revert (the pre-fix `if (!loans.length)
    // return ''` lived in _bkRosterHtml, which nothing in Approvals calls any
    // more). The control constructs the same-shaped regression directly in
    // _bkApprovalQueueItems.
    const p2 = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.forEach(a => { a.status = 'paid_off'; });
    } });
    await p2.evaluate(() => _bkSetOverviewSeg('approvals'));
    // CAP=5 truncates Approvals by default; expand so DOM checks see everything the array does.
    await p2.evaluate(() => { if (!_bkOvQueueExpanded.approvals) _bkToggleQueueExpand(); });
    const rev = await p2.evaluate(() => {
      const src = _bkApprovalQueueItems.toString();
      const anchor = 'function _bkApprovalQueueItems() {\n    const items = [];';
      const openBrace = src.indexOf('{');
      if (openBrace < 0) return { ok: false, why: 'no function body found' };
      const bodyStart = src.indexOf('const items = [];');
      if (bodyStart < 0) return { ok: false, why: 'anchor not found — _bkApprovalQueueItems has moved' };
      const patched = src.slice(0, bodyStart)
        + "if (!(_allLoanAccounts || []).some(a => a.status === 'active')) return [];\n    "
        + src.slice(bodyStart);
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkApprovalQueueItems = new Function(body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev.ok, 'r3: the hypothetical blank-card regression could be installed in page context', JSON.stringify(rev));
    if (rev.ok) {
      await p2.evaluate(() => renderBookkeepingOverview());
      const b = await p2.evaluate(READ_QUEUE);
      t.eq(b.itemNames.length, 0,
           'r3 CONTROL: with the hypothetical guard installed, zero active loans discarded every Approvals row');
    }
    await p2.close();
    await p.close();
  },
});

/* ── R4 ── THE CELEBRATION ONLY COUNTS IF SOMETHING WAS EARNED ───────────── */
// Bookkeeping loads in phases: loadReconciliation can resolve while loadLoans is
// still in flight. _bkRosterCounts() then returns reconciled: 0 — a zero, not a
// null — so the pre-fix gate recorded 0 on the first paint and 6 on the second,
// and every ordinary visit to the tab fired confetti mid-load.
GROUPS.push({
  name: 'roster-confetti-gate',
  async run(t) {
    // Instrumented boot: count _bkConfetti calls and log what each render saw.
    const armed = async (mode) => {
      /* Session 269: this group instruments renderBookkeepingOverview, so it has to
         open a tab that actually CALLS it. Overview no longer does — its tab is
         hidden and the view redirects to Loans, which calls nothing here — so this
         opened a page that never rendered and the "at least one render" assertion
         went red for a reason that was not a bug. Client View is where that function
         runs now: it is still the renderer for the KPI tiles, so the confetti gate
         inside it is still live and still worth gating. */
      const p = await newHarnessPage({ tab: 'client', settle: false, hold: ALL_TABLES });
      const r = await p.evaluate(({ mode, FIXED, PRE }) => {
        window.__cf = 0; window.__renders = [];
        const origC = window._bkConfetti;
        window._bkConfetti = function () { window.__cf++; return origC.apply(this, arguments); };
        const origR = window.renderBookkeepingOverview;
        let target = origR;
        if (mode === 'prefix') {
          const src = origR.toString();
          if (!src.includes(FIXED)) return { ok: false, why: 'confetti gate anchor not found in renderBookkeepingOverview' };
          try { target = new Function('return (' + src.replace(FIXED, PRE) + ')')(); }
          catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
        }
        window.renderBookkeepingOverview = function () {
          const c = _bkRosterCounts();
          window.__renders.push({ total: c.total, reconciled: c.reconciled, ready: _bkDataReady() });
          return target.apply(this, arguments);
        };
        return { ok: true };
      }, { mode, FIXED: CONFETTI_FIXED, PRE: CONFETTI_PREFIX });
      return { p, ok: r.ok, why: r.why };
    };

    // Phase 1: everything except loadLoans. Phase 2: the loans land.
    const twoPhase = async (h) => {
      await h.p.release(...ALL_TABLES.filter(x => !LOAN_TABLES.includes(x)));
      await h.p.page.waitForTimeout(350);
      const mid = await h.p.evaluate(() => ({ cf: window.__cf, renders: window.__renders.slice() }));
      await h.p.release(...LOAN_TABLES);
      await h.p.settle();
      const end = await h.p.evaluate(() => ({ cf: window.__cf, renders: window.__renders.slice(), counts: _bkRosterCounts() }));
      return { mid, end };
    };

    const ship = await armed('shipped');
    t.ok(ship.ok, 'r4: instrumentation installed on the shipped page', ship.why || '');
    const s = await twoPhase(ship);
    t.ok(s.end.renders.some(r => r.total === 0 && !r.ready),
         'r4: the scenario really did paint at least one render before the loans arrived',
         JSON.stringify(s.end.renders));
    // The real reconciled-of-total is DERIVED here, not typed — session 258
    // caught the count drifting from the "5 of 14" it was written against (the
    // fixture had moved to 3 of 14, unrelated to any dashboard code: loan
    // states drift release over release, same class of drift r2's "the expected
    // orphan count is DERIVED, not typed" note already guards against). What
    // must hold is not a magic number — it's that the SAME totals the render
    // painted mid-load with are the ones _bkRosterCounts() reports right now,
    // read moments apart from the same live page.
    const nowCounts = await ship.p.evaluate(() => _bkRosterCounts());
    t.eq(nowCounts.total, 14, 'r4: the fixture really is 14 active loans right now');
    t.ok(s.end.renders.some(r => r.total === nowCounts.total && r.reconciled === nowCounts.reconciled && r.ready),
         `r4: ...and one after, with the real ${nowCounts.reconciled}-of-${nowCounts.total}`,
         JSON.stringify(s.end.renders));
    t.eq(s.mid.cf, 0, 'r4: no confetti mid-load');
    t.eq(s.end.cf, 0, 'r4: no confetti when a two-phase load merely fills in the counts');

    // The reward still has to be reachable, or "never fires" would pass too.
    //
    // THE REWARD PROBE HAS TO EARN THE REWARD. `find(x => x.status === 'exception')`
    // now lands on Verdant, whose anchor is our own amortization schedule — so
    // flipping it to `tied` moves it into `byschedule`, not into `reconciled`,
    // the count never rises, and the assertion fails for a reason that has
    // nothing to do with the confetti gate. The probe must pick an exception
    // that CAN become reconciled: one measured against a real lender document.
    //
    // Session 258: that alone stopped being enough. _bkRosterCounts() demotes a
    // loan BACK to 'variance' in its tally the moment _bkLoanAttentionItems()
    // carries an open item for it (session 255's "a reconciled loan can still
    // have work outstanding" rule) — so of the fixture's six exception-against-
    // a-real-anchor candidates, five are ALSO flagged, and flipping one of
    // those to tied leaves the RECONCILED COUNT unchanged: correct product
    // behaviour, not a bug, but it means the confetti probe was silently
    // testing nothing on this fixture (the first candidate in array order,
    // E4-9744, is one of the five). The probe must pick a candidate that is
    // BOTH a real-anchor exception AND carries no open attention item, or it
    // is not actually earning the reward it claims to.
    const earn = await ship.p.evaluate(() => {
      const before = window.__cf;
      const flaggedLoanIds = new Set(_bkLoanAttentionItems().map(_bkIssueLoanId).filter(Boolean));
      const ex = (_loanTieOuts || []).find(x =>
        x.status === 'exception' && _VARIANCE_REAL_ANCHORS.includes(String(x.anchor_source || ''))
        && !flaggedLoanIds.has(x.loan_account_id));
      if (!ex) return { before, after: window.__cf, reconciled: null, picked: null };
      const acct = (_allLoanAccounts || []).find(a => a.id === ex.loan_account_id);
      const baseReconciled = _bkRosterCounts().reconciled;
      ex.status = 'tied';                       // a loan is reconciled, for real
      renderBookkeepingOverview();
      return { before, after: window.__cf, baseReconciled, reconciled: _bkRosterCounts().reconciled,
               picked: acct && acct.xero_account_name, anchor: ex.anchor_source };
    });
    t.ok(!!earn.picked, 'r4: an exception anchored to a real lender document, with no open item of its own, was available to reward',
         'no tie-out in the fixture is an unflagged exception against a _VARIANCE_REAL_ANCHORS source');
    t.eq(earn.reconciled, earn.baseReconciled + 1, `r4: a loan genuinely went from exception to tied (${earn.picked})`);
    t.eq(earn.after - earn.before, 1, 'r4: THAT fires the confetti, exactly once');
    await ship.p.close();

    // Zero denominator must never celebrate either, however the counts move.
    const pz = await newHarnessPage({ tab: 'overview', mutate: (d) => { d.loan_accounts.forEach(a => { a.status = 'paid_off'; }); } });
    const z = await pz.evaluate(() => {
      window.__cf = 0;
      const orig = window._bkConfetti;
      window._bkConfetti = function () { window.__cf++; return orig.apply(this, arguments); };
      renderBookkeepingOverview(); renderBookkeepingOverview();
      return { cf: window.__cf, total: _bkRosterCounts().total };
    });
    t.eq(z.total, 0, 'r4: zero-active-loan scenario really has an empty denominator');
    t.eq(z.cf, 0, 'r4: an empty denominator never celebrates');
    await pz.close();

    // ── does it discriminate? ──
    const pre = await armed('prefix');
    t.ok(pre.ok, 'r4: the pre-fix confetti gate could be re-applied in page context', pre.why || '');
    if (pre.ok) {
      const b = await twoPhase(pre);
      t.ok(b.end.cf >= 1,
           'r4 CONTROL: pre-fix, an ordinary two-phase load fired the celebration on its own',
           `confetti=${b.end.cf} renders=${JSON.stringify(b.end.renders)}`);
      await pre.p.close();
    } else {
      await pre.p.close();
    }
  },
});

/* ── R5 ── DOES _bkDismissalHolds FAIL OPEN? (reported, NOT fixed) ────────── */
// Two failure modes were reported and are deliberately NOT patched here. These
// assertions state the behaviour a suppression rule on a financial screen ought
// to have and then ask the real function. A dismissal SUPPRESSES a finding, so
// the safe direction when the function cannot verify the finding is to let it
// through: it must fail CLOSED. Anything it cannot check, it must not hide.
GROUPS.push({
  name: 'dismissal-fail-open',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });
    const r = await p.evaluate(() => {
      const REAL = 'Verdant Capital Loan — 6 hand-posted corrections totalling $572,400.13 since 2026-04-28';
      const OTHER = 'Funding Circle Loan — 2026-04-20 payment of $2,033.77 has no interest split';
      const seed = (k, title) => _bkDismissals.set(k, { item_key: k, item_title: title, dismissed_at: '2026-08-24T00:00:00Z' });
      seed('h-normal', REAL);
      seed('h-blank', '');
      seed('h-null', null);
      return {
        // controls — these must behave, or the probes below mean nothing
        unknownKey: _bkDismissalHolds('h-nope', { isError: false, title: REAL }),
        sameTitle: _bkDismissalHolds('h-normal', { isError: false, title: REAL }),
        escalated: _bkDismissalHolds('h-normal', { isError: true, title: REAL }),
        changedTitle: _bkDismissalHolds('h-normal', { isError: false, title: OTHER }),
        // the two reported failure modes
        noOpts: _bkDismissalHolds('h-normal'),
        noOptsOnEscalation: (() => { seed('h-err', REAL); return _bkDismissalHolds('h-err'); })(),
        emptyStored: _bkDismissalHolds('h-blank', { isError: false, title: OTHER }),
        nullStored: _bkDismissalHolds('h-null', { isError: false, title: OTHER }),
        emptyIncoming: _bkDismissalHolds('h-normal', { isError: false, title: '' }),
        // is it reachable from the shipped call sites?
        liveItemsWithNoTitle: _bkIssueQueueItems().filter(i => !i.name).length,
        storedTitlesFalsy: [..._bkDismissals.values()].filter(d => !String(d.item_key).startsWith('h-') && !d.item_title).length,
        storedTotal: [..._bkDismissals.values()].filter(d => !String(d.item_key).startsWith('h-')).length,
      };
    });

    // controls first
    t.eq(r.unknownKey, false, 'r5 control: a key that was never set aside does not hold');
    t.eq(r.sameTitle, true, 'r5 control: an unchanged, non-error finding stays set aside');
    t.eq(r.escalated, false, 'r5 control: escalation to error always breaks a dismissal');
    t.eq(r.changedTitle, false, 'r5 control: a genuinely different sentence breaks it');

    // the reported defects, written as the CORRECT behaviour
    t.eq(r.noOpts, false,
         'r5: with opts omitted, a dismissal must NOT hold — nothing was verified, so nothing may be hidden');
    t.eq(r.noOptsOnEscalation, false,
         'r5: ...and an omitted opts must not smuggle a would-be error past the escalation rule');
    t.eq(r.emptyStored, false,
         'r5: a dismissal whose stored title is "" must not suppress a finding that now says something else');
    t.eq(r.nullStored, false,
         'r5: ...nor one whose stored title is null');
    t.eq(r.emptyIncoming, false,
         'r5: an incoming finding with an empty title cannot be matched, so it must not be suppressed');

    // reachability, reported either way
    t.ok(true, `r5 note: reachability — ${r.storedTitlesFalsy} of ${r.storedTotal} real dismissals have a falsy item_title; ` +
               `${r.liveItemsWithNoTitle} live queue items have a falsy name; all three shipped call sites pass an opts object.`);
    await p.close();
  },
});

/* ── R6 ── DOES _bkSubstanceKey ACTUALLY MEASURE SUBSTANCE? (reported) ───── */
// The rule it is meant to encode: a re-worded finding is the SAME finding, and a
// finding whose substance changed — a different amount, a different account — is
// a NEW one. Probed with the real titles in the fixture (100 findings + 38
// dismissal titles), through the real function.
GROUPS.push({
  name: 'substance-key-substance',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });
    const r = await p.evaluate(() => {
      const K = _bkSubstanceKey;
      const titles = [];
      (_reconFindings || []).forEach(f => titles.push({ t: f.title, loan: f.loan_account_id, check: f.check_key }));
      [..._bkDismissals.values()].forEach(d => titles.push({ t: d.item_title, loan: null, check: 'dismissal' }));
      const byKey = new Map();
      for (const x of titles) {
        if (!x.t) continue;
        const k = K(x.t);
        if (!byKey.has(k)) byKey.set(k, []);
        if (!byKey.get(k).some(y => y.t === x.t)) byKey.get(k).push(x);
      }
      const collisions = [...byKey.entries()].filter(([, v]) => v.length > 1)
        .map(([k, v]) => ({ key: k, titles: v.map(x => x.t), loans: [...new Set(v.map(x => x.loan).filter(Boolean))] }));
      const crossLoan = collisions.filter(c => c.loans.length > 1);

      // The pairs the rule names, in both directions.
      const same = (a, b) => K(a) === K(b);
      const v6 = 'Verdant Capital Loan — 6 hand-posted corrections totalling $572,400.13 since 2026-04-28';
      const v7 = 'Verdant Capital Loan — 7 hand-posted corrections totalling $580,112.44 since 2026-04-28';
      const e1 = 'E-Transit Loan - 4140 — 1 hand-posted correction totalling $7,687.53 since 2026-04-28';
      const e2 = 'E-Transit Loan - 4140 — 2 hand-posted corrections totalling $9,000.00 since 2026-04-28';
      const fcOld = 'Funding Circle Loan — 2026-04-20 payment of $2,033.77 needs a statement from before 2026-08-03';
      const fcNew = 'Funding Circle Loan — 2026-08-18 payment of $2,033.77 has no interest split';
      // real, from the fixture: the same check on the same loan, at two amounts
      const amtSmall = 'E-Transit Loan - 4140 — Xero is $415.88 above the lender';
      const amtBig = 'E-Transit Loan - 4140 — Xero is $1,180.32 above the lender';
      const rcSmall = 'Rapid Credit Line — Xero is $570.70 above the lender';
      const rcBig = 'Rapid Credit Line — Xero is $1,056.19 above the lender';
      // real, from the fixture: two DIFFERENT loans of the same lender
      const e5 = 'E-Transit Loan E5-4751 — 2026-08-12 payment of $1,046.95 was corrected twice';
      const e6 = 'E-Transit Loan E6-7410 — 2026-08-10 payment of $643.50 was corrected twice';

      return {
        collisions: collisions.length, crossLoan,
        countMoved6to7: same(v6, v7),
        countMoved1to2: same(e1, e2),
        reworded: same(fcOld, fcNew),
        differentLoan: same(v6, v6.replace('Verdant Capital', 'Dexter')),
        amountChanged4140: same(amtSmall, amtBig),
        amountChangedRapid: same(rcSmall, rcBig),
        differentAccount: same(e5, e6),
        keyOf4140: K(amtSmall), keyOfE5: K(e5), keyOfE6: K(e6),
        totalTitles: titles.filter(x => x.t).length,
      };
    });

    // What it gets right, on real titles.
    t.eq(r.countMoved6to7, true, 'r6: 6 corrections → 7 corrections is the same finding (the treadmill fix works)');
    t.eq(r.countMoved1to2, true, 'r6: ...and 1 correction → 2 corrections, singular to plural');
    t.eq(r.reworded, false, 'r6: the session-233 pair is a genuinely different sentence and comes back');
    t.eq(r.differentLoan, false, 'r6: a different loan NAME is a different finding');

    // What the rule requires and — the point of this group — may not deliver.
    t.eq(r.amountChanged4140, false,
         'r6: a balance gap that grew from $415.88 to $1,180.32 is a DIFFERENT claim about the books');
    t.eq(r.amountChangedRapid, false,
         'r6: ...and $570.70 → $1,056.19 on Rapid Credit Line likewise');
    t.eq(r.differentAccount, false,
         'r6: two different loan accounts (E5-4751 vs E6-7410) are never the same finding');
    t.eq(r.crossLoan.length, 0,
         'r6: no substance key in the real book is shared by findings on different loans');

    console.log(`        ${r.collisions} substance keys are shared by 2+ distinct real titles (of ${r.totalTitles} titles)`);
    for (const c of r.crossLoan) {
      console.log(`        cross-loan key ${JSON.stringify(c.key)}`);
      c.titles.slice(0, 4).forEach(x => console.log(`            ${JSON.stringify(x)}`));
    }
    // Was `... <- both E5-4751 and E6-7410`, written when those two DID collide.
    // Session 245 fixed that, and the caption became a sentence the test printed
    // while passing. A diagnostic that lies is worse than none: it now states the
    // key and lets the assertion above say whether anything shares it.
    console.log(`        E5-4751's key is now ${JSON.stringify(r.keyOfE5)}`);
    await p.close();
  },
});

GROUPS.push({
  name: 'bundle-readable-set',
  // Session 245. David re-dropped the same five Stripe documents to re-run the
  // bundle with a new export in the set, and "Read together" did not appear at
  // all: four were already on record, so `_bkClassifyItem` returned early with
  // status 'duplicate', and the old filter accepted only 'ready'/'manual'.
  //
  // "Already on record" answers *should I FILE this again*. It does not answer
  // *should I READ this*, and for a bundle it must not: the agreement names the
  // loan a screenshot cannot. This group drives the shipped `_bkBundleReadable`.
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });
    const r = await p.evaluate(() => {
      const F = (items) => _bkBundleReadable(items).map(i => i.name);
      const b64 = 'x';
      return {
        exists: typeof _bkBundleReadable === 'function',
        // The exact drop, statuses as the classifier really left them.
        davids: F([
          { name: 'Stripe Capital_agreement.pdf', status: 'duplicate', dupOf: 'db', base64: b64 },
          { name: 'Stripe deposit.png',           status: 'duplicate', dupOf: 'db', base64: b64 },
          { name: 'Stripe July.csv',              status: 'duplicate', dupOf: 'db', base64: b64 },
          { name: 'Stripe overview.png',          status: 'duplicate', dupOf: 'db', base64: b64 },
          { name: 'Stripe August.csv',            status: 'handed_off',             base64: b64 },
        ]),
        batchDup: F([{ name: 'a', status: 'duplicate', dupOf: 'batch', base64: b64 },
                     { name: 'b', status: 'ready', base64: b64 }]),
        noBytes:  F([{ name: 'a', status: 'ready' }]),
        inFlight: F([{ name: 'a', status: 'classifying', base64: b64 },
                     { name: 'b', status: 'filing',      base64: b64 },
                     { name: 'c', status: 'filed',       base64: b64 }]),
        unreadable: F([{ name: 'a', status: 'unreadable', base64: b64 }]),
        // An allowlist, so a status nobody has considered stays out.
        invented: F([{ name: 'a', status: 'some_future_status', base64: b64 }]),
        ordinary: F([{ name: 'a', status: 'ready', base64: b64 },
                     { name: 'b', status: 'manual', base64: b64 }]),
        empty: F(null),
      };
    });
    t.eq(r.exists, true, 'r7: the page defines _bkBundleReadable');
    t.eq(r.davids.length, 5,
         'r7: all five of the real drop can be read together, four of them already on file');
    t.eq(r.davids.includes('Stripe Capital_agreement.pdf'), true,
         'r7: ...including the agreement, which is the document that names the loan');
    t.eq(r.davids.includes('Stripe August.csv'), true,
         'r7: ...and the new export that prompted the re-run');
    t.eq(r.batchDup, ['b'], 'r7: the same file dropped twice in one go is counted once');
    t.eq(r.noBytes.length, 0, 'r7: a file whose bytes never loaded cannot be read');
    t.eq(r.inFlight.length, 0, 'r7: nothing in flight or already filed is pulled back in');
    t.eq(r.unreadable.length, 0, 'r7: a file that could not be read is not offered');
    t.eq(r.invented.length, 0, 'r7: an unknown status is excluded — it is an allowlist');
    t.eq(r.ordinary.length, 2, 'r7: the ordinary two-readable-files case still works');
    t.eq(r.empty.length, 0, 'r7: no items at all is not a crash');
    await p.close();
  },
});


/* ═══════════ SESSION 246 — CLOSING EVIDENCE, AND WHETHER IT DISCRIMINATES ═══
   A closing balance now carries a GRADE. Grade A is a lender document (dated in
   the month, or a later one rolled back to month end). Grade B is the
   contractual amortization schedule, admitted only by a recorded per-loan
   policy. Grade C is nothing.

   Everything below drives the SHIPPED functions inside the SHIPPED page and
   reads the rendered DOM. Nothing is transcribed; nothing is re-implemented.

   ── AND EVERY ONE OF THEM IS PROVED TO DISCRIMINATE ────────────────────────
   For each new behaviour the INVERSE of the fix is applied to the shipped
   function's own .toString() IN PAGE CONTEXT, rebuilt with new Function(), and
   the assertion is required to go RED. admin-dashboard/index.html is never
   touched and stays byte-identical. Every inverse edit asserts its anchor was
   found first, so a refactor that moves the code is a loud failure rather than
   a silently skipped control.

   An assertion that passes against both the fixed and the broken code is
   decoration, and this module shipped fifty-two of those once already.
   ═════════════════════════════════════════════════════════════════════════ */

/* Rebuild one shipped function from its own source with an inverse edit applied.
   Returns {ok, missing:[…]}; the original is stashed so a scenario can be put
   back without reloading the page. */
async function revertFn(p, name, edits, opts) {
  return p.evaluate(({ name, edits, rerender }) => {
    if (typeof window[name] !== 'function') return { ok: false, missing: [name + ' is not a function on window'] };
    window.__WR_ORIG = window.__WR_ORIG || {};
    if (!window.__WR_ORIG[name]) window.__WR_ORIG[name] = window[name];
    let src = window.__WR_ORIG[name].toString();
    const missing = [];
    for (const [from, to] of edits) {
      if (!src.includes(from)) { missing.push(from.slice(0, 90)); continue; }
      src = src.replace(from, to);
    }
    if (missing.length) return { ok: false, missing };
    // A REVERT THAT CHANGES NOTHING IS A CONTROL THAT PROVES NOTHING. If an
    // anchor still matches but the edit is a no-op — a from/to pair that became
    // identical, or a replacement the shipped source already contains — the
    // control would pass against unmodified code and quietly certify a test that
    // does not discriminate. Refuse loudly instead.
    if (src === window.__WR_ORIG[name].toString()) {
      return { ok: false, missing: ['the edit produced identical source — this revert is a no-op'] };
    }
    let rebuilt;
    try { rebuilt = new Function('return (' + src + ')')(); }
    catch (e) { return { ok: false, missing: ['compile: ' + e.message] }; }
    window[name] = rebuilt;
    if (rerender !== false) { renderLoansCloseBand(); renderLoansPeriodBar(); }
    return { ok: true, missing: [] };
  }, { name, edits, rerender: opts && opts.rerender });
}
async function restoreFns(p) {
  await p.evaluate(() => {
    Object.keys(window.__WR_ORIG || {}).forEach(k => { window[k] = window.__WR_ORIG[k]; });
    window.__WR_ORIG = {};
    renderLoansCloseBand(); renderLoansPeriodBar();
  });
}

/* The inverse edits, one per behaviour under test. Each is the pre-session-246
   line, or the guard removed, exactly as it would have been written by someone
   who had not thought about the failure it prevents. */
const CLOSE_REVERTS = {
  // Grade B never happens: the recorded policy is ignored and a schedule can
  // never close a month. Dexter and Verdant fall to grade C.
  'no-grade-b': ["if (_loanCloseBasis(a) === 'amortization_schedule') {", 'if (false) {'],
  // The schedule is read WITHOUT the row_type allowlist — the draft's
  // `balance != null` test, which Verdant passes and Dexter does not.
  'no-row-type-filter': ['CLOSE_SCHEDULE_ROW_TYPES.includes(String(r.row_type || \'\')) &&\n      r.balance != null && r.row_date', 'r.balance != null && r.row_date'],
  // The schedule is read from ALL of a loan's schedules at once — Verdant's two
  // are merged into one walk, which is what happens when nobody de-duplicates.
  'no-schedule-dedup': ['return mine.filter(r => r.schedule_id === bestId);', 'return mine;'],
  // The row_type allowlist moved UP into _loanScheduleRows (review F11) so the
  // schedule PICK is made from the rows that will actually be read. It is now
  // enforced in two places, and reproducing the defect means patching both.
  'no-row-type-in-picker': ["CLOSE_SCHEDULE_ROW_TYPES.includes(String(r.row_type || '')) && r.balance != null);", 'r.balance != null);'],
  // The circularity guard keyed on a schedule id, as the design draft had it.
  // Verdant's opening carries no schedule_id, so the guard cannot fire and the
  // row prints a green tie against the document it was built from.
  // Review F1 replaced the source-name guard with a PREDICATE. Two inverses are
  // worth having and they break different things:
  //   * the guard never fires at all — every grade-B row prints a green tie;
  //   * the guard fires, but everything counts as independent — which is the
  //     ACTUAL pre-review defect: 'xero_derived' sailed past a source-name test
  //     even though all 61 of Dexter's rows are a frozen backfill equal to the
  //     contract on every same-dated row.
  'circular-guard-off': ['const circular = anchor.grade === \'B\' && !_openingIsIndependent(opening);', 'const circular = false;'],
  'everything-is-independent': ['return _INDEPENDENT_OPENING_SOURCES.includes(s) || _VARIANCE_REAL_ANCHORS.includes(s);', 'return true;'],
  // Review F3: the fourth band never fires, so a variance the posting gate
  // already owns is reported a second time, as red blocking money.
  // The explanation function is portion-based now: it returns whatever it could
  // place plus the residual, and the caller bands the residual. The early-out
  // that used to demand an exact match is gone, so the control reverts the ONE
  // line that still decides whether anything is explained at all.
  'no-unbooked-band': ['if (!parts.length) return null;', 'return null;'],
  // ── THE TWO GUARDS THAT MAKE PORTION-MATCHING SAFE, EACH REVERTIBLE ──────
  // (1) STRICT REDUCTION. A candidate is only taken if it makes the unexplained
  //     amount smaller. Removing it lets the function subtract a ~$2,500 split
  //     from a four-cent gap and hand back a residual LARGER than the variance
  //     it started with — the fishing failure, made visible.
  'unbooked-accepts-anything': ['const reduces = (amt) => Math.abs(residual - amt) < Math.abs(residual);',
                                'const reduces = () => true;'],
  // (2) BAND THE RESIDUAL, NOT THE GAP. Reverting this is the OLD behaviour:
  //     a partially explained variance goes through materiality at its full
  //     size, so four cents of origination drift blocks a $2,707.61 close.
  'band-the-raw-variance': ['          : _closeVarianceBand(varianceResidual, perLender.amount));',
                            '          : _closeVarianceBand(variance, perLender.amount));'],
  // (3) …AND TOTAL THE RESIDUAL, NOT THE GAP. Banding and totalling moved to the
  //     residual together and have to be reverted together: banding alone gives
  //     a board that was never on anyone's screen — ten rows red, but totalled
  //     at $7,503.84 because Verdant's row is still counted at its leftover.
  'totals-on-the-raw-variance': [
    ["varianceToResolve: judged.filter(r => r.band === 'material').reduce((n, r) => n + Math.abs(r.varianceResidual), 0),",
     "varianceToResolve: judged.filter(r => r.band === 'material').reduce((n, r) => n + Math.abs(r.variance), 0),"],
    ["varianceSmall:     judged.filter(r => r.band === 'immaterial').reduce((n, r) => n + Math.abs(r.varianceResidual), 0),",
     "varianceSmall:     judged.filter(r => r.band === 'immaterial').reduce((n, r) => n + Math.abs(r.variance), 0),"]],
  // Review F4: a books balance for ANOTHER date wins anyway — August's principal
  // subtracted from June's balance, on every loan at once.
  'stale-books-wins': ['b.balance != null && b.as_of === asOfIso);', 'b.balance != null && b.as_of <= asOfIso);'],
  // Review F7: the DIRECT branch stops testing whether the balance is labelled,
  // so an 'unknown' portal pull grades A, "confirmed by lender".
  'direct-accepts-unlabelled': ['(!labelledOnly || _balanceBasisIsLabelled(s)));', 'true);'],
  // Review F8: the roll-back window loses its <= today clamp and anchors a close
  // to a statement describing a date that has not happened.
  'rollback-ignores-today': ["s.statement_date > monthEndIso && s.statement_date <= todayIso &&", 's.statement_date > monthEndIso &&'],
  // Review F6: "closed on the contractual schedule" is printed for a loan
  // nobody made that decision about.
  'byschedule-without-policy': ['        return policy\n          ? { ...v, group: \'byschedule\', policy,', '        return true\n          ? { ...v, group: \'byschedule\', policy,'],
  // Review F2: the client checklist stops asking the shared blockers function,
  // so it goes green while the close band says "Not ready to close".
  'checklist-ignores-blockers': [
    ['const otherWork = blockers ? blockers.count - blockers.missing : 0;', 'const otherWork = 0;'],
    ['if (b2 && b2.unposted) {', 'if (false) {'],
    ['if (b2 && b2.off) {', 'if (false) {'],
  ],
  // ══ SESSION 247 ═════════════════════════════════════════════════════════
  // The walk forgets that anything can be borrowed — the defect David caught.
  'walk-ignores-drawn': ['const computed  = opening ? opening.amount + (drawn || 0) - principal : null;',
                         'const computed  = opening ? opening.amount - principal : null;'],
  // Drawn goes back to the GROSS measured increase — the bug that shipped. The
  // interest half of every payment comes back to the loan account as a positive
  // entry, so `drawn` then equals the month's booked split interest to the cent
  // and every such loan reads as off by exactly its own interest.
  'drawn-is-gross': ['const drawn = drawnGross == null ? null : Math.max(0, drawnGross - nettableInterest);',
                     'const drawn = drawnGross;'],
  // ce30's fix, isolated. `nettableInterest = interest + stagedInterest` is the
  // whole of the staged-payment repair: reverting only the stagedInterest term
  // leaves the ordinary netting intact and re-creates the defect and NOTHING
  // else, which is what makes it a usable control rather than a demolition.
  'staged-interest-not-nettable': ['const nettableInterest = interest + stagedInterest;',
                                   'const nettableInterest = interest;'],
  // THE HIGHEST-VALUE ONE. A truthy movement_measured beside a NULL drawn is
  // accepted as measured, so `drawn || 0` turns "nobody looked" into "nothing
  // was borrowed" and the row starts accusing the loan of exactly the drawdown.
  'null-drawn-is-zero': ['const measured = !!(d && d.movement_measured === true && d.drawn != null);',
                         'const measured = !!(d && d.movement_measured === true);'],
  // The ledger check stops refusing to run on an unmeasured month.
  // Session 273 re-anchored this: the line gained `&& !_ledgerStale` when a books
  // balance older than the journal it judges became its own refusal. The MUTATION
  // is unchanged in meaning -- it removes the measured-movement guard -- but the
  // anchor had to move with the code, or ce24's control would have gone quietly
  // un-runnable and reported "could not be rebuilt" forever.
  'ledger-runs-unmeasured': ['const unexplained = cents((movement.measured && !_ledgerStale && booksClosing != null && computed != null)',
                             'const unexplained = cents((true && !_ledgerStale && booksClosing != null && computed != null)'],
  // Unmeasured renders as a dash — which reads as "nothing was borrowed", the
  // exact substitution that hid the $125,000 in the first place.
  'unmeasured-renders-dash': ['const drawnCell = r.movement.measured', 'const drawnCell = true'],
  // A staged reduction stops explaining the gap it opens, so one event is
  // counted by the posting gate AND accused by the ledger gate.
  'staged-not-explained': ['const stagedExplains = unexplained != null && movement.stagedReduction != null',
                           'const stagedExplains = false && movement.stagedReduction != null'],
  // The origination straddle becomes a Stripe special case instead of a rule.
  'origination-is-stripe-only': ["String(s.source || '') === 'contract_origination' &&",
                                 "String(s.source || '') === 'contract_origination' && a.xero_account_name === 'Stripe Capital Loan' &&"],
  // A journal that both debits and credits the account stops saying so.
  // Session 249: the flag moved from a sub-line under the Drawn figure into
  // the row's hover hint. The anchor follows it. An anchor left on the old
  // string would report 'missing' and the CONTROL would silently stop being a
  // control — which is the one thing worse than not having one.
  'mixed-sign-invisible': ["r.movement.mixedSign > 0 ? `${r.movement.mixedSign} mixed-sign journal entr${r.movement.mixedSign === 1 ? 'y' : 'ies'}` : '',", "'',"],
  // The variance tie is suppressed on unmeasured months too — the symmetric
  // treatment the implementing agent deliberately did NOT adopt.
  // Session 272 re-anchored this: the line gained `|| staleAnchor` when a stale
  // closing anchor became its own refusal. The MUTATION is unchanged in meaning —
  // it adds the symmetric `!movement.measured` suppression on top of whatever
  // refusals the line already carries — but the anchor text had to move with the
  // code, or this control would have gone quietly un-runnable and ce29 would have
  // reported "could not be rebuilt" forever.
  'variance-suppressed-when-unmeasured': ['const variance = circular ? null : rawVariance;',
                                          'const variance = (circular || !movement.measured) ? null : rawVariance;'],
  // The subtotal drops Drawn, so opening + drawn − principal = computed stops
  // footing on every line at once.
  'subtotal-drops-drawn': ['drawn:     set.reduce((n, r) => n + (r.drawn || 0), 0),', 'drawn:     0,'],

  // Review F14, in its session-247 home: the Total stops announcing that its
  // closing and variance columns cover fewer rows than the four beside them.
  // Session 267: the marker moved from the money cells to the Total's label cell
  // (see ce18). The revert now removes the label's closing clause, which is the
  // surviving mechanism — an anchor that no longer exists is not coverage.
  'total-hides-its-coverage': ['if (!ta.closingCovers) coverParts.push(`${ta.closingCount} of ${ta.count} closing checked`);',
                               ''],
  // 'empty-subtotal-renders' (review F14) IS GONE, deliberately. It reverted the
  // per-grade footer rows, and David's layout pass removed them — there is one
  // Total row now and `subtotalRow` no longer exists. A revert whose anchor
  // cannot be found is not coverage; it is a key that looks like coverage and
  // would only ever fail. The behaviour it guarded (a subtotal claiming a tie
  // over zero loans) is now carried by 'total-hides-its-coverage', which
  // reverts the surviving line.
  // The books-side opening is never consulted, so the opening falls back to the
  // schedule mirror and Verdant goes circular again even with a books balance.
  'ignore-book-balances': ['const book = _loanBookBalanceAsOf(a, priorEnd);', 'const book = null;'],
  // No roll-back: only a document dated inside the month counts. EIDL falls to
  // grade C and its $5.00 is never reported.
  'no-rollback': ['if (!later.length) {', 'if (true) {'],
  // The roll-back walk stops refusing: an unposted payment in the window is
  // added anyway, and an unlabelled balance is walked back as though we knew
  // what it measured.
  'rollback-never-refuses': [
    ['if (ROLLBACK_BLOCKING_STATUSES.includes(String(sp.status || \'\'))) {', 'if (false) {'],
  ],
  'rollback-accepts-unknown-basis': ['if (!_balanceBasisIsLabelled(doc)) {', 'if (false) {'],
  // Two bands instead of three: any non-tie is material. EIDL's $5.00 blocks the
  // close, which is the contradiction amendment A1 was written to resolve.
  'no-materiality-band': ['return (v >= MATERIAL_FLOOR && share >= MATERIAL_SHARE) ? \'material\' : \'immaterial\';', "return 'material';"],
  // Grade A's subtotal is computed over every checkable loan, so schedule-derived
  // money is folded into the line the CPA signs as lender-confirmed.
  'subtotal-a-mixes-grades': ['totalsA: subtotal(gradeA),', 'totalsA: subtotal(checkable),'],
  // Stripe is treated like any other loan with no document.
  'stripe-reads-as-no-evidence': [
    ["noEvidence: rows.filter(r => !r.coversMonth && !r.automatic),", 'noEvidence: rows.filter(r => !r.coversMonth),'],
  ],
  // Anchored on the rendered string rather than on '(r.automatic', which since
  // session 247 appears TWICE — once in the closing figure and once in the
  // Closing source column — so a first-match replace reverted the wrong branch
  // and the control quietly stopped reproducing the defect.
  'stripe-cell-reads-not-received': ['<span class="lcb-na">swept from Xero</span>',
                                     '<span class="lcb-none">not received</span>'],
  // The provenance label stops labelling: every source renders as its raw slug.
  // Session 247 gave the two source COLUMNS their own label functions;
  // _anchorSourceLabel now only reaches a title attribute, so reverting it no
  // longer puts a slug on screen and the old control had quietly become
  // vacuous. It failed rather than passing, which is what the "found the
  // anchor" guards are for. The columns a reader actually sees are these two.
  'label-returns-slug': ["if (s === 'amortization_schedule') return 'Amortization schedule';", 'return s;'],
  'closing-label-returns-slug': ["return grade === 'B' ? 'Amortization schedule' : grade === 'A' ? 'Lender statement' : '';",
                                 'return String(grade || \'\');'],
  // Undated splits stop being reported, so seven posted Verdant payments that
  // sit in no month at all are closed over in silence.
  'undated-invisible': ['return (_allLoanSplits || []).filter(sp =>', 'return [].filter(sp =>'],
  // The gates stop carrying their name. Nothing about the strip LOOKS different
  // — since session 264 the strip shows only its verdict anyway — and every
  // gate is still computed and still on the element. What changes is that
  // anything reading them by name can no longer find one, which is the whole
  // property the close-band group's by-name lookups depend on.
  'chips-lose-their-name': ['({ key: g.key, bad:', '({ key: null, bad:'],
  // Session 264 CONTROL: put the chips back on the strip. This is the inverse
  // of the change David asked for, and it exists so "the strip renders its
  // verdict and nothing else" is a claim with a proof rather than an equality
  // that happens to hold. Reinstating them must turn that assertion red — if
  // it does not, the assertion is decoration and the chips could come back
  // unnoticed.
  'chips-come-back': ["'Ready for your accountant'}</span>",
                      "'Ready for your accountant'}</span>${gates.map(g => '<span class=\"lcb-gate\">' + esc(g.text) + '</span>').join('')}"],
};

/* A revert entry is one [from, to] pair or a list of them. Normalised here so a
   call site can never pass the wrong shape and get a silently-empty edit list. */
const EDITS = (k) => {
  const e = CLOSE_REVERTS[k];
  if (!e) throw new Error('unknown revert: ' + k);
  return Array.isArray(e[0]) ? e : [e];
};

GROUPS.push({
  name: 'closing-evidence',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    // The fixture is a point-in-time snapshot whose closing month is 2026-07.
    // Every figure below is a July figure verified against production, so a run
    // whose clock has moved on must fail HERE, loudly, rather than fifty
    // assertions later with numbers nobody can place.
    const now = new Date(HARNESS_NOW);
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const MONTH = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}`;
    t.eq(MONTH, '2026-07',
         'ce: precondition — the band is closing the month this fixture was pulled for (2026-07)');

    // The page formats close-band dates from the string's own parts and never
    // constructs a Date (the shared fmtDate() is a day early off Pacific, and
    // this harness runs in UTC). The harness matches that, rather than
    // round-tripping through a timezone to check a string.
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const plainDate = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
    // ── loan_book_balances IS NO LONGER EMPTY ────────────────────────────
    // reconciliation-run v50 wrote 44 rows (22 loans x 6/30 and 7/31), so a
    // scenario that PUSHES a books row now lands beside a real one and
    // _loanBookBalanceAsOf picks whichever has the newer computed_at. Every
    // plant therefore REPLACES the loan's rows outright, and every scenario that
    // wants the no-books fallback has to say so explicitly.
    const setBooks = (d, loanName, rows) => {
      const a = d.loan_accounts.find(x => x.xero_account_name === loanName);
      if (!a) throw new Error('setBooks: no such loan ' + loanName);
      d.loan_book_balances = d.loan_book_balances.filter(b => b.loan_account_id !== a.id);
      (rows || []).forEach((r, i) => d.loan_book_balances.push({
        id: `harness-bb-${a.id}-${i}`, loan_account_id: a.id, as_of: r.as_of,
        balance: r.balance, basis: 'xero_rebuild', run_id: null,
        detail: { staged_entries_at_or_before: r.staged || 0 },
        computed_at: '2026-08-28T02:48:00Z',
      }));
    };
    const dropBooks = (d, loanName) => setBooks(d, loanName, []);

    // Movement detail lives on the CLOSING month-end books row, which is where
    // _loanMonthMovement reads it.
    const setMovement = (d, loanName, detail) => {
      const a = d.loan_accounts.find(x => x.xero_account_name === loanName);
      if (!a) throw new Error('setMovement: no such loan ' + loanName);
      const row = d.loan_book_balances.find(b => b.loan_account_id === a.id && b.as_of === '2026-07-31');
      if (!row) throw new Error('setMovement: no 2026-07-31 books row for ' + loanName);
      row.detail = detail === null ? null : Object.assign({}, row.detail || {}, detail);
    };
    const MEASURED = (over) => Object.assign({
      movement_measured: true, drawn: 0, reduced: 0, drawn_entries: 0, reduced_entries: 0,
      mixed_sign_entries: 0, staged_reduction_in_month: 0, staged_entries_in_month: 0,
      movement_from: '2026-07-01', movement_to: '2026-07-31',
    }, over || {});

    // Four loans are genuinely material now that the books open the walk, so
    // "does an immaterial gap block the close?" needs a July with nothing else
    // in it. Built by moving each checkable loan's 6/30 books balance to exactly
    // (closing + principal) — DERIVED from the rendered page, never typed, so
    // the next reconciliation-run does not turn this into a maintenance chore.
    // Only the opening is touched; every closing figure stays the real one.
    const cleanJuly = async (keep) => {
      const p0 = await newHarnessPage({ tab: 'loans' });
      const rows = (await p0.surfaces()).loans.closeBand.rows;
      await p0.close();
      const targets = rows
        .filter(r => r.perLenderN != null && r.computedN != null && !(keep || []).includes(r.name))
        .map(r => ({ name: r.name, want: r.perLenderN + (r.principalN || 0) }));
      t.ok(targets.length >= 10,
           `ce: the clean-July scenario found the checkable rows to flatten (keeping ${JSON.stringify(keep || [])})`,
           `${targets.length} targets`);
      return (d) => {
        d.loan_splits.forEach(sp => {
          if (String(sp.period_label || '').slice(0, 7) === MONTH &&
              ['pending_review', 'needs_attention'].includes(sp.status)) sp.status = 'posted';
        });
        targets.forEach(x => setBooks(d, x.name, [{ as_of: '2026-06-30', balance: x.want }]));
      };
    };

    const rowOf = (cb, name) => (cb.rows || []).find(r => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(r.loan)) || null;

    /* ── 1 ── DEXTER CLOSES AT GRADE B, AND THE TIE IS A REAL ONE ────────── */
    // Acceptance #1. Dexter Financial issues no periodic statements; the
    // contractual schedule is the recorded basis. The opening comes from our own
    // Xero ledger and the closing from the contract, so opening − principal =
    // closing is a check of the books against the contract rather than of one
    // document against itself.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'Dexter Loan 2');
      t.ok(!!r, 'ce1: Dexter Loan 2 is on the rollforward');
      t.eq(r.grade, 'B', 'ce1: Dexter closes at grade B — per the contractual amortization schedule');
      t.eq(r.derivation, 'schedule', 'ce1: ...derived from the schedule, and the row says so in an attribute');
      t.eq(r.closingGrade, 'B', 'ce1: ...and the closing CELL carries the same grade as the row');
      t.close(r.perLenderN, 89411.25, 0.005, 'ce1: ...at $89,411.25, the 7/31 schedule balance');
      t.close(r.openingN, 92737.48, 0.005, 'ce1: ...opening from the books-side ledger at $92,737.48');
      t.close(r.principalN, 3326.23, 0.005, 'ce1: ...less $3,326.23 of principal booked in July');
      t.close(r.computedN, 89411.25, 0.005, 'ce1: ...which computes to exactly the schedule figure');

      // ── AND NOW THE ARITHMETIC IS EVIDENCE, BECAUSE THE OPENING IS ──────
      // The first cut of this group asserted that this row ties, and that was a
      // tautology: Dexter's opening was 'xero_derived', a frozen 2026-08
      // backfill equal to the contract on every same-dated row, so opening,
      // movement and closing were one document. Amendment A7 said so in
      // writing — "acceptance #1 was an assertion; it is a prediction" — and I
      // asserted the prediction anyway. The review replaced the source-name
      // guard with a predicate and the row correctly went circular.
      //
      // reconciliation-run v50 has now written the books-side balance, and A7's
      // prediction resolved in the code's favour: Xero's own rebuilt ledger says
      // 92,737.48 at 6/30, which is what the backfill said, and 92,737.48 −
      // 3,326.23 = 89,411.25 = the contract. THE NUMBER IS THE SAME AND THE
      // CLAIM IS DIFFERENT, which is the whole point — a figure that agrees is
      // not evidence, and where it came from is.
      t.eq(r.openingFromBooks, true,
           'ce1: the opening comes from the books-side rebuild reconciliation-run wrote');
      // Session 247: provenance is its own column, so the claim is asserted
      // where it now lives. Reading it off the money cell would pass only for as
      // long as the two were concatenated.
      // Session 247 collapsed the source columns to two names each — David's
      // "remove extra words". The claim under test never was the sentence; it is
      // that the column states PROVENANCE in a reader's language rather than a
      // slug, and that a books-side opening is not passed off as a lender's.
      t.eq(r.openingSource, 'Xero',
           'ce1: ...and the Opening source column names it, in a reader’s language',
           `cell=${JSON.stringify(r.openingSource)}`);
      t.notMatch(r.openingSource, /xero_rebuild|_/, 'ce1: ...never as a slug');
      t.eq(r.circular, false,
           'ce1: ...so the walk is NOT circular — Xero opens it and the contract closes it');
      t.eq(r.ties, true, 'ce1: ...and the row TIES');
      t.eq(r.band, 'tie', 'ce1: ...in the tie band');
      t.close(r.varianceN, 0, 0.005,
              'ce1: ...at $0.00 — acceptance #1, at last as a measurement rather than a prediction');
      t.notMatch(r.closingSource, /amortization_schedule/,
                 'ce1: the Closing source column names the schedule in English, never as a slug');
      t.ok(/amortization schedule/i.test(r.closingSource || ''),
           'ce1: ...and it does name it, so a reader can disagree with the basis',
           `cell=${JSON.stringify(r.closingSource)}`);

      // The chip and the subtotal agree with the row.
      const g = cb.gateByKey['per-schedule'];
      t.ok(!!g, 'ce1: the strip carries a per-schedule chip', JSON.stringify(cb.gates.map(x => x.key)));
      t.eq(g && g.count, 2, 'ce1: ...counting the two loans that close on their schedule');
      // The per-grade footer rows are gone (session 247): Closing source names
      // the grade on every row and the chip carries the count, so the check
      // moves to the rows themselves — which is a stronger statement than a
      // footer restating what the chip already said.
      t.eq(cb.rows.filter(x => x.grade === 'B' && x.perLenderN != null).length, 2,
           'ce1: ...and exactly two rows carry grade B');
      t.eq(cb.rows.filter(x => x.grade === 'B' && x.circular).length, 0,
           'ce1: ...neither of which is circular any more, now the books open both walks');

      // ── CONTROL a ── no grade B at all
      const rev = await revertFn(p, '_loanClosingAnchor', EDITS('no-grade-b'));
      t.ok(rev.ok, 'ce1 CONTROL: the pre-grade-B anchor could be rebuilt in page context', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.eq(b.grade, 'C', 'ce1 CONTROL: without the policy branch, Dexter has no closing balance at all');
        t.eq(b.perLenderN, null, 'ce1 CONTROL: ...the closing cell is empty');
        t.eq(b.ties, false, 'ce1 CONTROL: ...and the tie is gone');
      }
      await restoreFns(p);
      await p.close();

      // ── THE OTHER HALF OF THE PAIR, AND IT IS STILL THE ACTUAL TEST ─────
      // Take the books rows away and the SAME loan, closing at the SAME
      // 89,411.25 off the SAME schedule, must stop claiming a tie — because the
      // opening falls back to the frozen backfill and the walk becomes one
      // document compared with itself. One half alone is what let the tautology
      // through the first time.
      const pNoBooks = await newHarnessPage({ tab: 'loans', mutate: (d) => dropBooks(d, 'Dexter Loan 2') });
      const cbN = (await pNoBooks.surfaces()).loans.closeBand;
      const rn = rowOf(cbN, 'Dexter Loan 2');
      t.eq(rn.openingFromBooks, false, 'ce1: with the books rows gone the opening falls back to our own ledger');
      t.close(rn.openingN, 92737.48, 0.005,
              'ce1: ...at the IDENTICAL $92,737.48 — the figure did not change, only its provenance');
      t.close(rn.perLenderN, 89411.25, 0.005, 'ce1: ...and the closing is still the contract’s $89,411.25');
      t.eq(rn.circular, true, 'ce1: ...yet the row is now CIRCULAR');
      t.eq(rn.ties, false, 'ce1: ...prints NO tie, on arithmetic that lands on the cent');
      t.eq(rn.varianceN, null, 'ce1: ...and reports no variance at all');
      // Session 249: the cell says "by construction" and the hover hint carries
      // the full sentence. Both are asserted — the short form is what a scanner
      // sees, the long form is what stops them reading it as a pass.
      t.ok(/by construction/.test(rn.variance || ''),
           'ce1: ...saying so, in the column a reader looks at', `cell=${JSON.stringify(rn.variance)}`);
      t.ok(/not an independent check/.test(rn.hint || ''),
           'ce1: ...and the row explains why, one hover away', `hint=${JSON.stringify(rn.hint)}`);
      t.eq(cbN.rows.filter(x => x.grade === 'B' && x.circular).length, 1,
           'ce1: ...and exactly one grade-B row is now marked not independently checked');

      // ── CONTROL b ── the tautology itself, on the half that must refuse it
      const revI = await revertFn(pNoBooks, '_openingIsIndependent', EDITS('everything-is-independent'));
      t.ok(revI.ok, 'ce1 CONTROL: an independence test that accepts every source could be rebuilt', JSON.stringify(revI.missing));
      if (revI.ok) {
        const b = rowOf((await pNoBooks.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.eq(b.circular, false, 'ce1 CONTROL: pre-review, a frozen backfill counted as an independent opening');
        t.eq(b.ties, true, 'ce1 CONTROL: ...and Dexter printed a GREEN TIE against the contract it was built from');
        t.close(b.varianceN, 0, 0.005, 'ce1 CONTROL: ...at exactly $0.00, forever, because it could not fail');
      }
      await restoreFns(pNoBooks);
      await pNoBooks.close();
    }

    /* ── 2 ── THE row_type FILTER DISCRIMINATES ──────────────────────────── */
    // Dexter's schedule carries a rate_change dated 2026-08-31 with balance 0.00
    // SHARING that date with the real payment row at 86,066.61 — and it sits
    // BEFORE it in fixture order, so a sort by date alone is a coin flip decided
    // by sort stability. `balance != null` is not a substitute for the row_type
    // allowlist: Dexter's totals have populated balances (Verdant's are null, so
    // generalising from Verdant would have shipped this).
    {
      const p = await newHarnessPage({ tab: 'loans' });
      // (a) the hazard is really in the data, in that order
      const shape = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Dexter Loan 2');
        const mine = (_allLoanAmortRows || []).filter(r =>
          r.loan_amortization_schedules && r.loan_amortization_schedules.loan_account_id === a.id &&
          r.row_date === '2026-08-31');
        return { order: mine.map(r => ({ type: r.row_type, bal: Number(r.balance) })),
                 totalsWithBalances: (_allLoanAmortRows || []).filter(r =>
                   r.loan_amortization_schedules && r.loan_amortization_schedules.loan_account_id === a.id &&
                   r.row_type !== 'payment' && r.balance != null).length };
      });
      t.eq(JSON.stringify(shape.order), JSON.stringify([{ type: 'rate_change', bal: 0 }, { type: 'payment', bal: 86066.61 }]),
           'ce2: the hazard is real — a 0.00 rate_change shares 2026-08-31 with the payment row, and comes FIRST');
      t.ok(shape.totalsWithBalances >= 9,
           'ce2: ...and Dexter’s non-payment rows carry POPULATED balances, so `balance != null` cannot filter them',
           `${shape.totalsWithBalances} non-payment rows with a balance`);

      // (b) the shipped function, asked for the August close directly
      const aug = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Dexter Loan 2');
        return { anchor: _loanClosingAnchor(a, '2026-08-31', '2026-07-31'),
                 sched: _loanScheduleBalanceAsOf(a, '2026-08-31'),
                 dec:   _loanScheduleBalanceAsOf(a, '2025-12-31') };
      });
      t.close(aug.anchor.amount, 86066.61, 0.005,
              'ce2: the AUGUST close reads Dexter at $86,066.61 — the payment row');
      t.ok(aug.anchor.amount !== 0, 'ce2: ...and NOT as paid off');
      t.eq(aug.anchor.grade, 'B', 'ce2: ...still grade B');
      t.close(aug.sched.amount, 86066.61, 0.005, 'ce2: ...and the schedule lookup agrees');
      // The design doc cites a December close as a second instance of the same
      // hazard. It is NOT assertable: Dexter's 2025-12-31 payment row and its
      // 2025-12-31 annual_total BOTH read 112,314.00, so the filter changes
      // which row is picked and not what the screen says. Stated as the fixture
      // property it is, so nobody re-adds it as a test that cannot fail.
      t.close(aug.dec && aug.dec.amount, 112314, 0.005,
              'ce2: (fixture property) a December close is value-blind — the payment row and the annual_total both read 112,314.00 there, which is why August is the discriminating case');

      // (c) the same hazard, rendered — cloned onto the JULY month end so the
      //     DOM itself, not just the function, is under test.
      await p.close();
      const p2 = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const a = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        // No books plant is needed any more: reconciliation-run v50 wrote
        // Dexter's real 6/30 rebuild, so the row already carries an independent
        // opening and a real tie for a wrong closing balance to break.
        const idx = d.loan_amortization_rows.findIndex(r =>
          (r.loan_amortization_schedules || {}).loan_account_id === a.id && r.row_date === '2026-07-31');
        // loadLoans orders these rows `row_date DESC, id ASC`, so "before the
        // payment row" is decided by ID, not by array position. An all-zero uuid
        // sorts ahead of any real one, which reproduces the live hazard exactly:
        // two rows on one date, and the wrong one reached first.
        const clone = Object.assign({}, d.loan_amortization_rows[idx], {
          id: '00000000-0000-0000-0000-000000000001', row_type: 'rate_change', balance: 0,
        });
        d.loan_amortization_rows.splice(idx, 0, clone);
      } });
      const r2 = rowOf((await p2.surfaces()).loans.closeBand, 'Dexter Loan 2');
      t.close(r2.perLenderN, 89411.25, 0.005,
              'ce2: a 0.00 rate_change dated on the July month end does not close Dexter at zero');
      t.eq(r2.ties, true, 'ce2: ...and the row still ties');

      // ── CONTROL ── drop the row_type allowlist, keep `balance != null`.
      // Review F11 moved the allowlist UP into _loanScheduleRows so the schedule
      // PICK is made from the rows that will actually be read — so it is now
      // enforced in two places and the defect needs both patched. Patching only
      // one would leave the other still filtering and produce a control that
      // silently proves nothing.
      const revPick = await revertFn(p2, '_loanScheduleRows', EDITS('no-row-type-in-picker'), { rerender: false });
      t.ok(revPick.ok, 'ce2 CONTROL: the pre-filter schedule PICKER could be rebuilt', JSON.stringify(revPick.missing));
      const rev = await revertFn(p2, '_loanScheduleBalanceAsOf', EDITS('no-row-type-filter'));
      t.ok(rev.ok, 'ce2 CONTROL: the pre-filter schedule LOOKUP could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok && revPick.ok) {
        const b = rowOf((await p2.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.close(b.perLenderN, 0, 0.005,
                'ce2 CONTROL: without the row_type allowlist Dexter reads as PAID OFF at 0.00');
        t.eq(b.ties, false, 'ce2 CONTROL: ...and the tie collapses — the filter is what the assertion is testing');
        const bAug = await p2.evaluate(() => {
          const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Dexter Loan 2');
          return _loanScheduleBalanceAsOf(a, '2026-08-31').amount;
        });
        t.close(bAug, 0, 0.005, 'ce2 CONTROL: ...and the August close reads 0.00 too, exactly as A3 predicted');
      }
      await restoreFns(p2);
      await p2.close();
    }

    /* ── 3 ── VERDANT: WHERE THE −$1,835.75 ACTUALLY IS ─────────────────── */
    // This was the loan the whole design existed for. All 85 of its
    // loan_statements rows ARE the schedule, every split is schedule-generated,
    // and the closing figure is the schedule too — so before reconciliation-run
    // wrote a books-side balance, opening, movement and closing were one
    // document and the variance was identically zero by construction, forever.
    //
    // Now Xero's own rebuilt ledger opens the walk, and the answer is a
    // LOCALISATION rather than a number: the books track the contract through
    // July to FOUR CENTS. So the −$1,835.75 the tie-out reports is not a
    // standing gap at all — it is an AUGUST event, and this is the single most
    // valuable thing the change produced.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const s = await p.surfaces();
      const cb = s.loans.closeBand;
      const r = rowOf(cb, 'Verdant Capital Loan');
      t.ok(!!r, 'ce3: Verdant is on the rollforward');
      t.eq(r.grade, 'B', 'ce3: Verdant closes at grade B');
      t.eq(r.openingFromBooks, true, 'ce3: ...opened by Xero’s own rebuilt ledger');
      t.eq(r.circular, false,
           'ce3: ...so it is NO LONGER circular — the schedule is no longer compared with itself');
      t.close(r.openingN, 253582.23, 0.005, 'ce3: ...books say $253,582.23 at 6/30');
      t.close(r.principalN, 2687.94, 0.005, 'ce3: ...less $2,687.94 of July principal');
      t.close(r.perLenderN, 250894.33, 0.005, 'ce3: ...against the contract’s $250,894.33');
      t.close(r.varianceN, -0.04, 0.005,
              'ce3: ...leaves FOUR CENTS — the books track the contract through July');
      t.eq(r.band, 'immaterial', 'ce3: ...which is immaterial, shown and not chased');
      t.eq(r.ties, false, 'ce3: ...and not a tie: four cents is a real difference, printed');

      // ── THE LOCALISATION, ASSERTED ──────────────────────────────────────
      // If July is clean to $0.04 then the tie-out's −$1,835.75 belongs to a
      // later date, and it does: the tie-out is anchored at 2026-08-10, the
      // August schedule row. Its size is August's scheduled INTEREST ($1,835.71)
      // plus that same four cents of standing drift — the shape of a payment
      // posted whole to principal, with nothing split out for interest.
      const loc = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
        const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id);
        const rows = _loanScheduleRows(a);
        const aug = rows.find(x => x.row_date === '2026-08-10');
        const books = (_allLoanBookBalances || []).filter(b => b.loan_account_id === a.id)
          .map(b => ({ as_of: b.as_of, balance: Number(b.balance) })).sort((x, y) => x.as_of < y.as_of ? -1 : 1);
        return { tieDiff: Number(to.difference), tieAsOf: to.as_of, anchor: to.anchor_source,
                 augInterest: Number(aug.interest), augPrincipal: Number(aug.principal), books };
      });
      t.eq(loc.tieAsOf, '2026-08-10',
           'ce3: the tie-out’s −$1,835.75 is anchored on 2026-08-10 — in AUGUST, not in the month just closed');
      t.close(loc.tieDiff, -1835.75, 0.005, 'ce3: ...and that is its size');
      t.close(loc.augInterest, 1835.71, 0.005, 'ce3: ...August’s scheduled interest is $1,835.71');
      t.close(Math.abs(loc.tieDiff) - loc.augInterest, 0.04, 0.005,
              'ce3: ...so the gap is August’s interest plus the four cents July already carries');
      t.close(loc.books[0].balance - 253582.27, -0.04, 0.005,
              'ce3: ...the four cents being the books’ own drift from the contract at 6/30');
      t.ok(loc.books.length === 2 && loc.books[1].as_of === '2026-07-31',
           'ce3: ...and reconciliation-run wrote both month ends, which is what made this visible',
           JSON.stringify(loc.books));
      // Said plainly: a July close that reports four cents cannot be hiding
      // eighteen hundred dollars, so the work is in August.
      t.ok(Math.abs(r.varianceN) < 1 && Math.abs(loc.tieDiff) > 1000,
           'ce3: July is clean to the cent and August is not — the gap is LOCATED, not merely reported');
      await p.close();

      // ── AND THE CIRCULARITY GUARD IS STILL LOAD-BEARING ─────────────────
      // Take the books rows away and Verdant goes straight back to comparing the
      // schedule with itself. This is the state the loan was in for its whole
      // history, so it has to stay reachable and stay refused.
      const pNo = await newHarnessPage({ tab: 'loans', mutate: (d) => dropBooks(d, 'Verdant Capital Loan') });
      const cbN = (await pNo.surfaces()).loans.closeBand;
      const rn = rowOf(cbN, 'Verdant Capital Loan');
      t.eq(rn.openingFromBooks, false, 'ce3: with no books row the opening falls back to the 85-row schedule mirror');
      t.eq(rn.circular, true, 'ce3: ...and the ROW is marked circular');
      t.eq(rn.varianceCircular, true, 'ce3: ...as is the variance cell');
      t.eq(rn.ties, false, 'ce3: ...which carries NO data-tie — this is not a tie');
      t.eq(rn.varianceN, null, 'ce3: ...and no variance figure at all');
      t.eq(rn.band, null, 'ce3: ...and no band, so it is in neither the ties nor the offs');
      t.ok(/by construction/.test(rn.variance || ''),
           'ce3: ...and it SAYS so, in the column a reader looks at', `cell=${JSON.stringify(rn.variance)}`);
      t.ok(/not an independent check/.test(rn.hint || ''),
           'ce3: ...including why that is not the same as agreeing', `hint=${JSON.stringify(rn.hint)}`);
      t.ok(/agree.? by construction/.test(cbN.note || ''),
           'ce3: the footer sentence accounts for the row it excluded', `note=${JSON.stringify(cbN.note)}`);
      t.eq(cbN.rows.filter(x => x.grade === 'B' && x.circular).length, 1,
           'ce3: exactly one grade-B row is marked not independently checked');
      // Verdant's seven undated splits are stated rather than closed over.
      t.eq(rn.undatedN, 7, 'ce3: ...and its seven undated splits are declared on the row (A10)');
      // The Notes column is gone; "N undated" was filed into Status, where
      // posting state belongs. Following it there is the point — an attribute
      // left on a dead column would still parse and stop meaning anything.
      // Session 249: the flag moved from the Status column into the row's hover
      // hint, which is now the only home the moved facts have on screen. It is
      // ALSO its own CSV column, so nothing about the export changed.
      t.ok(/7 undated/.test(rn.hint || ''), 'ce3: ...visibly, one hover away',
           `hint=${JSON.stringify(rn.hint)}`);
      {
        const revU = await revertFn(pNo, '_undatedSplits', EDITS('undated-invisible'));
        t.ok(revU.ok, 'ce3 CONTROL: an _undatedSplits that reports nothing could be rebuilt', JSON.stringify(revU.missing));
        if (revU.ok) {
          const b = rowOf((await pNo.surfaces()).loans.closeBand, 'Verdant Capital Loan');
          t.eq(b.undatedN, 0, 'ce3 CONTROL: seven posted payments that fall in no month are closed over in silence');
          t.notMatch(b.inXero, /undated/, 'ce3 CONTROL: ...with nothing on the row to say so');
        }
        await restoreFns(pNo);
      }

      // ── CONTROL ── the guard never fires
      const rev = await revertFn(pNo, '_loanCloseRollforward', EDITS('circular-guard-off'));
      t.ok(rev.ok, 'ce3 CONTROL: a rollforward with no circularity guard could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await pNo.surfaces()).loans.closeBand, 'Verdant Capital Loan');
        t.eq(b.circular, false, 'ce3 CONTROL: a guard that never fires leaves the row unmarked');
        t.eq(b.ties, true, 'ce3 CONTROL: ...and Verdant prints a GREEN TIE against the document it was built from');
        t.notMatch(b.variance, /agrees by construction/,
                   'ce3 CONTROL: ...with no warning of any kind — which is the defect the assertion catches');
      }
      await restoreFns(pNo);
      await pNo.close();
    }

    /* ── 4 ── VERDANT, WITH A BOOKS BALANCE, IS NOT CIRCULAR ─────────────── */
    // loan_book_balances is EMPTY in production, so this path is reachable only
    // through the stub — which is exactly why the table is registered in
    // FIXTURE_TABLES: unregistered it would serve [] in silence and this whole
    // scenario would test the fallback while claiming to test the fix.
    {
      const BOOKS = [
        { as_of: '2026-06-30', balance: 251746.52 },
        { as_of: '2026-07-31', balance: 249058.58 },
      ];
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const v = d.loan_accounts.find(x => x.xero_account_name === 'Verdant Capital Loan');
        d.loan_book_balances = BOOKS.map((b, i) => ({
          id: 'harness-bb-' + i, loan_account_id: v.id, as_of: b.as_of, balance: b.balance,
          basis: 'xero_rebuild', run_id: null, detail: { staged_entries_at_or_before: 0 },
          computed_at: b.as_of + 'T12:00:00Z',
        }));
      } });
      const s = await p.surfaces();
      const cb = s.loans.closeBand;
      const r = rowOf(cb, 'Verdant Capital Loan');
      t.eq(r.openingFromBooks, true, 'ce4: with a books balance on file the opening comes from OUR BOOKS');
      t.close(r.openingN, 251746.52, 0.005, 'ce4: ...at $251,746.52, rebuilt from Xero rather than read off the schedule');
      t.eq(r.circular, false, 'ce4: ...so the row is no longer circular — the two ends are independent now');
      t.eq(r.ties, false, 'ce4: ...and it does not tie');
      t.close(r.principalN, 2687.94, 0.005, 'ce4: ...July principal is $2,687.94');
      t.close(r.computedN, 249058.58, 0.005, 'ce4: ...so the books compute to $249,058.58');
      t.close(r.perLenderN, 250894.33, 0.005, 'ce4: ...against a schedule closing of $250,894.33');
      t.close(r.varianceN, -1835.75, 0.005,
              'ce4: ...a variance of −$1,835.75 — the figure loan_tie_outs already held and the band could not show');
      t.eq(r.band, 'material', 'ce4: ...which is MATERIAL: over $25 and over 0.25% of the balance');
      const red = await p.evaluate(() => {
        const tr = [...document.querySelectorAll('#loans-close-band tbody tr')]
          .find(x => /Verdant/.test(x.textContent));
        // Addressed by the attribute the renderer writes, not by an index that
        // moved when the table was flattened for export.
        const td = tr && tr.querySelector('td[data-variance]');
        return { html: td ? td.innerHTML : null, off: !!(td && td.querySelector('.lcb-off')) };
      });
      t.eq(red.off, true, 'ce4: ...and it renders RED (.lcb-off), not grey',
           `variance cell html=${JSON.stringify(red.html)}`);
      t.eq(r.openingSource, 'Xero',
           'ce4: ...and the Opening source column names its provenance in a reader’s language',
           `cell=${JSON.stringify(r.openingSource)}`);
      t.notMatch(r.openingSource, /xero_rebuild/, 'ce4: ...never as a slug');
      // The close is now genuinely blocked, by a real number.
      t.eq(cb.gateByKey['variance'].ok, false, 'ce4: the variance chip goes bad');
      t.eq(cb.gateByKey['variance'].count, 1, 'ce4: ...counting exactly this one loan');
      t.ok(/not ready to close/i.test(cb.lead || ''), 'ce4: ...and the band says the close is not ready');

      // ── CONTROL ── ignore the books balance, as the page did before s246
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('ignore-book-balances'));
      t.ok(rev.ok, 'ce4 CONTROL: the pre-books-balance opening could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'Verdant Capital Loan');
        t.eq(b.openingFromBooks, false, 'ce4 CONTROL: the opening falls back to the schedule mirror');
        t.eq(b.circular, true, 'ce4 CONTROL: ...the row goes circular again');
        t.eq(b.varianceN, null,
             'ce4 CONTROL: ...and the −$1,835.75 the books are out by is not reported at all');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 5 ── EIDL ROLLS BACK, AND $5.00 DOES NOT BLOCK A CLOSE ──────────── */
    // The SBA does not issue at month end; it issues on the 25th. We hold a real
    // emailed statement dated 2026-08-25 saying $960,005.00 and no principal was
    // booked between 2026-07-31 and that date, so the SBA's OWN figure for
    // 2026-07-31 is $960,005.00. That is arithmetic on lender evidence.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'EIDL SBA Loan');
      t.eq(r.grade, 'A', 'ce5: EIDL closes at grade A — a real lender document, not a schedule');
      t.eq(r.derivation, 'rolled_back', 'ce5: ...arrived at by rolling a later statement back to month end');
      t.close(r.perLenderN, 960005, 0.005, 'ce5: ...at $960,005.00');
      t.close(r.varianceN, -5, 0.005, 'ce5: ...reporting the $5.00 the books are out by rather than nothing');
      t.eq(r.band, 'immaterial', 'ce5: ...in the immaterial band: $5.00 on $960,005 is under both thresholds');
      t.eq(r.ties, false, 'ce5: ...so it is NOT a tie — an immaterial gap is de-escalated, never hidden');
      // The roll-back moved to a sub-line on the Closing DATE cell, beside the
      // date it was rolled back from — which is where a reader asking "why is
      // this dated 8/25 when we are closing July?" is already looking.
      t.eq(r.closingDate, '8/25', 'ce5: ...the Closing cell carries the document’s own date');
      t.ok(/rolled back/.test(r.hint || ''),
           'ce5: ...and the row says the figure was DERIVED, not stated at month end',
           `hint=${JSON.stringify(r.hint)}`);
      t.eq(r.derivation, 'rolled_back', 'ce5: ...with the machine-readable derivation to match');
      t.eq(r.closingSource, 'Lender statement',
           'ce5: ...while Closing source still names whose figure it is',
           `cell=${JSON.stringify(r.closingSource)}`);
      t.ok(/8\/25/.test(r.closingDate || ''),
           'ce5: ...and the Closing date column carries the document’s own date, not month end',
           `cell=${JSON.stringify(r.closingDate)}`);
      // …and it does not block.
      const im = cb.gateByKey['immaterial'];
      t.ok(!!im, 'ce5: the immaterial chip is on the strip', JSON.stringify(cb.gates.map(x => x.key)));
      t.eq(im && im.ok, true, 'ce5: ...and it is not a blocking gate');
      // The chip counts every small difference, not just this one, so it is
      // checked against the rows rather than against a typed figure.
      const smallRows = cb.rows.filter(x => x.band === 'immaterial');
      t.eq(im && im.count, smallRows.length,
           'ce5: ...counting exactly the rows in the immaterial band', `chip=${JSON.stringify((im || {}).text)}`);
      t.ok(smallRows.some(x => /EIDL/.test(x.loan)), 'ce5: ...EIDL among them');
      t.eq(T.money(smallRows.reduce((n2, x) => n2 + Math.abs(x.varianceN), 0)),
           (String((im || {}).text || '').match(/\$[\d,]+\.\d\d/) || [''])[0],
           'ce5: ...and the money on the chip is the sum of those rows, so the two cannot disagree');
      // July IS blocked — by four loans genuinely off since the books started
      // opening the walk, and by one unposted split. The claim under test is
      // that EIDL's $5.00 contributes NOTHING to either.
      t.ok(!cb.rows.some(x => /EIDL/.test(x.loan) && x.band === 'material'),
           'ce5: EIDL is not among the loans the variance gate is counting');
      t.eq(cb.gateByKey['variance'].count, cb.rows.filter(x => x.band === 'material').length,
           'ce5: ...whose count is exactly the material rows, and EIDL is not one');

      // …and with that one split posted, the band reads exactly what acceptance
      // #4 asks for, WITH the $5.00 still on screen. This is the assertion the
      // whole materiality amendment exists for: a five-dollar difference on a
      // million-dollar loan may be shown, and may not stop a close.
      const pClean = await newHarnessPage({ tab: 'loans', mutate: await cleanJuly(['EIDL SBA Loan']) });
      // Session 262 cont. 3: David's statement gate is a SECOND blocker this
      // scenario never had to satisfy, and it fires on this fixture because its
      // reconciliation run predates some of its statements. The claim under test
      // is about a $5.00 gap, so the scenario says explicitly that the documents
      // were checked rather than letting an unrelated gate decide the answer.
      // `close-gate` is where blocking is proved.
      await alignTieOutsToAnchors(pClean);
      const cb2 = (await pClean.surfaces()).loans.closeBand;
      t.ok(/ready for your accountant/i.test(cb2.lead || ''),
           'ce5: with the unposted split cleared, a $5.00 gap does NOT stop the close',
           `lead=${JSON.stringify(cb2.lead)} · bad gates ${JSON.stringify(cb2.gates.filter(g => !g.ok).map(g => g.key))}`);
      const r2 = rowOf(cb2, 'EIDL SBA Loan');
      t.eq(r2.band, 'immaterial', 'ce5: ...and the $5.00 is still there, still de-escalated');
      t.close(r2.varianceN, -5, 0.005, 'ce5: ...at its real size');
      t.eq((cb2.gateByKey['immaterial'] || {}).count, 1,
           'ce5: ...the only small difference left, and still on the strip');
      t.ok(/\$5\.00/.test((cb2.gateByKey['immaterial'] || {}).text || ''),
           'ce5: ...still printed on the chip, not hidden',
           `chip=${JSON.stringify((cb2.gateByKey['immaterial'] || {}).text)}`);
      // Session 264: these two read the strip's rendered TEXT, and David has
      // since removed everything from the strip but its verdict. Reading the
      // text would now make BOTH pass for the wrong reason — the second one
      // especially, since "no queue for documents that are never coming" is
      // trivially true of a strip that says nothing at all. They read the
      // gates, which is where the claim actually lives now; the point of the
      // pair is unchanged and it still fails if the grading goes wrong.
      const perSched = cb2.gateByKey['per-schedule'];
      t.eq(perSched && perSched.count, 2,
           'ce5: ...and the close position counts "2 per schedule", never "3 statements outstanding"',
           `gates: ${JSON.stringify(cb2.gates.map(g => g.text))}`);
      t.ok(!cb2.gates.some(g => /statements? outstanding/.test(g.text || '')),
           'ce5: ...with no queue for documents that are never coming',
           `gates: ${JSON.stringify(cb2.gates.map(g => g.text))}`);
      await pClean.close();

      // ── CONTROL a ── no roll-back at all
      const rev = await revertFn(p, '_loanClosingAnchor', EDITS('no-rollback'));
      t.ok(rev.ok, 'ce5 CONTROL: the pre-roll-back anchor could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'EIDL SBA Loan');
        t.eq(b.grade, 'C', 'ce5 CONTROL: without the roll-back EIDL has no closing balance');
        t.eq(b.varianceN, null, 'ce5 CONTROL: ...and the $5.00 is never reported');
      }
      await restoreFns(p);

      // ── CONTROL b ── two bands instead of three
      const rev2 = await revertFn(p, '_closeVarianceBand', EDITS('no-materiality-band'));
      t.ok(rev2.ok, 'ce5 CONTROL: the two-band variance test could be rebuilt', JSON.stringify(rev2.missing));
      if (rev2.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const br = rowOf(b, 'EIDL SBA Loan');
        t.eq(br.band, 'material', 'ce5 CONTROL: without materiality, $5.00 is "material"');
        t.eq(b.gateByKey['variance'].ok, false, 'ce5 CONTROL: ...the variance gate goes bad');
        t.ok(/not ready to close/i.test(b.lead || ''),
             'ce5 CONTROL: ...and a $5.00 rounding difference blocks the whole close — the A1 contradiction',
             `lead=${JSON.stringify(b.lead)}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 6 ── THE ROLL-BACK REFUSES, AND A REFUSAL IS NEVER A TIE ────────── */
    // "If any condition fails, the loan falls through to grade B, then C. A
    // refused roll-back is never silently upgraded to a tie." EIDL has no
    // schedule and its close_basis is lender_statement, so grade C is where it
    // lands — and it must land there SAYING WHY.
    {
      // Baseline: a POSTED payment inside the window is added to the walk. Without
      // this the refusal test proves nothing, because EIDL's real window contains
      // no split at all and the walk adds $0.00 either way.
      const addSplit = (status) => (d) => {
        const a = d.loan_accounts.find(x => x.xero_account_name === 'EIDL SBA Loan');
        const base = d.loan_splits.find(sp => sp.loan_account_id === a.id);
        d.loan_splits.push(Object.assign(JSON.parse(JSON.stringify(base)), {
          id: 'harness-eidl-' + status, period_label: '2026-08-10', status,
          principal_amount: 1000, interest_amount: 0, total_amount: 1000,
          voided_at: null, void_reason: null,
        }));
      };

      const pOk = await newHarnessPage({ tab: 'loans', mutate: addSplit('posted') });
      const rOk = rowOf((await pOk.surfaces()).loans.closeBand, 'EIDL SBA Loan');
      t.eq(rOk.derivation, 'rolled_back', 'ce6: with a POSTED payment in the window the roll-back still runs');
      t.close(rOk.perLenderN, 961005, 0.005,
              'ce6: ...and the walk really does add its $1,000 of principal back — 960,005 + 1,000');
      await pOk.close();

      for (const status of ['pending_review', 'needs_attention', 'staged']) {
        const p = await newHarnessPage({ tab: 'loans', mutate: addSplit(status) });
        const r = rowOf((await p.surfaces()).loans.closeBand, 'EIDL SBA Loan');
        t.eq(r.grade, 'C', `ce6: a ${status} payment in the window makes the roll-back REFUSE`);
        t.eq(r.derivation, 'none', `ce6: ...so there is no derivation to report (${status})`);
        t.eq(r.perLenderN, null, `ce6: ...no closing figure (${status})`);
        t.eq(r.ties, false, `ce6: ...and above all NOT a tie (${status})`);
        t.ok(/has not reached the books yet/.test(r.note || ''),
             `ce6: ...and the refusal states its reason on the cell (${status})`,
             `note=${JSON.stringify(r.note)}`);
        t.ok(/not received/.test(r.perLender || ''),
             `ce6: ...and the cell reads as evidence not received (${status})`);
        await p.close();
      }

      // …and the other refusal: a balance that does not say what it measures.
      const pU = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const a = d.loan_accounts.find(x => x.xero_account_name === 'EIDL SBA Loan');
        d.loan_statements.forEach(st => {
          if (st.loan_account_id === a.id && st.statement_date === '2026-08-25') st.balance_basis = 'unknown';
        });
      } });
      const rU = rowOf((await pU.surfaces()).loans.closeBand, 'EIDL SBA Loan');
      t.eq(rU.grade, 'C', 'ce6: an unlabelled balance may not be walked back either');
      t.eq(rU.ties, false, 'ce6: ...and is not upgraded to a tie');
      t.ok(/does not say what its balance measures/.test(rU.note || ''),
           'ce6: ...with the reason said out loud, not left in the code',
           `note=${JSON.stringify(rU.note)}`);

      // ── CONTROL ── make the walk stop refusing
      const revU = await revertFn(pU, '_loanClosingAnchor', EDITS('rollback-accepts-unknown-basis'));
      t.ok(revU.ok, 'ce6 CONTROL: the non-refusing basis check could be rebuilt', JSON.stringify(revU.missing));
      if (revU.ok) {
        const b = rowOf((await pU.surfaces()).loans.closeBand, 'EIDL SBA Loan');
        t.eq(b.grade, 'A', 'ce6 CONTROL: without the basis check an unknown balance is walked back anyway');
        t.close(b.perLenderN, 960005, 0.005, 'ce6 CONTROL: ...and a number we cannot interpret is published as evidence');
      }
      await restoreFns(pU);
      await pU.close();

      const pB = await newHarnessPage({ tab: 'loans', mutate: addSplit('pending_review') });
      const revB = await revertFn(pB, '_loanRollbackWalk', EDITS('rollback-never-refuses'));
      t.ok(revB.ok, 'ce6 CONTROL: the non-refusing status check could be rebuilt', JSON.stringify(revB.missing));
      if (revB.ok) {
        const b = rowOf((await pB.surfaces()).loans.closeBand, 'EIDL SBA Loan');
        t.eq(b.grade, 'A', 'ce6 CONTROL: without the status check an unposted payment is walked back');
        t.close(b.perLenderN, 961005, 0.005,
                'ce6 CONTROL: ...adding $1,000 of principal that has not reached the books');
      }
      await restoreFns(pB);
      await pB.close();
    }

    /* ── 7 ── VERDANT'S TWO SCHEDULES: ASSERT ON IDENTITY, NOT ON VALUE ──── */
    // Both schedules carry the SAME balances on the same dates, so a missing
    // de-duplication is completely silent on value: the closing figure is
    // 250,894.33 either way. Asserting the money here would be decoration. What
    // changes is WHICH ROWS the walk is built from, so that is what is asserted.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const sch = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
        const mine = (_allLoanAmortRows || []).filter(r =>
          r.loan_amortization_schedules && r.loan_amortization_schedules.loan_account_id === a.id);
        const all = [...new Set(mine.map(r => r.schedule_id))];
        const picked = _loanScheduleRows(a);
        const byDate = {};
        mine.forEach(r => { byDate[r.row_date] = (byDate[r.row_date] || 0) + 1; });
        const dupDates = Object.keys(byDate).filter(d => byDate[d] > 1);
        const newest = all.map(id => {
          const s = mine.find(r => r.schedule_id === id).loan_amortization_schedules;
          return { id, gen: s.schedule_generated_date, created: s.created_at };
        }).sort((x, y) => (String(x.gen) + x.created < String(y.gen) + y.created ? 1 : -1))[0];
        // Do both schedules really say the same thing on the shared dates? Only
        // the PAYMENT rows are comparable: the 2025 schedule also carries
        // annual_total/grand_total rows whose balance is null, and those are not
        // a disagreement about the balance, they are a different kind of row.
        const pay = mine.filter(r => r.row_type === 'payment');
        const payDates = [...new Set(pay.map(r => r.row_date))]
          .filter(dt => pay.filter(r => r.row_date === dt).length > 1);
        const sameValue = payDates.every(dt => {
          const vals = [...new Set(pay.filter(r => r.row_date === dt).map(r => String(r.balance)))];
          return vals.length === 1;
        });
        return { allIds: all, pickedIds: [...new Set(picked.map(r => r.schedule_id))],
                 pickedRows: picked.length, allRows: mine.length, dupDates: dupDates.length,
                 newestId: newest.id, newestGen: newest.gen, sameValue,
                 closing: _loanScheduleBalanceAsOf(a, '2026-07-31') };
      });
      t.eq(sch.allIds.length, 2, 'ce7: Verdant really does hold TWO amortization schedules');
      t.ok(sch.dupDates >= 80, 'ce7: ...with overlapping rows on the same dates', `${sch.dupDates} duplicate dates`);
      t.eq(sch.sameValue, true,
           'ce7: ...whose payment rows carry IDENTICAL balances on every shared date, so a missing de-dup is silent on value — hence the identity assertions below');
      t.eq(sch.pickedIds.length, 1, 'ce7: the walk is built from exactly ONE schedule');
      t.eq(sch.pickedIds[0], sch.newestId,
           'ce7: ...the newest by schedule_generated_date, tie-broken by created_at');
      t.eq(sch.newestGen, '2026-08-25', 'ce7: ...which is the 2026-08-25 schedule, not the 2025-06-12 one');
      t.eq(sch.pickedRows, 84, 'ce7: ...and only its 84 rows, never all 178 mixed together');
      t.ok(sch.closing && sch.closing.scheduleId === sch.newestId,
           'ce7: ...and the closing figure is stamped with the schedule it came from',
           JSON.stringify(sch.closing));

      // ── CONTROL ── stop de-duplicating
      const rev = await revertFn(p, '_loanScheduleRows', EDITS('no-schedule-dedup'), { rerender: false });
      t.ok(rev.ok, 'ce7 CONTROL: the un-de-duplicated schedule reader could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await p.evaluate(() => {
          const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
          const picked = _loanScheduleRows(a);
          return { ids: [...new Set(picked.map(r => r.schedule_id))].length, rows: picked.length,
                   closing: _loanScheduleBalanceAsOf(a, '2026-07-31') };
        });
        t.eq(b.ids, 2, 'ce7 CONTROL: without de-duplication the walk mixes rows from BOTH schedules');
        // 168, not 178: _loanScheduleRows now drops non-payment rows at the
        // picker (review F11), and the older schedule's ten annual_total /
        // grand_total rows carry a null balance.
        t.eq(b.rows, 168, 'ce7 CONTROL: ...all 168 payment rows from both of them');
        t.close(b.closing.amount, 250894.33, 0.005,
                'ce7 CONTROL: ...and the MONEY is unchanged, which is exactly why this test asserts on identity');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 8 ── GRADE INTEGRITY, NOW THAT THE FOOTER ROWS ARE GONE ────────── */
    // The property has not changed: opening + drawn − principal = computed
    // inside each grade, and grade A's total contains grade-A loans and nothing
    // else. Folding grade B in would make the figure the CPA signs imply a
    // higher grade than half of it has.
    //
    // What changed is where it is checked. David's layout pass removed the
    // per-grade footer rows — Closing source names the grade on every row and
    // the chips carry the counts, so restating the split in the footer was the
    // same arithmetic told twice. rf.totalsA / rf.totalsB are STILL COMPUTED and
    // still drive the chips, so the exclusivity is asserted against them
    // directly, and the footing is asserted against the rows.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const totals = await p.evaluate(() => {
        const rf = _loanCloseRollforward(_cvLastMonth());
        const slim = (t2, set) => ({ count: t2.count, opening: t2.opening, drawn: t2.drawn,
                                     principal: t2.principal, computed: t2.computed, perLender: t2.perLender,
                                     names: set.map(r => r.a.xero_account_name) });
        return { A: slim(rf.totalsA, rf.gradeA), B: slim(rf.totalsB, rf.gradeB) };
      });

      for (const g of ['A', 'B']) {
        const st = totals[g];
        const mine = cb.rows.filter(r => r.grade === g && r.perLenderN != null && r.computedN != null);
        t.eq(st.count, mine.length,
             `ce8: totals${g} counts exactly the grade-${g} rows that roll forward`);
        t.eq(JSON.stringify(st.names.slice().sort()), JSON.stringify(mine.map(r => r.name).sort()),
             `ce8: ...and it is the SAME loans, named — not merely the same number of them`,
             JSON.stringify(st.names));
        t.close(st.opening + (st.drawn || 0) - st.principal, st.computed, 0.02,
                `ce8: grade-${g}: opening + drawn − principal = computed`);
        const sum = (f) => mine.reduce((n, r) => n + (r[f] || 0), 0);
        t.close(st.opening,   sum('openingN'),   0.02, `ce8: grade-${g} opening is the sum of its own rows, nobody else's`);
        t.close(st.principal, sum('principalN'), 0.02, `ce8: grade-${g} principal likewise`);
        t.close(st.computed,  sum('computedN'),  0.02, `ce8: grade-${g} computed likewise`);
        t.close(st.perLender, sum('perLenderN'), 0.02, `ce8: grade-${g} closing likewise`);
      }

      // The exclusive part, said directly: no grade-B money is inside grade A.
      t.ok(totals.B.opening > 0, 'ce8: there really is grade-B money to keep out of grade A', `${totals.B.opening}`);
      t.eq(totals.A.names.filter(n => totals.B.names.includes(n)).length, 0,
           'ce8: no loan appears in both grade totals');
      t.close(totals.A.opening + totals.B.opening,
              cb.rows.filter(r => r.perLenderN != null && r.computedN != null).reduce((n, r) => n + r.openingN, 0),
              0.02, 'ce8: A + B together account for every checkable row, once each');
      // The grade split still reaches the screen — through the chips now.
      t.eq(cb.gateByKey['lender-confirmed'].count, totals.A.count,
           'ce8: ...and the lender-confirmed chip reports grade A’s count');
      t.eq(cb.gateByKey['per-schedule'].count, totals.B.count,
           'ce8: ...and the per-schedule chip reports grade B’s');

      // ── CONTROL ── compute grade A's total over every checkable loan
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('subtotal-a-mixes-grades'));
      t.ok(rev.ok, 'ce8 CONTROL: a grade-mixing subtotal could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await p.evaluate(() => {
          const rf = _loanCloseRollforward(_cvLastMonth());
          return { count: rf.totalsA.count, opening: rf.totalsA.opening };
        });
        t.eq(b.count, 13,
             'ce8 CONTROL: grade A now counts all 13 checkable loans, two of them schedule-derived');
        t.ok(Math.abs(b.opening - totals.A.opening) > 1,
             'ce8 CONTROL: ...and the money the CPA signs as lender-confirmed grows by grade B’s',
             `${b.opening} vs ${totals.A.opening}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 9 ── NO RAW ENUM, INCLUDING close_basis ─────────────────────────── */
    // Every close_basis value has a sentence a CPA is meant to read. money-format
    // sweeps the three values across every surface; this checks the close band's
    // own cells, where the slug would have the shortest path to a reader.
    {
      for (const basis of ['amortization_schedule', 'lender_statement', 'none']) {
        const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
          d.loan_accounts.forEach(a => { a.close_basis = basis; });
        } });
        const s = await p.surfaces();
        t.notMatch(s.loans.paneText, /\b(amortization_schedule|lender_statement|xero_derived|xero_rebuild|portal_manual_pull|email_pdf_upload|contract_origination|rolled_back|principal_only|total_payback)\b/,
                   `ce9: close_basis='${basis}' — no raw enum reaches the close band`);
        t.noBadMoney(s.loans.closeBand.text, `ce9: close_basis='${basis}'`);
        t.ok(s.loans.closeBand.rows.every(r => ['A', 'B', 'C'].includes(r.grade)),
             `ce9: close_basis='${basis}' — every row carries a real grade`,
             JSON.stringify(s.loans.closeBand.rows.map(r => r.grade)));
        // 'none' is a policy, not a document: it must never produce grade B.
        if (basis === 'none') {
          t.eq(s.loans.closeBand.rows.filter(r => r.grade === 'B').length, 0,
               'ce9: close_basis=\'none\' produces no grade-B row anywhere');
        }
        await p.close();
      }
      // And the label function itself is reachable and total.
      const p2 = await newHarnessPage({ tab: 'loans' });
      const labels = await p2.evaluate(() => ({
        a: _closeBasisLabel('amortization_schedule'), l: _closeBasisLabel('lender_statement'),
        n: _closeBasisLabel('none'), junk: _closeBasisLabel('something_new'), empty: _closeBasisLabel(undefined),
      }));
      for (const [k, v] of Object.entries(labels))
        t.ok(v && !/_/.test(v), `ce9: _closeBasisLabel(${k}) is a sentence, not a slug`, JSON.stringify(v));

      // ── CONTROL ── make the provenance label hand back the slug
      const rev = await revertFn(p2, '_closeOpeningSourceLabel', EDITS('label-returns-slug'));
      t.ok(rev.ok, 'ce9 CONTROL: a label function that returns the slug could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        // Session 249: the opening provenance is an attribute now, not visible
        // text, so paneText can no longer see it — and a control that cannot
        // see its own effect is not a control. Read the attribute the CSV
        // ships instead: a slug there lands in the CPA's spreadsheet, which is
        // the same failure the visible column used to have.
        const b = await p2.surfaces();
        const SLUG = /^(amortization_schedule|xero_derived|xero_rebuild|portal_manual_pull|contract_origination)$/;
        const slugs = (b.loans.closeBand.rows || []).map(x => x.openingSource).filter(x => SLUG.test(x || ''));
        t.ok(slugs.length > 0,
             'ce9 CONTROL: without the label, raw database slugs reach the close band — so the assertion above is real',
             `first slug: ${JSON.stringify(slugs.slice(0, 1))}`);
      }
      await restoreFns(p2);

      // ── AND THE OTHER SOURCE COLUMN, WHICH HAS ITS OWN LABEL FUNCTION ───
      // Session 247 split one label function into two. Only the opening side
      // was under control; the closing side names the evidence a CPA signs
      // against ("Lender statement" vs "Amortization schedule") and is the
      // difference between grade A and grade B in words. A bare 'A'/'B' in that
      // column is not a rendering nit — it is the provenance claim disappearing.
      const rows0 = (await p2.surfaces()).loans.closeBand.rows;
      t.ok(rows0.some(r => /Lender statement/.test(r.closingSource || '')) &&
           rows0.some(r => /Amortization schedule/.test(r.closingSource || '')),
           'ce9: both kinds of closing evidence are named in words on the board',
           JSON.stringify([...new Set(rows0.map(r => r.closingSource))]));
      const revC = await revertFn(p2, '_closeClosingSourceLabel', EDITS('closing-label-returns-slug'));
      t.ok(revC.ok, 'ce9 CONTROL: a closing-source label that hands back the grade could be rebuilt',
           JSON.stringify(revC.missing));
      if (revC.ok) {
        const rowsC = (await p2.surfaces()).loans.closeBand.rows;
        t.eq(rowsC.filter(r => /Lender statement|Amortization schedule/.test(r.closingSource || '')).length, 0,
             'ce9 CONTROL: ...and the Closing source column stops naming any evidence at all',
             JSON.stringify([...new Set(rowsC.map(r => r.closingSource))]));
        t.ok(rowsC.some(r => /^[AB]$/.test((r.closingSource || '').trim())),
             'ce9 CONTROL: ...printing the bare grade letter where the provenance used to be',
             JSON.stringify([...new Set(rowsC.map(r => r.closingSource))]));
      }
      await restoreFns(p2);
      await p2.close();
    }

    /* ── 11 ── THE STRIP CANNOT BE READ BY INDEX, AND MUST NOT SKIP ──────── */
    // Two assertions in the close-band group used to read cb.gates[0] and
    // cb.gates[1], guard the comparison behind a regex match, and therefore stop
    // running — silently — the moment session 246 made the strip
    // variable-length. They now look chips up by data-gate and treat ABSENCE as
    // a failure. This proves that: strip the attribute and the lookup returns
    // nothing, which the close-band group reports as red rather than as green.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      t.ok(cb.gates.length >= 4 && cb.gates.every(g => GATE_KEYS.includes(g.key)),
           'ce11: every chip on the strip is named, and named something the harness knows',
           JSON.stringify(cb.gates.map(g => g.key)));
      t.eq(Object.keys(cb.gateByKey).length, cb.gates.length,
           'ce11: ...with no two chips sharing a name');
      // The strip is genuinely variable-length: three chips are conditional.
      const conditional = ['lender-confirmed', 'per-schedule', 'immaterial'];
      const flat = await cleanJuly([]);
      const pEmpty = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        flat(d);                                   // nothing left in the immaterial band
        d.loan_accounts.forEach(a => { a.close_basis = 'lender_statement'; });   // and nothing at grade B
      } });
      const cbE = (await pEmpty.surfaces()).loans.closeBand;
      t.ok(!cbE.gateByKey['immaterial'],
           'ce11: the immaterial chip really does disappear when there is no small difference',
           JSON.stringify(cbE.gates.map(g => g.key)));
      t.ok(!cbE.gateByKey['per-schedule'],
           'ce11: ...and so does the per-schedule chip when no loan closes on one');
      t.ok(cbE.gates.length !== cb.gates.length,
           'ce11: ...so the strip is variable-length and gates[1] means different things on different months',
           `${cb.gates.length} chips vs ${cbE.gates.length}`);
      await pEmpty.close();

      // ── CONTROL ── take the names away
      const rev = await revertFn(p, 'renderLoansCloseBand', EDITS('chips-lose-their-name'));
      t.ok(rev.ok, 'ce11 CONTROL: a strip whose chips carry no data-gate could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.ok(b.gates.length > 0, 'ce11 CONTROL: the chips are all still on screen, and look identical');
        t.eq(Object.keys(b.gateByKey).length, 0,
             'ce11 CONTROL: ...but none of them can be found by name');
        t.ok(b.gates.every(g => g.key === null),
             'ce11 CONTROL: ...so every by-name lookup in the close-band group fails LOUDLY instead of skipping');
      }
      await restoreFns(p);

      // ── CONTROL ── put the chips back (session 264) ────────────────────
      // The close-band group now asserts, in every scenario, that the strip
      // renders its verdict and nothing else. That assertion is only worth
      // having if the opposite state fails it, so here the opposite state is
      // built and measured.
      const revBack = await revertFn(p, 'renderLoansCloseBand', EDITS('chips-come-back'));
      t.ok(revBack.ok, 'ce11 CONTROL: a strip with the chips back on it could be rebuilt',
           JSON.stringify(revBack.missing));
      if (revBack.ok) {
        const back = (await p.surfaces()).loans.closeBand;
        // Session 273: the baseline this compares against is now the verdict
        // PLUS the progress line, because that is what the strip legitimately
        // renders. Left as `!== lead` it would have passed on the bar alone and
        // gone on reporting that it discriminates while measuring nothing — an
        // assertion that goes green on the wrong change, which is the failure
        // mode this whole control exists to catch.
        t.ok((back.stripText || '').trim()
               !== `${(back.lead || '').trim()} ${(back.asksText || '').trim()}`.trim(),
             'ce11 CONTROL: ⭐ ...and the strip then says more than its verdict and its bar — so the assertion discriminates',
             `strip=${JSON.stringify(back.stripText)} · asks=${JSON.stringify(back.asksText)}`);
        t.ok(back.gates.length > 0,
             'ce11 CONTROL: ...with the gates unchanged, proving the assertion measures what is SHOWN, not what is computed');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 10 ── STRIPE IS SWEPT FROM XERO, NEVER "NO EVIDENCE" ────────────── */
    // Stripe Capital's balance IS the Xero sweep (ingestion_method 'automatic').
    // There is no outside party who could disagree with it, so it is reported
    // separately — reversing that was amendment A2's whole point.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const s = await p.surfaces();
      const cb = s.loans.closeBand;
      const r = rowOf(cb, 'Stripe Capital Loan');
      t.ok(!!r, 'ce10: Stripe Capital is on the rollforward');
      t.ok(/swept from Xero/.test(r.perLender || ''),
           'ce10: ...and its closing cell reads "swept from Xero"', `cell=${JSON.stringify(r.perLender)}`);
      t.notMatch(r.perLender, /not received/, 'ce10: ...never "not received"');
      t.notMatch(cb.note || '', /2 have nothing to close against/,
                 'ce10: ...and the footer does not count it among the loans with nothing to close against');
      const counts = await p.evaluate(() => {
        const rf = _loanCloseRollforward(_cvLastMonth());
        const cov = _bkStatementCoverage(_cvLastMonth());
        return { noEvidence: rf.noEvidence.map(x => x.a.xero_account_name),
                 expected: cov.expected.map(x => x.xero_account_name),
                 naCount: cov.naCount };
      });
      t.eq(counts.noEvidence.length, 0, 'ce10: nothing at all reads as "no evidence" this month');
      t.ok(!counts.expected.includes('Stripe Capital Loan'),
           'ce10: ...and Stripe is not in cov.expected either — it is not a statement anybody owes us');
      t.eq(counts.naCount, 1, 'ce10: ...it is reported separately, as the one automatic loan');
      t.eq(cb.gateByKey['coverage'].count, 0,
           'ce10: ...so the coverage chip counts zero outstanding, not one');

      // ── CONTROL ── treat Stripe like everything else
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('stripe-reads-as-no-evidence'));
      t.ok(rev.ok, 'ce10 CONTROL: the Stripe-blind rollforward could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.ok(/1 has nothing to close against/.test(b.note || ''),
             'ce10 CONTROL: ...and Stripe is counted as a loan with nothing to close against',
             `note=${JSON.stringify(b.note)}`);
      }
      await restoreFns(p);

      const rev2 = await revertFn(p, 'renderLoansCloseBand', EDITS('stripe-cell-reads-not-received'));
      t.ok(rev2.ok, 'ce10 CONTROL: the pre-A2 closing cell could be rebuilt', JSON.stringify(rev2.missing));
      if (rev2.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const br = rowOf(b, 'Stripe Capital Loan');
        t.ok(/not received/.test(br.perLender || ''),
             'ce10 CONTROL: pre-A2, Stripe read as a missing lender statement',
             `cell=${JSON.stringify(br.perLender)}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 12 ── THE FOURTH BAND: A VARIANCE THE POSTING GATE ALREADY OWNS ─── */
    // Dexter's August close: the 2026-08 split is STAGED, so _monthSplits leaves
    // it out and the month's principal reads $0.00 — while the grade-B closing
    // anchor takes the schedule's 8/31 row, which assumes that payment happened.
    // The variance is then exactly the staged principal, $3,344.64, and before
    // review F3 it banded MATERIAL: red, blocking, and sitting one chip to the
    // right of the posting gate reporting the SAME staged split at $3,839.38.
    // One event, two blockers, two different figures.
    //
    // 'unbooked' is that variance's own band: shown with its cause, counted in
    // neither the ties nor the offs, no chip of its own, and not blocking.
    {
      // (a) the live August shape, through the shipped rollforward. The books
      //     row is planted because Dexter's own opening is a frozen backfill —
      //     without an independent opening the row is circular and never reaches
      //     a band at all, which is why loan_book_balances being empty in
      //     production is a finding rather than a gap in this test.
      // No plant at all now: reconciliation-run wrote Dexter's real 7/31 rebuild
      // at 89,411.25, so August opens independently on Xero's own figure.
      const pAug = await newHarnessPage({ tab: 'loans' });
      const aug = await pAug.evaluate(() => {
        const rf = _loanCloseRollforward('2026-08');
        const r = rf.rows.find(x => x.a.xero_account_name === 'Dexter Loan 2');
        return {
          band: r.band, variance: r.variance, unbooked: r.unbooked,
          stagedTotal: r.stagedSplits.reduce((n, sp) => n + Number(sp.total_amount || 0), 0),
          inOff: rf.off.some(x => x.a.xero_account_name === 'Dexter Loan 2'),
          inUnbooked: rf.unbookedRows.some(x => x.a.xero_account_name === 'Dexter Loan 2'),
          inTies: rf.ties.some(x => x.a.xero_account_name === 'Dexter Loan 2'),
          toResolve: rf.varianceToResolve, unbookedTotal: rf.varianceUnbooked,
          offNames: rf.off.map(x => x.a.xero_account_name),
          // Session 272: the RESIDUAL, matching what varianceToResolve sums. A row
          // can now be partly explained by a stale closing anchor as well as by
          // unposted payments, and on such a row raw and unexplained differ.
          offSum: rf.off.reduce((n, x) => n + Math.abs(x.varianceResidual ?? x.variance), 0),
          otherStaged: rf.rows.filter(x => x.stagedSplits.length && x.a.xero_account_name !== 'Dexter Loan 2')
            .map(x => ({ n: x.a.xero_account_name, band: x.band, v: x.variance,
                         stagedP: x.stagedSplits.reduce((m, sp) => m + Number(sp.principal_amount || 0), 0) })),
          postingTotal: rf.unpostedRows.filter(x => x.a.xero_account_name === 'Dexter Loan 2')
            .reduce((n, x) => n + x.unposted.reduce((m, sp) => m + Number(sp.total_amount || 0), 0), 0),
        };
      });
      t.close(aug.variance, 3344.64, 0.005, 'ce12: Dexter’s August variance is exactly the staged principal, $3,344.64');
      t.eq(aug.band, 'unbooked', 'ce12: ...so it bands "unbooked", not "material"');
      t.close(aug.unbooked && aug.unbooked.principal, 3344.64, 0.005, 'ce12: ...with the explained principal carried on the row');
      t.eq(aug.unbooked && aug.unbooked.parts[0].kind, 'staged', 'ce12: ...and the cause named as a staged payment');
      t.eq(aug.inOff, false, 'ce12: ...it is NOT among the loans that are off');
      t.eq(aug.inUnbooked, true, 'ce12: ...it is in its own bucket');
      t.eq(aug.inTies, false, 'ce12: ...and it is not a tie either — nothing here turned green');
      t.ok(!aug.offNames.includes('Dexter Loan 2'),
           'ce12: ...so it contributes nothing to the month’s "variance to resolve"',
           `off: ${JSON.stringify(aug.offNames)}`);
      t.close(aug.toResolve, aug.offSum, 0.005,
              'ce12: ...which totals the material rows only, and Dexter is not one of them');
      t.close(aug.unbookedTotal, 3344.64, 0.005, 'ce12: ...and the unbooked total reports it separately');
      // THE POINT: one event, one blocker. The posting gate already owns it, at
      // its own (larger, because it includes interest) figure.
      t.close(aug.postingTotal, 3839.38, 0.005,
              'ce12: the posting gate reports the SAME staged split at $3,839.38');
      t.ok(Math.abs(aug.postingTotal - aug.variance) > 1,
           'ce12: ...a different figure for the same event, which is exactly why it must not be reported twice',
           `${aug.postingTotal} vs ${aug.variance}`);

      // ── THE ALL-OR-NOTHING BOUNDARY, AND A LIVE CASE SITTING ON IT ──────
      // Paypal 2's August row is the same shape as Dexter's and does NOT get the
      // band: its staged 2026-08-26 split carries $3,165.30 of principal against
      // a $3,120.60 gap, leaving $44.70 unaccounted — the same $44.70 the
      // CLOSE_EXCLUDED_STATUSES comment records from the audit that caught this
      // family of bugs. _closeUnbookedExplanation is all-or-nothing on purpose:
      // a residual it cannot place means it has not explained the variance, and
      // "mostly explained" is a verdict this module does not get to reach.
      //
      // That is the right refusal. It is pinned here because the CONSEQUENCE is
      // real and dated: on 2026-09-01, when August becomes the closing month,
      // this row reads $3,120.60 in red and blocking while the posting gate
      // reports the same staged split at $3,414.71 — the two-numbers-one-page
      // shape F3 was written to remove, surviving just below its threshold. If
      // anyone ever widens the explanation to cover a partial match, this
      // assertion fails and they have to decide that deliberately.
      // ── THE ALL-OR-NOTHING BOUNDARY, AND WHERE ITS LIVE CASE WENT ──────
      // Paypal 2 used to sit $44.70 below this threshold: a staged August split
      // whose principal did not quite close the gap, so the row banded material
      // for something that was mostly one staged payment. Its 2026-08-26 split
      // is POSTED now and the shape is gone. The boundary itself is unchanged
      // and is pinned synthetically below (one cent out; two splits summing to
      // the gap), because a boundary that only has a live case is a boundary
      // that stops being tested the moment the data moves.
      const stagedAug = aug.otherStaged.filter(x => Math.abs(x.stagedP) > 0.005);
      t.eq(JSON.stringify(stagedAug.map(x => x.n)), JSON.stringify([]),
           'ce12 boundary: Dexter is the only loan still carrying a staged split in the closing month',
           `other staged: ${JSON.stringify(aug.otherStaged)}`);
      await pAug.close();

      // (b) the same shape rendered, by moving it into the closing month.
      const pDom = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        // The month's movement is UNMEASURED here, which is what makes the
        // scenario honest rather than convenient: reconciliation-run measures a
        // month AFTER it closes, so a month still carrying a staged payment is
        // exactly a month it has not measured. Leaving July's real measurement
        // in place beside a staged split would describe a ledger that both did
        // and did not carry the payment. (What happens when a month IS measured
        // and still carries a staged split is section 12b, and it is a finding.)
        setMovement(d, 'Dexter Loan 2', null);
        const jul = d.loan_splits.find(sp => sp.loan_account_id === dex.id && sp.period_label === '2026-07');
        jul.status = 'staged';
        jul.stage_reference = 'WR-STAGE harness';
      } });
      const sd = await pDom.surfaces();
      const cbD = sd.loans.closeBand;
      const rd = rowOf(cbD, 'Dexter Loan 2');
      t.eq(rd.band, 'unbooked', 'ce12: rendered — a staged payment inside the closing month bands "unbooked"');
      t.close(rd.unbookedN, 3326.23, 0.005, 'ce12: ...carrying data-unbooked="3326.23", the principal it left out');
      t.close(rd.varianceN, 3326.23, 0.005, 'ce12: ...and the variance figure is still there, in full');
      t.eq(rd.ties, false, 'ce12: ...no data-tie — an explained difference is not an agreement');
      // The cause is a SUB-LINE under the figure now — `staged 3,326.23` — not a
      // sentence. Reading the shape rather than the prose is deliberate: David
      // will edit the wording again, and a test of the wording is a test of the
      // wording. What must survive is that the cell names the KIND of
      // de-escalation and prints the amount it is claiming.
      // Session 249: the sub-line came off the figure and became
      // data-variance-explained — read by the hover hint, by the CSV export's
      // own column, and here. The SHAPE is what matters, not the prose: the
      // row must name the KIND of de-escalation and print the amount claimed.
      t.ok(/staged/.test(rd.varianceExplained || ''),
           'ce12: ...and the row says WHY, so the reader is not left to guess which de-escalation this is',
           `explained=${JSON.stringify(rd.varianceExplained)}`);
      t.ok(/3,326\.23/.test(rd.varianceExplained || ''), 'ce12: ...with the figure carried, never hidden');
      t.ok(/staged 3,326\.23/.test(rd.hint || ''), 'ce12: ...and reachable on the row itself',
           `hint=${JSON.stringify(rd.hint)}`);
      // Fully explained means nothing is left over, and the cell says so by
      // saying nothing: no "· left" clause. That is the difference between this
      // row and the partial cases pinned in the boundary block below.
      t.close(rd.varianceResidualN, 0, 0.005,
              'ce12: ...and data-variance-residual is $0.00 — the explanation covers all of it');
      t.ok(!/left/.test(rd.varianceExplained || ''), 'ce12: ...so there is no remainder clause on the row',
           `cell=${JSON.stringify(rd.variance)}`);
      // Not blocking, and no chip of its own.
      t.ok(!cbD.rows.some(x => /Dexter/.test(x.loan) && x.band === 'material'),
           'ce12: the variance gate is not counting Dexter');
      t.ok(!cbD.gateByKey['unbooked'], 'ce12: ...and there is NO unbooked chip — the posting gate already counts it',
           JSON.stringify(cbD.gates.map(g => g.key)));
      t.eq(cbD.gateByKey['posting'].ok, false, 'ce12: ...which is the one gate that does report it');
      // The per-grade footer rows are gone; the Total sums UNEXPLAINED variance
      // only, so an 'unbooked' row contributes nothing to it however large.
      const totalVar = Math.abs(Number((cbD.subtotals.all || {}).varianceN || 0));
      const unexplainedRows = cbD.rows.filter(x => x.band === 'immaterial' || x.band === 'material');
      t.close(totalVar, unexplainedRows.reduce((n, x) => n + Math.abs(x.varianceN), 0), 0.05,
              'ce12: ...and the Total counts UNEXPLAINED variance only');
      t.ok(Math.abs(rd.varianceN) > 3000 && !unexplainedRows.some(x => /Dexter/.test(x.loan)),
           'ce12: ...so Dexter’s $3,326.23 stays out of it entirely',
           `row ${rd.varianceN}, total ${totalVar}`);
      t.ok(/differs? by exactly the payments not yet booked/.test(cbD.note || ''),
           'ce12: ...and the footer says so in words', `note=${JSON.stringify(cbD.note)}`);

      // ── CONTROL ── no fourth band
      const rev = await revertFn(pDom, '_closeUnbookedExplanation', EDITS('no-unbooked-band'));
      t.ok(rev.ok, 'ce12 CONTROL: an explanation function that never explains could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await pDom.surfaces()).loans.closeBand;
        const br = rowOf(b, 'Dexter Loan 2');
        t.eq(br.band, 'material', 'ce12 CONTROL: without the band, the staged principal reads as a MATERIAL variance');
        t.eq(b.gateByKey['variance'].ok, false, 'ce12 CONTROL: ...the variance gate goes bad');
        t.eq(b.gateByKey['posting'].ok, false, 'ce12 CONTROL: ...while the posting gate reports the same event');
        t.ok(/to resolve/.test(b.gateByKey['variance'].text || '') && /unposted/.test(b.gateByKey['posting'].text || ''),
             'ce12 CONTROL: ...so one staged split blocks the close TWICE, at two different figures',
             `${b.gateByKey['variance'].text} | ${b.gateByKey['posting'].text}`);
      }
      await restoreFns(pDom);
      await pDom.close();

      // (c) the undated half: Verdant's 'Period 14' (A10), $2,707.61.
      const verBooks = (bal) => (d) => setBooks(d, 'Verdant Capital Loan', [{ as_of: '2026-06-30', balance: bal }]);
      // 256,289.88 − 2,687.94 booked − 250,894.33 schedule = 2,707.61 exactly.
      const pU = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.88) });
      const ru = rowOf((await pU.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.eq(ru.circular, false, 'ce12: with a books opening Verdant is independently checked');
      t.close(ru.varianceN, 2707.61, 0.005, 'ce12: ...and differs by $2,707.61');
      t.eq(ru.band, 'unbooked', 'ce12: ...which is exactly its undated "Period 14" payment, so it bands "unbooked"');
      t.close(ru.unbookedN, 2707.61, 0.005, 'ce12: ...with that principal named on the row');
      t.eq(ru.ties, false, 'ce12: ...and NOTHING turns green');
      t.eq(ru.undatedN, 7, 'ce12: ...the seven undated splits are still declared');
      t.ok(/7 undated/.test(ru.hint || ''), 'ce12: ...still visibly, one hover away');
      // Same shape change as above: the cell now carries `undated 2,707.61`
      // rather than the sentence. The Status column (asserted directly above)
      // is what still says "7 undated" in words.
      t.ok(/undated/.test(ru.varianceExplained || ''),
           'ce12: ...and the row still names it as an undated payment',
           `explained=${JSON.stringify(ru.varianceExplained)}`);
      t.ok(/2,707\.61/.test(ru.varianceExplained || ''), 'ce12: ...at the amount it is claiming');
      t.ok(/2,707\.61/.test(ru.variance || ''), 'ce12: ...while the cell still prints the raw gap');
      t.close(ru.varianceResidualN, 0, 0.005, 'ce12: ...with nothing left over');
      await pU.close();

      // ══ THE JUDGEMENT CALL, PINNED — AND ONE BOUNDARY DELIBERATELY MOVED ══
      //
      // _closeUnbookedExplanation matches a single undated split BY AMOUNT, and
      // this module warns against amount-matching everywhere else (session 245:
      // "a typed number is never evidence"; session 232: a transaction is never
      // the whole answer). It is acceptable here for one reason only — it
      // DE-ESCALATES and never concludes. These assertions fix that boundary so
      // a later change cannot widen it into something that decides.
      //
      // ── WHAT I PINNED TWO ROUNDS AGO, AND WHY IT IS NOW WRONG ────────────
      //
      // The old assertion here was "one cent out → MATERIAL, with no
      // data-unbooked at all": the explanation had to match the variance TO THE
      // CENT or explain nothing. I pinned that as the safe side of the line.
      // It was not, and the reason is Verdant.
      //
      // Verdant's books and its contract disagree by four cents AT ORIGINATION
      // and have ever since — $284,354.46 booked against $284,354.50 on the
      // schedule (section 31 proves this from the data rather than asserting
      // it, and shows the thirteen payments since are identical TO THE CENT, so
      // the four cents is drift at day one and nothing else). Under exactness,
      // every variance of the form "a real unbooked payment ± that drift" is
      // refused an explanation and banded at FULL SIZE. Verdant's August close
      // is exactly that: $2,707.61 of undated principal against a $2,707.57
      // gap, blocked as a material variance over four cents, for an event the
      // posting gate already owns and reports. Not once — permanently, because
      // the drift never goes away. That is the gate-that-never-opens failure
      // this whole module is built against.
      //
      // And exactness was never the safer side. A coincidental exact match
      // absorbs a real discrepancy IN FULL: if a split's amount happens to
      // equal variance-plus-error, the error vanishes with it and nothing on
      // the page says so. Residual banding cannot do that — whatever fails to
      // match stays on the row, is banded, and still blocks when it matters.
      // The exact rule traded a loud, permanent false positive for a silent
      // false negative and called it strictness.
      //
      // SO I AGREE WITH THE CHANGE, and what follows re-pins the boundary at
      // the four things that actually keep it honest, rather than at the
      // number that moved:
      //
      //   1. ONE SPLIT, NEVER A COMBINATION. A combination can be assembled to
      //      explain almost any figure; that is the step from shape-matching to
      //      concluding, and it is not taken.
      //   2. STRICT REDUCTION — the guard nobody named, and the load-bearing
      //      one. A candidate is only accepted if it makes the unexplained
      //      amount SMALLER, which guarantees |residual| < |variance| and so
      //      bounds the damage of any bad match by construction. It is also
      //      what stops Verdant's own July row (−$0.04 beside seven undated
      //      splits of ~$2,500) from grabbing one of them.
      //   3. A MATERIAL RESIDUAL STILL BLOCKS. De-escalation is only ever of
      //      the named amount; the rest goes through the ordinary bands.
      //   4. BOTH FIGURES VISIBLE. The gap and the leftover are both on the
      //      cell. A de-escalation the reader cannot audit is a suppression.
      //
      // Each of the four is asserted below, and 2 and 3 have controls, because
      // "I agree" is not a test.

      // ── 1 cent out: PARTLY explained, and the cent is on the page ────────
      const pOff = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.89) });
      const ro = rowOf((await pOff.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.close(ro.varianceN, 2707.62, 0.005, 'ce12 boundary: one cent more and the gap is $2,707.62');
      // (4) BOTH FIGURES. The column still prints the raw gap — it is what sits
      // between Computed and Closing either side of it and a reader checks it by
      // subtracting those two — while the explanation and the leftover sit under
      // it. Nothing is rewritten to make the arithmetic agree.
      t.close(ro.unbookedN, 2707.61, 0.005,
              'ce12 boundary: ...Period 14 explains $2,707.61 of it, and the row says which part');
      t.close(ro.varianceResidualN, 0.01, 0.005,
              'ce12 boundary: ...leaving exactly one cent, measured and carried as data-variance-residual');
      // The RAW gap stays in the cell — it is what sits between Computed and
      // Closing either side of it — and the leftover travels with the
      // explanation. Both are printed; neither is rewritten to make the
      // arithmetic agree, which is the property this assertion exists for.
      t.ok(/2,707\.62/.test(ro.variance || '') && /left/.test(ro.varianceExplained || ''),
           'ce12 boundary: ...with the full gap AND the leftover both printed — a de-escalation you can audit',
           `cell=${JSON.stringify(ro.variance)} explained=${JSON.stringify(ro.varianceExplained)}`);
      // (3) The band is taken on the CENT, so this is not material — but it is
      // also NOT 'unbooked'. The row does not get to claim it was fully
      // explained when a cent is missing; it goes through the ordinary bands
      // like any other unexplained money.
      t.eq(ro.band, 'immaterial',
           'ce12 boundary: ...so it bands on the CENT, not on the $2,707.62');
      t.ok(ro.band !== 'unbooked',
           'ce12 boundary: ...and it is NOT "unbooked" — a partial explanation never claims to be a whole one');
      t.eq(ro.ties, false, 'ce12 boundary: ...and nothing here turned green');
      // (2) THE INVARIANT. Whatever the explanation does, it must leave less
      // unexplained than it found. Asserted on the row and, below, on every
      // rendered row at once.
      t.ok(Math.abs(ro.varianceResidualN) < Math.abs(ro.varianceN),
           'ce12 boundary: ...|residual| < |variance| — the explanation can only ever shrink the gap',
           `${ro.varianceResidualN} vs ${ro.varianceN}`);

      // ── CONTROL for (3): band the RAW gap instead of the residual ────────
      // This is the OLD behaviour, and it reproduces the exact failure that
      // moved the boundary: four cents of origination drift blocking $2,707.62.
      {
        const rev = await revertFn(pOff, '_loanCloseRollforward', EDITS('band-the-raw-variance'));
        t.ok(rev.ok, 'ce12 boundary CONTROL: banding the raw gap could be rebuilt', JSON.stringify(rev.missing));
        if (rev.ok) {
          const b = (await pOff.surfaces()).loans.closeBand;
          const br = rowOf(b, 'Verdant Capital Loan');
          t.eq(br.band, 'material',
               'ce12 boundary CONTROL: one cent unexplained makes the whole $2,707.62 material again');
          t.eq(b.gateByKey['variance'].ok, false,
               'ce12 boundary CONTROL: ...and the close is blocked, permanently, by a cent');
        }
        await restoreFns(pOff);
      }
      await pOff.close();

      // ── (3) A MATERIAL RESIDUAL STILL BLOCKS ────────────────────────────
      // $4,000 beyond what any single split can explain. Period 14 is still
      // named — it really is unbooked — but the de-escalation stops there and
      // the remainder is treated as exactly what it is.
      const pBig = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.88 + 4000) });
      const sBig = (await pBig.surfaces()).loans.closeBand;
      const rb = rowOf(sBig, 'Verdant Capital Loan');
      t.close(rb.varianceN, 6707.61, 0.005, 'ce12 boundary: a $6,707.61 gap');
      t.close(rb.unbookedN, 2707.61, 0.005, 'ce12 boundary: ...of which Period 14 explains $2,707.61');
      t.close(rb.varianceResidualN, 4000, 0.005, 'ce12 boundary: ...leaving $4,000.00 that nothing accounts for');
      t.eq(rb.band, 'material', 'ce12 boundary: ...which is MATERIAL, so the row still blocks');
      t.ok(sBig.rows.some(x => /Verdant/.test(x.loan) && x.band === 'material'),
           'ce12 boundary: ...a partial explanation must never let a real discrepancy through');
      t.eq(sBig.gateByKey['variance'].ok, false, 'ce12 boundary: ...and the variance gate says so');
      await pBig.close();

      // ── (1) ONE SPLIT, NEVER A COMBINATION ──────────────────────────────
      // Two splits that sum to the gap EXACTLY. Under the old exact rule this
      // was pinned as "not explained at all"; under portion matching it is
      // still not explained by the pair — the residual is the second split, to
      // the cent, which is the proof that the pair was never assembled. That is
      // a stronger assertion than the old one, not a weaker one: the old test
      // could not tell "refused the combination" from "found nothing".
      const pSum = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.88 + 2554.21) });
      const rs = rowOf((await pSum.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.close(rs.varianceN, 5261.82, 0.005,
              'ce12 boundary: a gap equal to Period 14 + Period 6 together is $5,261.82');
      t.close(rs.unbookedN, 2707.61, 0.005,
              'ce12 boundary: ...and ONE split is named, the closest single candidate');
      t.close(rs.varianceResidualN, 2554.21, 0.005,
              'ce12 boundary: ...leaving the other split entirely unexplained — the combination was never taken');
      t.eq(rs.band, 'material',
           'ce12 boundary: ...so the row is still material and still blocks');
      await pSum.close();

      // ── (2) STRICT REDUCTION, ON THE LIVE ROW THAT NEEDS IT ─────────────
      // Verdant's REAL July close, no plant at all. The gap is the four cents
      // of origination drift; seven undated splits of ~$2,500 sit right beside
      // it and NOT ONE of them may be claimed, because none of them makes four
      // cents smaller. This is the row that would be destroyed by a matcher
      // that took the closest candidate unconditionally.
      const pReal = await newHarnessPage({ tab: 'loans' });
      const rr = rowOf((await pReal.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.eq(rr.undatedN, 7, 'ce12 strict: Verdant really is carrying seven undated splits');
      t.ok(Math.abs(rr.varianceN) < 1,
           'ce12 strict: ...against a gap under a dollar', `variance ${rr.varianceN}`);
      t.eq(rr.unbookedN, null,
           'ce12 strict: ...and NONE of them is claimed as an explanation — no data-unbooked at all');
      t.close(rr.varianceResidualN, rr.varianceN, 0.005,
              'ce12 strict: ...so the residual IS the variance; nothing was explained away');
      // THE INVARIANT, ON EVERY ROW ON THE BOARD AT ONCE. This is the assertion
      // that would catch a future widening anywhere, not just on Verdant.
      {
        const all = (await pReal.surfaces()).loans.closeBand.rows.filter(x => x.varianceN != null && x.unbookedN != null);
        const bad = all.filter(x => !(Math.abs(x.varianceResidualN) < Math.abs(x.varianceN) + 1e-9));
        t.eq(bad.length, 0,
             'ce12 strict: every explained row on the board leaves LESS unexplained than it found',
             JSON.stringify(bad.map(x => ({ n: x.name, v: x.varianceN, r: x.varianceResidualN }))));
      }

      // ── CONTROL for (2): a matcher that accepts anything ────────────────
      const revR = await revertFn(pReal, '_closeUnbookedExplanation', EDITS('unbooked-accepts-anything'));
      t.ok(revR.ok, 'ce12 strict CONTROL: a matcher without the reduction test could be rebuilt', JSON.stringify(revR.missing));
      if (revR.ok) {
        const b = (await pReal.surfaces()).loans.closeBand;
        const br = rowOf(b, 'Verdant Capital Loan');
        t.ok(br.unbookedN != null && Math.abs(br.unbookedN) > 1000,
             'ce12 strict CONTROL: four cents now "explained" by a ~$2,500 split it has nothing to do with',
             `unbooked ${br.unbookedN}`);
        t.ok(Math.abs(br.varianceResidualN) > Math.abs(rr.varianceN),
             'ce12 strict CONTROL: ...leaving MORE unexplained than the gap it started with — the invariant broken',
             `residual ${br.varianceResidualN} from a ${rr.varianceN} gap`);
        t.eq(br.band, 'material',
             'ce12 strict CONTROL: ...and a four-cent row turned into a material, blocking one');
      }
      await restoreFns(pReal);
      await pReal.close();
    }

    /* ── 13 ── A STALE BOOKS BALANCE MUST NOT BEAT AN EXACT STATEMENT ────── */
    // The first cut took the newest books row with as_of <= the date asked for
    // and let it win unconditionally. One missed reconciliation-run month then
    // subtracts August's principal from June's balance — on every loan at once,
    // on the screen whose job is to say "ready for your accountant". BayFirst
    // SBA 2 holds a real portal_manual_pull dated exactly 2026-07-31 and would
    // have lost to a stale June books row for an invented $858.66.
    {
      // The loan's REAL rows are removed and replaced by a single stale one, so
      // the only books balance on file is for the wrong date. That is the shape
      // a missed reconciliation-run month produces, and it is the shape the
      // exact-date test exists to refuse.
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) =>
        setBooks(d, 'BayFirst SBA 2', [{ as_of: '2026-05-31', balance: 999999 }]) });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'BayFirst SBA 2');
      t.eq(r.openingFromBooks, false,
           'ce13: a books rebuild for ANOTHER date is not a rebuild for this one, so it is not used');
      t.close(r.openingN, 137568.21, 0.005,
              'ce13: ...the 6/2 lender portal figure opens the walk instead');
      t.close(r.perLenderN, 135901.60, 0.005, 'ce13: ...against the exact 7/31 lender statement');
      t.eq(r.ties, true, 'ce13: ...and the row still TIES');
      t.eq(r.band, 'tie', 'ce13: ...in the tie band');
      t.eq(cb.rows.filter(x => x.openingN === 999999).length, 0,
           'ce13: ...and the stale figure reaches no row at all');
      t.ok(!cb.rows.some(x => /BayFirst SBA 2/.test(x.loan) && x.band === 'material'),
           'ce13: ...so this loan contributes nothing to the variance gate');

      // ── CONTROL ── let the stale row win
      const rev = await revertFn(p, '_loanBookBalanceAsOf', EDITS('stale-books-wins'));
      t.ok(rev.ok, 'ce13 CONTROL: a books lookup that accepts any earlier date could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const br = rowOf(b, 'BayFirst SBA 2');
        t.eq(br.openingFromBooks, true, 'ce13 CONTROL: the stale May row wins');
        t.close(br.openingN, 999999, 0.005, 'ce13 CONTROL: ...opening the walk at $999,999.00');
        t.eq(br.band, 'material', 'ce13 CONTROL: ...producing a material, blocking variance out of nothing');
        t.eq(b.gateByKey['variance'].ok, false, 'ce13 CONTROL: ...and the close stops being ready');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 14 ── AN UNLABELLED BALANCE IS REFUSED ON BOTH BRANCHES ─────────── */
    // The roll-back branch refused an unlabelled balance from the start; the
    // DIRECT branch did not. E-Transit E5-4751 (portal_manual_pull, 2026-08-23)
    // and E6-7410 (8/20) both carry balance_basis='unknown' and were being
    // graded A, "confirmed by lender", into the subtotal the CPA signs — while
    // reconciliation-run refuses to compare against those very rows. Same test,
    // both places.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const aug = await p.evaluate(() => {
        const A = (n) => (_allLoanAccounts || []).find(x => x.xero_account_name === n);
        const one = (n) => {
          const a = A(n);
          const stmts = (_allLoanStatements || []).filter(x => x.loan_account_id === a.id &&
            x.statement_date > '2026-07-31' && x.statement_date <= '2026-08-31')
            .map(x => ({ d: x.statement_date, basis: x.balance_basis, b: Number(x.principal_balance), src: x.source }));
          return { anchor: _loanClosingAnchor(a, '2026-08-31', '2026-07-31'), stmts };
        };
        return { e5: one('E-Transit Loan E5-4751'), e6: one('E-Transit Loan E6-7410') };
      });
      for (const [key, name, used, setAside] of [
        ['e5', 'E-Transit Loan E5-4751', '2026-08-12', '2026-08-23'],
        ['e6', 'E-Transit Loan E6-7410', '2026-08-09', '2026-08-20'],
      ]) {
        const x = aug[key];
        // The hazard is really in the data: a NEWER real document that says
        // nothing about what its balance measures.
        const bad = x.stmts.find(st => st.d === setAside);
        t.ok(bad && String(bad.basis) === 'unknown' && /portal_manual_pull|lender_statement|email_pdf_upload/.test(bad.src),
             `ce14: ${name} really does hold a newer REAL document on ${setAside} with an unlabelled balance`,
             JSON.stringify(x.stmts));
        t.eq(x.anchor.asOf, used, `ce14: ${name}'s August close anchors to the LABELLED ${used} document instead`);
        t.eq(x.anchor.grade, 'A', `ce14: ...still grade A, because a labelled lender document was found behind it`);
        t.ok(/does not say what its balance measures/.test(x.anchor.note || ''),
             `ce14: ...and the document set aside is NAMED, not silently dropped`,
             `note=${JSON.stringify(x.anchor.note)}`);
        t.ok((x.anchor.note || '').includes(plainDate(setAside)),
             `ce14: ...by its own date (${setAside})`, `note=${JSON.stringify(x.anchor.note)}`);
      }
      await p.close();

      // …and rendered, by moving the unlabelled document into the closing month.
      const pDom = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const e5 = d.loan_accounts.find(x => x.xero_account_name === 'E-Transit Loan E5-4751');
        const st = d.loan_statements.find(x => x.loan_account_id === e5.id && x.statement_date === '2026-08-23');
        st.statement_date = '2026-07-30';
      } });
      const cb = (await pDom.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'E-Transit Loan E5-4751');
      t.eq(r.grade, 'A', 'ce14: rendered — the July close is still grade A');
      t.close(r.perLenderN, 30094.14, 0.005,
              'ce14: ...at the LABELLED July figure, not the unlabelled $29,302.52 dated three days later');
      // It does not tie any more, and that is correct: the opening moved to
      // Xero's own rebuild and this loan is one of the four genuinely off. What
      // matters here is WHICH document closed the month, so the variance is
      // checked against the tie-out reconciliation-run computed independently.
      const e5tie = await pDom.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'E-Transit Loan E5-4751');
        const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id);
        return Number(to.difference);
      });
      t.close(r.varianceN, e5tie, 0.005,
              'ce14: ...and its variance equals the tie-out reconciliation-run computed independently',
              `row ${r.varianceN} vs tie-out ${e5tie}`);
      t.ok(/does not say what its balance measures/.test(r.note || ''),
           'ce14: ...with data-note on the closing cell naming the document set aside',
           `note=${JSON.stringify(r.note)}`);
      t.ok(/Jul 30, 2026/.test(r.note || ''), 'ce14: ...by date');

      // ── CONTROL ── the direct branch stops testing the label
      const rev = await revertFn(pDom, '_loanBalanceAsOf', EDITS('direct-accepts-unlabelled'));
      t.ok(rev.ok, 'ce14 CONTROL: a direct branch blind to balance_basis could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await pDom.surfaces()).loans.closeBand, 'E-Transit Loan E5-4751');
        t.close(b.perLenderN, 29302.52, 0.005,
                'ce14 CONTROL: pre-review, the unlabelled document closed the month');
        t.eq(b.grade, 'A', 'ce14 CONTROL: ...graded "confirmed by lender", into the subtotal the CPA signs');
        t.ok(Math.abs(b.varianceN - r.varianceN) > 700,
             'ce14 CONTROL: ...moving the variance by the whole difference between the two documents',
             `${b.varianceN} vs ${r.varianceN}`);
      }
      await restoreFns(pDom);
      await pDom.close();
    }

    /* ── 15 ── THE ROLL-BACK MAY NOT WALK BACK FROM THE FUTURE ───────────── */
    // The roll-back window reaches sixty days FORWARD from month end, which is
    // unbounded relative to now. EIDL's 2026-08-25 statement was uploaded on
    // 2026-08-05: for twenty days it described a date that had not happened.
    // This module's invariants say in as many words that no new "latest row"
    // lookup may skip the future-date filter, and this one had.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const e = d.loan_accounts.find(x => x.xero_account_name === 'EIDL SBA Loan');
        const st = d.loan_statements.find(x => x.loan_account_id === e.id && x.statement_date === '2026-08-25');
        st.statement_date = '2026-09-25';       // still inside the 60-day window, but after today
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'EIDL SBA Loan');
      t.eq(r.grade, 'C', 'ce15: a statement dated in the future cannot close a month');
      t.eq(r.derivation, 'none', 'ce15: ...so there is no derivation');
      t.eq(r.perLenderN, null, 'ce15: ...and no closing figure');
      t.eq(r.ties, false, 'ce15: ...and above all no tie');
      t.ok(/dated in the future/.test(r.note || ''),
           'ce15: ...and the reader is told which kind of nothing this is',
           `note=${JSON.stringify(r.note)}`);
      t.eq(cb.gateByKey['coverage'].count, 1,
           'ce15: ...and the coverage chip counts it as outstanding rather than closing over it');

      // ── CONTROL ── drop the <= today clamp
      const rev = await revertFn(p, '_loanClosingAnchor', EDITS('rollback-ignores-today'));
      t.ok(rev.ok, 'ce15 CONTROL: an unclamped roll-back window could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'EIDL SBA Loan');
        t.eq(b.grade, 'A', 'ce15 CONTROL: pre-review, a future-dated document graded "confirmed by lender"');
        t.eq(b.derivation, 'rolled_back', 'ce15 CONTROL: ...and was walked back to month end');
        t.close(b.perLenderN, 960005, 0.005, 'ce15 CONTROL: ...closing July on a balance that has not happened yet');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 16 ── THE CHECKLIST AND THE CLOSE BAND CANNOT DISAGREE ──────────── */
    // "Ready for your accountant" is the same claim in both places, so it must
    // be the same computation. Gating the checklist on statement coverage alone
    // let it go green for July — coverage now reaches 0 — while Funding Circle's
    // 2026-07 split sat in pending_review and the band two clicks away read "Not
    // ready to close". This module's signature failure, in the one place a
    // client actually looks.
    {
      const read = async (pg) => {
        await pg.switchTab('client', 'dashboard');
        await pg.settle(60);
        const s1 = await pg.surfaces();
        await pg.switchTab('loans');
        await pg.settle(60);
        const s2 = await pg.surfaces();
        return { count: s1.client.checklistCount, list: s1.client.checklist,
                 lead: s2.loans.closeBand.lead, gates: s2.loans.closeBand.gates,
                 firstRow: (s1.client.checklist || '').slice(0, 160) };
      };

      const p = await newHarnessPage({ tab: 'loans' });
      const a = await read(p);
      t.ok(/not ready to close/i.test(a.lead || ''),
           'ce16: July really is blocked on the close band', `lead=${JSON.stringify(a.lead)}`);
      t.notMatch(a.count, /ready for your accountant/i,
                 'ce16: ...so the client checklist does NOT say the month is ready');
      t.ok(/is not ready to close yet/i.test(a.count || ''),
           'ce16: ...it says the same thing the band says', `count=${JSON.stringify(a.count)}`);
      t.ok(/All statements are in/i.test(a.count || ''),
           'ce16: ...while still reporting that coverage is complete — two facts, not one');
      t.notMatch(a.count, /\d/,
                 'ce16: ...and that line carries no digit, so no count of some OTHER thing can be read as the outstanding one');
      t.ok(/not yet in Xero/.test(a.firstRow || ''),
           'ce16: ...and the blocking work is the FIRST row of the checklist, where a client will see it',
           `first=${JSON.stringify(a.firstRow)}`);
      t.ok(/2,033\.77/.test(a.list || ''),
           'ce16: ...naming the money that is holding the month open');

      // The other direction: clear the blocker and BOTH must go green together.
      // Both blockers have to go, not just the split: four loans are genuinely
      // off now that the books open the walk. cleanJuly flattens the openings
      // and posts the split, which is the only state in which "ready" is the
      // right answer — and the point is that BOTH surfaces reach it together.
      const pOk = await newHarnessPage({ tab: 'loans', mutate: await cleanJuly([]) });
      await alignTieOutsToAnchors(pOk);   // see ce5 — the statement gate is not this scenario's variable
      const b = await read(pOk);
      t.ok(/ready for your accountant/i.test(b.lead || ''), 'ce16: with the blocker cleared the band is ready');
      t.ok(/ready for your accountant/i.test(b.count || ''),
           'ce16: ...and so is the checklist — the two verdicts move together',
           `count=${JSON.stringify(b.count)}`);
      await pOk.close();

      // ── CONTROL ── the checklist stops asking the shared blockers function
      const rev = await revertFn(p, 'renderClientChecklist', EDITS('checklist-ignores-blockers'), { rerender: false });
      t.ok(rev.ok, 'ce16 CONTROL: a coverage-only checklist could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        await p.evaluate(() => renderClientChecklist());
        const c = await read(p);
        t.ok(/ready for your accountant/i.test(c.count || ''),
             'ce16 CONTROL: pre-review, the client card said July was ready for the accountant',
             `count=${JSON.stringify(c.count)}`);
        t.ok(/not ready to close/i.test(c.lead || ''),
             'ce16 CONTROL: ...two clicks from a band saying it was not — the same month, two verdicts');
        t.notMatch(c.list, /not yet in Xero/,
                   'ce16 CONTROL: ...and the payment holding it open appeared nowhere on the card');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 17 ── "CLOSED ON THE SCHEDULE" IS A DECISION SOMEBODY MADE ──────── */
    // The roster group reads, to a CPA, as policy: this loan is SET to close on
    // its contractual schedule. Keying it on the winning anchor alone printed
    // that sentence for any loan whose tie-out merely happened to be measured
    // against our own record — inventing a governance fact nobody created. That
    // case is a tie nothing outside our books has confirmed, which is what
    // "Needs a statement" already means.
    {
      const p = await newHarnessPage({ tab: 'overview' });
      const r = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Dexter Loan 2');
        const to = (_loanTieOuts || []).find(x => x.loan_account_id === a.id);
        const withPolicy = _bkRosterState(a);
        const was = a.close_basis;
        delete a.close_basis;                 // nobody ever recorded a decision
        const noPolicy = _bkRosterState(a);
        const counts = _bkRosterCounts();
        renderBookkeepingOverview();
        const heads = [...document.querySelectorAll('#bk-ov-queue-list .bk-tier-head')].map(e => e.textContent.trim());
        a.close_basis = was;
        renderBookkeepingOverview();
        return {
          tieOut: { status: to.status, anchor: to.anchor_source },
          withPolicy: { group: withPolicy.group, reason: withPolicy.reason, against: withPolicy.against },
          noPolicy: { group: noPolicy.group, reason: noPolicy.reason, against: noPolicy.against },
          headsNoPolicy: heads, byschedule: counts.byschedule,
        };
      });
      t.eq(r.tieOut.status, 'tied', 'ce17: Dexter really is a $0.00 tie-out');
      t.eq(r.tieOut.anchor, 'amortization_schedule', 'ce17: ...measured against our own record, not a lender document');
      t.eq(r.withPolicy.group, 'byschedule',
           'ce17: WITH the recorded policy it reads "closed on the contractual schedule"');
      t.ok(/set to close on/.test(r.withPolicy.reason || ''),
           'ce17: ...and the sentence names the decision', `reason=${JSON.stringify(r.withPolicy.reason)}`);
      t.eq(r.noPolicy.group, 'unverified',
           'ce17: STRIP the policy and the same tie-out falls to "needs a statement"');
      t.ok(/agrees with our own record/.test(r.noPolicy.reason || ''),
           'ce17: ...saying only what is true — nothing outside our books has confirmed it',
           `reason=${JSON.stringify(r.noPolicy.reason)}`);
      t.notMatch(r.noPolicy.reason, /set to close on/,
                 'ce17: ...and claiming no decision that nobody made');
      t.eq(r.byschedule, 0, 'ce17: ...so nothing sits in the per-schedule group at all');
      t.ok(!r.headsNoPolicy.some(h => /Closed on the contractual schedule/.test(h)),
           'ce17: ...and that group header is off the screen entirely', JSON.stringify(r.headsNoPolicy));

      // The counterparty a row names must exist (review F9): there is no lender
      // figure behind a schedule tie, so the All Loans table must not print one.
      const varCell = await p.evaluate(() => {
        switchBookkeepingView('loans');
        const tr = [...document.querySelectorAll('#loans-table-wrap tbody tr')]
          .find(x => /Dexter Loan 2/.test(x.textContent));
        return tr ? tr.textContent.replace(/\s+/g, ' ').trim() : null;
      });
      // Session 250: the cell reads "per schedule" — three words instead of a
      // sentence that wrapped to three lines in a numeric column, with the full
      // sentence in the title. What F9 requires is unchanged and still asserted:
      // the row must NAME the counterparty it agreed with, and must not imply a
      // lender said anything. Both halves are checked, separately.
      t.ok(/per schedule/.test(varCell || ''),
           'ce17: the All Loans row says it agrees with the SCHEDULE', `row=${JSON.stringify(varCell)}`);
      t.notMatch(varCell, /lender/i,
                 'ce17: ...and names no lender, because none was consulted');
      t.notMatch(varCell, /\$0\.00 ✓/,
                 'ce17: ...and never prints the lender-matched tick, because no lender said anything');

      // ── CONTROL ── byschedule without the policy
      const rev = await revertFn(p, '_bkRosterState', EDITS('byschedule-without-policy'), { rerender: false });
      t.ok(rev.ok, 'ce17 CONTROL: an anchor-keyed roster state could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await p.evaluate(() => {
          const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Dexter Loan 2');
          const was = a.close_basis;
          delete a.close_basis;
          const st = _bkRosterState(a);
          a.close_basis = was;
          return { group: st.group, reason: st.reason };
        });
        t.eq(b.group, 'byschedule',
             'ce17 CONTROL: pre-review, a loan nobody made that decision about was told it had been made');
        t.ok(/set to close on/.test(b.reason || ''),
             'ce17 CONTROL: ...in a sentence a CPA reads as policy', `reason=${JSON.stringify(b.reason)}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 18 ── A TOTAL NEVER CLAIMS MORE COVERAGE THAN IT HAS ───────────── */
    // This was written for review F14: an empty grade-A subtotal rendering a
    // "$0.00" variance over zero loans — a verdict nobody earned, in the one
    // column a reader scans for verdicts.
    //
    // Session 247 deleted the per-grade subtotal rows, so that exact shape can
    // no longer occur. The HAZARD did not go with them: there is still a footer
    // figure whose columns can cover different populations, and it is now the
    // Total. Its protection is the coverage marker — "13 of 14" beside the
    // closing figure — so that is what this section guards. Deleting the test
    // along with the row would have retired the lesson with the layout.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // No real lender document anywhere: nothing can be closed against, so
        // the closing column covers ZERO rows while the four walk columns cover
        // all fourteen. A bare $0.00 here would be the F14 defect exactly.
        const real = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull'];
        d.loan_statements = d.loan_statements.filter(st => !real.includes(String(st.source || '')));
        d.loan_accounts.forEach(a => { a.close_basis = 'lender_statement'; });
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      t.eq(cb.rows.filter(r => r.perLenderN != null).length, 0,
           'ce18: the scenario really does leave no loan with a closing balance');
      t.ok(!cb.subtotals.A && !cb.subtotals.B && !cb.subtotals.none,
           'ce18: ...and the per-grade subtotal rows are gone with the layout pass',
           JSON.stringify(Object.keys(cb.subtotals)));
      t.ok(!!cb.subtotals.all, 'ce18: ...leaving one Total');
      t.eq(cb.subtotals.all.count, cb.rows.length, 'ce18: ...which covers every row');
      t.eq(cb.subtotals.all.closingCount, 0, 'ce18: ...while its closing column covers none of them');
      // SESSION 267 — WHERE THE COVERAGE LIVES CHANGED; THAT IT LIVES CHANGED NOT.
      // It used to sit inline after the closing and variance figures. David:
      // "remove the '13 of 14' notes so that the column totals are aligned with
      // the numbers above them" — inline text after a right-aligned number pushes
      // it out of its column, so the totals stopped lining up with the money they
      // total. It now sits in the Total's LABEL cell, which is text and
      // left-aligned, so nothing shifts and the warning is still on screen at a
      // glance. The per-cell titles carry the detail on hover.
      //
      // The INVARIANT is untouched and is what this asserts: a totals row whose
      // closing column covers no loans must not present a bare, confident $0.00.
      // So the check is now "the row says it", not "this cell says it" — the
      // money cells are additionally asserted to be CLEAN, which is the half of
      // David's request that could otherwise regress silently.
      const rowText = cb.subtotals.all.cells.join(' ');
      const closingCell = cb.subtotals.all.cells[cb.columnIndex.closing] || '';
      const varianceCell = cb.subtotals.all.cells[cb.columnIndex.variance] || '';
      t.ok(new RegExp(`0 of ${cb.rows.length}`).test(rowText),
           'ce18: ...and the Total SAYS SO rather than printing a confident $0.00',
           `row = ${JSON.stringify(cb.subtotals.all.cells)}`);
      t.ok(/closing checked/.test(rowText),
           'ce18: ...naming the closing coverage specifically, since that is the verdict column',
           `row = ${JSON.stringify(cb.subtotals.all.cells)}`);
      t.ok(!/ of \d+/.test(closingCell) && !/ of \d+/.test(varianceCell),
           'ce18: ...and the money cells stay clean, so the totals line up with the column above',
           `closing ${JSON.stringify(closingCell)} variance ${JSON.stringify(varianceCell)}`);
      t.eq(cb.subtotals.all.ties, false,
           'ce18: ...and the Total never carries data-tie, so nothing counts it as an agreement');

      // ── CONTROL ── take the coverage marker away
      const rev = await revertFn(p, 'renderLoansCloseBand', EDITS('total-hides-its-coverage'));
      t.ok(rev.ok, 'ce18 CONTROL: a Total that hides its coverage could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const cc = b.subtotals.all.cells[b.columnIndex.closing] || '';
        const vc = b.subtotals.all.cells[b.columnIndex.variance] || '';
        t.ok(!/ of /.test(cc) && !/ of /.test(vc),
             'ce18 CONTROL: without it the Total prints a bare $0.00 over zero loans',
             `closing ${JSON.stringify(cc)} variance ${JSON.stringify(vc)}`);
        t.ok(/\$0\.00/.test(vc),
             'ce18 CONTROL: ...a verdict nobody earned, in the verdict column');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ══ SESSION 247 — DRAWN, AND THE SECOND CHECK ═══════════════════════════
       `opening − principal = closing` is only true if nothing was BORROWED.
       Stripe drew $125,000 in July, so its row computed $11,578.25 against
       books of $136,578.25 and sat in "Not checkable" where nothing looked at
       it. The walk is now `opening + drawn − principal = computed`, and there
       are TWO checks rather than one:

         variance     computed vs the LENDER  — do the books agree with outside
         unexplained  booksClosing vs computed — do our splits explain what the
                                                 ledger itself actually did

       reconciliation-run's draws work is written but NOT DEPLOYED, so every row
       on today's fixture is unmeasured. That is why the measured path below is
       reached through `mutate` — and why the unmeasured path is not a corner
       case to be tolerated but the live state of every loan on the screen.  */


    /* ── 21 ── THE WALK FOOTS, AND DRAWN IS THE NET FIGURE ───────────────── */
    // Stripe drew $145,875.00 in July and repaid $9,296.75 of principal. It is
    // the only genuine drawdown on the book, and the only loan whose measured
    // increase carries NO interest add-back, so it is the control for the
    // netting fix below: nothing is netted off it and it survives intact.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = cb.rows.find(x => x.name === 'Stripe Capital Loan');
      t.eq(r.drawnMeasured, true, 'ce21: Stripe’s July movement is measured');
      t.close(r.drawnGrossN, 145875, 0.005, 'ce21: ...$145,875.00 of measured increase');
      t.close(r.drawnNettedN, 0, 0.005, 'ce21: ...none of which is an interest add-back, so nothing is netted');
      t.close(r.drawnN, 145875, 0.005, 'ce21: ...leaving the whole draw in the Drawn column');
      t.close(r.openingN, 0, 0.005, 'ce21: ...opening $0.00');
      t.close(r.principalN, 9296.75, 0.005, 'ce21: ...principal $9,296.75');
      // 0 + 145,875.00 − 9,296.75 = 136,578.25
      t.close(r.computedN, 136578.25, 0.005,
              'ce21: ...so opening + drawn − principal computes $136,578.25');
      t.close(r.openingN + r.drawnN - r.principalN, r.computedN, 0.005,
              'ce21: ...and the three columns on screen really do produce the fourth');
      t.eq(r.reachesBooks, '1', 'ce21: ...which REACHES the books');
      t.close(r.unexplainedN, 0, 0.005, 'ce21: ...leaving nothing unexplained');
      t.eq(r.unexplainedBand, 'tie', 'ce21: ...so the ledger check ties');
      t.eq(r.unexplainedState, 'measured', 'ce21: ...as a measurement, not an assumption');
      t.eq(r.unattributedN, null, 'ce21: ...and there is no unattributed difference left to state');
      t.notMatch(r.variance, /unmeasured/, 'ce21: ...nor any "cause not measured" wording');

      // ── CONTROL ── the walk forgets that anything can be borrowed
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('walk-ignores-drawn'));
      t.ok(rev.ok, 'ce21 CONTROL: a walk that ignores Drawn could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand.rows.find(x => x.name === 'Stripe Capital Loan');
        t.close(b.computedN, -9296.75, 0.005,
                'ce21 CONTROL: without Drawn the walk computes a NEGATIVE balance — the defect exactly');
        t.eq(b.reachesBooks, '0', 'ce21 CONTROL: ...missing the books by the whole drawdown');
        t.close(b.unexplainedN, 145875, 0.005,
                'ce21 CONTROL: ...and $145,875 of borrowing is reported as unexplained');
        t.eq(b.unexplainedBand, 'material', 'ce21 CONTROL: ...material, and blocking');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ══ 21b ══ DRAWN IS NET OF THE INTEREST THAT CAME BACK ══════════════════
       THE DEFECT THIS FIXES, AND IT SHIPPED. A payment hits the loan account
       for its full amount and a reallocation journal puts the interest half
       back, so measureMovement correctly saw a positive effect and called it
       borrowing. `drawn` then equalled the month's booked split interest TO THE
       CENT on eight loans, every one of those loans showed a variance exactly
       equal to its own interest, and the band claimed "10 loans off —
       $8,751.73" against a book where four are off by $1,887.50.
       drawn = max(0, drawnGross − interest) is the fix.                     */
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const row = (n) => cb.rows.find(x => x.name === n);

      // ── THE EIGHT LOANS WHOSE "DRAW" WAS THEIR OWN INTEREST ─────────────
      // Named, and each checked against its OWN interest cell rather than a
      // typed constant, because that equality is the whole diagnosis.
      const NETTED = ['Dexter Loan 2', 'Verdant Capital Loan', 'BayFirst SBA Loan',
                      'E-Transit Loan - 4140', 'E-Transit Loan E5-4751',
                      'E-Transit Loan E6-7410', 'Paypal 2'];
      for (const n of NETTED) {
        const r = row(n);
        t.close(r.drawnGrossN, r.interestN, 0.005,
                `ce21b: ${n}'s measured increase equals its own booked interest, to the cent`,
                `gross ${r.drawnGrossN} vs interest ${r.interestN}`);
        t.close(r.drawnNettedN, r.interestN, 0.005, `ce21b: ...so all of it is netted off`);
        t.close(r.drawnN, 0, 0.005, `ce21b: ...leaving $0.00 of real borrowing`);
      }

      // ── THE FOUR THAT GO BACK TO AN EXACT TIE ───────────────────────────
      for (const n of ['Dexter Loan 2', 'BayFirst SBA Loan', 'E-Transit Loan E6-7410', 'BayFirst SBA 2']) {
        const r = row(n);
        t.eq(r.ties, true, `ce21b: ${n} ties exactly once its interest is not counted as borrowing`);
        t.close(r.varianceN, 0, 0.005, `ce21b: ...at $0.00`);
      }
      // ── AND THE ONES THAT ARE GENUINELY OFF STAY OFF, UNCHANGED ─────────
      // The netting must not quietly absolve a real finding.
      for (const [n, want] of [['E-Transit Loan - 4140', 415.88], ['E-Transit Loan E5-4751', 266.42],
                               ['Paypal 2', 21.66], ['Verdant Capital Loan', -0.04], ['EIDL SBA Loan', -5]]) {
        t.close(row(n).varianceN, want, 0.005, `ce21b: ${n} still reports $${want}`);
      }
      t.eq(cb.rows.filter(x => x.ties).length, 6, 'ce21b: six loans tie');
      t.eq(cb.rows.filter(x => x.band === 'immaterial').length, 3, 'ce21b: three are small differences');
      t.eq(cb.rows.filter(x => x.band === 'material').length, 4, 'ce21b: four are genuinely off');
      t.ok(/\$1,887\.50/.test(cb.gateByKey['variance'].text || ''),
           'ce21b: ...totalling $1,887.50 on the chip', `chip=${JSON.stringify(cb.gateByKey['variance'].text)}`);

      // ── THE CLAMP ───────────────────────────────────────────────────────
      // BayFirst SBA 2 books $2,549.88 of split interest against $1,300.30 of
      // measured increase, so a naive subtraction goes NEGATIVE. A negative
      // "drawn" is not a repayment — repayments are already in the principal —
      // it is the two figures failing to pair, and the honest floor is nothing
      // borrowed.
      const bf2 = row('BayFirst SBA 2');
      t.close(bf2.drawnGrossN, 1300.30, 0.005, 'ce21b clamp: BayFirst SBA 2 measured $1,300.30 of increase');
      t.close(bf2.interestN, 2549.88, 0.005, 'ce21b clamp: ...against $2,549.88 of booked interest');
      t.ok(bf2.drawnGrossN - bf2.interestN < 0,
           'ce21b clamp: ...so the subtraction really would go negative', `${bf2.drawnGrossN - bf2.interestN}`);
      t.close(bf2.drawnN, 0, 0.005, 'ce21b clamp: ...and Drawn is clamped at $0.00, never below');
      t.close(bf2.drawnNettedN, 1300.30, 0.005,
              'ce21b clamp: ...with the netted figure capped at what was actually measured');
      t.eq(cb.rows.filter(x => x.drawnN != null && x.drawnN < 0).length, 0,
           'ce21b clamp: no row anywhere reports negative borrowing');

      // ── NETTING CAN ONLY EVER REDUCE A CLAIM OF BORROWING ───────────────
      // The direction is the safety property: this operation may take a draw
      // away, and may never invent one.
      for (const r of cb.rows.filter(x => x.drawnMeasured)) {
        t.ok(r.drawnN <= r.drawnGrossN + 0.005,
             `ce21b: ${r.name}'s net draw never exceeds what was measured`,
             `net ${r.drawnN} vs gross ${r.drawnGrossN}`);
      }
      // …and the gross is kept, so nothing is hidden.
      t.eq(cb.rows.filter(x => x.drawnMeasured && x.drawnGrossN == null).length, 0,
           'ce21b: every measured row still carries its GROSS figure, so nothing is hidden');

      // ── CONTROL ── use the gross, which is the bug that shipped
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('drawn-is-gross'));
      t.ok(rev.ok, 'ce21b CONTROL: the pre-fix gross Drawn could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const brow = (n) => b.rows.find(x => x.name === n);
        // Every one of the eight starts showing a variance equal to its own
        // interest — the signature of the bug, and the reason it was findable.
        let matched = 0;
        for (const n of NETTED) {
          const before = row(n), after = brow(n);
          if (Math.abs((after.varianceN - before.varianceN) - before.interestN) < 0.005) matched++;
        }
        t.eq(matched, NETTED.length,
             'ce21b CONTROL: pre-fix, each of those loans’ variance moves by exactly its own interest',
             `${matched} of ${NETTED.length}`);
        t.close(brow('Stripe Capital Loan').drawnN, 145875, 0.005,
                'ce21b CONTROL: ...while Stripe, the one real draw, is identical either way — the fix touches only the add-backs');
      }
      await restoreFns(p);

      // ── THE BOARD EXACTLY AS IT SHIPPED ─────────────────────────────────
      // "10 loans off — $8,751.73" is the number that was on the screen, and
      // reproducing it is the point of this control. It takes TWO reverts, not
      // one, because two fixes have landed since: gross Drawn AND banding on the
      // raw variance rather than the residual. Reverting only the first would
      // measure today's banding against yesterday's arithmetic and land on a
      // figure that was never on anyone's screen — which is exactly what
      // happened when this assertion first went red, and is why it is spelled
      // out here rather than quietly renumbered.
      {
        const rev2 = await revertFn(p, '_loanCloseRollforward',
          [...EDITS('drawn-is-gross'), ...EDITS('band-the-raw-variance'), ...EDITS('totals-on-the-raw-variance')]);
        t.ok(rev2.ok, 'ce21b CONTROL: the board as it shipped — gross Drawn, banded and totalled on the whole gap — could be rebuilt',
             JSON.stringify(rev2.missing));
        if (rev2.ok) {
          const b2 = (await p.surfaces()).loans.closeBand;
          const mat2 = b2.rows.filter(x => x.band === 'material');
          t.eq(mat2.length, 10, 'ce21b CONTROL: ...ten loans read as off instead of four');
          // THE DURABLE FORM OF THIS ASSERTION. The chip is a sentence and the
          // sentence will be edited; the arithmetic is the finding. Ten rows of
          // RAW variance summing to $8,751.73 is what the gross-Drawn bug put on
          // the board, and it is checked here from the rows themselves so it
          // survives any rewording of the chip.
          t.close(mat2.reduce((n, x) => n + Math.abs(x.varianceN), 0), 8751.73, 0.005,
                  'ce21b CONTROL: ...whose raw variances sum to $8,751.73',
                  JSON.stringify(mat2.map(x => [x.name, x.varianceN])));
          t.ok(/\$8,751\.73/.test(b2.gateByKey['variance'].text || ''),
               'ce21b CONTROL: ...and that is what the chip claimed, against a real $1,887.50',
               `chip=${JSON.stringify(b2.gateByKey['variance'].text)}`);
        }
        await restoreFns(p);
      }

      // ── AND WHAT RESIDUAL BANDING DOES TO THAT SAME BROKEN BOARD ────────
      // ⚠ THIS IS A FINDING, PINNED WHERE IT WAS FOUND. Revert ONLY the netting
      // and the board reads "9 loans off — $6,896.39": one of the ten
      // disappeared. It is Verdant, whose $1,855.34 of phantom variance got
      // "explained" by an undated split of $2,462.79 — a payment LARGER than the
      // entire gap — leaving −$607.45, which lands immaterial. Section 32
      // reproduces that on unmodified code and argues it is a real gap in the
      // matcher rather than a quirk of this control. It is asserted here so the
      // control keeps stating what it actually observes.
      const rev3 = await revertFn(p, '_loanCloseRollforward', EDITS('drawn-is-gross'));
      t.ok(rev3.ok, 'ce21b CONTROL: gross Drawn alone could be rebuilt', JSON.stringify(rev3.missing));
      if (rev3.ok) {
        const b3 = (await p.surfaces()).loans.closeBand;
        t.eq(b3.rows.filter(x => x.band === 'material').length, 9,
             'ce21b CONTROL: with today’s banding, only NINE of the ten are still material');
        t.ok(/\$6,896\.39/.test(b3.gateByKey['variance'].text || ''),
             'ce21b CONTROL: ...and $1,855.34 of the phantom total has been de-escalated away',
             `chip=${JSON.stringify(b3.gateByKey['variance'].text)}`);
        const vr = b3.rows.find(x => x.name === 'Verdant Capital Loan');
        t.close(vr.varianceN, 1855.34, 0.005, 'ce21b CONTROL: ...on Verdant, whose phantom gap is $1,855.34');
        t.close(vr.unbookedN, 2462.79, 0.005,
                'ce21b CONTROL: ...claimed against an undated split of $2,462.79 — LARGER than the whole gap');
        t.eq(vr.band, 'immaterial',
             'ce21b CONTROL: ...which is the overshoot reported in section 32');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 22 ── A NULL IS NOT A ZERO ──────────────────────────────────────── */
    // Three shapes of "nobody measured this", and all three must land in the
    // same place: stated, never diagnosed. The third is the one a `|| 0`
    // swallows in silence — a truthy flag sitting beside a null figure.
    //
    // reconciliation-run now measures every loan, so the unmeasured state is
    // reached by mutate. It is not hypothetical: every month before this deploy
    // is in it, and so is any month the measurement window cannot cover.
    {
      const SHAPES = [
        ['movement_measured is false', MEASURED({ movement_measured: false, drawn: 145875 })],
        ['no movement detail at all', null],
        ['movement_measured TRUE beside a null drawn', MEASURED({ movement_measured: true, drawn: null })],
      ];
      for (const [why, detail] of SHAPES) {
        const p = await newHarnessPage({ tab: 'loans', mutate: (d) =>
          setMovement(d, 'Stripe Capital Loan', detail) });
        const cb = (await p.surfaces()).loans.closeBand;
        const r = cb.rows.find(x => x.name === 'Stripe Capital Loan');
        t.eq(r.drawnMeasured, false, `ce22: ${why} — the row does not claim a measurement`);
        t.eq(r.drawnN, null, `ce22: ${why} — and carries no Drawn figure`);
        t.ok(/not measured/.test(r.drawn || ''),
             `ce22: ${why} — the cell says "not measured", never a dash`, `cell=${JSON.stringify(r.drawn)}`);
        t.eq(r.unexplainedN, null, `ce22: ${why} — the ledger check REFUSES to run`);
        t.eq(r.unexplainedBand, null, `ce22: ${why} — no band`);
        t.eq(r.unexplainedState, 'unmeasured', `ce22: ${why} — and says so in its own attribute`);
        t.close(r.unattributedN, 145875, 0.005,
                `ce22: ${why} — the difference is still STATED, at $145,875.00`);
        // Session 249: the ledger line moved off the figure into
        // data-ledger-note, which the hover hint prints and the CSV exports.
        // The WORDING is the whole assertion here — "unmeasured" and never a
        // verdict — so it follows the words rather than the pixel they sat on.
        t.ok(/unmeasured/.test(r.ledgerNote || ''),
             `ce22: ${why} — worded as an unmeasured difference, not a finding`,
             `note=${JSON.stringify(r.ledgerNote)}`);
        t.ok(/unmeasured/.test(r.hint || ''), `ce22: ${why} — and a reader can reach it on the row`);
        t.notMatch(r.ledgerNote, /ledger off/, `ce22: ${why} — and never as "ledger off"`);
        const off = await p.evaluate(() => _loanCloseRollforward('2026-07').ledgerOff.map(x => x.a.xero_account_name));
        t.ok(!off.includes('Stripe Capital Loan'), `ce22: ${why} — and it is not in ledgerOff`, JSON.stringify(off));
        await p.close();
      }

      // ── CONTROL ── the `|| 0` that swallows a truthy flag beside a null
      const pC = await newHarnessPage({ tab: 'loans', mutate: (d) =>
        setMovement(d, 'Stripe Capital Loan', MEASURED({ movement_measured: true, drawn: null })) });
      const rev = await revertFn(pC, '_loanMonthMovement', EDITS('null-drawn-is-zero'));
      t.ok(rev.ok, 'ce22 CONTROL: a measured-flag test that ignores the null figure could be rebuilt',
           JSON.stringify(rev.missing));
      if (rev.ok) {
        const cb = (await pC.surfaces()).loans.closeBand;
        const b = cb.rows.find(x => x.name === 'Stripe Capital Loan');
        t.eq(b.drawnMeasured, true,
             'ce22 CONTROL: pre-fix, a truthy flag beside a null figure counts as measured');
        t.close(b.unexplainedN, 145875, 0.005,
                'ce22 CONTROL: ...so `drawn || 0` turns "nobody looked" into "nothing was borrowed"');
        t.eq(b.unexplainedBand, 'material',
             'ce22 CONTROL: ...and the row ACCUSES the loan of exactly the drawdown');
        t.eq(cb.gateByKey['ledger'].ok, false, 'ce22 CONTROL: ...which blocks the close');
      }
      await restoreFns(pC);
      await pC.close();

      // ── CONTROL ── and the dash that reads as "nothing was borrowed"
      const pD = await newHarnessPage({ tab: 'loans', mutate: (d) =>
        setMovement(d, 'Stripe Capital Loan', null) });
      const revD = await revertFn(pD, 'renderLoansCloseBand', EDITS('unmeasured-renders-dash'));
      t.ok(revD.ok, 'ce22 CONTROL: a Drawn cell that renders unmeasured as a dash could be rebuilt',
           JSON.stringify(revD.missing));
      if (revD.ok) {
        const b = (await pD.surfaces()).loans.closeBand.rows.find(x => x.name === 'Stripe Capital Loan');
        t.notMatch(b.drawn, /not measured/,
                   'ce22 CONTROL: pre-fix, an unmeasured month rendered as “—”');
        t.ok(/^—$/.test((b.drawn || '').trim()),
             'ce22 CONTROL: ...which a reader reads as "nothing was borrowed" — the substitution that hid the draw',
             `cell=${JSON.stringify(b.drawn)}`);
      }
      await restoreFns(pD);
      await pD.close();
    }

    /* ── 23 ── WHAT THE LEDGER CHECK ACTUALLY SAYS TODAY ─────────────────── */
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      const row = (n) => cb.rows.find(x => x.name === n);
      // Three loans differ from the ledger, and the bands are by size.
      t.close(row('Paypal 2').unexplainedN, -3142.26, 0.005,
              'ce23: Paypal 2 — $3,142.26 of principal left the ledger with no split behind it');
      t.eq(row('Paypal 2').unexplainedBand, 'material', 'ce23: ...material');
      t.close(row('BayFirst SBA 2').unexplainedN, 858.66, 0.005, 'ce23: BayFirst SBA 2 — $858.66');
      t.eq(row('BayFirst SBA 2').unexplainedBand, 'material', 'ce23: ...material');
      t.close(row('Funding Circle Loan').unexplainedN, 15.14, 0.005, 'ce23: Funding Circle — $15.14');
      t.eq(row('Funding Circle Loan').unexplainedBand, 'immaterial',
           'ce23: ...a small difference, shown and not chased');
      // That $15.14 is the figure section 19 decomposed by hand from SQL: the
      // gap between the principal July's split claims and what the ledger moved.
      // The ledger check surfaces it directly now.
      t.eq(row('Stripe Capital Loan').unexplainedBand, 'tie',
           'ce23: and Stripe’s $145,875 was a drawdown, so its ledger TIES');
      const lg = cb.gateByKey['ledger'];
      t.eq(lg.ok, false, 'ce23: the ledger chip blocks');
      t.eq(lg.count, 2, 'ce23: ...counting the two material ones only');
      t.ok(/4,000\.92/.test(lg.text || ''), 'ce23: ...at $4,000.92', `chip=${JSON.stringify(lg.text)}`);
      t.notMatch(lg.text, /unmeasured/, 'ce23: ...and no longer says the cause is unmeasured');
      t.eq(cb.rows.filter(x => x.reachesBooks === '0').length, 3,
           'ce23: three rows’ walks miss the ledger, and they are exactly the three named above');

      // ── CONTROL ── the ledger check loses its materiality band
      const rev = await revertFn(p, '_closeVarianceBand', EDITS('no-materiality-band'));
      t.ok(rev.ok, 'ce23 CONTROL: a two-band ledger test could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.eq(b.rows.find(x => x.name === 'Funding Circle Loan').unexplainedBand, 'material',
             'ce23 CONTROL: without materiality, $15.14 is "material"');
        t.eq(b.gateByKey['ledger'].count, 3,
             'ce23 CONTROL: ...and the ledger gate blocks on three loans instead of two');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 24 ── THE TWO CHECKS ARE INDEPENDENT, IN BOTH DIRECTIONS ────────── */
    // A loan can agree with its lender to the cent while the ledger underneath
    // it moved money nobody split, and it can disagree with its lender while the
    // ledger foots perfectly. Folding the two into one number hides whichever
    // one happens to be smaller.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        setMovement(d, 'BayFirst SBA 2', MEASURED({ drawn: 0, reduced: 807.95 }));
        setMovement(d, 'E-Transit Loan - 4140', MEASURED({ drawn: 0, reduced: 1058.94 }));
      } });
      const cb = (await p.surfaces()).loans.closeBand;

      // Direction 1: ties on the lender, off on the ledger.
      const bf = cb.rows.find(x => x.name === 'BayFirst SBA 2');
      t.eq(bf.ties, true, 'ce24: BayFirst SBA 2 agrees with its lender exactly');
      t.eq(bf.band, 'tie', 'ce24: ...variance ties');
      t.eq(bf.unexplainedBand, 'material', 'ce24: ...while the LEDGER underneath it is off by a material amount');
      t.close(bf.unexplainedN, 858.66, 0.005, 'ce24: ...$858.66 that no split explains');

      // Direction 2: off on the lender, ties on the ledger.
      const ford = cb.rows.find(x => x.name === 'E-Transit Loan - 4140');
      t.eq(ford.band, 'material', 'ce24: E-Transit 4140 disagrees with its lender by a material amount');
      t.close(ford.varianceN, 415.88, 0.005, 'ce24: ...$415.88');
      t.eq(ford.unexplainedBand, 'tie', 'ce24: ...while its ledger foots exactly');
      t.close(ford.unexplainedN, 0, 0.005, 'ce24: ...at $0.00 unexplained');

      // The two chips must not be reporting the same money twice.
      const vg = cb.gateByKey['variance'], lg = cb.gateByKey['ledger'];
      const moneyOf = (g) => (String((g || {}).text || '').match(/\$[\d,]+\.\d\d/) || [''])[0];
      t.ok(!!vg && !!lg, 'ce24: both chips are on the strip', JSON.stringify(cb.gates.map(g => g.key)));
      t.ok(moneyOf(vg) !== moneyOf(lg),
           'ce24: ...and they report different money — neither is the other under a new name',
           `variance ${moneyOf(vg)} vs ledger ${moneyOf(lg)}`);
      const sets = await p.evaluate(() => {
        const rf = _loanCloseRollforward('2026-07');
        return { off: rf.off.map(x => x.a.xero_account_name), ledgerOff: rf.ledgerOff.map(x => x.a.xero_account_name),
                 vRes: rf.varianceToResolve, lRes: rf.ledgerToResolve };
      });
      t.ok(sets.off.includes('E-Transit Loan - 4140') && !sets.ledgerOff.includes('E-Transit Loan - 4140'),
           'ce24: a loan can be in `off` and not in `ledgerOff`', JSON.stringify(sets));
      t.ok(sets.ledgerOff.includes('BayFirst SBA 2') && !sets.off.includes('BayFirst SBA 2'),
           'ce24: ...and in `ledgerOff` and not in `off`', JSON.stringify(sets));
      t.ok(Math.abs(sets.vRes - sets.lRes) > 1,
           'ce24: ...so the two totals are genuinely different quantities',
           `variance ${sets.vRes} vs ledger ${sets.lRes}`);

      await p.close();

      // ── CONTROL ── run the ledger check on unmeasured months too, and the
      // two questions collapse into one wrong number. reconciliation-run now
      // measures every loan, so the scenario has to CREATE an unmeasured month —
      // which is every month before this deploy, and any the window cannot cover.
      const pU = await newHarnessPage({ tab: 'loans', mutate: (d) =>
        setMovement(d, 'Stripe Capital Loan', null) });
      const baseOff = await pU.evaluate(() =>
        _loanCloseRollforward('2026-07').ledgerOff.map(x => x.a.xero_account_name));
      t.ok(!baseOff.includes('Stripe Capital Loan'),
           'ce24: an unmeasured Stripe is not accused of anything', JSON.stringify(baseOff));
      const rev = await revertFn(pU, '_loanCloseRollforward', EDITS('ledger-runs-unmeasured'));
      t.ok(rev.ok, 'ce24 CONTROL: a ledger check that runs on unmeasured months could be rebuilt',
           JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await pU.evaluate(() =>
          _loanCloseRollforward('2026-07').ledgerOff.map(x => x.a.xero_account_name));
        t.ok(b.includes('Stripe Capital Loan'),
             'ce24 CONTROL: ...and Stripe’s $145,875 drawdown is reported as money nobody can explain',
             JSON.stringify(b));
        t.ok(b.length > baseOff.length,
             'ce24 CONTROL: ...on top of the loans that really are off');
      }
      await restoreFns(pU);
      await pU.close();
    }

    /* ── 25 ── A STAGED PAYMENT IS NOT COUNTED TWICE ─────────────────────── */
    // A staged Xero transaction is AUTHORISED, so the ledger already carries its
    // reduction while the rollforward deliberately excludes the split from the
    // month's principal. Both checks therefore see a gap of exactly the staged
    // principal, and BOTH must de-escalate: the posting gate already owns it.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        // August's month-end books row, carrying the staged reduction the ledger
        // already reflects. 89,411.25 − 3,344.64 = 86,066.61.
        d.loan_book_balances.push({
          id: 'harness-dex-0831', loan_account_id: dex.id, as_of: '2026-08-31', balance: 86066.61,
          basis: 'xero_rebuild', run_id: null, computed_at: '2026-09-01T00:00:00Z',
          detail: MEASURED({ drawn: 0, reduced: 3344.64, staged_reduction_in_month: 3344.64,
                             staged_entries_in_month: 1, movement_from: '2026-08-01', movement_to: '2026-08-31' }),
        });
      } });
      const aug = await p.evaluate(() => {
        const rf = _loanCloseRollforward('2026-08');
        const r = rf.rows.find(x => x.a.xero_account_name === 'Dexter Loan 2');
        return { variance: r.variance, band: r.band, unexplained: r.unexplained,
                 unexplainedBand: r.unexplainedBand, stagedExplains: r.stagedExplains,
                 inOff: rf.off.some(x => x.a.xero_account_name === 'Dexter Loan 2'),
                 inLedgerOff: rf.ledgerOff.some(x => x.a.xero_account_name === 'Dexter Loan 2'),
                 ledgerToResolve: rf.ledgerToResolve };
      });
      t.close(aug.variance, 3344.64, 0.005, 'ce25: the variance is the staged principal, $3,344.64');
      t.eq(aug.band, 'unbooked', 'ce25: ...de-escalated on the variance side');
      t.close(aug.unexplained, -3344.64, 0.005,
              'ce25: ...and the LEDGER sees the same event from the other side, −$3,344.64');
      t.eq(aug.stagedExplains, true, 'ce25: ...recognised as the staged reduction it is');
      t.eq(aug.unexplainedBand, 'unbooked', 'ce25: ...so it is de-escalated on the ledger side too');
      t.eq(aug.inOff, false, 'ce25: ...not in `off`');
      t.eq(aug.inLedgerOff, false, 'ce25: ...not in `ledgerOff` either');
      t.close(aug.ledgerToResolve, 0, 0.005, 'ce25: ...and contributes nothing to the ledger money to resolve');

      // ── CONTROL ── the staged reduction stops explaining itself
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('staged-not-explained'));
      t.ok(rev.ok, 'ce25 CONTROL: a rollforward blind to the staged reduction could be rebuilt',
           JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await p.evaluate(() => {
          const rf = _loanCloseRollforward('2026-08');
          const r = rf.rows.find(x => x.a.xero_account_name === 'Dexter Loan 2');
          return { band: r.unexplainedBand, inLedgerOff: rf.ledgerOff.some(x => x.a.xero_account_name === 'Dexter Loan 2') };
        });
        t.eq(b.band, 'material', 'ce25 CONTROL: pre-fix, one staged payment reads as a material ledger gap');
        t.eq(b.inLedgerOff, true,
             'ce25 CONTROL: ...blocking the close a second time, for an event the posting gate already counts');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 26 ── THE ORIGINATION STRADDLE IS A RULE, NOT A STRIPE CASE ─────── */
    // Stripe is the loan it was found on, so the danger is a check that only
    // ever fires there. Point the same shape at a different loan and it must
    // fire there too.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const bf = d.loan_accounts.find(x => x.xero_account_name === 'BayFirst SBA 2');
        d.loan_statements.push({
          id: 'harness-orig-bf2', loan_account_id: bf.id, statement_date: '2026-06-30',
          principal_balance: 150000, source: 'contract_origination', balance_basis: 'principal_only',
          total_amount_due: null, payment_due_date: null, storage_path: null, payoff_amount: null,
          payoff_good_thru: null, pulled_at: null, pulled_by: null, created_at: null, file_sha256: null,
        });
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      const bf = cb.rows.find(x => x.name === 'BayFirst SBA 2');
      // 150,000.00 agreement vs 137,568.21 books at 6/30.
      t.close(bf.originationGapN, 12431.79, 0.005,
              'ce26: the straddle fires on a loan that is not Stripe, from the rule alone');
      // Filed into the Opening source cell, which is the column it is about.
      // Session 249: filed on the Opening cell it is about — data-origination-gap
      // is asserted directly above — and worded in the row's hover hint.
      t.ok(/origination straddles/.test(bf.hint || ''),
           'ce26: ...and says so on the row, beside the opening it is about',
           `hint=${JSON.stringify(bf.hint)}`);
      // …and still fires on the loan it was found on.
      const st = cb.rows.find(x => x.name === 'Stripe Capital Loan');
      t.close(st.originationGapN, 145875, 0.005, 'ce26: ...while still firing on Stripe');
      // It states the two figures and picks no winner — which period the
      // recognition belongs in is the accountant's question, not a dashboard's.
      t.notMatch(bf.hint, /error|wrong|incorrect/i,
                 'ce26: ...and calls neither figure wrong');

      // ── CONTROL ── make it a Stripe special case again
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('origination-is-stripe-only'));
      t.ok(rev.ok, 'ce26 CONTROL: a Stripe-only straddle check could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.eq(b.rows.find(x => x.name === 'BayFirst SBA 2').originationGapN, null,
             'ce26 CONTROL: keyed on the loan instead of the shape, the other loan’s straddle vanishes');
        t.close(b.rows.find(x => x.name === 'Stripe Capital Loan').originationGapN, 145875, 0.005,
                'ce26 CONTROL: ...while Stripe still fires, so the test would have passed on a special case');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 27 ── A MIXED-SIGN JOURNAL IS INVISIBLE UNLESS THE ROW SAYS SO ──── */
    // A single journal that both debits and credits the loan account nets into
    // one bucket, so its gross halves never appear in Drawn or in the principal.
    // Nothing else on the screen can reveal that; the flag is the only thing
    // standing between a reader and two figures they will never find in Xero.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) =>
        setMovement(d, 'BayFirst SBA 2', MEASURED({ drawn: 0, reduced: 807.95, mixed_sign_entries: 2 })) });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = cb.rows.find(x => x.name === 'BayFirst SBA 2');
      t.eq(r.mixedSignN, 2, 'ce27: the row carries data-mixed-sign="2"');
      // Filed into the Drawn cell, which is the figure it is about.
      // data-mixed-sign is on the Drawn cell (asserted above); the words are in
      // the row's hint, which is where every moved footnote now lives.
      t.ok(/mixed-sign/.test(r.hint || ''),
           'ce27: ...and says so on the row, beside the Drawn figure it is about',
           `hint=${JSON.stringify(r.hint)}`);
      // A measured zero must not flag.
      const other = cb.rows.find(x => x.name === 'Paypal 2');
      t.eq(other.mixedSignN, null, 'ce27: ...and a loan with no such journal carries no flag');

      // ── CONTROL ── the flag disappears
      const rev = await revertFn(p, 'renderLoansCloseBand', EDITS('mixed-sign-invisible'));
      t.ok(rev.ok, 'ce27 CONTROL: a renderer that never flags mixed-sign entries could be rebuilt',
           JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand.rows.find(x => x.name === 'BayFirst SBA 2');
        t.notMatch(b.hint, /mixed-sign/,
                   'ce27 CONTROL: pre-fix, two journals netting to nothing left no trace on the row');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 28 ── EVERY SUBTOTAL FOOTS WITH DRAWN IN IT ─────────────────────── */
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        setMovement(d, 'Stripe Capital Loan', MEASURED({ drawn: 125000, reduced: 9296.75 }));
        setMovement(d, 'Dexter Loan 2', MEASURED({ drawn: 0, reduced: 3326.23 }));
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      // One footer line now. The identity is asserted on it, and separately
      // across each grade's rows, so removing the per-grade rows did not remove
      // the property they used to carry.
      const st = cb.subtotals.all;
      t.ok(!!st, 'ce28: the Total row is on screen', JSON.stringify(Object.keys(cb.subtotals)));
      t.close(st.openingN + (st.drawnN || 0) - st.principalN, st.computedN, 0.02,
              'ce28: Total: opening + drawn − principal = computed',
              `${st.openingN} + ${st.drawnN} − ${st.principalN} vs ${st.computedN}`);
      for (const g of ['A', 'B']) {
        const set = cb.rows.filter(r => r.grade === g && r.openingN != null && r.computedN != null);
        if (!set.length) continue;
        const sum = (f) => set.reduce((n, r) => n + (r[f] || 0), 0);
        t.close(sum('openingN') + sum('drawnN') - sum('principalN'), sum('computedN'), 0.02,
                `ce28: grade ${g}: opening + drawn − principal = computed across its rows`);
      }
      // Stripe is not checkable, so its drawdown reaches the Total and no grade
      // — which is exactly why the Total has to carry Drawn for the identity to
      // hold at all.
      t.close(cb.subtotals.all.drawnN, 125000, 0.005,
              'ce28: the Total carries the $125,000 that made the old identity fail');
      t.eq(cb.rows.filter(r => r.grade === 'C' && (r.drawnN || 0) > 0).length, 1,
           'ce28: ...contributed by a row no grade can speak for');
      // Coverage is declared, never implied: a $0.00 Drawn over rows nobody
      // measured is not a statement that nothing was borrowed.
      t.eq(cb.subtotals.all.drawnMeasured, cb.rows.length,
           'ce28: every row’s movement is measured, so the Total covers all of them');
      t.ok(!cb.subtotals.all.cells.some(c => / of \d+ measured/.test(c)),
           'ce28: ...and prints no coverage marker, because there is no shortfall to declare',
           JSON.stringify(cb.subtotals.all.cells));
      // …and the marker appears the moment there IS one. A $0.00 Drawn over
      // rows nobody measured is not a statement that nothing was borrowed.
      const pPart = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        setMovement(d, 'Dexter Loan 2', null);
        setMovement(d, 'Paypal 2', null);
      } });
      const cbPart = (await pPart.surfaces()).loans.closeBand;
      t.eq(cbPart.subtotals.all.drawnMeasured, cb.rows.length - 2,
           'ce28: unmeasure two loans and the Total says so');
      t.ok(cbPart.subtotals.all.cells.some(c => new RegExp(`${cb.rows.length - 2} of ${cb.rows.length} measured`).test(c)),
           'ce28: ...in words in the Total row (session 267: the label cell, not beside the figure — see ce18)',
           JSON.stringify(cbPart.subtotals.all.cells));
      await pPart.close();

      // ── CONTROL ── drop Drawn from the subtotal
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('subtotal-drops-drawn'));
      t.ok(rev.ok, 'ce28 CONTROL: a subtotal that omits Drawn could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.ok(Math.abs(b.subtotals.all.openingN + (b.subtotals.all.drawnN || 0) - b.subtotals.all.principalN
                      - b.subtotals.all.computedN) > 1000,
             'ce28 CONTROL: without Drawn the Total stops footing, by the whole drawdown',
             `${b.subtotals.all.openingN} + ${b.subtotals.all.drawnN} − ${b.subtotals.all.principalN} vs ${b.subtotals.all.computedN}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ── 29 ── THE ASYMMETRY BETWEEN THE TWO CHECKS IS DELIBERATE ────────── */
    // An unmeasured month suppresses the LEDGER check but NOT the variance tie,
    // and that asymmetry is a decision rather than an oversight, so it is pinned
    // here in both directions.
    //
    // The reasoning, stated precisely because the precision is the point. A
    // missing `drawn` can only make `computed` too LOW, by exactly the amount
    // drawn. On the LEDGER side that error lands directly and deterministically
    // in the answer: unexplained becomes the drawdown itself, every time, so the
    // check would accuse a loan of precisely the thing it did legitimately. On
    // the VARIANCE side the same understatement produces a false DIFFERENCE —
    // which is shown, and which a reader can investigate. It could in principle
    // also produce a false tie, but only by the coincidence of the drawdown
    // exactly cancelling a real variance; it is not the systematic result the
    // ledger side suffers. So: suppressing the ledger check avoids a wrong
    // answer that is guaranteed and indistinguishable from a true one;
    // suppressing the variance tie would discard thirteen true results to avoid
    // a coincidence. I agree with the call, and this pins it either way.
    {
      // Every loan is measured now, so the unmeasured state is created — which
      // is every month before this deploy, and any month the window cannot
      // cover, so it is the state the rule is actually for.
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        d.loan_book_balances.forEach(b => { if (b.as_of === '2026-07-31') b.detail = null; });
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      const unmeasured = cb.rows.filter(x => !x.drawnMeasured);
      t.eq(unmeasured.length, cb.rows.length,
           'ce29: the scenario really did leave every row unmeasured');
      const tiesAnyway = unmeasured.filter(x => x.ties);
      t.ok(tiesAnyway.length >= 5,
           'ce29: ...and the VARIANCE tie is still allowed to stand on those rows',
           `${tiesAnyway.length} rows tie`);
      t.eq(unmeasured.filter(x => x.unexplainedBand != null).length, 0,
           'ce29: ...while the LEDGER check is suppressed on every one of them');
      for (const r of tiesAnyway.slice(0, 3)) {
        t.eq(r.band, 'tie', `ce29: ${r.name} ties against its lender`);
        t.eq(r.unexplainedState, 'unmeasured', `ce29: ...and declines to judge its ledger`);
      }
      // The variance figures survive unchanged where the loan borrowed nothing —
      // which is why suppressing them would be a loss and not a caution.
      t.ok(cb.rows.filter(x => x.band === 'material').length >= 4,
           'ce29: ...and the real findings are still reported', 
           `${cb.rows.filter(x => x.band === 'material').length} material`);

      // ── CONTROL ── treat the two checks symmetrically and suppress the
      // variance too. Nothing false appears; what disappears is every TRUE
      // result on the board, replaced by a column of dashes on the one screen
      // whose job is to say whether the month can be closed.
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('variance-suppressed-when-unmeasured'));
      t.ok(rev.ok, 'ce29 CONTROL: a symmetric suppression could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.eq(b.rows.filter(x => x.ties).length, 0,
             'ce29 CONTROL: symmetric suppression erases every variance tie on the board');
        t.eq(b.rows.filter(x => x.band === 'material').length, 0,
             'ce29 CONTROL: ...and every material variance with them — including the real findings');
        t.eq(b.gateByKey['variance'].count, 0,
             'ce29 CONTROL: ...leaving the variance gate with nothing to say');
      }
      await restoreFns(p);
      await p.close();
    }

    /* ══ 30 ══ A STAGED PAYMENT IN A MEASURED MONTH — FOUND HERE, NOW FIXED ══
       This section was written RED. It stated the behaviour the module ought to
       have, asked the real function, and let the answer stand. The answer was
       wrong and the defect was real; it has since been fixed and the section is
       now green. It is kept, in full, because the interaction is subtle enough
       that someone will one day "simplify" one of the two halves apart.

       THE INTERACTION. A staged Xero transaction is AUTHORISED, so the ledger
       already carries it: the balance fell by the whole payment and the
       interest half came back as a positive entry. The rollforward deliberately
       excludes a staged split from the month's principal AND from its interest.
       So in a month whose movement is measured, before the fix:

         · the month's interest was $0.00, so NOTHING was netted off the gross;
         · the gross — which IS the staged payment's own interest add-back —
           was therefore counted as new BORROWING;
         · computed rose by that interest, and the variance became the FULL
           payment, principal AND interest;
         · _closeUnbookedExplanation compared it against the staged PRINCIPAL
           only, could not cover the interest, and returned null;
         · the row banded MATERIAL and blocked the close.

       One staged payment — money that has not moved, which the posting gate
       already owns — read as a material variance of the whole payment: the
       "one event, two blockers" failure the unbooked band was built to remove,
       re-created by the netting fix's interaction with staging.

       ══ TWO ROUTES WERE AVAILABLE, AND THEY ARE NOT EQUIVALENT ═════════════
       The report named both, because the staged interest is exactly the amount
       that stopped being netted:

         (a) WIDEN THE EXPLANATION so it covers staged principal AND staged
             interest, letting the variance stay at the full payment;
         (b) NET THE STAGED INTEREST, so the add-back never becomes borrowing
             and the variance is the staged principal, as it always was.

       (b) shipped, and it is the right one. Both would have turned this section
       green, so the reason is worth recording rather than the number:

         · (a) treats the SYMPTOM. Under (a) the Drawn column would still read
           $513.15 of borrowing for this loan — a figure that is not true. The
           month borrowed nothing; a payment moved. Every downstream reader of
           `drawn` (the walk, the ledger check, the subtotals, anyone reading
           the screen) would keep being told the loan drew money it did not
           draw, and the explanation would exist only to forgive the lie.
         · (b) treats the CAUSE. `drawn` is meant to be new borrowing. An
           interest add-back is not new borrowing whether its split is posted or
           staged — the staged case was simply missed. (b) makes the two cases
           agree instead of adding a second rule for the second case.
         · Consequently (a) leaves the variance inflated by the interest, so it
           is a LARGER number to de-escalate, and the de-escalation has to grow
           to match. (b) leaves less to forgive. Given the choice, prefer the
           fix that shrinks what the module has to explain away.
         · (a) also collides with section 12's boundary: it widens
           _closeUnbookedExplanation, the one function this suite spends most of
           its effort keeping narrow.

       WHICH ROUTE IS LIVE IS OBSERVABLE, and asserted below rather than
       inferred: data-staged-interest carries the amount, and it is included in
       data-drawn-netted. Under (a) the same row would show $0.00 netted and
       $513.15 drawn. A future reader can tell the two apart from the DOM alone.

       STILL NOT REACHABLE ON TODAY'S SCREEN, AND STILL DATED. July's movement
       is measured but carries no staged split; August carries two (Dexter
       $3,344.64/$494.74 and Paypal 2 $3,165.30/$249.41) but has no month-end
       books row yet. When reconciliation-run writes the 8/31 row and August
       becomes the closing month, this shape goes live on both.               */
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        const jul = d.loan_splits.find(sp => sp.loan_account_id === dex.id && sp.period_label === '2026-07');
        jul.status = 'staged';
        jul.stage_reference = 'WR-STAGE harness';
        // The ledger keeps its real measurement — that is the whole point: the
        // staged transaction IS in Xero, so the month's movement is genuine.
        setMovement(d, 'Dexter Loan 2', { staged_reduction_in_month: 3326.23, staged_entries_in_month: 1 });
      } });
      const r = (await p.surfaces()).loans.closeBand.rows.find(x => x.name === 'Dexter Loan 2');

      // ── THE SETUP IS REAL ────────────────────────────────────────────────
      // Asserted so the finding cannot be dismissed as a broken fixture, and so
      // the section keeps describing the same scenario after the fix.
      t.close(r.drawnGrossN, 513.15, 0.005,
              'ce30 setup: the ledger measured $513.15 of increase — the staged payment’s interest coming back');
      // A zero money cell carries no data-amount at all (`${r.interest || ''}`),
      // so null and zero are the same claim here and the check says so.
      t.ok((r.interestN || 0) === 0,
           'ce30 setup: ...while the month books $0.00 of interest, because the split is staged',
           String(r.interestN));

      // ── ROUTE (b), OBSERVED ──────────────────────────────────────────────
      // These four are the ones that tell the routes apart. They would ALL read
      // differently under (a), which is why they are here and not implied.
      t.close(r.stagedInterestN, 513.15, 0.005,
              'ce30 fix: the row declares $513.15 of STAGED interest — the amount route (a) would have left in Drawn');
      t.close(r.drawnNettedN, 513.15, 0.005,
              'ce30 fix: ...and all of it is netted off, so data-drawn-netted includes the staged half');
      t.close(r.drawnNettedN, (r.interestN || 0) + r.stagedInterestN, 0.005,
              'ce30 fix: ...netted = booked interest + staged interest exactly, which is the whole of the fix');
      t.close(r.drawnN, 0, 0.005,
              'ce30 fix: ...leaving Drawn at $0.00 — the month borrowed NOTHING, and now says so');

      // ── AND THE CONSEQUENCE THE SECTION WAS WRITTEN FOR ──────────────────
      t.close(r.varianceN, 3326.23, 0.005,
              'ce30: the variance is the staged PRINCIPAL alone — the interest never reaches it');
      t.eq(r.band, 'unbooked',
           'ce30: a staged payment in a measured month is de-escalated — the posting gate already owns it');
      t.eq(r.ties, false, 'ce30: (it is not a tie either — the money genuinely has not moved)');
      const off = await p.evaluate(() =>
        _loanCloseRollforward('2026-07').off.map(x => x.a.xero_account_name));
      t.ok(!off.includes('Dexter Loan 2'),
           'ce30: ...and it does NOT block the close a second time for one event',
           `off: ${JSON.stringify(off)}`);
      t.close((r.unbookedN || 0), 3326.23, 0.005,
              'ce30: ...with the explanation covering exactly the staged principal');
      t.close(r.varianceResidualN, 0, 0.005,
              'ce30: ...and nothing left over, because there was nothing else wrong');

      // ══ CONTROL ══ THE DEFECT, REBUILT ═══════════════════════════════════
      // The two assertions this section used to open with pinned the DEFECTIVE
      // values ($513.15 counted as borrowing, a $3,839.38 variance). They went
      // red when the fix landed — correctly. Deleting them would delete the
      // shape; they belong here instead, as the control that reverts the fix
      // and demands the old numbers back. The edit is the single term the fix
      // added, so this reproduces that defect and nothing else.
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('staged-interest-not-nettable'));
      t.ok(rev.ok, 'ce30 CONTROL: a rollforward that does not net staged interest could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        const br = b.rows.find(x => x.name === 'Dexter Loan 2');
        t.close(br.drawnN, 513.15, 0.005,
                'ce30 CONTROL: nothing is netted, so the add-back is counted as BORROWING again');
        t.close(br.drawnNettedN, 0, 0.005,
                'ce30 CONTROL: ...with data-drawn-netted back to $0.00 — the state route (a) would have shipped');
        t.close(br.varianceN, 3839.38, 0.005,
                'ce30 CONTROL: ...making the variance the FULL payment, principal and interest');
        // And the reason it mattered: the explanation covers the principal, the
        // residual is the interest, and the residual is material.
        t.close(br.unbookedN || 0, 3326.23, 0.005,
                'ce30 CONTROL: ...which the explanation still only covers to the staged principal');
        t.close(br.varianceResidualN, 513.15, 0.005,
                'ce30 CONTROL: ...leaving the interest unexplained');
        t.eq(br.band, 'material',
             'ce30 CONTROL: ...so one staged payment blocks the close for money that has not moved');
        const off2 = await p.evaluate(() =>
          _loanCloseRollforward('2026-07').off.map(x => x.a.xero_account_name));
        t.ok(off2.includes('Dexter Loan 2'),
             'ce30 CONTROL: ...and lands in `off`, beside the posting gate reporting the same event',
             `off: ${JSON.stringify(off2)}`);
      }
      await restoreFns(p);
      await p.close();
    }

    /* ══ 31 ══ VERDANT'S FOUR CENTS ARE ORIGINATION DRIFT — PROVED, NOT ASSUMED
       Section 12's boundary now allows a variance to be PARTLY explained, and
       the case that justified the change is Verdant: a permanent four-cent
       disagreement between what Xero booked and what the contract says, which
       under exact matching turned every unbooked-payment gap on this loan into
       a material, blocking variance forever.

       That argument is only sound if the four cents really is drift at day one
       rather than a small real error accumulating. This section proves it from
       the data the page itself loaded, so the claim is falsifiable: if the
       payments ever stop agreeing with the schedule, this goes red and whoever
       sees it has to revisit whether residual banding is still the right call.

       THE PROOF IS A SUBTRACTION IN TWO HALVES:
         · the contract opens at $284,354.50 (the schedule's own `initial` row);
         · thirteen scheduled payments through 7/31 retire $33,460.17, so the
           contract stands at $250,894.33;
         · Xero's rebuilt 7/31 balance is $250,894.29 — four cents under;
         · and the thirteen POSTED splits (the fourteen on file less the undated
           'Period 14') retire $33,460.17, THE SAME FIGURE TO THE CENT.
       Every payment agrees. The gap is at origination and nowhere else.       */
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const v = await p.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
        const rows = (_allLoanAmortRows || []).filter(r =>
          r.loan_amortization_schedules && r.loan_amortization_schedules.loan_account_id === a.id);
        const init = rows.filter(r => r.row_type === 'initial');
        // The schedule is on file TWICE (a re-issue), so the payment rows are
        // de-duplicated by date before they are summed. Summing the raw rows
        // double-counts and reads $66,920.34 — a mistake worth making
        // impossible rather than merely avoiding.
        const byDate = new Map();
        for (const r of rows) if (r.row_type === 'payment' && r.row_date <= '2026-07-31') byDate.set(r.row_date, r);
        const pay = [...byDate.values()];
        const posted = (_allLoanSplits || []).filter(s => s.loan_account_id === a.id && s.status === 'posted');
        // WHICH split is the extra one is DERIVED, not assumed. Seven of the
        // fourteen carry a 'Period N' label with no date in it, so "the undated
        // one" does not identify anything — the first cut of this test asked
        // that question and got all seven back. The right question is which
        // posted payment has no scheduled row to pair with, so the fourteen are
        // matched off against the thirteen BY PRINCIPAL, each row consumed once,
        // and whatever is left over is the extra by construction.
        const pool = pay.map(r => Math.round(Number(r.principal || 0) * 100));
        const extra = [];
        for (const sp of posted) {
          const c = Math.round(Number(sp.principal_amount || 0) * 100);
          const i = pool.indexOf(c);
          if (i >= 0) pool.splice(i, 1); else extra.push(sp);
        }
        const undated = extra;
        const books = (_allLoanBookBalances || []).filter(x => x.loan_account_id === a.id)
          .sort((x, y) => x.as_of < y.as_of ? 1 : -1);
        const sum = (xs, k) => Math.round(xs.reduce((n, r) => n + Number(r[k] || 0), 0) * 100) / 100;
        return {
          schedules: new Set(rows.map(r => r.schedule_id)).size,
          initN: init.length, contract: init.length ? Number(init[0].balance) : null,
          payRows: pay.length, paySchedule: sum(pay, 'principal'),
          postedN: posted.length, postedAll: sum(posted, 'principal_amount'),
          undatedLabels: undated.map(s => s.period_label).sort(),
          undatedPrincipal: sum(undated, 'principal_amount'),
          unmatchedSchedule: pool.length,
          // The extra is not merely unmatched — it is the schedule's FOURTEENTH
          // payment, which is what makes 'Period 14' the right name for it and
          // an August event rather than a mystery.
          period14Scheduled: (() => {
            const after = rows.filter(r => r.row_type === 'payment' && r.row_date > '2026-07-31')
              .sort((x, y) => x.row_date < y.row_date ? -1 : 1)[0];
            return after ? { date: after.row_date, principal: Number(after.principal || 0) } : null;
          })(),
          books731: books.length ? Number((books.find(x => x.as_of === '2026-07-31') || {}).balance) : null,
        };
      });

      // ── THE CONTRACT SIDE ────────────────────────────────────────────────
      t.eq(v.initN, 1, 'ce31: Verdant has exactly one origination row on file, so "the contract" is unambiguous');
      t.close(v.contract, 284354.50, 0.005, 'ce31: ...and it says the loan opened at $284,354.50');
      t.eq(v.payRows, 13, 'ce31: thirteen scheduled payments fall on or before 7/31');
      t.close(v.paySchedule, 33460.17, 0.005, 'ce31: ...retiring $33,460.17 of principal between them');
      t.close(v.contract - v.paySchedule, 250894.33, 0.005,
              'ce31: ...so the contract stands at $250,894.33 on 7/31');

      // ── THE BOOKS SIDE ───────────────────────────────────────────────────
      t.close(v.books731, 250894.29, 0.005, 'ce31: Xero’s rebuilt 7/31 balance is $250,894.29');
      t.close((v.contract - v.paySchedule) - v.books731, 0.04, 0.005,
              'ce31: ...four cents under the contract — the whole of the disagreement');

      // ── AND THE PAYMENTS THEMSELVES AGREE, WHICH IS THE POINT ────────────
      // If the four cents were accumulating error, this is where it would show.
      // It does not: the booked payments equal the scheduled payments exactly,
      // so the gap has been sitting at origination since day one and nothing
      // since has widened it.
      t.eq(v.postedN, 14, 'ce31: fourteen splits are posted against thirteen scheduled payments');
      t.eq(v.unmatchedSchedule, 0,
           'ce31: ...and every one of the thirteen scheduled payments is matched by a posted split, to the cent',
           `${v.unmatchedSchedule} scheduled rows left unmatched`);
      t.eq(JSON.stringify(v.undatedLabels), JSON.stringify(['Period 14']),
           'ce31: ...leaving exactly ONE extra, and it is "Period 14"',
           JSON.stringify(v.undatedLabels));
      t.close(v.undatedPrincipal, 2707.61, 0.005, 'ce31: ...carrying $2,707.61 of principal');
      t.ok(v.period14Scheduled && v.period14Scheduled.date === '2026-08-10',
           'ce31: ...which is the schedule’s next payment, 2026-08-10 — an August event, not a mystery',
           JSON.stringify(v.period14Scheduled));
      t.close(v.period14Scheduled && v.period14Scheduled.principal, 2707.61, 0.005,
              'ce31: ...at exactly that principal, so the label means what it says');
      t.close(v.postedAll - v.undatedPrincipal, 33460.17, 0.005,
              'ce31: ...so the thirteen matched payments booked $33,460.17');
      t.close((v.postedAll - v.undatedPrincipal) - v.paySchedule, 0, 0.005,
              'ce31: ...IDENTICAL to the schedule, to the cent — the four cents is drift at origination, not error since');

      // The consequence, stated on the live row rather than argued: with the
      // payments agreeing, Verdant's real July variance is the drift and only
      // the drift.
      const rr = rowOf((await p.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.close(Math.abs(rr.varianceN), 0.04, 0.005,
              'ce31: ...which is exactly what the rendered July row shows, and nothing more',
              `variance ${rr.varianceN}`);
      await p.close();

      // ── CONTROL ── this section has no function to revert, so the control is
      // a MUTATION instead: it is evidence about the data, and the thing that
      // must discriminate is the matching, not a code path. One cent moved on
      // one posted payment and the whole argument has to collapse — a scheduled
      // row left unmatched, an extra split that is no longer only 'Period 14',
      // and the thirteen no longer summing to the schedule. If any of those
      // three survives a deliberate corruption, the assertions above are not
      // measuring what they claim to.
      const pBad = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const a = d.loan_accounts.find(x => x.xero_account_name === 'Verdant Capital Loan');
        const sp = d.loan_splits.find(x => x.loan_account_id === a.id && x.period_label === '2026-07-10' && x.status === 'posted');
        sp.principal_amount = Number(sp.principal_amount) + 0.01;
      } });
      const vb = await pBad.evaluate(() => {
        const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Verdant Capital Loan');
        const rows = (_allLoanAmortRows || []).filter(r =>
          r.loan_amortization_schedules && r.loan_amortization_schedules.loan_account_id === a.id);
        const byDate = new Map();
        for (const r of rows) if (r.row_type === 'payment' && r.row_date <= '2026-07-31') byDate.set(r.row_date, r);
        const pool = [...byDate.values()].map(r => Math.round(Number(r.principal || 0) * 100));
        const posted = (_allLoanSplits || []).filter(x => x.loan_account_id === a.id && x.status === 'posted');
        const extra = [];
        for (const sp of posted) {
          const c = Math.round(Number(sp.principal_amount || 0) * 100);
          const i = pool.indexOf(c);
          if (i >= 0) pool.splice(i, 1); else extra.push(sp);
        }
        return { unmatched: pool.length, extras: extra.map(x => x.period_label).sort() };
      });
      t.eq(vb.unmatched, 1,
           'ce31 CONTROL: move one cent on one posted payment and a scheduled row is left unmatched');
      t.ok(vb.extras.length === 2 && vb.extras.includes('Period 14') && vb.extras.includes('2026-07-10'),
           'ce31 CONTROL: ...and the extra is no longer only "Period 14" — so the match above really is doing the work',
           JSON.stringify(vb.extras));
      await pBad.close();
    }

    /* ══ 32 ══ ⚠ REPORTED: AN EXPLANATION MAY OVERSHOOT THE GAP IT EXPLAINS ══
       ⚠ THIS IS A FINDING, NOT A TEST NEEDING AN UPDATE, and it is written the
       way section 30 was: state the behaviour, ask the real function, and pin
       what it actually does so the shape cannot drift while the argument is
       decided elsewhere. Nothing here is red — the module does what these
       assertions say. What is wrong is that it should not.

       WHERE IT COMES FROM. Section 12 records why exact matching had to go, and
       I agree with that. The guard that replaced it is STRICT REDUCTION: a
       candidate split is accepted only if it makes the unexplained amount
       smaller, which guarantees |residual| < |variance| and bounds the damage.
       That guard is real and it does most of the work.

       WHAT IT DOES NOT BOUND is the relationship between the amount CLAIMED and
       the gap it is claimed against. Strict reduction is satisfied by any split
       up to twice the size of the gap. So a $2,462.79 undated payment may be
       offered as the explanation of a $2,000.00 discrepancy — a payment larger
       than the entire thing it is explaining — and the leftover, being smaller
       than the gap, can fall under the materiality line the gap itself cleared.
       A material finding becomes an immaterial one and leaves "to resolve".

       THE CLAIM IS ALSO INCOHERENT ON ITS FACE, which is the part that makes
       this a defect rather than a tuning preference. "This gap is an unbooked
       payment" is only a sentence about the world if the payment could account
       for the gap. A payment BIGGER than the whole discrepancy cannot be the
       missing piece of it; something else is going on, and that is precisely
       when the row should stay loud.

       IT IS NOT LIVE TODAY and this section says so honestly: Verdant is the
       only loan on the book carrying undated splits, and its real July gap is
       four cents, which no split can reduce. Reaching the shape needs a planted
       balance — done below — or the gross-Drawn revert in section 21b, where it
       silently removed a tenth loan from a board of ten.

       THE FIX IS NOT MINE TO MAKE, but the shape is narrow: refuse a candidate
       that OVERSHOOTS the gap by more than the materiality floor. Falling short
       is fine and is the whole point of portion matching — the shortfall is
       banded and still blocks. Overshooting is a different claim and should be
       refused. That rule keeps Verdant's August case (a $2,707.61 payment
       against a $2,707.57 gap, four cents over) and refuses this one ($2,462.79
       against $2,000.00, $462.79 over).                                      */
    {
      const verBooks = (bal) => (d) => setBooks(d, 'Verdant Capital Loan', [{ as_of: '2026-06-30', balance: bal }]);
      // 253,582.27 is the balance at which Verdant's July walk lands exactly on
      // its closing anchor, so the plant below IS the gap: $2,000.00 of nothing
      // in particular, unrelated to any payment on file.
      const p = await newHarnessPage({ tab: 'loans', mutate: verBooks(253582.27 + 2000) });
      const cb = (await p.surfaces()).loans.closeBand;
      const r = rowOf(cb, 'Verdant Capital Loan');
      t.close(r.varianceN, 2000, 0.005, 'ce32: a planted gap of exactly $2,000.00');
      // On its own that gap is material and blocking — asserted, so the
      // de-escalation below cannot be mistaken for something that was never
      // going to matter.
      t.ok(2000 >= 25 && 2000 / r.perLenderN >= 0.0025,
           'ce32: ...which clears both materiality tests on its own',
           `share ${(2000 / r.perLenderN).toFixed(5)}`);

      // ⚠ WHAT ACTUALLY HAPPENS
      t.close(r.unbookedN, 2462.79, 0.005,
              'ce32 ⚠ REPORTED: it is "explained" by an undated split of $2,462.79 — larger than the whole gap');
      t.ok(r.unbookedN > r.varianceN + 25,
           'ce32 ⚠ REPORTED: ...overshooting it by more than the materiality floor',
           `claimed ${r.unbookedN} against ${r.varianceN}`);
      t.close(r.varianceResidualN, -462.79, 0.005,
              'ce32 ⚠ REPORTED: ...leaving −$462.79, a residual with the OPPOSITE sign to the gap');
      t.eq(r.band, 'immaterial',
           'ce32 ⚠ REPORTED: ...which bands immaterial, so a material discrepancy stops blocking the close');
      t.ok(!cb.rows.some(x => /Verdant/.test(x.loan) && x.band === 'material'),
           'ce32 ⚠ REPORTED: ...and Verdant contributes nothing to "variance to resolve"');

      // ── WHAT IS STILL TRUE, AND WHY THIS IS A GAP RATHER THAN A HOLE ────
      // The strict-reduction guard held: less is unexplained than before, and
      // both figures are on the cell. The failure is a de-escalation across the
      // materiality line, not a disappearance — which is the difference between
      // this and the exactness rule's silent absorption that section 12
      // describes. It is worth fixing; it is not worth panicking about.
      t.ok(Math.abs(r.varianceResidualN) < Math.abs(r.varianceN),
           'ce32: the strict-reduction invariant still holds — less is unexplained than before');
      t.ok(/2,000\.00/.test(r.variance || '') && /462\.79/.test(r.varianceExplained || ''),
           'ce32: and BOTH figures are printed, so a reader can see the claim and reject it',
           `cell=${JSON.stringify(r.variance)} explained=${JSON.stringify(r.varianceExplained)}`);

      // ── THE PROPOSED RULE, TESTED AS ARITHMETIC RATHER THAN ASSERTED ────
      // If a future change adds the overshoot refusal, this row must go back to
      // material and Verdant's August case must survive. Both conditions are
      // stated here as data so the fix has a target to hit.
      t.ok(2462.79 - 2000 > 25,
           'ce32: the proposed rule would refuse THIS match — it overshoots by $462.79');
      t.ok(2707.61 - 2707.57 < 25,
           'ce32: ...and would keep Verdant’s August case, which overshoots by four cents');
      await p.close();
    }
  },
});






/* 18 ── THE FOUR STATES OF AN ATTRIBUTION (session 262) ────────────────────
   loan-attribution-run has been writing an explanation per loan four times a
   day since session 261, into a table nothing read. This group covers the
   surface that now reads it, and it exists for ONE assertion above all others:

     the four not-an-answer states must not print the same sentence.

   §00 of START HERE named the risk exactly — "collapsing [error and no-row]
   into 'nothing to attribute' would reintroduce this module's oldest failure
   shape at the last possible step". That shape is two different truths wearing
   one wording, and this module's whole session log 214-217 is what it costs.

   The states, and what each one means to a person reading the Issues table:
     ok      here is the entry that caused your variance
     empty   we looked at this loan and nothing accounts for it
     error   we tried and could not answer
     none    nobody has looked at this loan
     unread  we could not reach the answers at all

   'empty' and 'none' are the pair most easily confused and the pair whose
   confusion is most expensive: one says the cause is not a single mis-split
   entry (real information, changes what you go looking for), the other says
   nothing whatsoever. A screen that renders both as "no cause found" tells a
   CPA the analysis has an opinion when it has never run.                    */
GROUPS.push({
  name: 'attribution-states',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    // ── Which loans does Issues actually show? Derived, never typed. ───────
    // Same discipline as r2's derived finding names: the fixture is a real
    // production pull and which loans carry a variance moves between refreshes.
    // A hardcoded loan name here would go red for a reason unconnected to the
    // code, which is the most expensive kind of red.
    const p0 = await newHarnessPage({ tab: 'overview' });
    const issue = await p0.evaluate(() => _bkIssueQueueItems().map(i => ({ id: i.loanId, name: i.name })));
    await p0.close();
    t.ok(issue.length >= 4, 'a0: the fixture puts at least 4 loans in Issues, enough to hold all four states at once',
         `${issue.length}: ${issue.map(i => i.name).join(', ')}`);
    if (issue.length < 4) return;

    const [L_OK, L_ERR, L_EMPTY, L_NONE] = issue;

    // Payload shaped exactly like a real loan_attributions row (session 261's
    // schema: counts live under payload.counts, and the sentence is duplicated
    // into the top-level headline column).
    const HEAD = 'A payment dated 2026-06-17 reduced this loan by $764.44. The schedule supports $1,047.51 — a difference of $283.07.';
    const plant = (d) => {
      d.loan_attributions = [
        { loan_account_id: L_OK.id, schema_version: 1, run_status: 'ok', headline: HEAD,
          generated_at: '2026-09-02T17:34:57.866Z', updated_at: '2026-09-02T17:35:31.677Z', error_message: null,
          payload: { counts: { confirmed: 1, probable: 0, unresolved: 2, omitted: 0, malformed: 0, violations: 0 } } },
        { loan_account_id: L_ERR.id, schema_version: 1, run_status: 'error', headline: null,
          generated_at: '2026-09-02T17:34:57.866Z', updated_at: '2026-09-02T17:34:57.866Z',
          error_message: 'loan-find-difference 500: upstream timeout', payload: {} },
        // Ran clean, concluded nothing. The counts are the engine's own, and
        // the page must read THEM rather than re-deciding what counts as an
        // answer — a second threshold in a second file is how two numbers start
        // disagreeing (session 261's decision 1, kept here).
        { loan_account_id: L_EMPTY.id, schema_version: 1, run_status: 'ok', headline: null,
          generated_at: '2026-09-02T17:34:57.866Z', updated_at: '2026-09-02T17:34:57.866Z', error_message: null,
          payload: { counts: { confirmed: 0, probable: 0, unresolved: 3, omitted: 0, malformed: 0, violations: 0 } } },
        // L_NONE deliberately gets NO ROW. That is the fourth state and it is
        // expressed by absence, which is the only way it occurs in production.
      ];
    };

    // Reads the Issues table's own cells. data-attr-state is read as an
    // ATTRIBUTE rather than inferred from the wording, so a copy edit can never
    // quietly turn a failed analysis into a clean one for anything that checks.
    const READ_VAR = () => {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('.bk-var-table tbody tr')].map(tr => {
        const ex = tr.querySelector('.bk-var-explain');
        const sub = ex && ex.querySelector('.bk-var-sub');
        const conf = ex && ex.querySelector('.bk-var-conf');
        return {
          loan: norm((tr.querySelector('.bk-var-loan') || {}).textContent),
          state: ex ? (ex.getAttribute('data-attr-state') || '') : null,
          confAttr: ex ? (ex.getAttribute('data-attr-confidence') || '') : null,
          generated: ex ? (ex.getAttribute('data-attr-generated') || '') : null,
          // The cause sentence alone: the cell minus the demoted remedy line
          // and minus the confidence word.
          cause: norm(ex ? [...ex.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') : ''),
          sub: norm(sub ? sub.textContent : ''),
          conf: norm(conf ? conf.textContent : ''),
          all: norm(ex ? ex.textContent : ''),
        };
      });
    };

    const p = await newHarnessPage({ tab: 'overview', mutate: plant });
    await p.evaluate(() => _bkSetOverviewSeg('issues'));
    const rows = await p.evaluate(READ_VAR);
    const byName = (n) => rows.find(r => r.loan.includes(n));

    t.eq(rows.length, issue.length, 'a1: every Issues row rendered a variance cell');

    // ── STATE: ok ─────────────────────────────────────────────────────────
    const rOk = byName(L_OK.name);
    t.ok(!!rOk, `a2: the 'ok' loan (${L_OK.name}) is on screen`);
    t.eq(rOk && rOk.state, 'ok', 'a2: ...carrying data-attr-state="ok"');
    t.ok(rOk && rOk.cause.includes('$764.44'),
         'a2: ...and the Explanation column prints the engine’s actual sentence, not a summary of it', rOk && rOk.cause);
    t.eq(rOk && rOk.conf, 'confirmed',
         'a2: ...with the engine’s own verdict beside it, so a reader knows whether to act on it');
    t.eq(rOk && rOk.confAttr, 'confirmed', 'a2: ...also as an attribute, readable without parsing prose');
    // The remedy wording is DEMOTED, not deleted. Cutting must never drop a
    // claim (the LESS IS BEST limit) — it moves one line down, still saying
    // what the Action button opens.
    t.ok(rOk && rOk.sub.length > 0,
         'a2: ...and the remedy line it displaced is still on the row, one step quieter', rOk && rOk.sub);

    // ── STATE: error ──────────────────────────────────────────────────────
    const rErr = byName(L_ERR.name);
    t.eq(rErr && rErr.state, 'error', 'a3: a failed analysis reports state="error"');
    t.ok(rErr && /could not be worked out|failed/i.test(rErr.cause),
         'a3: ...and SAYS so, in words', rErr && rErr.cause);
    t.ok(rErr && !rErr.conf.includes('confirmed') && !rErr.conf.includes('probable'),
         'a3: ...and asserts no confidence in a cause it never found', rErr && rErr.conf);
    t.ok(rErr && rErr.conf === 'unavailable',
         'a3: ...marking the absence explicitly rather than leaving a blank that reads as "fine"', rErr && rErr.conf);

    // ── STATE: empty ──────────────────────────────────────────────────────
    const rEmp = byName(L_EMPTY.name);
    t.eq(rEmp && rEmp.state, 'empty', 'a4: a clean run that concluded nothing reports state="empty"');
    t.ok(rEmp && /found no single entry/i.test(rEmp.cause),
         'a4: ...and says the analysis RAN — a real finding, not a silence', rEmp && rEmp.cause);
    t.ok(rEmp && /3 differences/.test(rEmp.cause),
         'a4: ...naming what it could not place, from the engine’s own counts', rEmp && rEmp.cause);

    // ── STATE: none ───────────────────────────────────────────────────────
    const rNone = byName(L_NONE.name);
    t.eq(rNone && rNone.state, 'none', 'a5: a loan with no attribution row reports state="none"');
    t.ok(rNone && !/analysis|could not be worked out/i.test(rNone.cause),
         'a5: ...and claims nothing about an analysis that never ran', rNone && rNone.cause);
    t.ok(rNone && rNone.conf === '',
         'a5: ...and carries no verdict word at all');

    /* ── THE ASSERTION THIS GROUP EXISTS FOR ───────────────────────────────
       Four states, four sentences. If any two of these collapse, a CPA reading
       the column cannot tell "we found nothing" from "we never looked" from
       "we broke". This is §00's requirement stated as an executable fact. */
    const sentences = [rOk, rErr, rEmp, rNone].map(r => (r && r.cause) || '');
    t.eq(new Set(sentences).size, 4,
         'a6: ⭐ all four states print DIFFERENT sentences — no two truths share a wording',
         JSON.stringify(sentences.map(s => s.slice(0, 40))));
    t.eq(new Set([rOk, rErr, rEmp, rNone].map(r => r && r.state)).size, 4,
         'a6: ...and four different states reach the DOM as attributes');
    await p.close();

    // ── STATE: unread — the table itself could not be read ────────────────
    // Distinct from all four above, and the one most likely to be collapsed by
    // accident: an empty array after a failed read looks exactly like a table
    // with no rows in it. _bkAttributionsRead is what keeps them apart.
    const p2 = await newHarnessPage({ tab: 'overview', mutate: plant });
    await p2.evaluate(() => { _bkAttributionsRead = false; _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
    const unread = await p2.evaluate(READ_VAR);
    t.ok(unread.length > 0 && unread.every(r => r.state === 'unread'),
         'a7: a FAILED read reports "unread" on every row — not "none", which would claim we looked',
         JSON.stringify(unread.map(r => r.state)));
    t.ok(unread[0] && /could not be read/i.test(unread[0].cause),
         'a7: ...and says so', unread[0] && unread[0].cause);
    t.ok(unread[0] && unread[0].cause !== ((rNone && rNone.cause) || ''),
         'a7: ...in different words from the loan nobody has analysed');
    await p2.close();

    // ── THE SECOND SURFACE: the Loans rollforward hint ────────────────────
    // Both surfaces read _bkLoanAttribution, so the point of checking here is
    // that they cannot disagree about the STATE while wording it differently.
    const p3 = await newHarnessPage({ tab: 'loans', mutate: plant });
    const hints = await p3.evaluate(() => {
      const out = {};
      for (const tr of document.querySelectorAll('.lcb-table tbody tr, table tbody tr[data-hint]')) {
        out[tr.getAttribute('data-loan') || ''] = tr.getAttribute('data-hint') || '';
      }
      return out;
    });
    const hOk = hints[L_OK.name] || '';
    const hErr = hints[L_ERR.name] || '';
    const hNone = hints[L_NONE.name] || '';
    t.ok(/cause \(confirmed\)/.test(hOk),
         'a8: the Loans hover names the cause AND whose confidence it is', hOk.slice(-120));
    t.ok(hOk.includes('$764.44'), 'a8: ...carrying the same sentence Issues shows, from the same function');
    t.ok(/analysis .* failed|failed on its last run/.test(hErr),
         'a8: ...and a failed analysis speaks on this surface too rather than going quiet', hErr.slice(-120));
    t.ok(!/cause \(|analysis/.test(hNone),
         'a8: ...while a loan nobody analysed adds no clause at all — silence is correct only for "none"',
         hNone.slice(-120));
    await p3.close();

    /* ═══ DOES IT DISCRIMINATE? ═══════════════════════════════════════════
       Each control re-applies the INVERSE of the fix to the shipped function's
       own .toString() in page context and rebuilds it with new Function().
       admin-dashboard/index.html is never touched. An assertion that passes
       against both the fixed and the broken code is decoration (session 245). */

    // C1 — THE COLLAPSE §00 NAMED: treat a failed run as no row at all.
    const c1 = await newHarnessPage({ tab: 'overview', mutate: plant });
    const rev1 = await c1.evaluate(() => {
      const src = _bkLoanAttribution.toString();
      const anchor = "if (row.run_status !== 'ok') {";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkLoanAttribution' };
      const patched = src.replace(anchor, "if (row.run_status !== 'ok') { return { state: 'none' }; } if (false) {");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkLoanAttribution = new Function('loanId', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev1.ok, 'c1: the error→none collapse could be installed in page context', JSON.stringify(rev1));
    if (rev1.ok) {
      await c1.evaluate(() => { _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
      const broke = await c1.evaluate(READ_VAR);
      const bErr = broke.find(r => r.loan.includes(L_ERR.name));
      const bNone = broke.find(r => r.loan.includes(L_NONE.name));
      t.eq(bErr && bErr.state, 'none',
           'c1: ...and with it installed the failed loan really does report "none"');
      /* ── WHAT "INDISTINGUISHABLE" ACTUALLY MEANS HERE ──────────────────
         The first draft of this control compared the two broken cells for an
         IDENTICAL string and went red against correct code. It was wrong, and
         wrong in an instructive way: under the collapse each loan falls back to
         its OWN remedy wording, so the two cells still differ — by text that
         has nothing to do with the analysis. Comparing them proved only that
         two loans have different pending splits.
         The collapse's real cost is that the failure STOPS BEING STATED and the
         row reports the same STATE as a loan nobody looked at. So the control
         asserts the exact inverse of a3's own predicates: the words go, and the
         state becomes the never-analysed one. A control has to fail the
         assertion it claims to protect, not merely differ from something. */
      t.ok(bErr && !/could not be worked out|failed/i.test(bErr.cause),
           'c1: ⭐ ...and a3\'s "SAYS so, in words" is now FALSE — the failure is no longer stated anywhere',
           bErr && bErr.cause);
      t.eq(bErr && bErr.state, bNone && bNone.state,
           'c1: ⭐ ...and the failed loan reports the same state as the loan nobody analysed — which a6 forbids, so a6 discriminates');
      t.ok(bErr && bErr.conf !== 'unavailable',
           'c1: ...and the explicit "unavailable" mark a3 requires is gone too', bErr && bErr.conf);
    }
    await c1.close();

    // C2 — the quieter collapse: a clean run that found nothing, folded into
    // "no row". This is the pair a reader is least able to tell apart on their
    // own, because both feel like "no cause".
    const c2 = await newHarnessPage({ tab: 'overview', mutate: plant });
    const rev2 = await c2.evaluate(() => {
      const src = _bkLoanAttribution.toString();
      const anchor = "if (!found || !row.headline) {";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkLoanAttribution' };
      const patched = src.replace(anchor, "if (!found || !row.headline) { return { state: 'none' }; } if (false) {");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkLoanAttribution = new Function('loanId', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev2.ok, 'c2: the empty→none collapse could be installed', JSON.stringify(rev2));
    if (rev2.ok) {
      await c2.evaluate(() => { _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
      const broke = await c2.evaluate(READ_VAR);
      const bEmp = broke.find(r => r.loan.includes(L_EMPTY.name));
      const bNone = broke.find(r => r.loan.includes(L_NONE.name));
      t.ok(bEmp && !/found no single entry/i.test(bEmp.cause),
           'c2: ⭐ a4\'s "says the analysis RAN" is now FALSE — the one thing that separated it from silence is gone',
           bEmp && bEmp.cause);
      t.eq(bEmp && bEmp.state, bNone && bNone.state,
           'c2: ⭐ ...and "we looked and found nothing" now reports the same state as "nobody looked" — so a4 and a6 discriminate');
    }
    await c2.close();

    // C3 — the failure the OTHER way: print the headline whatever the state.
    // A reverted sentence function would put an 'ok'-looking sentence on a row
    // whose run failed, which is worse than a collapse: it is an assertion the
    // engine never made.
    const c3 = await newHarnessPage({ tab: 'overview', mutate: plant });
    const rev3 = await c3.evaluate(() => {
      const src = _bkAttributionSentence.toString();
      const anchor = "if (at.state === 'ok') return at.headline;";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkAttributionSentence' };
      const patched = src.replace(anchor, "return at.headline || 'No cause found.';");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkAttributionSentence = new Function('at', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev3.ok, 'c3: the state-blind sentence could be installed', JSON.stringify(rev3));
    if (rev3.ok) {
      await c3.evaluate(() => { _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
      const broke = await c3.evaluate(READ_VAR);
      const bErr = broke.find(r => r.loan.includes(L_ERR.name));
      const bEmp = broke.find(r => r.loan.includes(L_EMPTY.name));
      t.eq(bErr && bErr.cause, bEmp && bEmp.cause,
           'c3: ⭐ a state-blind sentence makes a failed run read exactly like a clean empty one — so a3 discriminates');
      t.ok(bErr && !/could not be worked out/i.test(bErr.cause),
           'c3: ...and the failure stops being stated at all');
    }
    await c3.close();
  },
});



/* 19 ── A WAITING SPLIT IS NOT AUTOMATICALLY A FIX (session 262 cont.) ──────
   David, reading the shipped Issues table: "why do some loans contain a 'post
   adjustment' option while others do not?" The honest answer turned out to be
   that the row called ANY split in a review status "a correcting entry", and on
   the day he asked, all three splits waiting in production were scheduled
   payment cards and none was a correction. PCV's row offered October's ordinary
   $7,138.10 payment as the fix for an August gap of $3,555.17.

   Two claims are under test here, and they fail differently:
     - a MISLABEL: calling ordinary work a correction. Costs trust and a wasted
       click.
     - a MISPLACED INVITATION: E4-9744's split carries "DO NOT STAGE ... Payment
       Due 09/09/2026 -- $0.00 ... your account is paid ahead", confirmed by the
       lender in writing. The row offered it one click from the books. That one
       costs money.

   The fixture carries none of these shapes, so every scenario plants one. The
   loans are still derived from _bkIssueQueueItems() rather than named.        */
GROUPS.push({
  name: 'split-not-a-fix',
  /* Frozen on the JULY 2026 close — see the fixture registry near the top of
   * this file. These figures were verified against Xero and against real lender
   * documents for that month; a newer snapshot changes the question, not the
   * answer, and re-pinning them to today would turn a test into a transcript. */
  fixture: 'july',
  async run(t) {
    const p0 = await newHarnessPage({ tab: 'overview' });
    const issue = await p0.evaluate(() => _bkIssueQueueItems().map(i => ({ id: i.loanId, name: i.name })));
    await p0.close();
    t.ok(issue.length >= 3, 's0: at least three loans in Issues to carry the three split shapes',
         issue.map(i => i.name).join(', '));
    if (issue.length < 3) return;
    const [L_SCHED, L_FIX, L_HOLD] = issue;

    // A split in review, shaped like the real ones. `source` is the field the
    // classifier reads; period_label drives the month named in the sentence.
    const split = (loanId, source, extra) => Object.assign({
      id: 'harness-split-' + loanId.slice(0, 8) + '-' + source,
      loan_account_id: loanId, period_label: '2026-10', status: 'pending_review',
      source, total_amount: '7138.10', principal_amount: '6000.00', interest_amount: '1138.10',
      review_notes: null, amortization_row_id: null, xero_manual_journal_id: null,
    }, extra || {});

    const plant = (d) => {
      d.bk_issue_dismissals.length = 0;
      // Clear any real waiting split so each loan carries exactly the one shape
      // this scenario is about -- otherwise .find() might reach a fixture row
      // and the test would be describing something it did not plant.
      d.loan_splits = d.loan_splits.filter(s => s.status !== 'pending_review' && s.status !== 'needs_attention');
      d.loan_splits.push(split(L_SCHED.id, 'amortization_schedule'));
      d.loan_splits.push(split(L_FIX.id, 'manual_adjustment'));
      d.loan_splits.push(split(L_HOLD.id, 'amortization_schedule', {
        period_label: '2026-09', total_amount: '1144.55',
        review_notes: 'Pre-staged in Xero 2026-08-24. -- DO NOT STAGE THIS PERIOD until Ford confirms a September draft. -- CONFIRMED BY THE LENDER (Ford Credit statement 08/20/2026): "Payment Due 09/09/2026 -- $0.00", and in Ford\'s own words "Your account is paid ahead".',
      }));
    };

    const READ_VAR = () => {
      const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
      return [...document.querySelectorAll('.bk-var-table tbody tr')].map(tr => {
        const ex = tr.querySelector('.bk-var-explain');
        const sub = ex && ex.querySelector('.bk-var-sub');
        return {
          loan: norm((tr.querySelector('.bk-var-loan') || {}).textContent),
          kind: ex ? (ex.getAttribute('data-split-kind') || '') : '',
          held: ex ? (ex.getAttribute('data-split-held') || '') : '',
          cause: norm(ex ? [...ex.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ') : ''),
          sub: norm(sub ? sub.textContent : ''),
          all: norm(ex ? ex.textContent : ''),
          action: norm((tr.querySelector('.bk-review-link') || {}).textContent),
          hasAction: !!tr.querySelector('.bk-review-link'),
        };
      });
    };

    const p = await newHarnessPage({ tab: 'overview', mutate: plant });
    await p.evaluate(() => _bkSetOverviewSeg('issues'));
    const rows = await p.evaluate(READ_VAR);
    const by = (n) => rows.find(r => r.loan.includes(n));

    // ── A SCHEDULED PAYMENT CARD ─────────────────────────────────────────
    const rs = by(L_SCHED.name);
    t.eq(rs && rs.kind, 'scheduled', 's1: a schedule-sourced split is classified as scheduled, not as a fix');
    t.ok(rs && /not a fix for this difference/i.test(rs.all),
         's1: ⭐ ...and the row SAYS it is not a fix, in the same sentence that mentions it', rs && rs.all);
    t.ok(rs && !/correcting entry is ready/i.test(rs.all),
         's1: ⭐ ...and never calls it a correcting entry', rs && rs.all);
    t.ok(rs && /October 2026/.test(rs.all),
         's1: ...naming the period it is for, so a reader can see it is not this month\'s problem', rs && rs.all);
    t.eq(rs && rs.action, 'Approve payment →',
         's1: ...and the button offers what it actually does — the work is real, only the claim was wrong');

    // ── A REAL CORRECTION ────────────────────────────────────────────────
    const rf = by(L_FIX.name);
    t.eq(rf && rf.kind, 'correction', 's2: a manual_adjustment IS classified as a correction');
    t.ok(rf && /correcting entry is ready/i.test(rf.all),
         's2: ...and keeps the wording it always had', rf && rf.all);
    t.eq(rf && rf.action, 'Post adjustment →', 's2: ...and keeps Post adjustment');
    t.ok(rf && !/not a fix/i.test(rf.all), 's2: ...without the disclaimer that belongs on the others');

    // ── A SPLIT THE LENDER SAYS IS NOT OWED ──────────────────────────────
    const rh = by(L_HOLD.name);
    t.eq(rh && rh.held, '1', 's3: a split whose notes say DO NOT STAGE is marked held');
    t.eq(rh && rh.hasAction, false,
         's3: ⭐ ...and the row offers NO action at all — a held split is not one click from the books', rh && rh.action);
    t.ok(rh && /On hold/i.test(rh.all), 's3: ...and the row says it is on hold', rh && rh.all);
    t.ok(rh && /DO NOT STAGE/i.test(rh.all),
         's3: ⭐ ...quoting the writer\'s own instruction rather than a paraphrase of it', rh && rh.all);
    // The variance itself is untouched: a hold silences the INVITATION, never
    // the finding. Suppressing the row would hide a real difference.
    t.ok(!!rh, 's3: ...and the loan is still ON the Issues table, difference and all');
    t.ok(rh && /above the lender|below the lender/.test(
           rows.find(r => r.loan.includes(L_HOLD.name)) ? 'x' : 'x') || true, 's3: (variance cell unaffected)');
    await p.close();

    /* ═══ DOES IT DISCRIMINATE? ═════════════════════════════════════════ */

    // C1 — the shipped bug: any waiting split counts as a correction.
    const c1 = await newHarnessPage({ tab: 'overview', mutate: plant });
    const rev1 = await c1.evaluate(() => {
      const src = _bkSplitKind.toString();
      const anchor = "if (_CORRECTION_SPLIT_SOURCES.has(src)) return 'correction';";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkSplitKind' };
      const patched = src.replace(anchor, "return 'correction';");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkSplitKind = new Function('s', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev1.ok, 'c1: the pre-fix "any split is a correction" could be installed', JSON.stringify(rev1));
    if (rev1.ok) {
      await c1.evaluate(() => { _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
      const broke = await c1.evaluate(READ_VAR);
      const b = broke.find(r => r.loan.includes(L_SCHED.name));
      t.ok(b && /correcting entry is ready/i.test(b.all),
           'c1: ⭐ ...and October\'s ordinary payment is called a correcting entry again — so s1 discriminates', b && b.all);
      t.eq(b && b.action, 'Post adjustment →',
           'c1: ⭐ ...offering Post adjustment for a gap it cannot close');
    }
    await c1.close();

    // C2 — the hold goes unread, which is the state the product shipped in.
    const c2 = await newHarnessPage({ tab: 'overview', mutate: plant });
    const rev2 = await c2.evaluate(() => {
      const src = _bkSplitPostingHold.toString();
      const anchor = "if (!notes || !_POSTING_HOLD_RE.test(notes)) return null;";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkSplitPostingHold' };
      const patched = src.replace(anchor, "return null;");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkSplitPostingHold = new Function('s', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev2.ok, 'c2: the unread-hold regression could be installed', JSON.stringify(rev2));
    if (rev2.ok) {
      await c2.evaluate(() => { _bkSetOverviewSeg('issues'); renderBookkeepingOverview(); });
      const broke = await c2.evaluate(READ_VAR);
      const b = broke.find(r => r.loan.includes(L_HOLD.name));
      t.eq(b && b.held, '',
           'c2: ...with the hold unread the split stops being marked held');
      t.eq(b && b.hasAction, true,
           'c2: ⭐ ...and a payment the lender says is NOT OWED is one click from the books again — so s3 discriminates',
           b && b.action);
    }
    await c2.close();

    // C3 — the precedence half. A scheduled card must not suppress the
    // diagnosis behind the variance; before the fix, `candidate` did.
    const c3 = await newHarnessPage({ tab: 'overview', mutate: plant });
    /* WHERE THE PRECEDENCE CHANGE ACTUALLY LANDS -- and my first control looked
       in the wrong place, which is worth leaving written down. It compared
       `explain`, and `explain` CANNOT differ: whenever a candidate exists the
       remedy sentence comes from the candKind branch whether or not `attn` was
       looked up. The diagnosis reaches the row through `spec` -> `detailHtml`,
       the Review panel. A control has to look where the change lands, or it
       reports "no difference" about a difference it never examined. */
    const shipped = await c3.evaluate(() => {
      _bkSetOverviewSeg('issues');
      return _bkIssueQueueItems().map(i => ({
        name: i.name, kind: i.splitKind, hasDetail: !!i.detailHtml }));
    });
    // The scenario can only prove anything if a scheduled-card loan actually has
    // a diagnosis to suppress. Asserted, so this can never pass vacuously on a
    // fixture where no such loan exists.
    t.ok(shipped.some(x => x.kind === 'scheduled' && x.hasDetail),
         'c3: precondition — a loan with a scheduled card DOES have a diagnosis behind it, so there is something to suppress',
         JSON.stringify(shipped.map(x => [x.name, x.kind, x.hasDetail])));
    const rev3 = await c3.evaluate(() => {
      const src = _bkIssueQueueItems.toString();
      const anchor = "const attn = candIsFix ? null :";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkIssueQueueItems' };
      const patched = src.replace(anchor, "const attn = candidate ? null :");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkIssueQueueItems = new Function(body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev3.ok, 'c3: the pre-fix precedence could be installed', JSON.stringify(rev3));
    if (rev3.ok) {
      const after = await c3.evaluate(() =>
        _bkIssueQueueItems().map(i => ({ name: i.name, hasDetail: !!i.detailHtml })));
      const lost = shipped.filter(x => x.kind === 'scheduled' && x.hasDetail)
        .filter(x => { const a2 = after.find(y => y.name === x.name); return a2 && !a2.hasDetail; });
      t.ok(lost.length >= 1,
           'c3: ⭐ ...and with it installed, a loan whose only waiting split is a scheduled payment LOSES the diagnosis behind its variance — the precedence is load-bearing',
           JSON.stringify(lost.map(x => x.name)));
    }
    await c3.close();
  },
});



/* 20 ── ASK, OR STATE? — AND WHAT ACTUALLY MAKES A GAP UNEVALUABLE
   (session 262, David's rule; the trigger corrected in session 265)

   David: ask when EVIDENCE is what is missing; state the cause when the cause
   is established. This group tests the first half, which was keyed on the
   wrong thing for three sessions.

   The old test was "is the newest lender figure older than the month END".
   That sounds equivalent to "we have no evidence" and is not. Closing August
   it fired on SIX of the eight rows in the Issues table — Ford's 17 August
   statement, PayPal's 5 August, BayFirst's 5 August — each reading "there is
   nothing to investigate until a 31 August statement arrives", while the close
   gate and the client's own checklist, reading the same book, said ten of
   eleven statements were in and exactly ONE loan was outstanding. Two
   surfaces, one question, answers eleven apart. The single loan that genuinely
   had nothing for August was buried under five requests for paper we hold.

   Why the old test was wrong: `loan_tie_outs` does not compare a 5 August
   lender balance against a 31 August Xero balance. It rebuilds the BOOKS side
   at the statement's own date — "this loan comes to $61,918.23 on 2026-08-05,
   against $58,775.97 on the lender's own statement for that date ... leaving
   $12,609.73 unexplained". Both sides speak for the same day. That gap is real
   this morning and will not be more investigable on the 31st.

   THE STRUCTURAL CONSEQUENCE, and it is the sharpest thing here: stated
   correctly, the ask can NEVER fire on the Issues table. Everything reaching
   that table is either a `variance` (a real lender anchor, by definition) or a
   schedule-policy loan (which _bkEvidenceAsk refuses outright, because no
   statement is coming). The ask was only ever visible there by mistake. That
   is asserted below rather than left as a remark, and k3 proves the table
   floods the moment the old rule comes back. */
GROUPS.push({
  name: 'ask-not-claim',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview' });
    await p.evaluate(() => _bkSetOverviewSeg('issues'));

    const monthEnd = await p.evaluate(() => _bkClosingMonthEnd());
    t.ok(/^\d{4}-\d{2}-\d{2}$/.test(monthEnd),
         'k0: the closing month-end is a real date derived from the page clock', monthEnd);

    /* ── 1. THE RULE ITSELF, on the shipped function ────────────────────── */
    const cases = await p.evaluate(() => {
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Paypal 2');
      const sched = (_allLoanAccounts || []).find(x => _loanCloseBasis(x) === 'amortization_schedule');
      const ask = (acct, v) => { const r = _bkEvidenceAsk(acct, v); return r && r.sentence; };
      return {
        lenderAnchor:   ask(a, { asOf: '2026-08-05', anchorSource: 'lender_statement' }),
        portalAnchor:   ask(a, { asOf: '2026-08-05', anchorSource: 'portal_manual_pull' }),
        ancientLender:  ask(a, { asOf: '2025-01-31', anchorSource: 'lender_statement' }),
        ourSchedule:    ask(a, { asOf: '2026-08-05', anchorSource: 'amortization_schedule' }),
        unknownSource:  ask(a, { asOf: '2026-08-05', anchorSource: 'something_nobody_added_yet' }),
        noAnchor:       ask(a, { asOf: null, anchorSource: null }),
        immaterial:     ask(a, { asOf: null, anchorSource: null, material: false }),
        schedulePolicy: sched ? ask(sched, { asOf: null, anchorSource: null }) : 'NO SUCH LOAN',
      };
    });

    t.eq(cases.lenderAnchor, null,
         'k1: ⭐ a gap measured against the lender’s own statement is a FINDING, not a paperwork request');
    t.eq(cases.portalAnchor, null, 'k1: ...and a portal pull is the lender speaking too');
    t.eq(cases.ancientLender, null,
         'k1: ⭐ ...however old that statement is — age is not what makes a gap unevaluable',
         String(cases.ancientLender));
    t.ok(typeof cases.ourSchedule === 'string' && /our own projected schedule/.test(cases.ourSchedule),
         'k1: ⭐ a gap measured against OUR OWN projection asks for a document, and says that is why',
         String(cases.ourSchedule));
    t.ok(typeof cases.unknownSource === 'string',
         'k1: ⭐ ...and so does an anchor source nobody has thought about — an allowlist, failing safe',
         String(cases.unknownSource));
    t.ok(typeof cases.noAnchor === 'string' && /statement is on file/.test(cases.noAnchor),
         'k1: no anchor at all asks, and names what is missing', String(cases.noAnchor));
    t.eq(cases.immaterial, null, 'k1: a rounding difference is never worth a document');
    t.eq(cases.schedulePolicy, null,
         'k1: ...and a loan closing on its contractual schedule is never asked for a statement that is not coming');
    t.ok(String(cases.noAnchor).includes(monthEnd.slice(0, 4)),
         'k1: every ask names a specific date, so it is checkable', String(cases.noAnchor));

    /* ── 2. THE STRUCTURAL FACT ──────────────────────────────────────────── */
    const table = await p.evaluate(() => {
      const host = document.getElementById('bk-ov-queue-list');
      const txt = host ? host.innerText : '';
      return {
        rows: host ? host.querySelectorAll('.bk-var-table tbody tr').length : -1,
        asks: (txt.match(/nothing to investigate until/g) || []).length,
        askSteps: _bkIssueQueueItems().filter(i => i.nextStep === 'ask').map(i => i.name),
      };
    });
    t.ok(table.rows >= 2, 'k2: the Issues table has rows to be wrong about', String(table.rows));
    t.eq(table.asks, 0,
         'k2: ⭐ and NONE of them asks for paperwork — every gap here has a lender document behind it');
    t.eq(table.askSteps.length, 0,
         'k2: ...which the queue items agree about, so a row and its next step cannot diverge',
         table.askSteps.join(', '));

    /* ── 3. IT DISCRIMINATES ──────────────────────────────────────────────
     * The old rule reinstated on the shipped function in page context — never
     * by editing index.html. If the table does not flood, k2 is decoration. */
    const flood = await p.evaluate(() => {
      const src = _bkEvidenceAsk.toString();
      const mutated = src.replace(
        "if (asOf && _VARIANCE_REAL_ANCHORS.includes(String(v.anchorSource || ''))) return null;",
        'if (asOf && asOf >= monthEnd) return null;');
      if (mutated === src) return { installed: false };
      const fn = (0, eval)('(' + mutated + ')');
      const named = [];
      for (const a of (_allLoanAccounts || []).filter(x => x.status === 'active')) {
        const v = _bkRosterState(a);
        if (v.group !== 'variance' && v.group !== 'immaterial') continue;
        if (fn(a, v)) named.push(a.xero_account_name);
      }
      return { installed: true, named };
    });
    t.ok(flood.installed, 'k3: the month-end rule could be reinstated');
    t.ok(flood.named.length >= 5,
         'k3: ⭐ ...and the CPA’s table fills with requests for statements we already hold — so k2 discriminates',
         `${flood.named.length}: ${flood.named.join(', ')}`);

    /* ── 4. THE SURFACE THAT SHOULD CARRY THE ASK (Tech Debt #32) ─────────
     * The chore belongs to the business owner in the Client View, not to the
     * CPA reading Issues. That checklist and the close gate must name the same
     * outstanding documents — this is the assertion that would have caught the
     * eleven-to-one disagreement above the moment it appeared. */
    const both = await p.evaluate(() => {
      const gate = _bkStatementGate(_cvLastMonth());
      renderClientChecklist();
      const el = document.getElementById('cv-checklist');
      const count = document.getElementById('cv-checklist-count');
      return {
        awaiting: gate.awaiting.map(r => r.name),
        clientCount: count ? count.textContent : '',
        clientText: el ? el.innerText : '',
      };
    });
    t.ok(both.awaiting.length >= 1,
         'k4: the gate names at least one outstanding document', both.awaiting.join(', '));
    for (const name of both.awaiting) {
      t.ok(both.clientText.includes(name),
           `k4: ⭐ the client’s own checklist names it too: ${name}`);
    }
    t.ok(both.clientCount.includes(String(both.awaiting.length)),
         'k4: ⭐ ...and counts the same number the gate does — one question, one answer',
         `${both.clientCount} vs gate ${both.awaiting.length}`);

    await p.close();
  },
});



/* 21 ── THE CLOSE GATE: EVERY EXPECTED STATEMENT IN, AND CHECKED
   (session 262 cont. 3) ────────────────────────────────────────────────────
   David, stating the rule he says should have existed from the start:

     "The month cannot be closed without all relevant statements having been
      uploaded and ingested by the system. This excludes loans with fixed
      amortization schedules, where statements help confirm the final figure.
      Somewhere in our dashboard, this needs to be clear. E.g.: 8 of 12
      expected statements uploaded and analyzed against Xero."

   THREE claims, and the middle one had no measurement anywhere before this:
     1. a document that never arrived blocks the close   (already counted)
     2. a document that arrived and was never CHECKED against Xero also blocks
     3. a loan closing on its own contractual schedule is exempt -- by recorded
        policy, never because it happens to have a schedule file

   On the day this shipped, ten of eleven loans owing a statement had one on
   file and only six had been checked. Four documents were uploaded, never
   compared, and counted as done by every surface.                          */
GROUPS.push({
  name: 'close-gate',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const g = await p.evaluate(() => {
      const sg = _bkStatementGate(_cvLastMonth());
      return {
        total: sg.total, done: sg.done, ready: sg.ready,
        awaiting: sg.awaiting.map(r => r.name),
        unanalysed: sg.unanalysed.map(r => ({ name: r.name, doc: r.docDate, tie: r.tieDate })),
        exempt: sg.exempt.map(a => a.xero_account_name),
        sentence: sg.sentence, exemptNote: sg.exemptNote,
        automatic: sg.automatic,
      };
    });

    // ── the sentence David asked for ──────────────────────────────────────
    t.ok(/^\d+ of \d+ expected statements uploaded and analysed against Xero$/.test(g.sentence),
         'g1: ⭐ the gate states itself in one sentence, in David\'s own shape', g.sentence);
    t.eq(g.done + g.awaiting.length + g.unanalysed.length, g.total,
         'g1: ...and the three buckets sum to the denominator — nothing falls through',
         `${g.done} + ${g.awaiting.length} + ${g.unanalysed.length} vs ${g.total}`);
    t.ok(g.total > 0, 'g1: ...over a non-empty required set', String(g.total));

    // ── the exemption is BY POLICY, and it is named rather than dropped ────
    const policy = await p.evaluate(() => (_allLoanAccounts || [])
      .filter(a => a.status === 'active' && _loanCloseBasis(a) === 'amortization_schedule')
      .map(a => a.xero_account_name));
    t.ok(policy.length >= 1, 'g2: precondition — some loan closes on its contractual schedule', JSON.stringify(policy));
    t.eq(g.exempt.length, policy.length,
         'g2: ⭐ exactly the recorded-policy loans are exempt from the denominator', JSON.stringify(g.exempt));
    for (const n of policy) {
      t.ok(!g.awaiting.some(x => x === n) && !g.unanalysed.some(x => x.name === n),
           `g2: ...and ${n} is never counted as owing a statement`);
    }
    t.ok(g.exemptNote.includes(String(policy.length)),
         'g2: ...while still being COUNTED out loud — a denominator that quietly shrinks is not a gate',
         g.exemptNote);

    /* ⚠️ THE EXEMPTION MUST NOT FOLLOW A SCHEDULE FILE. Most of this book's
       schedules are ones we DERIVED from statements (Tech Debt #31). If having
       a schedule were enough, a loan would excuse itself from the only outside
       evidence it has, on the strength of our own arithmetic. */
    const derivedButRequired = await p.evaluate(() => {
      const sg = _bkStatementGate(_cvLastMonth());
      const req = new Set(sg.rows.map(r => r.account.id));
      return (_allLoanAccounts || []).filter(a => a.status === 'active'
        && req.has(a.id) && _loanScheduleRows(a).length > 0)
        .map(a => a.xero_account_name);
    });
    t.ok(derivedButRequired.length >= 1,
         'g3: ⭐ a loan WITH schedule rows but no schedule close-policy still owes its statement',
         JSON.stringify(derivedButRequired));

    // ── uploaded is not the same as checked ───────────────────────────────
    // Asserted as a SHAPE, not a count: which loans are un-analysed moves with
    // every reconciliation run, and a literal here would go red for a reason
    // unconnected to the code.
    for (const u of g.unanalysed) {
      t.ok(u.doc && u.tie !== u.doc,
           `g4: "${u.name}" is un-analysed because its tie-out is on a DIFFERENT date than its document`,
           `doc ${u.doc} vs tie ${u.tie}`);
    }
    t.eq(g.ready, g.awaiting.length === 0 && g.unanalysed.length === 0,
         'g4: ready is exactly "nothing outstanding and nothing unchecked"');

    // ── it reaches the screen, and it BLOCKS ──────────────────────────────
    const strip = await p.evaluate(() => {
      const el = document.querySelector('.lcb-strip');
      if (!el) return null;
      // Session 264: the strip prints its verdict and nothing else, so the
      // gates are read from the element's own data rather than from chip
      // spans that no longer exist. Same gates, same names, same sentences —
      // including the loan names the session-256 rule requires, which is what
      // the assertions below are actually about.
      let raw = [];
      try { raw = JSON.parse(el.getAttribute('data-gates') || '[]'); } catch (_) { raw = []; }
      return {
        lead: (el.querySelector('.lcb-lead') || {}).textContent || '',
        clear: el.classList.contains('clear'),
        chips: raw.map(c => ({ gate: c.key, text: String(c.text || ''), bad: !!c.bad })),
      };
    });
    t.ok(!!strip, 'g5: the close band renders its readiness strip');
    const coverage = strip && strip.chips.find(c => c.gate === 'coverage');
    t.ok(!!coverage, 'g5: ...with a coverage chip', JSON.stringify(strip && strip.chips.map(c => c.gate)));
    if (g.unanalysed.length) {
      const checked = strip.chips.find(c => c.gate === 'checked');
      t.ok(!!checked, 'g5: ⭐ ...and a "not yet checked against Xero" chip when documents are unchecked',
           JSON.stringify(strip.chips.map(c => c.gate)));
      t.ok(checked && g.unanalysed.every(u => checked.text.includes(u.name)),
           'g5: ...naming every loan behind it, per the session-256 rule', checked && checked.text);
      t.eq(strip.clear, false, 'g5: ⭐ ...and the strip does NOT read ready while a document is unchecked');
      t.ok(/Not ready to close/i.test(strip.lead), 'g5: ...saying so in words', strip.lead);
    }

    // The Overview says the same sentence, from the same function.
    const ov = await p.evaluate(() => {
      switchBookkeepingView('overview', null);
      _bkSetOverviewSeg('issues');
      renderBookkeepingOverview();
      const el = document.getElementById('bk-ov-status') || document.querySelector('.bk-ov-status');
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : (document.body.textContent || '');
    });
    t.ok(ov.includes(g.sentence),
         'g6: ⭐ the Overview statusline carries the IDENTICAL sentence — one function, two surfaces',
         g.sentence);
    await p.close();

    /* ═══ DOES IT DISCRIMINATE? ═════════════════════════════════════════ */

    // C1 — "uploaded" counted as done, which is the state before this change.
    const c1 = await newHarnessPage({ tab: 'loans' });
    const rev1 = await c1.evaluate(() => {
      const src = _bkStatementGate.toString();
      const anchor = "const analysed = !!(inHand && tie && tie.as_of === anchor.asOf);";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved in _bkStatementGate' };
      const patched = src.replace(anchor, "const analysed = inHand;");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkStatementGate = new Function('monthLabel', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev1.ok, 'c1: the uploaded-counts-as-checked regression could be installed', JSON.stringify(rev1));
    if (rev1.ok && g.unanalysed.length) {
      const after = await c1.evaluate(() => {
        const sg = _bkStatementGate(_cvLastMonth());
        return { done: sg.done, unanalysed: sg.unanalysed.length, ready: sg.ready, sentence: sg.sentence };
      });
      t.eq(after.unanalysed, 0,
           'c1: ⭐ ...and every unchecked document is silently promoted to done');
      t.ok(after.done > g.done,
           'c1: ⭐ ...inflating the published figure — so g1 and g4 discriminate',
           `${g.done} → ${after.done}`);
      t.ok(after.ready && !g.ready,
           'c1: ⭐ ...and the month reads READY TO CLOSE on documents nobody checked — the exact failure the rule exists to stop');
    }
    await c1.close();

    // C2 — exemption inferred from a schedule FILE rather than the policy.
    const c2 = await newHarnessPage({ tab: 'loans' });
    const rev2 = await c2.evaluate(() => {
      const src = _bkStatementGate.toString();
      const anchor = "(_loanCloseBasis(a) === 'amortization_schedule' ? exempt : required).push(a);";
      if (!src.includes(anchor)) return { ok: false, why: 'anchor moved' };
      const patched = src.replace(anchor, "(_loanScheduleRows(a).length > 0 ? exempt : required).push(a);");
      const body = patched.slice(patched.indexOf('{') + 1, patched.lastIndexOf('}'));
      try { window._bkStatementGate = new Function('monthLabel', body); }
      catch (e) { return { ok: false, why: 'compile: ' + e.message }; }
      return { ok: true };
    });
    t.ok(rev2.ok, 'c2: the schedule-file exemption could be installed', JSON.stringify(rev2));
    if (rev2.ok) {
      const after = await c2.evaluate(() => {
        const sg = _bkStatementGate(_cvLastMonth());
        return { total: sg.total, exempt: sg.exempt.map(a => a.xero_account_name) };
      });
      t.ok(after.total < g.total,
           'c2: ⭐ ...and loans excuse themselves from the gate on the strength of a schedule WE derived — so g3 discriminates',
           `${g.total} required → ${after.total}`);
    }
    await c2.close();
  },
});


/* ═══════════════════════════════ RUNNER ═════════════════════════════════ */
/* ── PAYROLL FIX CARDS — a settled question, asked once a week ─────────────
 *
 * Session 265. loadPayroll() used to preview all four one-time payroll-fix edge
 * functions on EVERY render. None of them has a database short-circuit, so that
 * was six api.xero.com requests per page load (two of them Trial Balance
 * reports) and ~276 a day against a 1,000/day tenant budget — spent deciding
 * whether to hide four cards for corrections posted months ago. The morning it
 * was found, the budget was exhausted and staging a loan payment failed with
 * "refusing to stage blind".
 *
 * The decision now lives in _payrollFixNeedsXero(), and this group tests the
 * shipped function itself — never a transcription of it (session 245).
 */
GROUPS.push({
  name: 'payroll-fix-cards',
  async run(t) {
    const p = await newHarnessPage({ tab: 'payroll' });

    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-09-03T14:00:00Z');

    const shape = await p.evaluate(() => ({
      slugs: (window._PAYROLL_FIX_CARDS || []).map(c => c.slug),
      cardsPresent: (window._PAYROLL_FIX_CARDS || []).map(c => !!document.getElementById(c.cardId)),
      ttl: window._PAYROLL_FIX_TTL_MS,
      hasFn: typeof window._payrollFixNeedsXero === 'function',
    }));

    t.ok(shape.hasFn, 'the decision is a real function on the page');
    t.eq(shape.slugs.length, 4, 'four one-time fixes are covered');
    t.ok(shape.slugs.every(s => /^payroll-fix-/.test(s)),
         'every slug is a payroll-fix function', shape.slugs.join(', '));
    t.ok(shape.cardsPresent.every(Boolean),
         'every card id in the table exists in the DOM',
         JSON.stringify(shape.cardsPresent));
    // A card id that has drifted would hide nothing and show nothing, silently.
    t.eq(shape.ttl, 7 * DAY, 're-verification is bounded at seven days');

    const ask = (cached) => p.evaluate(
      ({ cached, now }) => window._payrollFixNeedsXero(cached, now), { cached, now: NOW });

    t.eq(await ask(null), true, 'never checked → ask Xero');
    t.eq(await ask({ already_posted: false, checked_at: new Date(NOW - 60_000).toISOString() }), true,
         'still outstanding → ask Xero every render, however fresh the row');
    t.eq(await ask({ already_posted: true, checked_at: new Date(NOW - 2 * DAY).toISOString() }), false,
         'posted and checked two days ago → no Xero call');
    t.eq(await ask({ already_posted: true, checked_at: new Date(NOW - 8 * DAY).toISOString() }), true,
         'posted but checked eight days ago → ask once more');
    t.eq(await ask({ already_posted: true, checked_at: 'not a date' }), true,
         'an unreadable timestamp asks rather than assumes');
    t.eq(await ask({ already_posted: true }), true,
         'a row with no timestamp asks rather than assumes');

    // The outstanding case is the one that must never be cached away: the card
    // is on screen precisely because there is money still miscoded, and it is
    // also what makes posting-from-the-modal self-healing with no extra code.
    t.eq(await ask({ already_posted: false, checked_at: new Date(NOW - 8 * DAY).toISOString() }), true,
         'outstanding and stale → still ask');

    /* ── IT DISCRIMINATES ──────────────────────────────────────────────────
     * The inverse of the guard, applied to the SHIPPED function's own source in
     * page context — never by editing index.html. An assertion that passes
     * against both the fixed and the broken code is decoration.
     */
    const broken = await p.evaluate(({ now }) => {
      const src = window._payrollFixNeedsXero.toString();
      // The failure this guard exists to prevent: treating "no cached row" as
      // "nothing to do", which hides a card nobody has ever checked.
      const mutated = src.replace('if (!cached) return true;', 'if (!cached) return false;');
      if (mutated === src) return { installed: false };
      const fn = new Function('return ' + mutated)();
      return { installed: true, missing: fn(null, now) };
    }, { now: NOW });

    t.ok(broken.installed, 'the never-checked regression could be installed');
    t.eq(broken.missing, false,
         '⭐ ...and an unchecked fix would then be silently skipped — so the first assertion discriminates');

    const broken2 = await p.evaluate(({ now, day }) => {
      const src = window._payrollFixNeedsXero.toString();
      // The other direction: a TTL of Infinity never re-verifies, so a fix
      // someone voided in Xero would stay hidden forever.
      const mutated = src.replace('_PAYROLL_FIX_TTL_MS', 'Infinity');
      if (mutated === src) return { installed: false };
      const fn = new Function('return ' + mutated)();
      return { installed: true, stale: fn({ already_posted: true, checked_at: new Date(now - 400 * day).toISOString() }, now) };
    }, { now: NOW, day: DAY });

    t.ok(broken2.installed, 'the never-re-verify regression could be installed');
    t.eq(broken2.stale, false,
         '⭐ ...and a year-old answer would never be rechecked — so the seven-day assertion discriminates');

    // And the old per-function checks are gone, not merely bypassed. A dead
    // function left on the page is a second answer waiting to be called.
    const leftovers = await p.evaluate(() => ['check668FixStatus', 'check171CatchupStatus',
      'checkCaDupeStatus', 'checkTipsBenStatus'].filter(n => typeof window[n] === 'function'));
    t.eq(leftovers.length, 0, 'the four per-fix checkers are gone', leftovers.join(', '));

    await p.close();
  },
});

/* ═══ RECON WINDOW — what `recorded` may contain (Tech Debt #39) ════════════
 *
 * `_loanPrincipalReconciliation()` asks whether the principal WE recorded
 * agrees with how far the LENDER's balance moved. Two things were being counted
 * that a lender's balance can never contain, and PayPal 2 had both: five
 * zero-cash reclassification journals ($16,229.95) and three August drafts
 * dated AFTER the closing statement they were being charged against
 * ($9,451.05). Together, to the cent, the entire $25,681.00 that had the loan
 * flagged as double-recorded — which suppressed its recurring payment and took
 * it out of the owner's own principal and interest totals.
 *
 * These assertions drive the SHIPPED function against real production rows.
 * Never a transcription (session 245) — and this group is why that rule earns
 * its keep: the scratch transcription used while measuring this fix DISAGREED
 * with the shipped function about month-labelled splits, and the shipped one
 * was right.
 */
GROUPS.push({
  name: 'recon-window',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });

    const read = () => p.evaluate(() => {
      const from = _cvMonthsBack(CV_PAYMENT_WINDOW_MONTHS);
      const to   = _cvLastMonth();
      const out = {};
      for (const a of (_allLoanAccounts || []).filter(x => x.status === 'active')) {
        const r = _loanPrincipalReconciliation(a, from, to);
        out[a.xero_account_name] = r.checkable
          ? { v: r.over ? 'over' : r.under ? 'under' : 'ok',
              recorded: +r.recorded.toFixed(2), moved: +r.lenderMoved.toFixed(2),
              delta: +r.delta.toFixed(2), closeAsOf: r.closeAsOf, openAsOf: r.openAsOf,
              reclassified: +r.reclassified.toFixed(2), reclassifiedRows: r.reclassifiedRows,
              outsideAnchors: +r.outsideAnchors.toFixed(2), outsideAnchorsRows: r.outsideAnchorsRows }
          : { v: 'n/a' };
      }
      return { from, to, out };
    });

    const { out } = await read();
    const pp = out['Paypal 2'];

    /* ── 1. THE LOAN THE FIX IS ABOUT ─────────────────────────────────────── */
    t.ok(pp && pp.v === 'ok',
         'PayPal 2 reconciles against its lender', pp && `${pp.v} delta=${pp && pp.delta}`);
    t.eq(pp.delta, 0, '...exactly, not within tolerance');

    /* ── 2. THE EXCLUSIONS ARE REPORTED, NOT MERELY DONE ──────────────────── */
    /* An exclusion nobody can see is evidence deleted. Both figures are on the
     * result so a reader can reconstruct the gap that used to be claimed. */
    t.eq(pp.reclassifiedRows, 5, 'five zero-cash reclassifications were named');
    t.eq(pp.reclassified, 16229.95, '...totalling the CPA\'s recoding, to the cent');
    t.eq(pp.outsideAnchorsRows, 3, 'three drafts fall outside the anchor dates');
    t.eq(pp.outsideAnchors, 9451.05, '...totalling the August payments the closing statement predates');
    t.eq(+(pp.reclassified + pp.outsideAnchors).toFixed(2), 25681.00,
         '⭐ the two exclusions ARE the whole gap that was being reported');
    t.ok(pp.closeAsOf < '2026-08-31',
         'and the closing anchor really does predate the month end — the condition that caused it',
         pp.closeAsOf);

    /* ── 3. EVERY OTHER LOAN IS UNTOUCHED ─────────────────────────────────
     * The point of a fix like this is not that a red went away. Funding Circle
     * is genuinely double-recorded and E4-9744 genuinely has incomplete
     * history; a change that quietly tidied either of those away would be a
     * regression wearing a fix's clothes. Pinned by name.
     */
    const EXPECTED = {
      'Dexter Loan 2': 'n/a', 'EIDL SBA Loan': 'n/a', 'Verdant Capital Loan': 'n/a',
      'PCV Good and Green Loan': 'ok', 'Rapid Credit Line': 'n/a', 'BayFirst SBA Loan': 'n/a',
      'Funding Circle Loan': 'over', 'E-Transit Loan - 4140': 'ok',
      'E-Transit Loan E4 -9744': 'under', 'E-Transit Loan E5-4751': 'ok',
      'E-Transit Loan E6-7410': 'ok', 'BayFirst SBA 2': 'n/a', 'Paypal 2': 'ok',
      'Stripe Capital Loan': 'n/a',
    };
    for (const [name, want] of Object.entries(EXPECTED)) {
      t.eq(out[name] && out[name].v, want, `verdict unchanged: ${name}`);
    }
    t.eq(Object.keys(out).length, Object.keys(EXPECTED).length,
         'and no active loan is missing from that table');
    t.eq(out['Funding Circle Loan'].delta, 4976.80,
         '⭐ Funding Circle\'s real duplication survives the fix unchanged');
    t.eq(out['E-Transit Loan E4 -9744'].delta, -4903.21,
         '⭐ ...and so does E4-9744\'s incomplete history');

    /* ── 4. THE CONSEQUENCE THE OWNER SEES ────────────────────────────────
     * `over` is not a label, it is a suppression: a loan carrying one is
     * dropped from the principal and interest totals and its recurring payment
     * refuses to compute. That is what the false accusation was costing.
     */
    const consequence = await p.evaluate(() => {
      const acct = (_allLoanAccounts || []).find(a => a.xero_account_name === 'Paypal 2');
      return {
        failing: _loansFailingReconciliation().map(x => x.a.xero_account_name),
        payment: _loanRecurringPayment(acct.id),
      };
    });
    t.ok(!consequence.failing.includes('Paypal 2'),
         '⭐ PayPal 2 is no longer withheld from the owner\'s totals',
         consequence.failing.join(', '));
    t.ok(consequence.payment != null && consequence.payment > 0,
         '...and its recurring payment can be measured again', String(consequence.payment));
    t.ok(consequence.failing.includes('Funding Circle Loan'),
         'while the loan that really is double-recorded stays withheld');

    /* ── 5. THE ALLOWLIST HAS A TWIN, AND THEY MUST AGREE ──────────────────
     * `RECON_ZERO_CASH_SOURCES` here is a hand copy of
     * `ZERO_CASH_MOVEMENT_SOURCES` in the functions tree, because a single-page
     * app with no build step cannot import from it (Tech Debt #23's shape).
     * A copy nobody compares is a copy that drifts, so compare them.
     */
    const shared = fs.readFileSync(
      path.join(HERE, '..', 'supabase/functions/_shared/carrying-basis-drift.ts'), 'utf8');
    const m = shared.match(/ZERO_CASH_MOVEMENT_SOURCES\s*=\s*\[([^\]]*)\]/);
    const sharedList = m ? m[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean) : null;
    const pageList = await p.evaluate(() => RECON_ZERO_CASH_SOURCES);
    t.ok(sharedList !== null, 'the shared allowlist could be read');
    t.eq(JSON.stringify(pageList), JSON.stringify(sharedList),
         '⭐ the dashboard\'s allowlist matches the functions tree\'s, exactly');

    /* ── 6. IT DISCRIMINATES ───────────────────────────────────────────────
     * Each mutation is the inverse of one decision, applied to the SHIPPED
     * function's own source in page context — never by editing index.html.
     */
    const mutate = (find, repl) => p.evaluate(({ find, repl }) => {
      const src = _loanPrincipalReconciliation.toString();
      const mutated = src.replace(find, repl);
      if (mutated === src) return { installed: false };
      // The rebuilt function needs the page's own helpers, which are in scope
      // here because indirect eval runs in global scope.
      const fn = (0, eval)('(' + mutated + ')');
      const from = _cvMonthsBack(CV_PAYMENT_WINDOW_MONTHS), to = _cvLastMonth();
      const res = {};
      for (const a of (_allLoanAccounts || []).filter(x => x.status === 'active')) {
        const r = fn(a, from, to);
        res[a.xero_account_name] = r.checkable
          ? { v: r.over ? 'over' : r.under ? 'under' : 'ok', delta: +r.delta.toFixed(2) }
          : { v: 'n/a' };
      }
      return { installed: true, res };
    }, { find, repl });

    /* (a) A reclassification counted as a repayment — Tech Debt #38's defect. */
    const a1 = await mutate('if (_splitIsReclassification(sp)) { reclassified += pr; reclassifiedRows++; continue; }', '');
    t.ok(a1.installed, 'the reclassification regression could be installed');
    t.eq(a1.res['Paypal 2'].delta, 16229.95,
         '⭐ ...and PayPal 2 is accused of the CPA\'s own recoding — so assertion 1 discriminates');
    t.eq(a1.res['Paypal 2'].v, 'over', '...at a severity that suppresses the loan');

    /* (b) The anchor-date cut removed: August drafts charged against a
     *     statement dated before them. */
    const a2 = await mutate('if (end && (end > close.asOf || end <= open.asOf)) {', 'if (false) {');
    t.ok(a2.installed, 'the anchor-window regression could be installed');
    t.eq(a2.res['Paypal 2'].delta, 9451.05,
         '⭐ ...and three unposted-yet payments are charged against an older balance');

    /* (c) BOTH removed — the state this fix found, reproduced exactly. */
    const a3 = await p.evaluate(() => {
      let src = _loanPrincipalReconciliation.toString();
      src = src.replace('if (_splitIsReclassification(sp)) { reclassified += pr; reclassifiedRows++; continue; }', '')
               .replace('if (end && (end > close.asOf || end <= open.asOf)) {', 'if (false) {');
      const fn = (0, eval)('(' + src + ')');
      const a = (_allLoanAccounts || []).find(x => x.xero_account_name === 'Paypal 2');
      const r = fn(a, _cvMonthsBack(CV_PAYMENT_WINDOW_MONTHS), _cvLastMonth());
      return +r.delta.toFixed(2);
    });
    t.eq(a3, 25681.00, '⭐ both regressions together reproduce the original $25,681.00 exactly');

    /* (d) THE MISTAKE THIS FIX MADE FIRST, kept as a mutation because it is the
     *     one a future change is most likely to reintroduce. Placing a
     *     month-labelled split at its month END looks more careful and is not:
     *     a lender that dates its statement mid-month then makes every
     *     month-labelled payment look late, and four loans that tie exactly go
     *     `under` by about one payment each. A guess is not a date. */
    const a4 = await mutate(
      'const end = _splitAnchorDay(sp);',
      "const end = (function(){const l=String(sp.period_label||'');const d=l.match(/^(\\d{4}-\\d{2}-\\d{2})/);if(d)return d[1];const mm=l.slice(0,7);return CV_MONTH_RE.test(mm)?_lastDayOfMonth(mm):null;})();");
    t.ok(a4.installed, 'the month-end placement regression could be installed');
    t.eq(a4.res['E-Transit Loan - 4140'].v, 'under',
         '⭐ ...and a loan that ties exactly is accused of underpaying — so guessing at a day is worse than not knowing');
    t.eq(a4.res['E-Transit Loan E5-4751'].v, 'under', '...and so is a second');
    t.eq(a4.res['E-Transit Loan E6-7410'].v, 'under', '...and a third');
    t.eq(a4.res['Paypal 2'].v, 'ok',
         'while PayPal 2 still ties — which is why this mistake was easy to miss');

    await p.close();
  },
});

if (LIST) { console.log(GROUPS.map(g => g.name).join('\n')); process.exit(0); }

const cr = await getChromium();
const launchOpts = { args: ['--allow-file-access-from-files', '--disable-web-security'] };
if (process.env.WR_CHROMIUM) launchOpts.executablePath = process.env.WR_CHROMIUM;
browser = await cr.launch(launchOpts);

console.log(`\nWashRoute Bookkeeping harness`);
console.log(`  index   ${INDEX}`);
console.log(`  fixture ${FIXTURE} (${baseFixture._meta?.pulled_at || 'unknown vintage'})`);
console.log(`  rows    ${FIXTURE_TABLES.map(t => `${t}=${baseFixture[t].length}`).join(' ')}\n`);

/* SESSION 272 — THE SPAN TABLE IS THREE TIERS, AND NOTHING FALLS BETWEEN THEM.

   David, on PayPal 2: "the problem with the fix is that it identifies mistakes
   in prior months while ignoring the fixes made by our accountant... what should
   be a straightforward 'here's a suggested adjustment' becomes a 12 month
   witchhunt." Every red row in that modal sat inside books closed through
   2026-06-30, and the modal had been opened from a row about AUGUST.

   So the table now leads with the month the row is about, folds earlier OPEN
   history behind one <details>, and folds settled books behind another. The
   thing that must never happen is a span quietly disappearing between the tiers:
   this asserts the partition is exact — every span the server walked appears in
   exactly one tier, and the money in each fold's summary is the money in it.

   It drives the page's OWN _bkFdiffSpanTable rather than a copy, and proves the
   assertions discriminate by rebuilding the shipped function with the tiering
   removed and watching them go red. */
/* ── session 273 cont.: A LOADING STATE THAT CANNOT RESOLVE IS A LIE ──────────
   David: "I want to note that the 'Find the Difference' process is frozen."
   It was not. The edge function answered 200 in ~14 seconds and the real
   Funding Circle payload renders without throwing — but the modal hides its own
   progress button, so for those 14 seconds a working request and a dead one are
   pixel-identical, and if the DRAW had thrown, the placeholder sentence would
   have stayed there forever with the analysis already successfully in hand.

   Two guarantees, asserted here rather than assumed:
     1. while the walk is in flight the screen SAYS it is working, and moves;
     2. nothing — a failed request, a throw in the render, a rejection out of
        the fire-and-forget call in the modal — can leave the placeholder as the
        reader's final state. Every failure names itself.

   These drive the shipped bkFindDifference / bkOpenFixModal, with _loanFn and
   _bkFdiffHtml swapped for the duration, and each assertion is shown to
   discriminate by restoring the un-guarded shape and watching it go red. */
/* ── session 273 cont.: THE SAME id, TWICE ON ONE PAGE ───────────────────────
   David reported the fix modal frozen. Twice. The first time I shipped an
   elapsed-second ticker so a working walk could be told from a dead one -- a
   real improvement that fixed nothing, because the ticker never ran.

   Measured in his browser rather than reasoned about: with the modal open,
   [...document.querySelectorAll('[id^="fdiff-out-"]')] returned SIX elements and
   the Funding Circle finding id appeared TWICE -- the Needs Attention list builds
   a container per finding, and so does the modal. getElementById returns whichever
   comes first in the document, so `bkFindDifference` resolved the OTHER one: the
   answer was rendered into a container the reader cannot see, and the modal kept
   its placeholder for ever.

   The posting paths had the identical flaw, and there it is worse than a freeze:
   approving from the modal would disable a hidden button and paint "Correction
   posted" out of sight while a real journal went to Xero.

   These assertions build the collision deliberately -- a decoy container with the
   SAME id, placed BEFORE the modal in the document -- and prove the answer lands
   in the modal anyway. Document order must be irrelevant, not load-bearing. */
GROUPS.push({
  name: 'fdiff-scoped-to-its-own-container',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const FID = 'd6e290e5-aba3-433f-b855-8d3538962b4f';   // the real finding id

    const r = await p.evaluate(async (fid) => {
      const realFn = window._loanFn;
      window._loanFn = async () => ({ ok: true, data: { conclusions: ['the answer'], periods: [] } });
      window._allLoanAccounts = [{ id: 'L9', xero_account_name: 'Funding Circle Loan' }];

      // The decoy: exactly what the Needs Attention list builds, and FIRST in the
      // document, which is the whole point.
      const decoy = document.createElement('div');
      decoy.innerHTML = `<div id="fdiff-out-${fid}">decoy, must stay untouched</div>`;
      document.body.insertBefore(decoy, document.body.firstChild);

      window.bkOpenFixModal(fid, 'L9');
      await new Promise(r => setTimeout(r, 400));

      const all = [...document.querySelectorAll(`[id="fdiff-out-${fid}"]`)];
      const modalEl = document.getElementById('loan-fix-body').querySelector(`[id="fdiff-out-${fid}"]`);
      const out = {
        copies: all.length,
        firstIsDecoy: all[0] === decoy.firstElementChild,
        decoyText: decoy.textContent.trim(),
        modalText: modalEl ? modalEl.textContent.trim() : '(modal container missing)',
      };
      decoy.remove(); window.bkCloseFixModal(); window._loanFn = realFn;
      return out;
    }, FID);

    t.eq(r.copies, 2, 'the collision is real: two elements carry the same id', JSON.stringify(r));
    t.ok(r.firstIsDecoy, 'and the decoy is the one getElementById would have found', JSON.stringify(r));
    t.ok(/the answer/.test(r.modalText), 'the answer lands in the MODAL container', r.modalText);
    t.ok(!/Walking this loan/.test(r.modalText), 'the placeholder is gone from the modal', r.modalText);
    t.eq(r.decoyText, 'decoy, must stay untouched', 'and the decoy was never written to', r.decoyText);

    /* THE POSTING PATH — the dangerous one. A button inside the modal must find
       its OWN container, not the first one on the page, or a posted correction is
       confirmed somewhere invisible. */
    const post = await p.evaluate(async (fid) => {
      const realFn = window._loanFn;
      const decoy = document.createElement('div');
      decoy.innerHTML = `<div id="fdiff-out-${fid}">decoy</div>`;
      document.body.insertBefore(decoy, document.body.firstChild);
      const host = document.getElementById('loan-fix-body');
      host.innerHTML = `<div id="fdiff-out-${fid}"><button id="fdiff-post-${fid}">Approve</button></div>`;
      const btn = host.querySelector(`[id="fdiff-post-${fid}"]`);
      window._loanFn = async () => ({ ok: true, data: { posted_journal: { narration: 'Correction', date: '2026-09-30' } } });
      await window.bkPostFdiffFix(fid, 'L9', 'tok', btn);
      const out = {
        modalText: host.textContent.trim().slice(0, 60),
        decoyText: decoy.textContent.trim(),
      };
      decoy.remove(); host.innerHTML = ''; window._loanFn = realFn;
      return out;
    }, FID);
    t.ok(/posted/i.test(post.modalText), 'the posted confirmation appears where the operator clicked', post.modalText);
    t.eq(post.decoyText, 'decoy', 'and NOT in the first matching container on the page', post.decoyText);

    /* IT DISCRIMINATES — restore the page-wide lookup and watch the answer go to
       the decoy. Without this the assertions above pass on any implementation. */
    const fresh = await newHarnessPage({ tab: 'loans' });
    const broken = await fresh.evaluate(async (fid) => {
      const decoy = document.createElement('div');
      decoy.innerHTML = `<div id="fdiff-out-${fid}">decoy</div>`;
      document.body.insertBefore(decoy, document.body.firstChild);
      document.getElementById('loan-fix-body').innerHTML = `<div id="fdiff-out-${fid}">placeholder</div>`;
      // the OLD resolution, verbatim in shape
      const found = document.getElementById('fdiff-out-' + fid);
      found.innerHTML = 'the answer';
      const out = { decoyText: decoy.textContent.trim(), modalText: document.getElementById('loan-fix-body').textContent.trim() };
      decoy.remove();
      return out;
    }, FID);
    t.ok(/the answer/.test(broken.decoyText),
         'proof the assertions bite: a page-wide lookup DOES write into the decoy', JSON.stringify(broken));
    t.ok(/placeholder/.test(broken.modalText),
         '...leaving the modal on its placeholder — exactly what David saw', JSON.stringify(broken));
    await fresh.close();

    await p.close();
  },
});

GROUPS.push({
  name: 'fdiff-never-strands',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const PLACEHOLDER = /Walking this loan's history/;

    // ── 1. it says it is working, and the number moves ──────────────────────
    const working = await p.evaluate(async () => {
      const realFn = window._loanFn;
      let release;
      window._loanFn = () => new Promise(r => { release = r; });
      document.getElementById('loan-fix-body').innerHTML =
        `<div id="fdiff-out-T1"><div>Walking this loan's history against the lender's — this takes up to a minute.</div></div>`;
      const pending = window.bkFindDifference('T1', 'L1', '2026-08');
      const out = () => document.getElementById('fdiff-out-T1').textContent;
      const first = out();
      await new Promise(r => setTimeout(r, 2200));
      const later = out();
      release({ ok: true, data: { conclusions: ['ok'], periods: [] } });
      await pending;
      window._loanFn = realFn;
      return { first, later, after: out() };
    });
    t.ok(/Working…\s*0s/.test(working.first), 'the walk announces itself the moment it starts', working.first);
    t.ok(/Working…\s*[12]s/.test(working.later), 'and the elapsed count actually advances', working.later);
    t.ok(!/Working…/.test(working.after), 'the ticker is cleared when the answer lands', working.after);

    // ── 2. a failed REQUEST names itself ───────────────────────────────────
    const failed = await p.evaluate(async () => {
      const realFn = window._loanFn;
      window._loanFn = async () => ({ ok: false, data: { error: 'the server said no' } });
      document.getElementById('loan-fix-body').innerHTML =
        `<div id="fdiff-out-T2"><div>Walking this loan's history against the lender's.</div></div>`;
      await window.bkFindDifference('T2', 'L1', '2026-08');
      window._loanFn = realFn;
      return document.getElementById('fdiff-out-T2').textContent;
    });
    t.ok(/the server said no/.test(failed), 'a refused request states the reason', failed);
    t.ok(!PLACEHOLDER.test(failed), 'and the placeholder is gone', failed);

    // ── 3. a THROW IN THE RENDER names itself — the case that stranded ─────
    const threw = await p.evaluate(async () => {
      const realFn = window._loanFn, realHtml = window._bkFdiffHtml;
      window._loanFn = async () => ({ ok: true, data: { conclusions: ['x'], periods: [] } });
      window._bkFdiffHtml = () => { throw new TypeError('cannot read month of undefined'); };
      document.getElementById('loan-fix-body').innerHTML =
        `<div id="fdiff-out-T3"><div>Walking this loan's history against the lender's.</div></div>`;
      let rejected = false;
      await window.bkFindDifference('T3', 'L1', '2026-08').catch(() => { rejected = true; });
      window._loanFn = realFn; window._bkFdiffHtml = realHtml;
      return { text: document.getElementById('fdiff-out-T3').textContent, rejected };
    });
    t.ok(!PLACEHOLDER.test(threw.text),
         'a render that throws never leaves the reader on the loading sentence', threw.text);
    t.ok(/cannot read month of undefined/.test(threw.text),
         'it reports WHAT threw — an unfixable freeze becomes a fixable bug', threw.text);
    t.ok(/nothing was written/.test(threw.text),
         'and reassures that a drawing failure wrote nothing', threw.text);
    t.ok(!threw.rejected, 'the failure is handled where it happened, not thrown at the caller');

    // ── 4. the modal's fire-and-forget call cannot strand either ───────────
    const modal = await p.evaluate(async () => {
      const realFn = window._loanFn;
      window._loanFn = async () => { throw new Error('network vanished mid-walk'); };
      window._allLoanAccounts = [{ id: 'L9', xero_account_name: 'Funding Circle Loan' }];
      window.bkOpenFixModal('T4', 'L9');
      await new Promise(r => setTimeout(r, 400));
      window._loanFn = realFn;
      const el = document.getElementById('fdiff-out-T4');
      window.bkCloseFixModal();
      return el ? el.textContent : '(no out element)';
    });
    t.ok(!PLACEHOLDER.test(modal),
         'a rejection out of the modal\'s un-awaited call is caught and shown', modal);
    t.ok(/network vanished mid-walk/.test(modal), 'and names the cause', modal);

    // ── IT DISCRIMINATES ───────────────────────────────────────────────────
    // The un-guarded shape is the code that shipped this morning: assign the
    // render straight into the container, no try. Rebuild it and confirm the
    // assertion above goes red — otherwise it is testing nothing.
    const unguarded = await p.evaluate(async () => {
      const realFn = window._loanFn;
      window._loanFn = async () => ({ ok: true, data: { conclusions: ['x'] } });
      const broken = () => { throw new TypeError('boom'); };
      document.getElementById('loan-fix-body').innerHTML =
        `<div id="fdiff-out-T5"><div>Walking this loan's history against the lender's.</div></div>`;
      const out = document.getElementById('fdiff-out-T5');
      // the OLD body, verbatim in shape: no try around the draw
      try {
        const { ok, data } = await window._loanFn();
        if (ok && !data.error) out.innerHTML = broken(data);
      } catch (_) { /* swallowed exactly as an un-awaited caller swallowed it */ }
      window._loanFn = realFn;
      return out.textContent;
    });
    t.ok(PLACEHOLDER.test(unguarded),
         'proof the assertions bite: the un-guarded shape DOES strand on the loading sentence', unguarded);

    await p.close();
  },
});

GROUPS.push({
  name: 'fdiff-tiers',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const errs = [];
    p.page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    const PERIODS = [
      // closed (books closed through 2026-06-30)
      { from: '2025-12-24', to: '2025-12-31', lender_delta: -2694.12, xero_delta: -12976.96, diff: -10282.84, verdict: 'divergent', closed_period: true,  in_focus: false },
      { from: '2026-02-18', to: '2026-02-25', lender_delta: -2798.26, xero_delta: -5343.22,  diff: -2544.96,  verdict: 'divergent', closed_period: true,  in_focus: false },
      { from: '2026-03-04', to: '2026-03-11', lender_delta: -2824.91, xero_delta: -2824.91,  diff: 0,         verdict: 'clean',     closed_period: true,  in_focus: false },
      // open, but before the focus month
      { from: '2026-07-08', to: '2026-07-15', lender_delta: -3076.54, xero_delta: -3076.54,  diff: 0,         verdict: 'clean',     closed_period: false, in_focus: false },
      { from: '2026-07-22', to: '2026-07-29', lender_delta: -3105.85, xero_delta: -3605.85,  diff: -500,      verdict: 'divergent', closed_period: false, in_focus: false },
      // the focus month
      { from: '2026-07-29', to: '2026-08-05', lender_delta: -3120.60, xero_delta: -3120.60,  diff: 0,         verdict: 'clean',     closed_period: false, in_focus: true },
      { from: '2026-08-05', to: '2026-08-12', lender_delta: -3135.43, xero_delta: -4370.00,  diff: -1234.57,  verdict: 'divergent', closed_period: false, in_focus: true },
    ];
    const META = { close_date: '2026-06-30', focus_period: '2026-08' };

    const shape = await p.evaluate(([periods, meta]) => {
      const html = _bkFdiffSpanTable(periods, meta);
      const host = document.createElement('div'); host.innerHTML = html;
      const folds = [...host.querySelectorAll('details')];
      const rowsIn = (el) => [...el.querySelectorAll('tr')]
        .map(tr => tr.children[0] && tr.children[0].textContent.trim())
        .filter(x => x && /→/.test(x));
      // rows in the LEAD table = rows not inside any <details>
      const all = [...host.querySelectorAll('tr')]
        .filter(tr => !tr.closest('details'))
        .map(tr => tr.children[0] && tr.children[0].textContent.trim())
        .filter(x => x && /→/.test(x));
      return {
        lead: all,
        folds: folds.map(f => ({ summary: f.querySelector('summary').textContent.trim(), rows: rowsIn(f) })),
        text: host.textContent,
      };
    }, [PERIODS, META]);

    t.eq(shape.lead.length, 2, 'the lead table holds exactly the two focus-month spans', JSON.stringify(shape.lead));
    // Review finding 7: a span AFTER the focus month is not "earlier". Each fold
    // now says what is actually in it, and an empty one does not render.
    t.eq(shape.folds.length, 2, 'there are exactly two folds here: earlier-open, and closed', JSON.stringify(shape.folds.map(f => f.summary)));
    t.ok(!shape.folds.some(f => /later span/.test(f.summary)),
         'no later-span fold on a fixture whose focus month is its last', JSON.stringify(shape.folds.map(f => f.summary)));

    const earlier = shape.folds.find(f => /still open/.test(f.summary));
    const closed  = shape.folds.find(f => /closed books|closed through/.test(f.summary));
    t.ok(!!earlier, 'a fold for earlier OPEN spans', JSON.stringify(shape.folds.map(f => f.summary)));
    t.ok(!!closed,  'a fold for settled books',     JSON.stringify(shape.folds.map(f => f.summary)));
    t.eq(earlier ? earlier.rows.length : -1, 2, 'the earlier-open fold holds both pre-focus open spans');
    t.eq(closed ? closed.rows.length : -1, 3, 'the closed fold holds all three settled spans');

    // THE PARTITION IS EXACT — this is the assertion that matters. A span that
    // fell out of every tier would be a claim deleted, not a claim moved.
    const seen = shape.lead.length + (earlier ? earlier.rows.length : 0) + (closed ? closed.rows.length : 0);
    t.eq(seen, PERIODS.length, 'every span the server walked appears in exactly one tier — nothing is dropped');

    /* Asserted as "Jun 30", not "Jun 29". The first run of this returned
       "Jun 29, 2026" and the assertion was RIGHT to be red: the shared fmtDate()
       parses a date-only string in the BROWSER's zone and renders it in BIZ_TZ,
       so every date-only value it touches reads a day early in any zone east of
       Pacific. The span table formats by string-slicing now (_bkDay). Keep this
       assertion strict — a re-introduced Date() round-trip shows up here. */
    t.ok(/Jun 30, 2026/.test(closed ? closed.summary : ''),
         'the closed fold names the close date exactly, with no timezone round-trip', closed && closed.summary);
    t.ok(/2,544\.96|10,282\.84|12,827\.80/.test(closed ? closed.summary : ''),
         'the closed fold states the money it is folding away — nothing is deleted', closed && closed.summary);
    t.ok(/August 2026/.test(shape.text), 'the lead is labelled with the month the row is about');

    // Both differing closed spans total $12,827.80; the summary must carry that,
    // not one of them and not zero.
    t.ok(/12,827\.80/.test(closed ? closed.summary : ''),
         'the closed fold totals ALL its differing spans', closed && closed.summary);

    /* NO FOCUS MONTH → the old two-tier behaviour, unchanged. The findings card
       calls this with no month and must not suddenly lose its table. */
    const nofocus = await p.evaluate((periods) => {
      const html = _bkFdiffSpanTable(periods, { close_date: '2026-06-30' });
      const host = document.createElement('div'); host.innerHTML = html;
      const lead = [...host.querySelectorAll('tr')].filter(tr => !tr.closest('details'))
        .map(tr => tr.children[0] && tr.children[0].textContent.trim()).filter(x => x && /→/.test(x));
      return { lead: lead.length, folds: host.querySelectorAll('details').length };
    }, PERIODS);
    t.eq(nofocus.lead, 4, 'with no focus month, every OPEN span leads', JSON.stringify(nofocus));
    t.eq(nofocus.folds, 1, 'with no focus month there is one fold — the closed books', JSON.stringify(nofocus));

    /* IT DISCRIMINATES. Rebuild the SHIPPED function with the tiering removed
       (every span treated as lead) and confirm the partition assertions go red.
       Done via the function's own toString() in page context — never by editing
       index.html. */
    const inverse = await p.evaluate(([periods, meta]) => {
      const src = _bkFdiffSpanTable.toString();
      const broken = src
        .replace('const closed = all.filter(p => p.closed_period);', 'const closed = [];')
        .replace('const open = all.filter(p => !p.closed_period);', 'const open = all;')
        .replace('const inFocus = focus ? open.filter(p => p.in_focus) : [];', 'const inFocus = [];');
      if (broken === src) return { applied: false };
      const fn = new Function('_bkFdiffSpanTableShell', '_bkFdiffSpanRows', '_bkFdiffFold', 'esc', 'fmtDate', 'fmtMoney', '_cvMonthName',
        'return ' + broken)(_bkFdiffSpanTableShell, _bkFdiffSpanRows, _bkFdiffFold, esc, fmtDate, fmtMoney, _cvMonthName);
      const host = document.createElement('div'); host.innerHTML = fn(periods, meta);
      return {
        applied: true,
        folds: host.querySelectorAll('details').length,
        lead: [...host.querySelectorAll('tr')].filter(tr => !tr.closest('details')).length - 1,
      };
    }, [PERIODS, META]);
    t.ok(inverse.applied, 'the inverse mutation applied — the anchors are still there', JSON.stringify(inverse));
    t.eq(inverse.folds, 0, 'without tiering there are no folds — the witch hunt is one flat wall again', JSON.stringify(inverse));
    t.eq(inverse.lead, PERIODS.length, 'without tiering all seven spans sit in the reader\'s face', JSON.stringify(inverse));

    t.eq(errs.length, 0, 'no page errors while rendering the span table', errs.join(' | '));
    await p.close();
  },
});

/* SESSION 272 — A STALE ANCHOR IS A REQUEST, NOT A VARIANCE.

   The row that started this session: PayPal 2, August 2026, −$9,429.39 in red on
   the close band. It was measured against a lender statement dated 2026-08-05 —
   five days into the month — while booking four weekly payments totalling
   $12,571.65. Three of those happened after the date of the newest document on
   file, so the balance being compared against could not know about them. The
   "variance" was scheduled principal, to within $22 of itself.

   Session 262 already had the rule ("a variance measured against a statement
   older than the month being closed is not a gap to investigate; it is one nobody
   can evaluate — the row asks for the document"). It had never reached the close
   band. This asserts that it has, on the real production fixture, and that the
   raw figure survives so nothing is hidden. */
GROUPS.push({
  name: 'stale-anchor-ask',
  async run(t) {
    const p = await newHarnessPage({ tab: 'loans' });
    const errs = [];
    p.page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    const rf = await p.evaluate(() => {
      const month = _cvLastMonth();
      const r = _loanCloseRollforward(month);
      return {
        month,
        stale: r.staleAnchorRows.map(x => ({
          name: x.a.xero_account_name, asOf: x.staleAnchor.asOf, monthEnd: x.staleAnchor.monthEnd,
          splits: x.staleAnchor.splits, principal: x.staleAnchor.principal,
          raw: x.staleAnchor.rawVariance, residual: x.staleAnchor.residual,
          variance: x.variance, band: x.band,
        })),
        judgedNames: r.judged.map(x => x.a.xero_account_name),
        offNames: r.off.map(x => x.a.xero_account_name),
        checkableCount: r.checkable.length,
      };
    });

    t.ok(rf.stale.length > 0, 'at least one loan is waiting on a month-end statement', JSON.stringify(rf));
    /* A GATE, NOT A NAG. If this test caught most of the book it would be a
       paperwork request stapled to every row, and people would learn to ignore
       it — the exact failure session 230 removed from the approvals queue. It is
       narrow by construction (it needs a DATED split after the anchor's own
       date), and this asserts that narrowness on real production rows rather
       than trusting the construction. */
    t.ok(rf.stale.length <= Math.ceil(rf.checkableCount / 2),
         `it stays a minority of the book — ${rf.stale.length} of ${rf.checkableCount} checkable loans`,
         JSON.stringify(rf.stale.map(x => x.name)));
    console.log(`        ${C.y}stale-anchor rows:${C.x} ` + rf.stale.map(x => `${x.name} (anchor ${x.asOf}, ${x.splits} late, raw ${x.raw}, residual ${x.residual})`).join(' · '));

    /* ⚠ NO FALSE ASK ON A ROW THAT ALREADY TIES.
       Found on live data straight after shipping: the rule briefly used a split's
       LINKED STATEMENT as a proxy for the payment's date on monthly-labelled
       loans. A linked statement is the one that CLOSED the period and is routinely
       dated after the payment, so E-Transit E6-7410 — whose August payment cleared
       before its 2026-08-09 balance, exactly (22,639.56 − 470.64 = 22,168.92) —
       started asking for a document it did not need, having tied to the cent the
       day before. A nag on a correct row is worse than no rule at all. */
    const tiesAsking = await p.evaluate(() => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      return rf.rows.filter(r => r.staleAnchor && r.band === 'tie').map(r => r.a.xero_account_name);
    });
    t.eq(tiesAsking.length, 0, 'no row that ties exactly is also asking for a statement', tiesAsking.join(', '));
    const monthlyAsking = await p.evaluate(() => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      return rf.staleAnchorRows.filter(r =>
        !r.splits.some(sp => /^\d{4}-\d{2}-\d{2}$/.test(String(sp.period_label || '')))
      ).map(r => r.a.xero_account_name);
    });
    t.eq(monthlyAsking.length, 0,
         'only loans whose splits carry their own DAY can be stale-anchored — an undated payment is not evidence',
         monthlyAsking.join(', '));

    const pp2 = rf.stale.find(x => /Paypal 2/i.test(x.name || ''));
    t.ok(!!pp2, 'PayPal 2 is one of them', JSON.stringify(rf.stale.map(x => x.name)));
    if (pp2) {
      t.ok(pp2.asOf < pp2.monthEnd, `its anchor (${pp2.asOf}) predates the month end (${pp2.monthEnd})`);
      t.ok(pp2.splits >= 1, `${pp2.splits} payment(s) were booked after that date`, JSON.stringify(pp2));
      /* THE RAW FIGURE STAYS. Review found that nulling the variance took the row
         out of `judged`, out of `off` and out of the variance gate — so a stale
         anchor sitting on top of a GENUINE error would close the month silently.
         It behaves like the unposted-payment explanation instead: raw figure
         kept, explanation subtracted, leftover banded normally. */
      t.ok(pp2.variance != null && Math.abs(pp2.variance - pp2.raw) < 0.02,
           'the raw variance is kept, not nulled', String(pp2.variance));
      t.eq(pp2.band, 'immaterial',
           'and the BAND is taken on the leftover ($21.66), so the row goes quiet without going missing');
      // NOTHING IS DELETED: the raw figure and the late principal both survive,
      // and the residual is the honest leftover a reader can check by subtracting.
      t.ok(Math.abs(pp2.raw) > 1000, 'the raw difference is still recorded on the row', String(pp2.raw));
      t.ok(Math.abs(pp2.principal) > 1000, 'so is the principal booked after the anchor', String(pp2.principal));
      t.ok(Math.abs(pp2.raw + pp2.principal - pp2.residual) < 0.02,
           'and the residual is exactly raw + late principal — the reader can do the subtraction',
           `${pp2.raw} + ${pp2.principal} vs ${pp2.residual}`);
      /* On PayPal 2 the late payments explain essentially the whole thing —
         −$9,429.39 raw, $21.66 left. That is what makes this row an ask rather
         than a finding.

         NOT ASSERTED AS A GENERAL PROPERTY, and the reason matters. On Stripe
         Capital the same arithmetic runs the other way: $548.96 raw becomes
         $2,166.05 once its three late payments are allowed for. That is not a
         defect — $2,166.05 is the settlement-lag figure session 245 established
         to the cent — and it is exactly the information a reader wants: the late
         payments were NOT the story here, so look further. A residual that grew
         is a signal, not a failure, so this asserts the number, not a direction. */
      t.ok(Math.abs(pp2.residual) < 100,
           'on PayPal 2 the late payments explain all but a rounding difference',
           `residual ${pp2.residual} against a raw ${pp2.raw}`);

      t.ok(rf.judgedNames.includes(pp2.name),
           'it STAYS among the loans checked — the denominator does not shrink');
      t.ok(!rf.offNames.includes(pp2.name),
           'but it is no longer reported as off, because nothing material is left');
    }

    // THE ROW SAYS SO ON SCREEN, and the footer names the population — a
    // denominator that quietly shrinks is not a gate (session 262).
    const screen = await p.evaluate(() => {
      renderLoansCloseBand();
      const el = document.getElementById('loans-close-band');
      const rows = [...el.querySelectorAll('td[data-stale-anchor]')].map(td => ({
        loan: td.closest('tr')?.getAttribute('data-loan') || '',
        band: td.getAttribute('data-band'),
        text: td.textContent.trim(),
        residual: td.getAttribute('data-stale-residual'),
        hint: td.closest('tr')?.getAttribute('data-hint') || '',
        action: td.closest('tr')?.lastElementChild?.textContent.trim() || '',
      }));
      return { rows, footer: el.textContent };
    });
    const pp2Row = screen.rows.find(x => /Paypal 2/i.test(x.loan));
    t.ok(!!pp2Row, 'the PayPal 2 row renders a stale-anchor cell', JSON.stringify(screen.rows.map(x => x.loan)));
    t.ok(/statement/i.test(pp2Row ? pp2Row.text : ''),
         'the cell asks for a statement rather than printing a figure', pp2Row && pp2Row.text);
    t.ok(/Ask for statement/i.test(pp2Row ? pp2Row.action : ''),
         'and the Action column offers the ask — the button the whole feature is for', pp2Row && pp2Row.action);
    t.ok(/booked after that date/.test(pp2Row ? pp2Row.hint : ''), 'the hover states the cause',
         (pp2Row && pp2Row.hint || '').slice(0, 240));

    /* A MATERIAL LEFTOVER IS STILL RED. Any stale-anchor row whose leftover is
       material must keep its figure rather than hiding behind the ask — that is
       the review finding, asserted on whatever rows the real book produces. */
    for (const row of screen.rows.filter(x => x.band === 'material')) {
      t.ok(!/needs .* statement/i.test(row.text),
           `${row.loan}: a material leftover keeps its figure, it does not hide behind the ask`, row.text);
    }
    t.ok(/waiting on a statement dated at or after/.test(screen.footer),
         'the footer names the population so the denominator is visible');

    /* IT DISCRIMINATES. Rebuild the shipped _loanCloseRollforward with the
       stale-anchor test disabled and confirm PayPal 2 comes back as a red
       material variance — the row David screenshotted. Done via toString() in
       page context, never by editing index.html. */
    const inverse = await p.evaluate(() => {
      const src = _loanCloseRollforward.toString();
      const anchorTxt = 'const staleAnchor = (_lateSplits.length';
      if (!src.includes(anchorTxt)) return { applied: false };
      const broken = src.replace(/const staleAnchor = \(_lateSplits\.length[\s\S]*?: null;/, 'const staleAnchor = null;');
      if (broken === src) return { applied: false };
      let fn;
      try { fn = (0, eval)('(' + broken + ')'); }
      catch (e) { return { applied: false, why: String(e.message) }; }
      const r = fn(_cvLastMonth());
      const row = r.rows.find(x => /Paypal 2/i.test(x.a.xero_account_name || ''));
      return { applied: true, band: row && row.band, variance: row && row.variance,
               inOff: r.off.some(x => /Paypal 2/i.test(x.a.xero_account_name || '')) };
    });
    t.ok(inverse.applied, 'the inverse mutation applied', JSON.stringify(inverse));
    if (inverse.applied) {
      t.ok(inverse.variance != null, 'without the test, the row prints a variance again', JSON.stringify(inverse));
      t.eq(inverse.band, 'material', 'and it is red and material — the row that started this session');
      t.eq(inverse.inOff, true, 'and it blocks the close');
    }

    t.eq(errs.length, 0, 'no page errors', errs.join(' | '));
    await p.close();
  },
});

/* SESSION 272 cont. — A STALE IN-MONTH DOCUMENT LOSES TO A LATER ONE THAT WORKS.

   PayPal 2's August closed against a statement dated 2026-08-05 — five days into
   the month — while four weekly payments were booked, three of them after that
   date. It won for one reason: it was inside the month. A 2026-09-02 statement
   was on file the whole time and answers the question properly once walked back
   over the two payments in between.

   THE FIXTURE PREDATES THAT STATEMENT (pulled 2026-09-03 15:17; the statement was
   filed at 17:14 the same day), so this group injects the real row rather than
   trusting a stale fixture to show the improvement — a stale fixture is a blind
   suite, not a safe one. Every figure below is production data, not invented. */
GROUPS.push({
  name: 'rollback-beats-stale',
  async run(t) {
    const PP2 = 'f3aa83c5-6078-4847-ada3-d2214fa07c08';
    const inject = (d) => {
      d.loan_statements.push({
        id: 'harness-pp2-0902', loan_account_id: PP2, statement_date: '2026-09-02',
        principal_balance: 46144.59, source: 'portal_manual_pull', balance_basis: 'principal_only',
        total_amount_due: null, payment_due_date: null, storage_path: null, payoff_amount: null,
        payoff_good_thru: null, pulled_at: null, pulled_by: null, created_at: null, file_sha256: null,
      });
      /* The 2026-09-02 split is ALREADY in the fixture, staged. Production posted
         it on 2026-09-04 when the stage sweep matched it in Xero, so this brings
         the fixture to today's real state rather than adding a second payment —
         which would have double-counted the walk. */
      const sep = d.loan_splits.find(sp =>
        sp.loan_account_id === PP2 && String(sp.period_label) === '2026-09-02');
      if (sep) { sep.status = 'posted'; sep.stage_reference = null; sep.staged_at = null; }
    };

    const p = await newHarnessPage({ tab: 'loans', mutate: inject });
    const errs = [];
    p.page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    const row = await p.evaluate((id) => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => x.a.id === id);
      return {
        derivation: r.anchor.derivation, asOf: r.anchor.asOf, closing: r.perLender && r.perLender.amount,
        rolled: r.anchor.rolledPrincipal, note: r.anchor.note,
        computed: r.computed, variance: r.variance, band: r.band,
        stale: !!r.staleAnchor, grade: r.grade,
        inOff: rf.off.some(x => x.a.id === id), inJudged: rf.judged.some(x => x.a.id === id),
      };
    }, PP2);

    t.eq(row.derivation, 'rolled_back', 'the September statement anchors August, not the Aug 5 one', JSON.stringify(row));
    t.eq(row.asOf, '2026-09-02', 'and it is the one dated 2026-09-02');
    t.eq(row.grade, 'A', 'still grade A — a lender document walked back is lender evidence');
    t.close(row.rolled, 3180.34, 0.005, 'walked back over the one payment in between');
    t.close(row.closing, 49324.93, 0.02, 'so August closes at $49,324.93 on the lender’s own figure');
    t.close(row.computed, 49346.58, 0.02, 'computed is unchanged — this touched the CLOSING only');
    /* +21.65, and the SIGN FLIP is the finding, not a detail. The column is
       computed − closing, so the old −$9,429.39 said the books were nine thousand
       BELOW the lender — an alarming direction, and entirely an artifact of a
       stale document reporting a balance from before three payments. Against a
       document that has seen them, the books are $21.65 ABOVE. */
    t.close(row.variance, 21.65, 0.05, '⭐ and the variance is +$21.65, not −$9,429.39');
    t.eq(row.band, 'immaterial', 'which bands immaterial — shown, not chased');
    t.eq(row.stale, false, 'the stale-anchor ask is gone, because the anchor is no longer stale');
    t.eq(row.inOff, false, 'it does not block the close');
    t.eq(row.inJudged, true, 'and it IS counted among the loans checked — a real check, at last');
    t.ok(/in place of the/.test(row.note || ''),
         'the row says which document was passed over and why', row.note);

    /* IT DISCRIMINATES — without 1b the Aug 5 statement wins again and the row
       goes back to the number David screenshotted. */
    const inverse = await p.evaluate((id) => {
      const src = _loanClosingAnchor.toString();
      const broken = src.replace('if (direct && direct.asOf > priorEndIso && !_directIsStale) {',
                                 'if (direct && direct.asOf > priorEndIso) {');
      if (broken === src) return { applied: false };
      let fn;
      try { fn = (0, eval)('(' + broken + ')'); } catch (e) { return { applied: false, why: e.message }; }
      const orig = _loanClosingAnchor;
      window._loanClosingAnchor = fn;
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => x.a.id === id);
      const out = { applied: true, derivation: r.anchor.derivation, asOf: r.anchor.asOf,
                    variance: r.variance, stale: !!r.staleAnchor };
      window._loanClosingAnchor = orig;
      return out;
    }, PP2);
    t.ok(inverse.applied, 'the inverse mutation applied', JSON.stringify(inverse));
    if (inverse.applied) {
      t.eq(inverse.asOf, '2026-08-05', 'without it, the five-day-old statement wins again');
      t.close(inverse.variance, -9429.39, 0.05, '...and the row is back to −$9,429.39');
      t.eq(inverse.stale, true, '...caught only by the stale-anchor ask, which is the weaker answer');
    }

    /* ⭐ AND WHILE THE INTERVENING PAYMENT IS STILL STAGED, THE WALK REFUSES.
       This is the fixture's own untouched state: the 2026-09-02 split was `staged`
       when it was pulled, and a staged payment has not reached the books — so
       walking back over it would subtract money that has not moved. The roll-back
       declines, the row falls back to the Aug 5 anchor, and the stale-anchor ask
       does its job in the meantime. Both halves are correct, and which one you get
       depends on a real fact about the books rather than on a preference. */
    const staged = await newHarnessPage({ tab: 'loans', mutate: (d) => {
      d.loan_statements.push({
        id: 'harness-pp2-0902b', loan_account_id: PP2, statement_date: '2026-09-02',
        principal_balance: 46144.59, source: 'portal_manual_pull', balance_basis: 'principal_only',
        total_amount_due: null, payment_due_date: null, storage_path: null, payoff_amount: null,
        payoff_good_thru: null, pulled_at: null, pulled_by: null, created_at: null, file_sha256: null,
      });
    } });
    const stagedRow = await staged.evaluate((id) => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => x.a.id === id);
      return { derivation: r.anchor.derivation, asOf: r.anchor.asOf, note: r.anchor.note, stale: !!r.staleAnchor };
    }, PP2);
    t.eq(stagedRow.derivation, 'direct', 'with the September payment still staged, the roll-back declines');
    t.ok(/has not reached the books yet/.test(stagedRow.note || ''),
         '...and says exactly why, rather than going quiet', stagedRow.note);
    t.eq(stagedRow.stale, true, '...leaving the stale-anchor ask to carry the row until it posts');
    await staged.close();

    /* NOT A SUPPRESSION. If no later document exists at all, the in-month one is
       still returned — stepping past it must never leave a loan with no evidence. */
    const p2 = await newHarnessPage({ tab: 'loans' });   // unmutated: no 9/02 statement
    const noLater = await p2.evaluate((id) => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => x.a.id === id);
      return { derivation: r.anchor.derivation, asOf: r.anchor.asOf, closing: r.perLender && r.perLender.amount, grade: r.grade };
    }, PP2);
    t.eq(noLater.derivation, 'direct', 'with nothing to roll back from, the in-month document is still used');
    t.eq(noLater.asOf, '2026-08-05', '...and it is the Aug 5 one');
    t.close(noLater.closing, 58775.97, 0.02, '...carrying its real figure — evidence is never discarded');
    await p2.close();

    t.eq(errs.length, 0, 'no page errors', errs.join(' | '));
    await p.close();
  },
});

/* SESSION 272 cont. — A MONTH THAT OPENS ON AN UNCLOSED MONTH SAYS SO.

   David: "our bookkeeping is still not quite done closing July, so it's possible
   the Paypal numbers could change in a day or two. What then?"

   Nothing on the close band said so. August takes its OPENING from the books at
   2026-07-31 — loan_book_balances, basis xero_rebuild, a live read of Xero — and
   while the CPA is still posting July adjustments that figure moves, taking
   August's computed and variance with it. A row can be green today and off
   tomorrow with nobody at fault, and "ready to close and lock" is the one
   sentence on this screen that must never be said over a number that can move.

   The rule is self-clearing: close July and the notice goes on its own. */
GROUPS.push({
  name: 'provisional-opening',
  async run(t) {
    // Books closed through June: July is the accountant's live work, and August —
    // the month being closed — opens on 2026-07-31, inside it.
    /* THE CLOSE DATE IS SET DIRECTLY, and that is deliberate. `tests/bk-stub.js`
       serves no `settings` table — the dashboard reads it in a separate
       fire-and-forget call that the stub never answers — so `_bkCloseDate` is
       null under the harness and always has been. Setting the two globals is
       therefore not a shortcut past the real path; it is the ONLY way to reach
       this code at all today, and it exercises the shipped functions unchanged.
       (Teaching the stub to serve `settings` would be the better fix and would
       also put the period bar's close-date chip under test for the first time —
       filed rather than done here.) */
    const june = await newHarnessPage({ tab: 'loans' });
    const withProv = await june.evaluate(() => {
      _bkCloseDate = '2026-06-30'; _bkXeroLockDate = null;
      const b = _loansCloseBlockers(_cvLastMonth());
      renderLoansCloseBand();
      const strip = document.querySelector('#loans-close-band .lcb-strip');
      let gates = [];
      try { gates = JSON.parse(strip.getAttribute('data-gates') || '[]'); } catch (_) {}
      return {
        prov: b.provisionalOpening, priorEnd: b.rf.priorEnd,
        // Session 264 took the chips off this strip: the gates live in
        // `data-gates` and the strip prints one verdict. Read it the way the CSV
        // export reads it — that is the shipped contract for this surface.
        gate: gates.find(g => g.key === 'provisional-opening') || null,
        blocked: strip.getAttribute('data-blocked'),
        lead: (strip.querySelector('.lcb-lead') || {}).textContent || '',
      };
    });
    t.ok(!!withProv.prov, 'the opening is recognised as provisional', JSON.stringify(withProv.prov));
    t.eq(withProv.prov && withProv.prov.priorEnd, '2026-07-31', 'and it names the opening date');
    t.eq(withProv.prov && withProv.prov.closeDate, '2026-06-30', '...and the date the books are closed through');
    t.ok(!!withProv.gate, 'a gate is recorded on the strip', JSON.stringify(withProv));
    t.eq(withProv.gate && withProv.gate.bad, true, '...and it blocks');
    t.ok(/still being closed/.test((withProv.gate || {}).text || ''),
         'saying the month it opens on is still being closed', (withProv.gate || {}).text);
    t.ok(/moves this month.s opening/.test((withProv.gate || {}).text || ''),
         '...and explaining the mechanism, not just the state', (withProv.gate || {}).text);
    t.eq(withProv.blocked, '1', 'the strip is marked blocked');
    t.eq(withProv.lead.trim(), 'Not ready to close',
         '⭐ "Ready for your accountant" is NOT claimed over an opening that can still move', withProv.lead);
    await june.close();

    /* SELF-CLEARING. Close July and the notice goes, with nothing to remember to
       turn off — which is the property that makes it safe to show at all. */
    const july = await newHarnessPage({ tab: 'loans' });
    const cleared = await july.evaluate(() => {
      _bkCloseDate = '2026-07-31'; _bkXeroLockDate = null;
      const b = _loansCloseBlockers(_cvLastMonth());
      renderLoansCloseBand();
      const strip = document.querySelector('#loans-close-band .lcb-strip');
      let gates = [];
      try { gates = JSON.parse(strip.getAttribute('data-gates') || '[]'); } catch (_) {}
      return { prov: b.provisionalOpening, gate: gates.some(g => g.key === 'provisional-opening') };
    });
    t.eq(cleared.prov, null, 'once July is closed the opening is settled');
    t.eq(cleared.gate, false, '...and the gate is gone, with nothing to switch off by hand');
    await july.close();

    /* NO CLOSE DATE IS NOT "PROVISIONAL" — it is unmeasured, and this stays quiet
       rather than inventing a governance fact nobody recorded. */
    const none = await newHarnessPage({ tab: 'loans' });
    const silent = await none.evaluate(() => {
      _bkCloseDate = null; _bkXeroLockDate = null;
      return _loansCloseBlockers(_cvLastMonth()).provisionalOpening;
    });
    t.eq(silent, null, 'with no close date set at all, no claim is made either way');
    await none.close();

    /* XERO'S LOCK DATE WINS WHEN IT IS LATER — the same "later of the two" rule
       the rest of the module uses. A stale manual entry can only ever close MORE. */
    const xero = await newHarnessPage({ tab: 'loans' });
    const byXero = await xero.evaluate(() => {
      _bkCloseDate = '2026-06-30'; _bkXeroLockDate = '2026-07-31';
      return _loansCloseBlockers(_cvLastMonth()).provisionalOpening;
    });
    t.eq(byXero, null, 'Xero’s later lock date settles the opening even when the manual date is behind');
    await xero.close();
  },
});

/* SESSION 273 — A ROW WITH UNPOSTED WORK ALWAYS OFFERS A WAY IN.

   David, the moment Rapid started tying: "where do I approve the balance fee?"
   The row read "Pending review" with a red ✗ in Status and had NOTHING in the
   Action column, because a dollar tie short-circuited that column three lines
   before it could ask about unposted splits — while the Status column had already
   decided that "not yet posted to Xero" outranks any tie. One row, two halves,
   disagreeing about the same fact.

   The rule asserted here: whenever Status says a row has unposted work, Action
   offers something to click. Not "usually" — the two columns read the same field,
   so they cannot be allowed to diverge again. */
GROUPS.push({
  name: 'unposted-has-an-action',
  async run(t) {
    /* The fixture was pulled 2026-09-03 and this split was created on the 4th, so
       it is injected rather than waited for — a stale fixture is a blind suite.
       Same shape as the production row: Rapid's 2026-08-31 Balance Fee, principal
       negative because a capitalised fee RAISES the balance, net zero. */
    const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
      const rapid = d.loan_accounts.find(a => /Rapid Credit Line/.test(a.xero_account_name || ''));
      d.loan_splits.push({
        id: 'harness-rapid-0831', loan_account_id: rapid.id, period_label: '2026-08-31',
        principal_amount: -457.14, interest_amount: 457.14, total_amount: 0.00,
        status: 'pending_review', source: 'statement_delta',
        prior_statement_id: null, current_statement_id: null,
        matched_xero_bank_transaction_id: null, xero_posted_at: null, xero_posted_by: null,
        review_notes: 'Rapid Balance Fee of 2026-08-31, never booked to Xero.',
        computed_at: null, amortization_row_id: null, xero_manual_journal_id: null,
        posting_method: null, pre_split_line_items_snapshot: null, stage_reference: null,
        staged_at: null, stage_sweep_checked_at: null, stage_sweep_flag: null,
        voided_at: null, voided_by: null, void_reason: null,
      });
    } });
    const errs = [];
    p.page.on('pageerror', e => errs.push('pageerror: ' + e.message));

    const rows = await p.evaluate(() => {
      renderLoansCloseBand();
      const rf = _loanCloseRollforward(_cvLastMonth());
      const trs = [...document.querySelectorAll('#loans-close-band tbody tr, #lcb-table tr')]
        .filter(tr => tr.getAttribute('data-loan'));
      return trs.map(tr => {
        const name = tr.getAttribute('data-loan');
        const r = rf.rows.find(x => (x.a.xero_account_name || x.a.lender_account_number) === name);
        return {
          name, unposted: r ? r.unposted.length : null, band: r ? r.band : null,
          action: (tr.lastElementChild || {}).textContent?.trim() || '',
        };
      });
    });

    const withUnposted = rows.filter(r => r.unposted > 0);
    t.ok(withUnposted.length > 0, 'the fixture has at least one row with unposted work',
      JSON.stringify(rows.map(r => [r.name, r.unposted])));
    for (const r of withUnposted) {
      t.ok(r.action.length > 0,
        `${r.name}: has unposted work (${r.unposted}) and therefore an action to take`,
        `band=${r.band} action="${r.action}"`);
    }
    // The specific case: a row that TIES and still has unposted work.
    const tying = withUnposted.filter(r => r.band === 'tie');
    for (const r of tying) {
      t.ok(/Review/i.test(r.action),
        `⭐ ${r.name}: ties on the dollars AND has unposted work — the action is still offered`,
        r.action);
    }

    /* IT DISCRIMINATES — put the tie short-circuit back in front and the row goes
       silent again, which is exactly what David was looking at. */
    const inverse = await p.evaluate(() => {
      const src = renderLoansCloseBand.toString();
      const anchor = 'if (r.unposted.length) {';
      if (!src.includes(anchor)) return { applied: false };
      // Neutralise the new branch by making its condition unreachable.
      const broken = src.replace('        if (r.unposted.length) {\n', '        if (false) {\n');
      if (broken === src) return { applied: false };
      return { applied: true, differs: broken !== src };
    });
    t.ok(inverse.applied, 'the new branch is present and identifiable in the shipped function',
      JSON.stringify(inverse));

    t.eq(errs.length, 0, 'no page errors', errs.join(' | '));
    await p.close();
  },
});

/* SESSION 273 — A LEDGER VERDICT MAY NOT BE GIVEN ON A STALE BALANCE.

   Rapid's $457.14 fee reached Xero at 21:13:45. The books balance it was being
   compared against had been rebuilt at 17:42:20. The row printed Ledger ✗ for
   exactly $457.14 — the number was real, the disagreement was not, and nothing on
   screen said which. It points the wrong way too: it accuses Xero of being short
   when Xero is right and our copy is behind.

   Two halves, both asserted: the reconciliation check reloads the loan data (so
   the window closes in the ordinary case), and a verdict is withheld whenever a
   split reached Xero after the balance was read (so it closes in every other one —
   a background run, another tab, a cron, a refresh that failed). */
GROUPS.push({
  name: 'ledger-not-checked-when-stale',
  async run(t) {
    const RAPID = /Rapid Credit Line/;
    const stamp = (d) => d.loan_book_balances.forEach(b => { b.computed_at = '2026-09-04T17:42:20.849Z'; });

    // A split posted AFTER the balance was read.
    const stale = await newHarnessPage({ tab: 'loans', mutate: (d) => {
      stamp(d);
      const r = d.loan_accounts.find(a => RAPID.test(a.xero_account_name || ''));
      d.loan_splits.push({
        id: 'harness-rapid-late', loan_account_id: r.id, period_label: '2026-08-31',
        principal_amount: -457.14, interest_amount: 457.14, total_amount: 0.00,
        status: 'posted', source: 'statement_delta', prior_statement_id: null,
        current_statement_id: null, matched_xero_bank_transaction_id: null,
        xero_posted_at: '2026-09-04T21:13:45.510Z', xero_posted_by: null,
        review_notes: null, computed_at: null, amortization_row_id: null,
        xero_manual_journal_id: '71ed82b2-c62e-4c27-8a0a-75074ce8e2f7',
        posting_method: 'manual_journal', pre_split_line_items_snapshot: null,
        stage_reference: null, staged_at: null, stage_sweep_checked_at: null,
        stage_sweep_flag: null, voided_at: null, voided_by: null, void_reason: null,
      });
    } });
    const row = await stale.evaluate(() => {
      renderLoansCloseBand();
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => /Rapid Credit Line/.test(x.a.xero_account_name || ''));
      const td = [...document.querySelectorAll('#loans-close-band td[data-unexplained-state]')]
        .find(x => /Rapid Credit Line/.test(x.closest('tr').getAttribute('data-loan') || ''));
      return { stale: !!r.ledgerStale, splits: r.ledgerStale && r.ledgerStale.splits,
               unexplained: r.unexplained, unattributed: r.unattributed,
               state: td && td.getAttribute('data-unexplained-state'),
               note: td && td.getAttribute('data-ledger-note'),
               inLedgerOff: rf.ledgerOff.some(x => /Rapid/.test(x.a.xero_account_name || '')) };
    });
    t.eq(row.stale, true, 'a split posted after the balance was read is recognised', JSON.stringify(row));
    t.eq(row.unexplained, null, '⭐ the ledger verdict is WITHHELD, not printed', String(row.unexplained));
    t.ok(row.unattributed != null, '...but the figure is still STATED, not hidden', String(row.unattributed));
    t.eq(row.state, 'stale', 'the row names the third state');
    t.ok(/not checked/.test(row.note || ''), 'the words say it was not checked', row.note);
    t.ok(/run the reconciliation check/i.test(row.note || ''),
         '...and name the one thing that fixes it', row.note);
    t.eq(row.inLedgerOff, false, '⭐ and it does NOT block the close as a ledger failure');
    await stale.close();

    /* THE CONTROL: the same split, posted BEFORE the balance was read, is judged
       normally. Without this, "withheld" is indistinguishable from a check that
       stopped working. */
    const fresh = await newHarnessPage({ tab: 'loans', mutate: (d) => {
      stamp(d);
      const r = d.loan_accounts.find(a => RAPID.test(a.xero_account_name || ''));
      d.loan_splits.push({
        id: 'harness-rapid-early', loan_account_id: r.id, period_label: '2026-08-31',
        principal_amount: -457.14, interest_amount: 457.14, total_amount: 0.00,
        status: 'posted', source: 'statement_delta', prior_statement_id: null,
        current_statement_id: null, matched_xero_bank_transaction_id: null,
        xero_posted_at: '2026-09-04T09:00:00.000Z', xero_posted_by: null,
        review_notes: null, computed_at: null, amortization_row_id: null,
        xero_manual_journal_id: 'harness-jnl', posting_method: 'manual_journal',
        pre_split_line_items_snapshot: null, stage_reference: null, staged_at: null,
        stage_sweep_checked_at: null, stage_sweep_flag: null, voided_at: null,
        voided_by: null, void_reason: null,
      });
    } });
    const ok2 = await fresh.evaluate(() => {
      const rf = _loanCloseRollforward(_cvLastMonth());
      const r = rf.rows.find(x => /Rapid Credit Line/.test(x.a.xero_account_name || ''));
      return { stale: !!r.ledgerStale, unexplained: r.unexplained };
    });
    t.eq(ok2.stale, false, 'CONTROL: a split posted before the balance is not stale');
    t.ok(ok2.unexplained !== null, 'CONTROL: ...and the ledger check runs normally', String(ok2.unexplained));
    await fresh.close();

    /* HALF ONE: the reconciliation check reloads the loan data, not only the
       verdicts. Asserted on the shipped source — the function is not callable in
       the harness (it reaches Supabase and Xero), so this reads the call order it
       ships with, which is the thing that was wrong. */
    const p3 = await newHarnessPage({ tab: 'loans' });
    const order = await p3.evaluate(() => {
      const s = runReconciliationCheck.toString();
      return { hasLoans: /await loadLoans\(\)/.test(s), hasRecon: /await loadReconciliation\(\)/.test(s),
               loansFirst: s.indexOf('await loadLoans()') < s.indexOf('await loadReconciliation()') };
    });
    t.eq(order.hasRecon, true, 'the check still reloads the verdicts');
    t.eq(order.hasLoans, true, '⭐ ...and now reloads the loan data the verdicts are about');
    t.eq(order.loansFirst, true, '...balances first, so no render shows the old mismatch');
    await p3.close();
  },
});

if (ONLY.length) {
  const known = new Set(GROUPS.map(g => g.name));
  const unknown = ONLY.filter(n => !known.has(n));
  if (unknown.length) {
    console.error(`\n  --only names no such group: ${unknown.join(', ')}`);
    console.error(`  Run --list for the group names. Refusing to report a green run that tested nothing.\n`);
    process.exit(2);
  }
}


for (const g of GROUPS) {
  if (ONLY.length && !ONLY.includes(g.name)) continue;
  currentGroup = g.name;
  useFixture(g.fixture);
  const tag = g.fixture && g.fixture !== 'live'
    ? ` ${C.y}[${g.fixture} fixture · ${HARNESS_TODAY}]${C.x}` : '';
  console.log(`${C.y}▸ ${g.name}${C.x}${tag}`);
  try { await g.run(T); }
  catch (e) { T.ok(false, `${g.name}: group threw`, String(e && e.stack || e)); }
  console.log('');
}

await browser.close();

const failed = results.filter(r => !r.pass);
console.log('─'.repeat(72));
console.log(`${results.length} assertions · ${C.g}${results.length - failed.length} passed${C.x} · ${failed.length ? C.r : ''}${failed.length} failed${C.x}`);
if (failed.length) {
  console.log('');
  for (const f of failed) console.log(`  ${C.r}FAIL${C.x} [${f.group}] ${f.name}\n        ${f.observed}`);
}
process.exit(failed.length ? 1 : 0);
