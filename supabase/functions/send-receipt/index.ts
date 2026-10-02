import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
};

// ── Authorization ─────────────────────────────────────────────────────────
// Callers are the admin dashboard and the POS only. Before session 137 this
// was wide open: anyone with an order UUID could re-send a receipt and read
// the customer's email address back out of the response.
// profiles.role values: customer, attendant, driver, manager, admin,
// pos_device, laundry_tech.
const RECEIPT_ROLES = new Set(['admin', 'manager', 'attendant', 'pos_device', 'laundry_tech']);

// Session 229: the DB can present neither the service-role key nor a staff JWT,
// so a server-side batch job (the corrected-receipt run) authenticates with the
// shared internal secret in `public.wr_internal_auth`, exactly as charge-order /
// send-email / send-order-notification already do. Scope is bounded: this
// function can only email the address already on the order's customer record.
async function isInternalCaller(req: Request): Promise<boolean> {
  const hdr = req.headers.get('x-wr-internal') || '';
  if (!hdr) return false;
  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
    const { data } = await admin.from('wr_internal_auth').select('secret').limit(1).single();
    const expected = (data as any)?.secret ?? '';
    return expected.length > 0 && hdr === expected;
  } catch (_e) {
    return false;
  }
}

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  if (await isInternalCaller(req)) return { ok: true };

  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' };
  const jwt = m[1];

  if (jwt === SUPABASE_SVC_KEY) return { ok: true };

  if (jwt === SUPABASE_ANON_KEY) {
    return { ok: false, status: 401, reason: 'Anon key not accepted; staff login required' };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' };

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  const { data: profile, error: profErr } = await adminClient
    .from('profiles').select('role').eq('id', user.id).single();
  if (profErr || !profile) return { ok: false, status: 403, reason: 'Profile not found' };
  if (!RECEIPT_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to send receipts` };
  }

  return { ok: true };
}

function fmt(n: number): string {
  return '$' + Math.abs(Number(n)).toFixed(2);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: 'America/Los_Angeles'
  });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles'
  }).toLowerCase();
}

function fmtWindow(start: string, end?: string): string {
  const s = fmtTime(start);
  if (!end) return s;
  const sPart = s.replace(/\s*(am|pm)\s*$/i, '');
  return `${sPart} – ${fmtTime(end)}`;
}

// Filter out stale "Name: Yes" line items when a "Name × N bag" version exists.
// Handles orders saved before the label fix that had duplicate entries.
function dedupeLineItems(items: any[]): any[] {
  if (!Array.isArray(items)) return [];
  const hasPerBag = new Set<string>();
  items.forEach((li: any) => {
    const m = (li.label || '').match(/^(.+?)\s*×\s*\d+/);
    if (m) hasPerBag.add(m[1].trim().toLowerCase());
  });
  return items.filter((li: any) => {
    const m = (li.label || '').match(/^(.+?):\s*(Yes|No)$/i);
    if (m && hasPerBag.has(m[1].trim().toLowerCase())) return false;
    return true;
  });
}

// ── Referral block (session 326) ──────────────────────────────────────────
// Every receipt carries the customer's own WORKING referral code + link.
// The code comes from `referral_codes` (what claim_referral_code accepts) — NOT
// customers.ambassador_code, which is the old Starchup code and is rejected by
// the referral system. Amounts come ONLY from referral_config() (CLAUDE.md:
// referral amounts are never typed anywhere else). Any failure here returns
// null and the receipt goes out without the block — never blocks a receipt.
type ReferralBlock = { code: string; link: string; friend: number; referrer: number };

function fmtAmt(n: number): string {
  return '$' + (Math.round(n * 100) % 100 === 0 ? String(Math.round(n)) : n.toFixed(2));
}

async function getReferralBlock(db: any, customerId: string, firstName: string | null, billingType: string | null): Promise<ReferralBlock | null> {
  try {
    if (!customerId) return null;
    const { data: cfg, error: cfgErr } = await db.rpc('referral_config');
    if (cfgErr || !cfg || cfg.enabled !== true) return null;
    if (billingType === 'on_account' && cfg.commercial_can_refer === false) return null;
    const friend = Number(cfg.friend_credit), referrer = Number(cfg.referrer_credit);
    if (!(friend > 0) || !(referrer > 0)) return null;

    let code: string | null = null;
    const { data: existing, error: selErr } = await db.from('referral_codes')
      .select('code, active').eq('customer_id', customerId).maybeSingle();
    if (selErr) return null;
    if (existing) {
      if (existing.active === false) return null;   // staff switched this code off
      code = existing.code;
    } else {
      // Same shape get_or_create_referral_code mints: FIRSTNAME + 3 digits.
      // (That RPC needs a signed-in caller, so it can't be used from here.)
      let stem = String(firstName || '').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 10);
      if (stem.length < 2) stem = 'WASH';
      for (let i = 0; i < 25 && !code; i++) {
        const candidate = stem + String(Math.floor(Math.random() * 900) + 100);
        const { error: insErr } = await db.from('referral_codes')
          .insert({ customer_id: customerId, code: candidate });
        if (!insErr) { code = candidate; break; }
        // Lost a race on customer_id (code minted elsewhere) → read it back.
        const { data: again } = await db.from('referral_codes')
          .select('code, active').eq('customer_id', customerId).maybeSingle();
        if (again) { if (again.active === false) return null; code = again.code; }
        // else: code collision → loop and try another number
      }
    }
    if (!code) return null;
    return { code, link: 'https://app.familylaundry.com/r/' + code, friend, referrer };
  } catch (e) {
    console.warn('[send-receipt] referral block skipped:', (e as any)?.message ?? e);
    return null;
  }
}

function buildReferralHtml(r: ReferralBlock | null): string {
  if (!r) return '';
  // Session 326b: kept deliberately quiet — one small line under the total, not a banner.
  // The button goes to the customer's OWN invite screen (Rewards › Invite, share sheet),
  // not to /r/CODE — that link is the friend's landing page ("X gave you $20 off").
  const inviteUrl = 'https://app.familylaundry.com/?page=invite';
  return `
          <tr><td style="padding:20px 32px 16px;">
            <div style="padding-top:6px;font-size:12.5px;color:#6b7280;line-height:1.6;text-align:center;">
              <strong style="color:#374151;">Give ${fmtAmt(r.friend)}, get ${fmtAmt(r.referrer)}.</strong>
              Send a friend your code <strong style="color:#111827;letter-spacing:.04em;">${r.code}</strong> &mdash; they save ${fmtAmt(r.friend)} on their first order, and you get ${fmtAmt(r.referrer)} once they&rsquo;ve tried us.
              <a href="${inviteUrl}" style="color:#1d4ed8;text-decoration:none;font-weight:600;white-space:nowrap;">Invite a friend &rarr;</a>
            </div>
          </td></tr>`;
}

// ── Receipt numbers (session 330) ─────────────────────────────────────────
// ONE computation feeds both the HTML email and the PDF attachment, so the two
// can never disagree. Moved out of buildEmailHtml verbatim — no math changed.
function computeReceiptData(order: any, creditApplied: number = 0) {
  // Normalize two possible line_item formats:
  // Old (customer-app): { qty, name, total, unit_price, service_id }
  // New (processing):   { label, amount, type }
  const rawItems: any[] = Array.isArray(order.line_items) ? order.line_items : [];
  const allItems = dedupeLineItems(rawItems.map((i: any) => {
    if (i.type !== undefined) return i; // already new format
    // Old format — convert to new
    const label = (i.qty != null && i.qty > 1)
      ? `${i.qty} × ${i.name ?? 'Service'}`
      : (i.name ?? 'Service');
    return { label, amount: Number(i.total ?? 0), type: 'base' };
  }));

  // ── Which line items render as charge rows (session 229) ──
  // This used to be an ALLOW-list (`DISPLAY_TYPES`). Any line-item type
  // introduced later was therefore silently dropped from the receipt AND from
  // the computed total. `lb_overage` — the subscription weight-overage line
  // appended by the `apply_subscription_usage_fn` trigger at
  // ready_for_delivery — was never added to it, so every subscriber overage
  // since June 2026 was invisible on the emailed receipt. Rae Maxwell-Ross
  // #11775: card charged $144.75, emailed receipt said $21.00. 113 orders /
  // $8,591 of charges hidden.
  //
  // It is now a DENY-list: anything not rendered elsewhere on the receipt
  // shows up as a charge row, so a future new type can never vanish again.
  //   discount → its own green minus rows below
  //   credit   → rendered exactly once from `effectiveCredit`
  //   tax      → its own row from order.tax_amount / legacy type:'tax'
  const NON_LINE_TYPES = new Set(['discount', 'credit', 'tax']);
  // Session 170: show the $0 "Delivery — included" line on subscription receipts
  // (reinforces the free-delivery perk). Other $0 lines stay hidden as before;
  // a regular $9.95 delivery line is already amount>0 so it's unaffected.
  const displayItems = allItems.filter((i: any) => !NON_LINE_TYPES.has(i.type)
    && (Number(i.amount ?? 0) > 0 || (i.type === 'delivery_fee' && /included/i.test(String(i.label ?? '')))));
  // Reductions to subtotal — both account credits AND service discounts (SENIORS, promo codes,
  // etc.) render as green minus rows under the subtotal. Before this, type='discount' line items
  // were silently dropped from the receipt, so customers saw an unexplained gap between
  // (line items + tip) and Total Paid (e.g. SENIORS 5% off — Dorothy, May 2026).
  // Service discounts ONLY (SENIORS, promo codes, etc.) — rendered as their own
  // green minus rows. Account credit (type:'credit') is deliberately EXCLUDED here:
  // it is rendered exactly once below from `effectiveCredit`, the authoritative
  // customer_transactions sum. Including type:'credit' here AS WELL caused the
  // receipt to show two identical "Account credit applied" lines AND to subtract
  // the credit twice from the card total (Todd Bower #7240, June 2026 — receipt
  // said $20.75 paid by card when the card was actually charged $54.85).
  const discountItems = allItems.filter((i: any) => i.type === 'discount' && Number(i.amount ?? 0) < 0);
  // Fallback account-credit figure for legacy orders that predate the credit ledger
  // (no credit_use transaction). Sum of any type:'credit' line items, as a positive.
  const lineCreditTotal = allItems
    .filter((i: any) => i.type === 'credit' && Number(i.amount ?? 0) < 0)
    .reduce((s: number, i: any) => s + Math.abs(Number(i.amount ?? 0)), 0);

  const subtotal = displayItems.reduce((sum: number, i: any) => sum + Number(i.amount ?? 0), 0);
  // `orders.total_amount` is the authoritative pre-tip service total — it is what
  // charge-order actually bills. The rendered line items must agree with it; see
  // the under-report backstop below.
  const authoritativeSubtotal = Math.round(Number(order.total_amount ?? 0) * 100) / 100;
  const bags     = order.total_bags ?? null;
  const weightLbs = order.weight_lbs ? Number(order.weight_lbs) : null;

  // ── Tip calculation ──
  const tipAmt = parseFloat(order.tip_amount || 0);
  const tipDollars = tipAmt > 0
    // pct tips bill off orders.total_amount in charge-order (computeTipDollars),
    // so the receipt must use the same base — not the rendered line sum.
    ? (order.tip_type === 'pct' ? Math.round(authoritativeSubtotal * tipAmt) / 100 : tipAmt)
    : 0;
  const tipLabel = tipAmt > 0
    ? (order.tip_type === 'pct' ? `Team Tip (${tipAmt}%)` : 'Team Tip')
    : '';

  // ── Sales tax (session 140) ──
  // Prefer the new orders.tax_amount column; fall back to a legacy
  // `type:'tax'` line_item for POS orders created before session 140.
  // Delivery laundry orders are always 0 (services exempt under CA rules).
  // taxRatePct is only known for legacy line-item orders (the rate isn't
  // stored on the new column). Column-only orders fall back to a dollar-only
  // "Sales tax" label without the percentage.
  const taxFromCol  = parseFloat(order.tax_amount || 0);
  const taxLegacy   = (rawItems.find((i: any) => i?.type === 'tax')?.amount) || 0;
  const taxAmt      = taxFromCol > 0 ? taxFromCol : Number(taxLegacy);
  const taxRatePct  = (rawItems.find((i: any) => i?.type === 'tax')?.rate) || null;
  const taxLabel    = taxRatePct ? `Sales tax (${(taxRatePct * 100).toFixed(2)}%)` : 'Sales tax';

  // Session 150: split mixed-tender payments. `creditApplied` (passed in by the
  // handler from customer_transactions where type='credit_use') is the dollar
  // amount paid from the customer's account credit. Prefer it; fall back to the
  // line-item credit total for legacy orders without a ledger entry.
  const effectiveCredit = creditApplied > 0 ? creditApplied : lineCreditTotal;

  // Gross total the customer owes, built UP from gross services + discounts + tax
  // + tip. We must NOT derive this from order.total_amount: that column is already
  // NET of the account credit (and discounts), so using it double-subtracted the
  // credit and understated the card charge (Todd Bower #7240 — see note above).
  const discountTotal = discountItems.reduce((s: number, i: any) => s + Number(i.amount ?? 0), 0); // negative

  // ── Under-report backstop (session 229) ──
  // If the rendered lines sum to LESS than orders.total_amount, some charge did
  // not render and the customer would see a total lower than what their card was
  // charged. That must never ship: log it loudly and add a catch-all row so the
  // receipt still reconciles to the real charge. The opposite direction (lines
  // summing to MORE) is normal on orders where credit was applied at intake —
  // total_amount is net of it there — so that only warns.
  //
  // ⚠️ Compare against total_amount MINUS tax, not total_amount. On POS
  // (`source='walk_in'`) orders `orders.total_amount` is tax-INCLUSIVE
  // (#13445: total 8.31 = 7.50 of line items + 0.81 tax) while line_items are
  // always pre-tax. Comparing the raw column would fire the backstop on every
  // single retail sale, add a bogus "Additional charges" row for the tax, and
  // then add the tax AGAIN below — overstating every POS receipt by its own
  // tax. Delivery orders are tax-exempt (taxAmt = 0), so subtracting is a
  // no-op for them.
  const authoritativePreTax = Math.round((authoritativeSubtotal - taxAmt) * 100) / 100;
  const renderedSubtotal = Math.round((subtotal + discountTotal) * 100) / 100;
  let reconcileDelta = 0;
  if (authoritativePreTax - renderedSubtotal > 0.01) {
    reconcileDelta = Math.round((authoritativePreTax - renderedSubtotal) * 100) / 100;
    console.error(`[send-receipt] RECONCILE order #${order.order_number}: rendered $${renderedSubtotal.toFixed(2)} but orders.total_amount (less tax) is $${authoritativePreTax.toFixed(2)} — $${reconcileDelta.toFixed(2)} of charges had no matching line item. Rendered a catch-all row; investigate the line_items types on this order.`);
    displayItems.push({ type: '_reconcile', label: 'Additional charges', amount: reconcileDelta });
  } else if (renderedSubtotal - authoritativePreTax > 0.01 && effectiveCredit === 0) {
    console.warn(`[send-receipt] order #${order.order_number}: rendered $${renderedSubtotal.toFixed(2)} exceeds orders.total_amount less tax $${authoritativePreTax.toFixed(2)} with no account credit applied.`);
  }
  const subtotalShown = Math.round((subtotal + reconcileDelta) * 100) / 100;

  const grandTotal = Math.round((subtotalShown + discountTotal + taxAmt + tipDollars) * 100) / 100;

  // `cardPaid` is what hit the customer's actual card. When both credit and card
  // are > 0, the receipt shows them as separate lines so the customer's
  // bank-statement charge matches what they see here.
  const cardPaid = Math.max(0, Math.round((grandTotal - effectiveCredit) * 100) / 100);
  const hasMixedTender = effectiveCredit > 0 && cardPaid > 0;
  const fullyPaidByCredit = effectiveCredit > 0 && cardPaid === 0;

  // Show subtotal row only when it differs from total (i.e. credits exist, multi-line, tax, or tip)
  const showSubtotal = displayItems.length > 1 || discountItems.length > 0 || tipDollars > 0 || taxAmt > 0 || effectiveCredit > 0;

  return {
    displayItems, discountItems, effectiveCredit, subtotalShown, taxAmt, taxLabel,
    tipDollars, tipLabel, grandTotal, cardPaid, hasMixedTender, fullyPaidByCredit,
    bags, weightLbs, showSubtotal,
  };
}

