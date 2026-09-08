import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // Verify caller is an authenticated admin
  const authHeader = req.headers.get('Authorization') || '';
  const callerToken = authHeader.replace('Bearer ', '').trim();
  if (!callerToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: missing service key' }), { status: 500 });
  }

  // Use caller's JWT to get their user ID
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${callerToken}` } },
  });
  const { data: { user: callerUser }, error: userError } = await callerClient.auth.getUser();
  if (userError || !callerUser) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  // Check caller's role in profiles table
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerProfile } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', callerUser.id)
    .single();

  if (callerProfile?.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403 });
  }

  // Parse request body
  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { email, role } = body;
  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Valid email required' }), { status: 400 });
  }

  // Session 262: this allowlist had gone stale. It still contained the retired
  // 'staff' role (renamed to pos_device back in session 132) and was missing
  // 'attendant', 'pos_device' and 'cpa'. Anything not listed fell back to
  // 'staff', which profiles_role_check now REJECTS — so the invite email went
  // out and the profile upsert failed with only a console.warn, leaving an
  // invited user with no role at all. Kept in sync with create-staff.
  const allowedRoles = ['admin', 'manager', 'laundry_tech', 'attendant', 'pos_device', 'cpa'];
  const safeRole = allowedRoles.includes(role ?? '') ? role! : 'attendant';

  // Send magic-link invite email — redirect to admin dashboard
  const { data: inviteData, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    data: { invited_role: safeRole },
    redirectTo: 'https://admin.familylaundry.com',
  });

  if (inviteError) {
    return new Response(JSON.stringify({ error: inviteError.message }), {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
    });
  }

  // Update or insert profile with the desired role
  const userId = inviteData.user.id;
  const { error: profileError } = await adminClient
    .from('profiles')
    .upsert({ id: userId, role: safeRole, email }, { onConflict: 'id' });

  if (profileError) {
    // Session 262: no longer swallowed. A silent failure here is exactly how an
    // invited user ends up able to log in with no role, failing every role check
    // in a different confusing way.
    console.error('Profile upsert failed for invited user:', userId, profileError.message);
    return new Response(JSON.stringify({
      error: 'Invite email was sent but the role could not be saved: ' + profileError.message + ' — set their role on the Team page before they log in.',
      userId,
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
    });
  }

  return new Response(JSON.stringify({ success: true, userId }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    },
  });
});
