import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// v5 (session 294e): lookup moved to SQL (public.prepare_phone_otp_lookup) — see below.

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

    // v5 (session 294e): the lookup runs in SQL. v4 scanned customers and auth users
    // in JS, but PostgREST caps a select at 1000 rows (there are 4,000+ customers)
    // and listUsers() returned page 1 of 2,000+ logins — so many returning customers
    // were never matched, or a stale phone login was never cleared, and the SMS
    // code went to an empty login instead of their account.
    const { data: look, error: lookErr } = await supabase.rpc('prepare_phone_otp_lookup', { p_last10: last10 });
    if (lookErr) throw new Error(`lookup failed: ${lookErr.message}`);
    const realAuthId: string | null = look?.real_auth_id ?? null;
    const matchKind: 'customer' | 'staff' | null = look?.match_kind ?? null;

    if (!realAuthId) {
      return new Response(JSON.stringify({ ok: true, isNewSignup: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // STEP 1: delete stale phone logins with this number (the SQL lookup already
    // excludes the real login, any login attached to a customer, and staff).
    const orphanIds: string[] = Array.isArray(look?.orphan_ids) ? look.orphan_ids : [];
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
