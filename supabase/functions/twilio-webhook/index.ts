import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_WEBHOOK_URL = Deno.env.get('TWILIO_WEBHOOK_URL')
  || `${SUPABASE_URL}/functions/v1/twilio-webhook`;

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

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '').trim();
}

function getPtOffsetHours(): number {
  const noon = new Date(Date.UTC(
    new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 12
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

function getNextPickupDayPT(
  schedDays: number[]
): { dateStr: string; year: number; month: number; day: number } | null {
  for (let ahead = 1; ahead <= 7; ahead++) {
    const utcMs   = Date.now() + ahead * 86_400_000;
    const dateStr = ptDateFmt.format(new Date(utcMs));
    const [y,m,d] = dateStr.split('-').map(Number);
    const dow     = new Date(y, m - 1, d).getDay();
    if (schedDays.includes(dow)) return { dateStr, year: y, month: m, day: d };
  }
  return null;
}

function ptDateTimeToUtc(y: number, mo: number, d: number, h: number, min: number): string {
  const offsetH = getPtOffsetHours();
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

async function handleSkip(customerId: string, from: string, to: string): Promise<string> {
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
      "We don't see an upcoming pickup scheduled for your number. Reply or visit familylaundry.com for help."
    );
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
  const existing = await dbGet(
    `orders?customer_id=eq.${customerId}&status=in.(${activeStatuses})&limit=1` +
    `&select=order_number,status,pickup_window_start`
  );
  const activeOrder = Array.isArray(existing) ? existing[0] : null;
  if (activeOrder) {
    const pickupDate = activeOrder.pickup_window_start ? fmtDatePT(activeOrder.pickup_window_start) : 'upcoming';
    const reply = `Hi ${firstName}! You already have order #${activeOrder.order_number} scheduled for ${pickupDate}. ` +
                  `Reply STATUS to check on it, or visit familylaundry.com to make changes.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const lastOrders = await dbGet(
    `orders?customer_id=eq.${customerId}&status=eq.delivered&order=created_at.desc&limit=1` +
    `&select=zone_id,pickup_address_id,delivery_address_id,service_id,total_bags`
  );
  const lastOrder = Array.isArray(lastOrders) ? lastOrders[0] : null;

  let zoneId: string | null         = lastOrder?.zone_id             || null;
  let pickupAddrId: string | null   = lastOrder?.pickup_address_id   || null;
  let deliveryAddrId: string | null = lastOrder?.delivery_address_id || lastOrder?.pickup_address_id || null;
  const bags: number                = lastOrder?.total_bags || 2;
  const serviceId: string | null    = lastOrder?.service_id || null;

  if (!pickupAddrId) {
    const addrs = await dbGet(`addresses?customer_id=eq.${customerId}&is_default=eq.true&limit=1&select=id,lat,lng`);
    const addr  = Array.isArray(addrs) ? addrs[0] : null;
    if (!addr) {
      const reply = `Hi ${firstName}! We couldn't find a saved address. Please book at familylaundry.com.`;
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
    const reply = `Hi ${firstName}! We couldn't confirm your service area. Please book at familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const templates = await dbGet(
    `route_templates?zone_id=eq.${zoneId}&is_active=eq.true&order=window_start.desc&limit=1` +
    `&select=schedule_days,window_start,window_end,turnaround_days,arrival_window_hours`
  );
  const rt = Array.isArray(templates) ? templates[0] : null;
  if (!rt) {
    const reply = `Hi ${firstName}! No pickup windows found for your area. Please book at familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const nextDay = getNextPickupDayPT(rt.schedule_days ?? [0,1,2,3,4,5]);
  if (!nextDay) {
    const reply = `Hi ${firstName}! No available pickup slots this week. Please book at familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const [wStartH, wStartM] = (rt.window_start as string).split(':').map(Number);
  const [wEndH,   wEndM  ] = (rt.window_end   as string).split(':').map(Number);
  const fullWindowH        = wEndH - wStartH;
  const subH               = Math.min(rt.arrival_window_hours ?? fullWindowH, fullWindowH) || fullWindowH;
  const subEndH            = wStartH + subH;
  const turnaround: number = rt.turnaround_days ?? 1;

  const { year: py, month: pm, day: pd } = nextDay;
  const pickupStart = ptDateTimeToUtc(py, pm, pd, wStartH, wStartM);
  const pickupEnd   = ptDateTimeToUtc(py, pm, pd, subEndH, wStartM);

  const delivPt  = new Date(Date.UTC(py, pm - 1, pd + turnaround));
  const dy = delivPt.getUTCFullYear(), dmo = delivPt.getUTCMonth() + 1, dd = delivPt.getUTCDate();
  const delivStart = ptDateTimeToUtc(dy, dmo, dd, wStartH, wStartM);
  const delivEnd   = ptDateTimeToUtc(dy, dmo, dd, subEndH, wStartM);

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
    const reply = `Hi ${firstName}! We had trouble booking your pickup. Please try at familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }

  const orderJson = await orderRes.json();
  const newOrder  = Array.isArray(orderJson) ? orderJson[0] : orderJson;
  if (!newOrder?.order_number) {
    const reply = `Hi ${firstName}! Your pickup was booked but we had trouble confirming the details. Check familylaundry.com.`;
    await logSms({ customer_id: customerId, direction: 'outbound', body: reply, from_number: to, to_number: from, status: 'sent' });
    return twimlMessage(reply);
  }
  const pickupDateLabel = fmtDatePT(pickupStart);
  const windowLabel     = `${fmt12h(wStartH)}–${fmt12h(subEndH)}`;

  const reply =
    `Got it, ${firstName}! Your pickup is booked for ${pickupDateLabel} between ${windowLabel}. ` +
    `Order #${newOrder.order_number}. Please have your bags ready outside before ${fmt12h(wStartH)}. ` +
    `We'll text you when your driver is on the way!`;

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
    const body = formData.get('Body') as string;
    const sid  = formData.get('MessageSid') as string;

    const digits10 = from.replace(/[^0-9]/g, '').slice(-10);
    const custRpc  = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_customer_by_phone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
        apikey: SUPABASE_SVC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ digits: digits10 }),
    });
    const custData   = await custRpc.json();
    const customerId = custData?.[0]?.id || null;

    let firstName = 'there';
    if (customerId) {
      const custRows = await dbGet(`customers?id=eq.${customerId}&select=first_name_cache&limit=1`);
      firstName = (Array.isArray(custRows) ? custRows[0]?.first_name_cache : null) || 'there';
    }

    console.log(`Inbound SMS from=${from} customer_id=${customerId} firstName=${firstName} body="${body?.slice(0,80)}"`);

    await logSms({
      customer_id: customerId, direction: 'inbound', body,
      from_number: from, to_number: to, twilio_sid: sid, status: 'received',
    });

    const keyword = (body || '').trim().toUpperCase();
    const noAccount = (msg: string) => new Response(twimlMessage(msg), { headers: TWIML_HDRS });

    if (keyword === 'STOP') {
      return new Response(await handleStop(customerId, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'START' || keyword === 'UNSTOP') {
      return new Response(await handleStart(customerId, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'SKIP') {
      if (!customerId) return noAccount("We couldn't find your account. Visit familylaundry.com for help.");
      return new Response(await handleSkip(customerId, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'PICKUP') {
      if (!customerId) return noAccount(`We couldn't find an account for your number. Please sign up at familylaundry.com.`);
      return new Response(await handlePickup(customerId, firstName, from, to), { headers: TWIML_HDRS });
    }
    if (keyword === 'HELP') {
      const helpMsg = `Family Laundry\n` +
        `PICKUP - Book a pickup\n` +
        `SKIP - Skip your next pickup\n` +
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
