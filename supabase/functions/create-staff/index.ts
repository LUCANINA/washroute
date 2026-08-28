import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || '*';
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Normalize a phone string to E.164 (digits only, 1-prefixed). Returns null if too short.
function toE164(phone?: string): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return '1' + digits.slice(-10);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

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
  if (callerProfile?.role !== 'admin') return new Response(JSON.stringify({ error: 'Forbidden: admin role required' }), { status: 403, headers: CORS });

  let body: { email?: string; password?: string; role?: string; first_name?: string; last_name?: string; phone?: string };
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

  const { email, password, role, first_name, last_name, phone } = body;
  if (!email || !email.includes('@')) return new Response(JSON.stringify({ error: 'Valid email required' }), { status: 400, headers: CORS });
  if (!password || password.length < 8) return new Response(JSON.stringify({ error: 'Password must be at least 8 characters' }), { status: 400, headers: CORS });

  // session 134: allowlist updated to match the live role enum (session 132 renamed staff -> pos_device + added attendant).
  // Default fallback is 'attendant' instead of the legacy 'staff' value, which would silently lock out new POS users from the dashboard nav.
  // (Session 231: this line existed only in the DEPLOYED function — the repo copy was
  // still on the old 'staff' allowlist. Reconciled so the repo is the source of truth.)
  const safeRole = ['admin', 'manager', 'laundry_tech', 'attendant', 'pos_device'].includes(role ?? '') ? role! : 'attendant';
  const e164Phone = toE164(phone);

  // ── Session 231: refuse to create a SECOND account for someone already on the team ──
  // Aracely Cruzado got a second staff account here in June (same email, same phone,
  // role 'manager'). Driver access was switched on for it, so she ended up with two
  // drivers rows. Her phone-OTP login resolved to one of them while admin scheduled
  // her routes on the other, and on those days the driver app showed her an empty
  // route with no error anywhere. The DB now blocks the duplicate driver record
  // (trg_prevent_duplicate_driver_identity) — this stops the duplicate PERSON one
  // step earlier, where the message can actually name who they collide with.
  {
    const last10 = String(phone || '').replace(/\D/g, '').slice(-10);

    // Match in JS, not in the query: phones are stored inconsistently ('5107572669'
    // and '(510) 757-2669' are the same person), so an ilike pattern silently misses
    // half the duplicates. The staff roster is a few dozen rows — pull it and compare
    // normalized values.
    const STAFF_ROLES = ['admin', 'manager', 'laundry_tech', 'attendant', 'pos_device', 'driver'];
    const { data: existing } = await adminClient
      .from('profiles')
      .select('id, first_name, last_name, email, phone, role')
      .in('role', STAFF_ROLES);

    const clash = (existing || []).find((p: any) => {
      const sameEmail = (p.email || '').trim().toLowerCase() === email.trim().toLowerCase();
      const samePhone = last10.length === 10
        && String(p.phone || '').replace(/\D/g, '').slice(-10) === last10;
      return sameEmail || samePhone;
    });

    if (clash) {
      const who = [clash.first_name, clash.last_name].filter(Boolean).join(' ') || clash.email || 'A team member';
      const on  = (clash.email || '').trim().toLowerCase() === email.trim().toLowerCase() ? 'email address' : 'phone number';
      return new Response(JSON.stringify({
        error: `${who} already has an account with that ${on}. Open their team member record and edit it instead — creating a second account splits their routes across two driver records.`,
        existingUserId: clash.id,
      }), { status: 409, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  // session 111e: include phone on initial create so phone-OTP login works on day one.
  // phone_confirm:true is safe — admin entered the number directly.
  const createPayload: any = { email, password, email_confirm: true, user_metadata: { first_name, last_name } };
  if (e164Phone) {
    createPayload.phone = e164Phone;
    createPayload.phone_confirm = true;
  }

  const { data: newUser, error: createError } = await adminClient.auth.admin.createUser(createPayload);
  if (createError) return new Response(JSON.stringify({ error: createError.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });

  const { error: profileError } = await adminClient.from('profiles').upsert({
    id: newUser.user.id,
    role: safeRole,
    first_name: first_name || null,
    last_name: last_name || null,
    phone: phone || null,
    email: email,
  }, { onConflict: 'id' });
  // A staff auth user with no profiles row is an orphan: it can sign in but has no
  // role, so every role check fails in a different confusing way. Surface it rather
  // than reporting success (session 231).
  if (profileError) {
    console.error('Profile upsert failed for new staff user:', newUser.user.id, profileError.message);
    return new Response(JSON.stringify({
      error: 'Account was created but the team profile could not be saved: ' + profileError.message + ' — tell David before this person tries to log in.',
      userId: newUser.user.id,
    }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ success: true, userId: newUser.user.id, phoneSet: !!e164Phone }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
