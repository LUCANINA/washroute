// gmail-sync — session 327c. Copies customer emails from info@familylaundry.com
// (Gmail) into email_messages so they show in the customer's Messages history.
//
// verify_jwt MUST be FALSE: pg_cron calls with the x-wr-internal header only.
// Staff calls (admin/manager/attendant JWT) are checked in authorizeCaller.
//
// Actions (POST body.action):
//   sync      (default; cron every 5 min) — everything new since the saved Gmail
//             history cursor. Falls back to the last 3 days if Gmail has expired
//             the cursor (it keeps ~a week), so an outage self-heals.
//   backfill  { days, page_token } — one page (≤250) of older mail; the admin
//             card loops until next_page_token is null. Does not move the cursor.
//   status    — connection status for the Settings card (never secrets).
//
// What gets saved: ONLY messages whose other party is a customer (matched on
// customers.email_cache, case-insensitive). Vendors, invoices, newsletters and
// internal @familylaundry.com mail are read and dropped, never stored.
// Inbound = in the inbox; outbound = Gmail SENT label (a staff reply from Gmail).
// gmail_message_id is UNIQUE, so overlap between runs/backfills can't duplicate.
//
// READ-ONLY: gmail.readonly scope. This function cannot change the mailbox.

import {
  adminClient, authorizeCaller, cors, EXPECTED_ACCOUNT, getAccessToken, GmailAuthRevoked,
  GmailSyncRow, json, loadState, publicStatus, saveState,
} from '../_shared/gmail.ts'
import { alertSmsConfigFromEnv, sendAlertSms } from '../_shared/alert-sms.ts'
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'