function buildEmailHtml(order: any, customer: any, creditApplied: number = 0, priorTotal: number | null = null, referral: ReferralBlock | null = null): string {
  const firstName = customer.first_name_cache ?? customer.email_cache?.split('@')[0] ?? 'there';
  const {
    displayItems, discountItems, effectiveCredit, subtotalShown, taxAmt, taxLabel,
    tipDollars, tipLabel, grandTotal, cardPaid, hasMixedTender, fullyPaidByCredit,
    bags, weightLbs, showSubtotal,
  } = computeReceiptData(order, creditApplied);

  // ── Correction banner (session 229) ──
  // Set only when this is a re-send of a receipt that was originally emailed with
  // a too-low total (see the NON_LINE_TYPES note above). `priorTotal` is the big
  // number the ORIGINAL email displayed, computed by the caller from the old
  // allow-list rules. The corrected figure is whatever THIS render arrives at, so
  // the banner can never disagree with the itemization printed below it.
  const correctedFigure = fullyPaidByCredit || grandTotal <= 0
    ? '$0.00 (paid with credits)'
    : fmt(hasMixedTender ? cardPaid : grandTotal);
  const correctionHtml = (priorTotal !== null) ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;margin-bottom:20px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:13px;font-weight:800;color:#92400e;margin-bottom:8px;">A correction to your receipt</div>
        <div style="font-size:13px;color:#78350f;line-height:1.65;">
          We found an error in our emailed receipts: subscription weight-overage charges were not being
          listed. The receipt we sent you for this order showed <strong>${fmt(priorTotal)}</strong>, but the
          amount charged to your card was <strong>${correctedFigure}</strong>.
          <br><br>
          <strong>Nothing about your charge has changed and no new charge has been made</strong> &mdash; only
          the receipt was wrong. The corrected, itemized version is below.
          <br><br>
          We&rsquo;re sorry for the confusion. The error is fixed. If anything here doesn&rsquo;t look right,
          just reply to this email.
        </div>
      </td></tr>
    </table>` : '';

  // Schedule rows
  const pickupAddr = order.pickup_address;
  const addrLine = pickupAddr
    ? `${pickupAddr.line1}${pickupAddr.city ? ', ' + pickupAddr.city : ''}${pickupAddr.state ? ', ' + pickupAddr.state : ''}${pickupAddr.zip ? ' ' + pickupAddr.zip : ''}`
    : null;

  const pickupDateStr  = order.actual_pickup_at   ? fmtDate(order.actual_pickup_at)
                       : order.pickup_window_start ? fmtDate(order.pickup_window_start)
                       : null;
  const pickupTimeStr  = order.actual_pickup_at   ? fmtTime(order.actual_pickup_at)
                       : order.pickup_window_start ? fmtWindow(order.pickup_window_start, order.pickup_window_end)
                       : null;
  const deliveryDateStr = order.actual_delivery_at    ? fmtDate(order.actual_delivery_at)
                        : order.delivery_window_start  ? fmtDate(order.delivery_window_start)
                        : null;
  const deliveryTimeStr = order.actual_delivery_at    ? fmtTime(order.actual_delivery_at)
                        : order.delivery_window_start  ? fmtWindow(order.delivery_window_start, order.delivery_window_end)
                        : null;

  const scheduleRowStyle = `font-size:13px;padding:6px 0;border-bottom:1px solid #f3f4f6;`;
  const scheduleLblStyle = `color:#9ca3af;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.06em;width:80px;`;
  const scheduleValStyle = `color:#111827;font-size:13px;`;

  const scheduleHtml = (pickupDateStr || deliveryDateStr || addrLine) ? `
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0 14px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;">
      ${addrLine ? `<tr style="${scheduleRowStyle}">
        <td style="${scheduleLblStyle}">Address</td>
        <td style="${scheduleValStyle}">${addrLine}</td>
      </tr>` : ''}
      ${pickupDateStr ? `<tr style="${scheduleRowStyle}">
        <td style="${scheduleLblStyle}">Pickup</td>
        <td style="${scheduleValStyle}">${pickupDateStr} · ${pickupTimeStr}</td>
      </tr>` : ''}
      ${deliveryDateStr ? `<tr style="${scheduleRowStyle}">
        <td style="${scheduleLblStyle}">Delivery</td>
        <td style="${scheduleValStyle}">${deliveryDateStr} · ${deliveryTimeStr}</td>
      </tr>` : ''}
    </table>` : '';

  const displayItemsHtml = displayItems.length > 0
    ? displayItems.map((i: any) => `
        <tr>
          <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;">${i.label ?? 'Service'}</td>
          <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:14px;font-weight:600;text-align:right;width:80px;">${fmt(i.amount ?? 0)}</td>
        </tr>`).join('')
    : `<tr><td colspan="2" style="padding:10px 0;font-size:13px;color:#9ca3af;">Wash &amp; Fold service</td></tr>`;

  const discountItemsHtml = discountItems.map((i: any) => `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#059669;">${i.label ?? 'Discount'}</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">−${fmt(i.amount)}</td>
        </tr>`).join('');

  // Session 150: account-credit-application row. Rendered ONCE from effectiveCredit
  // (transactions, or legacy line-item fallback) — never also from line items.
  const accountCreditHtml = effectiveCredit > 0 ? `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#059669;">Account credit applied</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">−${fmt(effectiveCredit)}</td>
        </tr>` : '';

  // Tip row — styled like credit items but in green with a + prefix
  const tipHtml = tipDollars > 0 ? `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#6b7280;">${tipLabel}</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">+${fmt(tipDollars)}</td>
        </tr>` : '';

  // session 140: Sales tax row — appears between subtotal and tip when present.
  const taxHtml = taxAmt > 0 ? `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#6b7280;">${taxLabel}</td>
          <td style="padding:5px 0;font-size:13px;color:#111827;font-weight:500;text-align:right;">${fmt(taxAmt)}</td>
        </tr>` : '';

  // Compact order summary (bags + weight)
  const orderSummary = bags != null
    ? `${bags} bag${bags !== 1 ? 's' : ''}${weightLbs != null ? ` &middot; ${weightLbs.toFixed(1)} lbs` : ''}`
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Family Laundry Receipt</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:white;border-radius:8px;overflow:hidden;max-width:520px;width:100%;">

          <tr><td style="padding:30px 32px 0;">

            <div style="font-size:20px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Family Laundry</div>
            <div style="font-size:11px;color:#9ca3af;margin-bottom:22px;">2609 Foothill Blvd &middot; Oakland, CA 94601</div>

            <div style="font-size:14px;color:#374151;margin-bottom:18px;line-height:1.6;">
              ${priorTotal !== null
                ? `Hi ${firstName} &mdash; here&rsquo;s a corrected receipt for this order.`
                : `Hi ${firstName}, thanks for your order &mdash; here&rsquo;s your receipt.`}
            </div>

            ${correctionHtml}

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 18px;">

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:${orderSummary ? '8px' : '12px'};">
              <tr>
                <td style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;">Receipt</td>
                <td align="right" style="font-size:14px;font-weight:800;color:#111827;">#${order.order_number}</td>
              </tr>
            </table>

            ${orderSummary ? `<div style="font-size:12px;color:#6b7280;margin-bottom:12px;">${orderSummary}</div>` : ''}

            ${scheduleHtml}

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:18px 0 14px;">

            <table width="100%" cellpadding="0" cellspacing="0">
              ${displayItemsHtml}
            </table>

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:14px 0 10px;">

            <table width="100%" cellpadding="0" cellspacing="0">
              ${showSubtotal ? `<tr>
                <td style="font-size:13px;color:#6b7280;padding:3px 0;">Subtotal</td>
                <td align="right" style="font-size:13px;color:#111827;font-weight:500;">${fmt(subtotalShown)}</td>
              </tr>` : ''}
              ${discountItemsHtml}
              ${accountCreditHtml}
              ${taxHtml}
              ${tipHtml}
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #111827;margin-top:10px;">
              <tr>
                <td style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding-top:14px;">${
                  // Session 150: label/amount honestly reflect mixed-tender payments.
                  // - fully credit: green "$0.00 (paid with credits)"
                  // - mixed credit + card: big number = card amount (matches bank statement)
                  // - card only / no credit: existing behavior
                  hasMixedTender ? 'Paid by Card' : (fullyPaidByCredit || grandTotal <= 0 ? 'Total' : 'Total Paid')
                }</td>
                <td align="right" style="font-size:24px;font-weight:900;padding-top:10px;${(fullyPaidByCredit || grandTotal <= 0) ? 'color:#059669;' : ''}">${
                  fullyPaidByCredit || grandTotal <= 0
                    ? '$0.00 (paid with credits)'
                    : fmt(hasMixedTender ? cardPaid : grandTotal)
                }</td>
              </tr>
            </table>

          </td></tr>

          ${priorTotal === null ? buildReferralHtml(referral) : ''}

          <tr><td style="padding:22px 32px 28px;border-top:1px solid #f3f4f6;margin-top:22px;font-size:11.5px;color:#9ca3af;text-align:center;line-height:1.7;">
            Questions? Reply to this email or visit familylaundry.com<br>
            Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601
          </td></tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── PDF receipt (session 330) ─────────────────────────────────────────────
