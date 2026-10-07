// subscription-receipt — receipts for subscription payments (session 337)
//
// Customers asked for receipts for their monthly subscription, like the ones we send
// for orders. Order receipts live in send-receipt and are keyed by order; a
// subscription payment has no order, so this is its own function and send-receipt is
// untouched.
//
// One receipt = one customer_transactions row of type 'subscription_invoice' (written by
// stripe-webhook on invoice.payment_succeeded — renewals, first payments, final overage).
// Line items, period, invoice number, card and refunds come from Stripe so the receipt
// matches what Stripe charged; if Stripe can't be reached it falls back to the row.
//
// POST { transaction_id, mode: 'email' | 'pdf', source?: 'auto' | 'manual', test_email? }
//
// Who may call:
//   * stripe-webhook (service-role key or x-wr-internal) .... mode 'email', source 'auto'
//   * staff (admin / manager / laundry_tech / attendant / pos_device)
//                                                         .... 'email' (resend) or 'pdf'
//   * the customer, for THEIR OWN payment .................... 'pdf' only
//
// Safety (anything that emails a customer will email every customer until proven
// otherwise):
//   * 'auto' sends claim a row in subscription_receipt_sends BEFORE sending; a unique
//     index allows one auto row per payment, so a retried webhook can't double-send.
//   * 'auto' refuses payments older than 48 hours — a backfill or a replay can never
//     turn into an email to every past subscriber.
//   * suppressed (bounced / complained) addresses are skipped for 'auto'.
//   * every send/failure is logged; a failed log write stops the send.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const AUTO_MAX_AGE_MS   = 48 * 60 * 60 * 1000;

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
};
const STAFF_ROLES = new Set(['admin', 'manager', 'laundry_tech', 'attendant', 'pos_device']);

type Caller =
  | { kind: 'internal' }
  | { kind: 'staff'; profileId: string }
  | { kind: 'customer'; profileId: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

class Refused extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } }

async function identify(req: Request, admin: any): Promise<Caller> {
  const hdr = req.headers.get('x-wr-internal') || '';
  if (hdr) {
    const { data } = await admin.from('wr_internal_auth').select('secret').limit(1).single();
    const expected = (data as any)?.secret ?? '';
    if (expected.length > 0 && hdr === expected) return { kind: 'internal' };
  }
  const m = (req.headers.get('Authorization') || req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Refused('Missing Authorization header', 401);
  const jwt = m[1];
  if (jwt === SUPABASE_SVC_KEY) return { kind: 'internal' };
  if (jwt === SUPABASE_ANON_KEY) throw new Refused('Please sign in', 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: { user }, error } = await userClient.auth.getUser(jwt);
  if (error || !user) throw new Refused('Your session expired — please sign in again', 401);
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single();
  if (!profile) throw new Refused('Profile not found', 403);
  if (STAFF_ROLES.has(profile.role)) return { kind: 'staff', profileId: user.id };
  if (profile.role === 'customer') return { kind: 'customer', profileId: user.id };
  throw new Refused(`Role '${profile.role}' cannot open subscription receipts`, 403);
}

// ── formatting ────────────────────────────────────────────────────────────
const TZ = 'America/Los_Angeles';
const money = (n: number) => (n < 0 ? '-' : '') + '$' + Math.abs(Number(n)).toFixed(2);
const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ });
const fmtShort = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ });
const fmtRange = (s: number, e: number) => {
  const a = new Date(s * 1000), b = new Date(e * 1000);
  return `${fmtShort(a)} – ${fmtDay(b)}`;
};
const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pdfSafe = (s: any) => String(s ?? '').replace(/[^\x20-\x7E -ÿ–—‘’“”•…]/g, '').trim();
const cap = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

type Line = { label: string; sub?: string; amount: number };
type Receipt = {
  number: string;
  paidAt: Date;
  customerName: string;
  customerEmail: string | null;
  lines: Line[];
  adjustments: number;     // discounts / credits Stripe applied (negative), 0 if none
  totalPaid: number;
  refunded: number;
  cardLabel: string | null;
  fromStripe: boolean;
};

