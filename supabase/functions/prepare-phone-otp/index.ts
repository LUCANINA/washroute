import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// PURPOSE: account-link a phone to an existing CUSTOMER or STAFF auth user BEFORE
// the calling app calls Supabase's signInWithOtp({phone}). Mirror of
// send-magic-link v17 for the phone-OTP flow.
// session 111e: extended to also handle staff (drivers/admins/managers) whose
// profile has the phone but auth.users does not.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone } = await req.json();
    if (!phone) throw new Error('phone is required');

    const digits = String(phone).replace(/\D/g, '');
    const last10 = digits.slice(-10);
    if (last10.length < 10) {
      return new Response(JSON.stringify({ ok: true, skipped: 'short_phone' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const e164 = digits.length === 11 && digits.startsWith('1') ? digits : `1${last10}`;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // ----- Find the real auth user this phone should land on -----
    let realAuthId: string | null = null;
    let matchKind: 'customer' | 'staff' | null = null;

    // 1) Customer match (existing behavior)
    const { data: customers, error: custErr } = await supabase
      .from('customers')
      .select('id, profile_id, first_name_cache, last_name_cache')
      .filter('phone_cache', 'not.is', null)
      .ilike('phone_cache', `%${last10.slice(0,3)}%${last10.slice(3,6)}%${last10.slice(6,10)}%`);
    if (custErr) console.warn('[prepare-phone-otp] customers query error:', custErr.message);

    const matchedCustomers = (customers || []).filter(c => {
      const cd = (c.phone_cache || '').replace(/\D/g, '');
      return cd.slice(-10) === last10;
    }).filter(c => c.profile_id);

    if (matchedCustomers.length > 0) {
      const { data: ranked } = await supabase.from('customers')
        .select('id, profile_id, total_orders')
        .in('id', matchedCustomers.map(m => m.id))
        .order('total_orders', { ascending: false, nullsFirst: false })
        .limit(1);
      const customer = ranked?.[0] || matchedCustomers[0];
      realAuthId = customer.profile_id;
      matchKind = 'customer';
    } else {
      // 2) Staff match (session 111e)
      // Look in profiles for staff with this phone. profile.id IS the auth.users id.
      const { data: staffProfiles, error: staffErr } = await supabase
        .from('profiles')
        .select('id, phone, role')
        .in('role', ['driver','admin','manager','laundry_tech'])
        .filter('phone', 'not.is', null);
      if (staffErr) console.warn('[prepare-phone-otp] staff query error:', staffErr.message);

      const matchedStaff = (staffProfiles || []).filter(p => {
        const pd = (p.phone || '').replace(/\D/g, '');
        return pd.slice(-10) === last10;
      });

      if (matchedStaff.length > 0) {
        realAuthId = matchedStaff[0].id;
        matchKind = 'staff';
      }
    }

    if (!realAuthId) {
      return new Response(JSON.stringify({ ok: true, isNewSignup: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ----- STEP 1: delete any orphan phone-auth user with this number that's NOT the real one -----
    const { data: existingPhoneUsers } = await supabase.auth.admin.listUsers({
      page: 1, perPage: 1000,
    });
    const orphanIds: string[] = [];
    for (const u of existingPhoneUsers?.users || []) {
      if (u.id === realAuthId) continue;
      if (!u.phone) continue;
      if (u.phone.replace(/\D/g, '').slice(-10) !== last10) continue;
      // Don't delete a staff auth user even if it's an apparent orphan — the new
      // BEFORE DELETE trigger on auth.users will block it, but skip explicitly so
      // we don't error out here.
      const { data: prof } = await supabase.from('profiles').select('role').eq('id', u.id).maybeSingle();
      if (prof && ['driver','admin','manager','laundry_tech'].includes(prof.role)) continue;
      orphanIds.push(u.id);
    }
    for (const id of orphanIds) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(id);
      if (delErr) console.warn(`[prepare-phone-otp] delete orphan ${id}: ${delErr.message}`);
    }

    // ----- STEP 2: ensure the real auth user has the phone set -----
    const { data: realUser } = await supabase.auth.admin.getUserById(realAuthId);
    const realPhoneDigits = (realUser?.user?.phone || '').replace(/\D/g, '');
    if (realPhoneDigits.slice(-10) !== last10) {
      const { error: updErr } = await supabase.auth.admin.updateUserById(realAuthId, {
        phone: e164,
        phone_confirm: true,
      });
      if (updErr) {
        console.warn(`[prepare-phone-otp] failed to set phone on ${realAuthId}: ${updErr.message}`);
        return new Response(JSON.stringify({ ok: true, linked: false, matchKind, error: updErr.message }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      console.log(`[prepare-phone-otp] linked phone ${e164} to existing ${matchKind} auth user ${realAuthId}`);
    }

    return new Response(JSON.stringify({
      ok: true, linked: true, matchKind, cleanedOrphans: orphanIds.length, authUserId: realAuthId,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[prepare-phone-otp] error:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
