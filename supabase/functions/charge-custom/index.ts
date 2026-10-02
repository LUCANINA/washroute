import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// ─────────────────────────────────────────────────────────────────────────────
// charge-custom (session 329)
//
// Staff charge a customer's saved card a CUSTOM amount that is not an order —
// e.g. a lost-item fee, a missed adjustment. Added with the customer-panel
// redesign (Billing → Balance → "Custom charge").
//
// Rules this function holds:
//  • Same staff roles as charge-order. Anon key refused.
//  • Reason is required: it goes on the Stripe charge, the ledger row, and the
//    customer's text receipt.
//  • Hard cap per charge (MAX_CUSTOM_CHARGE). Anything bigger belongs in an order
//    or an invoice, not a free-form box.
//  • On-account customers are refused (they are invoiced, never card-charged).
//  • Double-click / retry safety: the caller sends a requestId generated once
//    per form open; it becomes the Stripe idempotency key, so two identical
//    requests collapse into ONE PaymentIntent at Stripe.
//  • Description starts with "Custom charge:" and metadata.kind='custom_charge'.
//    xero-payout-sync keys on those to book the charge to 403 Delivery - Wash &
//    Fold instead of 'unclassified' (which would hold up the payout).
//  • Ledger row: customer_transactions type 'charge', order_id NULL, with the
//    PaymentIntent id — so the existing refund-charge function can refund it
//    from the Payments list like any other charge. The insert is CHECKED; if it
//    fails after Stripe succeeded we return success with ledgerError so the UI
//    says so loudly (money moved, record didn't).
//  • Text receipt to the customer via send-sms (service-role → "Automated"),
//    fire-and-forget, only after Stripe succeeded.
// ─────────────────────────────────────────────────────────────────────────────

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const CHARGE_ROLES = new Set(['admin', 'manager', 'attendant', 'laundry_tech'])
const MAX_CUSTOM_CHARGE = 500   // dollars, per charge

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type Actor = { name: string }