// ── build the receipt from Stripe (falls back to the transaction row) ───────
async function buildReceipt(admin: any, txn: any, customer: any): Promise<Receipt> {
  const name = [customer?.first_name_cache, customer?.last_name_cache].filter(Boolean).join(' ') || 'Customer';
  const fallbackCard = txn.card_last4 ? `${cap(String(txn.card_brand || 'Card'))} ending ${txn.card_last4}` : null;
  const base: Receipt = {
    number: 'S-' + String(txn.id).slice(0, 8).toUpperCase(),
    paidAt: new Date(txn.created_at),
    customerName: name,
    customerEmail: customer?.email_cache ?? null,
    lines: [{ label: txn.description || 'Subscription payment', amount: Number(txn.amount) }],
    adjustments: 0,
    totalPaid: Number(txn.amount),
    refunded: 0,
    cardLabel: fallbackCard,
    fromStripe: false,
  };
  if (!txn.stripe_payment_intent_id) return base;

  try {
    const pi: any = await stripe.paymentIntents.retrieve(txn.stripe_payment_intent_id, { expand: ['latest_charge', 'invoice'] });
    const inv: any = pi.invoice && typeof pi.invoice === 'object' ? pi.invoice : null;
    const ch: any = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;

    const card = ch?.payment_method_details?.card;
    if (card?.last4) {
      const wallet = card.wallet?.type === 'apple_pay' ? ' (Apple Pay)' : card.wallet?.type === 'google_pay' ? ' (Google Pay)' : '';
      base.cardLabel = `${cap(card.brand || 'Card')} ending ${card.last4}${wallet}`;
    }
    base.refunded = Math.round(Number(ch?.amount_refunded || 0)) / 100;
    if (ch?.created) base.paidAt = new Date(ch.created * 1000);

    if (inv) {
      if (inv.number) base.number = inv.number;
      // Plan names by Stripe price id, from our own plans table
      const { data: plans } = await admin.from('subscription_plans').select('name, stripe_price_id');
      const planByPrice: Record<string, string> = {};
      (plans || []).forEach((p: any) => { if (p.stripe_price_id) planByPrice[p.stripe_price_id] = p.name; });

      let lineItems: any[] = inv.lines?.data || [];
      if (inv.lines?.has_more) {
        lineItems = [];
        for await (const li of stripe.invoices.listLineItems(inv.id, { limit: 100 })) lineItems.push(li);
      }
      const lines: Line[] = lineItems.map((li: any) => {
        const amt = Number(li.amount || 0) / 100;
        const priceId = li.price?.id || li.pricing?.price_details?.price || null;
        const isSub = li.type === 'subscription' || li.parent?.type === 'subscription_item_details';
        const isProration = !!(li.proration || li.parent?.subscription_item_details?.proration || li.parent?.invoice_item_details?.proration);
        const period = li.period && li.period.end > li.period.start ? fmtRange(li.period.start, li.period.end) : '';
        if (isSub && !isProration) {
          return { label: planByPrice[priceId] || 'Monthly subscription', sub: period ? `Service period ${period}` : undefined, amount: amt };
        }
        if (li.metadata?.washroute_overage === 'true') {
          return { label: li.metadata?.washroute_final_overage === 'true' ? 'Final overage (pounds over plan)' : 'Overage (pounds over plan, previous period)', amount: amt };
        }
        return { label: li.description || 'Subscription adjustment', sub: isProration && period ? period : undefined, amount: amt };
      });
      if (lines.length) {
        base.lines = lines;
        const linesTotal = lines.reduce((s, l) => s + l.amount, 0);
        base.totalPaid = Number(inv.amount_paid || 0) / 100;
        base.adjustments = Math.round((base.totalPaid - linesTotal) * 100) / 100;
        base.fromStripe = true;
      }
    }
  } catch (e: any) {
    console.warn(`[subscription-receipt] Stripe lookup failed for ${txn.id}, using the payment record: ${e?.message ?? e}`);
  }
  return base;
}

