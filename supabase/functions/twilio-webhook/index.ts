import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_ACCOUNT_SID  = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const TWILIO_AUTH_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_WEBHOOK_URL  = Deno.env.get('TWILIO_WEBHOOK_URL')
  || `${SUPABASE_URL}/functions/v1/twilio-webhook`;

const SMS_MEDIA_BUCKET = 'sms-media';

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const TWIML_HDRS  = { 'Content-Type': 'text/xml' };

async function verifyTwilioSignature(req: Request, formData: FormData): Promise<boolean> {
  const sigHeader = req.headers.get('X-Twilio-Signature')
    || req.headers.get('x-twilio-signature');
  if (!sigHeader) return false;
  if (!TWILIO_AUTH_TOKEN) {
    console.error('twilio-webhook: TWILIO_AUTH_TOKEN env var not set — cannot verify signatures');
    return false;
  }

  const params: [string, string][] = [];
  for (const [k, v] of formData.entries()) {
    if (typeof v === 'string') params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let data = TWILIO_WEBHOOK_URL;
  for (const [k, v] of params) data += k + v;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  if (expected.length !== sigHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

function twimlMessage(msg: string): string {
  const safe = msg.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function fmtDatePT(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

// ── Skip-request classifier (2026-09-21) ──
// "Skip pick up today thanks" used to fall through to the staff inbox because
// only a handful of exact phrasings counted. Now: the text must contain SKIP
// and EVERY other word must come from a small filler list. Any
// other word — a name, "don't", "not", "next", "and", a question about
// something else — means a human reads it. Returns null when it isn't a skip.
// `when` is the day the customer named, checked against the order in handleSkip.
export type SkipWhen = 'today' | 'tomorrow' | 'week' | null;
const SKIP_FILLER = new Set([
  'PLEASE','PLS','PLZ','CAN','COULD','WOULD','YOU','WE','I','HI','HELLO','HEY','OK','OKAY',
  'PICK','UP','PICKUP','PICKUPS','MY','THE','OUR','ORDER','LAUNDRY','ME','US','IT','FOR',
  'NEED','WANT','TO','JUST','TIME','SORRY',
  'TODAY','TODAYS','TONIGHT','TONITE','TOMORROW','TOMORROWS','TMRW','THIS','WEEK','WEEKS',
  'THANKS','THANK','THX','TY','TNX',
]);
export function classifySkip(body: string): { when: SkipWhen } | null {
  const words = (body || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.includes('SKIP')) return null;
  if (!words.every(w => w === 'SKIP' || SKIP_FILLER.has(w))) return null;
  const has = (...ws: string[]) => ws.some(w => words.includes(w));
  const namesToday = has('TODAY', 'TODAYS', 'TONIGHT', 'TONITE');
  const namesTomorrow = has('TOMORROW', 'TOMORROWS', 'TMRW');
  if (namesToday && namesTomorrow) return null;           // contradictory — let a human decide
  if (namesToday) return { when: 'today' };
  if (namesTomorrow) return { when: 'tomorrow' };
  if (has('WEEK', 'WEEKS')) return { when: 'week' };
  return { when: null };
}

// YYYY-MM-DD in Pacific time, `addDays` from now (or from `iso` when given).
function ptDateKey(iso?: string, addDays = 0): string {
  const d = iso ? new Date(iso) : new Date(Date.now() + addDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '').trim();
}

// 2026-09-16: offset is taken for the DATE BEING BOOKED, not today — otherwise a
// booking made before a DST change for a day after it lands an hour off.
function getPtOffsetHours(y?: number, mo?: number, d?: number): number {
  const base = new Date();
  const noon = new Date(Date.UTC(
    y ?? base.getUTCFullYear(), mo !== undefined ? mo - 1 : base.getUTCMonth(), d ?? base.getUTCDate(), 12
  ));
  const ptNoonHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
    }).format(noon)
  );
  return 12 - ptNoonHour;
}

const ptDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

// WashRoute's route_templates.schedule_days uses the convention 0=Mon … 6=Sun.
// JavaScript's Date.getDay() uses 0=Sun … 6=Sat, so it must be converted with
// (getDay() + 6) % 7 before comparing against schedule_days — the same
// conversion used throughout the customer app and admin dashboard. Without it,
// Sunday (getDay()=0) falsely matches schedule_days value 0 (which means Monday),
// so the SMS reorder would book closed Sundays and never book Saturdays.
function wrDow(y: number, m: number, d: number): number {
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

function getNextPickupDayPT(
  schedDays: number[],
  holidays?: Set<string>
): { dateStr: string; year: number; month: number; day: number } | null {
  for (let ahead = 1; ahead <= 14; ahead++) {
    const utcMs   = Date.now() + ahead * 86_400_000;
    const dateStr = ptDateFmt.format(new Date(utcMs));
    const [y,m,d] = dateStr.split('-').map(Number);
    const dow     = wrDow(y, m, d);
    if (schedDays.includes(dow) && !(holidays && holidays.has(dateStr))) return { dateStr, year: y, month: m, day: d };
  }
  return null;
}

// Resolve the first delivery date on or after (pickup + turnaround_days) that
// actually has a route running, per the template's schedule_days. Mirrors the
// customer app's getNextDeliveryDay — without this, a Saturday pickup with a
// 1-day turnaround would schedule a Sunday delivery on a day no route runs.
function getNextDeliveryDayPT(
  py: number, pm: number, pd: number, turnaround: number, schedDays: number[],
  holidays?: Set<string>
): { year: number; month: number; day: number } {
  for (let extra = 0; extra <= 21; extra++) {
    const dt = new Date(Date.UTC(py, pm - 1, pd + turnaround + extra));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const ds = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (schedDays.includes(wrDow(y, m, d)) && !(holidays && holidays.has(ds))) return { year: y, month: m, day: d };
  }
  // Fallback: literal pickup + turnaround (should never hit given 14-day walk)
  const fb = new Date(Date.UTC(py, pm - 1, pd + turnaround));
  return { year: fb.getUTCFullYear(), month: fb.getUTCMonth() + 1, day: fb.getUTCDate() };
}

function ptDateTimeToUtc(y: number, mo: number, d: number, h: number, min: number): string {
  const offsetH = getPtOffsetHours(y, mo, d);
  return new Date(Date.UTC(y, mo - 1, d, h + offsetH, min, 0)).toISOString();
}

function fmt12h(h: number): string {
  if (h === 0)  return '12am';
  if (h === 12) return '12pm';
  return h > 12 ? `${h - 12}pm` : `${h}am`;
}

async function dbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SVC_KEY}`, apikey: SUPABASE_SVC_KEY },
  });
  return res.json();
}

async function dbPatch(path: string, payload: object) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      apikey: SUPABASE_SVC_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
}

async function logSms(payload: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      apikey: SUPABASE_SVC_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

// ── proxyTwilioMedia ──
// Twilio webhooks include MediaUrlN form fields when the inbound message has
// attachments (an MMS). The URLs are tied to the Twilio account lifetime and
// require basic auth to fetch — neither is suitable for direct rendering in
// the admin UI. So for each piece of media we:
//   1. Fetch from Twilio (basic-auth with our account SID + auth token).
//   2. Re-upload to our own public sms-media bucket under
//      inbound/<yyyy-mm-dd>/<MessageSid>-<idx>.<ext> (deterministic, idempotent
//      against retries — Twilio retries with the same Sid on 5xx).
//   3. Return the bucket's public URL paired with the original content type.
// On any per-piece failure we log + continue; the SMS is still saved (with a
// shorter media_urls array) rather than dropped. We never want to lose an
// inbound message because of a media side-effect.
function extFromContentType(ct: string): string {
  const t = (ct || '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png'))  return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('heic')) return 'heic';
  if (t.includes('gif'))  return 'gif';
  if (t.includes('mp4'))  return 'mp4';
  if (t.includes('quicktime') || t.includes('mov')) return 'mov';
  if (t.includes('pdf'))  return 'pdf';
  return 'bin';
}

async function proxyTwilioMedia(
  formData: FormData,
  sid: string,
): Promise<Array<{ url: string; content_type: string }>> {
  const numMedia = parseInt((formData.get('NumMedia') as string) || '0', 10);
  if (!numMedia || numMedia <= 0) return [];

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('proxyTwilioMedia: TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN unset — cannot fetch media');
    return [];
  }

  const datePrefix = ptDateFmt.format(new Date()); // YYYY-MM-DD in PT
  const basicAuth  = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  const cleanSid   = (sid || `sms-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const out: Array<{ url: string; content_type: string }> = [];

  for (let i = 0; i < numMedia; i++) {
    const url = formData.get(`MediaUrl${i}`) as string;
    const ct  = (formData.get(`MediaContentType${i}`) as string) || 'application/octet-stream';
    if (!url) continue;

    try {
      // Twilio's MediaUrl issues a 302 redirect to the actual media host
      // (S3) which serves the bytes without auth. Following redirects with
      // the auth header attached is harmless; Deno's fetch follows by
      // default.
      const mediaRes = await fetch(url, { headers: { Authorization: basicAuth } });
      if (!mediaRes.ok) {
        console.error(`proxyTwilioMedia: fetch ${url} -> ${mediaRes.status}`);
        continue;
      }
      const bytes = new Uint8Array(await mediaRes.arrayBuffer());

      const ext     = extFromContentType(ct);
      const path    = `inbound/${datePrefix}/${cleanSid}-${i}.${ext}`;
      const upRes   = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${SMS_MEDIA_BUCKET}/${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
            apikey: SUPABASE_SVC_KEY,
            'Content-Type': ct,
            'x-upsert': 'true',
          },
          body: bytes,
        },
      );
      if (!upRes.ok) {
        const errText = await upRes.text().catch(() => '');
        console.error(`proxyTwilioMedia: upload failed ${path} -> ${upRes.status} ${errText}`);
        continue;
      }

      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SMS_MEDIA_BUCKET}/${path}`;
      out.push({ url: publicUrl, content_type: ct });
    } catch (e) {
      console.error(`proxyTwilioMedia: exception for MediaUrl${i}:`, e);
      // continue — never block the message log on a media error
    }
  }

  return out;
}

async function handleStop(customerId: string | null, from: string, to: string): Promise<string> {
  if (customerId) {
    await dbPatch(`customers?id=eq.${customerId}`, {
      sms_consent_at: null,
      sms_marketing_opt_out_at: new Date().toISOString(),
    });
  }
  const reply = "You've been unsubscribed from Family Laundry texts. Reply START to re-subscribe anytime.";
  if (customerId) {
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
  }
  return twimlMessage(reply);
}

async function handleStart(customerId: string | null, from: string, to: string): Promise<string> {
  if (customerId) {
    await dbPatch(`customers?id=eq.${customerId}`, {
      sms_consent_at: new Date().toISOString(),
      sms_marketing_opt_out_at: null,
    });
  }
  const reply = "You're re-subscribed to Family Laundry texts! Reply STOP to opt out anytime.";
  if (customerId) {
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
  }
  return twimlMessage(reply);
}

async function handleSkip(customerId: string, from: string, to: string, when: SkipWhen = null): Promise<string | null> {
  // session 137: also fetch recurring_interval so we know whether to use the
  // recurring or one-time skip-confirmation template. The two templates differ
  // in their tail copy: recurring says "see you on your next pickup"
  // (the chain auto-continues via trg_create_recurring_order_fn), one-time
  // says "text PICKUP anytime" because there is no next pickup queued.
  const orders = await dbGet(
    `orders?customer_id=eq.${customerId}&status=in.(scheduled,ready_for_pickup)&order=pickup_window_start.asc&limit=1` +
    `&select=id,pickup_window_start,recurring_interval`
  );
  const order = Array.isArray(orders) ? orders[0] : null;

  if (!order) {
    return twimlMessage(
      "We don't see an upcoming pickup scheduled for your number. Reply or visit app.familylaundry.com for help."
    );
  }

  // The customer named a day: only act if the next pickup is actually on it.
  // Otherwise (e.g. "skip tomorrow" while today's pickup is next) a human
  // decides — return null and the caller routes the text to the staff inbox.
  if (when) {
    const pickupDay = order.pickup_window_start ? ptDateKey(order.pickup_window_start) : '';
    const ok = when === 'today'    ? pickupDay === ptDateKey()
             : when === 'tomorrow' ? pickupDay === ptDateKey(undefined, 1)
             : /* week */            !!pickupDay && pickupDay >= ptDateKey() && pickupDay <= ptDateKey(undefined, 7);
    if (!ok) {
      console.log(`Skip request names "${when}" but next pickup is ${pickupDay || 'undated'} — routed to staff inbox`);
      return null;
    }
  }

  await dbPatch(`orders?id=eq.${order.id}`, { status: 'skipped', cancelled_by: 'customer' });

  // Pick the right template by recurring_interval. Either explicit value or
  // null/empty — anything non-null+non-empty is treated as recurring.
  const isRecurring = order.recurring_interval && order.recurring_interval !== '';
  const templateKey = isRecurring ? 'skip_confirmation_recurring' : 'skip_confirmation_one_time';

  const tmpls = await dbGet(
    `message_templates?trigger_key=eq.${templateKey}&sms_enabled=eq.true&limit=1`
  );
  const tmpl = Array.isArray(tmpls) ? tmpls[0] : null;
  const pickupDate = order.pickup_window_start ? fmtDatePT(order.pickup_window_start) : 'your upcoming pickup';

  // Hardcoded fallbacks differ by branch — used only if the template was
  // deleted or sms_enabled was toggled off without redeploying the handler.
  const fallback = isRecurring
    ? `Got it! We've skipped your pickup on ${pickupDate}. See you next time!`
    : `Got it! We've skipped your pickup on ${pickupDate}. Text PICKUP when you're ready to schedule another.`;

  const msgBody = tmpl?.sms_body
    ? interpolate(tmpl.sms_body, { pickup_date: pickupDate })
    : fallback;

  await logSms({ customer_id: customerId, direction: 'outbound', body: msgBody, from_number: to, to_number: from, status: 'sent' });
  return twimlMessage(msgBody);
}

