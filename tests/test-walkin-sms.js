/* =============================================================
   Walk-in SMS smoke test — session 114
   =============================================================
   HOW TO RUN
   ----------
   1. Open https://app.familylaundry.com/pos/ (or the local POS)
   2. Sign in with your PIN so a POS shift is active
   3. Open the browser console (F12 → Console)
   4. Paste the whole file and press Enter

   What it checks (no SMS is actually sent):
     ✓ Both message templates exist and are enabled
     ✓ The POS session can read them (RLS policy works)
     ✓ Placeholder substitution renders the expected body
     ✓ Phone normalization produces a valid E.164 number

   If you want to send ONE real SMS end-to-end, scroll to the
   "LIVE SEND" block at the bottom and follow the instructions.
   ============================================================= */

(async function walkinSmsSmokeTest() {
  const pass = (m) => console.log('%c✓ ' + m, 'color:green');
  const fail = (m) => console.error('%c✗ ' + m, 'color:red');
  const info = (m) => console.log('%c  ' + m, 'color:gray');

  console.log('%c=== Walk-in SMS smoke test ===', 'font-weight:bold;font-size:14px');

  // ---- 1. Verify POS session ----
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) {
      fail('No POS session — sign in with your PIN first, then re-run.');
      return;
    }
    pass(`POS session active as ${session.user.email}`);
  } catch (e) {
    fail('auth.getSession() threw: ' + e.message);
    return;
  }

  // ---- 2. Fetch both templates ----
  const keys = ['walkin_order_placed', 'walkin_order_ready'];
  const { data: tmpls, error: tErr } = await db
    .from('message_templates')
    .select('trigger_key, trigger_label, sms_enabled, sms_body')
    .in('trigger_key', keys);
  if (tErr) {
    fail('Template lookup failed: ' + tErr.message);
    fail('→ RLS policy `pos_read_message_templates` may not be applied.');
    return;
  }
  if (!tmpls || tmpls.length < 2) {
    fail(`Expected 2 templates, got ${tmpls?.length || 0}.`);
    return;
  }
  pass(`Loaded ${tmpls.length} templates via POS session`);

  for (const k of keys) {
    const t = tmpls.find(x => x.trigger_key === k);
    if (!t) { fail(`Missing template: ${k}`); continue; }
    if (!t.sms_enabled) fail(`Template ${k} is DISABLED (sms_enabled=false)`);
    else pass(`${k} is enabled`);
    info('  label: ' + t.trigger_label);
    info('  body:  ' + t.sms_body);
  }

  // ---- 3. Placeholder substitution ----
  const sample = {
    first_name:   'David',
    order_number: '9999',
  };
  for (const k of keys) {
    const t = tmpls.find(x => x.trigger_key === k);
    const rendered = (t.sms_body || '')
      .replace(/\{\{\s*first_name\s*\}\}/g,  sample.first_name)
      .replace(/\{\{\s*order_number\s*\}\}/g, sample.order_number);

    if (rendered.includes('{{')) {
      fail(`${k}: unsubstituted placeholder left behind — ${rendered}`);
    } else if (rendered.length > 160) {
      // Twilio splits over 160 chars into multiple segments. Not fatal,
      // just worth knowing.
      info(`${k}: length ${rendered.length} chars (will send as multi-segment)`);
    } else {
      pass(`${k}: renders clean at ${rendered.length} chars`);
    }
    console.log('  →', rendered);
  }

  // ---- 4. Phone normalization ----
  const cases = [
    { raw: '4155550134',         expected: '+14155550134' },
    { raw: '+14155550134',       expected: '+14155550134' },
    { raw: '(415) 555-0134',     expected: '+14155550134' },
    { raw: '1-415-555-0134',     expected: '+14155550134' },
    { raw: '415.555.0134',       expected: '+14155550134' },
    { raw: '',                   expected: null },
    { raw: '555',                expected: null },
  ];
  for (const c of cases) {
    const digits = (c.raw || '').replace(/\D/g, '').slice(-10);
    const got = digits.length === 10 ? '+1' + digits : null;
    if (got === c.expected) pass(`phone "${c.raw}" → ${got || 'skip'}`);
    else fail(`phone "${c.raw}" → got ${got}, expected ${c.expected}`);
  }

  console.log('%c=== Smoke test done ===', 'font-weight:bold;font-size:14px');
  console.log(
    '%cTo send ONE real SMS end-to-end, see the "LIVE SEND" block below.',
    'color:orange;font-weight:bold'
  );
})();

/* =============================================================
   LIVE SEND — only runs when you uncomment and paste this block.
   Uses your own phone + a fake order number to verify the
   Twilio path. Actually sends an SMS. DO NOT spam.
   =============================================================

(async function liveSendOneSms() {
  const MY_PHONE   = '+15105551212';   // ← put your real number here
  const TEST_NAME  = 'David';
  const TEST_ORDER = '9999';

  await sendPosTemplateSms(
    'walkin_order_placed',
    { order_number: TEST_ORDER },
    { id: null, name: TEST_NAME, phone: MY_PHONE }
  );
  console.log('Check your phone — one walkin_order_placed SMS should arrive.');
})();

*/
