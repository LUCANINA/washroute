// _shared/alert-sms.ts — the one place an operational alert becomes a text message.
//
// Extracted from health-monitor in session 260, when xero-payout-watchdog needed
// the same capability. A second copy of a Twilio sender is how two alert paths
// drift until one of them is quietly dead, and this module's whole reason for
// existing is that a failure nobody is told about is the same as no failure
// detection at all -- which is precisely what let the 2026-08-27 payout sit broken
// for six days.
//
// health-monitor keeps its own copy for now (it is the only working alarm and was
// not worth destabilising in the same change that adds a new one). Folding it onto
// this module is filed as tech debt.

export interface AlertSmsResult { ok: boolean; reason?: string; sid?: string }

export interface AlertSmsConfig {
  sid: string
  token: string
  from: string
  to: string
}

export function alertSmsConfigFromEnv(env: (k: string) => string | undefined): AlertSmsConfig {
  return {
    sid: env('TWILIO_ACCOUNT_SID') || '',
    token: env('TWILIO_AUTH_TOKEN') || '',
    from: env('TWILIO_PHONE_NUMBER') || '',
    // Same deliberate fallback health-monitor carries: ALERT_PHONE is not set in
    // Supabase Secrets, so dropping it would silently disable every alert. Set
    // ALERT_PHONE in the dashboard, then remove this.
    to: env('ALERT_PHONE') || '+14156085446',
  }
}

/** Normalise to E.164, or return null if it cannot be made into a real number. */
export function normalisePhone(raw: string): string | null {
  if (!raw) return null
  let phone = raw.replace(/[^\d+]/g, '')
  if (phone && !phone.startsWith('+')) phone = '+1' + phone.slice(-10)
  if (!phone || phone.length < 10) return null
  return phone
}

export async function sendAlertSms(body: string, cfg: AlertSmsConfig): Promise<AlertSmsResult> {
  if (!cfg.sid || !cfg.token || !cfg.from) return { ok: false, reason: 'twilio_not_configured' }
  const phone = normalisePhone(cfg.to)
  if (!phone) return { ok: false, reason: 'invalid_alert_phone' }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(`${cfg.sid}:${cfg.token}`),
      },
      body: new URLSearchParams({ To: phone, From: cfg.from, Body: body }).toString(),
    })
    const data = await res.json()
    if (!res.ok) return { ok: false, reason: data.message || `twilio_${res.status}` }
    return { ok: true, sid: data.sid }
  } catch (e) {
    // An alert that throws must never take down the job that was trying to alert.
    return { ok: false, reason: `twilio_threw: ${String((e as Error)?.message || e)}` }
  }
}

/**
 * SMS is 160 characters per segment and an alert that arrives truncated at a
 * random point is worse than a short one. Callers build a short message; this is
 * the backstop.
 */
export function trimForSms(s: string, max = 320): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
