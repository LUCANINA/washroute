import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

  // Only show meaningful line items — include pref_service (Vinegar, Oxi, etc.)
  const DISPLAY_TYPES = new Set(['base', 'overage', 'addon_service', 'pref_service', 'delivery_fee', 'same_day_surcharge']);
  const displayItems = allItems.filter((i: any) => DISPLAY_TYPES.has(i.type) && Number(i.amount ?? 0) > 0);
  // Reductions to subtotal — both account credits AND service discounts (SENIORS, promo codes,
  // etc.) render as green minus rows under the subtotal. Before this, type='discount' line items
  // were silently dropped from the receipt, so customers saw an unexplained gap between
  // (line items + tip) and Total Paid (e.g. SENIORS 5% off — Dorothy, May 2026).
  const creditItems  = allItems.filter((i: any) => (i.type === 'credit' || i.type === 'discount') && Number(i.amount ?? 0) < 0);

  const subtotal = displayItems.reduce((sum: number, i: any) => sum + Number(i.amount ?? 0), 0);
  const total    = Number(order.total_amount ?? 0);
  const bags     = order.total_bags ?? null;
  const weightLbs = order.weight_lbs ? Number(order.weight_lbs) : null;

  // ── Tip calculation ──
  const tipAmt = parseFloat(order.tip_amount || 0);
  const tipDollars = tipAmt > 0
    ? (order.tip_type === 'pct' ? Math.round(subtotal * tipAmt) / 100 : tipAmt)
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

  const grandTotal = total + tipDollars;
  // Session 150: split mixed-tender payments. `creditApplied` (passed in by the
  // handler from customer_transactions where type='credit_use') is the dollar
  // amount paid from the customer's account credit. `cardPaid` is what hit
  // their actual card. When both are > 0, the receipt shows them as separate
  // lines so the customer's bank-statement charge matches what they see here.
  const cardPaid = Math.max(0, Math.round((grandTotal - creditApplied) * 100) / 100);
  const hasMixedTender = creditApplied > 0 && cardPaid > 0;
  const fullyPaidByCredit = creditApplied > 0 && cardPaid === 0;

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

  const creditItemsHtml = creditItems.map((i: any) => `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#059669;">${i.label ?? 'Credit'}</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">\u2212${fmt(i.amount)}</td>
        </tr>`).join('');

  // Session 150: account-credit-application row, separate from line-item credits.
  const accountCreditHtml = creditApplied > 0 ? `
        <tr>
          <td style="padding:5px 0;font-size:13px;color:#059669;">Account credit applied</td>
          <td style="padding:5px 0;font-size:13px;font-weight:600;text-align:right;color:#059669;">\u2212${fmt(creditApplied)}</td>
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
  const showSubtotal = displayItems.length > 1 || creditItems.length > 0 || tipDollars > 0 || taxAmt > 0 || creditApplied > 0;

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
                <td align="right" style="font-size:13px;color:#111827;font-weight:500;">${fmt(subtotal)}</td>
              </tr>` : ''}
              ${creditItemsHtml}
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
      JSON.stringify({ ok: true, sent_to: toEmail }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
