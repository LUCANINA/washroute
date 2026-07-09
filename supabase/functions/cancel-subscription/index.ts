import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Verify the caller owns the subscription they're trying to mutate.
// (Session 134 — closes the security gap before the SUBSCRIPTIONS feature flag flips on.)
async function assertOwnership(req: Request, subCustomerId: string): Promise<{ ok: true } | { ok: false, status: number, msg: string }> {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return { ok: false, status: 401, msg: 'Unauthorized' };
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${tok}` } },
  });
  const { data: { user: callerUser } } = await callerClient.auth.getUser();
  if (!callerUser) return { ok: false, status: 401, msg: 'Unauthorized' };
  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: prof } = await adminClient.from('profiles').select('role').eq('id', callerUser.id).single();
  if (prof?.role === 'admin') return { ok: true };
  const { data: cust } = await adminClient.from('customers').select('id').eq('profile_id', callerUser.id).maybeSingle();
  if (!cust) return { ok: false, status: 403, msg: 'Forbidden' };
  if (cust.id !== subCustomerId) return { ok: false, status: 403, msg: 'Forbidden: not your subscription' };
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, serviceKey)
    const { subscription_id } = await req.json()

    if (!subscription_id) throw new Error('subscription_id is required')

    const { data: sub, error: subErr } = await db.from('subscriptions')
      .select('id, stripe_subscription_id, customer_id, status')
      .eq('id', subscription_id)
      .single()

    if (subErr || !sub) throw new Error('Subscription not found')
    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription ID on record')

    const auth = await assertOwnership(req, sub.customer_id);
    if (!auth.ok) return new Response(JSON.stringify({ error: auth.msg }), { status: auth.status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const now = new Date().toISOString()

    // v10 (session 178): PAST-DUE subscriptions cancel IMMEDIATELY and their unpaid
    // renewal invoice(s) are voided. Rationale: the renewal payment already failed —
    // "cancel at period end" would keep Stripe dunning the customer's card all month
    // for a period they're cancelling out of (Maria Markison, Jul 2026). The
    // stripe-webhook customer.subscription.deleted handler does the full bookkeeping
    // (final overage invoice, pricelist restore, dunning clear); the local update
    // below is an optimistic mirror so the UI reflects the cancel instantly.
    // Stripe status can drift from our cache, so check BOTH sides.
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
    const isPastDue = sub.status === 'past_due' || stripeSub.status === 'past_due' || stripeSub.status === 'unpaid'

    if (isPastDue) {
      // Cancel now — no proration, no final invoice for the unpaid period.
      await stripe.subscriptions.cancel(sub.stripe_subscription_id, {
        invoice_now: false,
        prorate: false,
      })

      // Void every open invoice on this subscription so Stripe stops retrying the card.
      const openInvoices = await stripe.invoices.list({
        subscription: sub.stripe_subscription_id,
        status: 'open',
        limit: 10,
      })
      for (const inv of openInvoices.data) {
        await stripe.invoices.voidInvoice(inv.id)
        console.log('Voided unpaid invoice on past-due cancel:', inv.id, 'amount:', (inv.amount_due || 0) / 100)
      }

      // Optimistic local update — the customer.subscription.deleted webhook writes
      // the same terminal state (idempotent) plus pricelist/plan cleanup.
      await db.from('subscriptions').update({
        status: 'cancelled',
        cancelled_at: now,
        cancel_at_period_end: false,
        dunning_started_at: null,
        updated_at: now,
      }).eq('id', subscription_id)

      console.log('Past-due subscription cancelled immediately:', subscription_id, sub.stripe_subscription_id, 'invoices voided:', openInvoices.data.length)

      return new Response(JSON.stringify({ success: true, immediate: true, message: 'Subscription cancelled immediately; unpaid invoice voided' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Active (paid-up) subscription — graceful cancel at period end, unchanged.
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    })

    await db.from('subscriptions').update({
      cancel_at_period_end: true,
      updated_at: now,
    }).eq('id', subscription_id)

    console.log('Subscription marked for cancellation at period end:', subscription_id, sub.stripe_subscription_id)

    return new Response(JSON.stringify({ success: true, immediate: false, message: 'Subscription will cancel at period end' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('cancel-subscription error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
