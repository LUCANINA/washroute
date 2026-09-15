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

// Orders that are in progress or whose charge failed — a customer may not
// remove their LAST card while one of these exists (staff may).
const IN_PROGRESS = ['picked_up', 'processing', 'folding', 'ready_for_delivery', 'out_for_delivery']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { customer_id, payment_method_id } = await req.json()
    const auth = await authorizeForCustomer(req, customer_id)
    if (!auth.ok) return json({ error: auth.reason }, auth.status)
    if (typeof payment_method_id !== 'string' || !payment_method_id) {
      return json({ error: 'Which card should be removed?' }, 400)
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
    const { data: pmRow } = await db.from('customer_payment_methods')
      .select('id, stripe_payment_method_id, is_default')
      .eq('customer_id', customer_id).eq('stripe_payment_method_id', payment_method_id).maybeSingle()
    if (!pmRow) return json({ error: 'Card not found' }, 404)

    const { count: cardCount } = await db.from('customer_payment_methods')
      .select('id', { count: 'exact', head: true }).eq('customer_id', customer_id)

    if (!auth.staff && (cardCount || 0) <= 1) {
      const [{ count: active }, { count: failed }] = await Promise.all([
        db.from('orders').select('id', { count: 'exact', head: true })
          .eq('customer_id', customer_id).in('status', IN_PROGRESS)
          .or('billing_status.is.null,billing_status.neq.paid'),
        db.from('orders').select('id', { count: 'exact', head: true })
          .eq('customer_id', customer_id).eq('billing_status', 'failed'),
      ])
      if ((active || 0) > 0 || (failed || 0) > 0) {
        return json({
          error: 'You have an order in progress. Add another card before removing this one.',
          code: 'last_card_in_use',
        }, 409)
      }
    }

    try { await stripe.paymentMethods.detach(payment_method_id) }
    catch (e: any) { console.warn('Stripe detach warning:', e.message) }

    await db.from('customer_payment_methods').delete()
      .eq('customer_id', customer_id).eq('stripe_payment_method_id', payment_method_id)

    let newDefault: string | null = null
    if (pmRow.is_default) {
      const { data: remaining } = await db.from('customer_payment_methods')
        .select('stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year')
        .eq('customer_id', customer_id).order('created_at', { ascending: false }).limit(1)
      const { data: cust } = await db.from('customers').select('stripe_customer_id').eq('id', customer_id).single()
      const next = remaining?.[0]
      if (next) {
        newDefault = next.stripe_payment_method_id
        await db.from('customer_payment_methods').update({ is_default: true })
          .eq('customer_id', customer_id).eq('stripe_payment_method_id', next.stripe_payment_method_id)
        if (cust?.stripe_customer_id) {
          try {
            await stripe.customers.update(cust.stripe_customer_id,
              { invoice_settings: { default_payment_method: next.stripe_payment_method_id } })
          } catch (_) { /* best effort */ }
        }
        await db.from('customers').update({
          stripe_default_payment_method_id: next.stripe_payment_method_id,
          card_last4: next.card_last4, card_brand: next.card_brand,
          card_exp_month: next.card_exp_month, card_exp_year: next.card_exp_year,
          updated_at: new Date().toISOString(),
        }).eq('id', customer_id)
      } else {
        await db.from('customers').update({
          stripe_default_payment_method_id: null,
          card_last4: null, card_brand: null, card_exp_month: null, card_exp_year: null,
          updated_at: new Date().toISOString(),
        }).eq('id', customer_id)
      }
    }
    return json({ success: true, newDefault })
  } catch (error: any) {
    console.error('remove-card error:', error)
    return json({ error: error.message || 'Could not remove card' }, 500)
  }
})
