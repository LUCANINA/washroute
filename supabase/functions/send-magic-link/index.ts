import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const FROM_EMAIL = 'info@familylaundry.com';
const FROM_NAME  = 'Family Laundry';
const APP_URL    = 'https://washroute.vercel.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── v19 (session 293): purpose 'add_card' — staff-sent "add your card" link that
// signs the customer in and opens the in-app add-card sheet. Staff-only, fixed redirect.
const APP_ADDCARD_URL = 'https://app.familylaundry.com/?addcard=1';
const STAFF_ROLES = new Set(['admin', 'manager', 'attendant', 'laundry_tech']);

async function isStaffCaller(req: Request, supabase: any): Promise<boolean> {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const jwt = m[1];
  if (jwt === (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return true;
  const { data: { user } } = await supabase.auth.getUser(jwt);
  if (!user) return false;
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
  return !!profile && STAFF_ROLES.has(profile.role);
}

function buildMagicLinkEmail(magicUrl: string, email: string, purpose = 'sign_in'): string {
  const isCard = purpose === 'add_card';
  const title  = isCard ? 'Add your card to Family Laundry' : 'Sign in to Family Laundry';
  const intro  = isCard
    ? 'Tap the button below to add your payment card. It signs you in to the Family Laundry app and opens the secure card form &mdash; we only charge your card after each order is delivered. This link is valid for <strong>1 hour</strong> and can only be used once.'
    : 'Use the button below to sign in to your Family Laundry account. This link is valid for <strong>1 hour</strong> and can only be used once.';
  const cta    = isCard ? 'Add My Card &rarr;' : 'Sign In to My Account &rarr;';
  const after  = isCard
    ? 'Link expired? Open app.familylaundry.com, sign in, and go to Account &rarr; Profile &rarr; Payment.'
    : 'If you didn&rsquo;t request this, you can safely ignore this email &mdash; your account won&rsquo;t be changed.';
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;max-width:520px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.10);">
          <tr><td style="background:#0f2744;padding:32px;text-align:center;">
            <div style="font-size:22px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:white;">Family Laundry</div>
            <div style="font-size:13px;color:rgba(255,255,255,.55);margin-top:4px;">Pickup &amp; delivery laundry service</div>
          </td></tr>
          <tr><td style="padding:36px 36px 28px;">
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px;">Hi there,</p>
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 28px;">${intro}</p>
            <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;"><tr><td style="background:#0f2744;border-radius:10px;text-align:center;">
              <a href="${magicUrl}" style="display:inline-block;padding:15px 36px;font-size:15px;font-weight:700;color:white;text-decoration:none;letter-spacing:.02em;">${cta}</a>
            </td></tr></table>
            <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:0;">${after}</p>
            <p style="font-size:12px;color:#9ca3af;line-height:1.6;margin:16px 0 0;">If the button doesn&rsquo;t work, copy and paste this link:<br><span style="word-break:break-all;color:#2a6fc9;">${magicUrl}</span></p>
          </td></tr>
          <tr><td style="padding:20px 36px 28px;border-top:1px solid #f3f4f6;text-align:center;font-size:11.5px;color:#9ca3af;line-height:1.7;">
            Questions? Text us at (510) 588-4102<br>Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email, redirectTo, linkOnly, purpose } = await req.json();
    if (!email) throw new Error('email is required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const isCard = purpose === 'add_card';
    if (isCard && !(await isStaffCaller(req, supabase))) {
      return new Response(JSON.stringify({ ok: false, error: 'Staff sign-in required' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const finalRedirect = isCard ? APP_ADDCARD_URL : (redirectTo || APP_URL);

    // ── v18 (2026-04-17 / session 123): REFUSE when no customer exists for this email.
    //
    // v17 always called generateLink() in Step C, which creates a NEW email auth
    // user whenever one doesn't already exist. That silently spawned orphan
    // auth records whenever someone typed an email for which we had no
    // matching customer yet (e.g., new visitors, typos, or customers whose
    // email_cache didn't match what they typed). Examples caught by audit
    // check #12: Jennifer Fatzler (Apr 17), preeandrew@gmail.com (Apr 15).
    //
    // v18 enforces the principle: magic link is a SIGN-IN tool, not a signup
    // tool. Signups go through the signup form (email+password) or phone OTP.
    // So: if no customer record has this email_cache, we refuse cleanly and
    // tell the client to prompt the user to sign up or use phone OTP.
    // ────────────────────────────────────────────────────────────────────

    // Step A: Find a customer with this email AND an already-linked auth user.
    const { data: customers } = await supabase
      .from('customers')
      .select('id, profile_id, first_name_cache, last_name_cache, email_cache, phone_cache, total_orders')
      .eq('email_cache', email)
      .not('profile_id', 'is', null)
      .order('total_orders', { ascending: false, nullsFirst: false })
      .limit(1);

    if (!customers || customers.length === 0) {
      // Nobody with a linked auth user. Check if there's a LEGACY customer
      // (imported from Starchup) with this email but no profile_id yet.
      const { data: legacy } = await supabase
        .from('customers')
        .select('id, phone_cache')
        .eq('email_cache', email)
        .is('profile_id', null)
        .limit(1);

      if (legacy && legacy.length > 0 && legacy[0].phone_cache) {
        console.log(`[send-magic-link v18] Legacy customer for ${email} — directing to phone OTP.`);
        return new Response(JSON.stringify({
          ok: false,
          noAccount: true,
          legacyCustomer: true,
          error: "We have your account on file but haven't set it up for email sign-in yet. Please sign in with your phone number instead — we'll link everything up automatically.",
        }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      // No customer at all with this email. Refuse to create an orphan auth user.
      console.log(`[send-magic-link v18] No account for ${email} — refusing to generate link.`);
      return new Response(JSON.stringify({
        ok: false,
        noAccount: true,
        error: "We don't have an account for that email. Please sign up, or sign in using your phone number.",
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Step B: Delete any stale orphan email auth user for this email (same as v17).
    const { data: orphanCheck } = await supabase.rpc('find_orphan_email_auth_user', { p_email: email }).maybeSingle();
    if (orphanCheck?.orphan_auth_id) {
      console.log(`[send-magic-link v18] Deleting orphan email auth user ${orphanCheck.orphan_auth_id} for ${email}`);
      const { error: delErr } = await supabase.auth.admin.deleteUser(orphanCheck.orphan_auth_id);
      if (delErr) console.warn(`[send-magic-link v18] Orphan delete failed: ${delErr.message}`);
    }

    // Step C: Link the email to the customer's existing phone-auth user so
    // generateLink uses THAT user (not a fresh one).
    const customer = customers[0];
    const profileId = customer.profile_id;
    const { data: authUser } = await supabase.auth.admin.getUserById(profileId);

    if (authUser?.user && !authUser.user.email) {
      console.log(`[send-magic-link v18] Linking ${email} to existing phone auth user ${profileId}`);
      const { error: updateErr } = await supabase.auth.admin.updateUserById(profileId, {
        email,
        email_confirm: true,
      });
      if (updateErr) {
        console.warn(`[send-magic-link v18] Failed to link email to auth user ${profileId}: ${updateErr.message}`);
      }
    } else if (authUser?.user?.email && authUser.user.email.toLowerCase() !== email.toLowerCase()) {
      console.log(`[send-magic-link v18] Auth user ${profileId} has a different email ${authUser.user.email}; not overwriting.`);
    }

    // Step D: linkOnly short-circuit (for admin flows).
    if (linkOnly) {
      return new Response(JSON.stringify({ ok: true, linkedOnly: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Step E: generate + send the magic link.
    const { data, error: genErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: finalRedirect },
    });

    if (genErr || !data?.properties?.action_link) {
      throw new Error(genErr?.message ?? 'Failed to generate magic link');
    }

    const magicUrl = data.properties.action_link;
    const html = buildMagicLinkEmail(magicUrl, email, isCard ? 'add_card' : 'sign_in');

    const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: isCard ? 'Add your card — Family Laundry' : 'Your sign-in link — Family Laundry',
        content: [{ type: 'text/html', value: html }],
      }),
    });

    if (!sgRes.ok) {
      const errBody = await sgRes.text();
      throw new Error(`SendGrid error ${sgRes.status}: ${errBody}`);
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
