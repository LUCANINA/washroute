// ============================================================
// GROUP B OUTREACH — Email to customers with unpaid orders, no card on file
// Run this from the browser console while on the admin dashboard
// Sends one email per customer with their outstanding balance
// and a link to add their card at app.familylaundry.com
// ============================================================
//
// DRY RUN MODE: Set DRY_RUN = true to preview without sending
// Set DRY_RUN = false when you're ready to actually send
//
const DRY_RUN = true;

(async () => {
  console.log(DRY_RUN ? '--- DRY RUN MODE (no emails will be sent) ---' : '--- LIVE MODE ---');

  // ── 1. Fetch all failed/unpaid orders ────────────────────────────────────
  const { data: orders, error: ordersErr } = await db
    .from('orders')
    .select(`
      id, total_amount, order_number, customer_id, billing_status, status,
      customers!inner(
        id, first_name_cache, last_name_cache, phone_cache, email_cache,
        stripe_customer_id, pricelist
      )
    `)
    .or('billing_status.eq.failed,billing_status.is.null')
    .not('status', 'in', '(cancelled,skipped,on_hold,scheduled,pickup_failed)');

  if (ordersErr) { console.error('Failed to fetch orders:', ordersErr.message); return; }
  console.log(`Found ${orders.length} total unpaid/failed orders`);

  // ── 2. Exclude Commercial-price-list customers (they're invoiced, not card-charged) ──
  const nonCommercial = orders.filter(o => o.customers?.pricelist !== 'Commercial');

  // ── 3. Identify unique customers who have a Stripe ID ────────────────────
  const customerMap = {};
  for (const o of nonCommercial) {
    const c = o.customers;
    if (!c?.stripe_customer_id) continue;
    const cid = c.id;
    if (!customerMap[cid]) {
      customerMap[cid] = {
        id: cid,
        name: c.first_name_cache || 'there',
        email: c.email_cache,
        phone: c.phone_cache,
        totalOwed: 0,
        orders: [],
      };
    }
    customerMap[cid].totalOwed += parseFloat(o.total_amount || 0);
    customerMap[cid].orders.push(o.order_number);
  }

  const customerIds = Object.keys(customerMap);

  // ── 4. Find which customers have a card on file ───────────────────────────
  const { data: paymentMethods, error: pmErr } = await db
    .from('customer_payment_methods')
    .select('customer_id')
    .in('customer_id', customerIds);

  if (pmErr) { console.error('Failed to fetch payment methods:', pmErr.message); return; }

  const customersWithCard = new Set(paymentMethods.map(pm => pm.customer_id));

  // ── 5. Group B = has Stripe ID, no card on file ───────────────────────────
  const groupB = customerIds
    .filter(cid => !customersWithCard.has(cid))
    .map(cid => customerMap[cid]);

  console.log(`\nGroup B (no card on file): ${groupB.length} customers`);
  console.log('─'.repeat(70));

  const withEmail    = groupB.filter(c => c.email);
  const withoutEmail = groupB.filter(c => !c.email);

  withEmail.forEach(c => {
    const amt = c.totalOwed.toFixed(2);
    console.log(`  ${c.name.padEnd(22)} $${amt}  ${c.email}`);
  });
  if (withoutEmail.length) {
    console.log(`\n  No email on file (skipped):`);
    withoutEmail.forEach(c => console.log(`    ${c.name} — $${c.totalOwed.toFixed(2)}`));
  }
  console.log('─'.repeat(70));

  if (!withEmail.length) {
    console.log('No customers with email addresses to contact.');
    return;
  }

  // ── 6. Confirm before sending ─────────────────────────────────────────────
  if (!DRY_RUN) {
    const ok = confirm(`About to send emails to ${withEmail.length} customers. Continue?`);
    if (!ok) { console.log('Cancelled.'); return; }
  }

  // ── 7. Send emails ────────────────────────────────────────────────────────
  const results = { sent: [], skipped: [], failed: [] };

  for (const c of withEmail) {
    const amt       = c.totalOwed.toFixed(2);
    const firstName = c.name.charAt(0).toUpperCase() + c.name.slice(1);
    const subject   = 'Your Family Laundry balance';

    const htmlBody = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1e293b">
  <p style="font-size:15px;line-height:1.7;margin:0 0 16px">Hi ${firstName},</p>
  <p style="font-size:15px;line-height:1.7;margin:0 0 16px">
    We recently moved to a new platform and your outstanding balance of
    <strong>$${amt}</strong> has not yet been processed.
  </p>
  <p style="font-size:15px;line-height:1.7;margin:0 0 24px">
    To keep your pickups going, please log in and add your payment info at the link below.
    It only takes a minute.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="https://app.familylaundry.com"
       style="background:#1e293b;color:#ffffff;padding:14px 32px;border-radius:8px;
              text-decoration:none;font-weight:600;font-size:15px;display:inline-block;
              letter-spacing:0.01em">
      Add Payment Info
    </a>
  </div>
  <p style="font-size:14px;line-height:1.6;color:#64748b;margin:0 0 8px">
    If you have any questions, just reply to this email or send us a text.
    We appreciate your business and look forward to continuing to serve you.
  </p>
  <p style="font-size:14px;color:#64748b;margin:0">
    Thanks,<br>
    The Family Laundry Team
  </p>
</div>`;

    if (DRY_RUN) {
      console.log(`[DRY RUN] To: ${c.email}\n  Subject: ${subject}\n  Balance: $${amt}\n`);
      results.sent.push(c);
      continue;
    }

    try {
      const res = await fetch(`${SUPA_URL}/functions/v1/send-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPA_ANON_KEY,
        },
        body: JSON.stringify({
          customer_id: c.id,
          to_email: c.email,
          subject,
          body: htmlBody,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`  Sent to ${c.name} (${c.email})`);
        results.sent.push(c);
      } else {
        console.warn(`  Failed for ${c.name}: ${data.error || res.status}`);
        results.failed.push({ ...c, error: data.error || res.status });
      }
    } catch (e) {
      console.error(`  Error for ${c.name}: ${e.message}`);
      results.failed.push({ ...c, error: e.message });
    }

    // Brief pause between sends
    await new Promise(r => setTimeout(r, 400));
  }

  // ── 8. Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== ${DRY_RUN ? 'DRY RUN COMPLETE' : 'DONE'} ===`);
  console.log(`Sent:    ${results.sent.length}`);
  console.log(`Skipped: ${withoutEmail.length} (no email on file)`);
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
