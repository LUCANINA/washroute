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

// --- Staging kill-switch (Track A3, Aug 2026) ---------------------------
// Fail-closed: if we can't PROVE this project is production, refuse to
// mutate a real Stripe subscription. Never rely on client-side env
// detection — see WashRoute-Staging-Config-Scope.md and the Billing
// Boundary Rule in washroute-preflight: any plan/price that COULD charge
// WILL be charged unless blocked server-side.
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

// Verify the caller owns the subscription they're trying to mutate.
// (Session 134 — closes the security gap before the SUBSCRIPTIONS feature flag flips on.)
async function assertOwnership(req: Request, subCustomerId: string): Promise<{ ok: true, isStaff: boolean } | { ok: false, status: number, msg: string }> {
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
  if (prof?.role === 'admin' || prof?.role === 'manager') return { ok: true, isStaff: true };
  const { data: cust } = await adminClient.from('customers').select('id').eq('profile_id', callerUser.id).maybeSingle();
  if (!cust) return { ok: false, status: 403, msg: 'Forbidden' };
  if (cust.id !== subCustomerId) return { ok: false, status: 403, msg: 'Forbidden: not your subscription' };
  return { ok: true, isStaff: false };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, serviceKey)
    // v11 (session 190): `immediate` is now an explicit caller choice instead of being
    // inferred purely from payment status. Admin-dashboard's Cancel action offers two
    // distinct buttons — "Cancel immediately" and "Cancel at end of term" — and passes
    // this flag. Customer self-serve cancel (unchanged) doesn't send it, so it defaults
    // to false and keeps the existing graceful period-end behavior for everyone else.
    //
    // Background: this function previously had exactly one automatic behavior for a
    // paid-up subscription (always period-end) with no way for staff to override it.
    // Olivia Rosaldo-Pratt (Jul 2026) subscribed, was refunded $275 by staff who
    // intended to cancel her immediately, but the Cancel button silently took the
    // period-end path — she stayed "active" for another 3+ weeks. `immediate: true`
    // closes that gap.
    const { subscription_id, immediate: requestedImmediate } = await req.json()

    if (!subscription_id) throw new Error('subscription_id is required')

    const { data: sub, error: subErr } = await db.from('subscriptions')
      .select('id, stripe_subscription_id, customer_id, status')
      .eq('id', subscription_id)
      .single()

    if (subErr || !sub) throw new Error('Subscription not found')
    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription ID on record')

    const auth = await assertOwnership(req, sub.customer_id);
    if (!auth.ok) return new Response(JSON.stringify({ error: auth.msg }), { status: auth.status, headers: { ...cors, 'Content-Type': 'application/json' } });

    const envCheck = await assertProductionOrRefuse(db)
    if (!envCheck.ok) {
      console.warn('cancel-subscription blocked by staging kill-switch:', envCheck.reason)
      return new Response(JSON.stringify({ error: envCheck.reason }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Only staff (admin/manager) may request an immediate cancel on an otherwise
    // healthy subscription — a customer self-cancelling always gets the graceful
    // period-end path regardless of what's in the request body. Past-due and
    // not-yet-started (trialing) subscriptions are immediate for everyone since
    // there's no "term" worth protecting in either case.
    const callerRequestedImmediate = !!requestedImmediate && auth.isStaff

    const now = new Date().toISOString()

    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
    const isPastDue = sub.status === 'past_due' || stripeSub.status === 'past_due' || stripeSub.status === 'unpaid'
    // Session 190: a "scheduled" subscription (Feature 2 — customer picked a future
    // start date) is in Stripe's trial state until that date arrives. Nothing has been
    // charged yet, so there's no meaningful "period" to run out — cancelling one always
    // means "never start it," which is just an immediate cancel.
    const isTrialing = sub.status === 'trialing' || stripeSub.status === 'trialing'

    const doImmediate = isPastDue || isTrialing || callerRequestedImmediate

    if (doImmediate) {
      // Cancel now — no proration, no final invoice for time that hasn't happened yet.
      await stripe.subscriptions.cancel(sub.stripe_subscription_id, {
        invoice_now: false,
        prorate: false,
      })

      // Void any open invoices on this subscription (relevant for past-due; harmless
      // no-op for a healthy or trialing sub which normally has none open).
      const openInvoices = await stripe.invoices.list({
        subscription: sub.stripe_subscription_id,
        status: 'open',
        limit: 10,
      })
      for (const inv of openInvoices.data) {
        await stripe.invoices.voidInvoice(inv.id)
        console.log('Voided open invoice on immediate cancel:', inv.id, 'amount:', (inv.amount_due || 0) / 100)
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

      const reason = isPastDue ? 'past_due' : isTrialing ? 'trialing_scheduled' : 'staff_immediate'
      console.log('Subscription cancelled immediately:', subscription_id, sub.stripe_subscription_id, 'reason:', reason, 'invoices voided:', openInvoices.data.length)

      const message = isPastDue
        ? 'Subscription cancelled immediately; unpaid invoice voided'
        : isTrialing
          ? 'Scheduled subscription cancelled — it never started, nothing was charged'
          : 'Subscription cancelled immediately'

      return new Response(JSON.stringify({ success: true, immediate: true, reason, message }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // Healthy subscription, no immediate override requested — graceful cancel at
    // period end, unchanged from prior behavior.
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