const STAFF_ROLES = new Set(['admin', 'manager', 'attendant'])
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SKIP_LABELS = new Set(['DRAFT', 'SPAM', 'TRASH', 'CHAT'])
const OWN_DOMAIN = '@familylaundry.com'
// Deliberately excludes characters that mean something to PostgREST's or()
// grammar (, ( ) " *) and LIKE's % — an address with them is simply not matched.
const EMAIL_RE = /^[a-z0-9.!#$&'+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
const MAX_BODY = 200_000
const TIME_BUDGET_MS = 100_000
const ALERT_AFTER_FAILURES = 3
const REALERT_HOURS = 12

// ── Gmail HTTP with retry on 429/5xx ────────────────────────────────────────
async function gget(token: string, path: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) return res.json()
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
      continue
    }
    const txt = await res.text().catch(() => '')
    const err = new Error(`Gmail ${res.status} on ${path.split('?')[0]}: ${txt.slice(0, 200)}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

// ── Message parsing ─────────────────────────────────────────────────────────
function header(msg: any, name: string): string {
  const h = (msg.payload?.headers || []).find((x: any) => String(x.name).toLowerCase() === name.toLowerCase())
  return h ? String(h.value) : ''
}

function addresses(raw: string): string[] {
  const found = raw.match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g) || []
  return [...new Set(found.map(a => a.toLowerCase().replace(/\.$/, '')))].filter(a => EMAIL_RE.test(a))
}

function decodeB64url(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function extractBody(payload: any): string {
  let html = '', text = ''
  const walk = (p: any) => {
    if (!p || (html && text)) return
    const mime = String(p.mimeType || '')
    const isAttachment = !!p.filename
    if (!isAttachment && p.body?.data) {
      if (mime === 'text/html' && !html) html = decodeB64url(p.body.data)
      else if (mime === 'text/plain' && !text) text = decodeB64url(p.body.data)
    }
    for (const c of p.parts || []) walk(c)
  }
  walk(payload)
  const out = html || (text ? `<div style="white-space:pre-wrap">${escapeHtml(text)}</div>` : '')
  return out.length > MAX_BODY ? out.slice(0, MAX_BODY) : out
}

// ── Customer matching ───────────────────────────────────────────────────────
type Cust = { id: string; email_cache: string; last_order_at: string | null; created_at: string; cancelled_at: string | null }

async function matchCustomers(db: SupabaseClient, addrs: string[]): Promise<Map<string, string>> {
  const best = new Map<string, Cust>()
  for (let i = 0; i < addrs.length; i += 40) {
    const chunk = addrs.slice(i, i + 40)
    const { data, error } = await db.from('customers')
      .select('id, email_cache, last_order_at, created_at, cancelled_at')
      .or(chunk.map(a => `email_cache.ilike."${a}"`).join(','))
    if (error) throw new Error(`customer lookup failed: ${error.message}`)
    for (const c of (data || []) as Cust[]) {
      const key = String(c.email_cache || '').toLowerCase()
      if (!chunk.includes(key)) continue // ilike '_' is a wildcard; insist on an exact match
      const cur = best.get(key)
      // Duplicate accounts sharing an email: prefer open, then most recently ordered, then newest.
      const rank = (x: Cust) => [x.cancelled_at ? 0 : 1, x.last_order_at || '', x.created_at || '']
      if (!cur || rank(c).join('|') > rank(cur).join('|')) best.set(key, c)
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.id]))
}

// ── Core: turn a list of Gmail ids into saved rows ──────────────────────────
async function processIds(db: SupabaseClient, token: string, ids: string[]) {
  ids = [...new Set(ids)]
  if (!ids.length) return { scanned: 0, matched: 0, saved: 0 }

  const already = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db.from('email_messages').select('gmail_message_id').in('gmail_message_id', ids.slice(i, i + 100))
    if (error) throw new Error(`dedupe lookup failed: ${error.message}`)
    for (const r of data || []) already.add(r.gmail_message_id)
  }
  const fresh = ids.filter(id => !already.has(id))

  const metas = await pool(fresh, 8, async id => {
    try {
      return await gget(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`)
    } catch (e) {
      if ((e as any).status === 404) return null // deleted between listing and fetching
      throw e
    }
  })

  type Cand = { id: string; threadId: string; outbound: boolean; parties: string[]; from: string; to: string; subject: string; at: string }
  const cands: Cand[] = []
  for (const m of metas) {
    if (!m) continue
    const labels: string[] = m.labelIds || []
    if (labels.some(l => SKIP_LABELS.has(l))) continue
    const outbound = labels.includes('SENT')
    const fromA = addresses(header(m, 'From'))
    const toA = addresses(header(m, 'To') + ',' + header(m, 'Cc'))
    const external = (list: string[]) => list.filter(a => a !== EXPECTED_ACCOUNT && !a.endsWith(OWN_DOMAIN))
    const parties = external(outbound ? toA : fromA)
    if (!parties.length) continue
    cands.push({
      id: m.id, threadId: m.threadId, outbound, parties,
      from: fromA[0] || '', to: (outbound ? parties[0] : toA[0]) || EXPECTED_ACCOUNT,
      subject: header(m, 'Subject').slice(0, 500),
      at: new Date(Number(m.internalDate)).toISOString(),
    })
  }

  const custByEmail = await matchCustomers(db, [...new Set(cands.flatMap(c => c.parties))])
  const matched = cands
    .map(c => ({ ...c, customerId: c.parties.map(p => custByEmail.get(p)).find(Boolean) }))
    .filter(c => c.customerId)

  const rows = (await pool(matched, 5, async c => {
    let full: any
    try { full = await gget(token, `/messages/${c.id}?format=full`) }
    catch (e) { if ((e as any).status === 404) return null; throw e }
    return {
      customer_id: c.customerId,
      direction: c.outbound ? 'outbound' : 'inbound',
      subject: c.subject || '(no subject)',
      body: extractBody(full.payload) || escapeHtml(String(full.snippet || '')),
      from_email: c.from,
      to_email: c.to,
      created_at: c.at,
      gmail_message_id: c.id,
      gmail_thread_id: c.threadId,
      sent_by_name: c.outbound ? 'Gmail (info@)' : null,
    }
  })).filter(Boolean) as Record<string, unknown>[]

  let saved = 0
  for (let i = 0; i < rows.length; i += 50) {
    const { data, error } = await db.from('email_messages')
      .upsert(rows.slice(i, i + 50), { onConflict: 'gmail_message_id', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`saving emails failed: ${error.message}`)
    saved += (data || []).length
  }
  return { scanned: fresh.length, matched: matched.length, saved }
}

