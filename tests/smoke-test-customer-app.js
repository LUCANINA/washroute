// ─────────────────────────────────────────────────────────────────────────────
//  WashRoute Customer App — Tier 1 Smoke Test
//  Paste into the browser console at https://app.familylaundry.com/customer-app/
//  while logged in. Asserts the state machine + key panels render correctly.
//
//  Read-only — does NOT mutate any DB rows or send any messages.
//  Run after every customer-app deploy or auth-related change.
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('%c🧪 WashRoute Customer App — Smoke Test Tier 1', 'font-size:14px;font-weight:bold;color:#635bff');
  const results = [];
  const pass = (name, detail = '') => { results.push({ name, status: 'PASS', detail }); console.log('%c✅ ' + name, 'color:#16a34a', detail); };
  const fail = (name, detail = '') => { results.push({ name, status: 'FAIL', detail }); console.error('❌ ' + name, detail); };
  const skip = (name, why) => { results.push({ name, status: 'SKIP', detail: why }); console.warn('⏭️  ' + name, '—', why); };

  // ─── Section 1: globals + auth state ────────────────────────────────────
  console.group('1. Globals + auth state');

  if (typeof db !== 'undefined' && db?.auth) pass('Supabase client initialized'); else fail('Supabase client missing');
  if (typeof currentUser !== 'undefined') pass('currentUser global defined'); else fail('currentUser global missing');
  if (typeof currentProfile !== 'undefined') pass('currentProfile global defined'); else fail('currentProfile global missing');
  if (typeof currentCustomer !== 'undefined') pass('currentCustomer global defined'); else fail('currentCustomer global missing');

  if (currentUser) {
    pass('Signed in', `user_id=${currentUser.id?.slice(0, 8)}…`);
    if (!currentUser.email && !currentUser.phone) fail('Auth user has neither email nor phone — broken state');
  } else {
    skip('Persona checks (signed in)', 'Not signed in — log in and re-run');
    console.groupEnd();
    // Print summary even when signed-out
    const passes = results.filter(r => r.status === 'PASS').length;
    const fails  = results.filter(r => r.status === 'FAIL').length;
    const skips  = results.filter(r => r.status === 'SKIP').length;
    console.log(`%c\n=== Result: ${passes} pass, ${fails} fail, ${skips} skip ===`, 'font-weight:bold');
    return;
  }

  // ─── Section 2: required globals (functions that must exist) ────────────
  console.groupEnd();
  console.group('2. Required functions exist');

  for (const fn of [
    'goTo', 'showAuthPanel', 'loadAccount', 'loadContactDetails',
    'handleOTPVerify', 'handlePhoneSubmit', 'startSubscription',
    'pauseSubscription', 'resumeSubscription', 'cancelSubscription',
    'isPasswordlessUser', 'savePasswordChange', 'saveContactInfo', 'saveEmailChange',
    '_handleCustomerSession',
  ]) {
    if (typeof window[fn] === 'function' || (typeof eval(`typeof ${fn}`) === 'function')) {
      pass(`Function ${fn}() defined`);
    } else {
      fail(`Function ${fn}() missing — UI handler will throw on click`);
    }
  }

  // ─── Section 3: race-condition flags + idempotency guards ───────────────
  console.groupEnd();
  console.group('3. OTP race guards in place');

  // The actual bug from session 111 — verify the in-flight + already-verified guards exist
  const handlerSrc = (typeof handleOTPVerify === 'function') ? handleOTPVerify.toString() : '';
  if (handlerSrc.includes('_otpVerifyInFlight')) pass('handleOTPVerify has in-flight guard'); else fail('handleOTPVerify missing in-flight guard — double-fire bug');
  if (handlerSrc.includes('_otpAlreadyVerified')) pass('handleOTPVerify has already-verified guard'); else fail('handleOTPVerify missing already-verified guard — sequential re-burn bug');
  if (handlerSrc.includes("_handleCustomerSession('SIGNED_IN'") || handlerSrc.includes('_handleCustomerSession("SIGNED_IN"')) {
    pass('handleOTPVerify drives navigation explicitly');
  } else {
    fail('handleOTPVerify relies on onAuthStateChange (race condition)');
  }
  // Belt-and-suspenders: input cleared on verify start
  if (handlerSrc.includes("otpInput.value = ''")) pass('handleOTPVerify clears input on verify start'); else fail('handleOTPVerify does not clear input — token can be re-burned');

  // ─── Section 4: Account Details renders correctly for current persona ───
  console.groupEnd();
  console.group('4. Account Details renders');

  try {
    loadContactDetails();
    const expectedFirst = currentProfile?.first_name || currentCustomer?.first_name_cache || '';
    const expectedLast  = currentProfile?.last_name  || currentCustomer?.last_name_cache  || '';
    const expectedEmail = currentUser?.email || currentCustomer?.email_cache || '';
    const expectedPhone = currentCustomer?.phone_cache || '';

    const cdFirst = document.getElementById('cd-first')?.value;
    const cdLast  = document.getElementById('cd-last')?.value;
    const cdEmail = document.getElementById('cd-email')?.value;
    const cdPhone = document.getElementById('cd-phone')?.value;

    if (cdFirst === expectedFirst) pass('cd-first matches expected'); else fail(`cd-first="${cdFirst}" expected="${expectedFirst}"`);
    if (cdLast  === expectedLast)  pass('cd-last matches expected');  else fail(`cd-last="${cdLast}" expected="${expectedLast}"`);
    if (cdEmail === expectedEmail) pass('cd-email matches expected'); else fail(`cd-email="${cdEmail}" expected="${expectedEmail}"`);
    if (cdPhone === expectedPhone) pass('cd-phone matches expected'); else fail(`cd-phone="${cdPhone}" expected="${expectedPhone}"`);
  } catch (e) {
    fail('loadContactDetails threw', e.message);
  }

  // Password section reachable for everyone
  const changeShown = document.getElementById('cd-pw-change-section')?.style.display !== 'none';
  if (changeShown) {
    pass('Change/Set Password section visible');
  } else {
    fail('Password section hidden — phone-OTP users locked out');
  }
  const pwBtn = document.getElementById('cd-save-pw-btn')?.textContent?.trim();
  const expectedPwBtn = isPasswordlessUser() ? 'Set Password' : 'Change Password';
  if (pwBtn === expectedPwBtn) pass(`Password button label = "${pwBtn}"`); else fail(`Password button label "${pwBtn}" expected "${expectedPwBtn}"`);

  // ─── Section 5: Subscription UI hidden until subscribed ─────────────────
  console.groupEnd();
  console.group('5. Subscription UI gating');

  const homeSubCard = document.getElementById('home-sub-card');
  const myPlanItem  = document.getElementById('acct-menu-plan-item');
  const hasActiveSub = !!(typeof _activeSub !== 'undefined' && _activeSub);

  if (homeSubCard) {
    if (hasActiveSub) {
      if (homeSubCard.style.display !== 'none') pass('Home sub card visible (has subscription)'); else fail('Home sub card hidden but should be visible');
    } else {
      if (homeSubCard.style.display === 'none') pass('Home sub card hidden (no subscription) — correct'); else fail('Home sub card visible without subscription');
    }
  } else {
    skip('Home sub card check', 'element not found');
  }

  if (myPlanItem) {
    if (hasActiveSub) {
      if (myPlanItem.style.display !== 'none') pass('My Plan menu visible (has subscription)'); else fail('My Plan menu hidden but should be visible');
    } else {
      if (myPlanItem.style.display === 'none') pass('My Plan menu hidden (no subscription) — correct'); else fail('My Plan menu visible without subscription');
    }
  } else {
    skip('My Plan menu check', 'element not found');
  }

  // ─── Section 6: Subscription edge functions reachable ───────────────────
  console.groupEnd();
  console.group('6. Subscription edge functions reachable');

  const SUPA = 'https://umjpbuxrdydwejqtensq.supabase.co';
  const ANON = (db?.supabaseKey) || (db?.headers?.apikey);
  const fakeId = '00000000-0000-0000-0000-000000000000';
  for (const fn of ['pause-subscription', 'resume-subscription', 'cancel-subscription']) {
    try {
      const r = await fetch(`${SUPA}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON}` },
        body: JSON.stringify({ subscription_id: fakeId }),
      });
      const body = await r.json();
      if (r.status === 500 && /Subscription not found/i.test(body.error || '')) {
        pass(`${fn} reachable + validates subscription_id`);
      } else {
        fail(`${fn} unexpected response`, `status=${r.status} body=${JSON.stringify(body)}`);
      }
    } catch (e) {
      fail(`${fn} network error`, e.message);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.groupEnd();
  const passes = results.filter(r => r.status === 'PASS').length;
  const fails  = results.filter(r => r.status === 'FAIL').length;
  const skips  = results.filter(r => r.status === 'SKIP').length;
  const banner = `\n=== Tier 1 Smoke: ${passes} pass, ${fails} fail, ${skips} skip ===`;
  console.log(`%c${banner}`, fails > 0 ? 'color:#dc2626;font-weight:bold;font-size:13px' : 'color:#16a34a;font-weight:bold;font-size:13px');
  if (fails > 0) {
    console.log('%c❌ Failures:', 'color:#dc2626;font-weight:bold');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  • ${r.name}: ${r.detail}`));
  }
  return { passes, fails, skips, results };
})();
