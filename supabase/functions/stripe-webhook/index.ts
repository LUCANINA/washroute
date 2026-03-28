import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const body = await req.text()
  const sig = req.headers.get('stripe-signature')

  // ── Diagnostic logging (v26): log event type + account before signature check ──
  try {
    const preview = JSON.parse(body)
    console.log('Stripe webhook received:', preview.type, '| account:', preview.account || 'direct', '| livemode:', preview.livemode)
  } catch (_) {
    console.warn('Stripe webhook: could not parse body for diagnostics')
  }

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, webhookSecret)
  } catch (err) {
    console.error('Webhook signature error:', err.message, '| sig prefix:', sig?.slice(0, 30))
    return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400 })
  }

  const db = createClient(supabaseUrl, supabaseServiceKey)

  // Helper: save/update a card in customer_payment_methods
  async function saveCardToTable(customerId: string, pmId: string, card: Stripe.PaymentMethod.Card, isDefault: boolean) {
    // Count existing cards for this customer to know if this is the first
    const { count } = await db
      .from('customer_payment_methods')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .neq('stripe_payment_method_id', pmId)

    const actuallyDefault = isDefault || (count === 0)

    await db.from('customer_payment_methods').upsert({
      customer_id: customerId,
      stripe_payment_method_id: pmId,
      card_brand: card.brand,
      card_last4: card.last4,
      card_exp_month: card.exp_month,
      card_exp_year: card.exp_year,
      is_default: actuallyDefault,
    }, { onConflict: 'stripe_payment_method_id' })

    // Mirror default card on customers flat columns
    if (actuallyDefault) {
      await db.from('customers').update({
        stripe_default_payment_method_id: pmId,
        card_last4: card.last4,
        card_brand: card.brand,
        card_exp_month: card.exp_month,
        card_exp_year: card.exp_year,
        updated_at: new Date().toISOString(),
      }).eq('id', customerId)
    }

    // Return whether this was the customer's first card (for promo credit)
    return count === 0
  }

  // Helper: grant $20 welcome/migration credit if eligible
  async function grantMigrationCredit(customerId: string) {
    const { data: cust } = await db.from('customers')
      .select('credits, credit_expires_at')
      .eq('id', customerId)
      .single()

    if (!cust) return
    const currentCredits = parseFloat(cust.credits || 0)
    if (cust.credit_expires_at || currentCredits > 0) {
      console.log('Migration credit skipped -- already has credits or expiry set:', customerId)
      return
    }

    const { error } = await db.from('customers').update({
      credits: 20,
      credit_expires_at: '2026-03-27T23:59:59-07:00',
      updated_at: new Date().toISOString(),
    }).eq('id', customerId)

    if (error) {
      console.error('Failed to grant migration credit:', error)
    } else {
      console.log('Granted $20 migration credit to customer:', customerId)
    }
  }

  try {
    // -- payment_intent.succeeded -- backup: mark order as paid if charge-order missed it --
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent
      const orderId = pi.metadata?.order_id
      if (orderId) {
        // Only update if billing_status isn't already set (don't overwrite)
        const { data: order } = await db.from('orders')
          .select('id, billing_status')
          .eq('id', orderId)
          .single()

        if (order && order.billing_status !== 'paid') {
          await db.from('orders').update({
            stripe_payment_intent_id: pi.id,
            billing_status: 'paid',
            billed_at: new Date().toISOString(),
            charge_failed_at: null,
            updated_at: new Date().toISOString(),
          }).eq('id', orderId)
          console.log('Webhook backup: marked order as paid:', orderId, pi.id)
        }
      }
    }

    // -- payment_intent.payment_failed -- backup: mark order as failed --
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent
      const orderId = pi.metadata?.order_id
      if (orderId) {
        const { data: order } = await db.from('orders')
          .select('id, billing_status')
          .eq('id', orderId)
          .single()

        if (order && order.billing_status !== 'paid') {
          await db.from('orders').update({
            billing_status: 'failed',
            charge_failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', orderId)
          console.log('Webhook backup: marked order as failed:', orderId)
        }
      }
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const { type, order_id, plan_id, customer_id } = session.metadata || {}

      if (type === 'order' && order_id) {
        const paymentIntentId = typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent as any)?.id

        await db.from('orders').update({
          stripe_payment_intent_id: paymentIntentId,
          status: 'processing',
          updated_at: new Date().toISOString(),
        }).eq('id', order_id)

        console.log('Order paid, moved to processing:', order_id)
      }

      if (type === 'subscription' && plan_id && customer_id) {
        const stripeCustomerId = typeof session.customer === 'string'
          ? session.customer
          : (session.customer as any)?.id

        await db.from('customers').update({
          subscription_plan_id: plan_id,
          stripe_customer_id: stripeCustomerId,
          updated_at: new Date().toISOString(),
        }).eq('id', customer_id)

        console.log('Subscription activated for customer:', customer_id)
      }

      if (type === 'setup' && customer_id) {
        const setupIntentId = typeof session.setup_intent === 'string'
          ? session.setup_intent
          : (session.setup_intent as any)?.id

        if (setupIntentId) {
          const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
          const pmId = typeof setupIntent.payment_method === 'string'
            ? setupIntent.payment_method
            : (setupIntent.payment_method as any)?.id

          if (pmId) {
            const pm = await stripe.paymentMethods.retrieve(pmId)
            const card = pm.card!

            const stripeCustomerId = typeof session.customer === 'string'
              ? session.customer
              : (session.customer as any)?.id

            if (stripeCustomerId) {
              await stripe.customers.update(stripeCustomerId, {
                invoice_settings: { default_payment_method: pmId },
              })

              // BACKUP: ensure stripe_customer_id is saved on the customer record.
              // create-checkout sets this before redirect, but the save can fail silently.
              // This is the safety net that ensures it's always persisted.
              const { error: scErr } = await db.from('customers').update({
                stripe_customer_id: stripeCustomerId,
                updated_at: new Date().toISOString(),
              }).eq('id', customer_id)
              if (scErr) console.error('Failed to save stripe_customer_id backup:', scErr.message)
              else console.log('stripe_customer_id ensured for customer:', customer_id, stripeCustomerId)
            }

            const isFirstCard = await saveCardToTable(customer_id, pmId, card, true)
            console.log('Card saved via Checkout for customer:', customer_id, card.brand, card.last4)

            if (isFirstCard) {
              await grantMigrationCredit(customer_id)
            }
          }
        }
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      const stripeCustomerId = typeof sub.customer === 'string'
        ? sub.customer
        : (sub.customer as any)?.id

      await db.from('customers').update({
        subscription_plan_id: null,
        updated_at: new Date().toISOString(),
      }).eq('stripe_customer_id', stripeCustomerId)

      console.log('Subscription cancelled for Stripe customer:', stripeCustomerId)
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice
      const stripeCustomerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : (invoice.customer as any)?.id
      console.log('Payment failed for Stripe customer:', stripeCustomerId)
    }

  } catch (err) {
    console.error('Webhook handler error:', err)
    return new Response(JSON.stringify({ error: 'Handler error' }), { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
