import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Session 167 Phase 7: in-app subscribe using a saved card on file.
//
// Replaces the Stripe-hosted Checkout (still available via create-checkout for
// new customers with no saved card; see Phase 8's embedded Payment Element
// for the new-card path). This function is the SAVED-CARD path:
//   1. Customer is already PAYG and has stripe_default_payment_method_id set
//   2. They tap "Subscribe" in-app, see a confirm modal showing their saved card
//   3. We create the Stripe subscription server-side via API with the saved card
//   4. Webhook fires customer.subscription.created → pricelist auto-switches to
//      Subscription, subscriptions row upserted, etc. (all existing v44 logic)
//
// Requires the caller's user JWT (the customer themselves). Returns 401 for
// anon-key callers (same pattern as refund-charge).

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl     = Deno.env.get('SUPABASE_URL')!
const supabaseKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const ALLOWED_ORIGIN  = Deno.env.get('ALLOWED_ORIGIN') || '*'

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function requireOwnership(req: Request, customerId: string): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization: Bearer <jwt>' }
  const jwt = m[1]
  if (jwt === supabaseAnonKey) return { ok: false, status: 401, reason: 'Anon key not accepted; sign in to subscribe' }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt)
  if (userErr || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' }

  const adminClient = createClient(supabaseUrl, supabaseKey)
  const { data: cust } = await adminClient.from('customers').select('profile_id').eq('id', customerId).single()
  if (!cust) return { ok: false, status: 404, reason: 'Customer not found' }
  if (cust.profile_id !== user.id) return { ok: false, status: 403, reason: 'Forbidden — can only subscribe your own account' }
  return { ok: true }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, supabaseKey)
    const { planId, customerId } = await req.json()

    if (!planId) throw new Error('planId is required')
    if (!customerId) throw new Error('customerId is required')

    const auth = await requireOwnership(req, customerId)
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const { data: plan } = await db.from('subscription_plans')
      .select('id, name, stripe_price_id, price_monthly, is_active')
      .eq('id', planId).single()
    if (!plan) throw new Error('Plan not found')
    if (!plan.is_active) {
      return new Response(JSON.stringify({ error: 'This subscription plan is not currently available.' }), {
        status: 403, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const { data: customer } = await db.from('customers')
      .select('id, stripe_customer_id, stripe_default_payment_method_id, email_cache, first_name_cache, last_name_cache, card_brand, card_last4')
      .eq('id', customerId).single()
    if (!customer) throw new Error('Customer not found')
    if (!customer.stripe_customer_id) {
      return new Response(JSON.stringify({ error: 'No Stripe customer on file. Please add a payment method first.', code: 'no_stripe_customer' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    if (!customer.stripe_default_payment_method_id) {
      return new Response(JSON.stringify({ error: 'No saved card on file. Please add a payment method first.', code: 'no_saved_card' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const { data: existingSub } = await db.from('subscriptions')
      .select('id, status, stripe_subscription_id')
      .eq('customer_id', customerId)
      .in('status', ['active', 'past_due', 'paused', 'incomplete'])
      .maybeSingle()
    if (existingSub) {
      return new Response(JSON.stringify({ error: `Already subscribed (${existingSub.status}).`, code: 'already_subscribed' }), {
        status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    let priceId = plan.stripe_price_id
    if (!priceId) {
      const product = await stripe.products.create({
        name: `Family Laundry ${plan.name}`,
        metadata: { supabase_plan_id: plan.id },
      })
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(Number(plan.price_monthly) * 100),
        currency: 'usd',
        recurring: { interval: 'month' },
      })
      priceId = price.id
      await db.from('subscription_plans').update({ stripe_price_id: priceId }).eq('id', plan.id)
    }

    await stripe.customers.update(customer.stripe_customer_id, {
      invoice_settings: { default_payment_method: customer.stripe_default_payment_method_id },
    })

    const idempotencyKey = `sub-create-${customer.id}-${plan.id}`
    const subscription = await stripe.subscriptions.create({
      customer: customer.stripe_customer_id,
      items: [{ price: priceId }],
      default_payment_method: customer.stripe_default_payment_method_id,
      payment_behavior: 'error_if_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        supabase_plan_id: plan.id,
        supabase_customer_id: customer.id,
        source: 'in_app_saved_card',
      },
    }, { idempotencyKey })

    if (subscription.status === 'incomplete' || subscription.status === 'incomplete_expired') {
      return new Response(JSON.stringify({
        error: 'The first subscription charge could not be completed. Please update your card and try again.',
        code: 'payment_failed',
        subscription_id: subscription.id,
        status: subscription.status,
      }), { status: 402, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      success: true,
      subscription_id: subscription.id,
      status: subscription.status,
      card_brand: customer.card_brand,
      card_last4: customer.card_last4,
      plan_name: plan.name,
      price_monthly: plan.price_monthly,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error('create-subscription error:', error)
    const msg = error?.message || 'Subscription creation failed'
    const code = error?.code || error?.raw?.code || 'unknown_error'
    return new Response(JSON.stringify({ error: msg, code }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
