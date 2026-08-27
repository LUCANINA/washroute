/* ─────────────────────────────────────────────────────────────────────────
   WashRoute Bookkeeping harness — offline Supabase stand-in.

   Injected with addInitScript BEFORE index.html's own <script> runs, so the
   page's `const { createClient } = supabase` picks this up instead of the
   (blocked) CDN bundle.

   Serves REAL rows pulled by SELECT from production. The only rules that
   matter for fidelity:
     * .order(col,{ascending}) ACTUALLY SORTS, with Postgres NULL ordering
       (ASC → NULLS LAST, DESC → NULLS FIRST). A no-op order() silently
       changes which row wins a "latest" pick, which is the exact class of
       bug this harness exists to find.
     * every table can be delayed, held open, or made to fail independently,
       so cold-boot order and loader races are reproducible.
   ───────────────────────────────────────────────────────────────────────── */
(() => {
  const CTL = window.__WR_STUB = {
    latency: {},          // { table: ms }  — default 0
    defaultLatency: 0,
    hold: new Set(),      // tables whose response is parked until released
    errors: {},           // { table: {message, code, details, hint} }
    log: { queries: [], toasts: [], consoleErrors: [], unknownTables: new Set() },
    data: window.__WR_FIXTURE,
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

  function cmp(a, b, asc) {
    // Postgres: ASC → NULLS LAST, DESC → NULLS FIRST (PostgREST default).
    const an = a == null, bn = b == null;
    if (an && bn) return 0;
    if (an) return asc ? 1 : -1;
    if (bn) return asc ? -1 : 1;
    if (typeof a === 'number' && typeof b === 'number') return asc ? a - b : b - a;
    if (typeof a === 'boolean' || typeof b === 'boolean') {
      const av = a ? 1 : 0, bv = b ? 1 : 0;
      return asc ? av - bv : bv - av;
    }
    const as = String(a), bs = String(b);
    const r = as < bs ? -1 : as > bs ? 1 : 0;
    return asc ? r : -r;
  }

  const OPS = {
    eq:  (v, x) => v === x || String(v) === String(x),
    neq: (v, x) => !(v === x || String(v) === String(x)),
    gt:  (v, x) => v != null && v > x,
    gte: (v, x) => v != null && v >= x,
    lt:  (v, x) => v != null && v < x,
    lte: (v, x) => v != null && v <= x,
    is:  (v, x) => (x === null ? v == null : v === x),
    in:  (v, x) => (x || []).some(y => y === v || String(y) === String(v)),
    like:  (v, x) => new RegExp('^' + String(x).replace(/%/g, '.*') + '$').test(String(v)),
    ilike: (v, x) => new RegExp('^' + String(x).replace(/%/g, '.*') + '$', 'i').test(String(v)),
    not_is: (v, x) => !(x === null ? v == null : v === x),
  };

  class QB {
    constructor(table) {
      this.table = table;
      this._filters = [];
      this._orders = [];
      this._limit = null;
      this._single = false;
      this._selected = null;
    }
    select(cols) { this._selected = cols; return this; }
    order(col, opts) { this._orders.push({ col, asc: !(opts && opts.ascending === false) }); return this; }
    limit(n) { this._limit = n; return this; }
    range(a, b) { this._range = [a, b]; return this; }
    single() { this._single = true; return this; }
    maybeSingle() { this._single = 'maybe'; return this; }
    // write paths — the harness never exercises them, but they must not throw
    insert() { this._write = 'insert'; return this; }
    update() { this._write = 'update'; return this; }
    upsert() { this._write = 'upsert'; return this; }
    delete() { this._write = 'delete'; return this; }
    eq(col, val)   { this._filters.push({ col, op: 'eq',   val }); return this; }
    neq(col, val)  { this._filters.push({ col, op: 'neq',  val }); return this; }
    gt(col, val)   { this._filters.push({ col, op: 'gt',   val }); return this; }
    gte(col, val)  { this._filters.push({ col, op: 'gte',  val }); return this; }
    lt(col, val)   { this._filters.push({ col, op: 'lt',   val }); return this; }
    lte(col, val)  { this._filters.push({ col, op: 'lte',  val }); return this; }
    is(col, val)   { this._filters.push({ col, op: 'is',   val }); return this; }
    in(col, val)   { this._filters.push({ col, op: 'in',   val }); return this; }
    like(col, val) { this._filters.push({ col, op: 'like', val }); return this; }
    ilike(col, val){ this._filters.push({ col, op: 'ilike',val }); return this; }
    contains(col, val) { this._filters.push({ col, op: 'contains', val }); return this; }
    match(obj) { for (const k of Object.keys(obj || {})) this._filters.push({ col: k, op: 'eq', val: obj[k] }); return this; }
    or(expr) { this._filters.push({ or: expr }); return this; }
    not(col, op, val) { this._filters.push({ col, op: 'not_' + op, val }); return this; }
    filter(col, op, val) { this._filters.push({ col, op, val }); return this; }
    abortSignal() { return this; }

    async _run() {
      const t = this.table;
      CTL.log.queries.push({ table: t, orders: this._orders.map(o => o.col + (o.asc ? '↑' : '↓')), at: Date.now() });
      if (this._write) return { data: null, error: { message: 'harness: writes are blocked', code: 'HARNESS_RO' } };

      while (CTL.hold.has(t)) await sleep(5);
      const lat = CTL.latency[t] != null ? CTL.latency[t] : CTL.defaultLatency;
      if (lat) await sleep(lat);

      if (CTL.errors[t]) return { data: null, error: Object.assign({ code: 'HARNESS', details: '', hint: '' }, CTL.errors[t]) };

      let rows = CTL.data[t];
      if (!rows) { CTL.log.unknownTables.add(t); rows = []; }
      rows = clone(rows);

      for (const f of this._filters) {
        if (f.or) continue;                       // not used by Bookkeeping
        const fn = OPS[f.op];
        if (!fn) continue;
        rows = rows.filter(r => fn(r[f.col], f.val));
      }
      for (let i = this._orders.length - 1; i >= 0; i--) {
        const o = this._orders[i];
        rows = rows.map((r, idx) => [r, idx])
                   .sort((A, B) => cmp(A[0][o.col], B[0][o.col], o.asc) || (A[1] - B[1]))
                   .map(x => x[0]);
      }
      if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
      if (this._limit != null) rows = rows.slice(0, this._limit);
      if (this._single) {
        if (!rows.length) return this._single === 'maybe'
          ? { data: null, error: null }
          : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
        return { data: rows[0], error: null };
      }
      return { data: rows, error: null, count: rows.length };
    }
    then(res, rej) { return this._run().then(res, rej); }
    catch(f) { return this._run().catch(f); }
    finally(f) { return this._run().finally(f); }
  }

  const noSession = { data: { session: null }, error: null };
  const client = {
    from: (t) => new QB(t),
    rpc: () => Promise.resolve({ data: null, error: { message: 'harness: rpc blocked', code: 'HARNESS_RO' } }),
    auth: {
      getSession: async () => noSession,
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: {}, error: { message: 'harness: offline' } }),
      signOut: async () => ({ error: null }),
      setSession: async () => noSession,
      refreshSession: async () => noSession,
      updateUser: async () => ({ data: {}, error: null }),
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      exchangeCodeForSession: async () => noSession,
    },
    channel: () => { const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }; return ch; },
    removeChannel: () => {},
    removeAllChannels: () => {},
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: null, error: { message: 'harness: offline' } }),
        download: async () => ({ data: null, error: { message: 'harness: offline' } }),
        upload: async () => ({ data: null, error: { message: 'harness: offline' } }),
        remove: async () => ({ data: null, error: { message: 'harness: offline' } }),
        getPublicUrl: () => ({ data: { publicUrl: 'about:blank' } }),
      }),
    },
    functions: { invoke: async () => ({ data: null, error: { message: 'harness: offline' } }) },
  };

  window.supabase = { createClient: () => client };

  // Third-party globals the page expects from blocked CDN <script> tags.
  const noop = () => {};
  window.lucide = window.lucide || { createIcons: noop };
  window.Chart = window.Chart || function () { return { destroy: noop, update: noop, data: {}, options: {} }; };
  window.L = window.L || new Proxy({}, { get: () => () => new Proxy({}, { get: () => noop }) });
  window.Stripe = window.Stripe || (() => ({ elements: () => ({ create: () => ({ mount: noop, on: noop, destroy: noop }) }) }));
  window.JsBarcode = window.JsBarcode || noop;
  window.jspdf = window.jspdf || { jsPDF: function () { return new Proxy({}, { get: () => () => {} }); } };
  window.pdfjsLib = window.pdfjsLib || { getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }), GlobalWorkerOptions: {} };

  // Capture toasts + console errors — a failed loader's only user-visible
  // signal is a toast, so "did the UI say so" is an assertion about this log.
  window.addEventListener('DOMContentLoaded', () => {
    const orig = window.showToast;
    window.showToast = function (msg, kind) {
      CTL.log.toasts.push({ msg: String(msg), kind: kind || 'info', at: Date.now() });
      try { if (typeof orig === 'function') return orig.apply(this, arguments); } catch (_) {}
    };
  });
  const ce = console.error.bind(console);
  console.error = function (...a) { CTL.log.consoleErrors.push(a.map(String).join(' ')); ce(...a); };
})();
