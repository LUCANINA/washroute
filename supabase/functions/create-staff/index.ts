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

  const safeRole = ['admin', 'manager', 'laundry_tech', 'staff'].includes(role ?? '') ? role! : 'staff';
  const e164Phone = toE164(phone);

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
  if (profileError) console.warn('Profile upsert warning:', profileError.message);

  return new Response(JSON.stringify({ success: true, userId: newUser.user.id, phoneSet: !!e164Phone }), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
