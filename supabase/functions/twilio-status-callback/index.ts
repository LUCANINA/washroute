import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Twilio Status Callback receiver.
// Twilio POSTs here as each outbound message changes state
// (queued -> sent -> delivered, or failed/undelivered). We record the
// final outcome on the matching sms_messages row via the
// record_sms_delivery_status RPC (keeps column writes server-side, immune
// to the PostgREST schema-cache trap).
//
// verify_jwt is OFF because Twilio cannot send a Supabase JWT. This endpoint
// only flips status/error fields on an EXISTING row matched by twilio_sid
// (no data is returned, no messages are sent), so spoof impact is minimal.
// Optional future hardening: validate the X-Twilio-Signature header.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SVC_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Human-readable text for the Twilio messaging error codes we actually see.
const ERROR_TEXT: Record<string, string> = {
  '30001': 'Queue overflow',
  '30002': 'Account suspended',
  '30003': 'Unreachable destination handset',
  '30004': 'Message blocked by carrier',
  '30005': 'Unknown destination handset',
  '30006': 'Landline or unreachable carrier',
  '30007': 'Carrier filtered (likely flagged as spam)',
  '30008': 'Unknown delivery error',
  '21610': 'Recipient unsubscribed (texted STOP)',
  '21408': 'Permission not enabled for the destination region',
  '21211': 'Invalid phone number',
  '21614': 'Not a valid mobile number',
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  try {
    const ct = req.headers.get('content-type') || '';
    let sid = '', status = '', errorCode = '';

    if (ct.includes('application/json')) {
      const j = await req.json().catch(() => ({} as any));
      sid       = j.MessageSid || j.SmsSid || j.sid || '';
      status    = j.MessageStatus || j.SmsStatus || j.status || '';
      errorCode = (j.ErrorCode !== undefined && j.ErrorCode !== null) ? String(j.ErrorCode) : '';
    } else {
      const form = new URLSearchParams(await req.text());
      sid       = form.get('MessageSid') || form.get('SmsSid') || '';
      status    = form.get('MessageStatus') || form.get('SmsStatus') || '';
      errorCode = form.get('ErrorCode') || '';
    }

    // Always answer Twilio with 200 so it doesn't retry on malformed pings.
    if (!sid || !status) {
      console.warn('[twilio-status-callback] missing sid/status', { sid, status });
      return new Response(JSON.stringify({ ok: false, reason: 'missing_sid_or_status' }), { status: 200, headers: JSON_HEADERS });
    }

    const errMsg = errorCode ? (ERROR_TEXT[errorCode] || ('Twilio error ' + errorCode)) : null;

    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_sms_delivery_status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SVC_KEY}`,
        'apikey': SVC_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_sid: sid,
        p_status: status,
        p_error_code: errorCode || null,
        p_error_message: errMsg,
      }),
    });

    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error('[twilio-status-callback] rpc failed', r.status, JSON.stringify(data));
    } else {
      console.log(`[twilio-status-callback] sid=${sid} status=${status} err=${errorCode || '-'} -> ${JSON.stringify(data)}`);
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    console.error('[twilio-status-callback] error', e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 200, headers: JSON_HEADERS });
  }
});
