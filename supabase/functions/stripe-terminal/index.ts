import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"

/* ──────────────────────────────────────────────────────────────
   stripe-terminal  —  Stripe Terminal helpers for POS
   ──────────────────────────────────────────────────────────────
   POST /stripe-terminal
   Body: { "action": "connection_token" | "create_payment" | "cancel_payment" }

   • connection_token  — returns { secret } for the Terminal JS SDK
   • create_payment    — creates a PaymentIntent for the reader
       body: { action, amount_cents, description?, metadata? }
   • cancel_payment    — cancels a PaymentIntent by id
       body: { action, payment_intent_id }
   ────────────────────────────────────────────────────────────── */

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS })
  }

  try {
    const body = await req.json()
    const { action } = body

    /* ── 1. Connection token ─────────────────────────────────── */
    if (action === 'connection_token') {
      // The Terminal JS SDK calls this to authenticate with Stripe
      // and communicate with the reader over the internet.
      const token = await stripe.terminal.connectionTokens.create()
      console.log('[stripe-terminal] connection_token issued')
      return json({ secret: token.secret })
    }

    /* ── 2. Create PaymentIntent for Terminal ─────────────────── */
    if (action === 'create_payment') {
      const { amount_cents, description, metadata } = body

      if (!amount_cents || amount_cents < 50) {
        return json({ error: 'amount_cents must be at least 50 ($0.50)' }, 400)
      }

      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount_cents),
        currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: description || 'WashRoute POS sale',
        metadata: metadata || {},
      })

      console.log(`[stripe-terminal] PaymentIntent created: ${pi.id} for $${(pi.amount / 100).toFixed(2)}`)
      return json({
        client_secret: pi.client_secret,
        payment_intent_id: pi.id,
      })
    }

    /* ── 3. Cancel a PaymentIntent ────────────────────────────── */
    if (action === 'cancel_payment') {
      const { payment_intent_id } = body
      if (!payment_intent_id) {
        return json({ error: 'payment_intent_id is required' }, 400)
      }

      const cancelled = await stripe.paymentIntents.cancel(payment_intent_id)
      console.log(`[stripe-terminal] PaymentIntent cancelled: ${cancelled.id}`)
      return json({ status: cancelled.status })
    }

    return json({ error: `Unknown action: ${action}` }, 400)

  } catch (err) {
    console.error('[stripe-terminal] Error:', err.message)
    return json({ error: err.message }, 500)
  }
})