// ── email HTML (same look as the order receipts) ──────────────────────────
function buildEmailHtml(r: Receipt, firstName: string): string {
  const row = (l: Line) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#374151;">${esc(l.label)}${l.sub ? `<div style="font-size:12px;color:#9ca3af;margin-top:2px;">${esc(l.sub)}</div>` : ''}</td>
      <td style="padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:14px;font-weight:600;text-align:right;width:90px;vertical-align:top;">${money(l.amount)}</td>
    </tr>`;
  const small = (label: string, value: string, color = '#6b7280') => `
    <tr><td style="font-size:13px;color:${color};padding:3px 0;">${label}</td>
        <td align="right" style="font-size:13px;color:${color};font-weight:500;">${value}</td></tr>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your Family Laundry Receipt</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;"><tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" style="background:white;border-radius:8px;overflow:hidden;max-width:520px;width:100%;">
      <tr><td style="padding:30px 32px 0;">
        <div style="font-size:20px;font-weight:900;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Family Laundry</div>
        <div style="font-size:11px;color:#9ca3af;margin-bottom:22px;">2609 Foothill Blvd &middot; Oakland, CA 94601</div>
        <div style="font-size:14px;color:#374151;margin-bottom:18px;line-height:1.6;">Hi ${esc(firstName)}, thanks for being a subscriber &mdash; here&rsquo;s the receipt for your subscription payment. A PDF copy is attached.</div>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 18px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:6px;"><tr>
          <td style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;">Receipt</td>
          <td align="right" style="font-size:14px;font-weight:800;color:#111827;">#${esc(r.number)}</td>
        </tr></table>
        <div style="font-size:12px;color:#6b7280;margin-bottom:12px;">Paid ${esc(fmtDay(r.paidAt))}${r.cardLabel ? ` &middot; ${esc(r.cardLabel)}` : ''}</div>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0 6px;">
        <table width="100%" cellpadding="0" cellspacing="0">${r.lines.map(row).join('')}</table>
        ${r.adjustments !== 0 ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${small('Discounts &amp; credits', money(r.adjustments), '#059669')}</table>` : ''}
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #111827;margin-top:10px;"><tr>
          <td style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding-top:14px;">Total Paid</td>
          <td align="right" style="font-size:24px;font-weight:900;padding-top:10px;">${money(r.totalPaid)}</td>
        </tr></table>
        ${r.refunded > 0 ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">${small('Refunded to your card', '-' + money(r.refunded), '#b45309')}${small('Net paid', money(r.totalPaid - r.refunded), '#111827')}</table>` : ''}
        <div style="height:22px"></div>
      </td></tr>
      <tr><td style="padding:22px 32px 28px;border-top:1px solid #f3f4f6;font-size:11.5px;color:#9ca3af;text-align:center;line-height:1.7;">
        You can download any past subscription receipt in the app under Account &rarr; Billing History.<br>
        Questions? Reply to this email or visit familylaundry.com<br>
        Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// ── PDF (same layout as the order PDF receipt) ────────────────────────────
async function buildPdf(r: Receipt): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Family Laundry Receipt #${r.number}`);
  pdf.setAuthor('Family Laundry');
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.15), grey = rgb(0.42, 0.45, 0.5), green = rgb(0.02, 0.59, 0.41), amber = rgb(0.71, 0.33, 0.04), rule = rgb(0.9, 0.91, 0.92);
  const L = 56, R = 556;
  let y = 736;
  const text = (s: string, x: number, size = 10, f = font, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const right = (s: string, size = 10, f = font, color = ink) => {
    const t = pdfSafe(s); page.drawText(t, { x: R - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  const hr = (thick = 0.75, color = rule) => page.drawLine({ start: { x: L, y }, end: { x: R, y }, thickness: thick, color });

  text('FAMILY LAUNDRY', L, 18, bold); right('RECEIPT', 18, bold); y -= 16;
  text('2609 Foothill Blvd · Oakland, CA 94601 · familylaundry.com', L, 9, font, grey); right(`Receipt #${r.number}`, 10, bold); y -= 14;
  right(`Paid: ${fmtDay(r.paidAt)}`, 9, font, grey); y -= 26;

  text('BILLED TO', L, 8, bold, grey); text('FOR', 330, 8, bold, grey); y -= 14;
  text(r.customerName, L, 11, bold); text('Wash & Fold subscription', 330, 10); y -= 13;
  if (r.customerEmail) text(r.customerEmail, L, 9, font, grey);
  y -= 28;

  text('DESCRIPTION', L, 8, bold, grey); right('AMOUNT', 8, bold, grey); y -= 8; hr(1, ink); y -= 16;
  for (const l of r.lines) {
    if (y < 160) break;
    text(l.label, L, 10); right(money(l.amount), 10);
    if (l.sub) { y -= 12; text(l.sub, L, 8.5, font, grey); }
    y -= 7; hr(); y -= 15;
  }
  y -= 4;
  const row = (label: string, value: string, f = font, color = ink, size = 10) => {
    page.drawText(pdfSafe(label), { x: 330, y, size, font: f, color }); right(value, size, f, color); y -= 16;
  };
  if (r.adjustments !== 0) row('Discounts & credits', money(r.adjustments), font, green);
  page.drawLine({ start: { x: 330, y: y + 8 }, end: { x: R, y: y + 8 }, thickness: 1.5, color: ink }); y -= 8;
  row('TOTAL PAID', money(r.totalPaid), bold, ink, 13);
  if (r.cardLabel) row('Payment', r.cardLabel, font, grey, 9);
  if (r.refunded > 0) { row('Refunded', '-' + money(r.refunded), font, amber, 9); row('Net paid', money(r.totalPaid - r.refunded), bold, ink, 9); }
  row('Balance due', '$0.00', font, grey, 9);

  page.drawText(pdfSafe('Thank you for your business. Questions? Reply to the receipt email or visit familylaundry.com'), { x: L, y: 64, size: 8.5, font, color: grey });
  page.drawText(pdfSafe('Family Laundry · 2609 Foothill Blvd, Oakland CA 94601'), { x: L, y: 52, size: 8.5, font, color: grey });
  return await pdf.save();
}

// ── handler ───────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const admin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  let logId: string | null = null;
  let txnIdForLog = '?';

  try {
    const caller = await identify(req, admin);
    const body = await req.json().catch(() => ({}));
    const txnId: string = body?.transaction_id;
    txnIdForLog = txnId || '?';
    const mode: 'email' | 'pdf' = body?.mode === 'pdf' ? 'pdf' : 'email';
    const testEmail: string | null = (typeof body?.test_email === 'string' && body.test_email.includes('@')) ? body.test_email.trim() : null;
    const source: 'auto' | 'manual' = caller.kind === 'internal' && body?.source === 'auto' ? 'auto' : 'manual';
    if (!txnId) throw new Refused('transaction_id is required', 400);

    if (caller.kind === 'customer' && mode !== 'pdf') throw new Refused('Customers can download receipts only', 403);
    if (testEmail && caller.kind === 'customer') throw new Refused('Not allowed', 403);

    const { data: txn, error: txnErr } = await admin.from('customer_transactions')
      .select('id, customer_id, type, amount, description, stripe_payment_intent_id, card_brand, card_last4, created_at')
      .eq('id', txnId).maybeSingle();
    if (txnErr) throw new Error('Could not load the payment: ' + txnErr.message);
    if (!txn || txn.type !== 'subscription_invoice') throw new Refused('Subscription payment not found', 404);

    const { data: customer, error: custErr } = await admin.from('customers')
      .select('id, profile_id, first_name_cache, last_name_cache, email_cache').eq('id', txn.customer_id).single();
    if (custErr || !customer) throw new Error('Customer not found');
    if (caller.kind === 'customer' && customer.profile_id !== caller.profileId) throw new Refused('Subscription payment not found', 404);

    const receipt = await buildReceipt(admin, txn, customer);
    const pdfBytes = await buildPdf(receipt);
    const filename = `FamilyLaundry-Subscription-Receipt-${receipt.number}.pdf`;

    if (mode === 'pdf') {
      return new Response(pdfBytes as unknown as BodyInit, { headers: {
        ...corsHeaders, 'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Access-Control-Expose-Headers': 'Content-Disposition',
      } });
    }

    // ── email ──
    const toEmail = testEmail ?? customer.email_cache;
    if (!toEmail) throw new Refused('This customer has no email address on file', 400);

    if (source === 'auto' && !testEmail) {
      if (Date.now() - new Date(txn.created_at).getTime() > AUTO_MAX_AGE_MS) {
        console.warn(`[subscription-receipt] auto send refused for old payment ${txn.id} (${txn.created_at})`);
        return json({ ok: true, skipped: 'too_old' });
      }
      const { data: sup, error: supErr } = await admin.from('email_suppressions').select('email').in('email', [...new Set([toEmail, toEmail.toLowerCase()])]).limit(1);
      if (supErr) throw new Error('Could not check email suppressions: ' + supErr.message);
      if (sup && sup.length) return json({ ok: true, skipped: 'suppressed' });
    }

    if (!testEmail) {
      // Claim first. For 'auto' the unique index makes a second claim fail -> already sent.
      const { data: claim, error: claimErr } = await admin.from('subscription_receipt_sends').insert({
        transaction_id: txn.id, customer_id: customer.id, source, email: toEmail,
        sent_by: caller.kind === 'staff' ? caller.profileId : null,
      }).select('id').single();
      if (claimErr) {
        if (source === 'auto' && (claimErr as any).code === '23505') return json({ ok: true, skipped: 'already_sent' });
        throw new Error('Could not log the receipt (nothing was sent): ' + claimErr.message);
      }
      logId = claim.id;
    }

    const firstName = customer.first_name_cache || (customer.email_cache || '').split('@')[0] || 'there';
    const subject = `Your receipt — Family Laundry subscription (${fmtDay(receipt.paidAt)})`;
    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: testEmail ? `[TEST] ${subject}` : subject,
        content: [{ type: 'text/html', value: buildEmailHtml(receipt, firstName) }],
        attachments: [{ content: encodeBase64(pdfBytes), filename, type: 'application/pdf', disposition: 'attachment' }],
      }),
    });
    if (!sgRes.ok) throw new Error(`SendGrid error ${sgRes.status}: ${(await sgRes.text()).slice(0, 300)}`);

    let logged = true;
    if (logId) {
      const { error: upErr } = await admin.from('subscription_receipt_sends')
        .update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', logId);
      if (upErr) { logged = false; console.error(`[subscription-receipt] ${txn.id}: SENT but log update failed: ${upErr.message}`); }
    }
    console.log(`[subscription-receipt] ${source}${testEmail ? ' TEST' : ''} receipt ${receipt.number} for txn ${txn.id} sent (stripe=${receipt.fromStripe})`);
    return json({ ok: true, to: toEmail, number: receipt.number, test: !!testEmail, logged });

  } catch (err: any) {
    const status = err instanceof Refused ? err.status : 400;
    console.error(`[subscription-receipt] txn ${txnIdForLog} failed: ${err?.message ?? err}`);
    if (logId) {
      const { error: upErr } = await admin.from('subscription_receipt_sends')
        .update({ status: 'failed', error: String(err?.message ?? err).slice(0, 500) }).eq('id', logId);
      if (upErr) console.error(`[subscription-receipt] failure log also failed: ${upErr.message}`);
    }
    return json({ ok: false, error: err?.message ?? String(err) }, status);
  }
});
