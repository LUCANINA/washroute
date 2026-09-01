// xero-rate-probe -- "is Xero actually refusing us, and WHICH limit?" (session 259)
//
// WHY THIS EXISTS
// ---------------
// Xero returns 429 with an EMPTY body. `xero-read` reported only the status, so
// "which limit" and "for how long" were invisible, and the quota state has now been
// misread TWICE:
//   * session 258 cont. 2 assumed the daily cap and stopped work for the night;
//   * session 259 probed with `whoami`, got a 200, and announced the quota was back --
//     but `whoami` hits Xero's IDENTITY api (identity.xero.com / connections), which
//     carries its own separate limit and answers happily while the ACCOUNTING api is
//     still refusing every call.
//
// So: probe the ACCOUNTING api, and read the headers Xero actually sends.
//   X-Rate-Limit-Problem  names the limit: Minute | Daily | Concurrent | AppMinute
//   Retry-After           seconds to wait
//   X-DayLimit-Remaining / X-MinLimit-Remaining  the counters, when present
//
// READ-ONLY BY CONSTRUCTION: one hard-coded GET to /Accounts with $top-equivalent
// trimming (we discard the body entirely and only report headers + status). There is
// no write branch, no request body, and no path parameter -- nothing here can change
// anything in Xero. It is the cheapest accounting-api call available: one request.
//
// The same header-reading fix is committed into `xero-read` itself and should be
// deployed there when a CLI is available; this probe stays regardless, because a
// one-call "can I talk to Xero right now" answer is worth having on its own.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from "../_shared/xero-auth.ts"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Content-Type': 'application/json',
}

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  )
}

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const { data } = await admin().from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch {
    return false
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  if (!(await isInternalCall(req))) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors })
  }

  let auth
  try {
    auth = await getXeroAuth()
  } catch (e) {
    // A token failure is a DIFFERENT problem from a rate limit and must not be
    // reported as one -- that conflation is exactly what this function exists to end.
    return new Response(JSON.stringify({
      ok: false, stage: 'token',
      reachable: false,
      message: 'Could not obtain a Xero token at all -- this is a credentials/connection problem, NOT a rate limit.',
      detail: String(e && (e as Error).message || e),
    }), { status: 200, headers: cors })
  }

  const started = Date.now()
  const res = await fetch('https://api.xero.com/api.xro/2.0/Accounts', { method: 'GET', headers: auth.headers })
  const elapsed_ms = Date.now() - started
  // Body is deliberately discarded: this function reports reachability, never data.
  await res.text().catch(() => '')

  const problem = res.headers.get('X-Rate-Limit-Problem')
  const retryAfter = res.headers.get('Retry-After')

  // Xero's documented values are 'Daily' / 'Minute' / 'AppMinute' / 'Concurrent',
  // but the live api answered **'day'** (lowercase, singular) on 2026-09-01 -- so the
  // documented casing is not what arrives. Normalise before looking anything up; a
  // guidance table keyed on the docs alone silently produced "no guidance on file".
  const NOTES: Record<string, string> = {
    day: 'Daily cap. MEASURED on this tenant 2026-09-01: the ceiling is 1,000/day, not the 5,000 the docs quote -- do not repeat the doc figure. Xero enforces it as a ROLLING window, not a midnight reset, so "it is a new day in UTC" is NOT evidence it has cleared and equally it can free up seconds from now (observed: retry_after 88s from a hard 0-remaining refusal). Trust retry_after_seconds and remaining_day; nothing else.',
    minute: 'Per-minute burst limit (60/min per tenant). Harmless: wait the Retry-After and carry on.',
    appminute: 'App-wide per-minute limit across all tenants (10,000/min). Not something this org caused.',
    concurrent: 'Too many simultaneous requests (max 5). Serialise the calls rather than waiting.',
  }
  const noteKey = (problem || '').toLowerCase().replace(/[^a-z]/g, '')
  const NOTE_ALIASES: Record<string, string> = { daily: 'day', min: 'minute', app: 'appminute' }

  const body: Record<string, unknown> = {
    ok: res.ok,
    status: res.status,
    api: 'accounting',
    elapsed_ms,
    checked_at: new Date().toISOString(),
    remaining_day: res.headers.get('X-DayLimit-Remaining'),
    remaining_minute: res.headers.get('X-MinLimit-Remaining'),
  }

  if (res.status === 429) {
    body.rate_limited = true
    body.limit = problem || 'unknown'
    body.retry_after_seconds = retryAfter ? Number(retryAfter) : null
    body.retry_after_human = retryAfter
      ? `${Math.round(Number(retryAfter) / 60)} min (${retryAfter}s)`
      : 'not stated by Xero'
    body.note = NOTES[NOTE_ALIASES[noteKey] || noteKey]
      || (problem ? `Xero named this limit: "${problem}". No guidance on file for that value -- add it to NOTES.` : 'Xero returned 429 without naming a limit.')
  } else if (res.ok) {
    body.rate_limited = false
    body.note = 'The accounting api answered normally. Xero is reachable right now.'
  } else {
    body.rate_limited = false
    body.note = `Non-429 failure (${res.status}) -- not a rate limit. 401 usually means a missing scope rather than a bad token.`
  }

  return new Response(JSON.stringify(body, null, 2), { status: 200, headers: cors })
})
