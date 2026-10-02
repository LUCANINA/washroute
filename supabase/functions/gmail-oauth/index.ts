// gmail-oauth — session 327c. One-time "Connect Gmail" for info@familylaundry.com.
//
// verify_jwt MUST be FALSE: Google's redirect back to us (GET ?code=&state=)
// carries no Supabase JWT. Every POST action authenticates itself below, and the
// GET callback is protected by an HMAC-signed, 15-minute `state` minted only for
// a signed-in admin/manager.
//
// POST actions (admin/manager JWT):
//   status       → connection status for the Settings card (never secrets)
//   save_client  → store the Google OAuth client id/secret pasted by the admin
//   start        → returns the Google consent URL to open
//   disconnect   → revokes the token at Google and forgets it
// GET (from Google) → exchanges the code, checks the account IS info@, stores the
//   refresh token, then redirects back to the admin Settings page.
//
// Supabase serves function HTML as text/plain, so the callback never renders a
// page itself — it 302s back to the admin with ?gmail=connected / ?gmail_error=.

import {
  adminClient, authorizeCaller, cors, EXPECTED_ACCOUNT, GMAIL_SCOPE, json, loadState,
  publicStatus, REDIRECT_URI, saveState, signState, verifyState,
} from '../_shared/gmail.ts'

const ADMIN_URL = Deno.env.get('ADMIN_URL') || 'https://admin.familylaundry.com/'
const CONNECT_ROLES = new Set(['admin', 'manager'])

function backToAdmin(params: Record<string, string>): Response {
  const u = new URL(ADMIN_URL)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  u.hash = 'settings'
  return new Response(null, { status: 302, headers: { Location: u.toString() } })
}

async function revoke(token: string) {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    })
  } catch (_) { /* best effort */ }
}

async function handleCallback(url: URL): Promise<Response> {
  const db = adminClient()
  const err = url.searchParams.get('error')
  if (err) return backToAdmin({ gmail_error: err === 'access_denied' ? 'You cancelled the Google sign-in.' : `Google returned: ${err}` })

  const userId = await verifyState(url.searchParams.get('state') || '')
  if (!userId) return backToAdmin({ gmail_error: 'The sign-in link expired. Click Connect Gmail again.' })
  const code = url.searchParams.get('code')
  if (!code) return backToAdmin({ gmail_error: 'Google did not return a code.' })

  const s = await loadState(db)
  if (!s.client_id || !s.client_secret) return backToAdmin({ gmail_error: 'Google client not configured.' })

  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: s.client_id, client_secret: s.client_secret,
      redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
    }),
  })
  const tok = await tokRes.json().catch(() => ({}))
  if (!tokRes.ok || !tok.access_token) {
    return backToAdmin({ gmail_error: `Google sign-in failed: ${tok.error_description || tok.error || tokRes.status}` })
  }
  if (!tok.refresh_token) {
    await revoke(tok.access_token)
    return backToAdmin({ gmail_error: 'Google did not grant offline access. Click Connect Gmail again.' })
  }
  if (!String(tok.scope || '').includes('gmail.readonly')) {
    await revoke(tok.refresh_token)
    return backToAdmin({ gmail_error: 'Gmail read permission was not granted — tick the Gmail box on the Google screen.' })
  }

  const profRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })
  const prof = await profRes.json().catch(() => ({}))
  if (!profRes.ok || !prof.emailAddress) {
    await revoke(tok.refresh_token)
    return backToAdmin({ gmail_error: `Could not read the Gmail profile (${profRes.status}).` })
  }
  const account = String(prof.emailAddress).toLowerCase()
  if (account !== EXPECTED_ACCOUNT) {
    await revoke(tok.refresh_token)
    return backToAdmin({ gmail_error: `You signed in as ${account}. Sign in as ${EXPECTED_ACCOUNT} instead.` })
  }

  await saveState(db, {
    account_email: account,
    refresh_token: tok.refresh_token,
    // Reconnecting keeps the old cursor so nothing in between is skipped; a
    // cursor Gmail no longer knows is handled by gmail-sync's fallback.
    history_id: s.history_id || String(prof.historyId),
    connected_at: new Date().toISOString(),
    connected_by: userId,
    last_error: null,
    consecutive_failures: 0,
    alerted_at: null,
  })
  return backToAdmin({ gmail: 'connected' })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const url = new URL(req.url)

  if (req.method === 'GET') {
    try { return await handleCallback(url) }
    catch (e) { console.error('gmail-oauth callback error', e); return backToAdmin({ gmail_error: 'Unexpected error — try again.' }) }
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = await authorizeCaller(req, CONNECT_ROLES)
  if (!auth.ok) return json({ error: auth.reason }, auth.status)
  if (auth.caller.kind !== 'staff') return json({ error: 'Staff login required' }, 403)

  try {
    const body = await req.json().catch(() => ({}))
    const db = adminClient()
    const s = await loadState(db)

    switch (body.action) {
      case 'status':
        return json({ ok: true, status: publicStatus(s) })

      case 'save_client': {
        const clientId = String(body.client_id || '').trim()
        const clientSecret = String(body.client_secret || '').trim()
        if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
          return json({ error: 'Client ID should end in .apps.googleusercontent.com' }, 400)
        }
        if (clientSecret.length < 10 || /\s/.test(clientSecret)) return json({ error: 'Client secret looks wrong' }, 400)
        const changed = clientId !== s.client_id
        if (changed && s.refresh_token) await revoke(s.refresh_token)
        await saveState(db, {
          client_id: clientId, client_secret: clientSecret,
          // A token belongs to the client that issued it.
          ...(changed ? { refresh_token: null, account_email: null, connected_at: null } : {}),
        })
        return json({ ok: true, status: publicStatus(await loadState(db)) })
      }

      case 'start': {
        if (!s.client_id || !s.client_secret) return json({ error: 'Save the Google Client ID and secret first' }, 400)
        const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        u.searchParams.set('client_id', s.client_id)
        u.searchParams.set('redirect_uri', REDIRECT_URI)
        u.searchParams.set('response_type', 'code')
        u.searchParams.set('scope', GMAIL_SCOPE)
        u.searchParams.set('access_type', 'offline')
        u.searchParams.set('prompt', 'consent')
        u.searchParams.set('login_hint', EXPECTED_ACCOUNT)
        u.searchParams.set('state', await signState(auth.caller.userId))
        return json({ ok: true, url: u.toString() })
      }

      case 'disconnect': {
        if (s.refresh_token) await revoke(s.refresh_token)
        await saveState(db, { refresh_token: null, account_email: null, connected_at: null, connected_by: null })
        return json({ ok: true, status: publicStatus(await loadState(db)) })
      }

      default:
        return json({ error: 'Unknown action' }, 400)
    }
  } catch (e) {
    console.error('gmail-oauth error', e)
    return json({ error: String((e as Error).message || e) }, 500)
  }
})
