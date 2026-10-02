// _shared/gmail.ts — session 327c. The info@familylaundry.com Gmail connection.
//
// Everything about the connection lives in public.gmail_sync (one row, id=1,
// service-role only): the Google OAuth client (pasted by an admin), the refresh
// token (written once by gmail-oauth after the admin signs in as info@), and the
// sync cursor. Nothing here is ever returned to a browser.
//
// READ-ONLY by design: the only scope requested is gmail.readonly. WashRoute can
// never send, delete, label or move mail in info@ — a bug here can at worst fail
// to copy an email, never touch the mailbox.

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
export const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
export const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
// Only this mailbox may be connected. Signing in as anyone else is refused, so a
// staff member can't accidentally pipe their personal inbox into customer records.
export const EXPECTED_ACCOUNT = (Deno.env.get('GMAIL_EXPECTED_ACCOUNT') || 'info@familylaundry.com').toLowerCase()
export const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-oauth`

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SVC_KEY)
}

export type GmailSyncRow = {
  id: number
  client_id: string | null
  client_secret: string | null
  account_email: string | null
  refresh_token: string | null
  history_id: string | null
  connected_at: string | null
  connected_by: string | null
  last_run_at: string | null
  last_success_at: string | null
  last_error: string | null
  consecutive_failures: number
  alerted_at: string | null
  saved_total: number
}

export async function loadState(db: SupabaseClient): Promise<GmailSyncRow> {
  const { data, error } = await db.from('gmail_sync').select('*').eq('id', 1).single()
  if (error || !data) throw new Error(`gmail_sync row missing: ${error?.message ?? 'no row'}`)
  return data as GmailSyncRow
}

export async function saveState(db: SupabaseClient, patch: Partial<GmailSyncRow>): Promise<void> {
  const { error } = await db.from('gmail_sync').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1)
  if (error) throw new Error(`gmail_sync update failed: ${error.message}`)
}

/** Public-safe view of the connection for the admin card. Never includes secrets. */
export function publicStatus(s: GmailSyncRow) {
  return {
    client_configured: !!(s.client_id && s.client_secret),
    client_id_hint: s.client_id ? s.client_id.slice(0, 12) + '…' : null,
    connected: !!s.refresh_token,
    account_email: s.account_email,
    connected_at: s.connected_at,
    last_run_at: s.last_run_at,
    last_success_at: s.last_success_at,
    last_error: s.last_error,
    consecutive_failures: s.consecutive_failures,
    saved_total: s.saved_total,
    redirect_uri: REDIRECT_URI,
  }
}

export class GmailAuthRevoked extends Error {}

/** Exchange the stored refresh token for a short-lived access token. */
export async function getAccessToken(s: GmailSyncRow): Promise<string> {
  if (!s.client_id || !s.client_secret) throw new Error('Google client not configured')
  if (!s.refresh_token) throw new GmailAuthRevoked('Gmail is not connected')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.client_id,
      client_secret: s.client_secret,
      refresh_token: s.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (data?.error === 'invalid_grant') {
      throw new GmailAuthRevoked('Google says access was revoked or expired — reconnect Gmail in Admin → Settings → Email')
    }
    throw new Error(`Google token refresh failed (${res.status}): ${data?.error_description || data?.error || 'unknown'}`)
  }
  return data.access_token as string
}

// ── Signed OAuth state (CSRF protection for the callback) ───────────────────
async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SUPABASE_SVC_KEY),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'))
}

export async function signState(userId: string): Promise<string> {
  const payload = b64url(JSON.stringify({ u: userId, exp: Date.now() + 15 * 60 * 1000, n: crypto.randomUUID() }))
  return `${payload}.${await hmacHex('gmail-oauth:' + payload)}`
}

export async function verifyState(state: string): Promise<string | null> {
  const [payload, sig] = String(state || '').split('.')
  if (!payload || !sig) return null
  if ((await hmacHex('gmail-oauth:' + payload)) !== sig) return null
  try {
    const p = JSON.parse(unb64url(payload))
    if (typeof p.u !== 'string' || typeof p.exp !== 'number' || p.exp < Date.now()) return null
    return p.u
  } catch { return null }
}

// ── Caller auth (copied shape from send-email / health-monitor) ─────────────
export type Caller = { kind: 'internal' } | { kind: 'staff'; userId: string; role: string; name: string }

export async function authorizeCaller(req: Request, allowedRoles: Set<string>):
  Promise<{ ok: true; caller: Caller } | { ok: false; status: number; reason: string }> {
  const db = adminClient()
  const internal = req.headers.get('x-wr-internal') || ''
  if (internal) {
    const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
    if (data?.secret && internal === data.secret) return { ok: true, caller: { kind: 'internal' } }
    return { ok: false, status: 401, reason: 'Bad internal secret' }
  }
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' }
  const jwt = m[1]
  if (jwt === SUPABASE_SVC_KEY) return { ok: true, caller: { kind: 'internal' } }
  if (jwt === SUPABASE_ANON_KEY) return { ok: false, status: 401, reason: 'Anon key not accepted; staff login required' }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
  const { data: { user }, error } = await userClient.auth.getUser(jwt)
  if (error || !user) return { ok: false, status: 401, reason: 'Invalid or expired session' }
  const { data: profile } = await db.from('profiles').select('role, first_name, last_name, email').eq('id', user.id).single()
  if (!profile) return { ok: false, status: 403, reason: 'Profile not found' }
  if (!allowedRoles.has(profile.role)) return { ok: false, status: 403, reason: `Role '${profile.role}' not allowed` }
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || profile.email || 'Staff'
  return { ok: true, caller: { kind: 'staff', userId: user.id, role: profile.role, name } }
}
