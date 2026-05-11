// ════════════════════════════════════════════════════════════════════════════
// provision-device-account — session 147 pt 15
// ════════════════════════════════════════════════════════════════════════════
// Admin-only. Creates a shared device account in three steps within one logical
// operation:
//   1. auth.user via admin API (needs service_role)
//   2. profiles row with role = laundry_tech | pos_device
//   3. (POS only) pos_devices row with name + optional printer_token
//
// Multi-tenant scaffold: the request accepts an optional `tenant_id`. Today
// it's a placeholder — there is no `tenants` table yet and no tenant filtering
// in RLS. When the multi-tenant migration lands, this parameter becomes
// authoritative and gets stamped on every row this function creates. Callers
// can already pass it without breakage.
//
// Reversal of a created device account (no automatic undo): manually delete
// the auth user via Supabase dashboard, the profile row, and the pos_devices
// row (if any).
// ════════════════════════════════════════════════════════════════════════════
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEVICE_ROLES = new Set(['laundry_tech', 'pos_device']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: CORS });

  // ── Caller auth ──
  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace('Bearer ', '').trim();
  if (!callerToken) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const { data: { user: callerUser } } = await callerClient.auth.getUser();
  if (!callerUser) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS });

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerProfile } = await adminClient.from('profiles').select('role').eq('id', callerUser.id).single();
  if (callerProfile?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── Body parse + validate ──
  let body: {
    device_type?: string;
    name?: string;
    email?: string;
    password?: string;
    printer_token?: string;
    location?: string;
    tenant_id?: string; // accepted but ignored today; ready for multi-tenant
  };
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

  const { device_type, name, email, password, printer_token, location } = body;

  if (!device_type || !DEVICE_ROLES.has(device_type)) {
    return new Response(JSON.stringify({ error: `device_type must be one of: ${[...DEVICE_ROLES].join(', ')}` }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  if (!name || !name.trim()) {
    return new Response(JSON.stringify({ error: 'name is required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Valid email required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  if (!password || password.length < 8) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── 1. Create auth user ──
  // user_metadata.first_name = the display name so the row reads naturally on
  // the Team > Devices list.
  const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { first_name: name.trim(), last_name: '' },
  });
  if (createError || !newUser?.user) {
    return new Response(JSON.stringify({ error: createError?.message || 'auth user creation failed' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── 2. Profile row ──
  const { error: profileError } = await adminClient.from('profiles').upsert({
    id: newUser.user.id,
    role: device_type,
    first_name: name.trim(),
    last_name: '',
    email,
  }, { onConflict: 'id' });
  if (profileError) {
    // Auth user got created but profile didn't — best-effort rollback so we
    // don't leave a half-provisioned account.
    await adminClient.auth.admin.deleteUser(newUser.user.id);
    return new Response(JSON.stringify({ error: 'profile insert failed: ' + profileError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // ── 3. pos_devices row (POS only) ──
  let pos_device_id: string | null = null;
  if (device_type === 'pos_device') {
    const { data: pd, error: pdError } = await adminClient.from('pos_devices').insert({
      name: name.trim(),
      auth_user_id: newUser.user.id,
      printer_token: printer_token || null,
      location: location || null,
      is_active: true,
    }).select('id').single();
    if (pdError) {
      // Rollback profile + auth on failure here as well.
      await adminClient.from('profiles').delete().eq('id', newUser.user.id);
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return new Response(JSON.stringify({ error: 'pos_devices insert failed: ' + pdError.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    pos_device_id = pd.id;
  }

  return new Response(JSON.stringify({
    success: true,
    auth_user_id: newUser.user.id,
    profile_id: newUser.user.id,
    pos_device_id,
    email,
    device_type,
  }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
