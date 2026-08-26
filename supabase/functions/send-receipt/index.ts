import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Authorization ─────────────────────────────────────────────────────────
// Callers are the admin dashboard and the POS only. Before session 137 this
// was wide open: anyone with an order UUID could re-send a receipt and read
// the customer's email address back out of the response.
// profiles.role values: customer, attendant, driver, manager, admin,
// pos_device, laundry_tech.
const RECEIPT_ROLES = new Set(['admin', 'manager', 'attendant', 'pos_device', 'laundry_tech']);

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
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

function buildEmailHtml(order: any, customer: any, creditApplied: number = 0): string {
  const firstName = customer.first_name_cache ?? customer.email_cache?.split('@')[0] ?? 'there';

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
  const renderedSubtotal = Math.round((subtotal + discountTotal) * 100) / 100;
  let reconcileDelta = 0;
  if (authoritativeSubtotal - renderedSubtotal > 0.01) {
    reconcileDelta = Math.round((authoritativeSubtotal - renderedSubtotal) * 100) / 100;
    console.error(`[send-receipt] RECONCILE order #${order.order_number}: rendered $${renderedSubtotal.toFixed(2)} but orders.total_amount is $${authoritativeSubtotal.toFixed(2)} — $${reconcileDelta.toFixed(2)} of charges had no matching line item. Rendered a catch-all row; investigate the line_items types on this order.`);
    displayItems.push({ type: '_reconcile', label: 'Additional charges', amount: reconcileDelta });
  } else if (renderedSubtotal - authoritativeSubtotal > 0.01 && effectiveCredit === 0) {
    console.warn(`[send-receipt] order #${order.order_number}: rendered $${renderedSubtotal.toFixed(2)} exceeds orders.total_amount $${authoritativeSubtotal.toFixed(2)} with no account credit applied.`);
  }
  const subtotalShown = Math.round((subtotal + reconcileDelta) * 100) / 100;

  const grandTotal = Math.round((subtotalShown + discountTotal + taxAmt + tipDollars) * 100) / 100;

  // `cardPaid` is what hit the customer's actual card. When both credit and card
  // are > 0, the receipt shows them as separate lines so the customer's
  // bank-statement charge matches what they see here.
  const cardPaid = Math.max(0, Math.round((grandTotal - effectiveCredit) * 100) / 100);
  const hasMixedTender = effectiveCredit > 0 && cardPaid > 0;
  const fullyPaidByCredit = effectiveCredit > 0 && cardPaid === 0;

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
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">\u2212${fmt(i.amount)}</td>
        </tr>`).join('');

  // Session 150: account-credit-application row. Rendered ONCE from effectiveCredit
  // (transactions, or legacy line-item fallback) \u2014 never also from line items.
  const accountCreditHtml = effectiveCredit > 0 ? `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#059669;">Account credit applied</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">\u2212${fmt(effectiveCredit)}</td>
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

  // Show subtotal row only when it differs from total (i.e. credits exist, multi-line, tax, or tip)
  const showSubtotal = displayItems.length > 1 || discountItems.length > 0 || tipDollars > 0 || taxAmt > 0 || effectiveCredit > 0;

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
              Hi ${firstName}, thanks for your order &mdash; here&rsquo;s your receipt.
            </div>

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.reason }),
        { status: auth.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { order_id } = await req.json();
    if (!order_id) throw new Error('order_id is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch order + customer + address + schedule windows + tip fields
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select(`
        id, order_number, total_amount, line_items, total_bags, weight_lbs,
        pickup_window_start, pickup_window_end,
        delivery_window_start, delivery_window_end,
        actual_pickup_at, actual_delivery_at,
        tip_amount, tip_type, tax_amount,
        pickup_address:pickup_address_id ( line1, city, state, zip ),
        customers ( first_name_cache, last_name_cache, email_cache )
      `)
      .eq('id', order_id)
      .single();

    if (orderErr || !order) throw new Error(orderErr?.message ?? 'Order not found');

    const customer = order.customers as any;
    const toEmail  = customer?.email_cache;
    if (!toEmail) throw new Error('Customer has no email address on file');

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

    const html = buildEmailHtml(order, customer, creditApplied);

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: `Your receipt \u2014 Family Laundry Order #${order.order_number}`,
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error(`SendGrid error ${sgRes.status}: ${errBody}`);
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
