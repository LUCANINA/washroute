import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
    const { customer_id, to_email, subject, body } = await req.json();
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
