import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

// ── Caller authorization (session 293) ─────────────────────────────────────
// These card functions run with the service-role key, so they MUST prove the
// caller may act on `customerId`: either the signed-in customer who owns that
// customer row, or a staff member. The anon key alone is rejected.
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const CARD_STAFF_ROLES  = new Set(['admin', 'manager', 'attendant', 'laundry_tech'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Authz = { ok: true; staff: boolean } | { ok: false; status: number; reason: string }

async function authorizeForCustomer(req: Request, customerId: unknown): Promise<Authz> {
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) {
    return { ok: false, status: 400, reason: 'A valid customer id is required' }
  }
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Please sign in' }
  const jwt = m[1]
  if (jwt === SUPABASE_SVC_KEY) return { ok: true, staff: true }
  if (jwt === SUPABASE_ANON_KEY) return { ok: false, status: 401, reason: 'Please sign in' }

  const admin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
  const { data: { user }, error } = await admin.auth.getUser(jwt)
  if (error || !user) return { ok: false, status: 401, reason: 'Your session has expired. Please sign in again.' }

  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (profile && CARD_STAFF_ROLES.has(profile.role)) return { ok: true, staff: true }

  const { data: own } = await admin.from('customers').select('id')
    .eq('id', customerId).eq('profile_id', user.id).maybeSingle()
  if (!own) return { ok: false, status: 403, reason: 'Not allowed' }
  return { ok: true, staff: false }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { customerId } = await req.json()
    const auth = await authorizeForCustomer(req, customerId)
    if (!auth.ok) return json({ error: auth.reason }, auth.status)

    const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
    const { data: customer } = await db.from('customers')
      .select('id, stripe_customer_id, first_name_cache, last_name_cache, email_cache')
      .eq('id', customerId).single()
    if (!customer) return json({ error: 'Customer not found' }, 404)

    let stripeCustomerId = customer.stripe_customer_id
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email_cache || undefined,
        name: `${customer.first_name_cache || ''} ${customer.last_name_cache || ''}`.trim() || undefined,
        metadata: { supabase_customer_id: customer.id },
      })
      stripeCustomerId = sc.id
      await db.from('customers').update({ stripe_customer_id: stripeCustomerId }).eq('id', customer.id)
    }

    // Cards only (Apple Pay / Google Pay are cards). No Link, no bank debits.
    const setupIntent = await stripe.setupIntents.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      usage: 'off_session',
      metadata: { supabase_customer_id: customer.id },
    })
    return json({ clientSecret: setupIntent.client_secret, stripeCustomerId })
  } catch (error: any) {
    console.error('create-setup-intent error:', error)
    return json({ error: error.message || 'Could not start card setup' }, 500)
  }
})