async function authorize(req: Request): Promise<{ ok: true; actor: Actor } | { ok: false; status: number; reason: string }> {
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization') || ''
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' }
  const jwt = m[1]
  if (jwt === supabaseAnonKey) return { ok: false, status: 401, reason: 'Anon key not accepted; staff login required' }
  if (jwt === supabaseServiceKey) return { ok: true, actor: { name: 'System' } }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  })
  const { data: { user }, error: userErr } = await userClient.auth.getUser(jwt)
  if (userErr || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' }

  const adminClient = createClient(supabaseUrl, supabaseServiceKey)
  const { data: profile, error: profErr } = await adminClient
    .from('profiles').select('role, first_name, last_name').eq('id', user.id).single()
  if (profErr || !profile) return { ok: false, status: 403, reason: 'Profile not found' }
  if (!CHARGE_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed to charge customers` }
  }
  const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Staff'
  return { ok: true, actor: { name } }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

// Same normalisation the admin compose box uses (session 327b): Twilio needs E.164.
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const d = String(raw).replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  if (String(raw).trim().startsWith('+') && d.length >= 10) return '+' + d
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only', code: 'bad_request' }, 405)

  const auth = await authorize(req)
  if (!auth.ok) return json({ error: auth.reason, code: 'unauthorized' }, auth.status)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON', code: 'bad_request' }, 400) }
  const customerId = String(body?.customerId || '')
  const reason     = String(body?.reason || '').trim().slice(0, 120)
  const requestId  = String(body?.requestId || '').trim()
  const amount     = Math.round(Number(body?.amount) * 100) / 100

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) return json({ error: 'customerId must be a customer id', code: 'bad_request' }, 400)
  if (!reason)                       return json({ error: 'A reason is required', code: 'bad_request' }, 400)
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return json({ error: 'requestId is required', code: 'bad_request' }, 400)
  if (!isFinite(amount) || amount < 0.5) return json({ error: 'Amount must be at least $0.50', code: 'invalid_amount' }, 400)
  if (amount > MAX_CUSTOM_CHARGE)    return json({ error: `Custom charges are capped at $${MAX_CUSTOM_CHARGE}. Use an order or invoice for more.`, code: 'over_cap' }, 400)

  const db = createClient(supabaseUrl, supabaseServiceKey)

  const { data: customer, error: custErr } = await db.from('customers')
    .select('id, first_name_cache, phone_cache, billing_type, stripe_customer_id, stripe_default_payment_method_id, card_brand, card_last4, cancelled_at')
    .eq('id', customerId).single()
  if (custErr || !customer) return json({ error: 'Customer not found', code: 'not_found' }, 404)
  if (customer.cancelled_at)               return json({ error: 'This account is cancelled', code: 'cancelled' }, 409)
  if (customer.billing_type === 'on_account') return json({ error: 'On-account customers are invoiced, not card-charged', code: 'on_account' }, 409)
  if (!customer.stripe_customer_id)        return json({ error: 'No Stripe account for this customer', code: 'no_stripe_account' }, 409)

  // Default card only. Unlike an order charge we do NOT fall through to other
  // cards: staff picked an amount for THIS card shown on screen.
  const { data: cards, error: cardsErr } = await db.from('customer_payment_methods')
    .select('stripe_payment_method_id, card_brand, card_last4, is_default')
    .eq('customer_id', customer.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  if (cardsErr) return json({ error: 'Could not load cards: ' + cardsErr.message, code: 'cards_unavailable' }, 500)
  const card = (cards && cards[0]) || (customer.stripe_default_payment_method_id
    ? { stripe_payment_method_id: customer.stripe_default_payment_method_id, card_brand: customer.card_brand, card_last4: customer.card_last4 }
    : null)
  if (!card) return json({ error: 'No card on file for this customer', code: 'no_card_on_file' }, 409)

  let pi: any
  try {
    pi = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      customer: customer.stripe_customer_id,
      payment_method: card.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      description: `Custom charge: ${reason} — Family Laundry`,
      metadata: { kind: 'custom_charge', customer_id: customer.id, reason, charged_by: auth.actor.name },
    }, { idempotencyKey: `cc_${customer.id}_${requestId}` })
  } catch (e: any) {
    return json({ error: `Card declined: ${e?.message || 'unknown error'}`, code: 'card_declined' }, 402)
  }
  if (pi.status !== 'succeeded') return json({ error: `Payment status: ${pi.status}`, code: 'card_declined' }, 402)

  // Idempotent replay: Stripe returned the SAME PaymentIntent for a repeated
  // requestId. Don't write a second ledger row or send a second text.
  const { data: existing } = await db.from('customer_transactions')
    .select('id').eq('stripe_payment_intent_id', pi.id).maybeSingle()
  if (existing) {
    return json({ success: true, replay: true, paymentIntentId: pi.id, amount, card: `${card.card_brand} ending ${card.card_last4}` })
  }

  const { error: ledgerErr } = await db.from('customer_transactions').insert({
    customer_id: customer.id,
    type: 'charge',
    amount,
    description: `Custom charge — ${reason}`,
    order_id: null,
    stripe_payment_intent_id: pi.id,
    payment_method: 'credit_card',
    card_brand: card.card_brand,
    card_last4: card.card_last4,
    note: `Charged by ${auth.actor.name}`,
  })
  if (ledgerErr) {
    console.error('charge-custom: Stripe succeeded but ledger insert failed', { pi: pi.id, err: ledgerErr.message })
  }

  // Text receipt. Awaited (an edge function can be torn down as soon as it
  // responds), but a failed text never undoes the charge — it is only reported.
  const to = toE164(customer.phone_cache)
  let texted = false
  if (to) {
    const brand = card.card_brand ? card.card_brand.charAt(0).toUpperCase() + card.card_brand.slice(1) : 'Card'
    const smsBody = `Family Laundry: we charged $${amount.toFixed(2)} to your ${brand} ending ${card.card_last4} for: ${reason}. Questions? Just reply to this text.`
    try {
      const r = await fetch(`${supabaseUrl}/functions/v1/send-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${supabaseServiceKey}` },
        body: JSON.stringify({ to, body: smsBody, customer_id: customer.id }),
      })
      texted = r.ok
      if (!r.ok) console.warn('charge-custom: receipt text refused', r.status, await r.text().catch(() => ''))
    } catch (e: any) {
      console.warn('charge-custom: receipt text failed', e?.message)
    }
  }

  return json({
    success: true,
    paymentIntentId: pi.id,
    amount,
    card: `${card.card_brand} ending ${card.card_last4}`,
    texted,
    ledgerError: ledgerErr ? ledgerErr.message : null,
  })
})
