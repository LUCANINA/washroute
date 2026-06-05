import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ─────────────────────────────────────────────────────────────────────────────
// Session 168 — SERVER-SIDE SOFT-LAUNCH ALLOWLIST (mirrors customer-app
// SUBSCRIPTIONS_ALLOWLIST + create-subscription). The UI flag is NOT a billing
// boundary (session-157 lesson). While this list is NON-EMPTY, a SUBSCRIPTION
// checkout may only be created for these emails — even though the plan is active
// for the soft-launch window. EMPTY this array (set to []) and redeploy on
// Monday's public launch to open subscriptions to everyone. This function is
// the legacy Stripe-hosted Checkout path (the in-app flows use
// create-subscription); gating it too closes the back door.
const SUBSCRIPTION_ALLOWLIST = [
  'dmacquart@gmail.com',
  'dmacquart+wrsignup1@gmail.com',
  'dmacquart+sub4@gmail.com',
].map(e => e.toLowerCase())

function emailAllowed(email: string | null | undefined): boolean {
  if (SUBSCRIPTION_ALLOWLIST.length === 0) return true  // launch mode: open to all
  return !!email && SUBSCRIPTION_ALLOWLIST.includes(String(email).toLowerCase())
}
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, supabaseServiceKey)
    const { type, orderId, planId, userId, customerId, successUrl, cancelUrl } = await req.json()

    // Support two lookup modes:
    // 1. customerId (admin flow) — look up customer directly by customers.id
    // 2. userId (customer self-service) — look up customer by profile_id
    let customer
    if (customerId) {
      const { data } = await db.from('customers')
        .select('id, stripe_customer_id, first_name_cache, last_name_cache, email_cache')
        .eq('id', customerId)
        .single()
      customer = data
    } else if (userId) {
      const { data } = await db.from('customers')
        .select('id, stripe_customer_id, first_name_cache, last_name_cache, email_cache')
        .eq('profile_id', userId)
        .single()
      customer = data
    }

    if (!customer) throw new Error('Customer not found')

    let stripeCustomerId = customer.stripe_customer_id
    if (!stripeCustomerId) {
      const sc = await stripe.customers.create({
        email: customer.email_cache || '',
        name: `${customer.first_name_cache || ''} ${customer.last_name_cache || ''}`.trim(),
        metadata: { supabase_customer_id: customer.id },
      })
      stripeCustomerId = sc.id
      await db.from('customers').update({ stripe_customer_id: stripeCustomerId }).eq('id', customer.id)
    }

    let session

    if (type === 'order') {
      const { data: order } = await db.from('orders')
        .select('id, order_number, total_amount, services(name)')
        .eq('id', orderId)
        .single()
      if (!order) throw new Error('Order not found')

      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(Number(order.total_amount) * 100),
            product_data: {
              name: `Order #${order.order_number}`,
              description: 'Family Laundry pickup & delivery',
            },
          },
          quantity: 1,
        }],
        metadata: { type: 'order', order_id: orderId, customer_id: customer.id },
        success_url: `${successUrl}?payment=success&order=${orderId}`,
        cancel_url: cancelUrl,
      })

    } else if (type === 'subscription') {
      const { data: plan } = await db.from('subscription_plans')
        .select('id, name, stripe_price_id, price_monthly, is_active')
        .eq('id', planId)
        .single()
      if (!plan) throw new Error('Plan not found')

      // Session 157 — SERVER-SIDE SUBSCRIPTION GATE.
      // A subscription checkout may ONLY be created for a plan explicitly marked
      // is_active. The customer-app's SUBSCRIPTIONS_ENABLED flag is a UI toggle,
      // NOT a security boundary — a cached/old app build or a direct API call
      // bypasses it entirely. This is the authoritative gate. Ashley Thompson +
      // Sandeep Vadivel were each charged $260/mo on the still-in-development
      // 'Wash & Fold Monthly' plan because this check did not exist and the plan
      // was left is_active=true. To launch subscriptions: set the plan
      // is_active=true AND flip SUBSCRIPTIONS_ENABLED=true in the customer app.
      if (!plan.is_active) {
        return new Response(JSON.stringify({ error: 'This subscription plan is not currently available.' }), {
          status: 403,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      // Session 168 — soft-launch allowlist gate (see note at top). While the
      // allowlist is non-empty, only those emails may create a subscription
      // checkout, even though the plan is active for the soft-launch window.
      if (!emailAllowed(customer.email_cache)) {
        return new Response(JSON.stringify({ error: 'Subscriptions aren’t available for your account yet.', code: 'not_allowlisted' }), {
          status: 403,
          headers: { ...cors, 'Content-Type': 'application/json' },
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

      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { type: 'subscription', plan_id: planId, customer_id: customer.id },
        success_url: `${successUrl}?payment=success&plan=${planId}`,
        cancel_url: cancelUrl,
      })

    } else if (type === 'setup') {
      // successUrl for admin-initiated: point to customer app
      const resolvedSuccessUrl = successUrl || 'https://washroute.vercel.app/customer-app/?payment=success&setup=true'
      const resolvedCancelUrl  = cancelUrl  || 'https://washroute.vercel.app/customer-app/'

      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        mode: 'setup',
        payment_method_types: ['card'],
        metadata: { type: 'setup', customer_id: customer.id },
        success_url: `${resolvedSuccessUrl}${resolvedSuccessUrl.includes('?') ? '&' : '?'}setup=true`,
        cancel_url: resolvedCancelUrl,
      })

    } else {
      throw new Error('Invalid type: must be order, subscription, or setup')
    }

    return new Response(JSON.stringify({ url: session.url, customer_id: customer.id, email: customer.email_cache }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('create-checkout error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
