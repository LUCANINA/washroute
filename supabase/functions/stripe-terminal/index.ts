import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

/* ──────────────────────────────────────────────────────────────
   stripe-terminal  —  Stripe Terminal helpers for POS
   ──────────────────────────────────────────────────────────────
   POST /stripe-terminal
   Actions:
     connection_token | create_payment | cancel_payment | charge_reader
     get_payment | cancel_reader_action
     list_recent_pos_sales | refund_pos_payment    (added session 139)

   verify_jwt is DISABLED to match the rest of the WashRoute edge functions
   (cloudprnt, send-receipt, charge-order). Refund actions additionally
   require a valid pos_shift_id of an OPEN shift (ended_at IS NULL) — that's
   the auth boundary for refunds (matches "anyone signed into POS can
   refund" decision in session 139).
   ────────────────────────────────────────────────────────────── */

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseSrv = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

// Open-shift validation. Refund actions can only proceed if the caller
// passes a pos_shift_id that has not yet been ended.
async function validateOpenShift(shiftId: string) {
  if (!shiftId || typeof shiftId !== 'string' || shiftId.length !== 36) {
    throw new Error('pos_shift_id is required (open POS shift)')
  }
  const db = createClient(supabaseUrl, supabaseSrv)
  const { data, error } = await db
    .from('pos_shifts')
    .select('id, cashier_profile_id, ended_at')
    .eq('id', shiftId)
    .maybeSingle()
  if (error) throw new Error('Could not validate POS shift: ' + error.message)
  if (!data) throw new Error('POS shift not found')
  if (data.ended_at !== null) throw new Error('POS shift is closed — sign in again to refund')
  return data
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
      return json({ client_secret: pi.client_secret, payment_intent_id: pi.id })
    }

    /* ── 3. Cancel a PaymentIntent ────────────────────────────── */
    if (action === 'cancel_payment') {
      const { payment_intent_id } = body
      if (!payment_intent_id) return json({ error: 'payment_intent_id is required' }, 400)
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
      if (!reader_id) return json({ error: 'reader_id is required' }, 400)
      const pi = await stripe.paymentIntents.create({
        amount: Math.round(amount_cents),
        currency: 'usd',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: description || 'WashRoute POS sale',
        metadata: metadata || {},
      })
      const reader = await stripe.terminal.readers.processPaymentIntent(reader_id, {
        payment_intent: pi.id,
      })
      console.log(`[stripe-terminal] Charge pushed to reader ${reader_id}: PI ${pi.id} for $${(pi.amount / 100).toFixed(2)}`)
      return json({
        payment_intent_id: pi.id,
        reader_action_id: reader.action?.id || null,
        reader_status: reader.status || null,
      })
    }

    /* ── 5. Poll PaymentIntent status ─────────────────────────── */
    if (action === 'get_payment') {
      const { payment_intent_id } = body
      if (!payment_intent_id) return json({ error: 'payment_intent_id is required' }, 400)
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id)
      return json({
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        last_payment_error: pi.last_payment_error?.message || null,
      })
    }

    /* ── 6. Cancel whatever the reader is currently doing ───── */
    if (action === 'cancel_reader_action') {
      const { reader_id } = body
      if (!reader_id) return json({ error: 'reader_id is required' }, 400)
      const reader = await stripe.terminal.readers.cancelAction(reader_id)
      console.log(`[stripe-terminal] Reader action cancelled on ${reader_id}`)
      return json({ reader_status: reader.status })
    }

    /* ── 7. List recent POS sales (refund flow) ─────────────────
       Returns the last ~30 walk-in (POS) orders that have a non-zero
       remaining-refundable amount. Both card and cash sales included.
       Already-fully-refunded sales are not returned (no point listing).
       Auth: pos_shift_id required (open shift).
       ────────────────────────────────────────────────────────── */
    if (action === 'list_recent_pos_sales') {
      const { pos_shift_id, limit = 30 } = body
      await validateOpenShift(pos_shift_id)
      const db = createClient(supabaseUrl, supabaseSrv)
      const lim = Math.min(Math.max(Number(limit) || 30, 1), 100)
      const { data: rows, error } = await db
        .from('orders')
        .select('id, order_number, total_amount, tip_amount, amount_refunded, billed_at, billing_payment_method, billing_status, stripe_payment_intent_id, customer_id, line_items, customers(first_name_cache, last_name_cache)')
        .eq('source', 'walk_in')
        .not('billed_at', 'is', null)
        .in('billing_status', ['paid', 'refunded'])
        .order('billed_at', { ascending: false })
        .limit(lim * 2)
      if (error) return json({ error: 'Failed to load recent sales: ' + error.message }, 500)

      const sales = (rows || [])
        .map((r: any) => {
          const total = Number(r.total_amount || 0)
          const tip = Number(r.tip_amount || 0)
          const refunded = Number(r.amount_refunded || 0)
          const chargeable = +(total + tip).toFixed(2)
          const remaining = +(chargeable - refunded).toFixed(2)
          let desc = 'POS sale'
          if (Array.isArray(r.line_items)) {
            const first = r.line_items.find((l: any) => l && l.type !== 'tax')
            if (first) desc = first.label || first.name || desc
          }
          const cust = r.customers
            ? `${r.customers.first_name_cache || ''} ${r.customers.last_name_cache || ''}`.trim()
            : null
          return {
            order_id: r.id,
            order_number: r.order_number,
            billed_at: r.billed_at,
            chargeable,
            already_refunded: refunded,
            remaining_refundable: remaining,
            payment_method: r.billing_payment_method,
            stripe_payment_intent_id: r.stripe_payment_intent_id,
            description: desc,
            customer_name: cust,
            is_fully_refunded: remaining < 0.01,
          }
        })
        .filter((s: any) => !s.is_fully_refunded)
        .slice(0, lim)

      return json({ sales })
    }

    /* ── 8. Refund a POS payment (full or partial) ──────────────
       For card sales: stripe.refunds.create() against the PaymentIntent.
       For cash sales: skip Stripe (cashier hands cash from till).
       Always: increments orders.amount_refunded, flips billing_status to
       'refunded' when fully refunded, and inserts a customer_transactions
       row when the order has an attached customer (for admin reporting).
       Decrements customers.lifetime_value to match admin's refund-charge.
       Auth: pos_shift_id required (open shift).
       ────────────────────────────────────────────────────────── */
    if (action === 'refund_pos_payment') {
      const { pos_shift_id, order_id, amount, note } = body
      const shift = await validateOpenShift(pos_shift_id)

      if (!order_id) return json({ error: 'order_id is required' }, 400)
      const refundAmount = Number(amount)
      if (!refundAmount || !isFinite(refundAmount) || refundAmount <= 0) {
        return json({ error: 'amount must be a positive number (dollars)' }, 400)
      }

      const db = createClient(supabaseUrl, supabaseSrv)

      const { data: order, error: orderErr } = await db
        .from('orders')
        .select('id, order_number, source, total_amount, tip_amount, amount_refunded, billing_payment_method, billing_status, stripe_payment_intent_id, customer_id')
        .eq('id', order_id)
        .single()
      if (orderErr || !order) return json({ error: 'Order not found' }, 404)

      if (order.source !== 'walk_in') {
        return json({ error: 'POS refund only works on walk-in orders. Use the admin refund flow for delivery orders.' }, 400)
      }

      const total = Number(order.total_amount || 0)
      const tip = Number(order.tip_amount || 0)
      const alreadyRefunded = Number(order.amount_refunded || 0)
      const chargeable = +(total + tip).toFixed(2)
      const remaining = +(chargeable - alreadyRefunded).toFixed(2)

      if (refundAmount > remaining + 0.001) {
        return json({
          error: `Refund $${refundAmount.toFixed(2)} exceeds remaining refundable $${remaining.toFixed(2)} on order #${order.order_number}.`,
        }, 400)
      }

      const isCard = order.billing_payment_method === 'card' || order.billing_payment_method === 'credit_card'
      const isCash = order.billing_payment_method === 'cash'
      if (!isCard && !isCash) {
        return json({ error: `Cannot refund payment method: ${order.billing_payment_method || 'unknown'}` }, 400)
      }

      let stripeRefundId: string | null = null
      let cardBrand: string | null = null
      let cardLast4: string | null = null

      if (isCard) {
        if (!order.stripe_payment_intent_id) {
          return json({ error: 'Card sale has no Stripe PaymentIntent on file — cannot refund automatically.' }, 400)
        }
        const refund = await stripe.refunds.create({
          payment_intent: order.stripe_payment_intent_id,
          amount: Math.round(refundAmount * 100),
          metadata: {
            source: 'pos',
            order_id: order.id,
            order_number: String(order.order_number),
            cashier_profile_id: shift.cashier_profile_id,
          },
        })
        if (refund.status !== 'succeeded' && refund.status !== 'pending') {
          return json({ error: `Stripe refund status: ${refund.status}` }, 502)
        }
        stripeRefundId = refund.id

        // Pull card brand + last4 best-effort for the customer_transactions row.
        try {
          const pi: any = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, { expand: ['latest_charge'] })
          const card = pi?.latest_charge?.payment_method_details?.card
          if (card) {
            cardBrand = card.brand || null
            cardLast4 = card.last4 || null
          }
        } catch (e: any) {
          console.warn('[stripe-terminal] Could not fetch card details for refund record:', e?.message)
        }
      }

      const newRefunded = +(alreadyRefunded + refundAmount).toFixed(2)
      const isFull = newRefunded >= chargeable - 0.001
      const updates: any = { amount_refunded: newRefunded }
      if (isFull) updates.billing_status = 'refunded'

      const { error: updErr } = await db.from('orders').update(updates).eq('id', order.id)
      if (updErr) {
        console.error('[stripe-terminal] Order update failed AFTER stripe refund succeeded:', updErr.message)
        return json({
          error: 'Stripe refund succeeded but order update failed: ' + updErr.message + '. Contact admin.',
          stripe_refund_id: stripeRefundId,
        }, 500)
      }

      // Customer-attached orders mirror admin's refund-charge: insert a
      // customer_transactions row (powers admin reporting + customer panel)
      // and decrement lifetime_value.
      if (order.customer_id) {
        const desc = isFull
          ? `Refund: Order #${order.order_number}`
          : `Partial refund: Order #${order.order_number} ($${refundAmount.toFixed(2)})`
        const { error: txErr } = await db.from('customer_transactions').insert({
          customer_id: order.customer_id,
          type: 'refund',
          amount: refundAmount,
          description: desc,
          order_id: order.id,
          stripe_payment_intent_id: order.stripe_payment_intent_id || null,
          card_brand: cardBrand,
          card_last4: cardLast4,
          note: note || (isCash ? 'POS cash refund' : 'POS card refund'),
        })
        if (txErr) {
          console.warn('[stripe-terminal] customer_transactions insert failed (non-fatal):', txErr.message)
        }

        const { data: cust } = await db.from('customers').select('lifetime_value').eq('id', order.customer_id).single()
        if (cust) {
          const newLtv = Math.max(0, Number(cust.lifetime_value || 0) - refundAmount)
          await db.from('customers').update({ lifetime_value: newLtv }).eq('id', order.customer_id)
        }
      }

      console.log(`[stripe-terminal] Refunded $${refundAmount.toFixed(2)} on order #${order.order_number} (${isCard ? 'card' : 'cash'}, ${isFull ? 'full' : 'partial'}, by shift ${pos_shift_id})`)

      return json({
        success: true,
        order_id: order.id,
        order_number: order.order_number,
        amount_refunded: refundAmount,
        new_total_refunded: newRefunded,
        remaining_refundable: +(chargeable - newRefunded).toFixed(2),
        is_full_refund: isFull,
        stripe_refund_id: stripeRefundId,
        payment_method: isCard ? 'card' : 'cash',
      })
    }

    return json({ error: `Unknown action: ${action}` }, 400)

  } catch (err: any) {
    console.error('[stripe-terminal] Error:', err.message)
    return json({ error: err.message }, 500)
  }
})
