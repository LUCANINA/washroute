import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TWILIO_SID          = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_TOKEN        = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
// Support both secret name variants (TWILIO_PHONE_NUMBER is the correct one)
const TWILIO_FROM         = Deno.env.get('TWILIO_PHONE_NUMBER') ?? Deno.env.get('TWILIO_FROM_PHONE') ?? '';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Twilio ────────────────────────────────────────────────────────────────────
async function sendSms(to: string, body: string, customerId?: string): Promise<{ ok: boolean; sid?: string; reason?: string }> {
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
    customer_id: customerId ?? null,
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
 * Rating request (2026-09-16 — replaces the old direct review-link text).
 * Morning run. Texts a link to rate the order in the app:
 *   https://app.familylaundry.com/?rate=<order id>
 * The app offers the public review link to EVERY rater, whatever the score
 * (no review gating). Rules:
 *   - order delivered 12–60h ago, not billed as failed, not rated yet
 *   - individual customers only (not on-account businesses), phone on file,
 *     automated SMS not turned off, no open issue on the account
 *   - at most one rating text per customer every 30 days
 *   - at most MAX_PER_RUN texts per run (safety cap)
 * Template: review_request ({{first_name}}, {{order_number}}, {{rate_link}};
 * {{review_link}} is kept as an alias of the rate link for old templates).
 */
const RATING_MAX_PER_RUN = 60;
async function runReviewRequest(): Promise<number> {
  const now  = new Date();
  const from = new Date(now.getTime() - 60 * 3_600_000).toISOString();
  const to   = new Date(now.getTime() - 12 * 3_600_000).toISOString();

  const template = await getTemplate('review_request');
  if (!template) return 0;   // switched off in Notifications

  const { data: orders, error } = await db
    .from('orders')
    .select(`
      id, order_number, customer_id, actual_delivery_at, billing_status,
      customers ( id, first_name_cache, phone_cache, billing_type, sms_notifications_opt_out_at )
    `)
    .eq('status', 'delivered')
    .gte('actual_delivery_at', from)
    .lte('actual_delivery_at', to)
    .is('review_request_sent_at', null)
    .order('actual_delivery_at', { ascending: true })
    .limit(500);

  if (error) { console.error('runReviewRequest query error:', error); return 0; }
  if (!orders?.length) return 0;

  const markDone = (orderId: string) =>
    db.from('orders').update({ review_request_sent_at: new Date().toISOString() }).eq('id', orderId);
  const since30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const texted = new Set<string>();

  let sent = 0;
  for (const order of orders) {
    if (sent >= RATING_MAX_PER_RUN) break;
    const cust = order.customers as { id?: string; first_name_cache?: string; phone_cache?: string; billing_type?: string; sms_notifications_opt_out_at?: string | null } | null;
    if (!cust?.id || !cust.phone_cache) { await markDone(order.id); continue; }
    if (cust.sms_notifications_opt_out_at || cust.billing_type === 'on_account') { await markDone(order.id); continue; }
    if (order.billing_status === 'failed') continue;          // may become eligible once paid, within the window
    if (texted.has(cust.id)) { await markDone(order.id); continue; }

    const [{ data: rated }, { data: recent }, { data: openIssue }] = await Promise.all([
      db.from('order_feedback').select('id').eq('order_id', order.id).limit(1),
      db.from('orders').select('id').eq('customer_id', cust.id).neq('id', order.id)
        .gte('review_request_sent_at', since30).limit(1),
      db.from('cs_issues').select('id').eq('customer_id', cust.id).eq('status', 'open').limit(1),
    ]);
    if (rated?.length || recent?.length) { await markDone(order.id); continue; }
    if (openIssue?.length) continue;                            // ask later if the issue is resolved in time

    const rateLink = `https://app.familylaundry.com/?rate=${order.id}`;
    const body = interpolate(template, {
      first_name:   cust.first_name_cache || 'there',
      order_number: String(order.order_number ?? ''),
      rate_link:    rateLink,
      review_link:  rateLink,
    });

    const result = await sendSms(cust.phone_cache, body, cust.id);
    console.log(`review_request (rating) order=${order.id}`, result);
    if (result.ok) {
      await markDone(order.id);
      texted.add(cust.id);
      sent++;
    }
  }
  return sent;
}

// ── Handler ────────────────────────────────────────────────────────────────────────────
// ── Authorization ─────────────────────────────────────────────────────────
// Cron-only endpoint: it fans SMS out to every customer with an upcoming
// pickup and burns the one-shot *_sent_at flags, so a single unauthenticated
// {"type":"all"} would both mass-text customers AND silence the real 6pm run.
// The ONLY accepted credential is the service-role key that pg_cron presents.
// No CORS/OPTIONS handling here on purpose — there is no browser caller.
function isServiceRole(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1] === SUPABASE_SERVICE_KEY && SUPABASE_SERVICE_KEY.length > 0;
}


// ── Session 228: internal-caller auth (pg_cron / DB functions) ──────────────
// pg_cron and SECURITY DEFINER DB functions reach edge functions through
// net.http_post and CANNOT present the service-role key — it is not stored
// anywhere reachable from SQL and the Supabase vault is empty. Every pg_cron
// HTTP job in this project sends the ANON key, which is why session 227 held
// these four functions back: hardening them to require the service-role key
// would have killed their cron silently.
//
// They now send the shared secret from public.wr_internal_auth (RLS on, no
// policies, no anon/authenticated grants — only a service-role client can read
// it) as the x-wr-internal header, via public.wr_internal_secret(). Same
// mechanism charge-order / send-email / send-order-notification already use.
// See migration session_227h_internal_call_secret.
async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const c = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data } = await c.from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch (_) {
    return false
  }
}

Deno.serve(async (req: Request) => {
  if (!isServiceRole(req) && !(await isInternalCall(req))) {
    console.warn('send-scheduled-reminders: rejected caller without service-role key');
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
