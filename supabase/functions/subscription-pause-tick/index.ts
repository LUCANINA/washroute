import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Session 345 — runs hourly from pg_cron (job wr-subscription-pause-tick).
// AUTH  x-wr-internal header only. verify_jwt must be FALSE (deploy with --no-verify-jwt).
//
// Three passes, each idempotent:
//   1. START   pause_starts_at has passed, status still 'active'
//              a) silently skip repeating orders that already exist inside the window
//                 (while the plan is still active, so the series' next order is created with
//                 plan pricing — and lands after the pause thanks to the planned skips)
//              b) customer pricelist → previous_pricelist (pay-per-bag while paused)
//              c) status 'paused'
//              d) re-aim Stripe resumes_at at the REAL next renewal (the webhook has synced it)
//   2. REMIND  paused, restart within 3 days, not yet reminded → one email
//   3. END     paused and pause_ends_at has passed → pricelist 'Subscription', status from Stripe
//
// POST { dry_run: true } reports what each pass WOULD do and changes nothing.

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const HOUR = 3600 * 1000
const BIZ_TZ = 'America/Los_Angeles'
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const niceDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { timeZone: BIZ_TZ, weekday: 'long', month: 'long', day: 'numeric' })

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
  return !!data?.secret && provided === data.secret
}

async function isProduction(): Promise<boolean> {
  const { data, error } = await db.from('settings').select('wr_environment').eq('id', 1).single()
  return !error && data?.wr_environment === 'production'
}

async function log(subId: string, event_type: string, note: string) {
  const { error } = await db.from('subscription_usage_log').insert({ subscription_id: subId, event_type, note })
  if (error) throw new Error(`usage log (${event_type}) failed: ${error.message}`)
}

// ── 1. START ────────────────────────────────────────────────────────────────
async function startPause(sub: any, dry: boolean) {
  if (sub.cancel_at_period_end) return { sub: sub.id, skipped: 'plan set to end — no pause' }
  const { data: inWindow, error: owErr } = await db.from('orders')
    .select('id, order_number, pickup_window_start')
    .eq('customer_id', sub.customer_id)
    .not('recurring_interval', 'is', null).neq('recurring_interval', '')
    .in('status', ['scheduled', 'on_hold'])
    .gte('pickup_window_start', sub.pause_starts_at)
    .lt('pickup_window_start', sub.pause_ends_at)
  if (owErr) throw new Error('reading repeating orders: ' + owErr.message)

  const { data: cust, error: cErr } = await db.from('customers').select('id, pricelist').eq('id', sub.customer_id).single()
  if (cErr || !cust) throw new Error('customer not found')
  const restorePl = sub.previous_pricelist && sub.previous_pricelist !== 'Subscription' ? sub.previous_pricelist : 'Delivery'

  if (dry) return { sub: sub.id, would_skip_orders: (inWindow || []).map((o: any) => o.order_number), pricelist: `${cust.pricelist} → ${restorePl}` }

  await log(sub.id, 'pause_started', `Paused until ${new Date(sub.pause_ends_at).toISOString().slice(0, 10)}; ${inWindow?.length || 0} repeating pickup(s) skipped; pricelist → ${restorePl}`)

  for (const o of inWindow || []) {
    const { error } = await db.rpc('advance_order_status', {
      p_order_id: o.id, p_new_status: 'skipped', p_actor_name: 'System (subscription paused)',
      p_cancelled_by: 'system', p_notify_sms: false,
    })
    if (error) throw new Error(`skipping order #${o.order_number}: ${error.message}`)
  }

  const { error: plErr } = await db.from('customers').update({ pricelist: restorePl, updated_at: new Date().toISOString() }).eq('id', sub.customer_id)
  if (plErr) throw new Error('pricelist switch: ' + plErr.message)

  // The webhook has normally synced the new period by now; that period's end IS the restart.
  let pauseEnds = sub.pause_ends_at
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
  const realNext = new Date(stripeSub.current_period_end * 1000)
  if (realNext > new Date(sub.pause_starts_at) && Math.abs(realNext.getTime() - new Date(sub.pause_ends_at).getTime()) > HOUR) {
    pauseEnds = realNext.toISOString()
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      pause_collection: { behavior: 'void', resumes_at: Math.floor((realNext.getTime() - HOUR) / 1000) },
    })
  }

  const { error: sErr } = await db.from('subscriptions').update({
    status: 'paused', paused_at: new Date().toISOString(), pause_ends_at: pauseEnds, updated_at: new Date().toISOString(),
  }).eq('id', sub.id)
  if (sErr) throw new Error('status update: ' + sErr.message)

  return { sub: sub.id, skipped_orders: (inWindow || []).map((o: any) => o.order_number), pricelist: restorePl, pause_ends_at: pauseEnds }
}

