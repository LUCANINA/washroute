import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

// ── Caller authorization (session 293) ─────────────────────────────────────
// These card functions run with the service-role key, so they MUST prove the
// caller may act on `customerId`: either the signed-in customer who owns that
// customer row, or a staff member. The anon key alone is rejected.
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SVC_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const CARD_STAFF_ROLES  = new Set(['admin', 'manager', 'attendant', 'laundry_tech'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Authz = { ok: true; staff: boolean } | { ok: false; status: number; reason: string }

async function authorizeForCustomer(req: Request, customerId: unknown): Promise<Authz> {
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) {
    return { ok: false, status: 400, reason: 'A valid customer id is required' }
  }
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Please sign in' }
  const jwt = m[1]
  if (jwt === SUPABASE_SVC_KEY) return { ok: true, staff: true }
  if (jwt === SUPABASE_ANON_KEY) return { ok: false, status: 401, reason: 'Please sign in' }

  const admin = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
  const { data: { user }, error } = await admin.auth.getUser(jwt)
  if (error || !user) return { ok: false, status: 401, reason: 'Your session has expired. Please sign in again.' }

  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (profile && CARD_STAFF_ROLES.has(profile.role)) return { ok: true, staff: true }

  const { data: own } = await admin.from('customers').select('id')
    .eq('id', customerId).eq('profile_id', user.id).maybeSingle()
  if (!own) return { ok: false, status: 403, reason: 'Not allowed' }
  return { ok: true, staff: false }
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Make `pmId` the customer's only default, in our table, the customers flat
// columns, and Stripe.
async function setDefault(db: any, customerId: string, stripeCustomerId: string, pmId: string, card: any) {
  await db.from('customer_payment_methods').update({ is_default: false })
    .eq('customer_id', customerId).neq('stripe_payment_method_id', pmId)
  await db.from('customer_payment_methods').update({ is_default: true })
    .eq('customer_id', customerId).eq('stripe_payment_method_id', pmId)
  await stripe.customers.update(stripeCustomerId, { invoice_settings: { default_payment_method: pmId } })
  await db.from('customers').update({
    stripe_default_payment_method_id: pmId,
    card_last4: card.last4, card_brand: card.brand,
    card_exp_month: card.exp_month, card_exp_year: card.exp_year,
    updated_at: new Date().toISOString(),
  }).eq('id', customerId)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const { customerId, paymentMethodId, makeDefault } = await req.json()
    const auth = await authorizeForCustomer(req, customerId)
    if (!auth.ok) return json({ error: auth.reason }, auth.status)
    if (typeof paymentMethodId !== 'string' || !/^pm_[A-Za-z0-9]+$/.test(paymentMethodId)) {
      return json({ error: 'A valid payment method is required' }, 400)
    }

    const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
    const { data: customer } = await db.from('customers')
      .select('id, stripe_customer_id').eq('id', customerId).single()
    if (!customer) return json({ error: 'Customer not found' }, 404)
    if (!customer.stripe_customer_id) return json({ error: 'Card setup was not started for this account' }, 400)

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId)
    // Session 293: only real cards (incl. Apple/Google Pay). Link wallets came back
    // with placeholder details (LINK •••• 0000, 12/40) and may debit a bank account.
    if (pm.type !== 'card' || !pm.card || pm.card.brand === 'link') {
      return json({ error: 'Please add a debit or credit card.' }, 400)
    }
    if (pm.customer && pm.customer !== customer.stripe_customer_id) {
      return json({ error: 'Not allowed' }, 403)
    }
    const card = pm.card
    if (!pm.customer) {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.stripe_customer_id })
    }

    const { data: existing } = await db.from('customer_payment_methods')
      .select('stripe_payment_method_id, is_default').eq('customer_id', customerId)
    const rows = existing || []

    // Same physical card already saved? Keep the old one, drop the new duplicate.
    if (card.fingerprint && rows.length) {
      const saved = new Set(rows.map((r: any) => r.stripe_payment_method_id))
      const list = await stripe.paymentMethods.list({ customer: customer.stripe_customer_id, type: 'card', limit: 100 })
      const dup = list.data.find((p: any) => p.id !== paymentMethodId && saved.has(p.id)
        && p.card?.fingerprint === card.fingerprint
        && p.card?.exp_month === card.exp_month && p.card?.exp_year === card.exp_year)
      if (dup) {
        try { await stripe.paymentMethods.detach(paymentMethodId) } catch (_) { /* best effort */ }
        const wasDefault = rows.find((r: any) => r.stripe_payment_method_id === dup.id)?.is_default
        if (makeDefault && !wasDefault) await setDefault(db, customerId, customer.stripe_customer_id, dup.id, dup.card)
        return json({
          success: true, duplicate: true, isDefault: !!(makeDefault || wasDefault),
          card: { last4: dup.card!.last4, brand: dup.card!.brand, exp_month: dup.card!.exp_month,
                  exp_year: dup.card!.exp_year, stripe_payment_method_id: dup.id },
        })
      }
    }

    const others = rows.filter((r: any) => r.stripe_payment_method_id !== paymentMethodId)
    const becomeDefault = others.length === 0 || makeDefault === true

    const { error: upsertErr } = await db.from('customer_payment_methods').upsert({
      customer_id: customerId,
      stripe_payment_method_id: paymentMethodId,
      card_brand: card.brand,
      card_last4: card.last4,
      card_exp_month: card.exp_month,
      card_exp_year: card.exp_year,
      is_default: others.length === 0,
    }, { onConflict: 'stripe_payment_method_id' })
    if (upsertErr) throw new Error('Failed to save card: ' + upsertErr.message)

    if (becomeDefault) await setDefault(db, customerId, customer.stripe_customer_id, paymentMethodId, card)

    console.log('Card saved', customerId, card.brand, card.last4, 'default:', becomeDefault, 'wallet:', card.wallet?.type || '-')
    return json({
      success: true, isDefault: becomeDefault,
      card: { last4: card.last4, brand: card.brand, exp_month: card.exp_month, exp_year: card.exp_year,
              wallet: card.wallet?.type || null, stripe_payment_method_id: paymentMethodId },
    })
  } catch (err: any) {
    console.error('save-payment-method error:', err)
    return json({ error: err.message || 'Could not save card' }, 500)
  }
})
