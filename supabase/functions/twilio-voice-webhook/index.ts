import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Incoming call handler for the business number (510) 588-4102. Twilio hits this URL when someone dials.
//
// v23 (2026-10-09, Maya go-live). The source was ONLY on the server until now (deployed v22); v22's
// behaviour is kept verbatim as the voicemail path below.
//
// ON/OFF SWITCH — lives in Twilio, not in code:
//   Voice URL .../twilio-voice-webhook?maya=1  → forward the call to Maya (Retell number MAYA_NUMBER),
//                                                passing the caller's own number as caller ID so Maya can
//                                                recognise known customers. If Maya doesn't answer within
//                                                15s (busy / failed / no-answer), Twilio comes back to
//                                                ?maya=1&after=1 and the caller gets the old voicemail.
//   Voice URL .../twilio-voice-webhook          → old behaviour: greeting + voicemail (v22). No deploy needed
//                                                to switch back — just remove ?maya=1 in the Twilio console.
//
// Voicemail path (v22):
//   1. Plays a greeting (text-to-speech)
//   2. Records up to 2 minutes of voicemail
//   3. Posts the recording to twilio-voicemail-recorded when done
//   4. Transcribes the recording (best-effort, English only)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const SELF_URL = `${SUPABASE_URL}/functions/v1/twilio-voice-webhook`;
const RECORDING_CALLBACK_URL = `${SUPABASE_URL}/functions/v1/twilio-voicemail-recorded`;
const MAYA_NUMBER = '+15109734505'; // Retell number whose inbound agent is "Maya — Family Laundry"

const GREETING =
  "Thanks for calling Family Laundry. We can't take your call right now. " +
  "Please leave a message after the beep and we'll get back to you. " +
  "For faster service, text us at this number anytime.";

async function verifyTwilioSignature(req: Request, formData: FormData, url: string): Promise<boolean> {
  const sigHeader = req.headers.get('X-Twilio-Signature') || req.headers.get('x-twilio-signature');
  if (!sigHeader) return false;
  if (!TWILIO_AUTH_TOKEN) {
    console.error('twilio-voice-webhook: TWILIO_AUTH_TOKEN not set');
    return false;
  }

  const params: [string, string][] = [];
  for (const [k, v] of formData.entries()) {
    if (typeof v === 'string') params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let data = url;
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

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const xml = (twiml: string) => new Response(twiml, { headers: { 'Content-Type': 'text/xml' } });

// v22 voicemail TwiML, unchanged.
// - playBeep: yes (signals the caller to start)
// - finishOnKey: # (caller can press # to stop recording early)
// - timeout: 5 (hang up if 5s of silence after they start)
// - transcribe: true (Twilio sends a transcription callback to recordingStatusCallback)
// - maxLength: 120 (2 minutes — keeps recording costs minimal)
const VOICEMAIL = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${xmlEscape(GREETING)}</Say>
  <Record
    action="${RECORDING_CALLBACK_URL}"
    method="POST"
    maxLength="120"
    timeout="5"
    finishOnKey="#"
    playBeep="true"
    transcribe="true"
    transcribeCallback="${RECORDING_CALLBACK_URL}"
  />
  <Say voice="Polly.Joanna">We didn't receive a message. Goodbye.</Say>
</Response>`;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const qs = new URL(req.url).searchParams;
    const maya = qs.get('maya') === '1';
    const after = qs.get('after') === '1';
    // Twilio signs the exact URL it called, query string included.
    const signedUrl = SELF_URL + (maya ? (after ? '?maya=1&after=1' : '?maya=1') : '');

    const formData = await req.formData();
    const sigOk = await verifyTwilioSignature(req, formData, signedUrl);
    if (!sigOk) {
      console.warn('twilio-voice-webhook: rejected unsigned/invalid request');
      return new Response('Forbidden', { status: 403 });
    }

    const callSid = formData.get('CallSid') as string;
    const from = (formData.get('From') as string) || '';

    if (maya && after) {
      // Dial finished. Answered by Maya → done. Otherwise → old voicemail so no caller is ever stranded.
      const status = (formData.get('DialCallStatus') as string) || '';
      console.log(`Maya dial result: CallSid=${callSid} status=${status}`);
      if (status === 'completed' || status === 'answered') {
        return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      }
      return xml(VOICEMAIL);
    }

    if (maya) {
      console.log(`Incoming call → Maya: CallSid=${callSid} From=${from}`);
      // Pass the caller's number through (allowed when forwarding the caller) so Maya can recognise
      // them. Blocked/odd caller IDs are left off; Maya then treats them as an unknown caller.
      const callerId = /^\+1\d{10}$/.test(from) ? ` callerId="${xmlEscape(from)}"` : '';
      return xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${callerId} timeout="15" answerOnBridge="true" action="${xmlEscape(SELF_URL + '?maya=1&after=1')}" method="POST">
    <Number>${MAYA_NUMBER}</Number>
  </Dial>
</Response>`);
    }

    console.log(`Incoming call: CallSid=${callSid} From=${from}`);
    return xml(VOICEMAIL);
  } catch (err) {
    console.error('twilio-voice-webhook error:', err);
    const fallback = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try again later.</Say></Response>`;
    return xml(fallback);
  }
});
