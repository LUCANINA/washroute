import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Copied verbatim from resume-subscription / cancel-subscription so the three
// sibling endpoints enforce identical ownership rules. Without it anyone could
// pause any customer's subscription (mark_uncollectible) with just its UUID.
async function assertOwnership(req: Request, subCustomerId: string): Promise<{ ok: true } | { ok: false, status: number, msg: string }> {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return { ok: false, status: 401, msg: 'Unauthorized' };
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${tok}` } },
  });
  const { data: { user: callerUser } } = await callerClient.auth.getUser();
  if (!callerUser) return { ok: false, status: 401, msg: 'Unauthorized' };
  const adminClient = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });
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
    const db = createClient(supabaseUrl, supabaseServiceKey)
    const { subscription_id } = await req.json()

    if (!subscription_id) throw new Error('subscription_id is required')

    // Load subscription to verify it exists and get stripe_subscription_id
    const { data: sub, error: subErr } = await db.from('subscriptions')
      .select('id, stripe_subscription_id, customer_id')
      .eq('id', subscription_id)
      .single()

    if (subErr || !sub) throw new Error('Subscription not found')
    if (!sub.stripe_subscription_id) throw new Error('No Stripe subscription ID on record')

    const auth = await assertOwnership(req, sub.customer_id);
    if (!auth.ok) return new Response(JSON.stringify({ error: auth.msg }), { status: auth.status, headers: { ...cors, 'Content-Type': 'application/json' } });

    // Call Stripe to pause the subscription
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: {
        behavior: 'mark_uncollectible',
      },
    })

    // Update DB: mark as paused
    const now = new Date().toISOString()
    await db.from('subscriptions').update({
      status: 'paused',
      paused_at: now,
      updated_at: now,
    }).eq('id', subscription_id)

    console.log('Subscription paused:', subscription_id, sub.stripe_subscription_id)

    return new Response(JSON.stringify({
      success: true,
      message: 'Subscription paused',
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    console.error('pause-subscription error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
