import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth, getGrantedScopes } from "../_shared/xero-auth.ts"

// xero-read — v1 (session 232, 2026-08-25)
// =============================================================================
// A READ-ONLY window into Xero.
//
// WHY THIS EXISTS
// Every Xero-reading function in this project is verify_jwt:true, so a session
// working from the sandbox cannot look at the ledger at all -- it can query our own
// database in seconds but is blind to Xero. Session 232 spent an hour asking David to
// open transactions and screenshot them, and still produced one wrong figure because
// the reasoning was being done about a ledger nobody in the conversation could see.
// Reading is not the dangerous half of this integration; being unable to read is.
//
// READ-ONLY BY CONSTRUCTION, NOT BY DISCIPLINE
// There is exactly one fetch() to Xero in this file. It hard-codes method:'GET', and
// its URL is assembled from the ENDPOINTS table below -- a caller-supplied string can
// never become the path. There is no POST, PUT or DELETE branch to reach. A caller
// asking for something unknown gets a 400, not an improvised request.
//
// AUTH
// Same contract as the rest of the module, plus the x-wr-internal shared secret so a
// DB-side caller (pg_net) can use it -- see migration session_227h_internal_call_secret.
// Reading is advisory, so `cpa` is allowed here where writing functions require
// admin/manager.
//
// BODY
//   { mode: 'bank_transactions' | 'manual_journals' | 'invoices' | 'accounts'
//         | 'contacts' | 'whoami',
//     id?: string,              // fetch exactly one by Xero id
//     date?: string,            // 'YYYY-MM-DD' — that day only
//     from?: string, to?: string,
//     amount?: number,          // matches Total (bank txns) / line total (journals)
//     contains?: string,        // substring of reference / narration / name
//     where?: string,           // raw Xero where clause, escape hatch. Still GET-only.
//     page?: number,
//     full?: boolean }          // return Xero's untrimmed objects
// =============================================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Content-Type': 'application/json',
}

const XERO = 'https://api.xero.com/api.xro/2.0'

// The complete set of things this function is able to ask Xero for. Adding a key here
// is the only way to widen its reach, which keeps the blast radius reviewable.
const ENDPOINTS: Record<string, string> = {
  bank_transactions: 'BankTransactions',
  manual_journals:   'ManualJournals',
  invoices:          'Invoices',
  accounts:          'Accounts',
  contacts:          'Contacts',
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  try {
    const { data } = await admin().from('wr_internal_auth').select('secret').maybeSingle()
    return !!data?.secret && provided === data.secret
  } catch (_) {
    return false
  }
}

async function callerRole(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  if (token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return 'service_role'
  try {
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data } = await anon.auth.getUser(token)
    if (!data?.user) return null
    const { data: prof } = await admin().from('profiles').select('role').eq('id', data.user.id).single()
    return prof?.role ?? null
  } catch (_) {
    return null
  }
}

