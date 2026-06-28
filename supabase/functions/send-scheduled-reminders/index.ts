import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TWILIO_SID          = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_TOKEN        = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
// Support both secret name variants (TWILIO_PHONE_NUMBER is the correct one)
const TWILIO_FROM         = Deno.env.get('TWILIO_PHONE_NUMBER') ?? Deno.env.get('TWILIO_FROM_PHONE') ?? '';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Twilio ────────────────────────────────────────────────────────────────────
async function sendSms(to: string, body: string): Promise<{ ok: boolean; sid?: string; reason?: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.warn('Twilio not configured — SMS skipped', { sid: !!TWILIO_SID, token: !!TWILIO_TOKEN, from: !!TWILIO_FROM });
    return { ok: false, reason: 'twilio_not_configured' };
  }
  // Normalise to E.164
  const digits = to.replace(/\D/g, '');
  const e164   = digits.length === 10 ? '+1' + digits
               : digits.length === 11 && digits[0] === '1' ? '+' + digits
               : '+' + digits;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
    },
    body: new URLSearchParams({ To: e164, From: TWILIO_FROM, Body: body, StatusCallback: `${SUPABASE_URL}/functions/v1/twilio-status-callback` }).toString(),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, reason: data.message };

  // Log to sms_messages so the inbox shows it
  await db.from('sms_messages').insert({
    direction:   'outbound',
    to_number:   e164,
    from_number: TWILIO_FROM,
    body,
    twilio_sid:  data.sid,
    status:      data.status,
  });

  return { ok: true, sid: data.sid };
}

// ── Template lookup ──────────────────────────────────────────────────────
async function getTemplate(triggerKey: string): Promise<string | null> {
  const { data } = await db
    .from('message_templates')
    .select('sms_body, sms_enabled')
    .eq('trigger_key', triggerKey)
    .single();
  if (!data || !data.sms_enabled || !data.sms_body) return null;
  return data.sms_body;
}

// ── Interpolation ───────────────────────────────────────────────────────────────
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '').trim();
}

// ── Format address from addresses table row ─────────────────────────────────
// BUG FIX (2026-03-29): Always use the address joined from pickup_address_id,
// falling back to address_cache only if the order has no address row.
// Using address_cache as primary was showing the customer's default saved address
// instead of the address they selected for this specific order.
function fmtAddress(addr: any, fallback: string): string {
  if (!addr) return fallback;
  const parts = [
    addr.line1,
    addr.line2,
    addr.city && addr.state ? `${addr.city}, ${addr.state}` : (addr.city || addr.state),
    addr.zip,
  ].filter(Boolean);
  const formatted = parts.join(', ');
  return formatted || fallback;
}

// ── Human-readable pickup window ──────────────────────────────────────────────────────
function fmtWindow(start: string, end: string | null): string {
  const s = new Date(start);
  const opts: Intl.DateTimeFormatOptions = { timeZone: 'America/Los_Angeles' };
  const day  = s.toLocaleDateString('en-US', { ...opts, weekday: 'long' });
  const date = s.toLocaleDateString('en-US', { ...opts, month: 'short', day: 'numeric' });
  const t1   = s.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true })
                 .toLowerCase().replace(':00', '');
  if (!end) return `${day}, ${date} · ${t1}`;
  const e  = new Date(end);
  const t2 = e.toLocaleTimeString('en-US', { ...opts, hour: 'numeric', minute: '2-digit', hour12: true })
               .toLowerCase().replace(':00', '');
  return `${day}, ${date} · ${t1}–${t2}`;
}

// ── Reminder runners ─────────────────────────────────────────────────────────────────

/**
 * Day-before reminders.
 * Called at ~6pm PT (01:00 UTC). Finds orders whose pickup window starts
 * between 12h and 36h from now. Sends a single unified reminder to everyone.
 * Template: pickup_reminder_recurring (now the sole day-before template).
 */
