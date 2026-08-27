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
      // Case-insensitive on purpose: the assertion's job is "the headline says
      // it is not ready", not "the headline is capitalised the way it was in
      // August 2026". Session 241 made it the first words of the strip rather
      // than a clause inside one, and a test that fails on a capital letter is
      // a test that punishes copy edits.
      t.eq(/not ready to close/i.test(cb.lead || ''), anyBad,
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

const ALL_TABLES = [
  'loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents',
  'payroll_imports', 'payroll_import_employee_lines', 'payroll_departments', 'payroll_employees',
  'payroll_notices', 'reconciliation_runs', 'reconciliation_findings', 'loan_tie_outs',
  'bk_issue_dismissals', 'bookkeeping_kpi_snapshots',
];
const LOAN_TABLES = ['loan_accounts', 'loan_statements', 'loan_splits', 'loan_amortization_rows', 'loan_documents'];

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
               group: st.group, difference: st.difference == null ? null : Number(st.difference) };
    }));
    const g = (n) => (book.find(x => x.name === n) || {}).group;

    t.eq(book.length, 14, 'r0: the book really is 14 active loans');

    // ── tied and explained are the only two ways to be reconciled ──
    for (const n of ['Dexter Loan 2', 'Rapid Credit Line', 'Paypal 2'])
      t.eq(g(n), 'reconciled', `r0: ${n} (tied) is reconciled`);
    for (const n of ['BayFirst SBA Loan', 'BayFirst SBA 2', 'E-Transit Loan E6-7410'])
      t.eq(g(n), 'reconciled', `r0: ${n} (explained by later payments) is reconciled`);

    // ── an exception measured against a real lender document is red ──
    for (const n of ['PCV Good and Green Loan', 'Funding Circle Loan', 'E-Transit Loan - 4140',
                     'E-Transit Loan E4 -9744', 'E-Transit Loan E5-4751'])
      t.eq(g(n), 'variance', `r0: ${n} deviates from a real lender document — needs attention`);
    t.eq(g('EIDL SBA Loan'), 'variance',
         'r0: EIDL deviates against an emailed PDF, and with no materiality flag that reads as MATERIAL');

    // ── an exception measured against OUR OWN projection is never red ──
    const verdant = book.find(x => x.name === 'Verdant Capital Loan');
    t.eq(verdant.anchor, 'amortization_schedule', 'r0: Verdant really is anchored to our own schedule');
    t.eq(verdant.group, 'unverified', 'r0: ...so it needs a statement rather than a red flag');
    t.ok(verdant.group !== 'variance' && verdant.group !== 'reconciled',
         'r0: ...and is neither red nor green — it is not a fact about the world yet');

    // ── nothing to compare against is not "nothing wrong" ──
    const stripe = book.find(x => x.name === 'Stripe Capital Loan');
    t.eq(stripe.status, 'not_comparable', 'r0: Stripe Capital really has nothing to compare against');
    t.eq(stripe.group, 'na', 'r0: ...which is its own state');
    t.ok(stripe.group !== 'reconciled', 'r0: ...and never reads as reconciled — never checked is not a clean bill');

    // ── the denominator has to add up ──
    const counts = await p.evaluate(() => _bkRosterCounts());
    const sum = counts.reconciled + counts.variance + counts.unverified + counts.na + counts.unchecked + counts.immaterial;
    t.eq(sum, counts.total, 'r0: every active loan lands in exactly one group');
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

    t.eq(q.counts.reconciled, 6, 'r1: the six reconciled loans are still reconciled');
    t.ok(q.heads.includes('Reconciled (6)'), 'r1: the Reconciled group is on screen', JSON.stringify(q.heads));

    // A reconciled loan that carries open findings.
    const dex = rowFor(q, 'Dexter Loan 2');
    t.ok(!!dex, 'r1: Dexter Loan 2 (tied, but carrying findings) renders in the roster');
    t.eq(dex && dex.dot, 'amber', 'r1: a reconciled loan with open findings gets an AMBER dot, not a plain green one');
    t.ok(/still need/.test((dex || {}).reason || ''),
         'r1: ...and says so — "still need a look" rather than an unqualified all-clear',
         `reason=${JSON.stringify((dex || {}).reason)}`);
    const dexKids = kidsFor(q, 'Dexter Loan 2');
    t.eq(dexKids.childRows, 2, 'r1: both of Dexter Loan 2\'s open findings render UNDER it');
    t.ok(dexKids.childNames.some(n => /no lender document on file/.test(n)),
         'r1: ...including the stale_anchor finding by name', JSON.stringify(dexKids.childNames));

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
      const bDex = rowFor(b, 'Dexter Loan 2');
      t.eq(bDex && bDex.dot, 'green', 'r1 CONTROL: pre-fix, the same loan showed a plain green dot');
      t.eq(kidsFor(b, 'Dexter Loan 2').childRows, 0, 'r1 CONTROL: pre-fix, its findings rendered nowhere');
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
    t.eq(q2.counts.immaterial, 1, 'r1: an immaterial tie-out moves the loan out of "needs attention"');
    t.eq(q2.counts.variance, 5, 'r1: ...and the variance count drops by exactly one');
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
    const orphanHead = q.heads.find(h => /Not tied to one loan/.test(h));
    t.eq(orphanHead, 'Not tied to one loan (3)',
         'r2: the two findings on the now-inactive loan join the orphan group');

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
      t.eq(b.heads.find(h => /Not tied to one loan/.test(h)), 'Not tied to one loan (1)',
           'r2 CONTROL: pre-fix, it was not counted as an orphan either');
      t.ok(b.itemNames.filter(n => !b.text.includes(n)).length === 2,
           'r2 CONTROL: pre-fix, exactly the two findings on that loan were dropped',
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
    t.ok(s.end.renders.some(r => r.total === 14 && r.reconciled === 6 && r.ready),
         'r4: ...and one after, with the real 6-of-14', JSON.stringify(s.end.renders));
    t.eq(s.mid.cf, 0, 'r4: no confetti mid-load');
    t.eq(s.end.cf, 0, 'r4: no confetti when a two-phase load merely fills in the counts');

    // The reward still has to be reachable, or "never fires" would pass too.
    const earn = await ship.p.evaluate(() => {
      const before = window.__cf;
      const ex = (_loanTieOuts || []).find(x => x.status === 'exception');
      ex.status = 'tied';                       // a loan is reconciled, for real
      renderBookkeepingOverview();
      return { before, after: window.__cf, reconciled: _bkRosterCounts().reconciled };
    });
    t.eq(earn.reconciled, 7, 'r4: a loan genuinely went from exception to tied');
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
