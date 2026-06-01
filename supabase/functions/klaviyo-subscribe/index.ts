// klaviyo-subscribe — server-side subscribe to Klaviyo's "Email List" (id VDLwxj),
// which is the trigger list for the "Email Welcome Series" flow.
//
// Called by customer-app's handleSignup() and loadUserData() (post-email-confirm
// path) right after a fresh customer record is created with email marketing
// consent. Failure is intentionally non-fatal: this function logs warnings and
// returns 200 so that a Klaviyo outage can never break signup.
//
// verify_jwt:false matches the WashRoute project convention. No customer-PII
// trust boundary is crossed here — the function only writes to Klaviyo using
// the server-side KLAVIYO_API_KEY secret and only ever subscribes to one
// hardcoded list. The worst-case abuse is unsolicited welcome emails to
// attacker-supplied addresses, which is the same risk profile as any public
// newsletter embed form.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const KLAVIYO_KEY   = Deno.env.get('KLAVIYO_API_KEY') || ''
const REVISION      = '2024-10-15'
const EMAIL_LIST_ID = 'VDLwxj'   // "Email List" — trigger for "Email Welcome Series"

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function normPhone(raw: string): string | null {
  const d = (raw || '').replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return null
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST')    return jsonResponse({ error: 'method_not_allowed' }, 405)

  if (!KLAVIYO_KEY) {
    console.error('[klaviyo-subscribe] KLAVIYO_API_KEY not set in environment')
    // Non-fatal — return ok:false so callers don't break signup
    return jsonResponse({ ok: false, error: 'klaviyo_key_not_set' })
  }

  let body: any = {}
  try { body = await req.json() } catch { /* empty body — caught by email check below */ }

  const email     = String(body.email || '').trim().toLowerCase()
  const firstName = String(body.first_name || '').trim() || null
  const lastName  = String(body.last_name  || '').trim() || null
  const phoneE164 = normPhone(String(body.phone || ''))

  if (!email || !email.includes('@')) {
    return jsonResponse({ ok: false, error: 'invalid_email' }, 400)
  }

  const profileAttrs: Record<string, unknown> = {
    email,
    subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
  }
  if (firstName) profileAttrs.first_name   = firstName
  if (lastName)  profileAttrs.last_name    = lastName
  if (phoneE164) profileAttrs.phone_number = phoneE164

  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: { data: [{ type: 'profile', attributes: profileAttrs }] },
        custom_source: 'WashRoute customer signup',
      },
      relationships: { list: { data: { type: 'list', id: EMAIL_LIST_ID } } },
    },
  }

  try {
    const r = await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
      method: 'POST',
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
        'accept':        'application/json',
        'content-type':  'application/json',
        'revision':      REVISION,
      },
      body: JSON.stringify(payload),
    })

    if (!r.ok) {
      const errBody = await r.text().catch(() => '')
      console.warn(`[klaviyo-subscribe] Klaviyo ${r.status} for ${email}: ${errBody.slice(0, 500)}`)
      // Non-fatal — caller (signup flow) should not see this as a failure
      return jsonResponse({ ok: false, status: r.status, error: errBody.slice(0, 500) })
    }

    return jsonResponse({ ok: true, email })
  } catch (e: any) {
    console.warn('[klaviyo-subscribe] fetch error:', e?.message || String(e))
    return jsonResponse({ ok: false, error: e?.message || 'fetch_error' })
  }
})
