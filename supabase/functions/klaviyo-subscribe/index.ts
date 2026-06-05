// klaviyo-subscribe v3 — server-side subscribe to Klaviyo's "Email List"
// (id VDLwxj), trigger list for the "Email Welcome Series" flow.
//
// v3 (June 4 2026): dropped first_name + last_name from the subscribe payload.
// Klaviyo's profile-subscription-bulk-create-jobs endpoint rejects ALL profile
// attributes other than email + phone_number + subscriptions. Sending name
// fields produced a 400 "'last_name' is not a valid field for the resource
// 'profile'" and the welcome series never fired for anyone since the fix.
// Names still reach Klaviyo via the nightly sync-klaviyo profile upsert.
//
// v2 (June 1 2026): dropped phone_number for similar reasons.
//
// Lesson banked: this endpoint accepts ONLY {email, subscriptions} (and
// optionally phone_number when SMS consent is included). Anything else =
// 400 with the whole batch silently failing. Don't add fields without
// checking Klaviyo's spec first.
//
// Called by customer-app's handleSignup() / handleNameSubmit() / loadUserData()
// right after a fresh customer record is created with email marketing consent.
// Failure is intentionally non-fatal: this function logs warnings and returns
// 200 so a Klaviyo outage can't break signup.
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

  const email = String(body.email || '').trim().toLowerCase()

  if (!email || !email.includes('@')) {
    return jsonResponse({ ok: false, error: 'invalid_email' }, 400)
  }

  // ONLY email + subscriptions. first_name / last_name / phone_number are
  // rejected by this endpoint — they reach Klaviyo via the nightly sync.
  const payload = {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email,
              subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
            },
          }],
        },
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
