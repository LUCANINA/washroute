import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Session 167 — Nightly E2E smoke test (v2).
//
// Runs at 3am PT via pg_cron. Verifies the customer-app booking happy-path
// at the SCHEMA + SERVICE-RESOLUTION layers (the most common HOTFIX class).
// Direct INSERT instead of calling create_order_for_customer RPC because that
// RPC requires auth.uid() which is NULL when called by service_role.
//
// What this catches (the bug classes that matter most):
//   - defaultService picks wrong row (yesterday's HOTFIX): asserts the
//     Delivery W&F service is uniquely resolvable + has base_price > 0
//   - Schema drift: INSERT fails if any required column is missing or wrong type
//   - Trigger misfires: if a trigger crashes on insert, the smoke test catches it
//   - Delivery Fee lookup: asserts the global Delivery Fee row still exists
//   - Duplicate-services collision (HOTFIX class): explicit audit query
//
// What this does NOT catch:
//   - JS-only bugs in customer-app (covered by manual hard-reload testing)
//   - Auth-gated RPC behavior (separate test would need a real customer JWT)
//
// Any failure → SMS alert to ALERT_PHONE via Twilio direct.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ALERT_PHONE = Deno.env.get('ALERT_PHONE') || '+14156085446'

const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || ''
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || ''
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TEST_CUSTOMER_ID = 'a0603a34-d9e2-4bf2-ad27-7709c95c2024'  // dmacquart+wrsignup1@gmail.com
const TEST_ADDRESS_ID  = '85ef4d97-637b-47a9-b9e6-901750d04de8'  // default address on that account
const SMOKE_MARKER = 'WR-SMOKE-TEST'

async function sendAlertSms(body: string): Promise<{ ok: boolean }> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return { ok: false }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`
  let phone = ALERT_PHONE.replace(/[^\d+]/g, '')
  if (phone && !phone.startsWith('+')) phone = '+1' + phone.slice(-10)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`) },
      body: new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: body }).toString(),
    })
    return { ok: res.ok }
  } catch { return { ok: false } }
}