async function runDayBefore(): Promise<number> {
  const now   = new Date();
  const from  = new Date(now.getTime() + 12 * 3_600_000).toISOString();
  const until = new Date(now.getTime() + 36 * 3_600_000).toISOString();

  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, order_number, pickup_window_start, pickup_window_end,
      reminder_day_before_sent_at,
      customers ( id, first_name_cache, phone_cache, address_cache, sms_notifications_opt_out_at ),
      services  ( name ),
      pickup_address:pickup_address_id ( line1, line2, city, state, zip )
    `)
    .in('status', ['scheduled', 'ready_for_pickup'])
    .gte('pickup_window_start', from)
    .lte('pickup_window_start', until)
    .is('reminder_day_before_sent_at', null);

  if (error) { console.error('runDayBefore query error:', error); return 0; }
  if (!orders?.length) return 0;

  const template = await getTemplate('pickup_reminder_recurring');
  if (!template) { console.warn('No day-before template found (pickup_reminder_recurring)'); return 0; }

  let sent = 0;
  for (const order of orders) {
    const cust = order.customers as { first_name_cache?: string; phone_cache?: string; address_cache?: string; sms_notifications_opt_out_at?: string | null } | null;
    if (!cust?.phone_cache) continue;
    if (cust.sms_notifications_opt_out_at) continue; // automated-SMS opt-out (session 174 — Kidango sites)

    // Use the order's actual pickup address; fall back to address_cache only if no address row
    const address = fmtAddress((order as any).pickup_address, cust.address_cache || '');

    const body = interpolate(template, {
      first_name:    cust.first_name_cache || 'there',
      pickup_window: fmtWindow(order.pickup_window_start, order.pickup_window_end),
      time_window:   fmtWindow(order.pickup_window_start, order.pickup_window_end),
      service:       (order as any).services?.name || 'laundry',
      address,
    });

    const result = await sendSms(cust.phone_cache, body);
    console.log(`day-before order=${order.id}`, result);
    if (result.ok) {
      await db.from('orders')
        .update({ reminder_day_before_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      sent++;
    }
  }
  return sent;
}

/**
 * Day-of reminders.
 * Called at ~7am PT (14:00 UTC). Finds orders whose pickup window has not yet
 * ended and starts within the next 14 hours.
 */
async function runDayOf(): Promise<number> {
  const now   = new Date();
  const until = new Date(now.getTime() + 14 * 3_600_000).toISOString();

  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, order_number, pickup_window_start, pickup_window_end,
      reminder_day_of_sent_at,
      customers ( id, first_name_cache, phone_cache, address_cache, sms_notifications_opt_out_at ),
      services  ( name ),
      pickup_address:pickup_address_id ( line1, line2, city, state, zip )
    `)
    .in('status', ['scheduled', 'ready_for_pickup'])
    .gte('pickup_window_end', now.toISOString())
    .lte('pickup_window_start', until)
    .is('reminder_day_of_sent_at', null);

  if (error) { console.error('runDayOf query error:', error); return 0; }
  if (!orders?.length) return 0;

  const template = await getTemplate('pickup_day_reminder');
  if (!template) { console.warn('No day-of template found'); return 0; }

  let sent = 0;
  for (const order of orders) {
    const cust = order.customers as { first_name_cache?: string; phone_cache?: string; address_cache?: string; sms_notifications_opt_out_at?: string | null } | null;
    if (!cust?.phone_cache) continue;
    if (cust.sms_notifications_opt_out_at) continue; // automated-SMS opt-out (session 174 — Kidango sites)

    // Use the order's actual pickup address; fall back to address_cache only if no address row
    const address = fmtAddress((order as any).pickup_address, cust.address_cache || '');

    const body = interpolate(template, {
      first_name:    cust.first_name_cache || 'there',
      pickup_window: fmtWindow(order.pickup_window_start, order.pickup_window_end),
      time_window:   fmtWindow(order.pickup_window_start, order.pickup_window_end),
      service:       (order as any).services?.name || 'laundry',
      address,
    });

    const result = await sendSms(cust.phone_cache, body);
    console.log(`day-of order=${order.id}`, result);
    if (result.ok) {
      await db.from('orders')
        .update({ reminder_day_of_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      sent++;
    }
  }
  return sent;
}

/**
 * Reorder reminders.
 * Finds delivered orders 18-25 days old where the customer has no current
 * active order. Sends one nudge to rebook.
 */
async function runReorder(): Promise<number> {
  const now  = new Date();
  const from = new Date(now.getTime() - 25 * 86_400_000).toISOString();
  const to   = new Date(now.getTime() - 18 * 86_400_000).toISOString();

  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, customer_id, actual_delivery_at, reorder_reminder_sent_at,
      customers ( id, first_name_cache, phone_cache, sms_notifications_opt_out_at ),
      services  ( name )
    `)
    .eq('status', 'delivered')
    .gte('actual_delivery_at', from)
    .lte('actual_delivery_at', to)
    .is('reorder_reminder_sent_at', null);

  if (error) { console.error('runReorder query error:', error); return 0; }
  if (!orders?.length) return 0;

  const template = await getTemplate('reorder_reminder');
  if (!template) { console.warn('No reorder_reminder template found'); return 0; }

  let sent = 0;
  for (const order of orders) {
    const cust = order.customers as { id?: string; first_name_cache?: string; phone_cache?: string; sms_notifications_opt_out_at?: string | null } | null;
    if (!cust?.phone_cache || !cust.id) continue;
    if (cust.sms_notifications_opt_out_at) continue; // automated-SMS opt-out (session 174 — Kidango sites)

    // Skip if customer already has an active order
    const { data: active } = await db
      .from('orders')
      .select('id')
      .eq('customer_id', cust.id)
      .not('status', 'in', '(delivered,cancelled)')
      .limit(1);
    if (active?.length) continue;

    const body = interpolate(template, {
      first_name: cust.first_name_cache || 'there',
      service:    (order as any).services?.name || 'laundry',
    });

    const result = await sendSms(cust.phone_cache, body);
    console.log(`reorder order=${order.id}`, result);
    if (result.ok) {
      await db.from('orders')
        .update({ reorder_reminder_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      sent++;
    }
  }
  return sent;
}

/**
 * Review request.
 * Fires 2 days after delivery. Reads the review_link URL from settings table
 * (editable in Admin → Settings) and substitutes it into the review_request
 * template's {{review_link}} tag.
 */
async function runReviewRequest(): Promise<number> {
  const now  = new Date();
  // 2 days ago window: between 44h and 56h after delivery
  const from = new Date(now.getTime() - 56 * 3_600_000).toISOString();
  const to   = new Date(now.getTime() - 44 * 3_600_000).toISOString();

  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, customer_id, actual_delivery_at, review_request_sent_at,
      customers ( id, first_name_cache, phone_cache, sms_notifications_opt_out_at )
    `)
    .eq('status', 'delivered')
    .gte('actual_delivery_at', from)
    .lte('actual_delivery_at', to)
    .is('review_request_sent_at', null);

  if (error) { console.error('runReviewRequest query error:', error); return 0; }
  if (!orders?.length) return 0;

  const template = await getTemplate('review_request');
  if (!template) { console.warn('No review_request template found'); return 0; }

  // Read the review link from admin settings
  const { data: settings } = await db
    .from('settings')
    .select('review_link')
    .eq('id', 1)
    .single();
  const reviewLink = settings?.review_link || '';
  if (!reviewLink) {
    console.warn('No review_link configured in settings — skipping review requests');
    return 0;
  }

  let sent = 0;
  for (const order of orders) {
    const cust = order.customers as { id?: string; first_name_cache?: string; phone_cache?: string; sms_notifications_opt_out_at?: string | null } | null;
    if (!cust?.phone_cache || !cust.id) continue;
    if (cust.sms_notifications_opt_out_at) continue; // automated-SMS opt-out (session 174 — Kidango sites)

    // Only send one review request per customer (check if we already sent one for a different order)
    const { data: alreadySent } = await db
      .from('orders')
      .select('id')
      .eq('customer_id', cust.id)
      .not('review_request_sent_at', 'is', null)
      .limit(1);
    if (alreadySent?.length) {
      // Mark this order too so we don't keep checking it
      await db.from('orders')
        .update({ review_request_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      continue;
    }

    const body = interpolate(template, {
      first_name:  cust.first_name_cache || 'there',
      review_link: reviewLink,
    });

    const result = await sendSms(cust.phone_cache, body);
    console.log(`review_request order=${order.id}`, result);
    if (result.ok) {
      await db.from('orders')
        .update({ review_request_sent_at: new Date().toISOString() })
        .eq('id', order.id);
      sent++;
    }
  }
  return sent;
}

// ── Handler ────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  let type = 'all';
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      type = body.type ?? 'all';
    } catch { /* no body — run all */ }
  }

  const results: Record<string, number> = {};
  try {
    if (type === 'day_before' || type === 'all') {
      results.day_before = await runDayBefore();
    }
    if (type === 'day_of' || type === 'morning' || type === 'all') {
      results.day_of = await runDayOf();
    }
    if (type === 'reorder' || type === 'morning' || type === 'all') {
      results.reorder = await runReorder();
    }
    if (type === 'review' || type === 'morning' || type === 'all') {
      results.review_request = await runReviewRequest();
    }
  } catch (e) {
    console.error('send-scheduled-reminders error:', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('send-scheduled-reminders complete:', results);
  return new Response(JSON.stringify({ ok: true, sent: results }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
