import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Twilio credentials — loaded from Supabase Secrets only, never hardcoded
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN  = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM        = Deno.env.get('TWILIO_PHONE_NUMBER') || '+15105884102';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const headers = {
  'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
  'apikey': SUPABASE_SVC_KEY,
  'Content-Type': 'application/json',
};

async function dbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  const body = await r.json();
  // Session 228: a PostgREST ERROR used to be returned verbatim here. Callers do
  // `Array.isArray(x) ? x[0] : null`, so an error object became `null`, which the
  // handler reported to the driver as a clean 404 "Stop not found". That is exactly
  // how the ambiguous-embed bug below stayed invisible for 7 hours while every
  // driver's Notify button was dead. Make the failure loud instead of silent.
  if (!r.ok || (body && !Array.isArray(body) && body.code)) {
    console.error('dbGet FAILED', path, r.status, JSON.stringify(body));
    throw new Error(`db query failed (${r.status}): ${body?.message || body?.hint || 'unknown'}`);
  }
  return body;
}

async function dbPatch(table: string, id: string, data: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify(data),
  });
}

async function dbPost(table: string, data: object) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
}

// ── Template lookup from admin Notifications tab ──────────────────────────────
async function getTemplate(triggerKey: string): Promise<string | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/message_templates?trigger_key=eq.${triggerKey}&select=sms_body,sms_enabled&limit=1`,
    { headers }
  );
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.sms_enabled || !row.sms_body) return null;
  return row.sms_body;
}

// ── Tag interpolation ─────────────────────────────────────────────────────────
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '').trim();
}

// ── Authorization ─────────────────────────────────────────────────────────────
// This endpoint flips route_stops.status to en_route and texts the customer,
// so it needs a real identity. profiles.role values are: customer, attendant,
// driver, manager, admin, pos_device, laundry_tech.
//   * service-role key      -> allowed (internal callers)
//   * driver JWT            -> allowed ONLY for a stop on their own route
//   * admin / manager JWT   -> allowed for any stop
//   * anything else         -> 401 / 403
// The driver's display name is taken from the authenticated profile, never
// from the request body (which used to be interpolated straight into the SMS).
const NOTIFY_ROLES = new Set(['driver', 'admin', 'manager']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Caller = {
  ok: true;
  role: string;
  firstName: string;
  driverId: string | null;   // drivers.id when the caller is a driver
  isService: boolean;
};
type AuthResult = Caller | { ok: false; status: number; reason: string };

async function authorize(req: Request): Promise<AuthResult> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' };
  const jwt = m[1];

  if (jwt === SUPABASE_SVC_KEY) {
    return { ok: true, role: 'service_role', firstName: '', driverId: null, isService: true };
  }

  if (jwt === SUPABASE_ANON_KEY) {
    return { ok: false, status: 401, reason: 'Anon key not accepted; driver login required' };
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return { ok: false, status: 401, reason: 'Invalid or expired session' };
  const user = await userRes.json().catch(() => null);
  if (!user?.id) return { ok: false, status: 401, reason: 'Invalid or expired session' };

  const profRows = await dbGet(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role,first_name&limit=1`);
  const profile  = Array.isArray(profRows) ? profRows[0] : null;
  if (!profile) return { ok: false, status: 403, reason: 'Profile not found' };
  if (!NOTIFY_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to notify customers` };
  }

  let driverId: string | null = null;
  if (profile.role === 'driver') {
    const drvRows = await dbGet(`drivers?profile_id=eq.${encodeURIComponent(user.id)}&select=id&limit=1`);
    const drv = Array.isArray(drvRows) ? drvRows[0] : null;
    if (!drv) return { ok: false, status: 403, reason: 'No driver record for this account' };
    driverId = drv.id;
  }

  return {
    ok: true,
    role: profile.role,
    firstName: (profile.first_name || '').trim(),
    driverId,
    isService: false,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  const cors = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Twilio credentials not configured' }), { status: 500, headers: cors });
    }

    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: cors });
    }

    // `driverName` is deliberately NOT read from the body any more — it used to
    // be interpolated straight into the outbound SMS by an unauthenticated caller.
    const { stopId } = await req.json();
    if (!stopId) return new Response(JSON.stringify({ error: 'stopId required' }), { status: 400, headers: cors });
    // Validate before stopId reaches any PostgREST path (dbGet / dbPatch below).
    if (typeof stopId !== 'string' || !UUID_RE.test(stopId)) {
      return new Response(JSON.stringify({ error: 'stopId must be a UUID' }), { status: 400, headers: cors });
    }

    const stops = await dbGet(
      `route_stops?id=eq.${encodeURIComponent(stopId)}&select=id,stop_type,order_id,status,route_id,driver_id,routes!route_stops_route_id_fkey(id,driver_id,pickup_driver_id,delivery_driver_id),orders(id,status,customer_id,customers(id,first_name_cache,last_name_cache,phone_cache,sms_notifications_opt_out_at))&limit=1`
    );

    const stop = Array.isArray(stops) ? stops[0] : null;
    if (!stop) return new Response(JSON.stringify({ error: 'Stop not found' }), { status: 404, headers: cors });

    // A driver may only notify on stops belonging to their own route.
    // admin/manager and the service role are not scoped.
    if (auth.role === 'driver') {
      // PostgREST returns the embedded route as an object for a to-one FK,
      // but tolerate an array shape so the check never fails open.
      const rt = Array.isArray(stop.routes) ? stop.routes[0] : stop.routes;
      // Session 228: mirror get_driver_route_stops exactly. The previous check read
      // ONLY routes.driver_id, which refused three legitimate cases:
      //   - a stop individually re-assigned to this driver on someone else's route
      //     (the "Extra Stops" card),
      //   - a route worked via pickup_driver_id / delivery_driver_id with
      //     routes.driver_id null (split-driver days),
      //   - any route whose driver_id is null — `!stopDriverId` refused outright.
      // A stop's own driver_id is the override; NULL means "inherit the route's driver".
      const stopOverride = stop.driver_id ?? null;
      const onMyRoute = rt
        && (rt.driver_id === auth.driverId
            || rt.pickup_driver_id === auth.driverId
            || rt.delivery_driver_id === auth.driverId);
      const mayNotify = stopOverride
        ? stopOverride === auth.driverId          // explicitly mine, wherever it sits
        : !!onMyRoute;                            // inherited: mine if I work this route
      if (!mayNotify) {
        return new Response(JSON.stringify({ error: 'This stop is not on your route' }), { status: 403, headers: cors });
      }
    }

    const order    = stop.orders;
    const customer = order?.customers;
    const custFirstName   = customer?.first_name_cache || 'there';
    const phone           = customer?.phone_cache;

    // ── Stale-stop guard (session 175) ───────────────────────────────────
    // Refuse to revive a stop / text the customer when the order has already
    // moved to a terminal status (e.g. admin skipped/cancelled it, or it was
    // delivered/failed), or the stop itself is no longer active. Without this,
    // a driver working from a stale route list could tap "On My Way" on a
    // cancelled stop and the customer would get an "on the way" text after
    // having asked to cancel (the Todd Bower incident). The DB trigger
    // prevent_stop_reactivation_on_terminal_order is the hard backstop; this
    // returns a clean, friendly refusal so the driver app can refresh.
    const TERMINAL_ORDER_STATUSES = ['skipped','cancelled','delivered','pickup_failed','delivery_failed'];
    const orderStatus = order?.status || null;
    if (orderStatus && TERMINAL_ORDER_STATUSES.includes(orderStatus)) {
      return new Response(JSON.stringify({
        ok: false, refused: true, reason: 'order_terminal',
        order_status: orderStatus, stop_status: stop.status,
      }), { status: 409, headers: cors });
    }
    if (!['pending','en_route'].includes(stop.status)) {
      return new Response(JSON.stringify({
        ok: false, refused: true, reason: 'stop_inactive',
        order_status: orderStatus, stop_status: stop.status,
      }), { status: 409, headers: cors });
    }

    // Display name comes from the authenticated profile, never the request body.
    const driverFirstName = auth.firstName || 'Your driver';
    const actionWord      = stop.stop_type === 'pickup' ? 'pick up' : 'deliver';

    await dbPatch('route_stops', stopId, {
      status:            'en_route',
      on_my_way_sent_at: new Date().toISOString(),
    });

    let smsResult: { ok: boolean; reason?: string } = { ok: false, reason: 'no_phone' };

    // Per-customer automated-SMS kill-switch (session 174 — Kidango sites).
    // The stop is still marked en_route above; only the text is suppressed.
    if (customer?.sms_notifications_opt_out_at) {
      smsResult = { ok: false, reason: 'sms_notifications_opted_out' };
    } else if (phone) {
      // Read body from admin Notifications tab — editable without code changes
      const templateKey  = stop.stop_type === 'pickup' ? 'driver_on_way_pickup' : 'driver_on_way_delivery';
      const templateBody = await getTemplate(templateKey);

      const msgBody = templateBody
        ? interpolate(templateBody, {
            customer_first_name: custFirstName,
            driver_first_name:   driverFirstName,
            action_word:         actionWord,
          })
        // Fallback if template is missing or disabled
        : `Hi ${custFirstName}! ${driverFirstName} is on the way to ${actionWord} your laundry. Reply to this message with any questions.`;

      const twilioRes = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: msgBody, StatusCallback: `${SUPABASE_URL}/functions/v1/twilio-status-callback` }),
        }
      );
      const twilioData = await twilioRes.json();

      if (twilioRes.ok && twilioData.sid) {
        smsResult = { ok: true };
        await dbPost('sms_messages', {
          customer_id:  customer?.id || null,
          direction:    'outbound',
          body:         msgBody,
          from_number:  TWILIO_FROM,
          to_number:    phone,
          twilio_sid:   twilioData.sid,
          status:       twilioData.status,
        });
      } else {
        console.error('Twilio error:', twilioData);
        smsResult = { ok: false, reason: 'twilio_error' };
      }
    }

    return new Response(JSON.stringify({ ok: true, sms: smsResult }), { headers: cors });
  } catch (err) {
    console.error('notify-on-my-way error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: cors });
  }
});
