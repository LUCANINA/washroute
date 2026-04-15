import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// v4 (session 111f): drop the brittle ILIKE+filter pre-query that was silently
// returning zero rows for some customers (Heather Covyknight, Lindsea Brown).
// Instead: fetch the minimal projection for all customers with non-null phone
// and filter in JS. ~500 rows is fast; no URL-escape gotchas with % wildcards.

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

    const normalize = (p: string | null | undefined) => (p || '').replace(/\D/g, '').slice(-10);

    let realAuthId: string | null = null;
    let matchKind: 'customer' | 'staff' | null = null;
    let totalCustomersScanned = 0;
    let totalStaffScanned = 0;

    // 1) Customer match — fetch minimal projection, filter in JS
    const { data: customers, error: custErr } = await supabase
      .from('customers')
      .select('id, profile_id, phone_cache, total_orders')
      .not('phone_cache', 'is', null);

    if (custErr) console.warn('[prepare-phone-otp] customers query error:', custErr.message);
    totalCustomersScanned = customers?.length || 0;

    const matchedCustomers = (customers || [])
      .filter(c => normalize(c.phone_cache) === last10 && c.profile_id);

    if (matchedCustomers.length > 0) {
      // Prefer the customer with the most orders (if multiple share the phone)
      matchedCustomers.sort((a, b) => (b.total_orders || 0) - (a.total_orders || 0));
      realAuthId = matchedCustomers[0].profile_id;
      matchKind = 'customer';
    } else {
      // 2) Staff match
      const { data: staffProfiles, error: staffErr } = await supabase
        .from('profiles')
        .select('id, phone, role')
        .in('role', ['driver','admin','manager','laundry_tech'])
        .not('phone', 'is', null);
      if (staffErr) console.warn('[prepare-phone-otp] staff query error:', staffErr.message);
      totalStaffScanned = staffProfiles?.length || 0;

      const matchedStaff = (staffProfiles || []).filter(p => normalize(p.phone) === last10);
      if (matchedStaff.length > 0) {
        realAuthId = matchedStaff[0].id;
        matchKind = 'staff';
      }
    }

    if (!realAuthId) {
      return new Response(JSON.stringify({
        ok: true,
        isNewSignup: true,
        debug: { last10, scanned_customers: totalCustomersScanned, scanned_staff: totalStaffScanned },
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // STEP 1: delete orphan phone-auth users with this number (not the real one; not staff)
    const { data: existingPhoneUsers } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const orphanIds: string[] = [];
    for (const u of existingPhoneUsers?.users || []) {
      if (u.id === realAuthId) continue;
      if (!u.phone) continue;
      if (normalize(u.phone) !== last10) continue;
      const { data: prof } = await supabase.from('profiles').select('role').eq('id', u.id).maybeSingle();
      if (prof && ['driver','admin','manager','laundry_tech'].includes(prof.role)) continue;
      orphanIds.push(u.id);
    }
    for (const id of orphanIds) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(id);
      if (delErr) console.warn(`[prepare-phone-otp] delete orphan ${id}: ${delErr.message}`);
    }

    // STEP 2: set the phone on the real auth user (if not already)
    const { data: realUser } = await supabase.auth.admin.getUserById(realAuthId);
    const realPhoneLast10 = normalize(realUser?.user?.phone);
    let linked = false;
    if (realPhoneLast10 !== last10) {
      const { error: updErr } = await supabase.auth.admin.updateUserById(realAuthId, {
        phone: e164,
        phone_confirm: true,
      });
      if (updErr) {
        console.warn(`[prepare-phone-otp] failed to set phone on ${realAuthId}: ${updErr.message}`);
        return new Response(JSON.stringify({
          ok: true, linked: false, matchKind, error: updErr.message, authUserId: realAuthId,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      linked = true;
      console.log(`[prepare-phone-otp] linked phone ${e164} to existing ${matchKind} auth user ${realAuthId}`);
    } else {
      console.log(`[prepare-phone-otp] phone already set on ${matchKind} auth user ${realAuthId}`);
    }

    return new Response(JSON.stringify({
      ok: true,
      linked,
      matchKind,
      cleanedOrphans: orphanIds.length,
      authUserId: realAuthId,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err: any) {
    console.error('[prepare-phone-otp] error:', err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