async function logResult(db: any, ok: boolean, severity: string, message: string, context: any) {
  await db.from('_health_alerts').insert({
    alert_type: ok ? 'smoke_test_pass' : 'smoke_test_fail',
    severity, message, context,
    sent_sms: !ok,
    sent_to: ok ? null : ALERT_PHONE,
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const db = createClient(supabaseUrl, supabaseKey)
  const startedAt = new Date()

  const fail = async (step: string, err: any) => {
    const msg = `⚠️ WashRoute smoke test FAILED at "${step}": ${err?.message || JSON.stringify(err)}`
    await sendAlertSms(msg)
    await logResult(db, false, 'critical', msg, { step, err: String(err?.message || JSON.stringify(err)) })
    return new Response(JSON.stringify({ ok: false, step, error: String(err?.message || err) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  let createdOrderId: string | null = null
  try {
    const { data: pre } = await db.from('addresses')
      .select('id, customer_id').eq('id', TEST_ADDRESS_ID).eq('customer_id', TEST_CUSTOMER_ID).maybeSingle()
    if (!pre) return fail('pre-flight', new Error('Test customer/address row not found'))

    const { data: svcs } = await db.from('services')
      .select('id, name, base_price, pricelist, sort_order')
      .eq('pricelist', 'Delivery').eq('is_active', true).eq('is_addon', false).eq('show_in_app', true)
      .order('sort_order')
    if (!svcs || svcs.length === 0) return fail('service lookup', new Error('No Delivery Wash & Fold service is_active=true + show_in_app=true'))
    if (svcs.length > 1) return fail('service collision', new Error(`Multiple Delivery W&F services (${svcs.length}) found — .find() could pick the wrong one`))
    const svc = svcs[0]
    const expectedBase = Number(svc.base_price)
    if (!(expectedBase > 0)) return fail('service price', new Error(`Delivery W&F base_price is ${expectedBase} (expected > 0)`))

    const { data: dupRows } = await db.rpc('audit_duplicate_services')
    if (dupRows && dupRows.length > 0) {
      return fail('audit_duplicate_services', new Error(`Duplicate services in shared lookup table: ${JSON.stringify(dupRows)}`))
    }

    const { data: deliveryFee } = await db.from('service_fees')
      .select('id, amount, pricelist').eq('name', 'Delivery Fee').is('pricelist', null).maybeSingle()
    if (!deliveryFee) return fail('delivery fee', new Error('Global Delivery Fee row missing'))

    // 4b. Stripe→DB seam health (session 168, A5) — any active subscription with
    // no invoice recorded for its current period is the signature of the
    // webhook signing-secret drift that forced the June 2 backfill. Alert on it.
    const { data: missingInv } = await db.rpc('audit_subscriptions_missing_invoice')
    if (missingInv && missingInv.length > 0) {
      return fail('stripe seam — subscription invoice missing', new Error(`${missingInv.length} active subscription(s) have no recorded invoice for the current period — possible stripe-webhook signature/secret drift: ${JSON.stringify(missingInv)}`))
    }

    // 4c. Cancel→revert health (session 168) — any customer left on the $0
    // 'Subscription' pricelist with NO active subscription is getting free
    // service. Signature of a missed customer.subscription.deleted webhook at
    // period end, or a self-referential previous_pricelist snapshot. Alert on it.
    const { data: plOrphans } = await db.rpc('audit_subscription_pricelist_orphans')
    if (plOrphans && plOrphans.length > 0) {
      return fail('subscription pricelist orphan', new Error(`${plOrphans.length} customer(s) on the $0 Subscription pricelist with no active subscription — cancel→revert failure (free service): ${JSON.stringify(plOrphans)}`))
    }

    const tomorrow = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000)
    const pickupStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 20, 0, 0)
    const pickupEnd   = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 22, 0, 0)

    const totalBags = 1
    const baseAmount = totalBags * expectedBase
    const lineItems = [
      { type: 'base', label: `Wash & Fold · ${totalBags} bag × $${expectedBase.toFixed(2)}`, amount: baseAmount, taxable: false },
      { type: 'delivery_fee', label: 'Delivery fee', amount: Number(deliveryFee.amount), taxable: false },
    ]
    const total = baseAmount + Number(deliveryFee.amount)

    const { data: order, error: insErr } = await db.from('orders').insert({
      customer_id:           TEST_CUSTOMER_ID,
      service_id:            svc.id,
      status:                'scheduled',
      source:                'customer_app',
      total_bags:            totalBags,
      total_amount:          total,
      pickup_address_id:     TEST_ADDRESS_ID,
      delivery_address_id:   TEST_ADDRESS_ID,
      pickup_window_start:   pickupStart.toISOString(),
      pickup_window_end:     pickupEnd.toISOString(),
      line_items:            lineItems,
      special_instructions:  SMOKE_MARKER,
    }).select('id, total_amount, line_items').single()
    if (insErr || !order) return fail('order insert', insErr || new Error('No order returned'))
    createdOrderId = order.id

    if (Math.abs(Number(order.total_amount) - total) > 0.01) return fail('total mismatch', new Error(`total_amount ${order.total_amount} ≠ expected ${total}`))

    const { error: delErr } = await db.from('orders').delete().eq('id', createdOrderId).eq('special_instructions', SMOKE_MARKER)
    if (delErr) return fail('cleanup delete', delErr)

    const durationMs = Date.now() - startedAt.getTime()
    await logResult(db, true, 'info', `Smoke test passed in ${durationMs}ms`, { durationMs, baseAmount, total, serviceId: svc.id, deliveryFeeId: deliveryFee.id })
    return new Response(JSON.stringify({ ok: true, durationMs, orderId: createdOrderId, total }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (err: any) {
    if (createdOrderId) {
      try { await db.from('orders').delete().eq('id', createdOrderId).eq('special_instructions', SMOKE_MARKER) } catch (_) {}
    }
    return fail('unhandled', err)
  }
})
