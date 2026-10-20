import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Recording + transcription handler. Twilio hits this URL TWICE per voicemail:
//   1. When recording finishes → RecordingUrl, RecordingDuration, RecordingSid
//   2. When transcription is ready → TranscriptionText, TranscriptionStatus, RecordingSid
//
// First hit (recording):
//   - Download MP3 from Twilio (server-side, with auth)
//   - Upload to Supabase Storage 'voicemails' bucket
//   - Insert voicemails row
//   - Insert sms_messages row so it shows in the inbox
//   - Email info@familylaundry.com
// Second hit (transcription):
//   - Update voicemails.transcription_text
//   - Update the matching sms_messages row body to include the transcription
//
// Session 352: the voicemails bucket is going PRIVATE. The stored URL keeps the
// /object/public/ form (the admin inbox signs it on display); the email's Listen
// button gets a 30-day signed link instead. Source pulled into the repo from deployed v24.
//
// NOTE on the service-role key: this project uses Supabase's NEW key format
// ("sb_secret_...", 41 chars, no dots). The Storage endpoint requires BOTH
// Authorization AND apikey headers — sending only Authorization yields
// "Invalid Compact JWS" because Storage tries to parse the bearer as a JWT.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
const SELF_URL = `${SUPABASE_URL}/functions/v1/twilio-voicemail-recorded`;
const NOTIFY_EMAIL = 'info@familylaundry.com';
const EMAIL_LINK_DAYS = 30;

async function verifyTwilioSignature(req: Request, formData: FormData, url: string): Promise<boolean> {
  const sigHeader = req.headers.get('X-Twilio-Signature') || req.headers.get('x-twilio-signature');
  if (!sigHeader) return false;
  if (!TWILIO_AUTH_TOKEN) {
    console.error('twilio-voicemail-recorded: TWILIO_AUTH_TOKEN not set');
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

async function dbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { Authorization: `Bearer ${SUPABASE_SVC_KEY}`, apikey: SUPABASE_SVC_KEY },
  });
  return res.json();
}

async function dbPost(path: string, payload: object, prefer = 'return=representation') {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      apikey: SUPABASE_SVC_KEY,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(payload),
  });
}

async function dbUpsert(path: string, payload: object, onConflict: string) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      apikey: SUPABASE_SVC_KEY,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  });
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

function fmtPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return e164;
  return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2,'0')}` : `${s}s`;
}

// Session 352: turn a stored voicemails URL into a time-limited signed link.
// Anything that is not one of our voicemails URLs (e.g. the Twilio fallback) is returned as-is.
async function signedLink(storedUrl: string, seconds: number): Promise<string> {
  const marker = '/storage/v1/object/public/voicemails/';
  const i = storedUrl.indexOf(marker);
  if (i < 0) return storedUrl;
  const path = storedUrl.slice(i + marker.length);
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/voicemails/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_SVC_KEY}`, apikey: SUPABASE_SVC_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: seconds }),
    });
    const j = await res.json();
    if (res.ok && j?.signedURL) return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
    console.error('voicemail sign failed:', res.status, JSON.stringify(j).slice(0, 200));
  } catch (e) {
    console.error('voicemail sign error:', (e as Error).message);
  }
  return storedUrl;
}

// Download Twilio recording (Basic Auth) and upload to Supabase Storage.
// Returns the stored (public-form) URL or null on failure.
async function downloadAndStoreMp3(twilioRecordingUrl: string, recordingSid: string): Promise<string | null> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('Twilio creds missing — cannot download recording');
    return null;
  }

  const mp3Url = `${twilioRecordingUrl}.mp3`;
  const basicAuth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

  const audioRes = await fetch(mp3Url, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });
  if (!audioRes.ok) {
    console.error(`Twilio recording fetch failed: ${audioRes.status} ${await audioRes.text().catch(()=>'')}`);
    return null;
  }
  const audioBytes = new Uint8Array(await audioRes.arrayBuffer());

  const storagePath = `${recordingSid}.mp3`;
  // BOTH Authorization AND apikey headers required for Storage with the new
  // sb_secret_* key format. Without apikey, Storage tries to parse the bearer
  // as a JWT and fails with "Invalid Compact JWS".
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/voicemails/${storagePath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
        apikey: SUPABASE_SVC_KEY,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
      },
      body: audioBytes,
    },
  );
  if (!uploadRes.ok) {
    console.error(`Storage upload failed: ${uploadRes.status} ${await uploadRes.text().catch(()=>'')}`);
    return null;
  }

  return `${SUPABASE_URL}/storage/v1/object/public/voicemails/${storagePath}`;
}

