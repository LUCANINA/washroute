import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const TWILIO_ACCOUNT_SID     = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN      = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_FROM            = Deno.env.get('TWILIO_PHONE_NUMBER') || '+15105884102';
const TWILIO_MSG_SERVICE_SID = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// Roles allowed to originate outbound SMS via this endpoint. The roles in
// public.profiles are: customer, attendant, driver, manager, admin,
// pos_device, laundry_tech. Staff who interact with customers can send SMS;
// customer (obvious), pos_device (it's a device, not a person), and
// laundry_tech (back-of-house, no customer contact) are excluded.
const STAFF_SMS_ROLES = new Set(['admin', 'manager', 'driver', 'attendant']);

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
  if (!STAFF_SMS_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to send SMS` };
  }

  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), {
        status: auth.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: 'Twilio credentials not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const { to, body, customer_id, sent_by_driver_id, media_urls } = await req.json();

    // Body becomes optional when media is attached — Twilio MMS allows
    // empty body as long as MediaUrl is set. For SMS-only sends both 'to'
    // and 'body' are still required.
    const mediaList: string[] = Array.isArray(media_urls) ? media_urls.filter((u: unknown) => typeof u === 'string' && u) : [];
    if (!to || (!body && mediaList.length === 0)) {
      return new Response(JSON.stringify({ error: 'to and (body or media_urls) are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    if (mediaList.length > 10) {
      return new Response(JSON.stringify({ error: 'Twilio caps MediaUrl at 10 per message' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // URLSearchParams can encode repeated keys. Twilio reads MediaUrl as
    // an indexed array on its side regardless of suffix; the official
    // helper libraries use `MediaUrl` repeated. We mirror that pattern.
    const tParams = new URLSearchParams();
    tParams.append('To', to);
    if (body) tParams.append('Body', body);
    if (TWILIO_MSG_SERVICE_SID) tParams.append('MessagingServiceSid', TWILIO_MSG_SERVICE_SID);
    else                         tParams.append('From', TWILIO_FROM);
    for (const u of mediaList) tParams.append('MediaUrl', u);

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tParams,
      }
    );

    const twilioData = await twilioRes.json();

    if (!twilioRes.ok) {
      console.error('Twilio error:', twilioData);
      return new Response(
        JSON.stringify({ error: twilioData.message || 'Twilio send failed' }),
        { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // Persist media URLs alongside the message in the same shape the
    // inbound webhook uses: array of {url, content_type}. We don't have
    // the content_type from the client (it was already validated at upload
    // time), so we leave it blank and let the renderer fall through to
    // image extension matching. Most uploads will be image/* anyway.
    const mediaRows = mediaList.map((u: string) => ({ url: u, content_type: '' }));

    const dbPayload: Record<string, unknown> = {
      customer_id: customer_id || null,
      direction: 'outbound',
      body: body || '',
      from_number: TWILIO_FROM,
      to_number: to,
      twilio_sid: twilioData.sid,
      status: twilioData.status,
      media_urls: mediaRows,
    };
    if (sent_by_driver_id) {
      dbPayload.sent_by_driver_id = sent_by_driver_id;
    }

    const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/sms_messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
        'apikey': SUPABASE_SVC_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(dbPayload),
    });

    const saved = await dbRes.json();

    return new Response(
      JSON.stringify({ success: true, sid: twilioData.sid, message: saved[0] }),
      { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  } catch (err) {
    console.error('send-sms error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
