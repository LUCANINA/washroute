import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"

/* ──────────────────────────────────────────────────────────────
   stripe-terminal  —  Stripe Terminal helpers for POS
   ──────────────────────────────────────────────────────────────
   POST /stripe-terminal
   Body: { "action": "connection_token" | "create_payment" | "cancel_payment"
                   | "charge_reader"    | "get_payment"    | "cancel_reader_action" }

   • connection_token       — returns { secret } for the Terminal JS SDK
   • create_payment         — creates a PaymentIntent for the reader
       body: { action, amount_cents, description?, metadata? }
   • cancel_payment         — cancels a PaymentIntent by id
       body: { action, payment_intent_id }
   • charge_reader          — SERVER-DRIVEN: creates PI + pushes it to the reader in one call
       body: { action, amount_cents, reader_id, description?, metadata? }
       returns: { payment_intent_id, reader_action_id }
   • get_payment            — returns current PI status so the POS can poll
       body: { action, payment_intent_id }
       returns: { id, status, amount, last_payment_error }
   • cancel_reader_action   — dismisses an in-progress prompt on the reader
       body: { action, reader_id }
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

    /* ── 4. Server-driven: create PI and push it straight to the reader ─ */
    if (action === 'charge_reader') {
      const { amount_cents, reader_id, description, metadata } = body

      if (!amount_cents || amount_cents < 50) {
        return json({ error: 'amount_cents must be at least 50 ($0.50)' }, 400)
      }
      if (!reader_id) {
        return json({ error: 'reader_id is required' }, 400)
      }

      // Create PaymentIntent
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount_cents),
        currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: description || 'WashRoute POS sale',
        metadata: metadata || {},
      })

      // Push it to the reader (server-driven — no client SDK needed).
      // The reader displays the amount and waits for the customer to tap / dip / swipe.
      const reader = await stripe.terminal.readers.processPaymentIntent(reader_id, {
        payment_intent: pi.id,
      })

      console.log(`[stripe-terminal] Charge pushed to reader ${reader_id}: PI ${pi.id} for $${(pi.amount / 100).toFixed(2)}`)
      return json({
        payment_intent_id: pi.id,
        reader_action_id:  reader.action?.id || null,
        reader_status:     reader.status || null,
      })
    }

    /* ── 5. Poll PaymentIntent status ─────────────────────────── */
    if (action === 'get_payment') {
      const { payment_intent_id } = body
      if (!payment_intent_id) {
        return json({ error: 'payment_intent_id is required' }, 400)
      }
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id)
      return json({
        id:     pi.id,
        status: pi.status,
        amount: pi.amount,
        last_payment_error: pi.last_payment_error?.message || null,
      })
    }

    /* ── 6. Cancel whatever the reader is currently doing ───── */
    if (action === 'cancel_reader_action') {
      const { reader_id } = body
      if (!reader_id) {
        return json({ error: 'reader_id is required' }, 400)
      }
      const reader = await stripe.terminal.readers.cancelAction(reader_id)
      console.log(`[stripe-terminal] Reader action cancelled on ${reader_id}`)
      return json({ reader_status: reader.status })
    }

    return json({ error: `Unknown action: ${action}` }, 400)

  } catch (err) {
    console.error('[stripe-terminal] Error:', err.message)
    return json({ error: err.message }, 500)
  }
})
