import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { addOneMonth, occurrencesInWindow, ptDate } from "../_shared/pause-window.ts"

// Session 345 — one-month subscription pause, customer self-serve.
//
//   POST { subscription_id, action: 'schedule' }  → pause starts when the paid month ends
//   POST { subscription_id, action: 'undo' }      → cancel a pause that has not started yet
//
// How a pause works (David, Oct 15 2026):
//   * The month already paid for is kept. The pause starts at current_period_end.
//   * Stripe: pause_collection { behavior: 'void', resumes_at: pause end − 1h }. The renewal
//     invoice raised at pause start is voided (no charge); collection resumes an hour before
//     the following renewal, so that renewal charges normally. Renewal day never moves.
//   * Repeating pickups: every occurrence inside the pause window is written to
//     recurring_skip_dates (note 'pause:<sub id>'), so the series jumps straight past the
//     pause. An order that ALREADY exists inside the window is skipped silently by
//     subscription-pause-tick at pause start (before the pricelist flips).
//   * Status 'paused', the customer's pricelist flip and the restart are done by
//     subscription-pause-tick (hourly), not here.
//
// The previous version of this function (pause_collection mark_uncollectible, immediate,
// open-ended) was dropped in session 165; it is kept in _to_delete/.

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
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const HOUR = 3600 * 1000

// Same ownership rule as resume-subscription / cancel-subscription.
async function assertOwnership(req: Request, subCustomerId: string): Promise<{ ok: true, actor: string } | { ok: false, status: number, msg: string }> {
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
  if (prof?.role === 'admin') return { ok: true, actor: 'Admin' };
  const { data: cust } = await adminClient.from('customers').select('id').eq('profile_id', callerUser.id).maybeSingle();
  if (!cust) return { ok: false, status: 403, msg: 'Forbidden' };
  if (cust.id !== subCustomerId) return { ok: false, status: 403, msg: 'Forbidden: not your subscription' };
  return { ok: true, actor: 'Customer' };
}

