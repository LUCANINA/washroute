// ─────────────────────────────────────────────────────────────────────────────
// Sanity check — "Processed at X · folded by Y"  (session 326)
// Paste into the browser console on admin.familylaundry.com while signed in as
// staff. READ-ONLY except for one stamp, which it reverses before finishing.
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('🧪 Processed-at: start');
  let pass = 0, fail = 0;
  const ok  = (m) => { pass++; console.log('✅ ' + m); };
  const bad = (m, e) => { fail++; console.error('❌ ' + m, e || ''); };

  // 1. The column comes back on the panel's own select.
  const { data: o, error: e1 } = await db.from('orders')
    .select('id, order_number, processed_site_id, folded_by:folded_by_id(name)')
    .not('folded_by_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1).single();
  if (e1 || !o) return bad('could not read an order (column missing from the API?)', e1);
  ok(`read order #${o.order_number} — processed_site_id = ${o.processed_site_id ?? 'null'}`);
  if (!('processed_site_id' in o)) bad('processed_site_id absent from the row');

  // 2. The queue filter is what gets stamped. '' = All sites = nothing recorded.
  const filt = localStorage.getItem('wr-proc-site-filter');
  console.log(filt === null ? 'ℹ️ queue filter unset — defaults to the default site on load'
            : filt === ''   ? '⚠️ queue filter is "All sites" — intake here records NOTHING'
            : `ℹ️ queue filter = ${filt}`);

  // 3. Guard rejects a bogus site rather than writing junk.
  const { error: e2 } = await db.rpc('set_order_processed_site',
    { p_order_id: o.id, p_site_id: '00000000-0000-0000-0000-000000000000' });
  e2 ? ok('bogus site rejected: ' + e2.message) : bad('bogus site was ACCEPTED');

  // 4. Null site is a clean no-op, not an error.
  const { data: r3, error: e3 } = await db.rpc('set_order_processed_site',
    { p_order_id: o.id, p_site_id: null });
  (!e3 && r3 && r3.stamped === false) ? ok('null site = no-op (' + r3.reason + ')')
                                      : bad('null site did not no-op', e3 || r3);

  // 5. Round trip: stamp, verify, restore.
  const { data: sites } = await db.from('sites').select('id, name').limit(2);
  if (!sites || !sites.length) return bad('no sites found');
  const before = o.processed_site_id;
  const target = (sites.find(s => s.id !== before) || sites[0]);

  const { data: r5, error: e5 } = await db.rpc('set_order_processed_site',
    { p_order_id: o.id, p_site_id: target.id });
  if (e5) return bad('stamp failed', e5);
  ok(`stamped → ${r5.site}`);

  const { data: after } = await db.from('orders')
    .select('processed_site_id').eq('id', o.id).single();
  after?.processed_site_id === target.id ? ok('read back matches')
                                         : bad('read back mismatch', after);

  const { data: r6 } = await db.rpc('set_order_processed_site',
    { p_order_id: o.id, p_site_id: target.id });
  r6 && r6.stamped === false && r6.reason === 'unchanged'
    ? ok('idempotent — re-stamping the same site is a no-op')
    : bad('not idempotent', r6);

  // restore
  if (before) {
    await db.rpc('set_order_processed_site', { p_order_id: o.id, p_site_id: before });
    ok('restored original site');
  } else {
    console.warn(`⚠️ order #${o.order_number} had no site before; it now reads ${target.name}. ` +
                 `Clear it with:  UPDATE orders SET processed_site_id = NULL WHERE order_number = ${o.order_number};`);
  }

  console.log(`🧪 done — ${pass} passed, ${fail} failed`);
})();
