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

const BIZ_TZ = 'America/Los_Angeles'

// Minutes that LA local time is offset from UTC at a given instant
// (e.g. -420 during PDT, -480 during PST). Computed via Intl so it's
// always DST-correct without hardcoding offsets — see TIMEZONE RULES.
function laOffsetMinutes(date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: BIZ_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const map: Record<string, string> = {}
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value
  const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second)
  return Math.round((asUTC - date.getTime()) / 60000)
}

// Today's date as YYYY-MM-DD in Pacific time.
function pacificToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TZ }).format(new Date())
}

// Given a Pacific calendar day (YYYY-MM-DD), return the UTC instants for
// 00:00 of that day (gte) and 00:00 of the next day (lt), so a timestamptz
// `billed_at` filter captures exactly that Pacific day. DST transitions
// happen at 02:00, never at midnight, so the midnight boundary is safe.
function pacificDayRangeUtc(dateStr: string): { gte: string; lt: string } {
  const midnightUtc = (d: string) => {
    const naive = Date.parse(`${d}T00:00:00Z`)        // wall-clock as-if-UTC
    const off = laOffsetMinutes(new Date(naive))      // LA offset that day
    return new Date(naive - off * 60000).toISOString()
  }
  const [y, m, d] = dateStr.split('-').map(Number)
  const nextNaive = new Date(Date.UTC(y, m - 1, d))
  nextNaive.setUTCDate(nextNaive.getUTCDate() + 1)
  const nextStr = nextNaive.toISOString().slice(0, 10)
  return { gte: midnightUtc(dateStr), lt: midnightUtc(nextStr) }
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
    .select('id, cashier_profile_id, ended_at, device_id, pos_devices(site_id)')
    .eq('id', shiftId)
    .maybeSingle()
  if (error) throw new Error('Could not validate POS shift: ' + error.message)
  if (!data) throw new Error('POS shift not found')
  if (data.ended_at !== null) throw new Error('POS shift is closed — sign in again to refund')
  // Resolve the device's store so refund listing can be scoped to this site.
  // Derived server-side from the shift's device — never trusts a client value.
  const site_id = (data as any).pos_devices?.site_id ?? null
  return { ...data, site_id }
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

    /* ── 7. List POS sales for one Pacific day, one store (refund flow) ─
       Returns walk-in (POS) orders billed on the given Pacific calendar
       day at the shift's store. Both card and cash sales included.
       Already-fully-refunded sales ARE included (flagged is_fully_refunded)
       so the day's list mirrors what actually happened — the UI greys them
       out and blocks re-refund. Also returns a `summary` (count + totals).
       Auth: pos_shift_id required (open shift).
       ────────────────────────────────────────────────────────── */
    if (action === 'list_recent_pos_sales') {
      // Day-scoped POS sales for a single store (session 162 rework).
      //  - `date` (YYYY-MM-DD, Pacific): the calendar day to list. Defaults
      //    to today Pacific when omitted.
      //  - Scoped to the shift's device's site_id — derived server-side, so
      //    Foothill never sees 23rd Ave sales and vice versa.
      //  - Already-fully-refunded sales are INCLUDED (flagged
      //    is_fully_refunded) so the day's list mirrors what actually
      //    happened; the UI greys them out and blocks re-refund.
      const { pos_shift_id, date } = body
      const shift = await validateOpenShift(pos_shift_id)
      const db = createClient(supabaseUrl, supabaseSrv)

      const day = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
        ? date
        : pacificToday()
      const { gte, lt } = pacificDayRangeUtc(day)

      let q = db
        .from('orders')
        .select('id, order_number, total_amount, tip_amount, amount_refunded, billed_at, billing_payment_method, billing_status, stripe_payment_intent_id, customer_id, site_id, line_items, customers(first_name_cache, last_name_cache)')
        .eq('source', 'walk_in')
        .not('billed_at', 'is', null)
        .in('billing_status', ['paid', 'refunded'])
        .gte('billed_at', gte)
        .lt('billed_at', lt)
        .order('billed_at', { ascending: false })
        .limit(200)
      // Scope to this device's store. (All walk-in orders carry site_id; the
      // guard keeps us safe if a legacy null ever appears — it simply won't
      // match, rather than leaking another store's sales.)
      if (shift.site_id) q = q.eq('site_id', shift.site_id)

      const { data: rows, error } = await q
      if (error) return json({ error: 'Failed to load recent sales: ' + error.message }, 500)

      let dayTotal = 0
      let dayRefunded = 0
      const sales = (rows || []).map((r: any) => {
        const total = Number(r.total_amount || 0)
        const tip = Number(r.tip_amount || 0)
        const refunded = Number(r.amount_refunded || 0)
        const chargeable = +(total + tip).toFixed(2)
        const remaining = +(chargeable - refunded).toFixed(2)
        dayTotal += chargeable
        dayRefunded += refunded
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

      return json({
        sales,
        date: day,
        summary: {
          count: sales.length,
          total: +dayTotal.toFixed(2),
          refunded: +dayRefunded.toFixed(2),
        },
      })
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

    /* ── 9. Delete a POS order from the queue ───────────────────
       Auto-refunds any remaining balance, then hard-deletes the order.
       Used by the queue's 3-step delete UX (select → delete → confirm).
       Restricted to walk-in orders still in the queue (processing or
       ready_for_delivery) — once an order is delivered it's a historical
       record and shouldn't be deletable from the POS. Use admin tools
       for those.

       FK cascades handled by the schema:
         order_events, order_folding_assignments, order_items,
         notifications, route_stops          → ON DELETE CASCADE
         customer_transactions, print_jobs,
         subscription_usage_log              → ON DELETE SET NULL

       The customer_transactions refund row (when applicable) is inserted
       BEFORE the delete so the customer's billing history retains a
       record of what happened (its order_id link gets nulled by cascade,
       but the description preserves context).

       Auth: pos_shift_id required (open shift).
       ────────────────────────────────────────────────────────── */
    if (action === 'delete_pos_order') {
      const { pos_shift_id, order_id } = body
      const shift = await validateOpenShift(pos_shift_id)

      if (!order_id) return json({ error: 'order_id is required' }, 400)

      const db = createClient(supabaseUrl, supabaseSrv)

      const { data: order, error: orderErr } = await db
        .from('orders')
        .select('id, order_number, source, status, total_amount, tip_amount, amount_refunded, billing_status, billing_payment_method, stripe_payment_intent_id, customer_id')
        .eq('id', order_id)
        .single()
      if (orderErr || !order) return json({ error: 'Order not found' }, 404)

      if (order.source !== 'walk_in') {
        return json({ error: 'POS delete only works on walk-in orders.' }, 400)
      }
      if (order.status !== 'processing' && order.status !== 'ready_for_delivery') {
        return json({ error: `Cannot delete an order in status '${order.status}'. Only orders still in the queue can be deleted.` }, 400)
      }

      const total = Number(order.total_amount || 0)
      const tip = Number(order.tip_amount || 0)
      const alreadyRefunded = Number(order.amount_refunded || 0)
      const chargeable = +(total + tip).toFixed(2)
      const remaining = +(chargeable - alreadyRefunded).toFixed(2)

      const isCard = order.billing_payment_method === 'card' || order.billing_payment_method === 'credit_card'
      const isCash = order.billing_payment_method === 'cash'
      const wasPaid = order.billing_status === 'paid' || order.billing_status === 'refunded'
      const needsRefund = wasPaid && remaining > 0.005

      let stripeRefundId: string | null = null
      let cardBrand: string | null = null
      let cardLast4: string | null = null

      // 1) Refund the remaining balance (card only). Cash is bookkeeping
      //    only — the cashier hands cash back from the till.
      if (needsRefund && isCard) {
        if (!order.stripe_payment_intent_id) {
          return json({ error: 'Card sale has no Stripe PaymentIntent on file — cannot auto-refund. Refund manually in Stripe dashboard, then delete from admin.' }, 400)
        }
        const refund = await stripe.refunds.create({
          payment_intent: order.stripe_payment_intent_id,
          amount: Math.round(remaining * 100),
          metadata: {
            source: 'pos_delete',
            order_id: order.id,
            order_number: String(order.order_number),
            cashier_profile_id: shift.cashier_profile_id,
          },
        })
        if (refund.status !== 'succeeded' && refund.status !== 'pending') {
          return json({ error: `Stripe refund status: ${refund.status}` }, 502)
        }
        stripeRefundId = refund.id

        try {
          const pi: any = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id, { expand: ['latest_charge'] })
          const card = pi?.latest_charge?.payment_method_details?.card
          if (card) { cardBrand = card.brand || null; cardLast4 = card.last4 || null }
        } catch (e: any) {
          console.warn('[stripe-terminal] Could not fetch card details for delete-refund record:', e?.message)
        }
      }

      // 2) For customer-attached orders that had a real refund, preserve
      //    the billing-history record (order_id link gets nulled by cascade,
      //    but the description carries context).
      if (needsRefund && order.customer_id) {
        const { error: txErr } = await db.from('customer_transactions').insert({
          customer_id: order.customer_id,
          type: 'refund',
          amount: remaining,
          description: `Refund (deleted): Order #${order.order_number}`,
          order_id: order.id,
          stripe_payment_intent_id: order.stripe_payment_intent_id || null,
          card_brand: cardBrand,
          card_last4: cardLast4,
          note: isCash ? 'POS cash refund (order deleted)' : 'POS card refund (order deleted)',
        })
        if (txErr) {
          console.warn('[stripe-terminal] customer_transactions insert failed (non-fatal):', txErr.message)
        }

        const { data: cust } = await db.from('customers').select('lifetime_value').eq('id', order.customer_id).single()
        if (cust) {
          const newLtv = Math.max(0, Number(cust.lifetime_value || 0) - remaining)
          await db.from('customers').update({ lifetime_value: newLtv }).eq('id', order.customer_id)
        }
      }

      // 3) Hard delete the order. FK cascades clean up events/items/etc.
      const { error: delErr } = await db.from('orders').delete().eq('id', order.id)
      if (delErr) {
        console.error('[stripe-terminal] Order delete failed AFTER refund:', delErr.message)
        return json({
          error: 'Refund processed but order delete failed: ' + delErr.message + '. Contact admin to clean up.',
          stripe_refund_id: stripeRefundId,
          refunded_amount: needsRefund ? remaining : 0,
        }, 500)
      }

      console.log(`[stripe-terminal] Deleted order #${order.order_number} (${isCard ? 'card' : isCash ? 'cash' : 'unpaid'}, refunded $${needsRefund ? remaining.toFixed(2) : '0.00'}, by shift ${pos_shift_id})`)

      return json({
        success: true,
        order_number: order.order_number,
        refunded_amount: needsRefund ? remaining : 0,
        payment_method: isCard ? 'card' : isCash ? 'cash' : null,
        stripe_refund_id: stripeRefundId,
      })
    }

    return json({ error: `Unknown action: ${action}` }, 400)

  } catch (err: any) {
    console.error('[stripe-terminal] Error:', err.message)
    return json({ error: err.message }, 500)
  }
})
