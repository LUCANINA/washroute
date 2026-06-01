import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TWILIO_SID   = Deno.env.get('TWILIO_ACCOUNT_SID') ?? '';
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') ?? '';
const TWILIO_FROM  = Deno.env.get('TWILIO_PHONE_NUMBER') ?? '';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SVC_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const KLAVIYO_KEY = Deno.env.get('KLAVIYO_API_KEY') ?? '';

const BIZ_TZ = 'America/Los_Angeles';

const dbHeaders: Record<string, string> = {
  'Authorization': `Bearer ${SVC_KEY}`,
  'apikey': SVC_KEY,
  'Content-Type': 'application/json',
};

async function dbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  return r.json();
}

const EVENT_TO_TRIGGER: Record<string, string> = {
  confirmed:            'order_confirmed',
  picked_up:            'order_picked_up',
  out_for_delivery:     'driver_on_way_delivery',
  delivered:            'order_delivered',
  pickup_failed:        'pickup_failed',
  delivery_failed:      'delivery_failed',
  // Reschedule notifications (session 79, Mar 29 2026)
  schedule_changed:     'schedule_changed',
  delivery_rescheduled: 'delivery_rescheduled',
};

const EVENT_STOP_TYPE: Record<string, 'pickup' | 'delivery'> = {
  picked_up: 'pickup',
  delivered: 'delivery',
};

async function sendSms(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    console.warn('Twilio not configured', { sid: !!TWILIO_SID, token: !!TWILIO_TOKEN, from: !!TWILIO_FROM });
    return { ok: false, reason: 'twilio_not_configured' };
  }
  let phone = to.replace(/[^\d+]/g, '');
  if (phone && !phone.startsWith('+')) phone = '+1' + phone.slice(-10);
  if (!phone || phone.length < 10) return { ok: false, reason: 'invalid_phone' };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
    },
    body: new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: body }).toString(),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, reason: data.message };
  return { ok: true, sid: data.sid };
}

function fmtDate(d: string | null): string {
  if (!d) return '';
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: BIZ_TZ });
  } catch { return ''; }
}

function fmtTimeWindow(start: string | null, end: string | null): string {
  if (!start || !end) return '';
  try {
    const s = new Date(start);
    const e = new Date(end);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return '';
    const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: BIZ_TZ }).replace(':00', '').toLowerCase();
    return `${fmt(s)} – ${fmt(e)}`;
  } catch { return ''; }
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '').trim();
}

// Format an address row from the addresses table into a one-liner
function fmtAddress(addr: any): string {
  if (!addr) return '';
  const parts = [
    addr.line1,
    addr.line2,
    addr.city && addr.state ? `${addr.city}, ${addr.state}` : (addr.city || addr.state),
    addr.zip,
  ].filter(Boolean);
  return parts.join(', ');
}