async function handlePickup(
  customerId: string, firstName: string, from: string, to: string
): Promise<string> {
  const activeStatuses = 'scheduled,picked_up,processing,ready_for_delivery,on_hold';
  // 2026-09-16: these lookups don't depend on each other — run them together
  // instead of one after another (~4s → ~1.5s end to end).
  const [existing, lastOrders, custRows, svcRows, holRows, recentOrders] = await Promise.all([
    dbGet(
      `orders?customer_id=eq.${customerId}&status=in.(${activeStatuses})&limit=1` +
      `&select=order_number,status,pickup_window_start`
    ),
    dbGet(
      `orders?customer_id=eq.${customerId}&status=eq.delivered&order=created_at.desc&limit=1` +
      `&select=zone_id,pickup_address_id,delivery_address_id,service_id,total_bags`
    ),
    dbGet(`customers?id=eq.${customerId}&select=pricelist,route_template_override_id&limit=1`),
    dbGet(`services?is_active=eq.true&is_addon=eq.false&order=sort_order.asc&select=id,pricelist`),
    dbGet('holidays?select=holiday_date'),
    // Last 6 real bookings — used to find the customer's usual pickup time.
    dbGet(
      `orders?customer_id=eq.${customerId}&status=not.in.(cancelled,skipped)` +
      `&pickup_window_start=not.is.null&order=pickup_window_start.desc&limit=6&select=pickup_window_start`
    ),
  ]);
  const activeOrder = Array.isArray(existing) ? existing[0] : null;
  if (activeOrder) {
    const pickupDate = activeOrder.pickup_window_start ? fmtDatePT(activeOrder.pickup_window_start) : 'upcoming';
    const reply = `Hi ${firstName}! You already have order #${activeOrder.order_number} scheduled for ${pickupDate}. ` +
                  `Visit app.familylaundry.com to make changes.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const lastOrder = Array.isArray(lastOrders) ? lastOrders[0] : null;

  let zoneId: string | null         = lastOrder?.zone_id             || null;
  let pickupAddrId: string | null   = lastOrder?.pickup_address_id   || null;
  let deliveryAddrId: string | null = lastOrder?.delivery_address_id || lastOrder?.pickup_address_id || null;
  const bags: number                = lastOrder?.total_bags || 2;

  // 2026-09-16: every order needs a service (orders_require_service_unless_walkin).
  // Use the base service for the customer's CURRENT price list — same rule as the
  // customer app's getCustomerService(). A customer with no delivered order used to
  // send service_id=null and always got "We had trouble booking your pickup".
  // The last order's service is only a fallback (a price list with no base service).
  let serviceId: string | null = null;
  {
    const pricelist = (Array.isArray(custRows) ? custRows[0]?.pricelist : null) || 'Delivery';
    const svcs = Array.isArray(svcRows) ? svcRows as { id: string; pricelist: string | null }[] : [];
    for (const pl of [pricelist, 'Delivery']) {
      serviceId = svcs.find(v => v.pricelist === pl)?.id || null;
      if (serviceId) break;
    }
  }
  if (!serviceId) serviceId = lastOrder?.service_id || null;

  if (!pickupAddrId) {
    const addrs = await dbGet(`addresses?customer_id=eq.${customerId}&is_default=eq.true&limit=1&select=id,lat,lng`);
    const addr  = Array.isArray(addrs) ? addrs[0] : null;
    if (!addr) {
      const reply = `Hi ${firstName}! We couldn't find a saved address. Please book at app.familylaundry.com.`;
      await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
      return twimlMessage(reply);
    }
    pickupAddrId   = addr.id;
    deliveryAddrId = addr.id;

    if (!zoneId && addr.lat && addr.lng) {
      const zoneRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_zones_for_point`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
          apikey: SUPABASE_SVC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lat: parseFloat(addr.lat), lng: parseFloat(addr.lng) }),
      });
      const zones = await zoneRes.json();
      zoneId = Array.isArray(zones) ? zones[0]?.id || null : null;
    }
  }

  if (!zoneId) {
    const reply = `Hi ${firstName}! We couldn't confirm your service area. Please book at app.familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  // ── Pick the slot (2026-09-16) ─────────────────────────────────────────────
  // Same availability the customer app uses (get_slot_availability: honours the
  // customer's route override and slot capacity), today + the next 7 days, and
  // the same booking cutoff (a slot can be booked until booking_cutoff_minutes
  // before it ENDS). If the customer has a usual pickup time we book the earliest
  // open slot at that time; otherwise the earliest open slot, tonight included.
  const holidaySet = new Set((Array.isArray(holRows) ? holRows : []).map((h: { holiday_date: string }) => h.holiday_date));
  const overrideId: string | null = (Array.isArray(custRows) ? custRows[0]?.route_template_override_id : null) || null;

  const tmplRows = await dbGet(
    `route_templates?is_active=eq.true&` +
    (overrideId ? `id=eq.${overrideId}` : `zone_id=eq.${zoneId}`) +
    `&select=id,schedule_days,turnaround_days,booking_cutoff_minutes`
  );
  const tmplById = new Map<string, { schedule_days: number[] | null; turnaround_days: number | null; booking_cutoff_minutes: number | null }>();
  (Array.isArray(tmplRows) ? tmplRows : []).forEach((t: any) => tmplById.set(t.id, t));

  type Slot = { date: string; y: number; m: number; d: number; templateId: string; startHHMM: string; startH: number; startM: number; endH: number; endM: number; startMs: number };
  const nowMs = Date.now();
  const dates: { date: string; y: number; m: number; d: number }[] = [];
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = ptDateFmt.format(new Date(nowMs + ahead * 86_400_000));
    if (holidaySet.has(date) || dates.some(x => x.date === date)) continue;
    const [y, m, d] = date.split('-').map(Number);
    dates.push({ date, y, m, d });
  }
  const perDate = await Promise.all(dates.map(dt =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/get_slot_availability`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SVC_KEY}`, apikey: SUPABASE_SVC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_zone_id: zoneId, p_date: dt.date, p_customer_id: customerId }),
    }).then(r => r.ok ? r.json() : []).catch(() => [])
  ));

  const slots: Slot[] = [];
  perDate.forEach((rows, i) => {
    const dt = dates[i];
    (Array.isArray(rows) ? rows : []).forEach((r: any) => {
      const t = tmplById.get(r.template_id);
      if (!t) return;
      if (r.sub_window_limit != null && Number(r.active_stops) >= Number(r.sub_window_limit)) return; // full
      const [sh, sm] = String(r.sub_window_start).split(':').map(Number);
      const [eh, em] = String(r.sub_window_end).split(':').map(Number);
      const endMs    = new Date(ptDateTimeToUtc(dt.y, dt.m, dt.d, eh, em)).getTime();
      const cutoffMs = (t.booking_cutoff_minutes ?? 60) * 60_000;
      if (endMs - cutoffMs <= nowMs) return;                                                          // too late to book
      slots.push({ ...dt, templateId: r.template_id, startHHMM: `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`,
        startH: sh, startM: sm, endH: eh, endM: em,
        startMs: new Date(ptDateTimeToUtc(dt.y, dt.m, dt.d, sh, sm)).getTime() });
    });
  });
  slots.sort((a, b) => a.startMs - b.startMs);

  // Usual time = the pickup start time used in at least 2 (and at least half)
  // of the customer's last 6 bookings.
  let usualHHMM: string | null = null;
  {
    const times = (Array.isArray(recentOrders) ? recentOrders : []).map((o: any) =>
      new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false })
        .format(new Date(o.pickup_window_start)));
    const counts = new Map<string, number>();
    times.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
    let best = 0, tie = false;
    counts.forEach((n, t) => {
      if (n > best) { best = n; usualHHMM = t; tie = false; }
      else if (n === best) tie = true;
    });
    // No clear habit (e.g. 3 mornings + 3 evenings) → earliest open slot.
    if (tie || best < 2 || best * 2 < times.length) usualHHMM = null;
  }

  const chosen = (usualHHMM ? slots.find(x => x.startHHMM === usualHHMM) : undefined) || slots[0];
  if (!chosen) {
    const reply = `Hi ${firstName}! No pickup slots are open in the next week. Please book at app.familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }
  console.log(`PICKUP slot: usual=${usualHHMM ?? '-'} chosen=${chosen.date} ${chosen.startHHMM} tmpl=${chosen.templateId} open_slots=${slots.length}`);

  const rt = tmplById.get(chosen.templateId)!;
  const wStartH = chosen.startH, wStartM = chosen.startM;
  const subEndH = chosen.endH, subEndM = chosen.endM;
  const turnaround: number = rt.turnaround_days ?? 1;
  const { y: py, m: pm, d: pd } = chosen;
  const pickupStart = ptDateTimeToUtc(py, pm, pd, wStartH, wStartM);
  const pickupEnd   = ptDateTimeToUtc(py, pm, pd, subEndH, subEndM);

  const { year: dy, month: dmo, day: dd } =
    getNextDeliveryDayPT(py, pm, pd, turnaround, rt.schedule_days ?? [0,1,2,3,4,5], holidaySet);
  const delivStart = ptDateTimeToUtc(dy, dmo, dd, wStartH, wStartM);
  const delivEnd   = ptDateTimeToUtc(dy, dmo, dd, subEndH, subEndM);
  const isToday    = chosen.date === ptDateFmt.format(new Date(nowMs));

  const orderPayload = {
    customer_id:           customerId,
    service_id:            serviceId,
    status:                'scheduled',
    total_bags:            bags,
    total_amount:          0,
    pickup_window_start:   pickupStart,
    pickup_window_end:     pickupEnd,
    delivery_window_start: delivStart,
    delivery_window_end:   delivEnd,
    zone_id:               zoneId,
    pickup_address_id:     pickupAddrId,
    delivery_address_id:   deliveryAddrId,
    line_items:            [{ type: 'base', label: `${bags} bag${bags !== 1 ? 's' : ''}`, amount: 0 }],
    source:                'scheduled',
    recurring_interval:    null,
  };

  const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      apikey: SUPABASE_SVC_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(orderPayload),
  });

  if (!orderRes.ok) {
    const err = await orderRes.json().catch(() => ({}));
    console.error('PICKUP order creation failed:', JSON.stringify(err));
    const reply = `Hi ${firstName}! We had trouble booking your pickup. Please try at app.familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const orderJson = await orderRes.json();
  const newOrder  = Array.isArray(orderJson) ? orderJson[0] : orderJson;
  if (!newOrder?.order_number) {
    const reply = `Hi ${firstName}! Your pickup was booked but we had trouble confirming the details. Check app.familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }
  const pickupDateLabel = isToday ? `today (${fmtDatePT(pickupStart)})` : fmtDatePT(pickupStart);
  const windowLabel     = `${fmt12h(wStartH)}–${fmt12h(subEndH)}`;

  const reply =
    `Got it, ${firstName}! Your pickup is booked for ${pickupDateLabel} between ${windowLabel}. ` +
    `Order #${newOrder.order_number}. Please have your bags ready outside before ${fmt12h(wStartH)}. ` +
    `We'll text you when your driver is on the way! Need to cancel? Reply SKIP.`;

  await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
  return twimlMessage(reply);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const formData = await req.formData();

    const sigOk = await verifyTwilioSignature(req, formData);
    if (!sigOk) {
      const fakeFrom = formData.get('From') || 'unknown';
      console.warn(`twilio-webhook: rejected unsigned/invalid request (claimed From=${fakeFrom})`);
      return new Response('Forbidden', { status: 403 });
    }

    const from = formData.get('From') as string;
    const to   = formData.get('To')   as string;
    const body = (formData.get('Body') as string) || ''; // MMS-only sends empty body
    const sid  = formData.get('MessageSid') as string;

    // Proxy any MMS media to our own bucket BEFORE inserting the sms_messages
    // row so admin's first realtime payload already includes thumbnails.
    // Failure here never blocks the message log — see proxyTwilioMedia.
    const digits10 = from.replace(/[^0-9]/g, '').slice(-10);
    const [mediaUrls, custData] = await Promise.all([
      proxyTwilioMedia(formData, sid),
      fetch(`${SUPABASE_URL}/rest/v1/rpc/find_customer_by_phone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
          apikey: SUPABASE_SVC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ digits: digits10 }),
      }).then(r => r.json()),
    ]);
    const customerId = custData?.[0]?.id || null;

    // The inbound row is still written before any reply row (both awaited here).
    const [custRows] = await Promise.all([
      customerId ? dbGet(`customers?id=eq.${customerId}&select=first_name_cache&limit=1`) : Promise.resolve(null),
      logSms({
        customer_id: customerId, direction: 'inbound', body,
        from_number: from, to_number: to, twilio_sid: sid, status: 'received',
        media_urls: mediaUrls,
      }),
    ]);
    const firstName = (Array.isArray(custRows) ? custRows[0]?.first_name_cache : null) || 'there';

    console.log(`Inbound SMS from=${from} customer_id=${customerId} firstName=${firstName} body="${body?.slice(0,80)}"`);

    const keyword = (body || '').trim().toUpperCase();
    // 2026-09-16: customers write "Pick up", "Pickup.", "pick up please", "SKIP!".
    // Only letters count, and only these exact phrasings — so a sentence that
    // merely mentions a pickup still goes to the staff inbox.
    const letters = keyword.replace(/[^A-Z]/g, '');
    const PICKUP_WORDS = new Set(['PICKUP', 'PICKUPPLEASE', 'PLEASEPICKUP', 'PICKUPPLS', 'PICKUPTHANKS', 'PICKUPTHANKYOU']);
    const noAccount = (msg: string) => new Response(twimlMessage(msg), { headers: TWIML_HDRS });

    if (keyword === 'STOP') {
      return new Response(await handleStop(customerId, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'START' || keyword === 'UNSTOP') {
      return new Response(await handleStart(customerId, from, to), { headers: TWIML_HDRS });
    }
    const skipReq = classifySkip(body || '');
    if (skipReq) {
      if (!customerId) return noAccount("We couldn't find your account. Visit app.familylaundry.com for help.");
      const skipReply = await handleSkip(customerId, from, to, skipReq.when);
      if (skipReply !== null) return new Response(skipReply, { headers: TWIML_HDRS });
      return new Response(TWIML_EMPTY, { headers: TWIML_HDRS });   // day mismatch → staff inbox
    }
    if (PICKUP_WORDS.has(letters)) {
      if (!customerId) return noAccount(`We couldn't find an account for your number. Please sign up at app.familylaundry.com.`);
      return new Response(await handlePickup(customerId, firstName, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'HELP') {
      const helpMsg = `Family Laundry\n` +
        `PICKUP - Book a pickup\n` +
        `SKIP - Skip or cancel your next pickup\n` +
        `STOP - Unsubscribe from texts\n` +
        `START - Re-subscribe to texts\n` +
        `Or call us for anything else.`;
      if (customerId) await logSms({ customer_id: customerId, direction: 'outbound', body: helpMsg, from_number: to, to_number: from, status: 'sent' });
      return new Response(twimlMessage(helpMsg), { headers: TWIML_HDRS });
    }

    console.log(`Unrecognized message routed to human inbox: customer=${customerId ?? 'unknown'} body="${body?.slice(0,60)}"`);
    return new Response(TWIML_EMPTY, { headers: TWIML_HDRS });

  } catch (err) {
    console.error('twilio-webhook error:', err);
    return new Response(TWIML_EMPTY, { headers: TWIML_HDRS });
  }
});
