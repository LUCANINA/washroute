// klaviyo-subscribe v2 — server-side subscribe to Klaviyo's "Email List"
// (id VDLwxj), trigger list for the "Email Welcome Series" flow.
//
// v2 (June 1 2026): dropped phone_number from the subscribe payload. Klaviyo's
// profile-subscription-bulk-create-jobs endpoint silently rejects profiles that
// include phone_number unless SMS consent is also included — v1 was sending
// phone with email-only consent, so every real signup was failing while the
// function still returned 200 (non-fatal pattern hid it). Phone still reaches
// Klaviyo via the nightly sync-klaviyo profile upsert; this call exists only to
// fire the Welcome Series.
//
// Called by customer-app's handleSignup() and loadUserData() (post-email-confirm
// path) right after a fresh customer record is created with email marketing
// consent. Failure is intentionally non-fatal: this function logs warnings and
// returns 200 so a Klaviyo outage can't break signup.
//
// verify_jwt:false matches the WashRoute project convention.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"

const KLAVIYO_KEY   = Deno.env.get('KLAVIYO_API_KEY') || ''
const REVISION      = '2024-10-15'
const EMAIL_LIST_ID = 'VDLwxj'   // "Email List" — trigger for "Email Welcome Series"

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    return jsonResponse({ ok: false, error: 'klaviyo_key_not_set' })
  }

  let body: any = {}
  try { body = await req.json() } catch { /* empty body — caught by email check below */ }

  const email     = String(body.email || '').trim().toLowerCase()
  const firstName = String(body.first_name || '').trim() || null
  const lastName  = String(body.last_name  || '').trim() || null

  if (!email || !email.includes('@')) {
    return jsonResponse({ ok: false, error: 'invalid_email' }, 400)
  }

  // NOTE: phone_number is intentionally NOT included. See file header.
  const profileAttrs: Record<string, unknown> = {
    email,
    subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
  }
  if (firstName) profileAttrs.first_name = firstName
  if (lastName)  profileAttrs.last_name  = lastName

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
      // Log BOTH the email and the full Klaviyo error so this is debuggable next time
      console.warn(`[klaviyo-subscribe] FAIL Klaviyo ${r.status} for ${email}: ${errBody}`)
      console.warn(`[klaviyo-subscribe] sent payload: ${JSON.stringify(payload)}`)
      return jsonResponse({ ok: false, status: r.status, error: errBody.slice(0, 1000) })
    }

    console.log(`[klaviyo-subscribe] OK ${email}`)
    return jsonResponse({ ok: true, email })
  } catch (e: any) {
    console.warn('[klaviyo-subscribe] fetch error:', e?.message || String(e))
    return jsonResponse({ ok: false, error: e?.message || 'fetch_error' })
  }
})
