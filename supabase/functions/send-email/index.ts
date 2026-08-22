import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Authorization ─────────────────────────────────────────────────────────
// This endpoint sends HTML from info@familylaundry.com, an SPF/DKIM-aligned
// domain, so it must never be an open relay. profiles.role values are:
// customer, attendant, driver, manager, admin, pos_device, laundry_tech.
//
//  * service-role key  -> full send (internal callers: stripe-webhook, etc.)
//  * admin/manager/attendant JWT -> full send (arbitrary to_email + body)
//  * customer JWT      -> may ONLY send about their OWN order. They must pass
//                         order_id; the recipient address is looked up from
//                         that order's customer server-side and any client
//                         supplied to_email/customer_id is ignored. A caller
//                         never gets to pick both the recipient and the HTML.
//  * anon key          -> rejected
const STAFF_EMAIL_ROLES = new Set(['admin', 'manager', 'attendant']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuthOk =
  | { ok: true; mode: 'staff' }
  | { ok: true; mode: 'customer'; customerId: string; toEmail: string };
type AuthResult = AuthOk | { ok: false; status: number; reason: string };

async function authorize(req: Request, payload: any): Promise<AuthResult> {
  // Internal caller: pg_cron jobs and SECURITY DEFINER trigger/RPC functions reach
  // us through net.http_post and cannot present the service-role key (it is not
  // stored anywhere reachable from SQL — the vault is empty). They send the shared
  // secret from public.wr_internal_auth, a table with RLS on, no policies and no
  // anon/authenticated grants, so only a service-role client can read it.
  // See migration session_227h_internal_call_secret.
  const internalSecret = req.headers.get('x-wr-internal') || '';
  if (internalSecret) {
    const secretClient = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
    const { data: iaRow } = await secretClient.from('wr_internal_auth').select('secret').maybeSingle();
    if (iaRow?.secret && internalSecret === iaRow.secret) return { ok: true, mode: 'staff' };
  }

  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' };
  const jwt = m[1];

  if (jwt === SUPABASE_SVC_KEY) return { ok: true, mode: 'staff' };

  if (jwt === SUPABASE_ANON_KEY) {
    return { ok: false, status: 401, reason: 'Anon key not accepted; sign-in required' };
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

  if (STAFF_EMAIL_ROLES.has(profile.role)) return { ok: true, mode: 'staff' };

  if (profile.role === 'customer') {
    const orderId = payload?.order_id;
    if (typeof orderId !== 'string' || !UUID_RE.test(orderId)) {
      return { ok: false, status: 403, reason: 'Customers may only email about their own order (order_id required)' };
    }
    const { data: order, error: orderErr } = await adminClient
      .from('orders').select('id, customer_id').eq('id', orderId).single();
    if (orderErr || !order) return { ok: false, status: 403, reason: 'Order not found' };

    const { data: cust, error: custErr } = await adminClient
      .from('customers').select('id, profile_id, email_cache').eq('id', order.customer_id).single();
    if (custErr || !cust) return { ok: false, status: 403, reason: 'Customer not found' };
    if (cust.profile_id !== user.id) {
      return { ok: false, status: 403, reason: 'Order does not belong to this account' };
    }
    if (!cust.email_cache) return { ok: false, status: 400, reason: 'No email address on file' };

    return { ok: true, mode: 'customer', customerId: cust.id, toEmail: cust.email_cache };
  }

  return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to send email` };
}

// ── HMAC helper (must match email-unsubscribe function) ───────────────────
async function hmacSign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SUPABASE_SVC_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Build the unsubscribe footer HTML with a signed link
async function buildUnsubscribeFooter(customerId: string): Promise<string> {
  const token = await hmacSign(customerId);
  const url = `${SUPABASE_URL}/functions/v1/email-unsubscribe?id=${encodeURIComponent(customerId)}&token=${encodeURIComponent(token)}`;
  return `
    <div style="margin-top:32px; padding-top:16px; border-top:1px solid #eee; text-align:center; font-size:12px; color:#999;">
      <p>Family Laundry &middot; Oakland, CA</p>
      <p style="margin-top:4px;"><a href="${url}" style="color:#999; text-decoration:underline;">Unsubscribe from marketing emails</a></p>
    </div>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const payload = await req.json();

    const auth = await authorize(req, payload);
    if (!auth.ok) {
      return new Response(
        JSON.stringify({ ok: false, error: auth.reason }),
        { status: auth.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { subject, body } = payload;
    // Customer callers never choose the recipient: it comes from their order.
    const customer_id = auth.mode === 'customer' ? auth.customerId : payload.customer_id;
    const to_email    = auth.mode === 'customer' ? auth.toEmail    : payload.to_email;
    if (!to_email || !subject || !body) throw new Error('to_email, subject, and body are required');

    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

    // Append unsubscribe footer if we have a customer_id
    let finalBody = body;
    if (customer_id) {
      const footer = await buildUnsubscribeFooter(customer_id);
      // If the body has a closing </body> or </html> tag, insert before it.
      // Otherwise just append.
      if (finalBody.includes('</body>')) {
        finalBody = finalBody.replace('</body>', `${footer}</body>`);
      } else if (finalBody.includes('</html>')) {
        finalBody = finalBody.replace('</html>', `${footer}</html>`);
      } else {
        finalBody = finalBody + footer;
      }
    }

    // Send via SendGrid
    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to_email }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        reply_to: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: 'text/html', value: finalBody }],
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error(`SendGrid error ${sgRes.status}: ${errBody}`);
    }

    // Log to email_messages
    const { error: insertErr } = await supabase.from('email_messages').insert({
      customer_id: customer_id || null,
      direction: 'outbound',
      subject,
      body: finalBody,
      from_email: FROM_EMAIL,
      to_email,
    });

    if (insertErr) console.warn('email_messages insert error:', insertErr.message);

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
