import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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

// --- Staging kill-switch (Track A3, Aug 2026) ---------------------------
// Fail-closed: if we can't PROVE this project is production, refuse to
// issue a real Stripe refund (and the SMS it triggers below). Never rely
// on client-side env detection — see archive/WashRoute-Staging-Config-Scope.md
// and the Golden Rule in washroute-preflight: assume an action WILL reach
// a real person / real money unless proven otherwise.
async function assertProductionOrRefuse(db: any): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { data, error } = await db.from('settings').select('wr_environment').eq('id', 1).single();
    if (error) return { ok: false, reason: 'wr_environment check failed (fail-closed)' };
    if (data?.wr_environment !== 'production') {
      return { ok: false, reason: `Blocked by staging kill-switch: wr_environment='${data?.wr_environment ?? 'unset'}', not 'production'` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `wr_environment check errored (fail-closed): ${String(e)}` };
  }
}
// --------------------------------------------------------------------------

const REFUND_ROLES = new Set(['admin', 'manager']);

async function requireRefundRole(req: Request): Promise<{ ok: true; userId: string; actorName: string } | { ok: false; status: number; reason: string }> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization: Bearer <jwt>' }
  const jwt = m[1]
  if (jwt === supabaseAnonKey) return { ok: false, status: 401, reason: 'Anon key not accepted; staff login required' }
  const userClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt)
  if (userErr || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' }
  const adminClient = createClient(supabaseUrl, supabaseKey)
  const { data: profile, error: profErr } = await adminClient.from('profiles')
    .select('role, first_name, last_name').eq('id', user.id).single()
  if (profErr || !profile) return { ok: false, status: 403, reason: 'Profile not found' }
  if (!REFUND_ROLES.has(profile.role)) return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to issue refunds` }
  const actorName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || 'Admin'
  return { ok: true, userId: user.id, actorName }
}

// Session 167: for subscription_invoice rows that don't have stripe_payment_intent_id set
// (e.g. backfilled rows), find the matching paid Stripe invoice for this customer and
// return its payment_intent. Returns null if no match found.
async function resolvePaymentIntentForSubscription(db: any, txn: any): Promise<string | null> {
  const { data: cust } = await db.from('customers').select('stripe_customer_id').eq('id', txn.customer_id).single()
  if (!cust?.stripe_customer_id) return null

  const invoices = await stripe.invoices.list({
    customer: cust.stripe_customer_id,
    status: 'paid',
    limit: 25,
  })

  const expectedCents = Math.round(Number(txn.amount) * 100)
  const { data: recordedRows } = await db.from('customer_transactions')
    .select('stripe_payment_intent_id')
    .eq('customer_id', txn.customer_id)
    .not('stripe_payment_intent_id', 'is', null)
  const recorded = new Set((recordedRows || []).map((r: any) => r.stripe_payment_intent_id))

  for (const inv of invoices.data) {
    if (inv.amount_paid !== expectedCents) continue
    const piId = typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent as any)?.id
    if (!piId) continue
    if (recorded.has(piId)) continue
    return piId
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const auth = await requireRefundRole(req)
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const db = createClient(supabaseUrl, supabaseKey)

    const envCheck = await assertProductionOrRefuse(db)
    if (!envCheck.ok) {
      console.warn('refund-charge blocked by staging kill-switch:', envCheck.reason)
      return new Response(JSON.stringify({ error: envCheck.reason }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const { transactionId, amount, reason, suppress_sms } = await req.json()

    if (!transactionId) throw new Error('transactionId is required')
    if (!amount || Number(amount) <= 0) throw new Error('Refund amount must be greater than zero')

    const { data: txn, error: txnErr } = await db
      .from('customer_transactions')
      .select('id, customer_id, type, amount, description, order_id, stripe_payment_intent_id, card_brand, card_last4')
      .eq('id', transactionId)
      .single()

    if (txnErr || !txn) throw new Error('Transaction not found')
    const allowedTypes = new Set(['charge', 'subscription_invoice'])
    if (!allowedTypes.has(txn.type)) throw new Error(`Cannot refund transactions of type '${txn.type}'`)

    let paymentIntentId = txn.stripe_payment_intent_id
    if (!paymentIntentId && txn.type === 'subscription_invoice') {
      paymentIntentId = await resolvePaymentIntentForSubscription(db, txn)
      if (!paymentIntentId) {
        throw new Error('Could not find a matching Stripe invoice for this subscription charge. Refund manually in the Stripe dashboard.')
      }
      await db.from('customer_transactions').update({ stripe_payment_intent_id: paymentIntentId }).eq('id', txn.id)
    }
    if (!paymentIntentId) throw new Error('This transaction has no Stripe payment — cannot refund')

    const originalAmount = Number(txn.amount)
    const refundAmount   = Number(amount)
    if (refundAmount > originalAmount) throw new Error(`Refund amount (${refundAmount}) exceeds original charge (${originalAmount})`)

    // Pre-flight over-refund gate. This is the ONLY place a refund can still be blocked
    // without money having moved — record_order_refund deliberately records rather than
    // rejects, because by the time it runs Stripe has already paid the customer.
    const { data: existingRefunds } = await db
      .from('customer_transactions')
      .select('amount')
      .eq('customer_id', txn.customer_id)
      .eq('type', 'refund')
      .eq('stripe_payment_intent_id', paymentIntentId)
    const alreadyRefunded = (existingRefunds || []).reduce((s: number, r: any) => s + Number(r.amount), 0)
    if (alreadyRefunded + refundAmount > originalAmount) {
      throw new Error(`Total refunds (${alreadyRefunded + refundAmount}) would exceed original charge (${originalAmount})`)
    }

    const refundParams: any = { payment_intent: paymentIntentId, amount: Math.round(refundAmount * 100) }
    if (reason) refundParams.reason = 'requested_by_customer'

    const stripeRefund = await stripe.refunds.create(refundParams)
    if (stripeRefund.status !== 'succeeded' && stripeRefund.status !== 'pending') {
      throw new Error(`Stripe refund status: ${stripeRefund.status}`)
    }

    // ---- Session 213: ALL DB bookkeeping now happens in ONE transactional RPC. ----
    // Previously this was three loose writes (insert refund txn / decrement LTV /
    // update order), and the order update set billing_status='refunded' UNCONDITIONALLY
    // while never touching orders.amount_refunded. That marked partial refunds as full
    // ones — 72 orders and $6,924.37 of kept revenue misclassified — and left the
    // session-139 accumulator, which is supposed to be source-of-truth, at 0.
    // record_order_refund owns the rule now, and the POS refund path will move onto the
    // same RPC so the two can never drift again.
    const { data: book, error: bookErr } = await db.rpc('record_order_refund', {
      p_transaction_id: txn.id,
      p_amount:         refundAmount,
      p_note:           reason || null,
      p_actor_name:     auth.actorName,
    })

    if (bookErr) {
      // Stripe has ALREADY refunded the customer. Never throw a plain error here — the
      // operator would see "refund failed" and retry, double-refunding. Return success
      // with a loud warning so the money movement is not lost and the record gap is
      // visible and fixable by hand.
      console.error('refund-charge: Stripe refund SUCCEEDED but DB bookkeeping FAILED', {
        stripeRefundId: stripeRefund.id, transactionId: txn.id, amount: refundAmount, error: bookErr.message,
      })
      return new Response(JSON.stringify({
        success: true,
        refundId: stripeRefund.id,
        amount: refundAmount,
        status: stripeRefund.status,
        bookkeeping_failed: true,
        warning: `The refund of $${refundAmount.toFixed(2)} WAS issued to the customer's card (Stripe ${stripeRefund.id}), but recording it in WashRoute failed: ${bookErr.message}. Do NOT retry the refund — it would charge you twice. Report this to support.`,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (book?.over_refunded) {
      console.warn('refund-charge: recorded refund exceeds the original charge', { transactionId: txn.id, amount: refundAmount })
    }

    const isFullRefund = (txn.order_id && txn.type === 'charge')
      ? !!book?.fully_refunded
      : refundAmount >= originalAmount
    const refundLabel  = isFullRefund ? `$${refundAmount.toFixed(2)} (full refund)` : `$${refundAmount.toFixed(2)}`
    const cardLabel    = txn.card_last4 ? ` to your ${txn.card_brand || 'card'} ending ${txn.card_last4}` : ''
    const reasonNote   = reason ? ` (${reason})` : ''

    if (!suppress_sms) {
      const { data: customer } = await db.from('customers').select('phone_cache, first_name_cache, sms_notifications_opt_out_at').eq('id', txn.customer_id).single()
      if (customer?.phone_cache && !customer.sms_notifications_opt_out_at) {
        const rawPhone = customer.phone_cache.replace(/\D/g, '')
        const toE164   = rawPhone.length === 10 ? `+1${rawPhone}` : `+${rawPhone}`
        const firstName = customer.first_name_cache || 'there'
        const smsBody   = txn.type === 'subscription_invoice'
          ? `Hi ${firstName}! We've issued a subscription refund of ${refundLabel}${cardLabel}${reasonNote}. It typically appears in 5–7 business days. — Family Laundry`
          : `Hi ${firstName}! We've issued a refund of ${refundLabel}${cardLabel}${reasonNote}. It typically appears in 5–7 business days. — Family Laundry`
        const smsUrl = `${supabaseUrl}/functions/v1/send-sms`
        fetch(smsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseKey}` },
          body: JSON.stringify({ to: toE164, body: smsBody, customer_id: txn.customer_id }),
        }).catch((e: Error) => console.warn('SMS notification failed:', e.message))
      }
    }

    return new Response(JSON.stringify({
      success: true,
      refundId: stripeRefund.id,
      amount: refundAmount,
      status: stripeRefund.status,
      fully_refunded: !!book?.fully_refunded,
      order_amount_refunded: book?.order_amount_refunded ?? null,
      sms_suppressed: !!suppress_sms,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (error: any) {
    console.error('refund-charge error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
