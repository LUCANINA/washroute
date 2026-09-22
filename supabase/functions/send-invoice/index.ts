import { createClient } from 'jsr:@supabase/supabase-js@2';

// Emails an on-account invoice PDF. Called from Admin → On Account → Send invoice.
//
// SECURITY (audit 2026-09-22): this function had NO caller check and verify_jwt is
// false, so it was an open relay: anyone could send any HTML with any attachment
// from info@familylaundry.com (phishing that passes our domain's email auth, and
// burns the sending reputation). Now a signed-in admin/manager is required. The
// admin dashboard sends its session token with the request.
const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const INVOICE_ROLES = new Set(['admin', 'manager']);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, reason: 'Staff login required' };
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
  if (!INVOICE_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to send invoices` };
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const auth = await authorize(req);
    if (!auth.ok) {
      return new Response(JSON.stringify({ ok: false, error: auth.reason }),
        { status: auth.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const { to, cc, subject, body, attachments, billing_group_id, period } = await req.json();

    if (!to?.length || !subject || !body || !attachments?.length) {
      throw new Error('to, subject, body, and attachments are required');
    }

    const personalization: Record<string, unknown> = { to };
    if (cc?.length) personalization.cc = cc;

    const sgAttachments = attachments.map((a: any) => ({
      content: a.content,
      filename: a.filename,
      type: a.type || 'application/pdf',
      disposition: 'attachment',
    }));

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [personalization],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: 'text/html', value: body }],
        attachments: sgAttachments,
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error('SendGrid error ' + sgRes.status + ': ' + errBody);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
    const toEmails = to.map((t: any) => t.email).join(', ');

    await supabase.from('email_messages').insert({
      direction: 'outbound',
      subject,
      body,
      from_email: FROM_EMAIL,
      to_email: toEmails,
    });

    return new Response(
      JSON.stringify({ ok: true, message: 'Invoice sent to ' + toEmails }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: (err as Error).message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