// Fail-closed staging kill-switch (Track A3) — copied from resume-subscription.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const db = createClient(supabaseUrl, supabaseServiceKey)
    const { subscription_id, action } = await req.json()
    if (!subscription_id) return json({ error: 'subscription_id is required' }, 400)
    if (action !== 'schedule' && action !== 'undo') return json({ error: "action must be 'schedule' or 'undo'" }, 400)

    const { data: sub, error: subErr } = await db.from('subscriptions')
      .select('id, stripe_subscription_id, customer_id, status, current_period_end, cancel_at_period_end, pause_starts_at, pause_ends_at')
      .eq('id', subscription_id)
      .single()
    if (subErr || !sub) return json({ error: 'Subscription not found' }, 404)
    if (!sub.stripe_subscription_id) return json({ error: 'No Stripe subscription ID on record' }, 400)

    const auth = await assertOwnership(req, sub.customer_id)
    if (!auth.ok) return json({ error: auth.msg }, auth.status)

    const envCheck = await assertProductionOrRefuse(db)
    if (!envCheck.ok) return json({ error: envCheck.reason }, 403)

    const now = new Date()
    const pending = sub.pause_starts_at && new Date(sub.pause_starts_at) > now

    // ── UNDO ──────────────────────────────────────────────────────────────
    if (action === 'undo') {
      if (!pending) return json({ error: sub.status === 'paused' ? 'Your pause has already started. It ends on its own.' : 'There is no pause to undo.' }, 409)

      const { error: logErr } = await db.from('subscription_usage_log').insert({
        subscription_id: sub.id, event_type: 'pause_cancelled',
        note: `${auth.actor} undid the pause planned ${ptDate(new Date(sub.pause_starts_at))} → ${ptDate(new Date(sub.pause_ends_at))}`,
      })
      if (logErr) return json({ error: 'Could not record the change: ' + logErr.message }, 500)

      await stripe.subscriptions.update(sub.stripe_subscription_id, { pause_collection: '' as any })

      const { error: skipErr } = await db.from('recurring_skip_dates')
        .delete().eq('note', `pause:${sub.id}`).is('used_at', null)
      if (skipErr) console.error('pause undo: skip-date cleanup failed', skipErr.message)

      const { error: upErr } = await db.from('subscriptions').update({
        pause_starts_at: null, pause_ends_at: null, pause_requested_at: null, pause_reminder_sent_at: null,
        updated_at: now.toISOString(),
      }).eq('id', sub.id)
      if (upErr) return json({ error: 'Stripe was updated but saving failed: ' + upErr.message }, 500)

      return json({ success: true, message: 'Pause cancelled' })
    }

    // ── SCHEDULE ──────────────────────────────────────────────────────────
    if (sub.status !== 'active') return json({ error: `Only an active plan can be paused (this one is ${sub.status}).` }, 409)
    if (sub.cancel_at_period_end) return json({ error: 'This plan is already set to end. Reactivate it before pausing.' }, 409)
    if (pending) return json({ error: 'A pause is already planned.' }, 409)

    // Stripe is the authority on when the paid month ends.
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
    if (stripeSub.status !== 'active') return json({ error: `Stripe shows this plan as ${stripeSub.status}; it can't be paused.` }, 409)
    if (stripeSub.pause_collection) return json({ error: 'Stripe already has a pause on this plan.' }, 409)
    const pauseStart = new Date(stripeSub.current_period_end * 1000)
    const pauseEnd   = addOneMonth(pauseStart)
    if (pauseStart.getTime() - now.getTime() < 2 * HOUR) {
      return json({ error: 'Your plan renews in less than 2 hours. Please pause after the renewal.' }, 409)
    }

    // Log first (CLAUDE.md: the log write is checked and the action stops if it fails).
    const { error: logErr } = await db.from('subscription_usage_log').insert({
      subscription_id: sub.id, event_type: 'pause_scheduled',
      note: `${auth.actor} paused: no charge ${ptDate(pauseStart)}, restarts ${ptDate(pauseEnd)}`,
    })
    if (logErr) return json({ error: 'Could not record the pause: ' + logErr.message }, 500)

    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: { behavior: 'void', resumes_at: Math.floor((pauseEnd.getTime() - HOUR) / 1000) },
    })

    const { error: upErr } = await db.from('subscriptions').update({
      pause_starts_at: pauseStart.toISOString(),
      pause_ends_at: pauseEnd.toISOString(),
      pause_requested_at: now.toISOString(),
      pause_reminder_sent_at: null,
      updated_at: now.toISOString(),
    }).eq('id', sub.id)
    if (upErr) {
      // Put Stripe back so the two never disagree.
      await stripe.subscriptions.update(sub.stripe_subscription_id, { pause_collection: '' as any })
      return json({ error: 'Saving the pause failed; nothing was changed. ' + upErr.message }, 500)
    }

    // Repeating pickups: plan skips for every occurrence in the window.
    const { data: series, error: serErr } = await db.from('orders')
      .select('pickup_address_id, recurring_interval, recurring_anchor_at, pickup_window_start')
      .eq('customer_id', sub.customer_id)
      .not('recurring_interval', 'is', null).neq('recurring_interval', '')
      .in('status', ['scheduled', 'on_hold'])
      .gt('pickup_window_start', now.toISOString())
    let planned = 0
    if (serErr) {
      console.error('pause: could not read repeating pickups', serErr.message)
    } else {
      const rows = occurrencesInWindow(series || [], pauseStart, pauseEnd).map(r => ({
        customer_id: sub.customer_id, pickup_address_id: r.pickup_address_id, skip_date: r.skip_date,
        note: `pause:${sub.id}`, created_by_name: `${auth.actor} (subscription pause)`,
      }))
      if (rows.length) {
        const { error: insErr } = await db.from('recurring_skip_dates').insert(rows)
        if (insErr) console.error('pause: planned skips insert failed', insErr.message)
        else planned = rows.length
      }
    }

    return json({
      success: true,
      pause_starts_at: pauseStart.toISOString(),
      pause_ends_at: pauseEnd.toISOString(),
      planned_pickup_skips: planned,
    })
  } catch (error: any) {
    console.error('pause-subscription error:', error)
    return json({ error: error.message }, 500)
  }
})
