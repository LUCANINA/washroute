import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { sendAlertSms, alertSmsConfigFromEnv, trimForSms } from '../_shared/alert-sms.ts'

// ─────────────────────────────────────────────────────────────────────────────
// charge-account-payment (Session 374)
//
// An ON-ACCOUNT (invoiced) customer pays some of their unpaid orders with the
// card they have on file — e.g. Institute on Aging-Geary, Nov 2026. Opened from
// Record Payment (On-Account report) or "Charge card" on the customer's Billing tab.
//
// It charges the card, then records the payment exactly like a check would be:
// record_account_payment(method 'card', reference = PaymentIntent id). So the
// invoice, aging, payment history and Void all keep working unchanged. The
// customer stays on_account — nothing about how future orders bill changes.
//
// Rules this function holds:
//  • Staff with payment-recording rights only (same roles as is_admin()).
//  • Standalone on-account customers only (billing-group accounts span several
//    customers' cards — not supported). Automatic customers use charge-order.
//  • The AMOUNT IS COMPUTED HERE from the orders (total + tip, same formula as
//    mark_orders_paid). The screen sends what it showed; if the two differ by a
//    cent we refuse — the screen was stale.
//  • Every order must belong to this customer and still be unpaid.
//  • Double-charge protection, two layers:
//      1. requestId (made once per window open) → Stripe idempotency key, so a
//         double-click / network retry collapses into ONE PaymentIntent.
//      2. Before charging, we look at this customer's PaymentIntents from the last
//         30 minutes; if one already succeeded for the SAME set of orders (a second
//         tab, a second staff member), we reuse it instead of charging again.
//    And the DB holds one card payments row per PaymentIntent (unique index).
//  • Description starts "Account payment:" and metadata.kind='account_payment';
//    xero-payout-sync keys on those (books like a custom charge, 403).
//  • No customer message is sent. (On-account customers get invoices, not texts.)
//  • If Stripe succeeded but recording failed, we return success:true with
//    recorded:false + recordError, AND text the alert phone: money moved, record
//    didn't. Re-opening the window and charging the same orders again is safe —
//    layer 2 above finds the existing charge and records it instead.
// ─────────────────────────────────────────────────────────────────────────────

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

// Same roles record_account_payment lets in (is_admin()).
const PAYMENT_ROLES = new Set(['admin', 'manager', 'laundry_tech'])
const MAX_ACCOUNT_CARD_CHARGE = 3000   // dollars, per charge — a typo guard, not a policy
const MAX_ORDERS = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
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
  if (!PAYMENT_ROLES.has(profile.role)) {
    return { ok: false, status: 403, reason: `Role '${profile.role}' cannot record account payments` }
  }
  const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Staff'
  return { ok: true, actor: { name } }
}

// Same math as mark_orders_paid / orderChargedTotal(): total + tip ($ or %).
function orderChargedTotal(o: { total_amount: unknown; tip_amount: unknown; tip_type: unknown }): number {
  const sub = Number(o?.total_amount || 0)
  const tip = Number(o?.tip_amount || 0)
  if (!tip) return Math.round(sub * 100) / 100
  const tipDol = o.tip_type === 'pct' ? Math.round(sub * tip) / 100 : Math.round(tip * 100) / 100
  return Math.round((sub + tipDol) * 100) / 100
}

