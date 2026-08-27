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
    const rows = [...cb.querySelectorAll('tbody tr')].map(tr => {
      const tds = [...tr.children];
      const c = tds.map(td => td.textContent.replace(/\s+/g, ' ').trim());
      return { loan: c[0], opening: c[1], principal: c[2], interest: c[3],
               computed: c[4], perLender: c[5], variance: c[6], inXero: c[7],
               openingN: num(tds[1]), principalN: num(tds[2]), interestN: num(tds[3]),
               computedN: num(tds[4]), perLenderN: num(tds[5]),
               ties: tds[6] ? tds[6].hasAttribute('data-tie') : false,
               varianceN: tds[6] && tds[6].getAttribute('data-variance')
                 ? Number(tds[6].getAttribute('data-variance')) : (tds[6] && tds[6].hasAttribute('data-tie') ? 0 : null) };
    });
    const foot = [...cb.querySelectorAll('tfoot tr')].map(tr =>
      [...tr.children].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
    closeBand = {
      head: txt('#loans-close-band .lcb-head h3'),
      lead: txt('#loans-close-band .lcb-lead'),
      gates: [...cb.querySelectorAll('.lcb-gate')].map(g => ({ text: g.textContent.replace(/\s+/g, ' ').trim(), ok: g.classList.contains('ok') })),
      headers: [...cb.querySelectorAll('thead th')].map(th => th.textContent.replace(/\s+/g, ' ').trim()),
      rows, foot,
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

/* ── phrases that claim "everything is fine" ──────────────────────────────── */
const ALL_CLEAR = /(Everything is reconciled|nothing needs you right now|ready for your accountant|all \d+ statements in|Nothing outstanding|nothing needs doing|you're all caught up|no issues found)/i;
const CONFIDENT_ZERO = /\$0(?:\.00)?\b/;

/* ═══════════════════════════ SCENARIO GROUPS ═════════════════════════════ */
const GROUPS = [];

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
      const p = await newHarnessPage({
        tab, sub, settle: false,
        hold: ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
               'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
               'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
               'bk_issue_dismissals', 'bookkeeping_kpi_snapshots'],
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
      await p.release(...['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
        'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
        'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
        'bk_issue_dismissals', 'bookkeeping_kpi_snapshots']);
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
    // tfoot cell indices: 0=label ('N checkable loans'), 1=opening,
    // 2=principal, 3=interest, 4=computed, 5=perLender, 6=variance.
    const bandPrincipal = parseMoney(cb.foot0[2]) + (cb.excluded ? parseMoney(cb.excluded[2]) : 0);
    const bandInterest = parseMoney(cb.foot0[3]) + (cb.excluded ? parseMoney(cb.excluded[3]) : 0);
    t.eq(money(paidPrincipal), money(bandPrincipal),
         `"Paid last month" principal equals the close band's principal for the same month`);
    t.eq(money(paidInterest), money(bandInterest),
         `"Paid last month" interest equals the close band's interest for the same month`);
    t.eq(money(paidTotal), money(paidPrincipal + paidInterest), '"Paid last month" total equals its own principal + interest');

    // (e) statement coverage: the close band's gate vs the Client View checklist
    const gate = cb.gates[0].text;                       // "all N statements in" | "N statements outstanding"
    const gateOutstanding = /outstanding/.test(gate) ? Number(gate.match(/(\d+)/)[1]) : 0;
    const cvCount = s.client.checklistCount || '';
    const cvOutstanding = Number((cvCount.match(/(\d+)/) || [])[1] ?? (/(nothing|all)/i.test(cvCount) ? 0 : NaN));
    t.eq(gateOutstanding, cvOutstanding,
         'statement coverage: Loans close-band gate equals the Client View checklist count');

    // (f) close band arithmetic must tie across its own footer
    t.eq(money(parseMoney(cb.foot0[1]) - parseMoney(cb.foot0[2])), money(parseMoney(cb.foot0[4])),
         'close band footer: opening − principal = computed closing');

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
      t.eq(/not ready to close/.test(cb.lead || ''), anyBad,
           `close band — ${c.name}: headline agrees with its own gates`);
      // …and each gate must agree with the rows underneath it.
      const tieGate = cb.gates[1].text.match(/^(\d+) loans? tie exactly/);
      if (tieGate) t.eq(Number(tieGate[1]), cb.rows.filter(r => r.ties).length,
        `close band — ${c.name}: "N loans tie exactly" equals the rows that actually tie`);
      const stmtGate = cb.gates[0].text.match(/^(\d+) statements? outstanding/);
      if (stmtGate) t.ok(Number(stmtGate[1]) >= cb.rows.filter(r => /not received/.test(r.perLender)).length - 0,
        `close band — ${c.name}: "N statements outstanding" covers every "not received" row`,
        `gate says ${stmtGate[1]}, ${cb.rows.filter(r => /not received/.test(r.perLender)).length} rows say "not received"`);
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
        t.notMatch(s.bodyText, /\b(pending_review|needs_attention|not_comparable|already_in_xero|xero_derived|amortization_schedule|email_pdf_upload|portal_manual_pull|lender_statement|xero_balance_snapshot)\b/,
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
           `${bad.length} loan(s): ` + bad.map(b => `${b.loan} basis=${b.basis} ${money(b.amount)}`).join(' · '));
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
      t.close(cbx.footVarianceN, absSum, 0.05,
        's236: the close-band variance total is the sum of ABSOLUTE row variances');
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
