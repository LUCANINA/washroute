/* ============================================================================
   Session 280 — refund the subscription-overage DOUBLE CHARGES
   ----------------------------------------------------------------------------
   WHY: overage was billed twice — once on the order (paid at the time) and
   again on the next subscription invoice. These 11 customers were charged the
   second time and never refunded. Mayumi Santos is NOT in this list; John
   already refunded her $134.75.

   HOW TO RUN
     1. Open the admin dashboard and log in as admin or manager.
     2. Open the browser console (Cmd+Option+J on Mac Chrome).
     3. Paste this whole file, press Enter.  -> it does a DRY RUN and prints a table.
     4. Read the table. If it looks right, type:   wrRefund.run()   and press Enter.

   Safety:
     - Dry run by default. Nothing moves until you call wrRefund.run().
     - Refunds one customer at a time, printing each result.
     - refund-charge refuses to over-refund, so re-running cannot double-refund.
     - suppress_sms is TRUE: no automatic text goes to these customers. Reach
       out yourself so the message explains what happened.
   ========================================================================== */
(() => {
  const REFUNDS = [
    { name: 'Christina Sauper Stratton', txn: 'b90320b4-187d-44fa-bf02-93fe04b9350c', amount: 19.25,  charged: '2026-07-06' },
    { name: 'Karla Shallenberger',       txn: 'cbef8bc6-0f8b-4237-b690-53c765c09072', amount: 30.25,  charged: '2026-07-10' },
    { name: 'Corey Keller',              txn: '2f2448a2-6f0d-4069-899c-f8e616f93c11', amount: 57.75,  charged: '2026-07-26' },
    { name: 'Rachel Lederman',           txn: '94c94e83-64bc-401c-b7d2-a4df3ba62b0a', amount: 63.25,  charged: '2026-08-08' },
    { name: 'Andrew Foster',             txn: '5ff1e030-1daa-44d2-8d75-dce2373156b5', amount: 77.00,  charged: '2026-08-08' },
    { name: 'Tess Smagorinsky',          txn: '8072bce8-3b38-4e7d-b58f-981b422c2130', amount: 13.75,  charged: '2026-08-12' },
    { name: 'Cole Bridge',               txn: '571c6273-dd93-416f-9db9-75fb4e762a8b', amount: 74.25,  charged: '2026-08-16' },
    { name: 'Amy Cummings',              txn: 'b18f08e1-97bc-4230-b063-bef4f351bd45', amount: 495.00, charged: '2026-08-24' },
    { name: 'Jamie Addington',           txn: 'db52efc6-0e8f-4583-89ae-b0cd3ada202f', amount: 24.75,  charged: '2026-08-31' },
    { name: 'Lo Ferris',                 txn: '0693d997-7a5f-43a2-8f1a-dc6e642e20e2', amount: 77.00,  charged: '2026-09-03' },
    { name: 'Christina Liebner',         txn: '583f2188-1934-47af-9558-c8e5dd567a21', amount: 46.75,  charged: '2026-09-06' },
  ];
  const REASON = 'Subscription overage double-charged (already paid on the order) — session 280';
  const total  = REFUNDS.reduce((s, r) => s + r.amount, 0);

  console.table(REFUNDS.map(r => ({ Customer: r.name, Charged: r.charged, Refund: '$' + r.amount.toFixed(2) })));
  console.log(`%cDRY RUN — ${REFUNDS.length} refunds totalling $${total.toFixed(2)}.`,
              'font-weight:bold;font-size:13px');
  console.log('%cType   wrRefund.run()   to actually issue them.', 'color:#b45309;font-weight:bold');

  async function run() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { console.error('Not logged in — log into the admin dashboard first.'); return; }

    const results = [];
    for (const r of REFUNDS) {
      try {
        const res = await fetch(`${SUPA_URL}/functions/v1/refund-charge`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPA_ANON_KEY,
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            transactionId: r.txn,
            amount: r.amount,
            reason: REASON,
            suppress_sms: true,
          }),
        });
        const body = await res.json();
        const ok = res.ok && !body.error;
        results.push({ Customer: r.name, Refund: '$' + r.amount.toFixed(2), Result: ok ? 'REFUNDED' : 'FAILED', Detail: ok ? (body.refund_id || '') : (body.error || res.status) });
        console.log(`${ok ? '✅' : '❌'} ${r.name} $${r.amount.toFixed(2)}`, ok ? '' : body);
      } catch (e) {
        results.push({ Customer: r.name, Refund: '$' + r.amount.toFixed(2), Result: 'ERROR', Detail: String(e) });
        console.error('❌', r.name, e);
      }
      await new Promise(z => setTimeout(z, 600));   // be gentle on Stripe
    }
    console.table(results);
    const done = results.filter(x => x.Result === 'REFUNDED').length;
    console.log(`%cFinished: ${done}/${REFUNDS.length} refunded.`, 'font-weight:bold;font-size:13px');
    if (done < REFUNDS.length) console.warn('Some failed — safe to re-run; already-refunded rows are rejected automatically.');
  }

  window.wrRefund = { run, list: REFUNDS, total };
})();
