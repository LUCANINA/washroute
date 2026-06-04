import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Session 167 — production health monitor.
//
// Triggered by pg_cron every 15 minutes. Compares current order-rate to the
// baseline (same window 24h prior). Sends SMS to ALERT_PHONE if it detects:
//   (a) Zero customer-app orders in the last 60 min AND baseline >= 3
//   (b) >= 80% drop from baseline AND baseline >= 5
//
// Business hours only (Pacific 8am - 9pm). Outside that window: silent unless
// SEVERE drop (which catches the 'overnight outage that should have orders').
//
// Dedup: won't re-fire the same alert_type within 60 min (read from _health_alerts).
//
// This would have caught yesterday's HOTFIX class (15 rejected orders, 7 hour
// silence) within ~30-60 min of onset.

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ALERT_PHONE = Deno.env.get('ALERT_PHONE') || '+14156085446'  // David's phone, fallback
const MONITOR_SECRET = Deno.env.get('HEALTH_MONITOR_SECRET') || ''

const TWILIO_SID = Deno.env.get('TWILIO_ACCOUNT_SID') || ''
const TWILIO_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN') || ''
const TWILIO_FROM = Deno.env.get('TWILIO_PHONE_NUMBER') || ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function sendAlertSms(body: string): Promise<{ ok: boolean; reason?: string; sid?: string }> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return { ok: false, reason: 'twilio_not_configured' }
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`
  let phone = ALERT_PHONE.replace(/[^\d+]/g, '')
  if (phone && !phone.startsWith('+')) phone = '+1' + phone.slice(-10)
  if (!phone || phone.length < 10) return { ok: false, reason: 'invalid_alert_phone' }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`),
    },
    body: new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: body }).toString(),
  })
  const data = await res.json()
  if (!res.ok) return { ok: false, reason: data.message || `twilio_${res.status}` }
  return { ok: true, sid: data.sid }
}

function pacificHour(d: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Los_Angeles' })
  const parts = fmt.formatToParts(d)
  return parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const body = await req.json().catch(() => ({}))
    if (MONITOR_SECRET && body.secret !== MONITOR_SECRET) {
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const db = createClient(supabaseUrl, supabaseKey)
    const now = new Date()
    const hourPT = pacificHour(now)
    const inBusinessHours = hourPT >= 8 && hourPT < 21

    const sixtyMinAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const dayAgo60 = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const dayAgo60Plus = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString()

    const { count: currentCount } = await db.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'customer_app')
      .gte('created_at', sixtyMinAgo)

    const { count: baselineCount } = await db.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'customer_app')
      .gte('created_at', dayAgo60)
      .lt('created_at', dayAgo60Plus)

    const current = currentCount ?? 0
    const baseline = baselineCount ?? 0

    let alertType: string | null = null
    let severity: 'info' | 'warn' | 'critical' = 'info'
    let alertMessage = ''

    if (inBusinessHours) {
      if (current === 0 && baseline >= 3) {
        alertType = 'orders_zero_in_business_hours'
        severity = 'critical'
        alertMessage = `⚠️ WashRoute alert: 0 customer-app orders in the last hour (normally ${baseline}). Check the app + Postgres logs.`
      } else if (baseline >= 5 && current <= Math.floor(baseline * 0.2)) {
        alertType = 'orders_drop_severe'
        severity = 'critical'
        alertMessage = `⚠️ WashRoute alert: order rate dropped ≥80% in the last hour (${current} vs ${baseline} baseline). Check the app.`
      }
    } else {
      if (current === 0 && baseline >= 10) {
        alertType = 'orders_zero_overnight_high_baseline'
        severity = 'warn'
        alertMessage = `WashRoute notice: 0 customer-app orders in the last hour (baseline ${baseline}). Off-hours, but unusual.`
      }
    }

    if (!alertType) {
      const { data: lastHeartbeat } = await db.from('_health_alerts')
        .select('created_at')
        .eq('alert_type', 'heartbeat')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const lastHbMs = lastHeartbeat ? new Date(lastHeartbeat.created_at).getTime() : 0
      if ((now.getTime() - lastHbMs) > 6 * 3600 * 1000) {
        await db.from('_health_alerts').insert({
          alert_type: 'heartbeat',
          severity: 'info',
          message: `Healthy. Current: ${current}, baseline: ${baseline}.`,
          context: { current, baseline, hourPT, inBusinessHours },
        })
      }
      return new Response(JSON.stringify({ ok: true, status: 'healthy', current, baseline, hourPT }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const recentWindow = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
    const { data: recent } = await db.from('_health_alerts')
      .select('id, sent_sms')
      .eq('alert_type', alertType)
      .gte('created_at', recentWindow)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (recent) {
      await db.from('_health_alerts').insert({
        alert_type: alertType,
        severity,
        message: alertMessage + ' (suppressed: re-fire within 60min)',
        context: { current, baseline, hourPT, suppressed: true, prior_id: recent.id },
      })
      return new Response(JSON.stringify({ ok: true, status: 'alert_suppressed', alertType }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const smsResult = await sendAlertSms(alertMessage)
    await db.from('_health_alerts').insert({
      alert_type: alertType,
      severity,
      message: alertMessage,
      context: { current, baseline, hourPT, inBusinessHours, twilio: smsResult },
      sent_sms: smsResult.ok,
      sent_to: smsResult.ok ? ALERT_PHONE : null,
    })

    return new Response(JSON.stringify({ ok: true, status: 'alerted', alertType, severity, sms: smsResult }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (err: any) {
    console.error('health-monitor error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
