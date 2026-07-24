// Send the 7 apology SMS for the silent edit-modal reschedule bug.
// Run from the browser console while logged into the admin dashboard.
// Credits have already been applied via adjust_customer_credits RPC.
//
// Usage: open https://admin.familylaundry.com, log in, paste this whole
// script into the DevTools console, hit Enter. Output prints in console.

(async () => {
  const targets = [
    { name: 'Reanna',    phone: '+19253780839',   cust_id: 'c2d8ff52-2d13-4d27-98af-3428f7273cb6', ord: 5406, bump: 'a day later'    },
    { name: 'Evans',     phone: '+19173272034',   cust_id: 'dc231e6e-3116-4538-99b7-49bc8f9b2833', ord: 5452, bump: 'a day later'    },
    { name: 'Ellen',     phone: '+14086470933',   cust_id: '8b42c93c-b18f-4c49-8d43-a3ed37b90b0e', ord: 5387, bump: 'a day later'    },
    { name: 'Michele',   phone: '(510) 407-2764', cust_id: 'a71dea53-54c5-4d47-bc3c-6347c382283e', ord: 4719, bump: 'a day later'    },
    { name: 'Christine', phone: '(510) 365-1413', cust_id: 'c22879fc-25b9-4bb4-8234-58482f397973', ord: 4749, bump: 'two days later' },
    { name: 'Kalen',     phone: '(510) 333-1043', cust_id: '16dcab7b-edf7-44b8-a5a2-071b088f4557', ord: 4574, bump: 'a day later'    },
    { name: 'Denzeli',   phone: '+15102205487',   cust_id: 'f647f949-60df-407a-8bad-ab33907d7340', ord: 4532, bump: 'a day later'    },
  ];

  // Pull a fresh staff session token from the supabase-js client the admin
  // dashboard already has loaded as `db`.
  const { data: { session } } = await db.auth.getSession();
  if (!session?.access_token) {
    console.error('No staff session — make sure you are signed in to the admin dashboard.');
    return;
  }

  const results = [];
  for (const t of targets) {
    const body = `Hi ${t.name}, it's John from Family Laundry. We found a bug last week that quietly moved your delivery for order #${t.ord} ${t.bump} without you asking — that's on us. I've added a $10 credit to your account, and the bug is fixed. Sorry for the trouble!`;
    try {
      const res = await fetch(`${SUPA_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ to: t.phone, body, customer_id: t.cust_id }),
      });
      const data = await res.json().catch(() => ({}));
      results.push({ name: t.name, ord: t.ord, status: res.status, data });
      console.log(`${res.ok ? '✓' : '✗'} ${t.name} #${t.ord} — HTTP ${res.status}`, data);
    } catch (e) {
      results.push({ name: t.name, ord: t.ord, error: e.message });
      console.error(`✗ ${t.name} #${t.ord} — ${e.message}`);
    }
  }

  const ok = results.filter(r => r.status === 200).length;
  console.log(`\nDone. ${ok}/${results.length} sent successfully.`);
  console.table(results);
  return results;
})();
