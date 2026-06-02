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

// Fire-and-forget notification via send-order-notification edge function
function notifyCustomer(orderId: string, event: string) {
  fetch(`${supabaseUrl}/functions/v1/send-order-notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({ orderId, event }),
  }).catch(e => console.warn(`notification ${event} failed:`, e.message));
}

// Helper: stamp charge_failed_at on an order so the admin UI shows the correct button
async function stampChargeFailed(db: any, orderId: string) {
  await db.from('orders').update({
    billing_status: 'failed',
    charge_failed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', orderId);
}

// Compute the team tip in dollars from tip_amount + tip_type.
// tip_type='pct' means tip_amount is a percentage of total_amount.
// tip_type='dollar' (or legacy null) means tip_amount is already in dollars.
// Rounded to cents.
function computeTipDollars(totalAmount: number, tipAmount: number | null, tipType: string | null): number {
  const tip = Number(tipAmount || 0)
  if (tip <= 0) return 0
  if (tipType === 'pct') {
    return Math.round(Number(totalAmount) * tip) / 100
  }
  return Math.round(tip * 100) / 100
}

// Round to cents
const r2 = (n: number) => Math.round(n * 100) / 100

// v30: Statuses where charging is NOT allowed (order hasn't been picked up yet, or is terminal/voided)
// Any status not in this list is chargeable — this fixes the race condition where the dashboard
// calls charge-order before the DB status has been updated to ready_for_delivery.
const NON_CHARGEABLE_STATUSES = ['scheduled', 'on_hold', 'cancelled', 'skipped', 'pickup_failed']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, supabaseServiceKey)
    const { orderId } = await req.json()

    if (!orderId) throw new Error('orderId is required')

    // Load order. v36: subscription handling moved from a hard guard to the
    // bill-split path below — orders covered by a subscription still need to
    // be billed for add-ons + same-day + tip + any lb-overage above the cap.
    const { data: order, error: orderErr } = await db.from('orders')
      .select('id, order_number, total_amount, tip_amount, tip_type, status, stripe_payment_intent_id, customer_id, line_items, subscription_id, services(name)')
      .eq('id', orderId)
      .single()

    if (orderErr || !order) throw new Error('Order not found')
    if (order.stripe_payment_intent_id) throw new Error('Order has already been charged')
    if (!order.total_amount || Number(order.total_amount) <= 0) throw new Error('Order has no amount to charge')

    // v30: Guard — block charging for orders that haven't been picked up or are voided
    if (NON_CHARGEABLE_STATUSES.includes(order.status)) {
      throw new Error(`Order #${order.order_number} cannot be charged in "${order.status}" status`)
    }

    // Load customer (v34: also pull credits balance)
    const { data: customer, error: custErr } = await db.from('customers')
      .select('id, stripe_customer_id, stripe_default_payment_method_id, card_last4, card_brand, lifetime_value, credits')
      .eq('id', order.customer_id)
      .single()

    if (custErr || !customer) {
      await stampChargeFailed(db, orderId);
      notifyCustomer(orderId, 'payment_failed');
      throw new Error('Customer not found')
    }

    // ───────────────────────────────────────────────────────────────────
    // v36 — bill split for subscriber orders.
    // compute_subscription_residual reads the order's line_items + the
    // subscription's plan + current usage, returns:
    //   - absorbed: line items the subscription covers (base + line-item
    //     overage + delivery_fee) — informational, not charged here
    //   - lb_overage_dollars: weight over the plan's monthly cap × $/lb
    //   - addons + same_day + other: card-chargeable line items
    //   - tip_dollars
    //   - card_charge_total: the actual amount to bill the card
    // For non-subscriber orders the RPC returns the full total + tip
    // unchanged, so this code path is uniform.
    // ───────────────────────────────────────────────────────────────────
    const { data: residual, error: residualErr } = await db.rpc(
      'compute_subscription_residual',
      { p_order_id: orderId }
    )
    if (residualErr) {
      await stampChargeFailed(db, orderId);
      notifyCustomer(orderId, 'payment_failed');
      throw new Error('Failed to compute residual: ' + residualErr.message)
    }

    const hasSub        = Boolean(residual?.has_subscription)
    const subAbsorbed   = r2(Number(residual?.absorbed || 0))
    const lbOverageDol  = r2(Number(residual?.lb_overage_dollars || 0))
    const tipDollars    = r2(Number(residual?.tip_dollars || 0))
    const cardChargeTot = r2(Number(residual?.card_charge_total || 0))
    // Non-tip portion of the residual = total - tip. Credits apply only to
    // this portion (tips are driver compensation; never reduced by credits).
    const residualPreTip = r2(cardChargeTot - tipDollars)

    // ── v34: Apply available credits to the PRE-TIP residual ──
    const availableCredits = Math.max(0, Number(customer.credits || 0))
    const creditsApplied   = availableCredits > 0
      ? Math.min(availableCredits, Math.max(0, residualPreTip))
      : 0
    const subtotalAfterCredit = r2(Math.max(0, residualPreTip - creditsApplied))
    const chargeAmount = r2(subtotalAfterCredit + tipDollars)

    // Legacy: credits previously embedded in line_items at Intake (informational only — already deducted)
    const lineItems = Array.isArray(order.line_items) ? order.line_items : []
    const legacyCreditItem = lineItems.find((li: any) => li.type === 'credit')
    const legacyCreditApplied = legacyCreditItem ? Math.abs(Number(legacyCreditItem.amount)) : 0

    // No Stripe call needed when:
    //   - credits cover the full residual AND no tip-only remainder (creditsOnly), OR
    //   - residual is exactly $0 because the subscription absorbs everything (subOnly)
    const subOnly      = hasSub && cardChargeTot <= 0
    const creditsOnly  = !subOnly && chargeAmount <= 0

    let paymentIntent: any = null
    let usedCard: any = null

    if (!subOnly && !creditsOnly) {
      // Need to charge a card for the remainder
      if (!customer.stripe_customer_id) {
        await stampChargeFailed(db, orderId);
        notifyCustomer(orderId, 'payment_failed');
        throw new Error('No Stripe account for this customer')
      }

      // Load all saved cards — default first, then by creation date (newest first)
      const { data: cards, error: cardsErr } = await db
        .from('customer_payment_methods')
        .select('stripe_payment_method_id, card_brand, card_last4, is_default')
        .eq('customer_id', customer.id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false })

      if (cardsErr) {
        await stampChargeFailed(db, orderId);
        notifyCustomer(orderId, 'payment_failed');
        throw new Error('Failed to load cards: ' + cardsErr.message)
      }

      // Fall back to legacy flat columns if new table is empty
      const cardList = (cards && cards.length > 0)
        ? cards
        : customer.stripe_default_payment_method_id
          ? [{ stripe_payment_method_id: customer.stripe_default_payment_method_id, card_brand: customer.card_brand, card_last4: customer.card_last4, is_default: true }]
          : []

      if (cardList.length === 0) {
        await stampChargeFailed(db, orderId);
        notifyCustomer(orderId, 'payment_failed')
        throw new Error('No card on file for this customer')
      }

      const stripeAmountCents = Math.round(chargeAmount * 100)
      const descSuffix = [
        hasSub && subAbsorbed > 0 ? `subscription absorbed $${subAbsorbed.toFixed(2)}` : null,
        hasSub && lbOverageDol > 0 ? `$${lbOverageDol.toFixed(2)} lb overage` : null,
        creditsApplied > 0 ? `$${creditsApplied.toFixed(2)} credit applied` : null,
        tipDollars > 0 ? `incl. $${tipDollars.toFixed(2)} tip` : null,
      ].filter(Boolean).join(', ')
      const description = `Order #${order.order_number} — Family Laundry${descSuffix ? ` (${descSuffix})` : ''}`

      let lastError: any = null
      const failedCards: string[] = []

      // Try each card in order until one succeeds
      for (const card of cardList) {
        try {
          console.log(`Attempting charge of $${chargeAmount.toFixed(2)} (residual $${residualPreTip.toFixed(2)} - credit $${creditsApplied.toFixed(2)} + tip $${tipDollars.toFixed(2)}${hasSub ? `; sub absorbed $${subAbsorbed.toFixed(2)}, lb-overage $${lbOverageDol.toFixed(2)}` : ''}) on ${card.card_brand} •••• ${card.card_last4}`)
          const pi = await stripe.paymentIntents.create({
            amount: stripeAmountCents,
            currency: 'usd',
            customer: customer.stripe_customer_id,
            payment_method: card.stripe_payment_method_id,
            confirm: true,
            off_session: true,
            description,
            metadata: {
              order_id: order.id,
              customer_id: customer.id,
              credit_applied: creditsApplied.toFixed(2),
              tip_amount: tipDollars.toFixed(2),
              tip_type: String(order.tip_type || ''),
              subtotal: residualPreTip.toFixed(2),
              ...(hasSub ? {
                subscription_id: String(residual.subscription_id || ''),
                subscription_absorbed: subAbsorbed.toFixed(2),
                lb_overage: lbOverageDol.toFixed(2),
              } : {}),
            },
          })

          if (pi.status === 'succeeded') {
            paymentIntent = pi
            usedCard = card
            break
          } else {
            lastError = new Error(`Payment status: ${pi.status}`)
            failedCards.push(card.card_last4)
          }
        } catch (e: any) {
          console.warn(`Card ${card.card_last4} failed:`, e.message)
          lastError = e
          failedCards.push(card.card_last4)
        }
      }

      if (!paymentIntent || !usedCard) {
        await stampChargeFailed(db, orderId);
        notifyCustomer(orderId, 'payment_failed')

        const failMsg = failedCards.length > 1
          ? `All ${failedCards.length} cards on file were declined. Last error: ${lastError?.message}`
          : `Card declined: ${lastError?.message}`
        throw new Error(failMsg)
      }
    } else if (subOnly) {
      console.log(`Order #${order.order_number} fully covered by subscription ($${subAbsorbed.toFixed(2)} absorbed). Skipping Stripe.`)
    } else {
      console.log(`Order #${order.order_number} fully covered by credits ($${creditsApplied.toFixed(2)}). Skipping Stripe.`)
    }

    // ── SUCCESS path (Stripe-paid OR credits-only OR subscription-only) ──
    const billingNotesParts: string[] = []
    if (hasSub && subAbsorbed > 0)  billingNotesParts.push(`subscription absorbed $${subAbsorbed.toFixed(2)}`)
    if (hasSub && lbOverageDol > 0) billingNotesParts.push(`$${lbOverageDol.toFixed(2)} lb overage`)
    if (creditsApplied > 0)         billingNotesParts.push(`$${creditsApplied.toFixed(2)} credit applied`)
    const billingNotes = billingNotesParts.length > 0 ? billingNotesParts.join('; ') : null

    const orderUpdate: any = {
      billing_status: 'paid',
      billed_at: new Date().toISOString(),
      charge_failed_at: null,
      updated_at: new Date().toISOString(),
    }
    if (paymentIntent) {
      orderUpdate.stripe_payment_intent_id = paymentIntent.id
      // billing_payment_method records the PRIMARY method that moved money for
      // this order. If we charged the card we record 'credit_card'; the
      // subscription absorbed portion is captured in billing_notes above so
      // receipts + admin can show the split clearly.
      orderUpdate.billing_payment_method = 'credit_card'
    } else if (subOnly) {
      orderUpdate.billing_payment_method = 'subscription'
    } else {
      orderUpdate.billing_payment_method = 'credit'
    }
    if (billingNotes) orderUpdate.billing_notes = billingNotes
    await db.from('orders').update(orderUpdate).eq('id', orderId)

    // ── v34: Deduct applied credits from the customer's balance ──
    if (creditsApplied > 0) {
      const newBalance = r2(availableCredits - creditsApplied)
      await db.from('customers')
        .update({ credits: newBalance, updated_at: new Date().toISOString() })
        .eq('id', customer.id)

      await db.from('customer_transactions').insert({
        customer_id: customer.id,
        type: 'credit_use',
        amount: creditsApplied,
        description: `Applied to order #${order.order_number}`,
        order_id: order.id,
        payment_method: 'credit',
      })
    }

    // Update lifetime_value — only the actual Stripe-charged dollars (credits + subscription absorb don't count as spend)
    if (paymentIntent && chargeAmount > 0) {
      await db.from('customers').update({
        lifetime_value: Number(customer.lifetime_value || 0) + chargeAmount,
      }).eq('id', customer.id)
    }

    // Log charge to customer_transactions (only when card was actually charged)
    if (paymentIntent && usedCard) {
      const txDescSuffix = [
        hasSub && subAbsorbed > 0 ? `sub absorbed $${subAbsorbed.toFixed(2)}` : null,
        hasSub && lbOverageDol > 0 ? `$${lbOverageDol.toFixed(2)} lb overage` : null,
        creditsApplied > 0 ? `$${creditsApplied.toFixed(2)} credit applied` : null,
        tipDollars > 0 ? `$${tipDollars.toFixed(2)} tip` : null,
      ].filter(Boolean).join(', ')
      await db.from('customer_transactions').insert({
        customer_id: customer.id,
        type: 'charge',
        amount: chargeAmount,
        description: `Order #${order.order_number}${txDescSuffix ? ` (${txDescSuffix})` : ''}`,
        order_id: order.id,
        stripe_payment_intent_id: paymentIntent.id,
        payment_method: 'credit_card',
        card_brand: usedCard.card_brand,
        card_last4: usedCard.card_last4,
      })
    }

    // Notify customer of successful payment
    notifyCustomer(orderId, 'payment_received')

    console.log('Order charged successfully:', orderId,
      paymentIntent ? paymentIntent.id : (subOnly ? '[subscription-only]' : '[credits-only]'),
      usedCard ? `${usedCard.card_brand} ${usedCard.card_last4}` : '',
      hasSub && subAbsorbed > 0 ? `(sub absorbed: $${subAbsorbed.toFixed(2)})` : '',
      hasSub && lbOverageDol > 0 ? `(lb overage: $${lbOverageDol.toFixed(2)})` : '',
      creditsApplied > 0 ? `(credit applied: $${creditsApplied.toFixed(2)})` : '',
      tipDollars > 0 ? `(tip: $${tipDollars.toFixed(2)})` : '')

    return new Response(JSON.stringify({
      success: true,
      paymentIntentId: paymentIntent ? paymentIntent.id : null,
      amount: chargeAmount,
      // Residual + subscription breakdown for transparency in the response
      hasSubscription: hasSub,
      subscriptionAbsorbed: subAbsorbed,
      lbOverageDollars: lbOverageDol,
      residualSubtotal: residualPreTip,
      tipDollars,
      creditApplied: creditsApplied,
      legacyCreditApplied,
      paidByCreditOnly: creditsOnly,
      paidBySubscriptionOnly: subOnly,
      card: usedCard ? `${usedCard.card_brand} ending ${usedCard.card_last4}` : null,
      fallbackUsed: usedCard ? !usedCard.is_default : false,
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('charge-order error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
