import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';
const APP_URL    = 'https://washroute.vercel.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function buildMagicLinkEmail(magicUrl: string, email: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in to Family Laundry</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;max-width:520px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.10);">

          <!-- Header -->
          <tr>
            <td style="background:#0f2744;padding:32px;text-align:center;">
              <div style="font-size:22px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:white;">Family Laundry</div>
              <div style="font-size:13px;color:rgba(255,255,255,.55);margin-top:4px;">Pickup &amp; delivery laundry service</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px;">Hi there,</p>
              <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 28px;">Use the button below to sign in to your Family Laundry account. This link is valid for <strong>1 hour</strong> and can only be used once.</p>

              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="background:#0f2744;border-radius:10px;text-align:center;">
                    <a href="${magicUrl}" style="display:inline-block;padding:15px 36px;font-size:15px;font-weight:700;color:white;text-decoration:none;letter-spacing:.02em;">Sign In to My Account &rarr;</a>
                  </td>
                </tr>
              </table>

              <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:0;">If you didn&rsquo;t request this, you can safely ignore this email &mdash; your account won&rsquo;t be changed.</p>

              <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:16px 0 0;">If the button doesn&rsquo;t work, copy and paste this link:<br>
              <span style="word-break:break-all;color:#2a6fc9;">${magicUrl}</span></p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 36px 28px;border-top:1px solid #f3f4f6;text-align:center;font-size:11.5px;color:#9ca3af;line-height:1.7;">
              Questions? Text us at (510) 588-4102<br>
              Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { email, redirectTo } = await req.json();
    if (!email) throw new Error('email is required');

    // Use the Admin client to generate a magic link token
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const finalRedirect = redirectTo || APP_URL;

    // ── ACCOUNT LINKING (v16) ──────────────────────────────────────────
    // Before generating the magic link, check if this email belongs to an
    // existing customer whose auth user is phone-only (no email set).
    // If so, update that auth user to include the email so the magic link
    // logs them into their REAL account instead of creating a new ghost user.
    //
    // Without this, Supabase's generateLink silently creates a brand-new
    // auth.users row for the email, disconnected from the customer's phone
    // auth user. This caused 52+ orphaned auth accounts.
    // ────────────────────────────────────────────────────────────────────

    const { data: customers } = await supabase
      .from('customers')
      .select('id, profile_id, first_name_cache, last_name_cache, email_cache, phone_cache')
      .eq('email_cache', email)
      .not('profile_id', 'is', null)
      .order('total_orders', { ascending: false, nullsFirst: false })
      .limit(1);

    if (customers && customers.length > 0) {
      const customer = customers[0];
      const profileId = customer.profile_id;

      // Check if this customer's auth user already has this email
      const { data: authUser } = await supabase.auth.admin.getUserById(profileId);

      if (authUser?.user && !authUser.user.email) {
        // Phone-only auth user — add the email so generateLink uses THIS user
        console.log(`[send-magic-link] Linking email ${email} to existing phone auth user ${profileId} (customer: ${customer.first_name_cache} ${customer.last_name_cache})`);

        const { error: updateErr } = await supabase.auth.admin.updateUserById(profileId, {
          email,
          email_confirm: true, // Auto-confirm since they already own this email via customer record
        });

        if (updateErr) {
          console.warn(`[send-magic-link] Failed to link email to auth user ${profileId}: ${updateErr.message}`);
          // Fall through — generateLink will create a new user, but claim_existing_customer
          // will handle account linking on login. Not ideal, but not a blocker.
        }
      } else if (authUser?.user?.email && authUser.user.email !== email) {
        // Auth user has a DIFFERENT email — don't overwrite it.
        // generateLink will create/find the user for this email, and
        // claim_existing_customer will handle linking on login.
        console.log(`[send-magic-link] Auth user ${profileId} already has email ${authUser.user.email}, not overwriting with ${email}`);
      }
      // If authUser.user.email === email, perfect — generateLink will use the existing user
    }

    // Also check: does an orphaned email auth user already exist for this email?
    // If so AND we just linked the email to the phone auth user above, the orphan
    // will conflict with generateLink. Clean it up proactively.
    const { data: orphanCheck } = await supabase.rpc('find_orphan_email_auth_user', {
      p_email: email,
    }).maybeSingle();

    // If there's an orphan (email auth user not linked to any customer), delete it
    // so it doesn't interfere with the magic link generation
    if (orphanCheck?.orphan_auth_id) {
      console.log(`[send-magic-link] Deleting orphaned email auth user ${orphanCheck.orphan_auth_id} for ${email}`);
      await supabase.auth.admin.deleteUser(orphanCheck.orphan_auth_id);
    }

    const { data, error: genErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: finalRedirect },
    });

    if (genErr || !data?.properties?.action_link) {
      throw new Error(genErr?.message ?? 'Failed to generate magic link');
    }

    const magicUrl = data.properties.action_link;
    const html = buildMagicLinkEmail(magicUrl, email);

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: 'Your sign-in link — Family Laundry',
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error(`SendGrid error ${sgRes.status}: ${errBody}`);
    }

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
