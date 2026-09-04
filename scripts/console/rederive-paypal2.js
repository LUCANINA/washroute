// scripts/console/rederive-paypal2.js — session 270
//
// PayPal 2 (A00845102, Xero 284) carries the only schedule on the book that no code
// path maintains: `amort_type='actual_payment_history_from_lender_csv'`, hand-parsed
// in session 205, `anchor_statement_date` NULL. Session 268's staging guard correctly
// refuses to stage from it; this is the re-derive that guard's own message asks for.
//
// It is NOT a data fix and nothing here is inferred. deriveSchedule measures a rate
// from the loan's 35 real lender balances (all `portal_manual_pull`, all
// `principal_only`) and anchors the result at the newest of them. The anchor advances
// because the LENDER's documents moved it — which is the thing David refused to fake
// by hand on 2026-09-03, and he was right to.
//
// RUN IT IN THE ADMIN DASHBOARD CONSOLE (admin.familylaundry.com), signed in as
// admin or manager. `_loanFn` is a page function; it will not exist anywhere else.
//
// ── STEP 1: PREVIEW. Writes nothing. Read the output before going further. ──
(async () => {
  const PAYPAL_2 = 'f3aa83c5-6078-4847-ada3-d2214fa07c08';
  const { ok, data } = await _loanFn('loan-derive-schedule',
    { loan_account_id: PAYPAL_2, confirm: false }, 60000);
  if (!ok || data.error) return console.error('Preview failed:', data.error || data);
  console.log('%cPREVIEW — nothing written', 'font-weight:bold');
  console.table({
    'rate model':        data.fit?.model,
    'annual rate':       data.fit?.annual_rate_percent + '%',
    'fit residual':      data.fit?.residual,
    'periods fitted':    data.fit?.periods,
    'anchor statement':  data.anchor?.statement_date,
    'anchor balance':    data.anchor?.balance,
    'payment':           data.anchor?.payment,
    'cadence':           data.cadence,
    'future periods':    data.future_periods,
  });
  console.log('First future rows:', data.first_future_rows);
  console.log(
    '\nCHECK THESE THREE BEFORE STEP 2:\n' +
    '  1. anchor statement is 2026-09-02 (the newest lender balance, 46,144.59)\n' +
    '  2. the fitted rate is plausible and the residual is small — a bad fit usually\n' +
    '     means a wrong PAYMENT, not a wrong rate (session 230)\n' +
    '  3. cadence reads weekly — PayPal 2 drafts every 7 days, and a monthly reading\n' +
    '     would label splits by month and break the one-stage-per-feed-line rule\n' +
    '\nIf all three look right, run STEP 2 (bottom of this file).'
  );
})();

// ── STEP 2: COMMIT. Paste this ONLY after the preview above looks right. ──
// Writes a new `derived_*` schedule anchored at the newest lender statement. The old
// hand-parsed schedule is NOT deleted — deriveSchedule always appends, so nothing a
// split already points at is disturbed, and the supersession stays auditable.
//
// Side effect worth knowing: once this loan's newest schedule is `derived_*`, it
// rejoins the population that rederiveIfDerived maintains automatically. After
// session 270 that gate reads scheduleGoesStale, so it would have been covered
// either way — but this is what stops it drifting again in the meantime.
/*
(async () => {
  const PAYPAL_2 = 'f3aa83c5-6078-4847-ada3-d2214fa07c08';
  const { ok, data } = await _loanFn('loan-derive-schedule',
    { loan_account_id: PAYPAL_2, confirm: true, enable_staging: false }, 60000);
  console.log(ok && !data.error ? 'WROTE:' : 'FAILED:', data);
  // enable_staging stays FALSE on purpose. Get the schedule right first, look at the
  // card it produces, and turn staging on as a separate decision — never in the same
  // action that created the thing being staged.
})();
*/
