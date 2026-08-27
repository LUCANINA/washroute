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
//   { mode: 'payment_picture'   <-- START HERE for any question about a payment
//         | 'bank_transactions' | 'manual_journals' | 'invoices' | 'accounts'
//         | 'contacts' | 'whoami',
//     id?: string,              // fetch exactly one by Xero id
//     date?: string,            // 'YYYY-MM-DD' — that day only
//     from?: string, to?: string,
//     amount?: number,          // matches Total (bank txns) / line total (journals)
//     contains?: string,        // substring of reference / narration / name
//     where?: string,           // raw Xero where clause, escape hatch. Still GET-only.
//     page?: number,
//     full?: boolean,           // return Xero's untrimmed objects
//     window_days?: number }     // payment_picture: how far forward to look (default 120)
//
// ── WHY payment_picture EXISTS: A TRANSACTION IS NEVER THE WHOLE ANSWER ──────
// Session 232 got this wrong twice in one day, in both directions.
//
//   Funding Circle 2026-07-20: the bank transaction looked correctly split at source.
//   It was ALSO carrying a manual journal doing the same correction again -- $1,023.20
//   of interest counted twice. Reading the transaction alone said "fine".
//
//   Verdant 2025-07-10: the bank transaction was coded entirely to Income Tax Expense
//   and looked like a $4,543.32 misclassification. A journal dated 2025-08-31 had
//   already recoded it. Reading the transaction alone said "broken".
//
// A transaction plus its later journals is the unit of truth; either half on its own
// is a coin flip.
//
// SESSION 241: for its whole life this mode saw the transaction half only. Xero's
// ManualJournals LIST endpoint returns no JournalLines, so the account filter had
// nothing to match and "No posted journal touches this transaction" came back for
// every payment, always. Both examples below were reported correctly at the time
// only because a human read the journals by hand. Journals are now fetched by id,
// and the response carries `journal_search` so a caller can tell "nothing
// corrected this" apart from "we did not manage to look". So the product should not make the double check something a careful
// person remembers to do -- it should be the default way to ask about a payment.
// That is this mode: one call, both halves, netted per account, with the two dangerous
// shapes (corrected twice / never corrected) named in `warnings`.
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


// ── payment_picture ─────────────────────────────────────────────────────────
// The transaction AND every journal that touches its accounts afterwards, netted.
// See the header block for why this is the default way to ask about a payment.

const r2 = (n: number) => Math.round(n * 100) / 100

const xdate = (s: string) => {
  const [y, m, day] = s.split('-').map((n: string) => parseInt(n, 10))
  return `DateTime(${y},${m},${day})`
}

async function xeroGet(path: string, headers: Record<string, string>) {
  const res = await fetch(`${XERO}/${path}`, { method: 'GET', headers })
  const text = await res.text()
  if (!res.ok) throw new Error(`Xero read failed (${res.status}) on /${path.split('?')[0]}: ${text.slice(0, 400)}`)
  return JSON.parse(text)
}

// ── Journals, WITH their lines ───────────────────────────────────────────────
//
// Xero's ManualJournals LIST endpoint does not return JournalLines. Every
// journal it hands back carries `lines: []`, so any filter of the shape
//
//     journals.filter(j => j.lines.some(l => codes.has(l.account)))
//
// is structurally incapable of matching anything, and payment_picture reported
// "No posted journal touches this transaction" for EVERY payment ever passed to
// it. The mode exists specifically to catch a payment split at source AND
// reallocated by journal -- and it could not see a journal at all.
//
// Found session 241, by asking Xero for two journals BY ID that the same
// function had just declared did not exist. The file already knew the rule
// twenty lines above ("A transaction fetched by id carries its lines; one from
// a list search may not") and applied it to bank transactions only.
//
// Lines come back only when a journal is fetched by id, so that is what this
// does. Bounded, because Xero rate-limits at 60/min: a cap that is announced
// rather than silent, and read failures that are counted rather than swallowed.
// A journal we could not read is NOT a journal that does not touch the account.
const JOURNAL_FETCH_CAP = 150
// Xero allows 5 concurrent calls and 60 per minute. The first cut used 6 and no
// pacing, which is over BOTH limits: run live against a 200-day window it read 57
// of 155 journals and lost 93 to rate limiting. The honesty machinery below did
// its job -- it reported complete:false and refused to claim an absence -- but a
// diagnostic that can only see a third of the evidence is not much better than
// one that saw none, which was the whole complaint about this function.
const JOURNAL_FETCH_CONCURRENCY = 5        // Xero's stated concurrent maximum
const JOURNAL_RATE_PER_MIN = 58            // just under Xero's 60/min
const JOURNAL_RETRIES = 2
// The edge function's own wall clock is the other limit, and it bit immediately:
// pacing 155 journals at a safe rate takes ~2.8 minutes and the invocation died
// with a 504 at 150s, which is worse than the incomplete answer it replaced.
// Fast enough to be rate-limited and slow enough to time out are both failures;
// the way out is to bound the WORK and say exactly what was left undone.
const JOURNAL_TIME_BUDGET_MS = 75_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// One journal, with the retry Xero explicitly asks for. A 429 carries Retry-After
// in seconds; honouring it is the difference between a slow answer and a wrong one.
async function fetchOneJournal(id: string, headers: Record<string, string>) {
  for (let attempt = 0; attempt <= JOURNAL_RETRIES; attempt++) {
    try {
      const res = await fetch(`${XERO}/ManualJournals/${encodeURIComponent(id)}`, { method: 'GET', headers })
      if (res.status === 429) {
        const wait = Math.min(Number(res.headers.get('Retry-After') || 0) || 5, 30)
        await res.text().catch(() => '')
        if (attempt === JOURNAL_RETRIES) return undefined
        await sleep(wait * 1000)
        continue
      }
      const text = await res.text()
      if (!res.ok) return undefined
      return (JSON.parse(text).ManualJournals ?? [])[0] ?? null
    } catch (_) {
      if (attempt === JOURNAL_RETRIES) return undefined
      await sleep(500 * (attempt + 1))
    }
  }
  return undefined
}

