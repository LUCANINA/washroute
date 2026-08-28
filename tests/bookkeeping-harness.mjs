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
const ONLY    = (argv.find(a => a.startsWith('--only=')) || '').slice(7);
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
  // Empty in production until reconciliation-run starts writing it, and that is
  // exactly why it is registered: an unregistered table serves [] silently, so
  // a grade-B test would exercise only the no-books-balance fallback and pass
  // while the real path was never reached. Registered, a missing key is a
  // startup failure instead of a green test that proved nothing.
  'loan_book_balances',
];

const baseFixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
for (const t of FIXTURE_TABLES) {
  if (!Array.isArray(baseFixture[t])) throw new Error(`fixture is missing table array: ${t}`);
}
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
    const rows = [...cb.querySelectorAll('tbody tr')].map(tr => {
      const tds = [...tr.children];
      const c = tds.map(td => td.textContent.replace(/\s+/g, ' ').trim());
      return { loan: c[0], opening: c[1], principal: c[2], interest: c[3],
               computed: c[4], perLender: c[5], variance: c[6], inXero: c[7],
               openingN: num(tds[1]), principalN: num(tds[2]), interestN: num(tds[3]),
               computedN: num(tds[4]), perLenderN: num(tds[5]),
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
               closingGrade: att(tds[5], 'data-grade'),
               derivation: att(tds[5], 'data-derivation'),
               note: att(tds[5], 'data-note'),
               band: att(tds[6], 'data-band') || null,
               // A circular row carries data-circular on the variance cell and
               // deliberately NO data-tie. Reading them separately is the whole
               // point: "agrees by construction" must never be counted as a tie.
               varianceCircular: tds[6] ? tds[6].hasAttribute('data-circular') : false,
               // The fourth band (review F3). A variance fully accounted for by
               // money the month deliberately left out — a staged split, or one
               // undated payment — carries its explained principal here. It is
               // shown, never blocking, and owned by the posting gate.
               unbookedN: numA(tds[6], 'data-unbooked'),
               ties: tds[6] ? tds[6].hasAttribute('data-tie') : false,
               varianceN: tds[6] && tds[6].getAttribute('data-variance')
                 ? Number(tds[6].getAttribute('data-variance')) : (tds[6] && tds[6].hasAttribute('data-tie') ? 0 : null) };
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
        openingN: num(tds[1]), principalN: num(tds[2]), interestN: num(tds[3]),
        computedN: num(tds[4]), perLenderN: num(tds[5]),
        varianceN: numA(tds[6], 'data-variance'),
        material: numA(tds[6], 'data-material'),
        // Review F14: an EMPTY subtotal must not exist at all, and must never
        // carry data-tie. A $0.00 "tie" over zero loans is a claim nobody
        // earned, printed in the one column a reader scans for verdicts.
        ties: tds[6] ? tds[6].hasAttribute('data-tie') : false,
        automatic: numA(tr, 'data-automatic'),
      };
    };
    const subtotals = {};
    footTr.forEach(tr => { const k = att(tr, 'data-subtotal'); if (k) subtotals[k] = subtotalOf(tr); });
    // gates[] is NOT index-stable: three of the six chips render only when they
    // are non-zero, so gates[1] means a different thing on different months.
    // Every chip carries data-gate; index nothing, look up by name.
    const gates = [...cb.querySelectorAll('.lcb-gate')].map(g => ({
      key: att(g, 'data-gate'),
      count: numA(g, 'data-count'),
      text: g.textContent.replace(/\s+/g, ' ').trim(),
      ok: g.classList.contains('ok'),
    }));
    const gateByKey = {};
    gates.forEach(g => { if (g.key) gateByKey[g.key] = g; });
    closeBand = {
      head: txt('#loans-close-band .lcb-head h3'),
      lead: txt('#loans-close-band .lcb-lead'),
      gates, gateByKey,
      headers: [...cb.querySelectorAll('thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim()),
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
const GATE_KEYS = ['coverage', 'lender-confirmed', 'per-schedule', 'variance', 'immaterial', 'posting'];

/* ── phrases that claim "everything is fine" ──────────────────────────────── */
const ALL_CLEAR = /(Everything is reconciled|nothing needs you right now|ready for your accountant|all \d+ statements in|Nothing outstanding|nothing needs doing|you're all caught up|no issues found)/i;
const CONFIDENT_ZERO = /\$0(?:\.00)?\b/;

/* ═══════════════════════════ SCENARIO GROUPS ═════════════════════════════ */
const GROUPS = [];

/* Every table the Bookkeeping page reads on boot. 16 now: session 246 added
   loan_book_balances to loadLoans()'s Promise.all. Anything not in here answers
   instantly, which quietly un-parks a loader a cold-boot scenario claims is
   parked. */
const COLD_TABLES = [
  'loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
  'loan_book_balances',
  'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
  'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
  'bk_issue_dismissals', 'bookkeeping_kpi_snapshots',
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

/* 3 ── TAB-SWITCH RACES ──────────────────────────────────────────────────── */
GROUPS.push({
  name: 'tab-races',
  async run(t) {
    // Baseline: land on each tab cleanly and record every number.
    const baseline = {};
    for (const [tab, sub] of [['overview', null], ['loans', null], ['payroll', null], ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis']]) {
      const p = await newHarnessPage({ tab, sub });
      baseline[tab + (sub ? '/' + sub : '')] = await p.surfaces();
      await p.close();
    }

    // Race: boot cold on Overview with the loaders parked, flip through every
    // tab while they are in flight, land back on each one, then release.
    const ALL = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows',
                 'payroll_imports', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
                 'bk_issue_dismissals', 'bookkeeping_kpi_snapshots'];
    for (const [tab, sub] of [['overview', null], ['loans', null], ['payroll', null], ['client', 'dashboard'], ['client', 'debt'], ['client', 'kpis']]) {
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
    const cell = (k, i) => (sub[k] && sub[k].cells[i] != null ? parseMoney(sub[k].cells[i]) : 0) || 0;
    t.ok(!!sub.A, 'close band footer carries a grade-A (lender-confirmed) subtotal, addressed by data-subtotal',
         `subtotal rows on screen: ${JSON.stringify(Object.keys(sub))}`);
    t.ok(!!sub.B, 'close band footer carries a grade-B (per-schedule) subtotal — the two schedule-closed loans are not folded into A',
         `subtotal rows on screen: ${JSON.stringify(Object.keys(sub))}`);
    const bandPrincipal = cell('A', 2) + cell('B', 2) + cell('none', 2);
    const bandInterest  = cell('A', 3) + cell('B', 3) + cell('none', 3);
    // The partition itself, stated: every row's principal lands in exactly one
    // of the three footer lines. A fourth subtotal added later, or a row that
    // falls into none of them, breaks this rather than going unnoticed.
    const rowPrincipal = cb.rows.reduce((n, r) => n + (r.principalN || 0), 0);
    const rowInterest  = cb.rows.reduce((n, r) => n + (r.interestN  || 0), 0);
    t.eq(money(rowPrincipal), money(bandPrincipal),
         'close band footer: grade A + grade B + excluded accounts for every row\'s principal, once each');
    t.eq(money(rowInterest), money(bandInterest),
         'close band footer: ...and for every row\'s interest');
    t.eq(money(paidPrincipal), money(bandPrincipal),
         `"Paid last month" principal equals the close band's principal for the same month`);
    t.eq(money(paidInterest), money(bandInterest),
         `"Paid last month" interest equals the close band's interest for the same month`);
    t.eq(money(paidTotal), money(paidPrincipal + paidInterest), '"Paid last month" total equals its own principal + interest');

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

    // (f) close band arithmetic must tie WITHIN EACH GRADE's own footer line.
    // Session 245 established the property; session 246 gave it two rows to hold
    // on, and it has to hold on both or a subtotal is mixing populations.
    for (const k of ['A', 'B']) {
      if (!sub[k]) continue;
      t.eq(money(cell(k, 1) - cell(k, 2)), money(cell(k, 4)),
           `close band footer: opening − principal = computed within the grade-${k} subtotal`);
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
    const now = new Date();
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
      const f = cb.foot0;
      t.eq(money(parseMoney(f[1]) - parseMoney(f[2])), money(parseMoney(f[4])),
           `close band — ${c.name}: footer opening − principal = computed`);
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
          const now = new Date(); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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
      const now = new Date();
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
        const now = new Date(); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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
        d.loan_statements.push({ id: 'harness-stale', loan_account_id: off.id, statement_date: new Date().toISOString().slice(0, 10),
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
        const now = new Date(); const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
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
      const footSum = Object.keys(cbx.subtotals)
        .filter(k => k !== 'none')
        .reduce((n, k) => n + Math.abs(Number(cbx.subtotals[k].varianceN || 0)), 0);
      t.close(footSum, absSum, 0.05,
        's236: the close-band variance total is the sum of ABSOLUTE row variances, across every grade subtotal');
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
                     'loan_documents', 'loan_book_balances'];

/* The inverse edits: shipped source → pre-fix source. Keyed by the defect they
   re-introduce. Applied to _bkRosterHtml.toString() inside the page. */
const ROSTER_REVERTS = {
  // #1a A finding on a RECONCILED loan rendered nowhere: `continue` came before
  //     the children block, and the dot was green regardless.
  'reconciled-children': [
    ['<span class="bk-dot ${r.items.length ? \'amber\' : \'green\'}"></span>',
     '<span class="bk-dot green"></span>'],
    ['Agrees with the lender${asOf}${how}${still}',
     'Agrees with the lender${asOf}${how}'],
    ['          if (r.items.length) html += `<div style="padding-left:18px;border-left:2px solid var(--gray-100);margin-left:22px">`\n            + r.items.map(_bkQueueRowHtml).join(\'\') + `</div>`;\n          continue;\n        }\n\n        if (g.key === \'immaterial\') {',
     '          continue;\n        }\n\n        if (g.key === \'immaterial\') {'],
  ],
  // #1b Same defect on the IMMATERIAL group.
  'immaterial-children': [
    ['${r.items.length ? `. ${r.items.length} other thing${r.items.length === 1 ? \'\' : \'s\'} on this loan still need${r.items.length === 1 ? \'s\' : \'\'} a look` : \'\'}', ''],
    ['          if (r.items.length) html += `<div style="padding-left:18px;border-left:2px solid var(--gray-100);margin-left:22px">`\n            + r.items.map(_bkQueueRowHtml).join(\'\') + `</div>`;\n          continue;\n        }\n\n        const sub = g.key === \'variance\'',
     '          continue;\n        }\n\n        const sub = g.key === \'variance\''],
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
};

// #4 The confetti gate lives inside renderBookkeepingOverview, not in its own
//    function, so this one is reverted on that function instead.
const CONFETTI_FIXED =
  "const _rc = _bkOverviewSeg === 'issues' ? _bkRosterCounts() : null;\n" +
  "    const _rcNow = (_rc && _rc.total > 0 && _bkDataReady()) ? _rc.reconciled : null;";
const CONFETTI_PREFIX =
  "const _rcNow = _bkOverviewSeg === 'issues' ? _bkRosterCounts().reconciled : null;";

/* Install the pre-fix roster in the page. Returns {ok, missing:[...]}. */
async function revertRoster(p, names, edits) {
  return p.evaluate(({ names, edits }) => {
    let src = window._bkRosterHtml.toString();
    const missing = [];
    for (const n of names) for (const [from, to] of edits[n]) {
      if (!src.includes(from)) { missing.push(n + ' :: ' + from.slice(0, 60)); continue; }
      src = src.replace(from, to);
    }
    if (missing.length) return { ok: false, missing };
    const body = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
    try { window._bkRosterHtml = new Function('issues', body); }
    catch (e) { return { ok: false, missing: ['compile: ' + e.message] }; }
    renderBookkeepingOverview();
    return { ok: true, missing: [] };
  }, { names, edits });
}

/* The queue card, read the way a person reads it: rows in order, each with the
   dot colour, the reason, and whatever is indented underneath it. */
const READ_QUEUE = () => {
  const list = document.getElementById('bk-ov-queue-list');
  if (!list) return null;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return {
    counts: _bkRosterCounts(),
    dataReady: _bkDataReady(),
    // Every item the queue believes it is showing. If one of these never
    // reaches `text` below, the page dropped a finding.
    itemNames: _bkIssueQueueItems().map(i => norm(i.name)),
    heads: [...list.querySelectorAll('.bk-tier-head')].map(e => norm(e.textContent)),
    rows: [...list.children].map(e => ({
      cls: e.className,
      name: norm((e.querySelector('.bk-queue-name') || {}).textContent),
      dot: norm((e.querySelector('.bk-dot') || {}).className).replace('bk-dot ', ''),
      reason: norm((e.querySelector('.bk-queue-reason') || {}).textContent),
      // A child block is a bare <div> sibling holding the loan's own findings.
      childRows: e.className ? 0 : e.querySelectorAll('.bk-queue-row').length,
      childNames: e.className ? [] : [...e.querySelectorAll('.bk-queue-name')].map(n => norm(n.textContent)),
    })),
    text: norm(list.textContent),
    allClear: !!list.querySelector('.bk-allclear'),
    statusline: norm((document.getElementById('bk-ov-statusline') || {}).textContent),
  };
};

/* Find the roster row for a loan (the header row, not a child). */
const rowFor = (q, name) => q.rows.find(r => /bk-queue-row/.test(r.cls) && r.name === name) || null;
/* The child block that immediately follows a loan's row. */
const kidsFor = (q, name) => {
  const i = q.rows.findIndex(r => /bk-queue-row/.test(r.cls) && r.name === name);
  const nxt = i >= 0 ? q.rows[i + 1] : null;
  return nxt && !nxt.cls ? nxt : { childRows: 0, childNames: [] };
};

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
      const row = [...document.querySelectorAll('#bk-ov-queue-list .bk-queue-row')]
        .find(e => (e.querySelector('.bk-queue-name') || {}).textContent === 'PCV Good and Green Loan');
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
// The mutation is one a person performs with a mouse: Restore everything from
// the Archived list. The real book has three RECONCILED loans (Dexter Loan 2,
// Paypal 2, Rapid Credit Line) carrying open findings that are currently
// archived; un-archiving them puts findings under green loans, which is the
// exact shape that used to render nowhere at all.
GROUPS.push({
  name: 'roster-clean-loan-children',
  async run(t) {
    const noDismissals = (d) => { d.bk_issue_dismissals.length = 0; };

    const p = await newHarnessPage({ tab: 'overview', mutate: noDismissals });
    const q = await p.evaluate(READ_QUEUE);

    // Session 246 moved Dexter Loan 2 out of this group: its $0.00 tie-out is
    // against the amortization schedule the books were built from, so it now
    // reads "closed on the contractual schedule" rather than "reconciled". Five
    // loans remain, and the probe moves to the two that are still in the green
    // group AND still carrying open findings — Rapid Credit Line and Paypal 2.
    // Dexter's findings have not stopped mattering and are asserted below, in
    // the group it actually landed in.
    t.eq(q.counts.reconciled, 5, 'r1: the five reconciled loans are still reconciled');
    t.ok(q.heads.includes('Reconciled (5)'), 'r1: the Reconciled group is on screen', JSON.stringify(q.heads));

    // A reconciled loan that carries open findings.
    const RCL = 'Rapid Credit Line';
    const dex = rowFor(q, RCL);
    t.ok(!!dex, `r1: ${RCL} (tied, but carrying findings) renders in the roster`);
    t.eq(dex && dex.dot, 'amber', 'r1: a reconciled loan with open findings gets an AMBER dot, not a plain green one');
    t.ok(/still need/.test((dex || {}).reason || ''),
         'r1: ...and says so — "still need a look" rather than an unqualified all-clear',
         `reason=${JSON.stringify((dex || {}).reason)}`);
    const dexKids = kidsFor(q, RCL);
    t.eq(dexKids.childRows, 1, `r1: ${RCL}'s open finding renders UNDER it`);
    t.ok(dexKids.childNames.some(n => /enough lender balances to project a schedule/.test(n)),
         'r1: ...by name, not as a count', JSON.stringify(dexKids.childNames));
    // The same rule on the second reconciled loan carrying work, so the check is
    // about the BRANCH rather than about one loan's data.
    const pp = rowFor(q, 'Paypal 2');
    t.eq(pp && pp.dot, 'amber', 'r1: ...and the same on Paypal 2, the other reconciled loan with work outstanding');
    t.eq(kidsFor(q, 'Paypal 2').childRows, 1, 'r1: ...whose finding also renders under it');

    // ── AND THE LOAN THAT LEFT THE GREEN GROUP KEPT ITS FINDINGS ─────────
    // A quiet group is not a silent one. Dexter now sits under "Closed on the
    // contractual schedule"; both of its open findings must still be on screen,
    // under it, or session 246 has re-created the very defect this group exists
    // to catch in a new group.
    t.ok(q.heads.some(h => /Closed on the contractual schedule \(1\)/.test(h)),
         'r1: Dexter Loan 2 landed in the per-schedule group', JSON.stringify(q.heads));
    const dx = rowFor(q, 'Dexter Loan 2');
    t.ok(!!dx, 'r1: ...and still renders as its own row');
    const dxKids = kidsFor(q, 'Dexter Loan 2');
    t.eq(dxKids.childRows, 2, 'r1: ...with BOTH of its open findings still underneath it');
    t.ok(dxKids.childNames.some(n => /no lender document on file/.test(n)),
         'r1: ...including the stale_anchor finding by name', JSON.stringify(dxKids.childNames));

    // ...and a reconciled loan with nothing outstanding still reads green, so
    // the amber above is a distinction the renderer actually draws.
    const bay = rowFor(q, 'BayFirst SBA 2');
    t.eq(bay && bay.dot, 'green', 'r1: a reconciled loan with NOTHING outstanding is still plain green');
    t.notMatch((bay || {}).reason, /still need/, 'r1: ...and makes no "still need a look" claim');

    // The whole-card property: nothing the queue believes it is showing is missing.
    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r1: every item in the queue reaches the DOM — nothing is silently dropped');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));

    // ── does the assertion discriminate? put the pre-fix branch back ──
    const rev = await revertRoster(p, ['reconciled-children'], ROSTER_REVERTS);
    t.ok(rev.ok, 'r1: the pre-fix reconciled branch could be re-applied in page context',
         JSON.stringify(rev.missing));
    if (rev.ok) {
      const b = await p.evaluate(READ_QUEUE);
      const bDex = rowFor(b, RCL);
      t.eq(bDex && bDex.dot, 'green', 'r1 CONTROL: pre-fix, the same loan showed a plain green dot');
      t.eq(kidsFor(b, RCL).childRows, 0, 'r1 CONTROL: pre-fix, its findings rendered nowhere');
      const gone = b.itemNames.filter(n => !b.text.includes(n));
      t.ok(gone.length >= 2, 'r1 CONTROL: pre-fix, findings on reconciled loans vanished from the page',
           `${gone.length} dropped: ${JSON.stringify(gone.slice(0, 4))}`);
    }
    await p.close();

    // ── the same rule for the IMMATERIAL group ──
    // Nothing in the real book is immaterial today (no tie-out carries
    // detail.material === false), so this is EIDL's shape applied to a loan
    // that actually has findings: mark E-Transit 4140's tie-out immaterial and
    // its three open findings must still render underneath it.
    const p2 = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      noDismissals(d);
      const a = d.loan_accounts.find(x => x.xero_account_name === 'E-Transit Loan - 4140');
      const to = d.loan_tie_outs.find(x => x.loan_account_id === a.id);
      to.detail = Object.assign({}, to.detail || {}, { material: false });
    } });
    const q2 = await p2.evaluate(READ_QUEUE);
    // EIDL already sits in this group on the real book (its tie-out carries an
    // explicit material:false, visible for the first time now the fixture pulls
    // loan_tie_outs.detail), so forcing E-Transit 4140 immaterial makes TWO.
    // The invariant asserted is the movement, not the absolute: one loan crosses
    // from `variance` to `immaterial` and nothing else moves.
    t.eq(q2.counts.immaterial, 2, 'r1: an immaterial tie-out moves the loan out of "needs attention"');
    t.eq(q2.counts.variance, 5, 'r1: ...and the variance count drops by exactly one');
    t.eq(q2.counts.immaterial + q2.counts.variance, 7,
         'r1: ...so the two groups together are unchanged — the loan moved, it did not vanish');
    const et = rowFor(q2, 'E-Transit Loan - 4140');
    t.eq(et && et.dot, 'gray', 'r1: a small-difference loan is gray, not red');
    t.ok(/3 other things on this loan still need a look/.test((et || {}).reason || ''),
         'r1: ...and still names the work outstanding on it',
         `reason=${JSON.stringify((et || {}).reason)}`);
    t.eq(kidsFor(q2, 'E-Transit Loan - 4140').childRows, 3,
         'r1: all three of its findings render under it');

    const rev2 = await revertRoster(p2, ['immaterial-children'], ROSTER_REVERTS);
    t.ok(rev2.ok, 'r1: the pre-fix immaterial branch could be re-applied', JSON.stringify(rev2.missing));
    if (rev2.ok) {
      const b2 = await p2.evaluate(READ_QUEUE);
      t.eq(kidsFor(b2, 'E-Transit Loan - 4140').childRows, 0,
           'r1 CONTROL: pre-fix, an immaterial loan\'s findings rendered nowhere');
      t.notMatch((rowFor(b2, 'E-Transit Loan - 4140') || {}).reason, /still need a look/,
                 'r1 CONTROL: pre-fix, it did not mention them either');
    }
    await p2.close();
  },
});

/* ── R2 ── A FINDING ON A LOAN THAT IS NOT ACTIVE MUST SURFACE ────────────── */
// The roster is built from ACTIVE loans. A finding on a loan that has been paid
// off, or is still pending, has an id — so the pre-fix code put it in `byLoan`,
// never read that key back, and never counted it as an orphan either. It simply
// stopped existing. Funding Circle carries an ERROR balance_vs_lender of
// $3,041.83; paying the loan off must not make that error disappear.
GROUPS.push({
  name: 'roster-orphan-findings',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.find(x => x.xero_account_name === 'Funding Circle Loan').status = 'paid_off';
    } });
    const q = await p.evaluate(READ_QUEUE);

    t.eq(q.counts.total, 13, 'r2: the roster denominator drops to the 13 still-active loans');

    // The expected orphan count is DERIVED, not typed. The invariant is "every
    // finding on the now-inactive loan joins the orphan group"; how many
    // findings that loan happens to carry is fixture data, and a refresh that
    // adds one must not read as a regression in the page. (It did: the refresh
    // added a third Funding Circle finding and this assertion, written as a
    // literal 3, went red for no reason connected to the code.)
    const derived = await p.evaluate(() => {
      const fc = (_allLoanAccounts || []).find(a => a.xero_account_name === 'Funding Circle Loan');
      const items = _bkIssueQueueItems();
      return {
        fcStatus: fc.status,
        unplaceable: items.filter(it => !_bkIssueLoanId(it)).length,
        onFc: items.filter(it => _bkIssueLoanId(it) === fc.id).length,
      };
    });
    t.eq(derived.fcStatus, 'paid_off', 'r2: the scenario really did take Funding Circle off the active roster');
    t.ok(derived.onFc >= 2, 'r2: ...and it really is carrying findings that must not vanish with it',
         `${derived.onFc} findings on the inactive loan`);
    const orphanHead = q.heads.find(h => /Not tied to one loan/.test(h));
    t.eq(orphanHead, `Not tied to one loan (${derived.unplaceable + derived.onFc})`,
         'r2: every finding on the now-inactive loan joins the orphan group');

    const fcErr = 'Funding Circle Loan — Xero is $3,041.83 below the lender';
    const fcInfo = 'Funding Circle Loan — 2026-08-18 payment of $2,033.77 has no interest split';
    t.ok(q.text.includes(fcErr), 'r2: the $3,041.83 ERROR on the inactive loan is still on screen');
    t.ok(q.text.includes(fcInfo), 'r2: ...and so is its lumped-payment finding');
    t.ok(q.rows.some(r => r.name === fcErr), 'r2: the error renders as its own row, not as buried text');

    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r2: every item the queue holds reaches the DOM');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));

    // ── does it discriminate? ──
    const rev = await revertRoster(p, ['orphans'], ROSTER_REVERTS);
    t.ok(rev.ok, 'r2: the pre-fix orphan test could be re-applied', JSON.stringify(rev.missing));
    if (rev.ok) {
      const b = await p.evaluate(READ_QUEUE);
      t.ok(!b.text.includes(fcErr),
           'r2 CONTROL: pre-fix, a $3,041.83 error on a non-active loan rendered NOWHERE',
           b.text.includes(fcErr) ? 'still present — the revert did not reproduce the defect' : '');
      t.eq(b.heads.find(h => /Not tied to one loan/.test(h)), `Not tied to one loan (${derived.unplaceable})`,
           'r2 CONTROL: pre-fix, it was not counted as an orphan either');
      t.eq(b.itemNames.filter(n => !b.text.includes(n)).length, derived.onFc,
           'r2 CONTROL: pre-fix, exactly the findings on that loan were dropped',
           JSON.stringify(b.itemNames.filter(n => !b.text.includes(n))));
    }
    await p.close();
  },
});

/* ── R3 ── NO ACTIVE LOANS IS NOT A REASON TO THROW THE QUEUE AWAY ───────── */
// `if (!loans.length) return ''` blanked the entire card — payroll items, loan
// flags, findings, all of it — while the headline above still counted them.
// A roster with no denominator falls back to the flat list; it does not fall
// back to a blank screen.
GROUPS.push({
  name: 'roster-empty-denominator',
  async run(t) {
    const p = await newHarnessPage({ tab: 'overview', mutate: (d) => {
      d.loan_accounts.forEach(a => { a.status = 'paid_off'; });
    } });
    const q = await p.evaluate(READ_QUEUE);

    t.eq(q.counts.total, 0, 'r3: there really are zero active loans in this scenario');
    t.ok(q.dataReady, 'r3: ...and the books did load — this is an empty book, not a cold boot');
    t.ok(q.itemNames.length > 0, 'r3: the queue still holds items', `${q.itemNames.length} items`);

    const missing = q.itemNames.filter(n => !q.text.includes(n));
    t.eq(missing.length, 0, 'r3: every queue row still renders with no roster to hang it on');
    if (missing.length) console.log('        missing: ' + JSON.stringify(missing));
    t.ok(q.rows.filter(r => /bk-queue-row/.test(r.cls)).length >= q.itemNames.length,
         'r3: ...as real rows, one per item',
         `${q.rows.filter(r => /bk-queue-row/.test(r.cls)).length} rows for ${q.itemNames.length} items`);
    t.ok(!q.allClear, 'r3: an empty roster never renders the All clear badge over a non-empty queue');

    // ── does it discriminate? ──
    const rev = await revertRoster(p, ['empty-denominator'], ROSTER_REVERTS);
    t.ok(rev.ok, 'r3: the pre-fix blank-card return could be re-applied', JSON.stringify(rev.missing));
    if (rev.ok) {
      const b = await p.evaluate(READ_QUEUE);
      t.eq(b.itemNames.filter(n => !b.text.includes(n)).length, b.itemNames.length,
           'r3 CONTROL: pre-fix, zero active loans discarded EVERY queue row');
      t.eq(b.rows.filter(r => /bk-queue-row/.test(r.cls)).length, 0,
           'r3 CONTROL: pre-fix, the card rendered no rows at all');
    }
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
      const p = await newHarnessPage({ tab: 'overview', settle: false, hold: ALL_TABLES });
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
    // 5 of 14, not 6: session 246 moved Dexter Loan 2 out of `reconciled` and
    // into `byschedule`, because its $0.00 tie-out was against the schedule its
    // own books were built from.
    t.ok(s.end.renders.some(r => r.total === 14 && r.reconciled === 5 && r.ready),
         'r4: ...and one after, with the real 5-of-14', JSON.stringify(s.end.renders));
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
    const earn = await ship.p.evaluate(() => {
      const before = window.__cf;
      const ex = (_loanTieOuts || []).find(x =>
        x.status === 'exception' && _VARIANCE_REAL_ANCHORS.includes(String(x.anchor_source || '')));
      if (!ex) return { before, after: window.__cf, reconciled: null, picked: null };
      const acct = (_allLoanAccounts || []).find(a => a.id === ex.loan_account_id);
      ex.status = 'tied';                       // a loan is reconciled, for real
      renderBookkeepingOverview();
      return { before, after: window.__cf, reconciled: _bkRosterCounts().reconciled,
               picked: acct && acct.xero_account_name, anchor: ex.anchor_source };
    });
    t.ok(!!earn.picked, 'r4: an exception anchored to a real lender document was available to reward',
         'no tie-out in the fixture is an exception against a _VARIANCE_REAL_ANCHORS source');
    t.eq(earn.reconciled, 6, `r4: a loan genuinely went from exception to tied (${earn.picked})`);
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
  'no-unbooked-band': ['if (!parts.length || Math.abs(residual) >= 0.005) return null;', 'return null;'],
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
  // Review F14: an empty grade-A subtotal renders anyway, and prints data-tie
  // over zero loans.
  'empty-subtotal-renders': [
    ['${rf.gradeA.length ? subtotalRow(\'A\', `${rf.gradeA.length} confirmed by lender`, rf.totalsA) : \'\'}',
     '${subtotalRow(\'A\', `${rf.gradeA.length} confirmed by lender`, rf.totalsA)}'],
    ['${st.count && st.variance < 0.005 ? \' data-tie="1"\' : \'\'}', '${st.variance < 0.005 ? \' data-tie="1"\' : \'\'}'],
  ],
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
  'stripe-cell-reads-not-received': ['(r.automatic', '(false'],
  // The provenance label stops labelling: every source renders as its raw slug.
  'label-returns-slug': ['return _ANCHOR_SOURCE_LABEL[src] || src || \'unknown\';', 'return src;'],
  // Undated splits stop being reported, so seven posted Verdant payments that
  // sit in no month at all are closed over in silence.
  'undated-invisible': ['return (_allLoanSplits || []).filter(sp =>', 'return [].filter(sp =>'],
  // The chips stop carrying data-gate. Nothing about the strip LOOKS different;
  // what changes is that anything reading it by name can no longer find it.
  'chips-lose-their-name': ['data-gate="${esc(g.key)}"', ''],
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
  async run(t) {
    // The fixture is a point-in-time snapshot whose closing month is 2026-07.
    // Every figure below is a July figure verified against production, so a run
    // whose clock has moved on must fail HERE, loudly, rather than fifty
    // assertions later with numbers nobody can place.
    const now = new Date();
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

      // ── AND THAT ARITHMETIC IS A TAUTOLOGY, SO IT MUST NOT PRINT A TIE ──
      // This is what the first cut of this group got wrong, and it is the whole
      // lesson. "Opening − principal = closing" landed on the cent, and I read
      // that as the flagship acceptance test passing. It is not a check: all 61
      // of Dexter's 'xero_derived' opening rows are a frozen 2026-08 backfill
      // that equals the contract on every same-dated row, so the opening, the
      // movement and the closing are one document. Amendment A7 said this in
      // as many words — "acceptance #1 was an assertion; it is a prediction" —
      // and I asserted the prediction anyway.
      //
      // The guard is now a PREDICATE, not a source name: an opening counts only
      // if a books-side Xero rebuild or a real lender document produced it.
      t.eq(r.circular, true,
           'ce1: ...and the row is CIRCULAR — a frozen backfill off the same contract cannot confirm it');
      t.eq(r.ties, false, 'ce1: ...so it does NOT tie, however exactly the arithmetic lands');
      t.eq(r.varianceN, null, 'ce1: ...and reports no variance at all');
      t.eq(r.band, null, 'ce1: ...in no band, counted in neither the ties nor the offs');
      t.ok(/agrees by construction/.test(r.variance || ''),
           'ce1: ...saying so, in the column a reader looks at', `cell=${JSON.stringify(r.variance)}`);
      t.notMatch(r.perLender, /amortization_schedule/,
                 'ce1: the closing cell names the schedule in English, never as a slug');
      t.ok(/amortization schedule/i.test(r.perLender || ''),
           'ce1: ...and it does name it, so a reader can disagree with the basis',
           `cell=${JSON.stringify(r.perLender)}`);

      // The chip and the subtotal agree with the row.
      const g = cb.gateByKey['per-schedule'];
      t.ok(!!g, 'ce1: the strip carries a per-schedule chip', JSON.stringify(cb.gates.map(x => x.key)));
      t.eq(g && g.count, 2, 'ce1: ...counting the two loans that close on their schedule');
      t.eq(cb.subtotals.B && cb.subtotals.B.count, 2, 'ce1: ...and the grade-B subtotal holds the same two');

      // ── CONTROL a ── the tautology itself: let anything count as independent
      const revI = await revertFn(p, '_openingIsIndependent', EDITS('everything-is-independent'));
      t.ok(revI.ok, 'ce1 CONTROL: an independence test that accepts every source could be rebuilt', JSON.stringify(revI.missing));
      if (revI.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.eq(b.circular, false, 'ce1 CONTROL: pre-review, a frozen backfill counted as an independent opening');
        t.eq(b.ties, true, 'ce1 CONTROL: ...and Dexter printed a GREEN TIE against the contract it was built from');
        t.close(b.varianceN, 0, 0.005, 'ce1 CONTROL: ...at exactly $0.00, forever, because it could not fail');
      }
      await restoreFns(p);

      // ── CONTROL b ── no grade B at all
      const rev = await revertFn(p, '_loanClosingAnchor', EDITS('no-grade-b'));
      t.ok(rev.ok, 'ce1 CONTROL: the pre-grade-B anchor could be rebuilt in page context', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.eq(b.grade, 'C', 'ce1 CONTROL: without the policy branch, Dexter has no closing balance at all');
        t.eq(b.perLenderN, null, 'ce1 CONTROL: ...the closing cell is empty');
        t.eq(b.circular, false, 'ce1 CONTROL: ...and there is no grade-B row left to call circular');
      }
      await restoreFns(p);
      await p.close();

      // ── THE OTHER HALF OF THE PAIR, AND IT IS THE ACTUAL TEST ───────────
      // One half alone is what let the tautology through: asserting only that
      // Dexter ties proved nothing, and asserting only that it is circular would
      // be satisfied by a guard that fires on everything and reports no loan at
      // all. Give the walk a books-side opening that reconciliation-run really
      // would write, and the SAME row must become independent and tie for real.
      const pBooks = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        d.loan_book_balances.push({
          id: 'harness-dex-0630', loan_account_id: dex.id, as_of: '2026-06-30',
          balance: 92737.48, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-06-30T12:00:00Z',
        });
      } });
      const rb = rowOf((await pBooks.surfaces()).loans.closeBand, 'Dexter Loan 2');
      t.eq(rb.openingFromBooks, true, 'ce1: with a 6/30 books rebuild on file the opening comes from OUR BOOKS');
      t.close(rb.openingN, 92737.48, 0.005, 'ce1: ...at the same $92,737.48, from a genuinely independent measurement');
      t.eq(rb.circular, false, 'ce1: ...so the row is no longer circular');
      t.eq(rb.grade, 'B', 'ce1: ...still grade B — the closing is still the contract');
      t.close(rb.perLenderN, 89411.25, 0.005, 'ce1: ...still closing at $89,411.25');
      t.eq(rb.ties, true, 'ce1: ...and NOW it ties, and the tie means something');
      t.eq(rb.band, 'tie', 'ce1: ...in the tie band');
      t.close(rb.varianceN, 0, 0.005, 'ce1: ...at $0.00 — acceptance #1, finally as a measurement rather than a prediction');
      t.eq((await pBooks.surfaces()).loans.closeBand.subtotals.B.circularCount, 1,
           'ce1: ...and the grade-B subtotal now declares one circular row, not two');

      // ── CONTROL c ── the same row, with the books balance ignored
      const revB = await revertFn(pBooks, '_loanCloseRollforward', EDITS('ignore-book-balances'));
      t.ok(revB.ok, 'ce1 CONTROL: a rollforward blind to the books balance could be rebuilt', JSON.stringify(revB.missing));
      if (revB.ok) {
        const b = rowOf((await pBooks.surfaces()).loans.closeBand, 'Dexter Loan 2');
        t.eq(b.circular, true, 'ce1 CONTROL: ignore the books row and the same loan goes back to circular');
        t.eq(b.ties, false, 'ce1 CONTROL: ...and the real tie disappears — both halves of the pair discriminate');
      }
      await restoreFns(pBooks);
      await pBooks.close();
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
        // The books-side opening goes in too. Without it Dexter's row is
        // circular and prints no variance at all, so "the closing is still
        // 89,411.25" would be the only thing left to check and the tie — the
        // thing a wrong closing balance actually breaks — would be untestable.
        d.loan_book_balances.push({
          id: 'harness-dex-0630', loan_account_id: a.id, as_of: '2026-06-30',
          balance: 92737.48, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-06-30T12:00:00Z',
        });
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

    /* ── 3 ── VERDANT, WITH NO BOOKS BALANCE, AGREES BY CONSTRUCTION ─────── */
    // All 85 of Verdant's loan_statements rows ARE the schedule, every split is
    // schedule-generated, and the closing figure would be the schedule too:
    // opening, movement and closing are one document. The variance is then zero
    // for every month forever. It cannot fail, so it is not a check, and it must
    // not be allowed to look like one that passed.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const s = await p.surfaces();
      const cb = s.loans.closeBand;
      const r = rowOf(cb, 'Verdant Capital Loan');
      t.ok(!!r, 'ce3: Verdant is on the rollforward');
      t.eq(r.grade, 'B', 'ce3: Verdant closes at grade B');
      t.eq(r.circular, true, 'ce3: ...and the ROW is marked circular');
      t.eq(r.varianceCircular, true, 'ce3: ...as is the variance cell');
      t.eq(r.ties, false, 'ce3: ...which carries NO data-tie — this is not a tie');
      t.eq(r.varianceN, null, 'ce3: ...and no variance figure at all');
      t.eq(r.band, null, 'ce3: ...and no band, so it is in neither the ties nor the offs');
      t.ok(/agrees by construction/.test(r.variance || ''),
           'ce3: ...and it SAYS so, in the column a reader looks at',
           `cell=${JSON.stringify(r.variance)}`);
      t.ok(/not an independent check/.test(r.variance || ''),
           'ce3: ...including why that is not the same as agreeing');
      t.eq(r.openingFromBooks, false,
           'ce3: ...and the row records that its opening did NOT come from the books');
      // The footer says it out loud too, and counts it in neither column.
      t.ok(/agree.? by construction/.test(cb.note || ''),
           'ce3: the footer sentence accounts for the row it excluded', `note=${JSON.stringify(cb.note)}`);
      // BOTH grade-B loans are circular on the real book now: Verdant's opening is
      // the schedule mirror and Dexter's is a frozen backfill off the same
      // contract. Neither has anything independent opening its walk, and
      // loan_book_balances is empty in production — which is the finding, not a
      // gap in the test. ce1 plants the row that fixes one of them.
      t.eq(cb.subtotals.B && cb.subtotals.B.circularCount, 2,
           'ce3: the grade-B subtotal declares that NEITHER of its two loans is independently checked');
      t.eq(cb.subtotals.B && cb.subtotals.B.count, 2, 'ce3: ...out of two');
      t.eq(cb.rows.filter(r => r.circular).length, 2,
           'ce3: ...matching the rows that actually carry data-circular');
      // Verdant's seven undated splits are stated rather than closed over.
      t.eq(r.undatedN, 7, 'ce3: ...and its seven undated splits are declared on the row (A10)');
      t.ok(/7 undated/.test(r.inXero || ''), 'ce3: ...visibly, in the status column',
           `status=${JSON.stringify(r.inXero)}`);
      {
        const revU = await revertFn(p, '_undatedSplits', EDITS('undated-invisible'));
        t.ok(revU.ok, 'ce3 CONTROL: an _undatedSplits that reports nothing could be rebuilt', JSON.stringify(revU.missing));
        if (revU.ok) {
          const b = rowOf((await p.surfaces()).loans.closeBand, 'Verdant Capital Loan');
          t.eq(b.undatedN, 0, 'ce3 CONTROL: seven posted payments that fall in no month are closed over in silence');
          t.notMatch(b.inXero, /undated/, 'ce3 CONTROL: ...with nothing on the row to say so');
        }
        await restoreFns(p);
      }

      // ── CONTROL ── key the guard on a schedule id, as the design draft did
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('circular-guard-off'));
      t.ok(rev.ok, 'ce3 CONTROL: the draft’s id-keyed circularity guard could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = rowOf((await p.surfaces()).loans.closeBand, 'Verdant Capital Loan');
        t.eq(b.circular, false, 'ce3 CONTROL: a guard that cannot fire leaves the row unmarked');
        t.eq(b.ties, true, 'ce3 CONTROL: ...and Verdant prints a GREEN TIE against the document it was built from');
        t.notMatch(b.variance, /agrees by construction/,
                   'ce3 CONTROL: ...with no warning of any kind — which is the defect the assertion catches');
      }
      await restoreFns(p);
      await p.close();
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
        const td = tr && tr.children[6];
        return { html: td ? td.innerHTML : null, off: !!(td && td.querySelector('.lcb-off')) };
      });
      t.eq(red.off, true, 'ce4: ...and it renders RED (.lcb-off), not grey',
           `variance cell html=${JSON.stringify(red.html)}`);
      t.ok(/our books, rebuilt from Xero/.test(r.opening || ''),
           'ce4: ...and the opening cell names its provenance in English',
           `cell=${JSON.stringify(r.opening)}`);
      t.notMatch(r.opening, /xero_rebuild/, 'ce4: ...never as a slug');
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
      t.ok(/rolled back from/.test(r.perLender || ''),
           'ce5: ...and the cell says the figure was DERIVED, and from what',
           `cell=${JSON.stringify(r.perLender)}`);
      t.ok(/8\/25/.test(r.perLender || ''), 'ce5: ...naming the document’s own date, not month end');
      // …and it does not block.
      const im = cb.gateByKey['immaterial'];
      t.ok(!!im, 'ce5: the immaterial chip is on the strip', JSON.stringify(cb.gates.map(x => x.key)));
      t.eq(im && im.ok, true, 'ce5: ...and it is not a blocking gate');
      t.ok(/\$5\.00/.test((im || {}).text || ''), 'ce5: ...with the figure visible on the chip itself',
           `chip=${JSON.stringify((im || {}).text)}`);
      t.eq(cb.gateByKey['variance'].ok, true, 'ce5: the variance gate stays clear');
      // July IS blocked — by one Funding Circle split still in pending_review,
      // which is a different kind of work entirely. The claim under test is that
      // the $5.00 contributes NOTHING to that: no bad gate is about a variance.
      const bad = cb.gates.filter(g => !g.ok).map(g => g.key);
      t.eq(JSON.stringify(bad), JSON.stringify(['posting']),
           'ce5: the only thing blocking July is an unposted split — no gate is bad on account of a variance',
           `bad gates: ${JSON.stringify(bad)}`);
      t.eq(cb.subtotals.A && cb.subtotals.A.material, 0,
           'ce5: ...so grade A’s subtotal reports nothing material, and prints its $5.00 in grey');

      // …and with that one split posted, the band reads exactly what acceptance
      // #4 asks for, WITH the $5.00 still on screen. This is the assertion the
      // whole materiality amendment exists for: a five-dollar difference on a
      // million-dollar loan may be shown, and may not stop a close.
      const pClean = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        d.loan_splits.forEach(sp => {
          if (String(sp.period_label || '').slice(0, 7) === MONTH &&
              ['pending_review', 'needs_attention'].includes(sp.status)) sp.status = 'posted';
        });
      } });
      const cb2 = (await pClean.surfaces()).loans.closeBand;
      t.ok(/ready for your accountant/i.test(cb2.lead || ''),
           'ce5: with the unposted split cleared, a $5.00 gap does NOT stop the close',
           `lead=${JSON.stringify(cb2.lead)} · bad gates ${JSON.stringify(cb2.gates.filter(g => !g.ok).map(g => g.key))}`);
      const r2 = rowOf(cb2, 'EIDL SBA Loan');
      t.eq(r2.band, 'immaterial', 'ce5: ...and the $5.00 is still there, still de-escalated');
      t.ok(/\$5\.00/.test((cb2.gateByKey['immaterial'] || {}).text || ''),
           'ce5: ...still printed on the chip, not hidden');
      t.ok(/2 per schedule/.test(cb2.text || ''),
           'ce5: ...and the strip reads "N confirmed by lender · 2 per schedule", never "3 statements outstanding"',
           `strip: ${JSON.stringify(cb2.gates.map(g => g.text))}`);
      t.notMatch(cb2.text, /statements? outstanding/,
                 'ce5: ...with no queue for documents that are never coming');
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

    /* ── 8 ── SUBTOTAL INTEGRITY, PER GRADE ──────────────────────────────── */
    // opening − principal = computed inside EACH subtotal, and grade A's line
    // contains grade-A loans and nothing else. Folding grade B in would make the
    // total imply a higher grade than half of it has, which is the one thing
    // this session exists to stop.
    {
      const p = await newHarnessPage({ tab: 'loans' });
      const cb = (await p.surfaces()).loans.closeBand;
      for (const [k, grade] of [['A', 'A'], ['B', 'B']]) {
        const st = cb.subtotals[k];
        t.ok(!!st, `ce8: the grade-${grade} subtotal row is on screen`);
        if (!st) continue;
        const mine = cb.rows.filter(r => r.grade === grade && r.perLenderN != null && r.computedN != null);
        t.eq(st.count, mine.length, `ce8: the grade-${grade} subtotal counts exactly the grade-${grade} rows that roll forward`);
        t.close(st.openingN - st.principalN, st.computedN, 0.02,
                `ce8: grade-${grade}: opening − principal = computed`);
        const sum = (f) => mine.reduce((n, r) => n + (r[f] || 0), 0);
        t.close(st.openingN,   sum('openingN'),   0.02, `ce8: grade-${grade} opening is the sum of its own rows, nobody else's`);
        t.close(st.principalN, sum('principalN'), 0.02, `ce8: grade-${grade} principal likewise`);
        t.close(st.computedN,  sum('computedN'),  0.02, `ce8: grade-${grade} computed likewise`);
        t.close(st.perLenderN, sum('perLenderN'), 0.02, `ce8: grade-${grade} closing likewise`);
      }
      // The exclusive part, said directly: no grade-B money is inside grade A.
      const bMoney = cb.rows.filter(r => r.grade === 'B' && r.perLenderN != null)
                            .reduce((n, r) => n + r.openingN, 0);
      t.ok(bMoney > 0, 'ce8: there really is grade-B money to keep out of grade A', `${bMoney}`);
      t.ok(Math.abs(cb.subtotals.A.openingN - (cb.subtotals.A.openingN + bMoney)) > 1,
           'ce8: ...and grade A’s opening is smaller than A+B by exactly that amount');
      t.close(cb.subtotals.A.openingN + cb.subtotals.B.openingN,
              cb.rows.filter(r => r.perLenderN != null && r.computedN != null).reduce((n, r) => n + r.openingN, 0),
              0.02, 'ce8: A + B together account for every checkable row, once each');

      // ── CONTROL ── compute grade A's subtotal over every checkable loan
      const rev = await revertFn(p, '_loanCloseRollforward', EDITS('subtotal-a-mixes-grades'));
      t.ok(rev.ok, 'ce8 CONTROL: a grade-mixing subtotal could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.eq(b.subtotals.A.count, 13,
             'ce8 CONTROL: grade A’s line now counts all 13 checkable loans, two of them schedule-derived');
        t.ok(Math.abs(b.subtotals.A.openingN - cb.subtotals.A.openingN) > 1,
             'ce8 CONTROL: ...and the money the CPA signs as lender-confirmed grows by grade B’s $346,319.75',
             `${b.subtotals.A.openingN} vs ${cb.subtotals.A.openingN}`);
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
      const rev = await revertFn(p2, '_anchorSourceLabel', EDITS('label-returns-slug'));
      t.ok(rev.ok, 'ce9 CONTROL: a label function that returns the slug could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = await p2.surfaces();
        t.ok(/\b(amortization_schedule|xero_derived|portal_manual_pull)\b/.test(b.loans.paneText || ''),
             'ce9 CONTROL: without the label, raw database slugs reach the close band — so the assertion above is real',
             `first slug: ${JSON.stringify((b.loans.paneText || '').match(/\b(amortization_schedule|xero_derived|portal_manual_pull)\b/) || [])}`);
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
      const pEmpty = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        d.loan_accounts.forEach(a => { a.close_basis = 'lender_statement'; });
        d.loan_statements = d.loan_statements.filter(st => st.source !== 'email_pdf_upload');
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
      const pAug = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        d.loan_book_balances.push({
          id: 'harness-dex-0731', loan_account_id: dex.id, as_of: '2026-07-31',
          balance: 89411.25, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-07-31T12:00:00Z',
        });
      } });
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
          offSum: rf.off.reduce((n, x) => n + Math.abs(x.variance), 0),
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
      const pp = aug.otherStaged.find(x => x.n === 'Paypal 2');
      t.ok(!!pp, 'ce12 boundary: Paypal 2 also carries a staged split in August', JSON.stringify(aug.otherStaged));
      if (pp) {
        t.eq(pp.band, 'material',
             'ce12 boundary: ...and is NOT de-escalated, because its staged principal does not close the gap exactly');
        t.close(pp.v - pp.stagedP, -44.70, 0.005,
                'ce12 boundary: ...$44.70 of it is unaccounted for, so nothing here is "mostly explained"');
      }
      await pAug.close();

      // (b) the same shape rendered, by moving it into the closing month.
      const pDom = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const dex = d.loan_accounts.find(x => x.xero_account_name === 'Dexter Loan 2');
        d.loan_book_balances.push({
          id: 'harness-dex-0630', loan_account_id: dex.id, as_of: '2026-06-30',
          balance: 92737.48, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-06-30T12:00:00Z',
        });
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
      t.ok(/staged payment/.test(rd.variance || ''),
           'ce12: ...and the cell says WHY, so the reader is not left to guess which de-escalation this is',
           `cell=${JSON.stringify(rd.variance)}`);
      t.ok(/3,326\.23/.test(rd.variance || ''), 'ce12: ...with the figure printed, never hidden');
      // Not blocking, and no chip of its own.
      t.eq(cbD.gateByKey['variance'].ok, true, 'ce12: the variance gate stays clear');
      t.ok(!cbD.gateByKey['unbooked'], 'ce12: ...and there is NO unbooked chip — the posting gate already counts it',
           JSON.stringify(cbD.gates.map(g => g.key)));
      t.eq(cbD.gateByKey['posting'].ok, false, 'ce12: ...which is the one gate that does report it');
      t.close(cbD.subtotals.B.varianceN, 0, 0.005,
              'ce12: ...and the grade-B subtotal counts UNEXPLAINED variance only, so it stays at $0.00');
      t.ok(/payments this month has not booked yet/.test(cbD.note || ''),
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
      const verBooks = (bal) => (d) => {
        const ver = d.loan_accounts.find(x => x.xero_account_name === 'Verdant Capital Loan');
        d.loan_book_balances.push({
          id: 'harness-ver-0630', loan_account_id: ver.id, as_of: '2026-06-30',
          balance: bal, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-06-30T12:00:00Z',
        });
      };
      // 256,289.88 − 2,687.94 booked − 250,894.33 schedule = 2,707.61 exactly.
      const pU = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.88) });
      const ru = rowOf((await pU.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.eq(ru.circular, false, 'ce12: with a books opening Verdant is independently checked');
      t.close(ru.varianceN, 2707.61, 0.005, 'ce12: ...and differs by $2,707.61');
      t.eq(ru.band, 'unbooked', 'ce12: ...which is exactly its undated "Period 14" payment, so it bands "unbooked"');
      t.close(ru.unbookedN, 2707.61, 0.005, 'ce12: ...with that principal named on the row');
      t.eq(ru.ties, false, 'ce12: ...and NOTHING turns green');
      t.eq(ru.undatedN, 7, 'ce12: ...the seven undated splits are still declared');
      t.ok(/7 undated/.test(ru.inXero || ''), 'ce12: ...still visibly, in the status column');
      t.ok(/no date/.test(ru.variance || ''), 'ce12: ...and the variance cell still says the payment has no date',
           `cell=${JSON.stringify(ru.variance)}`);
      await pU.close();

      // ── THE JUDGEMENT CALL, PINNED ──────────────────────────────────────
      // _closeUnbookedExplanation matches a single undated split BY AMOUNT, and
      // this module warns against amount-matching everywhere else (session 245:
      // "a typed number is never evidence"; session 232: a transaction is never
      // the whole answer). It is acceptable here for one reason only — it
      // DE-ESCALATES and never concludes. These assertions fix that boundary so
      // a later change cannot widen it into something that decides.
      //
      // One cent out, and it must stop explaining.
      const pOff = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.89) });
      const ro = rowOf((await pOff.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.close(ro.varianceN, 2707.62, 0.005, 'ce12 boundary: one cent more and the gap is $2,707.62');
      t.eq(ro.band, 'material', 'ce12 boundary: ...which no undated split explains, so it is MATERIAL and blocks');
      t.eq(ro.unbookedN, null, 'ce12 boundary: ...with no data-unbooked at all');
      await pOff.close();

      // Two splits summing to the gap must NOT explain it. Matching a COMBINATION
      // is the step from shape-matching to concluding, and it is not taken.
      const pSum = await newHarnessPage({ tab: 'loans', mutate: verBooks(256289.88 + 2554.21) });
      const rs = rowOf((await pSum.surfaces()).loans.closeBand, 'Verdant Capital Loan');
      t.close(rs.varianceN, 5261.82, 0.005,
              'ce12 boundary: a gap equal to Period 14 + Period 6 together is $5,261.82');
      t.eq(rs.band, 'material',
           'ce12 boundary: ...and is NOT explained — one split, never a combination');
      await pSum.close();
    }

    /* ── 13 ── A STALE BOOKS BALANCE MUST NOT BEAT AN EXACT STATEMENT ────── */
    // The first cut took the newest books row with as_of <= the date asked for
    // and let it win unconditionally. One missed reconciliation-run month then
    // subtracts August's principal from June's balance — on every loan at once,
    // on the screen whose job is to say "ready for your accountant". BayFirst
    // SBA 2 holds a real portal_manual_pull dated exactly 2026-07-31 and would
    // have lost to a stale June books row for an invented $858.66.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        const bf = d.loan_accounts.find(x => x.xero_account_name === 'BayFirst SBA 2');
        d.loan_book_balances.push({
          id: 'harness-bf2-stale', loan_account_id: bf.id, as_of: '2026-05-31',
          balance: 999999, basis: 'xero_rebuild', run_id: null,
          detail: { staged_entries_at_or_before: 0 }, computed_at: '2026-05-31T12:00:00Z',
        });
      } });
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
      t.ok(/ready for your accountant/i.test(cb.lead || '') || cb.gateByKey['variance'].ok,
           'ce13: ...so nothing about the close changed', `lead=${JSON.stringify(cb.lead)}`);

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
      t.eq(r.ties, true, 'ce14: ...and the row still ties');
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
        t.eq(b.ties, false, 'ce14 CONTROL: ...and the tie broke, on a number nobody can interpret');
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
      const pOk = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        d.loan_splits.forEach(sp => {
          if (String(sp.period_label || '').slice(0, 7) === MONTH &&
              ['pending_review', 'needs_attention'].includes(sp.status)) sp.status = 'posted';
        });
      } });
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
      t.ok(/agrees with the schedule/.test(varCell || ''),
           'ce17: the All Loans row says it agrees with the SCHEDULE', `row=${JSON.stringify(varCell)}`);
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

    /* ── 18 ── AN EMPTY SUBTOTAL DOES NOT EXIST, AND NEVER TIES ──────────── */
    // A "$0.00" in the variance column of a line counting zero loans is a
    // verdict nobody earned, printed in the one column a reader scans for them.
    {
      const p = await newHarnessPage({ tab: 'loans', mutate: (d) => {
        // No real lender document anywhere: grade A becomes impossible, grade B
        // survives on the two loans carrying the recorded policy.
        const real = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull'];
        d.loan_statements = d.loan_statements.filter(st => !real.includes(String(st.source || '')));
      } });
      const cb = (await p.surfaces()).loans.closeBand;
      t.eq(cb.rows.filter(r => r.grade === 'A').length, 0, 'ce18: the scenario really does leave no grade-A loan');
      t.ok(!cb.subtotals.A, 'ce18: ...so no grade-A subtotal row is rendered at all',
           JSON.stringify(Object.keys(cb.subtotals)));
      t.ok(!!cb.subtotals.B, 'ce18: ...while grade B, which still has loans, keeps its line');
      t.eq(Object.keys(cb.subtotals).filter(k => cb.subtotals[k].count === 0 && cb.subtotals[k].ties).length, 0,
           'ce18: ...and no subtotal claims a tie over zero loans');

      // ── CONTROL ── render it anyway
      const rev = await revertFn(p, 'renderLoansCloseBand', EDITS('empty-subtotal-renders'));
      t.ok(rev.ok, 'ce18 CONTROL: an always-rendered subtotal could be rebuilt', JSON.stringify(rev.missing));
      if (rev.ok) {
        const b = (await p.surfaces()).loans.closeBand;
        t.ok(!!b.subtotals.A, 'ce18 CONTROL: pre-review, an empty grade-A line rendered');
        t.eq(b.subtotals.A.count, 0, 'ce18 CONTROL: ...over zero loans');
        t.eq(b.subtotals.A.ties, true,
             'ce18 CONTROL: ...carrying data-tie — a $0.00 agreement nobody earned, in the verdict column');
      }
      await restoreFns(p);
      await p.close();
    }
  },
});


/* ═══════════════════════════════ RUNNER ═════════════════════════════════ */
if (LIST) { console.log(GROUPS.map(g => g.name).join('\n')); process.exit(0); }

const cr = await getChromium();
const launchOpts = { args: ['--allow-file-access-from-files', '--disable-web-security'] };
if (process.env.WR_CHROMIUM) launchOpts.executablePath = process.env.WR_CHROMIUM;
browser = await cr.launch(launchOpts);

console.log(`\nWashRoute Bookkeeping harness`);
console.log(`  index   ${INDEX}`);
console.log(`  fixture ${FIXTURE} (${baseFixture._meta?.pulled_at || 'unknown vintage'})`);
console.log(`  rows    ${FIXTURE_TABLES.map(t => `${t}=${baseFixture[t].length}`).join(' ')}\n`);

for (const g of GROUPS) {
  if (ONLY && g.name !== ONLY) continue;
  currentGroup = g.name;
  console.log(`${C.y}▸ ${g.name}${C.x}`);
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
