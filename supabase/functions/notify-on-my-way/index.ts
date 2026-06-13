import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Twilio credentials — loaded from Supabase Secrets only, never hardcoded
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN  = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM        = Deno.env.get('TWILIO_PHONE_NUMBER') || '+15105884102';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const headers = {
  'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
  'apikey': SUPABASE_SVC_KEY,
  'Content-Type': 'application/json',
};

async function dbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  return r.json();
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

    const { stopId, driverName } = await req.json();
    if (!stopId) return new Response(JSON.stringify({ error: 'stopId required' }), { status: 400, headers: cors });

    const stops = await dbGet(
      `route_stops?id=eq.${stopId}&select=id,stop_type,order_id,status,orders(id,customer_id,customers(id,first_name_cache,last_name_cache,phone_cache,sms_notifications_opt_out_at))&limit=1`
    );

    const stop = Array.isArray(stops) ? stops[0] : null;
    if (!stop) return new Response(JSON.stringify({ error: 'Stop not found' }), { status: 404, headers: cors });

    const order    = stop.orders;
    const customer = order?.customers;
    const custFirstName   = customer?.first_name_cache || 'there';
    const phone           = customer?.phone_cache;

    // driverName is passed as first name only from the driver app
    const driverFirstName = driverName || 'Your driver';
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
          body: new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: msgBody }),
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
