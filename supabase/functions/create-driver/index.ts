import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Creates a driver login. Called from Admin → Drivers → Add driver.
//
// SECURITY (audit 2026-09-22): this function had NO caller check at all, and
// verify_jwt is false, so anyone on the internet could POST an email + password
// and receive a working, email-confirmed `driver` login. A driver login can send
// SMS from the business Twilio number (send-sms STAFF_SMS_ROLES includes driver),
// trigger customer notifications, and read routes/route_stops. Now only a signed-in
// admin or manager may call it. Auth block mirrors charge-order/index.ts.
const supabaseUrl        = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAnonKey    = Deno.env.get('SUPABASE_ANON_KEY')!

const CREATE_DRIVER_ROLES = new Set(['admin', 'manager'])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function authorize(req: Request): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Staff login required' }
  const jwt = m[1]

  if (jwt === supabaseServiceKey) return { ok: true }
  if (jwt === supabaseAnonKey) {
    return { ok: false, status: 401, reason: 'Anon key not accepted; staff login required' }
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt)
  if (userErr || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey)
  const { data: profile, error: profErr } = await adminClient
    .from('profiles').select('role').eq('id', user.id).single()
  if (profErr || !profile) return { ok: false, status: 403, reason: 'Profile not found' }
  if (!CREATE_DRIVER_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to create drivers` }
  }
  return { ok: true }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const auth = await authorize(req)
    if (!auth.ok) return Response.json({ error: auth.reason }, { status: auth.status, headers: corsHeaders })

    const { email, password, first_name, last_name, phone, license_number, license_expiry } = await req.json()

    if (!email || !password || !first_name || !last_name) {
      return Response.json({ error: 'email, password, first_name, and last_name are required' }, { status: 400, headers: corsHeaders })
    }

    if (password.length < 8) {
      return Response.json({ error: 'Password must be at least 8 characters' }, { status: 400, headers: corsHeaders })
    }

    // Admin client with service role (bypasses RLS, can create auth users)
    const adminClient = createClient(
      supabaseUrl,
      supabaseServiceKey,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // 1. Create Supabase auth user (auto-confirmed so driver can log in immediately)
    const { data: authData, error: authErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (authErr) return Response.json({ error: authErr.message }, { status: 400, headers: corsHeaders })

    const userId = authData.user.id

    // 2. Upsert profile row (trigger may have created a stub already)
    const { error: profileErr } = await adminClient.from('profiles').upsert({
      id:         userId,
      role:       'driver',
      first_name,
      last_name,
      phone:      phone  || null,
      email,
    }, { onConflict: 'id' })
    if (profileErr) return Response.json({ error: 'Profile error: ' + profileErr.message }, { status: 400, headers: corsHeaders })

    // 3. Create driver row
    const { error: driverErr } = await adminClient.from('drivers').insert({
      profile_id:     userId,
      license_number: license_number || null,
      license_expiry: license_expiry || null,
      is_active:      true,
    })
    if (driverErr) return Response.json({ error: 'Driver error: ' + driverErr.message }, { status: 400, headers: corsHeaders })

    return Response.json({ success: true, userId }, { headers: corsHeaders })

  } catch (e) {
    return Response.json({ error: e.message || 'Unexpected error' }, { status: 500, headers: corsHeaders })
  }
})
