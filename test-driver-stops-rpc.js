// ─────────────────────────────────────────────────────────────────────────
// Session 161 — Driver stops RPC sanity check
//
// HOW TO RUN:
//   1. Open the DRIVER app in a desktop browser (Chrome/Safari).
//   2. Sign in AS A DRIVER (phone code or password) — NOT as admin. The RPC
//      authorizes by the logged-in driver, so an admin login returns nothing.
//      Easiest real driver to use: one with a route assigned today.
//   3. Open the browser console (Cmd+Option+J on Chrome, Cmd+Option+C on Safari).
//   4. Paste this whole file and press Enter.
//
// It works whether or not the new app build is deployed yet — the two database
// functions are already live, so this verifies them against a real driver
// session independently of the app deploy.
// ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('%c🧪 Driver stops RPC sanity check', 'font-weight:bold;font-size:14px');

  // 1. Confirm a driver session
  const { data: { user } } = await db.auth.getUser();
  if (!user) { console.error('❌ Not signed in. Open this in the driver app while logged in as a driver.'); return; }

  const { data: drv } = await db.from('drivers').select('id').eq('profile_id', user.id).maybeSingle();
  if (!drv) { console.error('❌ This login has no driver record — sign in as an actual driver, not admin.'); return; }
  console.log('Driver record:', drv.id);

  // 2. Today's routes for this driver
  const todayStr = (typeof today === 'function')
    ? today()
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const { data: routes, error: rErr } = await db.from('routes')
    .select('id, name, status').eq('driver_id', drv.id).eq('run_date', todayStr).neq('status', 'cancelled');
  if (rErr) { console.error('❌ routes query failed', rErr); return; }
  const routeIds = (routes || []).map(r => r.id);
  console.log(`Today (${todayStr}): ${routeIds.length} route(s) —`, (routes || []).map(r => r.name));
  if (!routeIds.length) { console.warn('⏭️ No routes today for this driver. Run on a day/driver with an assigned route.'); return; }

  let pass = true;

  // 3. NEW path — the RPC
  const t0 = performance.now();
  const { data: rpcStops, error: rpcErr } = await db.rpc('get_driver_route_stops', { p_route_ids: routeIds });
  const ms = Math.round(performance.now() - t0);
  if (rpcErr) { console.error('❌ get_driver_route_stops errored', rpcErr); return; }
  console.log(`✅ RPC returned ${rpcStops.length} stop(s) in ${ms}ms`);

  // 4. OLD path — the direct embed, for a live side-by-side comparison
  const { data: embedStops, error: eErr } = await db.from('route_stops')
    .select('*, orders(*, customers(*), services(*))')
    .in('route_id', routeIds).or(`driver_id.eq.${drv.id},driver_id.is.null`);
  if (eErr) {
    console.warn('(embed comparison query errored — that itself is a data point)', eErr);
  } else {
    const embedNullOrders = embedStops.filter(s => s.order_id && !s.orders).length;
    console.log(`   embed path: ${embedStops.length} stop(s), ${embedNullOrders} with a NULL order embed`);
    if (embedNullOrders > 0) {
      console.log(`%c   ⬆️ The bug is happening RIGHT NOW: the embed dropped ${embedNullOrders} order(s) the RPC kept.`, 'color:green;font-weight:bold');
    }
    if (rpcStops.length < embedStops.length) { pass = false; console.error('❌ RPC returned FEWER stops than the embed — investigate'); }
    else { console.log(`✅ RPC count >= embed count (${rpcStops.length} vs ${embedStops.length})`); }
  }

  // 5. Core assertion — every RPC stop has populated order + customer data
  const nullOrders = rpcStops.filter(s => s.order_id && !s.orders);
  if (nullOrders.length) { pass = false; console.error(`❌ ${nullOrders.length} stop(s) have a NULL .orders via the RPC`, nullOrders.map(s => s.id)); }
  else { console.log('✅ every stop with an order_id has a populated .orders'); }

  const nullCust = rpcStops.filter(s => s.orders && s.orders.customer_id && !s.orders.customers);
  if (nullCust.length) { console.warn(`⚠️ ${nullCust.length} order(s) have a customer_id but null .customers`, nullCust.map(s => s.id)); }
  else { console.log('✅ orders with a customer_id resolved their .customers'); }

  // 6. Shape check on a sample
  const s = rpcStops[0];
  if (s) {
    const okShape = ['stop_number', 'stop_type', 'status', 'route_id', 'order_id'].every(k => k in s);
    if (okShape) console.log('✅ stop shape OK (stop_number, stop_type, status, route_id, order_id present)');
    else { pass = false; console.error('❌ stop shape missing expected fields. Keys:', Object.keys(s)); }
  }

  // 7. Override RPC smoke test (empty is fine; must not error)
  const { data: ov, error: ovErr } = await db.rpc('get_driver_override_stops', { p_run_date: todayStr, p_exclude_route_ids: routeIds });
  if (ovErr) { pass = false; console.error('❌ get_driver_override_stops errored', ovErr); }
  else console.log(`✅ get_driver_override_stops ok — ${ov.length} override stop(s)`);

  console.log(pass
    ? '%c🟢 OVERALL: PASS — RPCs return complete, correctly-shaped data for this driver.'
    : '%c🔴 OVERALL: FAIL — see ❌ above. Do not rely on the deploy; consider rollback.',
    `font-weight:bold;font-size:14px;color:${pass ? 'green' : 'red'}`);
})();
