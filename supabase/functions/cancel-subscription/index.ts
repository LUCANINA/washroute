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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, supabaseServiceKey)
    const { subscription_id } = await req.json()

    if (!subscription_id) throw new Error('subscription_id is required')

    // Load subscription to verify it exists and get stripe_subscription_id
    const { data: sub, error: subErr } = await db.from('subscriptions')
      .select('id, stripe_subscription_id, customer_id')
      .eq('id', subscription_id)
      .single()

    if (subErr || !sub) throw new Error('Subscription not found')
    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription ID on record')

    // Call Stripe to set cancel at period end (graceful cancellation)
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    })

    // Update DB: mark cancel_at_period_end flag
    // Don't set cancelled_at yet — that happens when the actual customer.subscription.deleted event fires
    const now = new Date().toISOString()
    await db.from('subscriptions').update({
      cancel_at_period_end: true,
      updated_at: now,
    }).eq('id', subscription_id)

    console.log('Subscription marked for cancellation at period end:', subscription_id, sub.stripe_subscription_id)

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscription will be cancelled at the end of your current billing period',
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('cancel-subscription error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
