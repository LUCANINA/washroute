// Session 371 — per-lb minimum order weight. Tests the REAL helpers, extracted from
// admin-dashboard/index.html and pos/index.html (not a transcription), and asserts
// the two apps compute identical results.
import fs from 'node:fs';
const grab = (file, name) => {
  const src = fs.readFileSync(file, 'utf8');
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found in ${file}`);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
};
const fmtMoney = n => '$' + Number(n).toFixed(2);
const admin = new Function('fmtMoney', grab('admin-dashboard/index.html', '_minLbsTopUp') + '; return _minLbsTopUp;')(fmtMoney);
const pos   = new Function(grab('pos/index.html', '_posMinLbsTopUp') + '; return _posMinLbsTopUp;')();

const COM  = { pricing_type: 'per_lb', base_price: '1.75', min_lbs: '25', min_lbs_from: '2026-12-01' };
const HCEB = { pricing_type: 'per_lb', base_price: '1.70', min_lbs: 25,   min_lbs_from: '2026-12-01' };
const DEC2 = { pickup_window_start: '2026-12-02T17:00:00Z' };
let fail = 0, n = 0;
const eq = (name, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, 'got', got, 'want', want); } };
for (const [app, f] of [['admin', admin], ['pos', pos]]) {
  const amt = (...a) => f(...a)?.amount ?? null;
  eq(`${app} 15 lbs Dec 2 → 10 lbs × 1.75`, amt(COM, 15, DEC2), 17.5);
  eq(`${app} lbs topped up`, f(COM, 15, DEC2)?.lbs, 10);
  eq(`${app} HCEB 14.6 lbs`, amt(HCEB, 14.6, DEC2), 17.68);
  eq(`${app} exactly 25 → none`, amt(COM, 25, DEC2), null);
  eq(`${app} 40 → none`, amt(COM, 40, DEC2), null);
  eq(`${app} weight 0 (not weighed) → none`, amt(COM, 0, DEC2), null);
  eq(`${app} before start date → none`, amt(COM, 15, { pickup_window_start: '2026-11-30T17:00:00Z' }), null);
  // 2026-12-01 03:00 UTC is still Nov 30 in Oakland
  eq(`${app} Pacific day, not UTC`, amt(COM, 15, { actual_pickup_at: '2026-12-01T03:00:00Z' }), null);
  eq(`${app} actual pickup wins over window`, amt(COM, 15, { actual_pickup_at: '2026-12-01T20:00:00Z', pickup_window_start: '2026-11-20T17:00:00Z' }), 17.5);
  eq(`${app} rewash → none`, amt(COM, 15, { ...DEC2, is_rewash: true }), null);
  eq(`${app} per-bag service → none`, amt({ ...COM, pricing_type: 'per_bag' }, 15, DEC2), null);
  eq(`${app} no minimum set → none`, amt({ ...COM, min_lbs: null }, 15, DEC2), null);
  eq(`${app} no start date → applies`, amt({ ...COM, min_lbs_from: null }, 15, {}), 17.5);
  eq(`${app} label`, f(COM, 15, DEC2)?.label, 'Minimum order adjustment · 10.0 lbs × $1.75/lb (25 lb minimum)');
}
// The two apps must agree on every case above.
for (const w of [0.5, 7, 14.6, 19.9, 24.9]) eq(`admin == pos @${w}`, admin(COM, w, DEC2), pos(COM, w, DEC2));
// Discriminates: remove the start-date guard and the "before start date" case must change.
const src = grab('admin-dashboard/index.html', '_minLbsTopUp');
if (!src.includes('if (refDay < ')) throw new Error('date guard text moved — update this test');
const broken = new Function('fmtMoney', src.replace('if (refDay < ', 'if (false && refDay < ') + '; return _minLbsTopUp;')(fmtMoney);
n++; if (broken(COM, 15, { pickup_window_start: '2026-11-30T17:00:00Z' }) === null) { fail++; console.log('FAIL inverse check did not go red'); }
console.log(`${n - fail}/${n} passed`); process.exit(fail ? 1 : 0);