// ── Trimming ────────────────────────────────────────────────────────────────
// Xero's objects are enormous and most of each one is nulls. A caller reading these
// through a conversation pays for every byte, so trim to what anyone actually asks
// about: what it is, when, how much, and how it was coded. `full: true` opts out.
// Xero returns dates in TWO shapes and the difference is not documented per-endpoint:
// BankTransactions carry a friendly DateString ("2026-07-20T00:00:00"), ManualJournals
// carry only the .NET form "/Date(1756598400000+0000)/". Slicing ten characters off the
// second one yields "/Date(1756" -- a string that looks like data, sorts like data, and
// is not a date. Caught in session 232 while checking a 2025 journal; parse both.
function d(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null
  const dotnet = v.match(/^\/Date\((-?\d+)/)
  if (dotnet) return new Date(Number(dotnet[1])).toISOString().slice(0, 10)
  return v.slice(0, 10)
}

function trimBankTransaction(t: any) {
  return {
    id: t.BankTransactionID,
    date: d(t.DateString ?? t.Date),
    type: t.Type,
    status: t.Status,
    reconciled: t.IsReconciled,
    contact: t.Contact?.Name ?? null,
    reference: t.Reference ?? null,
    total: t.Total,
    bank_account: t.BankAccount?.Code ?? t.BankAccount?.Name ?? null,
    lines: (t.LineItems || []).map((l: any) => ({
      description: l.Description ?? null,
      account: l.AccountCode ?? null,
      amount: l.LineAmount,
    })),
  }
}

function trimManualJournal(j: any) {
  return {
    id: j.ManualJournalID,
    number: j.JournalNumber ?? null,
    date: d(j.DateString ?? j.Date),
    status: j.Status,
    narration: j.Narration ?? null,
    lines: (j.JournalLines || []).map((l: any) => ({
      description: l.Description ?? null,
      account: l.AccountCode ?? null,
      amount: l.LineAmount,
    })),
  }
}

function trimInvoice(i: any) {
  return {
    id: i.InvoiceID, number: i.InvoiceNumber ?? null, date: d(i.DateString ?? i.Date),
    status: i.Status, contact: i.Contact?.Name ?? null, total: i.Total, due: i.AmountDue,
  }
}

function trimAccount(a: any) {
  return { code: a.Code, name: a.Name, type: a.Type, status: a.Status, class: a.Class }
}

function trimContact(c: any) {
  return { id: c.ContactID, name: c.Name, status: c.ContactStatus }
}

const TRIM: Record<string, (x: any) => unknown> = {
  bank_transactions: trimBankTransaction,
  manual_journals:   trimManualJournal,
  invoices:          trimInvoice,
  accounts:          trimAccount,
  contacts:          trimContact,
}

const COLLECTION: Record<string, string> = {
  bank_transactions: 'BankTransactions',
  manual_journals:   'ManualJournals',
  invoices:          'Invoices',
  accounts:          'Accounts',
  contacts:          'Contacts',
}

// Build a Xero `where` clause from the structured filters. Kept deliberately small:
// anything more exotic goes through the raw `where` escape hatch, where the caller is
// explicitly taking responsibility for the syntax.
function buildWhere(mode: string, b: any): string | null {
  const parts: string[] = []
  const dateField = mode === 'manual_journals' ? 'Date' : 'Date'
  const xdate = (s: string) => {
    const [y, m, day] = s.split('-').map((n: string) => parseInt(n, 10))
    return `DateTime(${y},${m},${day})`
  }
  if (typeof b.date === 'string') {
    parts.push(`${dateField} >= ${xdate(b.date)}`)
    const next = new Date(b.date + 'T00:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    parts.push(`${dateField} < ${xdate(next.toISOString().slice(0, 10))}`)
  } else {
    if (typeof b.from === 'string') parts.push(`${dateField} >= ${xdate(b.from)}`)
    if (typeof b.to === 'string') parts.push(`${dateField} <= ${xdate(b.to)}`)
  }
  if (typeof b.amount === 'number' && mode === 'bank_transactions') {
    parts.push(`Total == ${b.amount}`)
  }
  if (typeof b.contains === 'string' && b.contains) {
    const esc = b.contains.replace(/"/g, '')
    if (mode === 'bank_transactions') parts.push(`Reference.Contains("${esc}")`)
    else if (mode === 'manual_journals') parts.push(`Narration.Contains("${esc}")`)
    else if (mode === 'contacts') parts.push(`Name.Contains("${esc}")`)
  }
  return parts.length ? parts.join(' AND ') : null
}

async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors })
  }

  if (!(await isInternalCall(req))) {
    const role = await callerRole(req)
    if (!role || !['admin', 'manager', 'cpa', 'service_role'].includes(role)) {
      return new Response(JSON.stringify({ error: `Reading Xero requires an admin, manager or cpa account (role: ${role ?? 'none'}).` }), { status: 403, headers: cors })
    }
  }

  const b = await req.json().catch(() => ({}))
  const mode = String(b.mode ?? '')

  if (mode === 'whoami') {
    const { tenantId } = await getXeroAuth()
    return new Response(JSON.stringify({
      ok: true, tenant_id: tenantId, granted_scopes: await getGrantedScopes(),
      readable: Object.keys(ENDPOINTS),
      note: 'This function can only read. It has no code path that writes to Xero.',
    }, null, 2), { headers: cors })
  }

  const endpoint = ENDPOINTS[mode]
  if (!endpoint) {
    return new Response(JSON.stringify({
      error: `Unknown mode "${mode || '(none)'}".`,
      modes: [...Object.keys(ENDPOINTS), 'whoami'],
    }), { status: 400, headers: cors })
  }

  // ── the single outbound request ───────────────────────────────────────────
  let url = `${XERO}/${endpoint}`
  const qs: string[] = []
  if (typeof b.id === 'string' && b.id) {
    url += `/${encodeURIComponent(b.id)}`
  } else {
    const where = typeof b.where === 'string' && b.where ? b.where : buildWhere(mode, b)
    if (where) qs.push(`where=${encodeURIComponent(where)}`)
    if (typeof b.page === 'number') qs.push(`page=${b.page}`)
  }
  if (qs.length) url += `?${qs.join('&')}`

  const { headers } = await getXeroAuth()
  const res = await fetch(url, { method: 'GET', headers })
  const text = await res.text()
  if (!res.ok) {
    return new Response(JSON.stringify({
      error: 'Xero read failed', status: res.status, url_without_host: url.replace(XERO, ''),
      details: text.slice(0, 1200),
      hint: res.status === 401 ? 'Often a missing scope rather than a bad token — call mode "whoami" to see what was granted.' : undefined,
    }), { status: 502, headers: cors })
  }

  const json = JSON.parse(text)
  const rows = json[COLLECTION[mode]] ?? []
  const trimmed = b.full === true ? rows : rows.map(TRIM[mode])

  return new Response(JSON.stringify({
    ok: true, mode, count: rows.length,
    query: url.replace(XERO, ''),
    results: trimmed,
  }, null, 2), { headers: cors })
}

Deno.serve(async (req) => {
  try {
    return await handle(req)
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e) }), { status: 500, headers: cors })
  }
})