// ── Incremental sync from the history cursor ────────────────────────────────
async function incremental(db: SupabaseClient, s: GmailSyncRow, token: string) {
  const started = Date.now()
  if (!s.history_id) {
    const prof = await gget(token, '/profile')
    await saveState(db, { history_id: String(prof.historyId) })
    return { scanned: 0, matched: 0, saved: 0, note: 'cursor initialised' }
  }
  let cursor = s.history_id
  let pageToken = ''
  const totals = { scanned: 0, matched: 0, saved: 0 }
  try {
    do {
      const page = await gget(token, `/history?startHistoryId=${encodeURIComponent(s.history_id)}&historyTypes=messageAdded&maxResults=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
      const recs: any[] = page.history || []
      const ids = recs.flatMap(h => (h.messagesAdded || []).map((x: any) => x.message?.id)).filter(Boolean)
      const r = await processIds(db, token, ids)
      totals.scanned += r.scanned; totals.matched += r.matched; totals.saved += r.saved
      pageToken = page.nextPageToken || ''
      cursor = pageToken ? (recs.length ? String(recs[recs.length - 1].id) : cursor) : String(page.historyId || cursor)
      if (pageToken && Date.now() - started > TIME_BUDGET_MS) break // resume next run from `cursor`
    } while (pageToken)
  } catch (e) {
    if ((e as any).status !== 404) throw e
    // Gmail no longer has our cursor (offline > ~a week). Re-scan recent mail; the
    // unique gmail_message_id makes the overlap harmless.
    const list = await gget(token, `/messages?q=${encodeURIComponent('newer_than:3d')}&maxResults=500`)
    const r = await processIds(db, token, (list.messages || []).map((m: any) => m.id))
    totals.scanned += r.scanned; totals.matched += r.matched; totals.saved += r.saved
    cursor = String((await gget(token, '/profile')).historyId)
  }
  await saveState(db, { history_id: cursor })
  return totals
}

async function backfill(db: SupabaseClient, token: string, days: number, pageToken: string) {
  const q = encodeURIComponent(`newer_than:${days}d`)
  const list = await gget(token, `/messages?q=${q}&maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`)
  const r = await processIds(db, token, (list.messages || []).map((m: any) => m.id))
  return { ...r, next_page_token: list.nextPageToken || null }
}

// ── Failure bookkeeping + alert ─────────────────────────────────────────────
async function recordFailure(db: SupabaseClient, s: GmailSyncRow, msg: string) {
  const failures = (s.consecutive_failures || 0) + 1
  const patch: Partial<GmailSyncRow> = { last_run_at: new Date().toISOString(), last_error: msg.slice(0, 500), consecutive_failures: failures }
  const lastAlert = s.alerted_at ? new Date(s.alerted_at).getTime() : 0
  if (failures >= ALERT_AFTER_FAILURES && Date.now() - lastAlert > REALERT_HOURS * 3600_000) {
    const r = await sendAlertSms(
      `WashRoute: copying info@ emails into customer history has failed ${failures} times in a row. ` +
      `Mail delivery is NOT affected. Latest error: ${msg.slice(0, 160)}. Check Admin → Settings → Email.`,
      alertSmsConfigFromEnv(k => Deno.env.get(k)))
    if (r.ok) patch.alerted_at = new Date().toISOString()
    else console.error('gmail-sync alert failed', r.reason)
  }
  await saveState(db, patch)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const auth = await authorizeCaller(req, STAFF_ROLES)
  if (!auth.ok) return json({ error: auth.reason }, auth.status)

  const body = await req.json().catch(() => ({}))
  const action = body.action || 'sync'
  const db = adminClient()
  let s: GmailSyncRow
  try { s = await loadState(db) } catch (e) { return json({ error: String((e as Error).message) }, 500) }

  if (action === 'status') return json({ ok: true, status: publicStatus(s) })
  if (action === 'backfill' && auth.caller.kind !== 'staff') return json({ error: 'Staff only' }, 403)
  if (!s.refresh_token || !s.client_id) {
    return json({ ok: true, skipped: 'Gmail not connected', status: publicStatus(s) })
  }

  try {
    const token = await getAccessToken(s)
    let result: Record<string, unknown>
    if (action === 'backfill') {
      const days = Math.min(Math.max(parseInt(body.days, 10) || 90, 1), 365)
      result = await backfill(db, token, days, String(body.page_token || ''))
    } else if (action === 'sync') {
      result = await incremental(db, s, token)
    } else {
      return json({ error: 'Unknown action' }, 400)
    }
    const saved = Number(result.saved || 0)
    await saveState(db, {
      last_run_at: new Date().toISOString(), last_success_at: new Date().toISOString(),
      last_error: null, consecutive_failures: 0, alerted_at: null,
      saved_total: (s.saved_total || 0) + saved,
    })
    return json({ ok: true, ...result, status: publicStatus(await loadState(db)) })
  } catch (e) {
    const msg = e instanceof GmailAuthRevoked ? e.message : `Sync failed: ${String((e as Error).message || e)}`
    console.error('gmail-sync', msg)
    try { await recordFailure(db, s, msg) } catch (e2) { console.error('gmail-sync could not record failure', e2) }
    return json({ ok: false, error: msg }, 502)
  }
})