function buildSmsBody(durationSec: number | null, transcription: string | null, publicUrl: string): string {
  const dur = durationSec ? ` (${fmtDuration(durationSec)})` : '';
  const head = `🎙️ Voicemail${dur}`;
  const transcriptLine = transcription
    ? `“${transcription.trim()}”`
    : '(transcription pending…)';
  return `${head}\n${transcriptLine}\n▶ ${publicUrl}`;
}

async function sendNotificationEmail(args: {
  fromNumber: string;
  customerName: string | null;
  durationSec: number | null;
  transcription: string | null;
  publicUrl: string;
}) {
  const phoneDisplay = fmtPhone(args.fromNumber);
  const callerLabel = args.customerName ? `${args.customerName} (${phoneDisplay})` : phoneDisplay;
  const durationLabel = args.durationSec ? ` — ${fmtDuration(args.durationSec)}` : '';
  const subject = `🎙️ New voicemail from ${callerLabel}${durationLabel}`;

  const transcriptionBlock = args.transcription
    ? `<div style="background:#f7f7f7; padding:16px; border-left:4px solid #4a90e2; border-radius:4px; margin:16px 0;">
         <div style="font-size:12px; color:#666; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Transcription</div>
         <div style="font-size:15px; line-height:1.5; color:#222;">${args.transcription.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</div>
       </div>`
    : `<div style="background:#fff8e1; padding:12px; border-left:4px solid #f5a623; border-radius:4px; margin:16px 0; font-size:14px; color:#666;">
         Transcription is still processing — it will appear in the SMS inbox when ready.
       </div>`;

  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="margin:0 0 16px; color:#222;">New voicemail</h2>
      <table style="width:100%; border-collapse:collapse; font-size:14px;">
        <tr><td style="padding:6px 0; color:#666; width:120px;">From:</td><td style="padding:6px 0; color:#222;"><strong>${callerLabel}</strong></td></tr>
        ${args.durationSec ? `<tr><td style="padding:6px 0; color:#666;">Length:</td><td style="padding:6px 0; color:#222;">${fmtDuration(args.durationSec)}</td></tr>` : ''}
        <tr><td style="padding:6px 0; color:#666;">Received:</td><td style="padding:6px 0; color:#222;">${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })} PT</td></tr>
      </table>
      ${transcriptionBlock}
      <a href="${args.publicUrl}" style="display:inline-block; background:#4a90e2; color:#fff; padding:12px 20px; border-radius:6px; text-decoration:none; font-weight:600; margin-top:8px;">▶ Listen to recording</a>
      <p style="font-size:12px; color:#999; margin-top:10px;">This link works for ${EMAIL_LINK_DAYS} days. After that, play it from the WashRoute inbox.</p>
    </div>`;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to_email: NOTIFY_EMAIL,
      subject,
      body: html,
    }),
  });
  if (!res.ok) {
    console.error('send-email failed:', res.status, await res.text());
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const formData = await req.formData();
    const sigOk = await verifyTwilioSignature(req, formData, SELF_URL);
    if (!sigOk) {
      console.warn('twilio-voicemail-recorded: rejected unsigned/invalid request');
      return new Response('Forbidden', { status: 403 });
    }

    const callSid = formData.get('CallSid') as string | null;
    const recordingSid = formData.get('RecordingSid') as string | null;
    const recordingUrl = formData.get('RecordingUrl') as string | null;
    const recordingDuration = formData.get('RecordingDuration') as string | null;
    const transcriptionText = formData.get('TranscriptionText') as string | null;
    const transcriptionStatus = formData.get('TranscriptionStatus') as string | null;
    const from = formData.get('From') as string | null;
    const to = formData.get('To') as string | null;

    const fromNumber = from || (formData.get('Caller') as string | null);
    const toNumber = to || (formData.get('Called') as string | null);

    if (!recordingSid) {
      console.error('No RecordingSid in payload');
      return new Response('OK', { status: 200 });
    }

    const isTranscriptionCallback = !!transcriptionStatus;
    console.log(`Voicemail webhook: sid=${recordingSid} type=${isTranscriptionCallback ? 'transcription' : 'recording'}`);

    if (isTranscriptionCallback) {
      await dbPatch(`voicemails?twilio_recording_sid=eq.${recordingSid}`, {
        transcription_text: transcriptionText,
        transcription_status: transcriptionStatus,
      });

      const vmRows = await dbGet(
        `voicemails?twilio_recording_sid=eq.${recordingSid}` +
        `&select=recording_url,recording_duration_seconds,from_number,to_number,created_at&limit=1`
      );
      const vm = Array.isArray(vmRows) ? vmRows[0] : null;
      if (vm) {
        const updatedBody = buildSmsBody(
          vm.recording_duration_seconds,
          transcriptionText,
          vm.recording_url,
        );
        await dbPatch(
          `sms_messages?twilio_sid=eq.${recordingSid}`,
          { body: updatedBody },
        );
      }
      return new Response('OK', { status: 200 });
    }

    if (!recordingUrl || !fromNumber || !toNumber) {
      console.error('Missing required recording fields');
      return new Response('OK', { status: 200 });
    }

    const publicUrl = await downloadAndStoreMp3(recordingUrl, recordingSid);
    const finalUrl = publicUrl || `${recordingUrl}.mp3`;

    let customerId: string | null = null;
    let customerName: string | null = null;
    const digits10 = fromNumber.replace(/\D/g, '').slice(-10);
    if (digits10.length === 10) {
      const custRpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/find_customer_by_phone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SVC_KEY}`,
          apikey: SUPABASE_SVC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ digits: digits10 }),
      });
      const custData = await custRpc.json();
      customerId = custData?.[0]?.id || null;
      if (customerId) {
        const rows = await dbGet(`customers?id=eq.${customerId}&select=first_name_cache,last_name_cache&limit=1`);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row) {
          customerName = `${row.first_name_cache || ''} ${row.last_name_cache || ''}`.trim() || null;
        }
      }
    }

    const durationSec = recordingDuration ? parseInt(recordingDuration, 10) : null;

    const upsertRes = await dbUpsert(
      'voicemails',
      {
        twilio_recording_sid: recordingSid,
        twilio_call_sid: callSid,
        customer_id: customerId,
        from_number: fromNumber,
        to_number: toNumber,
        recording_url: finalUrl,
        recording_duration_seconds: durationSec,
      },
      'twilio_recording_sid',
    );
    if (!upsertRes.ok) {
      console.error('Voicemail upsert failed:', await upsertRes.text());
    }

    const smsBody = buildSmsBody(durationSec, null, finalUrl);
    const smsRes = await dbPost('sms_messages', {
      customer_id: customerId,
      direction: 'inbound',
      body: smsBody,
      from_number: fromNumber,
      to_number: toNumber,
      twilio_sid: recordingSid,
      status: 'received',
    }, 'return=minimal');
    if (!smsRes.ok) {
      console.error('sms_messages insert failed:', await smsRes.text());
    }

    await sendNotificationEmail({
      fromNumber,
      customerName,
      durationSec,
      transcription: null,
      publicUrl: await signedLink(finalUrl, EMAIL_LINK_DAYS * 86400),
    });

    return new Response('OK', { status: 200 });
  } catch (err) {
    console.error('twilio-voicemail-recorded error:', err);
    return new Response('OK', { status: 200 });
  }
});