// Built with pdf-lib (no headless browser in Deno). Numbers come from the SAME
// computeReceiptData() the HTML email uses. Standard Helvetica only covers the
// WinAnsi character set, so any other character in a label is dropped rather
// than crashing the whole receipt.
function pdfSafe(s: any): string {
  return String(s ?? '')
    .replace(/&middot;/g, '·').replace(/&amp;/g, '&')
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '')
    .trim();
}

async function buildReceiptPdfBase64(order: any, customer: any, creditApplied: number, cardLabel: string | null): Promise<string> {
  const d = computeReceiptData(order, creditApplied);
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Family Laundry Receipt #${order.order_number}`);
  pdf.setAuthor('Family Laundry');
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.15), grey = rgb(0.42, 0.45, 0.5), green = rgb(0.02, 0.59, 0.41), rule = rgb(0.9, 0.91, 0.92);
  const L = 56, R = 556;
  let y = 736;

  const text = (s: string, x: number, size = 10, f = font, color = ink) =>
    page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const right = (s: string, size = 10, f = font, color = ink) => {
    const t = pdfSafe(s);
    page.drawText(t, { x: R - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  const hr = (thick = 0.75, color = rule) => {
    page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: thick, color });
  };
  const money = (n: number) => '$' + Math.abs(Number(n)).toFixed(2);
  const dateStr = (iso: string | null) => iso ? fmtDate(iso) : '';

  // Header
  text('FAMILY LAUNDRY', L, 18, bold);
  right('RECEIPT', 18, bold);
  y -= 16;
  text('2609 Foothill Blvd · Oakland, CA 94601 · familylaundry.com', L, 9, font, grey);
  right(`Order #${order.order_number}`, 10, bold);
  y -= 14;
  right(`Date: ${dateStr(order.billed_at || order.actual_delivery_at || order.created_at)}`, 9, font, grey);
  y -= 26;

  // Bill to + service summary
  const name = [customer?.first_name_cache, customer?.last_name_cache].filter(Boolean).join(' ');
  text('BILLED TO', L, 8, bold, grey);
  text('SERVICE', 330, 8, bold, grey);
  y -= 14;
  text(name || 'Customer', L, 11, bold);
  const pick = order.actual_pickup_at || order.pickup_window_start;
  const drop = order.actual_delivery_at || order.delivery_window_start;
  if (pick) text(`Pickup: ${dateStr(pick)}`, 330, 10);
  y -= 13;
  if (customer?.email_cache) text(customer.email_cache, L, 9, font, grey);
  if (drop) text(`Delivery: ${dateStr(drop)}`, 330, 10);
  y -= 13;
  const a = order.pickup_address;
  if (a?.line1) text(`${a.line1}${a.city ? ', ' + a.city : ''}${a.state ? ', ' + a.state : ''}${a.zip ? ' ' + a.zip : ''}`, L, 9, font, grey);
  if (d.bags != null) text(`${d.bags} bag${d.bags !== 1 ? 's' : ''}${d.weightLbs != null ? ` · ${d.weightLbs.toFixed(1)} lbs` : ''}`, 330, 10);
  y -= 28;

  // Line items
  text('DESCRIPTION', L, 8, bold, grey);
  right('AMOUNT', 8, bold, grey);
  y -= 8; hr(1, ink); y -= 16;
  const items = d.displayItems.length ? d.displayItems : [{ label: 'Wash & Fold service', amount: null }];
  for (const it of items) {
    if (y < 140) break; // single page; receipts never come close
    text(it.label ?? 'Service', L, 10);
    if (it.amount != null) right(money(it.amount), 10);
    y -= 7; hr(); y -= 15;
  }
  y -= 4;

  // Totals block (right-aligned column)
  const row = (label: string, value: string, f = font, color = ink, size = 10) => {
    page.drawText(pdfSafe(label), { x: 330, y, size, font: f, color });
    right(value, size, f, color); y -= 16;
  };
  if (d.showSubtotal) row('Subtotal', money(d.subtotalShown), font, grey);
  for (const di of d.discountItems) row(di.label ?? 'Discount', '-' + money(di.amount), font, green);
  if (d.effectiveCredit > 0) row('Account credit applied', '-' + money(d.effectiveCredit), font, green);
  if (d.taxAmt > 0) row(d.taxLabel, money(d.taxAmt), font, grey);
  if (d.tipDollars > 0) row(d.tipLabel, '+' + money(d.tipDollars), font, grey);
  page.drawLine({ start: { x: 330, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 1.5, color: ink });
  y -= 8;
  const totalLabel = d.hasMixedTender ? 'PAID BY CARD' : (d.fullyPaidByCredit || d.grandTotal <= 0 ? 'TOTAL' : 'TOTAL PAID');
  const totalValue = d.fullyPaidByCredit || d.grandTotal <= 0 ? '$0.00 (paid with credits)' : money(d.hasMixedTender ? d.cardPaid : d.grandTotal);
  row(totalLabel, totalValue, bold, ink, 13);
  if (cardLabel && !(d.fullyPaidByCredit || d.grandTotal <= 0)) row('Payment', cardLabel, font, grey, 9);
  row('Balance due', '$0.00', font, grey, 9);

  // Footer
  page.drawText(pdfSafe('Thank you for your business. Questions? Reply to the receipt email or visit familylaundry.com'),
    { x: L, y: 64, size: 8.5, font, color: grey });
  page.drawText(pdfSafe('Family Laundry · 2609 Foothill Blvd, Oakland CA 94601'), { x: L, y: 52, size: 8.5, font, color: grey });

  return encodeBase64(await pdf.save());
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Session 330: hoisted so the catch block can log a receipt_failed event.
  let reqOrderId: string | null = null;
  let isTest = false;
  let sendSource = 'manual';
  let dbForLog: any = null;
  let logRecipient: string | null = null;

  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.reason }),
        { status: auth.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json();
    reqOrderId = body?.order_id ?? null;
    const { order_id, prior_total } = body ?? {};
    // Session 330: `test_email` sends the exact receipt (PDF included) to a staff
    // address instead of the customer, and is never logged to order_events.
    const testEmail: string | null = (typeof body?.test_email === 'string' && body.test_email.includes('@'))
      ? body.test_email.trim() : null;
    isTest = !!testEmail;
    // Session 330: 'auto_charge' = sent by charge-order after the background
    // auto-charge sweep. Those sends are once-per-order (see guard below).
    sendSource = typeof body?.source === 'string' ? body.source : 'manual';
    if (!order_id) throw new Error('order_id is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    dbForLog = supabase;

    // Once-per-order guard for automatic sends: if any path already emailed this
    // order's receipt, the auto-charge path does not send a second one. Manual
    // "Email receipt" clicks are deliberately NOT guarded — staff resends work.
    if (sendSource === 'auto_charge' && !isTest) {
      const { data: prior, error: priorErr } = await supabase.from('order_events')
        .select('id').eq('order_id', order_id).eq('event_type', 'receipt_sent').limit(1);
      if (priorErr) throw new Error('Could not check receipt history: ' + priorErr.message);
      if (prior && prior.length > 0) {
        return new Response(JSON.stringify({ ok: true, skipped: 'already_sent' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Fetch order + customer + address + schedule windows + tip fields
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select(`
        id, customer_id, order_number, total_amount, line_items, total_bags, weight_lbs,
        pickup_window_start, pickup_window_end,
        delivery_window_start, delivery_window_end,
        actual_pickup_at, actual_delivery_at, billed_at, created_at,
        tip_amount, tip_type, tax_amount,
        pickup_address:pickup_address_id ( line1, city, state, zip ),
        customers ( first_name_cache, last_name_cache, email_cache, billing_type, pricelist )
      `)
      .eq('id', order_id)
      .single();

    if (orderErr || !order) throw new Error(orderErr?.message ?? 'Order not found');

    const customer = order.customers as any;
    const customerEmail = customer?.email_cache;
    if (!customerEmail && !isTest) throw new Error('Customer has no email address on file');
    const toEmail = testEmail ?? customerEmail;
    logRecipient = toEmail;

    // Session 150: fetch credit_use transactions for this order so the email
    // receipt can split mixed-tender payments. Without this, an order paid
    // with $20 credit + $X card showed "Total Paid: $gross" — the gross total
    // didn't match what hit the customer's bank statement.
    //
    // Session 167 fix: NET credit_use against credit_refund. When admin re-saves
    // an intake, the prior credit_use is reversed via a matching credit_refund
    // row (both keyed by order_id). Without netting, a subscriber order that
    // was re-saved twice and ended up at $0 still shows "$0 (paid with credits)"
    // on the receipt because the gross credit_use sum was nonzero.
    let creditApplied = 0;
    try {
      const { data: txns } = await supabase
        .from('customer_transactions')
        .select('amount, type')
        .eq('order_id', order_id)
        .in('type', ['credit_use', 'credit_refund']);
      const net = (txns ?? []).reduce((s: number, t: any) => {
        const amt = Number(t.amount ?? 0);
        return t.type === 'credit_use' ? s + amt : s - amt;
      }, 0);
      creditApplied = Math.max(0, Math.round(net * 100) / 100);
    } catch (_e) { /* non-fatal — email still goes without the credit breakdown */ }

    // session 229: `prior_total` present => render the correction banner.
    const priorTotal = (prior_total === undefined || prior_total === null)
      ? null
      : Math.round(Number(prior_total) * 100) / 100;
    // Session 326: referral block (skipped on corrected receipts).
    const referral = priorTotal === null
      ? await getReferralBlock(supabase, (order as any).customer_id, customer?.first_name_cache ?? null, customer?.billing_type ?? null)
      : null;
    const html = buildEmailHtml(order, customer, creditApplied, priorTotal, referral);

    // Session 330: PDF receipt for Commercial-pricelist customers who pay by card
    // (on-account customers get monthly invoices instead). Restores session 219's
    // feature, which was lost because it was deployed but never committed.
    const wantsPdf = customer?.pricelist === 'Commercial' && customer?.billing_type !== 'on_account';
    let attachments: any[] | undefined;
    if (wantsPdf) {
      let cardLabel: string | null = null;
      const { data: chg } = await supabase.from('customer_transactions')
        .select('card_brand, card_last4').eq('order_id', order_id).eq('type', 'charge')
        .order('created_at', { ascending: false }).limit(1);
      if (chg && chg[0]?.card_last4) {
        cardLabel = `${String(chg[0].card_brand || 'Card').toUpperCase()} ending ${chg[0].card_last4}`;
      }
      const pdfB64 = await buildReceiptPdfBase64(order, customer, creditApplied, cardLabel);
      attachments = [{
        content: pdfB64,
        filename: `FamilyLaundry-Receipt-${order.order_number}.pdf`,
        type: 'application/pdf',
        disposition: 'attachment',
      }];
    }

    const baseSubject = priorTotal !== null
      ? `Corrected receipt — Family Laundry Order #${order.order_number}`
      : `Your receipt — Family Laundry Order #${order.order_number}`;

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: isTest ? `[TEST] ${baseSubject}` : baseSubject,
        content: [{ type: 'text/html', value: html }],
        ...(attachments ? { attachments } : {}),
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error(`SendGrid error ${sgRes.status}: ${errBody}`);
    }

    // Session 330: every real send is recorded on the order's history tab, so a
    // "we never got it" report can be answered from the order itself.
    let logged = true;
    if (!isTest) {
      const { error: logErr } = await supabase.from('order_events').insert({
        order_id,
        event_type: 'receipt_sent',
        new_value: 'sent',
        description: `Receipt emailed to ${toEmail}${attachments ? ' (PDF attached)' : ''}${sendSource === 'auto_charge' ? ' — after auto-charge' : ''}`,
        actor_name: 'System',
      });
      if (logErr) { logged = false; console.error(`[send-receipt] order ${order_id}: SENT but receipt_sent log failed: ${logErr.message}`); }
    }

    return new Response(
      JSON.stringify({ ok: true, to: isTest ? toEmail : undefined, pdf: !!attachments, test: isTest, logged }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    console.error(`[send-receipt] order ${reqOrderId ?? '?'} (${sendSource}${isTest ? ', test' : ''}) failed: ${err?.message ?? err}`);
    if (dbForLog && reqOrderId && !isTest) {
      const { error: logErr } = await dbForLog.from('order_events').insert({
        order_id: reqOrderId,
        event_type: 'receipt_failed',
        new_value: 'failed',
        description: `Receipt NOT sent${logRecipient ? ` to ${logRecipient}` : ''}: ${String(err?.message ?? err).slice(0, 300)}`,
        actor_name: 'System',
      });
      if (logErr) console.error(`[send-receipt] receipt_failed log also failed: ${logErr.message}`);
    }
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