async function fetchJournalsWithLines(ids: string[], headers: Record<string, string>) {
  const journals: any[] = []
  let unreadable = 0
  let notAttempted = 0
  const began = Date.now()
  const minMsPerBatch = Math.ceil((JOURNAL_FETCH_CONCURRENCY / JOURNAL_RATE_PER_MIN) * 60_000)
  for (let i = 0; i < ids.length; i += JOURNAL_FETCH_CONCURRENCY) {
    if (Date.now() - began > JOURNAL_TIME_BUDGET_MS) { notAttempted = ids.length - i; break }
    const startedAt = Date.now()
    const chunk = ids.slice(i, i + JOURNAL_FETCH_CONCURRENCY)
    const settled = await Promise.all(chunk.map((id) => fetchOneJournal(id, headers)))
    for (const j of settled) {
      if (j === undefined) unreadable++      // undefined = could not read, null = not found
      else if (j) journals.push(j)
    }
    // Pace the NEXT batch rather than sleeping after the last one.
    if (i + JOURNAL_FETCH_CONCURRENCY < ids.length) {
      const spent = Date.now() - startedAt
      if (spent < minMsPerBatch) await sleep(minMsPerBatch - spent)
    }
  }
  return { journals, unreadable, notAttempted }
}

async function paymentPicture(b: any): Promise<Response> {
  const windowDays = typeof b.window_days === 'number' ? Math.min(Math.max(b.window_days, 1), 730) : 120
  const { headers } = await getXeroAuth()

  // 1. the transaction
  let txns: any[]
  if (typeof b.id === 'string' && b.id) {
    txns = (await xeroGet(`BankTransactions/${encodeURIComponent(b.id)}`, headers)).BankTransactions ?? []
  } else {
    if (typeof b.date !== 'string' || typeof b.amount !== 'number') {
      return new Response(JSON.stringify({
        error: 'payment_picture needs either an `id`, or a `date` ("YYYY-MM-DD") and an `amount`.',
      }), { status: 400, headers: cors })
    }
    const next = new Date(b.date + 'T00:00:00Z')
    next.setUTCDate(next.getUTCDate() + 1)
    const where = `Date >= ${xdate(b.date)} AND Date < ${xdate(next.toISOString().slice(0, 10))} AND Total == ${b.amount}`
    txns = (await xeroGet(`BankTransactions?where=${encodeURIComponent(where)}`, headers)).BankTransactions ?? []
  }
  if (!txns.length) {
    return new Response(JSON.stringify({ ok: true, mode: 'payment_picture', found: false, note: 'No bank transaction matched.' }), { headers: cors })
  }
  if (txns.length > 1) {
    return new Response(JSON.stringify({
      ok: true, mode: 'payment_picture', found: false,
      note: `${txns.length} transactions match that date and amount -- call again with one of these ids.`,
      candidates: txns.map(trimBankTransaction),
    }), { headers: cors })
  }

  // A transaction fetched by id carries its lines; one from a list search may not.
  let txn = txns[0]
  if (!(txn.LineItems || []).length && txn.BankTransactionID) {
    const one = (await xeroGet(`BankTransactions/${txn.BankTransactionID}`, headers)).BankTransactions ?? []
    if (one.length) txn = one[0]
  }
  const t = trimBankTransaction(txn)
  const codes = new Set((t.lines || []).map((l: any) => String(l.account)).filter((c: string) => c && c !== 'null'))

  // 2. journals in the window that touch any of those accounts
  const from = String(t.date)
  const toDate = new Date(from + 'T00:00:00Z')
  toDate.setUTCDate(toDate.getUTCDate() + windowDays)
  const to = toDate.toISOString().slice(0, 10)
  const jWhere = `Date >= ${xdate(from)} AND Date <= ${xdate(to)}`
  const listed = (await xeroGet(`ManualJournals?where=${encodeURIComponent(jWhere)}`, headers)).ManualJournals ?? []
  // The list gives ids and dates; it does NOT give lines. See fetchJournalsWithLines.
  const capped = listed.length > JOURNAL_FETCH_CAP
  const ids = listed.slice(0, JOURNAL_FETCH_CAP)
    .map((j: any) => String(j.ManualJournalID || ''))
    .filter(Boolean)
  const { journals, unreadable, notAttempted } = await fetchJournalsWithLines(ids, headers)

  const touching = journals
    .map(trimManualJournal)
    .filter((j: any) => (j.lines || []).some((l: any) => codes.has(String(l.account))))
  const posted = touching.filter((j: any) => j.status === 'POSTED')
  const notPosted = touching.filter((j: any) => j.status !== 'POSTED')
  // True only when the search was actually complete. Everything that reports an
  // absence below has to consult this first.
  const searchComplete = !capped && unreadable === 0 && notAttempted === 0

  // 3. net it out, per account
  const net: Record<string, { from_transaction: number; from_journals: number }> = {}
  for (const l of t.lines || []) {
    const c = String(l.account)
    net[c] = net[c] || { from_transaction: 0, from_journals: 0 }
    net[c].from_transaction = r2(net[c].from_transaction + Number(l.amount || 0))
  }
  for (const j of posted) {
    for (const l of j.lines || []) {
      const c = String(l.account)
      if (!codes.has(c)) continue
      net[c] = net[c] || { from_transaction: 0, from_journals: 0 }
      net[c].from_journals = r2(net[c].from_journals + Number(l.amount || 0))
    }
  }

  // account names, so the answer is readable without a second lookup
  let names: Record<string, string> = {}
  try {
    const codeList = Object.keys(net)
    if (codeList.length) {
      const w = codeList.map((c) => `Code=="${c}"`).join(' OR ')
      const accts = (await xeroGet(`Accounts?where=${encodeURIComponent(w)}`, headers)).Accounts ?? []
      names = Object.fromEntries(accts.map((a: any) => [String(a.Code), a.Name]))
    }
  } catch (_) { /* names are a nicety, never a reason to fail the answer */ }

  // 4. the two shapes that have actually bitten
  const warnings: string[] = []
  if (capped) {
    warnings.push(`${listed.length} journals fall in this window and only the first ${JOURNAL_FETCH_CAP} were read. Narrow window_days -- anything below is about that subset, not the whole window.`)
  }
  if (unreadable) {
    warnings.push(`${unreadable} journal(s) in this window could not be read from Xero, so this picture may be incomplete. A failed lookup is not evidence of absence -- re-run before concluding anything from it.`)
  }
  if (notAttempted) {
    warnings.push(`${notAttempted} journal(s) in this window were not examined -- reading them all at a rate Xero accepts would outlast this request. Narrow window_days (each call reads about ${Math.floor(JOURNAL_TIME_BUDGET_MS / 1000 * (JOURNAL_RATE_PER_MIN / 60))} journals) and the answer will be complete.`)
  }
  if (posted.length === 0 && searchComplete) {
    warnings.push('No posted journal touches this transaction. Its own coding is the whole story -- if that coding is wrong, nothing later fixes it.')
  } else if (posted.length === 0) {
    warnings.push('No posted journal was found touching this transaction, but the search above was incomplete -- do NOT read this as "nothing corrected it".')
  }
  if (posted.length > 1) {
    warnings.push(`${posted.length} posted journals touch this transaction's accounts. Check they are not correcting the same thing twice.`)
  }
  for (const [code, v] of Object.entries(net)) {
    if (v.from_transaction !== 0 && v.from_journals !== 0
        && Math.sign(v.from_transaction) !== Math.sign(v.from_journals)
        && Math.abs(v.from_journals) > Math.abs(v.from_transaction) * 0.5) {
      warnings.push(`Account ${code}${names[code] ? ' (' + names[code] + ')' : ''} is moved ${v.from_transaction} by the transaction and ${v.from_journals} by journal, leaving ${r2(v.from_transaction + v.from_journals)}. A payment split at source AND reallocated by journal is the double-correction shape -- confirm it is deliberate.`)
    }
  }
  if (notPosted.length) {
    warnings.push(`${notPosted.length} journal(s) touching these accounts are not POSTED (voided or draft) and were excluded from the net.`)
  }

  return new Response(JSON.stringify({
    ok: true, mode: 'payment_picture', found: true,
    transaction: t,
    window: { from, to, days: windowDays },
    // So a caller can tell "nothing corrected this" from "we did not manage to look".
    journal_search: { listed: listed.length, read: journals.length, unreadable, not_attempted: notAttempted, capped, complete: searchComplete },
    posted_journals: posted,
    excluded_journals: notPosted,
    net_by_account: Object.entries(net).map(([code, v]) => ({
      account: code, name: names[code] ?? null,
      from_transaction: v.from_transaction, from_journals: v.from_journals,
      net: r2(v.from_transaction + v.from_journals),
    })),
    warnings,
  }, null, 2), { headers: cors })
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

  if (mode === 'payment_picture') return await paymentPicture(b)

  const endpoint = ENDPOINTS[mode]
  if (!endpoint) {
    return new Response(JSON.stringify({
      error: `Unknown mode "${mode || '(none)'}".`,
      modes: ['payment_picture', ...Object.keys(ENDPOINTS), 'whoami'],
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