async function orderSetKey(ids: string[]): Promise<string> {
  const s = [...ids].map(x => x.toLowerCase()).sort().join(',')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

const UNPAID_EXCLUDED = new Set(['paid', 'refunded', 'written_off'])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'POST only', code: 'bad_request' }, 405)

  const auth = await authorize(req)
  if (!auth.ok) return json({ error: auth.reason, code: 'unauthorized' }, auth.status)

  let body: any
  try { body = await req.json() } catch { return json({ error: 'Invalid JSON', code: 'bad_request' }, 400) }
  const customerId = String(body?.customerId || '')
  const requestId  = String(body?.requestId || '').trim()
  const orderIds: string[] = Array.isArray(body?.orderIds) ? [...new Set(body.orderIds.map((x: unknown) => String(x)))] as string[] : []
  const expected   = Math.round(Number(body?.expectedAmount) * 100) / 100

  if (!UUID_RE.test(customerId))               return json({ error: 'customerId must be a customer id', code: 'bad_request' }, 400)
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return json({ error: 'requestId is required', code: 'bad_request' }, 400)
  if (!orderIds.length)                        return json({ error: 'Select at least one order', code: 'bad_request' }, 400)
  if (orderIds.length > MAX_ORDERS)            return json({ error: `At most ${MAX_ORDERS} orders per card payment`, code: 'bad_request' }, 400)
  if (!orderIds.every(id => UUID_RE.test(id))) return json({ error: 'orderIds must be order ids', code: 'bad_request' }, 400)
  if (!isFinite(expected) || expected <= 0)    return json({ error: 'expectedAmount is required', code: 'bad_request' }, 400)

  const db = createClient(supabaseUrl, supabaseServiceKey)

  // ── Customer ──
  const { data: customer, error: custErr } = await db.from('customers')
    .select('id, first_name_cache, last_name_cache, billing_type, billing_group_id, stripe_customer_id, stripe_default_payment_method_id, card_brand, card_last4, cancelled_at')
    .eq('id', customerId).single()
  if (custErr || !customer)                  return json({ error: 'Customer not found', code: 'not_found' }, 404)
  if (customer.billing_type !== 'on_account') return json({ error: 'Not an on-account customer — use the normal card charge', code: 'not_on_account' }, 409)
  if (customer.billing_group_id)             return json({ error: 'Billing-group accounts can’t be paid by card here', code: 'group_account' }, 409)
  if (customer.cancelled_at)                 return json({ error: 'This account is cancelled', code: 'cancelled' }, 409)
  if (!customer.stripe_customer_id)          return json({ error: 'No Stripe account for this customer', code: 'no_stripe_account' }, 409)

  // Default card only — the one shown on screen.
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
  const cardLabel = `${card.card_brand || 'Card'} ending ${card.card_last4 || '????'}`

  // ── Orders: must all be this customer's, all still unpaid ──
  const { data: orders, error: ordErr } = await db.from('orders')
    .select('id, order_number, customer_id, status, total_amount, tip_amount, tip_type, billing_status')
    .in('id', orderIds)
  if (ordErr) return json({ error: 'Could not load orders: ' + ordErr.message, code: 'orders_unavailable' }, 500)
  if ((orders || []).length !== orderIds.length) return json({ error: 'Some orders were not found', code: 'bad_orders' }, 409)
  const foreign = orders!.filter(o => o.customer_id !== customer.id)
  if (foreign.length) return json({ error: `Order #${foreign[0].order_number} belongs to another customer`, code: 'bad_orders' }, 409)

  const cancelled = orders!.filter(o => o.status === 'cancelled')
  if (cancelled.length) return json({ error: `Order #${cancelled[0].order_number} is cancelled`, code: 'bad_orders' }, 409)

  const setKey = await orderSetKey(orderIds)
  const amount = Math.round(orders!.reduce((s, o) => s + orderChargedTotal(o), 0) * 100) / 100
  const orderNums = orders!.map(o => o.order_number).sort((a, b) => (a || 0) - (b || 0))
  const orderNumText = orderNums.map(n => '#' + n).join(', ')

  // ── Layer 2: did someone already charge THIS set of orders in the last 30 min? ──
  let pi: any = null
  try {
    const recent = await stripe.paymentIntents.list({
      customer: customer.stripe_customer_id,
      created: { gte: Math.floor(Date.now() / 1000) - 30 * 60 },
      limit: 100,
    })
    pi = recent.data.find((p: any) => p.status === 'succeeded'
      && p.metadata?.kind === 'account_payment' && p.metadata?.order_set === setKey) || null
  } catch (e: any) {
    return json({ error: 'Could not check Stripe for an earlier charge: ' + (e?.message || 'unknown'), code: 'stripe_unavailable' }, 502)
  }

  if (!pi) {
    // Fresh charge — only for orders that are still unpaid, at the amount shown.
    const paid = orders!.filter(o => o.billing_status && UNPAID_EXCLUDED.has(o.billing_status))
    if (paid.length) return json({ error: `Order #${paid[0].order_number} is already paid — reopen the window`, code: 'already_paid' }, 409)
    if (Math.abs(amount - expected) >= 0.01) {
      return json({ error: `The orders now total $${amount.toFixed(2)}, not $${expected.toFixed(2)} — reopen the window`, code: 'amount_changed', amount }, 409)
    }
    if (amount < 0.5)                     return json({ error: 'Amount must be at least $0.50', code: 'invalid_amount' }, 400)
    if (amount > MAX_ACCOUNT_CARD_CHARGE) return json({ error: `Card payments are capped at $${MAX_ACCOUNT_CARD_CHARGE}. Split it into smaller payments.`, code: 'over_cap' }, 400)

    try {
      pi = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency: 'usd',
        customer: customer.stripe_customer_id,
        payment_method: card.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        description: `Account payment: ${orderNumText} — Family Laundry`.slice(0, 900),
        metadata: {
          kind: 'account_payment',
          customer_id: customer.id,
          order_set: setKey,
          order_numbers: orderNums.join(',').slice(0, 480),
          charged_by: auth.actor.name.slice(0, 100),
        },
      }, { idempotencyKey: `ap_${customer.id}_${requestId}` })
    } catch (e: any) {
      return json({ error: `Card declined: ${e?.message || 'unknown error'}`, code: 'card_declined' }, 402)
    }
    if (pi.status !== 'succeeded') return json({ error: `Payment status: ${pi.status}`, code: 'card_declined' }, 402)
  }

  const chargedAmount = Math.round(Number(pi.amount_received || pi.amount)) / 100

  // ── Already recorded? (idempotent replay) ──
  const { data: existing, error: exErr } = await db.from('payments')
    .select('id, voided_at').eq('method', 'card').eq('reference', pi.id).maybeSingle()
  if (exErr) console.error('charge-account-payment: replay lookup failed', exErr.message)
  if (existing?.voided_at) {
    // The same orders were card-paid in the last 30 minutes and that payment was
    // then voided. Don't silently re-use that charge, and don't charge again —
    // a person needs to decide (refund in Stripe? re-record?).
    return json({ error: `These orders were already charged (Stripe ${pi.id}) in the last 30 minutes and that payment was voided. Check Stripe before charging again.`, code: 'previous_charge_voided', paymentIntentId: pi.id }, 409)
  }
  if (existing) {
    return json({ success: true, recorded: true, replay: true, paymentIntentId: pi.id, paymentId: existing.id, amount: chargedAmount, card: cardLabel })
  }

  // ── Record it like a check: payments row + orders marked paid ──
  const { data: rec, error: recErr } = await db.rpc('record_account_payment', {
    p_order_ids:        orderIds,
    p_amount:           chargedAmount,
    p_method:           'card',
    p_reference:        pi.id,
    p_received_date:    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
    p_notes:            `${cardLabel} — charged by ${auth.actor.name}`,
    p_actor_name:       auth.actor.name,
    p_billing_group_id: null,
    p_customer_id:      customer.id,
  })

  if (recErr) {
    console.error('charge-account-payment: Stripe succeeded but record failed', { pi: pi.id, err: recErr.message })
    const who = `${customer.first_name_cache || ''} ${customer.last_name_cache || ''}`.trim()
    await sendAlertSms(trimForSms(
      `WashRoute: card charged $${chargedAmount.toFixed(2)} for ${who} (${orderNumText}) but the payment was NOT recorded. Stripe ${pi.id}. Error: ${recErr.message}`
    ), alertSmsConfigFromEnv((k) => Deno.env.get(k))).catch(() => {})
    return json({ success: true, recorded: false, recordError: recErr.message, paymentIntentId: pi.id, amount: chargedAmount, card: cardLabel })
  }

  return json({
    success: true,
    recorded: true,
    paymentIntentId: pi.id,
    paymentId: rec?.payment_id,
    amount: chargedAmount,
    settledCount: rec?.settled_count,
    skippedCount: rec?.skipped_count,
    card: cardLabel,
  })
})