// ── 2. REMIND ───────────────────────────────────────────────────────────────
const escHtml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function reminderHtml(rawFirstName: string, restartIso: string, price: number) {
  const firstName = escHtml(rawFirstName)
  const day = niceDate(restartIso)
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your plan restarts ${day}</title></head>
<body style="margin:0;padding:0;background:#eef0f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f4;padding:28px 14px;"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:520px;width:100%;">
<tr><td style="background:#1f2a4d;padding:18px 26px;color:#fff;font-weight:800;letter-spacing:.06em;text-transform:uppercase;font-size:14px;">Family Laundry<div style="font-weight:500;letter-spacing:.02em;text-transform:none;color:#c9cfe3;font-size:11px;">Oakland, CA</div></td></tr>
<tr><td style="padding:24px 26px 8px;font-size:14px;line-height:1.6;color:#374151;">
Hi ${firstName || 'there'}, your one-month pause is almost over.
<div style="background:#fbf6f1;border-radius:8px;padding:18px;margin:16px 0;text-align:center;">
<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#8a8f9c;">Your plan restarts</div>
<div style="font-size:26px;font-weight:900;color:#1f2a4d;margin-top:4px;">${day}</div>
<div style="font-size:13px;color:#6b7280;margin-top:4px;">$${price.toFixed(2)} will be charged to your card on file that day</div></div>
From then on your pickups are back on the plan: 100 lbs a month and free delivery. Your repeating pickup starts again on its usual day.
<div style="border:1px solid #f3c9d5;background:#fff8fa;border-radius:8px;padding:12px 14px;margin:16px 0;font-size:13.5px;color:#4b2a35;">Not ready to restart? You can cancel in the app before ${day} under Account &rarr; Subscription.</div>
<div style="text-align:center;margin:18px 0 8px;"><a href="https://app.familylaundry.com" style="display:inline-block;background:#1f2a4d;color:#fff;text-decoration:none;font-weight:700;border-radius:999px;padding:11px 22px;font-size:14px;">Open the app</a></div>
</td></tr>
<tr><td style="padding:18px 26px 22px;border-top:1px solid #f3f4f6;font-size:11.5px;color:#9ca3af;text-align:center;line-height:1.7;">Questions? Reply to this email or visit app.familylaundry.com<br>Family Laundry &middot; 2609 Foothill Blvd, Oakland CA 94601</td></tr>
</table></td></tr></table></body></html>`
}

async function remind(sub: any, dry: boolean) {
  const { data: cust } = await db.from('customers').select('id, email_cache, first_name_cache').eq('id', sub.customer_id).single()
  const { data: plan } = await db.from('subscription_plans').select('price_monthly').eq('id', sub.plan_id).maybeSingle()
  const price = Number(plan?.price_monthly || 275)
  if (!cust?.email_cache) return { sub: sub.id, skipped: 'no email on file' }
  if (dry) return { sub: sub.id, would_email: cust.email_cache, restart: sub.pause_ends_at }

  // Claim first so a slow send can never go out twice.
  const { data: claimed, error: clErr } = await db.from('subscriptions')
    .update({ pause_reminder_sent_at: new Date().toISOString() })
    .eq('id', sub.id).is('pause_reminder_sent_at', null).select('id')
  if (clErr) throw new Error('reminder claim: ' + clErr.message)
  if (!claimed?.length) return { sub: sub.id, skipped: 'already reminded' }

  const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({
      customer_id: cust.id, to_email: cust.email_cache,
      subject: `Your Family Laundry plan restarts ${niceDate(sub.pause_ends_at)}`,
      body: reminderHtml(cust.first_name_cache || '', sub.pause_ends_at, price),
    }),
  })
  if (!r.ok) {
    await db.from('subscriptions').update({ pause_reminder_sent_at: null }).eq('id', sub.id) // retry next hour
    throw new Error(`reminder email failed: ${r.status} ${await r.text()}`)
  }
  return { sub: sub.id, emailed: cust.email_cache }
}

// ── 3. END ──────────────────────────────────────────────────────────────────
async function endPause(sub: any, dry: boolean) {
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
  if (stripeSub.status === 'canceled' || stripeSub.cancel_at_period_end) {
    // The customer cancelled during the pause: stripe-webhook (subscription.deleted) restores
    // their pricelist and marks the row cancelled. Nothing to restart.
    return { sub: sub.id, skipped: 'cancelled during pause — left to the webhook' }
  }
  const status = (stripeSub.status === 'past_due' || stripeSub.status === 'unpaid') ? 'past_due' : 'active'
  if (dry) return { sub: sub.id, would_restart: status, pause_collection_still_set: !!stripeSub.pause_collection }

  await log(sub.id, 'pause_ended', `Plan restarted (${status})`)
  if (stripeSub.pause_collection) {
    await stripe.subscriptions.update(sub.stripe_subscription_id, { pause_collection: '' as any })
  }
  const { error: plErr } = await db.from('customers').update({ pricelist: 'Subscription', updated_at: new Date().toISOString() }).eq('id', sub.customer_id)
  if (plErr) throw new Error('pricelist restore: ' + plErr.message)
  const { error: sErr } = await db.from('subscriptions').update({ status, paused_at: null, updated_at: new Date().toISOString() }).eq('id', sub.id)
  if (sErr) throw new Error('status update: ' + sErr.message)
  return { sub: sub.id, restarted: status }
}

Deno.serve(async (req) => {
  if (!(await isInternalCall(req))) return json({ error: 'forbidden' }, 403)
  let dry = false
  try { dry = !!(await req.json())?.dry_run } catch { /* empty body */ }
  if (!dry && !(await isProduction())) return json({ error: 'staging kill-switch: not production' }, 403)

  const now = new Date()
  const cols = 'id, customer_id, plan_id, stripe_subscription_id, status, previous_pricelist, pause_starts_at, pause_ends_at, pause_reminder_sent_at, cancel_at_period_end'
  const out: Record<string, unknown[]> = { started: [], reminded: [], ended: [], errors: [] }

  const run = async (bucket: string, rows: any[] | null, fn: (s: any, d: boolean) => Promise<unknown>) => {
    for (const s of rows || []) {
      try { out[bucket].push(await fn(s, dry)) }
      catch (e: any) { console.error(`pause-tick ${bucket} ${s.id}:`, e.message); out.errors.push({ sub: s.id, pass: bucket, error: e.message }) }
    }
  }

  const { data: toStart } = await db.from('subscriptions').select(cols)
    .eq('status', 'active').not('pause_starts_at', 'is', null).is('paused_at', null)
    .lte('pause_starts_at', now.toISOString()).gt('pause_ends_at', now.toISOString())
  await run('started', toStart, startPause)

  const { data: toRemind } = await db.from('subscriptions').select(cols)
    .eq('status', 'paused').is('pause_reminder_sent_at', null)
    .gt('pause_ends_at', now.toISOString())
    .lte('pause_ends_at', new Date(now.getTime() + 72 * HOUR).toISOString())
  await run('reminded', toRemind, remind)

  const { data: toEnd } = await db.from('subscriptions').select(cols)
    // paused_at marks a pause in progress (set at START, cleared at END). Not filtered on
    // status: the renewal webhook may already have flipped the row to 'active' — the
    // pricelist still has to come back.
    .not('paused_at', 'is', null).not('pause_ends_at', 'is', null)
    .lte('pause_ends_at', now.toISOString())
  await run('ended', toEnd, endPause)

  console.log('pause-tick', JSON.stringify({ dry, ...Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])) }))
  return json({ dry_run: dry, ...out })
})