// Session 137: compute actual charged total = subtotal + tip dollars, mirroring
// charge-order's chargeAmount math. The {{amount}} template variable was
// previously bound to total_amount alone (pre-tip), causing the payment_received
// SMS to show a number that didn't match the customer's Stripe charge.
function computeChargedTotal(totalAmount: number | string | null | undefined,
                              tipAmount: number | string | null | undefined,
                              tipType: string | null | undefined): number {
  const total = Number(totalAmount || 0);
  const tip   = Number(tipAmount   || 0);
  if (!tip) return Math.round(total * 100) / 100;
  const tipDollars = (tipType === 'pct')
    ? Math.round(total * tip) / 100
    : Math.round(tip * 100) / 100;
  return Math.round((total + tipDollars) * 100) / 100;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    const { orderId, event } = await req.json();
    console.log(`[send-order-notification] Received: orderId=${orderId} event=${event}`);

    if (!orderId || !event) {
      return new Response(JSON.stringify({ error: 'orderId and event are required' }), { status: 400, headers: CORS });
    }

    const triggerKey = EVENT_TO_TRIGGER[event] ?? event;

    // Fetch order FIRST — needed by both the Klaviyo event path and the SMS
    // path. Done before the template check so Klaviyo tracking stays decoupled
    // from SMS template state (toggling off the order_confirmed SMS template
    // in admin must NOT silently break the Klaviyo flow trigger).
    // session 137: include tip_amount + tip_type so {{amount}} matches the
    // actual Stripe-charged total.
    const orders = await dbGet(
      `orders?id=eq.${orderId}&select=id,order_number,pickup_window_start,pickup_window_end,delivery_window_start,delivery_window_end,status,total_amount,tip_amount,tip_type,total_bags,customer_id,pickup_address_id,delivery_address_id&limit=1`
    );
    const order = Array.isArray(orders) ? orders[0] : null;
    console.log(`[send-order-notification] Order lookup: orderId=${orderId} found=${!!order}`);

    if (!order) {
      return new Response(JSON.stringify({ error: 'Order not found', orderId }), { status: 404, headers: CORS });
    }

    // Fetch customer — email_cache added for Klaviyo event tracking
    const customers = await dbGet(
      `customers?id=eq.${order.customer_id}&select=id,first_name_cache,last_name_cache,phone_cache,address_cache,email_cache&limit=1`
    );
    const customer = Array.isArray(customers) ? customers[0] : null;

    if (!customer) {
      return new Response(JSON.stringify({ ok: true, sms: false, reason: 'no_customer' }), { headers: CORS });
    }

    // ── Klaviyo "Placed Order" event (fire-and-forget, non-fatal) ──
    // Fired on the 'confirmed' event (customer-app order placement). Unlocks
    // real-time behavioral flows in Klaviyo — most importantly the laggard
    // conversion flow's "has placed an order yet?" conditional split, which
    // would otherwise lag by ~24h waiting for the nightly profile sync.
    // unique_id=order.id dedupes against any repeat 'confirmed' calls.
    // Runs BEFORE the template / phone / SMS path so it's independent of
    // whether the order_confirmed SMS template is enabled or whether the
    // customer has a phone on file.
    if (event === 'confirmed' && customer.email_cache && KLAVIYO_KEY) {
      const klviTotal = computeChargedTotal(order.total_amount, order.tip_amount, order.tip_type);
      try {
        const r = await fetch('https://a.klaviyo.com/api/events/', {
          method: 'POST',
          headers: {
            'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
            'accept':        'application/json',
            'content-type':  'application/json',
            'revision':      '2024-10-15',
          },
          body: JSON.stringify({
            data: {
              type: 'event',
              attributes: {
                properties: {
                  OrderId:      String(order.order_number || ''),
                  OrderValue:   klviTotal,
                  BagCount:     order.total_bags || 0,
                  PickupDate:   order.pickup_window_start,
                  DeliveryDate: order.delivery_window_start,
                  $value:       klviTotal,
                },
                time:           new Date().toISOString(),
                value:          klviTotal,
                value_currency: 'USD',
                unique_id:      String(order.id),
                metric:  { data: { type: 'metric',  attributes: { name: 'Placed Order' } } },
                profile: { data: { type: 'profile', attributes: { email: customer.email_cache } } },
              },
            },
          }),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          console.warn(`[klaviyo-event] Placed Order ${r.status} for order=${order.order_number}: ${t.slice(0, 500)}`);
        } else {
          console.log(`[klaviyo-event] Placed Order tracked: order=${order.order_number} email=${customer.email_cache}`);
        }
      } catch (e: any) {
        console.warn('[klaviyo-event] fetch failed:', e?.message || String(e));
      }
    }

    // Template lookup (SMS path) — must come AFTER the Klaviyo block so that
    // a disabled order_confirmed SMS template doesn't silently break the
    // Klaviyo flow trigger above.
    const templates = await dbGet(
      `message_templates?trigger_key=eq.${triggerKey}&select=sms_enabled,sms_body,email_enabled,email_subject,email_body&limit=1`
    );
    const tmpl = Array.isArray(templates) ? templates[0] : null;
    console.log(`[send-order-notification] Template lookup: triggerKey=${triggerKey} found=${!!tmpl} isArray=${Array.isArray(templates)}`);

    if (!tmpl) {
      console.warn(`[send-order-notification] NO TEMPLATE for triggerKey=${triggerKey} (event=${event}, orderId=${orderId}) — customer was NOT notified. Add the row to message_templates.`);
      return new Response(JSON.stringify({ ok: true, sms: false, reason: 'no_template' }), { headers: CORS });
    }
    if (!tmpl.sms_enabled || !tmpl.sms_body) {
      console.warn(`[send-order-notification] TEMPLATE DISABLED for triggerKey=${triggerKey} (event=${event}, orderId=${orderId}) — sms_enabled=${tmpl.sms_enabled}, body_present=${!!tmpl.sms_body}. Customer was NOT notified. Re-enable in admin Notifications tab.`);
      return new Response(JSON.stringify({ ok: true, sms: false, reason: 'sms_disabled' }), { headers: CORS });
    }

    const phone = customer.phone_cache;
    if (!phone) {
      return new Response(JSON.stringify({ ok: true, sms: false, reason: 'no_phone' }), { headers: CORS });
    }

    // Resolve address
    let resolvedAddress = '';
    const addrId = order.pickup_address_id || order.delivery_address_id;
    if (addrId) {
      try {
        const addrs = await dbGet(`addresses?id=eq.${addrId}&select=line1,line2,city,state,zip&limit=1`);
        const addr = Array.isArray(addrs) ? addrs[0] : null;
        resolvedAddress = fmtAddress(addr);
        console.log(`[send-order-notification] Address from order: addrId=${addrId} resolved="${resolvedAddress}"`);
      } catch (e) {
        console.warn('[send-order-notification] Address lookup from order failed:', e);
      }
    }
    if (!resolvedAddress) {
      resolvedAddress = (customer.address_cache || '').trim();
      if (resolvedAddress) {
        console.log(`[send-order-notification] Address fallback to address_cache: "${resolvedAddress}"`);
      }
    }

    // Proof photo lookup
    let pickupPicture = '', dropoffPicture = '';
    const stopType = EVENT_STOP_TYPE[event];
    if (stopType) {
      const stops = await dbGet(`route_stops?order_id=eq.${orderId}&stop_type=eq.${stopType}&select=proof_photo_url&limit=1`);
      const stop = Array.isArray(stops) ? stops[0] : null;
      if (stop?.proof_photo_url) {
        if (stopType === 'pickup') pickupPicture = `View pickup photo: ${stop.proof_photo_url}`;
        else dropoffPicture = `View delivery photo: ${stop.proof_photo_url}`;
      }
    }

    // Driver name for out_for_delivery
    let driverFirstName = '';
    if (event === 'out_for_delivery') {
      const dlvStops = await dbGet(`route_stops?order_id=eq.${orderId}&stop_type=eq.delivery&select=driver_id,routes(driver_id)&limit=1`);
      const dlvStop = Array.isArray(dlvStops) ? dlvStops[0] : null;
      const driverId = dlvStop?.driver_id ?? dlvStop?.routes?.driver_id;
      if (driverId) {
        const drivers = await dbGet(`drivers?id=eq.${driverId}&select=profile_id,profiles(first_name)&limit=1`);
        const drv = Array.isArray(drivers) ? drivers[0] : null;
        driverFirstName = drv?.profiles?.first_name || '';
      }
    }

    const isDeliveryEvent = ['out_for_delivery', 'delivered', 'delivery_rescheduled'].includes(event);
    const timeWindow = isDeliveryEvent
      ? fmtTimeWindow(order.delivery_window_start, order.delivery_window_end)
      : fmtTimeWindow(order.pickup_window_start, order.pickup_window_end);

    // Session 137: {{amount}} = actual charged total (subtotal + tip), not subtotal alone.
    // Same math as charge-order/index.ts so SMS receipts match Stripe.
    const chargedTotal = computeChargedTotal(order.total_amount, order.tip_amount, order.tip_type);

    const vars: Record<string, string> = {
      first_name: customer.first_name_cache || 'there',
      last_name: customer.last_name_cache || '',
      customer_first_name: customer.first_name_cache || 'there',
      order_number: String(order.order_number || ''),
      pickup_date: fmtDate(order.pickup_window_start),
      delivery_date: fmtDate(order.delivery_window_start),
      address: resolvedAddress,
      amount: chargedTotal > 0 ? chargedTotal.toFixed(2) : '',
      pickup_picture: pickupPicture,
      dropoff_picture: dropoffPicture,
      order_link: 'https://washroute.vercel.app/customer-app/',
      driver_name: driverFirstName,
      driver_first_name: driverFirstName,
      time_window: timeWindow,
      pickup_time_window: fmtTimeWindow(order.pickup_window_start, order.pickup_window_end),
      delivery_time_window: fmtTimeWindow(order.delivery_window_start, order.delivery_window_end),
      bag_count: order.total_bags ? String(order.total_bags) : '',
      eta: '',
      review_link: '',
    };

    const smsBody = interpolate(tmpl.sms_body, vars);
    const smsResult = await sendSms(phone, smsBody);
    console.log(`[send-order-notification] SMS result: ${JSON.stringify(smsResult)}`);

    if (smsResult.ok && (smsResult as any).sid) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, {
          method: 'POST',
          headers: dbHeaders,
          body: JSON.stringify({
            customer_id: customer.id,
            direction: 'outbound',
            body: smsBody,
            from_number: TWILIO_FROM,
            to_number: phone,
            twilio_sid: (smsResult as any).sid,
            status: 'sent',
          }),
        });
      } catch (e) { console.warn('SMS log failed:', e); }
    }

    console.log(`[send-order-notification] Done: order=${orderId} event=${event} trigger=${triggerKey} sms=${JSON.stringify(smsResult)}`);
    return new Response(JSON.stringify({ ok: true, sms: smsResult }), { headers: CORS });

  } catch (e) {
    console.error('[send-order-notification] error:', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
});
