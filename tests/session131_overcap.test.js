// WashRoute session 131 sanity tests — paste into browser console.
// Run these in the CUSTOMER APP (customer-app/index.html) because that's where `db` + zones are.
//
// What this covers:
//   Phase 2 — DB is verified separately via execute_sql (not here).
//   Phase 1 — RCC badge is verified manually (see checklist in commit message / PROJECT-NOTES).
//   Phase 3 — this script exercises get_nearest_available_slots end-to-end.
//
// To run: paste the whole thing into the console on the customer app page.

(async () => {
  console.log('🧪 Session 131 — Phase 3 RPC sanity check');

  // 1. Pick any active zone
  const { data: tmpl, error: tmplErr } = await db
    .from('route_templates')
    .select('zone_id, name')
    .eq('is_active', true)
    .not('zone_id', 'is', null)
    .limit(1)
    .single();

  if (tmplErr || !tmpl) {
    console.error('❌ Could not find an active zone template', tmplErr);
    return;
  }
  console.log('Using zone:', tmpl.zone_id, `(${tmpl.name})`);

  // 2. Call the RPC: 3 days out, 10am, pickup, 3 results, ±2 day radius
  const preferredDate = new Date();
  preferredDate.setDate(preferredDate.getDate() + 3);
  const isoDate = preferredDate.toISOString().slice(0, 10);

  const { data, error } = await db.rpc('get_nearest_available_slots', {
    p_zone_id: tmpl.zone_id,
    p_preferred_date: isoDate,
    p_preferred_time: '10:00:00',
    p_stop_type: 'pickup',
    p_limit: 3,
    p_day_radius: 2,
  });

  if (error) {
    console.error('❌ RPC failed', error);
    return;
  }

  if (!data || data.length === 0) {
    console.warn('⚠️  RPC returned zero rows — either no active templates for that date range or all full. Not a failure.');
    return;
  }

  console.table(data);

  // 3. Invariants
  let pass = true;
  for (const row of data) {
    if (row.active_stops >= row.sub_window_limit) {
      console.error('❌ FAIL — RPC returned a FULL slot (active_stops >= limit)', row);
      pass = false;
    }
    if (typeof row.distance_minutes !== 'number' || row.distance_minutes < 0) {
      console.error('❌ FAIL — distance_minutes invalid', row);
      pass = false;
    }
  }

  // 4. Verify ordering
  for (let i = 1; i < data.length; i++) {
    if (data[i].distance_minutes < data[i - 1].distance_minutes) {
      console.error('❌ FAIL — rows not ordered by distance_minutes ASC', data);
      pass = false;
      break;
    }
  }

  if (pass) {
    console.log(`✅ PASS — ${data.length} open slots, all under capacity, ordered by distance.`);
  }

  // 5. Input guard
  const { error: guardErr } = await db.rpc('get_nearest_available_slots', {
    p_zone_id: tmpl.zone_id,
    p_preferred_date: isoDate,
    p_preferred_time: '10:00:00',
    p_stop_type: 'bogus',
    p_limit: 3,
    p_day_radius: 2,
  });
  if (guardErr && guardErr.message.includes("must be 'pickup' or 'delivery'")) {
    console.log('✅ PASS — input guard rejects invalid stop_type');
  } else {
    console.error('❌ FAIL — guard did not fire as expected', guardErr);
  }
})();
