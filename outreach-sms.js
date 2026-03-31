// ============================================================
// GROUP B OUTREACH — Customers with unpaid orders, no card on file
// Run this from the browser console while on the admin dashboard
// Sends one SMS per customer summarizing their outstanding balance
// and directing them to add a card at app.familylaundry.com
// ============================================================
//
// DRY RUN MODE: Set DRY_RUN = true to preview messages without sending
// Set DRY_RUN = false when you're ready to actually send
//
const DRY_RUN = true;

(async () => {
  console.log(DRY_RUN ? '--- DRY RUN MODE (no SMS will be sent) ---' : '--- LIVE MODE ---');

  // ── 1. Fetch all failed/unpaid orders (non-commercial) ──────────────────
  const { data: orders, error: ordersErr } = await db
    .from('orders')
    .select(`
      id, total_amount, order_number, customer_id, billing_status, status,
      customers!inner(
        id, first_name_cache, last_name_cache, phone_cache,
        stripe_customer_id, customer_type
      )
    `)
    .or('billing_status.eq.failed,billing_status.is.null')
    .not('status', 'in', '(cancelled,skipped,on_hold,scheduled,pickup_failed)');

  if (ordersErr) { console.error('Failed to fetch orders:', ordersErr.message); return; }
  console.log(`Found ${orders.length} total unpaid/failed orders`);

  // ── 2. Exclude commercial customers ─────────────────────────────────────
  const nonCommercial = orders.filter(o => {
    const ct = (o.customers?.customer_type || '').toLowerCase();
    return ct !== 'commercial';
  });
  console.log(`After excluding commercial: ${nonCommercial.length} orders`);

  // ── 3. Identify unique customer IDs who have a Stripe ID ─────────────────
  const customerMap = {};
  for (const o of nonCommercial) {
    const c = o.customers;
    if (!c?.stripe_customer_id) continue; // skip — no Stripe account at all
    const cid = c.id;
    if (!customerMap[cid]) {
      customerMap[cid] = {
        id: cid,
        name: c.first_name_cache || 'there',
        phone: c.phone_cache,
        totalOwed: 0,
        orders: [],
      };
    }
    customerMap[cid].totalOwed += parseFloat(o.total_amount || 0);
    customerMap[cid].orders.push(o.order_number);
  }

  const customerIds = Object.keys(customerMap);
  console.log(`Unique customers with Stripe ID and unpaid orders: ${customerIds.length}`);

  // ── 4. Find which of those customers have a card on file ─────────────────
  const { data: paymentMethods, error: pmErr } = await db
    .from('customer_payment_methods')
    .select('customer_id')
    .in('customer_id', customerIds);

  if (pmErr) { console.error('Failed to fetch payment methods:', pmErr.message); return; }

  const customersWithCard = new Set(paymentMethods.map(pm => pm.customer_id));
  console.log(`Customers with card on file: ${customersWithCard.size}`);

  // ── 5. Group B = has Stripe ID, no card on file ───────────────────────────
  const groupB = customerIds
    .filter(cid => !customersWithCard.has(cid))
    .map(cid => customerMap[cid]);

  console.log(`\nGroup B (no card on file): ${groupB.length} customers`);
  console.log('─'.repeat(60));
  groupB.forEach(c => {
    const amt = c.totalOwed.toFixed(2);
    console.log(`  ${c.name.padEnd(22)} $${amt}  ${c.phone || '(no phone)'}`);
  });
  console.log('─'.repeat(60));

  if (!groupB.length) {
    console.log('Nothing to send. All done.');
    return;
  }

  // ── 6. Confirm before sending ─────────────────────────────────────────────
  if (!DRY_RUN) {
    const ok = confirm(`About to send SMS to ${groupB.length} customers. Continue?`);
    if (!ok) { console.log('Cancelled.'); return; }
  }

  // ── 7. Send SMS ───────────────────────────────────────────────────────────
  const results = { sent: [], skipped: [], failed: [] };

  for (const c of groupB) {
    if (!c.phone) {
      console.warn(`  Skipping ${c.name} — no phone number on file`);
      results.skipped.push(c);
      continue;
    }

    const amt = c.totalOwed.toFixed(2);
    const firstName = c.name.charAt(0).toUpperCase() + c.name.slice(1);
    const message =
      `Hi ${firstName}, this is Family Laundry. We recently moved to a new platform and your ` +
      `balance of $${amt} has not yet been processed. To keep your pickups going, please add ` +
      `your payment info at app.familylaundry.com. Thanks.`;

    if (DRY_RUN) {
      console.log(`[DRY RUN] To: ${c.phone}\n  Message: ${message}\n`);
      results.sent.push(c);
      continue;
    }

    try {
      const res = await fetch(`${SUPA_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPA_ANON_KEY}`,
        },
        body: JSON.stringify({ to: c.phone, body: message, customer_id: c.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`  Sent to ${c.name} (${c.phone})`);
        results.sent.push(c);
      } else {
        console.warn(`  Failed for ${c.name}: ${data.error || res.status}`);
        results.failed.push({ ...c, error: data.error || res.status });
      }
    } catch (e) {
      console.error(`  Error for ${c.name}: ${e.message}`);
      results.failed.push({ ...c, error: e.message });
    }

    // Pause briefly between sends to avoid rate limiting
    await new Promise(r => setTimeout(r, 600));
  }

  // ── 8. Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== ${DRY_RUN ? 'DRY RUN COMPLETE' : 'DONE'} ===`);
  console.log(`Sent:    ${results.sent.length}`);
  console.log(`Skipped: ${results.skipped.length} (no phone number)`);
  console.log(`Failed:  ${results.failed.length}`);
  if (results.failed.length) {
    console.log('\nFailed:');
    results.failed.forEach(c => console.log(`  ${c.name}: ${c.error}`));
  }
  if (DRY_RUN) {
    console.log('\nTo send for real, change DRY_RUN = false at the top and run again.');
  }
  return results;
})();
