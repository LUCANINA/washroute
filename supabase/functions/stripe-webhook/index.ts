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

  // v29: Helper to map Stripe subscription status to our DB status
  function mapStripeStatus(sub: Stripe.Subscription): string {
    if (sub.pause_collection) {
      return 'paused'
    }
    if (sub.status === 'active') return 'active'
    if (sub.status === 'past_due') return 'past_due'
    if (sub.status === 'canceled') return 'cancelled'
    if (sub.status === 'incomplete') return 'incomplete'
    return sub.status as string
  }

  // v29: Helper to get stripe_customer_id from subscription customer field
  function getStripeCustomerId(customer: Stripe.Subscription['customer']): string {
    return typeof customer === 'string' ? customer : (customer as any)?.id
  }

  // v33: Helper — build dunning email HTML
  function buildDunningEmailHtml(name: string, type: 'initial' | 'reminder' | 'final', daysLeft: number): string {
    const appUrl = 'https://app.familylaundry.com/#account'
    const accent = '#3B82F6'
    let headline = ''
    let message = ''

    if (type === 'initial') {
      headline = 'Your subscription payment didn\u2019t go through'
      message = `
        <p>Hi ${name},</p>
        <p>We weren\u2019t able to process your Family Laundry subscription payment. This can happen when a card expires or your bank declines the charge.</p>
        <p><strong>Your service is still active</strong> \u2014 we\u2019ll keep your pickups running while you get this sorted. You have <strong>${daysLeft} days</strong> to update your payment method before your subscription is cancelled.</p>
        <p style="margin:24px 0"><a href="${appUrl}" style="background:${accent};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Update Payment Method</a></p>
        <p>If you have any questions, just reply to this email or text us at (510) 588-4102.</p>`
    } else if (type === 'reminder') {
      headline = 'Reminder: Please update your payment method'
      message = `
        <p>Hi ${name},</p>
        <p>Just a friendly reminder \u2014 your Family Laundry subscription payment is still pending. You have about <strong>${daysLeft} days left</strong> to update your card before your subscription is cancelled.</p>
        <p style="margin:24px 0"><a href="${appUrl}" style="background:${accent};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Update Payment Method</a></p>
        <p>We\u2019d hate to see you go \u2014 questions? Just reply here or text us.</p>`
    } else {
      headline = 'Final notice: Your subscription is about to be cancelled'
      message = `
        <p>Hi ${name},</p>
        <p>This is your final reminder. Your Family Laundry subscription will be <strong>cancelled automatically</strong> very soon unless your payment is resolved.</p>
        <p style="margin:24px 0"><a href="${appUrl}" style="background:#EF4444;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Update Payment Method Now</a></p>
        <p>If you\u2019ve already updated your card, you can ignore this \u2014 we\u2019ll retry the charge shortly.</p>`
    }

    return `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;line-height:1.6">
      <div style="background:${accent};padding:20px 24px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;font-size:20px;margin:0">Family Laundry</h1>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
        <h2 style="font-size:18px;margin:0 0 16px">${headline}</h2>
        ${message}
        <p style="color:#666;font-size:13px;margin-top:24px">\u2014 The Family Laundry Team</p>
      </div>
    </div>`
  }

  // v33: Helper — build recovery email HTML
  function buildRecoveryEmailHtml(name: string): string {
    const accent = '#3B82F6'
    return `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;line-height:1.6">
      <div style="background:${accent};padding:20px 24px;border-radius:12px 12px 0 0">
        <h1 style="color:#fff;font-size:20px;margin:0">Family Laundry</h1>
      </div>
      <div style="padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 12px 12px">
        <h2 style="font-size:18px;margin:0 0 16px">\u2705 Your subscription payment went through!</h2>
        <p>Hi ${name},</p>
        <p>Great news \u2014 your payment was successfully processed and your subscription is back to normal. No action needed on your end.</p>
        <p>Thanks for sticking with us!</p>
        <p style="color:#666;font-size:13px;margin-top:24px">\u2014 The Family Laundry Team</p>
      </div>
    </div>`
  }

  // v33: Helper — send dunning or recovery notification (email + SMS)
  async function sendDunningNotification(
    customerId: string,
    type: 'initial' | 'reminder' | 'final' | 'recovered'
  ) {
    const { data: customer } = await db.from('customers')
      .select('id, first_name, email, phone, sms_consent_at, sms_marketing_opt_out_at')
      .eq('id', customerId)
      .single()
    if (!customer) { console.warn('sendDunningNotification: customer not found:', customerId); return }

    const name = customer.first_name || 'there'
    const appUrl = 'https://app.familylaundry.com/#account'

    // Build SMS body
    let smsBody: string
    let emailSubject: string
    let emailHtml: string

    switch (type) {
      case 'initial':
        smsBody = `Hi ${name}, your Family Laundry subscription payment didn\u2019t go through. Please update your card at ${appUrl} within 7 days to keep your plan active. Questions? Reply to this text.`
        emailSubject = 'Action needed: Your subscription payment failed'
        emailHtml = buildDunningEmailHtml(name, 'initial', 7)
        break
      case 'reminder':
        smsBody = `Reminder: Your Family Laundry subscription payment is still pending. Update your card at ${appUrl} to avoid cancellation.`
        emailSubject = 'Reminder: Please update your payment method'
        emailHtml = buildDunningEmailHtml(name, 'reminder', 3)
        break
      case 'final':
        smsBody = `Final notice: Your Family Laundry subscription will be cancelled soon unless payment is resolved. Update your card: ${appUrl}`
        emailSubject = 'Final notice: Your subscription is about to be cancelled'
        emailHtml = buildDunningEmailHtml(name, 'final', 1)
        break
      case 'recovered':
        smsBody = `Great news! Your Family Laundry subscription payment went through. You\u2019re all set \u2014 no action needed.`
        emailSubject = 'Your subscription payment was successful!'
        emailHtml = buildRecoveryEmailHtml(name)
        break
    }

    // Send SMS if customer has phone + SMS consent
    // Note: dunning messages are TRANSACTIONAL (billing/account), not marketing.
    // They require sms_consent_at but bypass sms_marketing_opt_out_at per A2P 10DLC rules.
    const canSms = customer.phone && customer.sms_consent_at
    if (canSms) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
          body: JSON.stringify({ to: customer.phone, body: smsBody, customer_id: customerId }),
        })
        console.log(`Dunning SMS (${type}) sent to:`, customerId)
      } catch (e: any) { console.error('Dunning SMS failed:', e.message) }
    }

    // Send email if customer has email
    if (customer.email) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
          body: JSON.stringify({ customer_id: customerId, to_email: customer.email, subject: emailSubject, body: emailHtml }),
        })
        console.log(`Dunning email (${type}) sent to:`, customerId)
      } catch (e: any) { console.error('Dunning email failed:', e.message) }
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

    // v29: -- customer.subscription.created -- initialize subscription row
    if (event.type === 'customer.subscription.created') {
      const sub = event.data.object as Stripe.Subscription
      const stripeCustomerId = getStripeCustomerId(sub.customer)

      // Get the first item's price to find plan_id
      const firstItem = sub.items.data[0]
      const stripePriceId = firstItem?.price?.id

      let plan: any = null
      let customer: any = null

      if (!stripePriceId) {
        console.log('customer.subscription.created: no items or price, skipping:', sub.id)
      } else {
        // Look up which plan this price belongs to
        const planRes = await db.from('subscription_plans')
          .select('id')
          .eq('stripe_price_id', stripePriceId)
          .single()
        plan = planRes.data
        if (!plan) {
          console.warn('customer.subscription.created: plan not found for price:', stripePriceId)
        }
      }

      if (plan) {
        // Look up the customer by stripe_customer_id
        const custRes = await db.from('customers')
          .select('id')
          .eq('stripe_customer_id', stripeCustomerId)
          .single()
        customer = custRes.data
        if (!customer) {
          console.warn('customer.subscription.created: customer not found for stripe_customer_id:', stripeCustomerId)
        }
      }

      if (plan && customer) {
        const now = new Date().toISOString()
        const subStatus = mapStripeStatus(sub)

        // UPSERT on stripe_subscription_id to handle retries
        const { error: upsertErr } = await db.from('subscriptions')
          .upsert({
            customer_id: customer.id,
            plan_id: plan.id,
            stripe_subscription_id: sub.id,
            status: subStatus,
            current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
            current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
            signup_date: now,
            last_stripe_event_at: now,
            updated_at: now,
          }, {
            onConflict: 'stripe_subscription_id',
          })

        if (upsertErr) {
          console.error('customer.subscription.created upsert error:', upsertErr.message)
        } else {
          console.log('Subscription created:', sub.id, 'for customer:', customer.id, 'plan:', plan.id)
        }
      }
    }

    // v29: -- customer.subscription.updated -- sync status and dates
    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object as Stripe.Subscription
      const now = new Date().toISOString()
      const subStatus = mapStripeStatus(sub)

      const { error: updateErr } = await db.from('subscriptions')
        .update({
          status: subStatus,
          current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
          current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
          cancel_at_period_end: sub.cancel_at_period_end || false,
          last_stripe_event_at: now,
          updated_at: now,
        })
        .eq('stripe_subscription_id', sub.id)

      if (updateErr) {
        console.error('customer.subscription.updated error:', updateErr.message)
      } else {
        console.log('Subscription updated:', sub.id, 'status:', subStatus)
      }
    }

    // v29+v31: -- customer.subscription.deleted -- mark cancelled + bill outstanding overage
    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object as Stripe.Subscription
      const stripeCustomerId = getStripeCustomerId(sub.customer)
      const now = new Date().toISOString()

      // v31 (session 118): Bill outstanding overage before marking cancelled
      // When a subscriber cancels mid-cycle, there's no next renewal invoice to attach
      // the overage to. Create a standalone invoice for the remaining amount.
      const { data: localSub } = await db.from('subscriptions')
        .select('id, overage_amount_due')
        .eq('stripe_subscription_id', sub.id)
        .single()

      if (localSub && Number(localSub.overage_amount_due) > 0) {
        // v32: Race-condition guard — atomically zero the overage so that if
        // invoice.created fires at the same time, only ONE handler bills it.
        const overageAmount = Number(localSub.overage_amount_due)
        const { data: claimResult } = await db.from('subscriptions')
          .update({ overage_amount_due: 0, updated_at: now })
          .eq('id', localSub.id)
          .gt('overage_amount_due', 0)  // only succeeds if still > 0
          .select('id')

        if (claimResult && claimResult.length > 0) {
          const overageCents = Math.round(overageAmount * 100)
          try {
            // Create an invoice item on the customer (not attached to a specific invoice)
            const invoiceItem = await stripe.invoiceItems.create({
              customer: stripeCustomerId,
              amount: overageCents,
              currency: 'usd',
              description: `Final overage: $${overageAmount.toFixed(2)} (subscription cancelled)`,
              metadata: {
                washroute_overage: 'true',
                washroute_subscription_id: localSub.id,
                washroute_final_overage: 'true',
              },
            }, {
              idempotencyKey: `final-overage-${localSub.id}-${sub.id}`,
            })

            // v32: Create invoice with only THIS item to avoid sweeping other pending items,
            // and add idempotency key to prevent duplicate invoices on retries.
            const finalInvoice = await stripe.invoices.create({
              customer: stripeCustomerId,
              pending_invoice_items_behavior: 'exclude',  // don't sweep other pending items
              auto_advance: true,  // auto-finalize and attempt payment
              collection_method: 'charge_automatically',
              description: 'Final overage charge — Family Laundry subscription',
              metadata: {
                washroute_final_overage: 'true',
                washroute_subscription_id: localSub.id,
              },
            }, {
              idempotencyKey: `final-overage-inv-${localSub.id}-${sub.id}`,
            })

            // Manually attach the invoice item to the invoice
            // (since we excluded pending items from auto-sweep)
            await stripe.invoiceItems.update(invoiceItem.id, {
              invoice: finalInvoice.id,
            })

            await db.from('subscription_usage_log').insert({
              subscription_id: localSub.id,
              event_type: 'final_overage_invoiced',
              note: `$${overageAmount.toFixed(2)} final overage invoiced on cancellation (invoice ${finalInvoice.id})`,
            })

            console.log('Final overage invoice created:', finalInvoice.id, 'amount:', overageAmount, 'sub:', localSub.id)
          } catch (e: any) {
            console.error('Failed to create final overage invoice:', e.message)
            // Restore overage so Audit Check #15 can catch it
            await db.from('subscriptions').update({
              overage_amount_due: overageAmount,
              updated_at: now,
            }).eq('id', localSub.id)
          }
        } else {
          console.log('Final overage: another handler already claimed the overage for sub:', localSub.id)
        }
      }

      // Clear subscription_plan_id from customers (existing logic)
      await db.from('customers').update({
        subscription_plan_id: null,
        updated_at: now,
      }).eq('stripe_customer_id', stripeCustomerId)

      // v29: Also mark subscription as cancelled + clear dunning
      const { error: updateErr } = await db.from('subscriptions')
        .update({
          status: 'cancelled',
          cancelled_at: now,
          dunning_started_at: null,
          last_stripe_event_at: now,
          updated_at: now,
        })
        .eq('stripe_subscription_id', sub.id)

      if (updateErr) {
        console.error('customer.subscription.deleted subscriptions update error:', updateErr.message)
      }

      console.log('Subscription deleted:', sub.id, 'for Stripe customer:', stripeCustomerId)
    }

    // v29+v33: -- invoice.payment_succeeded -- recover from past_due + clear dunning + notify
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = invoice.subscription

      if (subscriptionId) {
        const now = new Date().toISOString()

        // Check if this subscription was in dunning (past_due) before recovery
        const { data: localSub } = await db.from('subscriptions')
          .select('id, customer_id, dunning_started_at, status')
          .eq('stripe_subscription_id', subscriptionId as string)
          .single()

        const wasDunning = localSub?.dunning_started_at != null

        // Update status to active + clear dunning
        const { error: updateErr } = await db.from('subscriptions')
          .update({
            status: 'active',
            dunning_started_at: null,
            last_stripe_event_at: now,
            updated_at: now,
          })
          .eq('stripe_subscription_id', subscriptionId as string)

        if (updateErr) {
          console.error('invoice.payment_succeeded error:', updateErr.message)
        } else {
          console.log('Invoice payment succeeded, subscription recovered:', subscriptionId)
        }

        // v33: If was dunning, remove dunning-set cancel_at from Stripe and send recovery notification
        if (wasDunning && localSub) {
          // Only clear cancel_at if it was set by dunning (not a voluntary cancel).
          // Check: if cancel_at_period_end is true, that's a voluntary cancel — leave it.
          try {
            const stripeSub = await stripe.subscriptions.retrieve(subscriptionId as string)
            if (stripeSub.cancel_at && !stripeSub.cancel_at_period_end) {
              await stripe.subscriptions.update(subscriptionId as string, { cancel_at: '' as any })
              console.log('Cleared dunning cancel_at on recovered subscription:', subscriptionId)
            }
          } catch (e: any) {
            console.error('Failed to clear cancel_at:', e.message)
          }

          // Send recovery notification
          await sendDunningNotification(localSub.customer_id, 'recovered')
          console.log('Recovery notification sent for subscription:', localSub.id)
        }
      }
    }

    // v29+v33: -- invoice.payment_failed -- set past_due + dunning notifications + grace period
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = invoice.subscription
      const stripeCustomerId = typeof invoice.customer === 'string'
        ? invoice.customer
        : (invoice.customer as any)?.id

      if (subscriptionId) {
        const now = new Date().toISOString()

        // Get the local subscription to check dunning state
        const { data: localSub } = await db.from('subscriptions')
          .select('id, customer_id, dunning_started_at, status')
          .eq('stripe_subscription_id', subscriptionId as string)
          .single()

        // Update status to past_due — but NOT if already cancelled (race guard)
        if (!localSub || localSub.status !== 'cancelled') {
          const { error: updateErr } = await db.from('subscriptions')
            .update({
              status: 'past_due',
              last_stripe_event_at: now,
              updated_at: now,
            })
            .eq('stripe_subscription_id', subscriptionId as string)
            .neq('status', 'cancelled')  // double safety: don't overwrite cancelled

          if (updateErr) {
            console.error('invoice.payment_failed subscriptions update error:', updateErr.message)
          }
        }

        // v33: Dunning flow — skip if subscription is already cancelled (race guard)
        if (localSub && localSub.status !== 'cancelled') {
          if (!localSub.dunning_started_at) {
            // First failure — start grace period
            await db.from('subscriptions')
              .update({ dunning_started_at: now, updated_at: now })
              .eq('id', localSub.id)

            // Set Stripe to auto-cancel in 7 days, but only if customer hasn't
            // already scheduled a voluntary cancel (cancel_at_period_end).
            // Don't override their voluntary cancel timing.
            try {
              const stripeSub = await stripe.subscriptions.retrieve(subscriptionId as string)
              if (!stripeSub.cancel_at_period_end && !stripeSub.cancel_at) {
                const cancelAt = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60)
                await stripe.subscriptions.update(subscriptionId as string, { cancel_at: cancelAt })
                console.log('Grace period set: cancel_at', new Date(cancelAt * 1000).toISOString(), 'for sub:', subscriptionId)
              } else {
                console.log('Skipped setting cancel_at — voluntary cancel already pending for sub:', subscriptionId)
              }
            } catch (e: any) {
              console.error('Failed to set cancel_at on Stripe subscription:', e.message)
            }

            // Send initial dunning notification
            await sendDunningNotification(localSub.customer_id, 'initial')
            console.log('Dunning started for subscription:', localSub.id)

          } else {
            // Subsequent failure — calculate days since dunning started and escalate
            const daysSinceDunning = Math.floor(
              (Date.now() - new Date(localSub.dunning_started_at).getTime()) / (1000 * 60 * 60 * 24)
            )

            if (daysSinceDunning >= 5) {
              await sendDunningNotification(localSub.customer_id, 'final')
              console.log('Final dunning notice sent, days since start:', daysSinceDunning, 'sub:', localSub.id)
            } else if (daysSinceDunning >= 2) {
              await sendDunningNotification(localSub.customer_id, 'reminder')
              console.log('Dunning reminder sent, days since start:', daysSinceDunning, 'sub:', localSub.id)
            } else {
              console.log('Dunning retry too soon for notification, days:', daysSinceDunning, 'sub:', localSub.id)
            }
          }
        } else if (localSub?.status === 'cancelled') {
          console.log('Skipped dunning — subscription already cancelled:', localSub.id)
        }
      }

      console.log('Payment failed for Stripe customer:', stripeCustomerId, 'subscription:', subscriptionId)
    }

    // v30 (session 115): -- invoice.created -- attach overage to draft renewal invoice
    if (event.type === 'invoice.created') {
      const invoice = event.data.object as Stripe.Invoice
      const subscriptionId = typeof invoice.subscription === 'string'
        ? invoice.subscription
        : (invoice.subscription as any)?.id

      // Only act on draft invoices tied to a subscription
      if (subscriptionId && invoice.status === 'draft') {
        const { data: sub } = await db.from('subscriptions')
          .select('id, overage_amount_due, stripe_subscription_id')
          .eq('stripe_subscription_id', subscriptionId)
          .single()

        if (sub && Number(sub.overage_amount_due) > 0) {
          const overageAmount = Number(sub.overage_amount_due)
          const stripeCustomerId = typeof invoice.customer === 'string'
            ? invoice.customer
            : (invoice.customer as any)?.id

          // v32: Race-condition guard — atomically zero the overage first
          const { data: claimResult } = await db.from('subscriptions')
            .update({ overage_amount_due: 0, updated_at: new Date().toISOString() })
            .eq('id', sub.id)
            .gt('overage_amount_due', 0)
            .select('id')

          if (claimResult && claimResult.length > 0) {
            const overageCents = Math.round(overageAmount * 100)
            try {
              await stripe.invoiceItems.create({
                customer: stripeCustomerId,
                invoice: invoice.id,
                amount: overageCents,
                currency: 'usd',
                description: `Overage: $${overageAmount.toFixed(2)}`,
                metadata: {
                  washroute_overage: 'true',
                  washroute_subscription_id: sub.id,
                },
              }, {
                idempotencyKey: `overage-${sub.id}-${invoice.id}`,
              })

              await db.from('subscription_usage_log').insert({
                subscription_id: sub.id,
                event_type: 'overage_invoiced',
                note: `$${overageAmount.toFixed(2)} overage attached to invoice ${invoice.id}`,
              })

              console.log('Overage attached to draft invoice:', invoice.id, 'amount:', overageAmount, 'sub:', sub.id)
            } catch (e: any) {
              console.error('Failed to attach overage to invoice:', e.message)
              // Restore overage so another handler or audit can catch it
              await db.from('subscriptions').update({
                overage_amount_due: overageAmount,
                updated_at: new Date().toISOString(),
              }).eq('id', sub.id)
            }
          } else {
            console.log('Overage already claimed by another handler for sub:', sub.id)
          }
        }
      }
    }

  } catch (err) {
    console.error('Webhook handler error:', err)
    return new Response(JSON.stringify({ error: 'Handler error' }), { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
