import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// ─────────────────────────────────────────────────────────────────────────────
// Bookkeeping → Reconciliation Check (session 212, 2026-08-15)
//
// Rebuilds every loan's balance from Xero's own transactions and compares it to
// the real lender statements on file, then records what it finds.
//
// DESIGN, and the reasoning behind it:
//
//  1. THIS ENGINE IS DETERMINISTIC. No LLM. Everything here is arithmetic and
//     rule-matching, so the same books always produce the same findings. The
//     LLM (phase 3) will sit on TOP of this, turning findings into plain-English
//     judgement — it will never compute a number.
//
//  2. ONLY LIVE XERO ENTRIES COUNT. Xero returns DELETED/VOIDED BankTransactions
//     and VOIDED/DRAFT ManualJournals from the same endpoints as live ones, but
//     neither hits the ledger. Not filtering them is what produced four phantom
//     payments and a fictional $22,103 "gap" before 2026-08-15. isLive() is the
//     single place that decision is made.
//
//  3. "SINCE THE LAST CHECK" IS NOT JUST NEW TRANSACTIONS. Xero lets you edit or
//     delete an old transaction at any time — that is exactly how the phantom
//     payments appeared. So every run also asks Xero for anything MODIFIED since
//     the last run (If-Modified-Since), regardless of its date. If something old
//     changed, the stored checkpoint is no longer trustworthy and the run says so.
//
//  4. FINDINGS ARE KEYED BY FINGERPRINT, NOT BY RUN. Same problem next month =
//     same fingerprint = reported as "still open", not "new". That is what makes
//     a report worth reading: it leads with what changed.
//
//  5. IT NEVER WRITES TO XERO. It reads Xero and writes only its own two tables.
//     Posting a correcting journal remains a separate, explicit human action
//     through loan-xero-post.
// ─────────────────────────────────────────────────────────────────────────────

const INTEREST_CODE = '800'
const STALE_ANCHOR_DAYS = 45
// How far either side of a lumped payment we'll look for its reallocation journal.
// Month-end corrections for an early-month payment can be ~30 days out.
const REALLOC_WINDOW_DAYS = 40
// Sources that represent a real document from the lender, as opposed to a balance
// we derived from Xero ourselves. Only these can anchor a reconciliation — comparing
// Xero against a number we computed from Xero proves nothing.
const REAL_ANCHOR_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const money = (n: number) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
// Pacific business date. Never toISOString() — after 5pm PT that rolls to tomorrow.
const todayPacific = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function callerRole(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
  const { data: { user } } = await anon.auth.getUser(token)
  if (!user) return null
  const { data: profile } = await admin().from('profiles').select('role').eq('id', user.id).single()
  return profile?.role || null
}

// ── Xero ─────────────────────────────────────────────────────────────────────

async function getXeroToken() {
  const clientId = Deno.env.get('XERO_CLIENT_ID')!
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')!
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`Xero token request failed: ${JSON.stringify(j).slice(0, 300)}`)
  return j.access_token as string
}

function normDate(dateString: any, dateRaw: any): string {
  if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateString)) return dateString.slice(0, 10)
  const m = String(dateString || dateRaw || '').match(/\/Date\((-?\d+)/)
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10)
  return String(dateString || dateRaw || '').slice(0, 10)
}

async function fetchPaged(baseUrl: string, token: string, tenantId: string, key: string, modifiedSince?: string | null, maxPages = 25) {
  const all: any[] = []
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json',
  }
  if (modifiedSince) headers['If-Modified-Since'] = new Date(modifiedSince).toUTCString()
  for (let page = 1; page <= maxPages; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    let res: Response | null = null
    let text = ''
    for (let retry = 0; retry < 5; retry++) {
      res = await fetch(`${baseUrl}${sep}page=${page}`, { headers })
      if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || (2 + retry * 3)) * 1000); continue }
      text = await res.text(); break
    }
    if (!res) throw new Error('Xero: no response after retries')
    if (res.status === 429) throw new Error('Xero daily/minute rate limit hit — try again later.')
    if (res.status === 304) break // If-Modified-Since: nothing changed
    let j: any
    try { j = JSON.parse(text) } catch { throw new Error(`Xero returned non-JSON (${res.status}): ${text.slice(0, 200)}`) }
    if (!res.ok) throw new Error(`Xero error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`)
    const items = j[key] || []
    all.push(...items)
    if (items.length < 100) break
    if (page === maxPages) {
      // Hard fail. A truncated pull produces a ledger that is missing real
      // transactions, which silently turns every balance into a false mismatch --
      // exactly what the first live run did on 2026-08-16 (2,500-record cap on a
      // 19-month window, ordered ascending, so nothing after mid-2025 was fetched
      // and all 22 loans "disagreed" with their lender by precisely the payments
      // that were never pulled). Never report a reconciliation from partial data.
      throw new Error(`Xero pull hit the ${maxPages}-page cap for ${key} — window too wide to fetch completely. Narrow the date range.`)
    }
    await sleep(300)
  }
  return all
}

/** The single definition of "this entry actually hits the ledger". See design note 2. */
const isLive = (r: any) => r.srcType === 'BankTransaction' ? r.status === 'AUTHORISED' : r.status === 'POSTED'

/** Signed effect on a liability balance. SPEND pays down; RECEIVE draws more.
 *  ManualJournal LineAmount is already signed (debit +, credit −); a debit to a
 *  liability reduces it. */
function effect(rec: any, code: string) {
  const amt = rec.lines.filter((l: any) => l.c === code).reduce((s: number, l: any) => s + Number(l.a || 0), 0)
  if (rec.srcType === 'BankTransaction') return String(rec.type || '').startsWith('RECEIVE') ? amt : -amt
  return -amt
}

async function pullXero(fromDate: string, toDate: string, modifiedSince: string | null) {
  const token = await getXeroToken()
  const tenantId = Deno.env.get('XERO_TENANT_ID')!

  const norm = (arr: any[], type: 'BankTransaction' | 'ManualJournal') => arr.map((x: any) => type === 'BankTransaction' ? ({
    srcType: 'BankTransaction', srcId: x.BankTransactionID, date: normDate(x.DateString, x.Date),
    status: x.Status, type: x.Type, ref: x.Reference, contact: x.Contact?.Name, total: x.Total,
    lines: (x.LineItems || []).map((l: any) => ({ d: l.Description, c: l.AccountCode, a: l.LineAmount })),
  }) : ({
    srcType: 'ManualJournal', srcId: x.ManualJournalID, date: normDate(x.DateString, x.Date),
    status: x.Status, narration: x.Narration,
    lines: (x.JournalLines || []).map((l: any) => ({ d: l.Description, c: l.AccountCode, a: l.LineAmount })),
  }))

  // In-window entries, pulled ONE MONTH AT A TIME. This org runs ~350-400 bank
  // transactions a month across all accounts, so a monthly slice is ~4 pages and
  // can never approach the page cap. A single wide `where` window can, and when it
  // does the result is silently partial (see the throw in fetchPaged).
  const months: Array<[string, string]> = []
  for (let cur = fromDate.slice(0, 8) + '01'; cur <= toDate;) {
    const d = new Date(cur + 'T00:00:00Z')
    const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    const endOfMonth = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10)
    months.push([cur < fromDate ? fromDate : cur, endOfMonth > toDate ? toDate : endOfMonth])
    cur = nextMonth.toISOString().slice(0, 10)
  }
  if (months.length > 18) throw new Error(`Window spans ${months.length} months — too wide for one run. Narrow it or raise the cap deliberately.`)

  const bt: any[] = []
  const mj: any[] = []
  for (const [mFrom, mTo] of months) {
    const [ay, am, ad] = mFrom.split('-').map(Number)
    const [by, bm, bd] = mTo.split('-').map(Number)
    const w = encodeURIComponent(`Date>=DateTime(${ay},${am},${ad})&&Date<=DateTime(${by},${bm},${bd})`)
    bt.push(...await pullBT(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${w}&order=Date`, token, tenantId, null))
    await sleep(300)
    mj.push(...await pullMJ(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${w}&order=Date`, token, tenantId, null))
    await sleep(300)
  }

  // Anything of ANY date touched since the last run. Design note 3 — this is what
  // catches a bookkeeper deleting a March entry in August.
  let changedOld: any[] = []
  if (modifiedSince) {
    await sleep(350)
    const btc = await pullBT('https://api.xero.com/api.xro/2.0/BankTransactions?order=Date', token, tenantId, modifiedSince, 8)
    await sleep(350)
    const mjc = await pullMJ('https://api.xero.com/api.xro/2.0/ManualJournals?order=Date', token, tenantId, modifiedSince, 8)
    changedOld = [...btc, ...mjc].filter(r => r.date < fromDate)
  }

  async function pullBT(url: string, t: string, ten: string, since: string | null, mp = 25) {
    return norm(await fetchPaged(url, t, ten, 'BankTransactions', since, mp), 'BankTransaction')
  }
  async function pullMJ(url: string, t: string, ten: string, since: string | null, mp = 25) {
    return norm(await fetchPaged(url, t, ten, 'ManualJournals', since, mp), 'ManualJournal')
  }

  const seen = new Set<string>()
  const entries = [...bt, ...mj].filter(r => { if (seen.has(r.srcId)) return false; seen.add(r.srcId); return true })
  return { entries, changedOld }
}

// ── Checks ───────────────────────────────────────────────────────────────────
// Each returns findings. A finding is a plain object; the runner handles storage,
// fingerprint dedup and new/open/resolved bookkeeping.

type Finding = {
  fingerprint: string; check_key: string; severity: 'info' | 'warn' | 'error'
  loan_account_id: string | null; title: string; plain_english: string
  detail: any; proposed_action?: any
}

function buildLedger(entries: any[], codes: string[]) {
  const byCode: Record<string, any[]> = {}
  for (const c of codes) byCode[c] = []
  for (const r of entries) {
    if (!isLive(r)) continue
    const hit = new Set(r.lines.map((l: any) => l.c).filter((c: any) => c && byCode[c]))
    for (const c of hit) byCode[c as string].push(r)
  }
  for (const c of codes) byCode[c].sort((a, b) => a.date.localeCompare(b.date))
  return byCode
}

/** Balance at date D, walking from a known checkpoint. Works in both directions so a
 *  lender anchor that predates the checkpoint can still be compared. */
function balanceAt(code: string, D: string, ledger: Record<string, any[]>, checkpoint: number, checkpointDate: string) {
  let b = checkpoint
  const rows = ledger[code] || []
  if (D >= checkpointDate) {
    for (const r of rows) if (r.date > checkpointDate && r.date <= D) b += effect(r, code)
  } else {
    for (const r of rows) if (r.date > D && r.date <= checkpointDate) b -= effect(r, code)
  }
  return Math.round(b * 100) / 100
}

function checkBalanceVsLender(loan: any, ledger: any, cp: number, cpDate: string, anchors: any[], today: string, windowFrom: string): Finding[] {
  const anchor = anchors[0]
  if (!anchor) return []
  // The ledger only contains what we pulled. Comparing against an anchor that
  // predates the window means walking the balance back through transactions we
  // never fetched — which yields a confident, wrong answer. Skip instead.
  if (anchor.statement_date < windowFrom) return []
  const code = loan.xero_account_code
  const xeroAtAnchor = balanceAt(code, anchor.statement_date, ledger, cp, cpDate)
  const diff = Math.round((xeroAtAnchor - Number(anchor.principal_balance)) * 100) / 100
  if (Math.abs(diff) < 0.02) return []

  // Before calling this an error: is there a POSTED entry dated after the anchor that
  // would close the gap? A month-end-dated correction for an early-month payment looks
  // like a mismatch on the anchor date but is already handled. Report it as info.
  const laterOnLoan = (ledger[code] || []).filter((r: any) => r.date > anchor.statement_date)
  const laterNet = laterOnLoan.reduce((s: number, r: any) => s + effect(r, code), 0)
  const closesIt = laterOnLoan.some((r: any) =>
    r.srcType === 'ManualJournal' && Math.abs(effect(r, code) + diff) < 0.02)

  return [{
    fingerprint: `balance_vs_lender:${code}:${anchor.statement_date}`,
    check_key: 'balance_vs_lender',
    severity: closesIt ? 'info' : 'error',
    loan_account_id: loan.id,
    title: closesIt
      ? `${loan.xero_account_name} — ties once a later-dated correction takes effect`
      : `${loan.xero_account_name} — Xero is ${money(Math.abs(diff))} ${diff < 0 ? 'below' : 'above'} the lender`,
    plain_english: closesIt
      ? `On ${anchor.statement_date} the lender says ${money(Number(anchor.principal_balance))} and Xero says ${money(xeroAtAnchor)}. A correcting journal dated after that statement already covers the ${money(Math.abs(diff))} difference, so nothing is wrong — the two only line up from that journal's date onward. Dating the journal at the payment instead would make them agree continuously.`
      : `Rebuilt from every live entry in Xero, this loan comes to ${money(xeroAtAnchor)} on ${anchor.statement_date}. The lender's own statement for that date says ${money(Number(anchor.principal_balance))} — a difference of ${money(Math.abs(diff))}. Something is either missing from Xero or recorded twice.`,
    detail: { code, anchor_date: anchor.statement_date, anchor_source: anchor.source, lender_balance: Number(anchor.principal_balance), xero_balance: xeroAtAnchor, difference: diff, entries_after_anchor: laterOnLoan.length, net_after_anchor: Math.round(laterNet * 100) / 100 },
  }]
}

function checkLumpedPayments(loan: any, ledger: any, today: string): Finding[] {
  const code = loan.xero_account_code
  const rows = ledger[code] || []
  const out: Finding[] = []
  // Automatic loans (Stripe Capital) repay by straight principal deduction from each
  // Stripe payout, coded directly to the loan account with no interest portion to
  // reallocate — they legitimately have no interest line and never get a loan_splits
  // row. Flagging them as "unsplit" produced ~30 false findings on 2026-08-16, one per
  // daily payout.
  if (loan.ingestion_method === 'automatic') return []
  // A paid-off loan's closing payment is legitimately all principal — there is no
  // interest left to split. Aquarecycle's $7,984.52 payoff on 2026-05-21 was flagged
  // as "missed" on 2026-08-16; it wasn't.
  if (loan.status === 'paid_off') return []
  for (const r of rows) {
    if (r.srcType !== 'BankTransaction') continue
    if (!String(r.type || '').startsWith('SPEND')) continue
    const hasInterestLine = r.lines.some((l: any) => l.c === INTEREST_CODE && Number(l.a) !== 0)
    if (hasInterestLine) continue
    // Is there a reallocation journal near this payment that moves money to interest?
    const paired = rows.some((j: any) => j.srcType === 'ManualJournal'
      && Math.abs(daysBetween(r.date, j.date)) <= REALLOC_WINDOW_DAYS
      && j.lines.some((l: any) => l.c === INTEREST_CODE && Number(l.a) > 0)
      && j.lines.some((l: any) => l.c === code && Number(l.a) < 0))
    if (paired) continue
    const amt = Math.abs(Number(r.total || 0))
    out.push({
      fingerprint: `lumped_payment:${code}:${r.srcId}`,
      check_key: 'lumped_payment',
      severity: daysBetween(r.date, today) > 45 ? 'warn' : 'info',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — ${r.date} payment of ${money(amt)} has no interest split`,
      plain_english: `The whole ${money(amt)} was recorded as paying down the loan, with nothing booked as interest. Until it's split, this loan looks smaller than it is and the month's interest expense is understated. ${daysBetween(r.date, today) > 45 ? 'This one is over 45 days old, so it is probably genuinely missed rather than just pending month-end.' : 'Recent — most likely just waiting for month-end or the lender statement.'}`,
      detail: { code, date: r.date, amount: amt, bank_transaction_id: r.srcId, contact: r.contact, age_days: daysBetween(r.date, today) },
      proposed_action: { kind: 'reallocation_journal', note: 'Split principal/interest once the lender statement or schedule gives the exact figures, then post via loan-xero-post.' },
    })
  }
  return out
}

function checkFutureDatedStatements(loan: any, statements: any[], today: string): Finding[] {
  const future = statements.filter(s => s.statement_date > today)
  if (!future.length) return []
  // `statements` arrives newest-first, so the furthest-out row is future[0]. Reading
  // future[future.length - 1] reported the NEAREST future date instead — which is how
  // Verdant's schedule, running to 2032, was described as ending on 2026-09-10.
  const furthest = future[0]
  return [{
    fingerprint: `future_dated_rows:${loan.xero_account_code}`,
    check_key: 'future_dated_rows',
    severity: 'info',
    loan_account_id: loan.id,
    title: `${loan.xero_account_name} — ${future.length} projected row${future.length === 1 ? '' : 's'} stored as statements`,
    plain_english: `${future.length === 1 ? 'One row' : `${future.length} rows`} in the statements table for this loan ${future.length === 1 ? 'is' : 'are'} dated in the future, the furthest on ${furthest.statement_date}. Those are projections, not statements — they describe what the balance is expected to be, not what a lender has confirmed. They're filtered out of the balance shown on screen, so nothing is wrong today; they just don't belong in a table of statements.`,
    detail: { code: loan.xero_account_code, future_row_count: future.length, furthest_date: furthest.statement_date, furthest_balance: Number(furthest.principal_balance) },
  }]
}

function checkStaleAnchor(loan: any, anchors: any[], today: string, futureOnlyAnchor: boolean): Finding[] {
  if (loan.status !== 'active') return []
  // Stripe Capital repays automatically out of each payout and has no statement to
  // chase — its balance is a live Xero snapshot by design. Asking for a document
  // that will never exist is not a finding.
  if (loan.ingestion_method === 'automatic') return []
  const anchor = anchors[0]
  const age = anchor ? daysBetween(anchor.statement_date, today) : null
  if (anchor && age !== null && age <= STALE_ANCHOR_DAYS) return []
  const isSchedule = anchor?.source === 'amortization_schedule'
  return [{
    fingerprint: `stale_anchor:${loan.xero_account_code}`,
    check_key: 'stale_anchor',
    severity: age === null || age > 365 ? 'warn' : 'info',
    loan_account_id: loan.id,
    title: anchor
      ? `${loan.xero_account_name} — newest lender document is ${age} days old`
      : futureOnlyAnchor
        ? `${loan.xero_account_name} — the only lender document on file is dated in the future`
        : `${loan.xero_account_name} — no lender document on file`,
    plain_english: anchor
      ? `The most recent ${isSchedule ? 'amortization schedule row' : 'statement'} from this lender is dated ${anchor.statement_date}, ${age} days ago. Everything since is our own arithmetic with nothing independent to check it against. A current document is what turns this loan from "probably right" into "verified".`
      : futureOnlyAnchor
        ? `Every lender document on file for this loan is dated ahead of today, so none of them can confirm what the balance is now. A current statement would fix that.`
        : `There is no lender statement, portal pull or amortization schedule on file for this loan, so its balance has never been checked against anything outside Xero.`,
    detail: { code: loan.xero_account_code, latest_anchor: anchor?.statement_date ?? null, anchor_source: anchor?.source ?? null, age_days: age, future_only: futureOnlyAnchor },
  }]
}

function checkDerivedDrift(loan: any, ledger: any, cp: number, cpDate: string, derived: any[], windowFrom: string): Finding[] {
  const code = loan.xero_account_code
  const out: Finding[] = []
  for (const d of derived) {
    if (d.statement_date < windowFrom) continue      // outside what we pulled — can't judge
    if (d.principal_balance == null) continue
    const computed = balanceAt(code, d.statement_date, ledger, cp, cpDate)
    const diff = Math.round((Number(d.principal_balance) - computed) * 100) / 100
    if (Math.abs(diff) < 0.02) continue
    out.push({
      fingerprint: `derived_drift:${code}:${d.statement_date}`,
      check_key: 'derived_drift',
      severity: 'warn',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — our stored balance for ${d.statement_date} disagrees with Xero by ${money(Math.abs(diff))}`,
      plain_english: `WashRoute has ${money(Number(d.principal_balance))} recorded for ${d.statement_date}, but rebuilding that date from Xero's live entries gives ${money(computed)}. Xero is the source of truth here, so our stored copy is the one that's wrong. This is usually caused by a deleted Xero entry that our records still count.`,
      detail: { code, date: d.statement_date, stored: Number(d.principal_balance), computed, difference: diff },
    })
  }
  return out
}

function checkNonLiveCounted(loan: any, allEntries: any[], derived: any[], splits: any[]): Finding[] {
  const code = loan.xero_account_code
  const touchesCode = (r: any) => r.lines.some((l: any) => l.c === code)

  // A deleted or voided entry sitting next to a live one is ordinary bookkeeping --
  // a draft withdrawn, a sync retried. On 2026-08-16 Stripe Capital alone had 16
  // voided entries on a single day from its payout sync, and the first version of
  // this check reported every one of them. Xero being messy is not a finding.
  //
  // The only thing that matters is whether WE ended up counting more payments for a
  // date than Xero actually has live entries for. That is the real double-count, and
  // it is what produced the four phantom payments found on 2026-08-15. One finding
  // per date, not per dead entry.
  const deadDates = new Set(allEntries.filter(r => touchesCode(r) && !isLive(r)).map(r => r.date))
  const out: Finding[] = []
  for (const date of [...deadDates].sort()) {
    const liveCount = allEntries.filter(r => touchesCode(r) && isLive(r) && r.date === date).length
    const storedSplits = splits.filter(sp => sp.period_label === date)
    if (storedSplits.length <= liveCount) continue   // our records agree with Xero — fine
    const deadCount = allEntries.filter(r => touchesCode(r) && !isLive(r) && r.date === date).length
    const extra = storedSplits.length - liveCount
    out.push({
      fingerprint: `non_live_counted:${code}:${date}`,
      check_key: 'non_live_counted',
      severity: 'error',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name} — ${date} has ${storedSplits.length} payment record${storedSplits.length === 1 ? '' : 's'} but only ${liveCount} live entr${liveCount === 1 ? 'y' : 'ies'} in Xero`,
      plain_english: `WashRoute records ${storedSplits.length} payment${storedSplits.length === 1 ? '' : 's'} for ${date}, but Xero only has ${liveCount} that actually affect${liveCount === 1 ? 's' : ''} the books (plus ${deadCount} deleted or voided). That means ${money(storedSplits.reduce((t: number, sp: any) => t + Number(sp.total_amount || 0), 0))} of recorded payments is over-counted by roughly ${extra} payment${extra === 1 ? '' : 's'} — a withdrawn draft was almost certainly treated as a real one.`,
      detail: { code, date, stored_split_count: storedSplits.length, live_entry_count: liveCount, dead_entry_count: deadCount,
                stored_total: storedSplits.reduce((t: number, sp: any) => t + Number(sp.total_amount || 0), 0) },
    })
  }
  return out
}

// ── Report ───────────────────────────────────────────────────────────────────

function renderReport(run: any, findings: any[], loansById: Record<string, any>, meta: any) {
  const sev = (s: string) => s === 'error' ? '#dc2626' : s === 'warn' ? '#b45309' : '#3b82f6'
  const group = (label: string, rows: any[], tone: string) => !rows.length ? '' : `
    <h2 style="font-size:16px;margin:26px 0 10px">${label} <span style="color:#9ca3af;font-weight:400">(${rows.length})</span></h2>
    ${rows.map(f => `<div style="border:1px solid #e5e7eb;border-left:3px solid ${tone};border-radius:8px;padding:12px 14px;margin-bottom:8px;background:#fff">
      <div style="font-weight:600;font-size:14px">${esc(f.title)}</div>
      <div style="font-size:13px;color:#4b5563;margin-top:5px;line-height:1.55">${esc(f.plain_english)}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:7px;font-family:ui-monospace,Menlo,monospace">${esc(f.check_key)} · ${esc(f.severity)}</div>
    </div>`).join('')}`

  const isNew = findings.filter(f => f._state === 'new')
  const still = findings.filter(f => f._state === 'open')
  const done = findings.filter(f => f._state === 'resolved')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconciliation Check — ${run.started_at.slice(0, 10)}</title></head>
<body style="margin:0;background:#f3f4f6;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:900px;margin:0 auto;padding:28px 18px 60px">
  <div style="background:#0f2744;color:#fff;border-radius:10px;padding:24px 28px;margin-bottom:20px">
    <h1 style="margin:0 0 5px;font-size:23px">Reconciliation Check</h1>
    <p style="margin:0;color:#9fb6d4;font-size:13.5px">Family Laundry · ${run.started_at.slice(0, 10)} · ${meta.loansChecked} loans · ${esc(run.mode)} run covering ${esc(run.period_from)} → ${esc(run.period_to)}</p>
  </div>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin-bottom:8px;font-size:14.5px">
    <strong>${isNew.length} new · ${still.length} still open · ${done.length} resolved</strong>
    ${meta.previousRunAt ? ` since the previous check on ${esc(String(meta.previousRunAt).slice(0, 10))}.` : ' — this is the first recorded check.'}
    ${!isNew.length && !still.length ? '<div style="color:#059669;margin-top:6px">Everything reconciles. No open findings.</div>' : ''}
    ${meta.changedOldCount ? `<div style="color:#b45309;margin-top:6px">${meta.changedOldCount} transaction(s) dated before this window were edited or deleted in Xero since the last check — they were pulled in and re-checked.</div>` : ''}
  </div>
  ${group('New findings', isNew, '#b45309')}
  ${group('Still open', still, '#d1d5db')}
  ${group('Resolved since last check', done, '#059669')}
  <div style="margin-top:34px;padding-top:16px;border-top:1px solid #d1d5db;color:#6b7280;font-size:12px">
    Every balance above was rebuilt from Xero's own BankTransactions and ManualJournals, counting only live
    entries (AUTHORISED / POSTED), and compared against real lender statements. This check reads Xero and
    never writes to it — correcting journals are posted separately, by a person.
  </div>
</div></body></html>`
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function handle(req: Request): Promise<Response> {
  const supa = admin()
  const body = await req.json().catch(() => ({}))
  const mode = body.mode === 'deep' ? 'deep' : 'incremental'
  const runBy = body.run_by || null
  const today = todayPacific()

  const role = await callerRole(req)
  if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
    return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403 })
  }

  // Rate-limit: a full run hits Xero hard, and session 205 lost ~17 hours to a
  // daily-quota lockout. One run per 10 minutes unless explicitly forced.
  const { data: recent } = await supa.from('reconciliation_runs')
    .select('id, started_at, status').order('started_at', { ascending: false }).limit(1)
  const last = recent?.[0]
  if (last && !body.force && Date.now() - Date.parse(last.started_at) < 10 * 60 * 1000 && last.status !== 'failed') {
    return new Response(JSON.stringify({
      error: 'A check already ran in the last 10 minutes. Xero has a daily API quota worth protecting — try again shortly, or pass force:true.',
      last_run_at: last.started_at,
    }), { status: 429 })
  }

  const { data: lastComplete } = await supa.from('reconciliation_runs')
    .select('id, started_at, period_to, summary').eq('status', 'complete')
    .order('started_at', { ascending: false }).limit(1)
  const prev = lastComplete?.[0] || null
  const checkpoints: Record<string, number> = prev?.summary?.checkpoint || {}
  const checkpointDate: string | null = prev?.period_to || null

  const { data: run } = await supa.from('reconciliation_runs').insert({
    status: 'running', trigger_source: 'manual', mode, run_by: runBy, period_to: today,
    xero_modified_since: prev?.started_at ?? null,
  }).select().single()

  try {
    const [{ data: loans }, { data: statements }, { data: splits }, { data: amortRows }] = await Promise.all([
      supa.from('loan_accounts').select('*'),
      supa.from('loan_statements').select('*').order('statement_date', { ascending: false }),
      supa.from('loan_splits').select('*'),
      // An amortization schedule IS a lender document. Several loans here (Dexter 2,
      // PCV, Verdant, PayPal 2) are reconciled against a schedule rather than a
      // monthly statement, and the first live version of this check told David they
      // had "never been checked against anything outside Xero" — flatly untrue, and
      // the kind of wrong that erodes trust in every other finding on the page.
      supa.from('loan_amortization_rows')
        .select('row_date, balance, loan_amortization_schedules!inner(loan_account_id)')
        .not('balance', 'is', null),
    ])
    const active = (loans || []).filter(l => l.xero_account_code)
    const codes = active.map(l => l.xero_account_code)

    // Window: far enough back to cover every lender anchor we need to compare against,
    // plus the checkpoint, plus a small buffer. Anchors on active loans are recent, so
    // this stays cheap — a normal run pulls ~60 days, not ten years.
    const anchorDates = (statements || [])
      .filter(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date <= today)
      .map(s => s.statement_date)
    let windowFrom = body.from_date
      || [checkpointDate, ...anchorDates.slice().sort()].filter(Boolean).sort()[0]
      || addDays(today, -120)
    windowFrom = addDays(windowFrom, -5)
    // Floor at 120 days. Without this, one loan holding an old lender statement
    // (EIDL's newest is from 2024) drags the window back years, which is both slow
    // and the thing that broke the first live run. Anchors older than the window
    // were already verified by whichever run covered them.
    const floorFrom = addDays(today, -120)
    if (windowFrom < floorFrom) windowFrom = floorFrom
    if (mode === 'deep') windowFrom = body.from_date || addDays(today, -365)

    // Pull PAST today. Month-end accrual journals are routinely dated at the end of the
    // current month, so a window that stops at today would miss a correction that has
    // already been posted and wrongly report the payment it corrects as unsplit. The
    // checkpoint and every "as of" balance still cut off at today — balanceAt() filters
    // by date — so future-dated entries inform the checks without inflating the balance.
    const pullTo = addDays(today, 60)

    const { entries, changedOld } = await pullXero(windowFrom, pullTo, prev?.started_at ?? null)
    const relevantChangedOld = changedOld.filter(r => r.lines.some((l: any) => codes.includes(l.c)))
    const allEntries = [...entries, ...relevantChangedOld]
    const ledger = buildLedger(allEntries, codes)

    const findings: Finding[] = []
    for (const loan of active) {
      const code = loan.xero_account_code
      const cpDate = checkpointDate || windowFrom
      const cp = checkpoints[code] ?? 0
      const haveCheckpoint = checkpointDate != null && checkpoints[code] != null
      const mine = (statements || []).filter(s => s.loan_account_id === loan.id)
      const stmtAnchors = mine
        .filter(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date <= today)
        .map(s => ({ statement_date: s.statement_date, principal_balance: s.principal_balance, source: s.source }))
      const schedAnchors = (amortRows || [])
        .filter((r: any) => r.loan_amortization_schedules?.loan_account_id === loan.id && r.row_date <= today)
        .map((r: any) => ({ statement_date: r.row_date, principal_balance: r.balance, source: 'amortization_schedule' }))
      // Newest first, so anchors[0] is the most recent document of either kind.
      const anchors = [...stmtAnchors, ...schedAnchors].sort((a, b) => b.statement_date.localeCompare(a.statement_date))
      const futureOnlyAnchor = !anchors.length && mine.some(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date > today)
      const derived = mine.filter(s => s.source === 'xero_derived' && s.statement_date <= today)
      const mySplits = (splits || []).filter(s => s.loan_account_id === loan.id)

      // Balance-dependent checks need a trustworthy starting point.
      if (haveCheckpoint) {
        findings.push(...checkBalanceVsLender(loan, ledger, cp, cpDate, anchors, today, windowFrom))
        findings.push(...checkDerivedDrift(loan, ledger, cp, cpDate, derived, windowFrom))
      }
      findings.push(...checkLumpedPayments(loan, ledger, today))
      findings.push(...checkFutureDatedStatements(loan, mine, today))
      findings.push(...checkStaleAnchor(loan, anchors, today, futureOnlyAnchor))
      findings.push(...checkNonLiveCounted(loan, allEntries.filter((r: any) => r.date >= windowFrom), derived, mySplits))
    }

    // ── new / still-open / resolved, by fingerprint ──
    const { data: existing } = await supa.from('reconciliation_findings').select('*')
    const byFp: Record<string, any> = Object.fromEntries((existing || []).map(f => [f.fingerprint, f]))
    const seenFps = new Set(findings.map(f => f.fingerprint))
    const enriched: any[] = []

    for (const f of findings) {
      const prevF = byFp[f.fingerprint]
      if (prevF?.status === 'suppressed') continue   // deliberately dismissed; stays dismissed
      const state = prevF && prevF.status === 'open' ? 'open' : 'new'
      enriched.push({ ...f, _state: state, ...(prevF?.pinned_note ? { title: prevF.title, plain_english: prevF.plain_english, proposed_action: prevF.proposed_action } : {}) })
      // A pinned finding (David or a CPA hand-wrote a diagnosis on it, e.g. via the
      // dashboard) keeps its own title/plain_english/proposed_action forever — the
      // engine still tracks new/open/resolved state and last_seen for it, but stops
      // overwriting the human explanation with its generic template. Otherwise every
      // hand-written "here's what explains it, here's what to do" note gets silently
      // clobbered on the next run, same failure shape as the v5 window-resolve bug.
      await supa.from('reconciliation_findings').upsert({
        fingerprint: f.fingerprint, loan_account_id: f.loan_account_id, check_key: f.check_key,
        severity: f.severity,
        ...(prevF?.pinned_note ? {} : { title: f.title, plain_english: f.plain_english, proposed_action: f.proposed_action ?? null }),
        detail: f.detail, status: 'open',
        first_seen_run_id: prevF?.first_seen_run_id ?? run.id,
        first_seen_at: prevF?.first_seen_at ?? new Date().toISOString(),
        last_seen_run_id: run.id, last_seen_at: new Date().toISOString(),
        resolved_at: null, resolved_run_id: null,
      }, { onConflict: 'fingerprint' })
    }

    // Anything previously open that this run did NOT re-find is resolved —
    // UNLESS the finding's own date falls before this run's pulled window, in
    // which case it wasn't re-examined at all and "not re-found" just means
    // "out of range", not "fixed". v5 marked E-Transit 4140's 2026-04-17 lumped
    // payment "resolved" on 2026-08-16 for exactly this reason: the 120-day
    // floor put windowFrom at 2026-04-18, one day after the payment, so the
    // check never even looked at it. A finding that falls off the edge of the
    // window must stay open, not get swept into "resolved" by default.
    const resolvedNow = (existing || []).filter(f => {
      if (f.status !== 'open' || seenFps.has(f.fingerprint)) return false
      const d = f.detail?.date ?? f.detail?.anchor_date
      if (d && d < windowFrom) return false
      return true
    })
    for (const f of resolvedNow) {
      await supa.from('reconciliation_findings').update({
        status: 'resolved', resolved_at: new Date().toISOString(), resolved_run_id: run.id,
      }).eq('fingerprint', f.fingerprint)
      enriched.push({ ...f, _state: 'resolved' })
    }

    // New checkpoint for the next run.
    const newCheckpoint: Record<string, number> = {}
    for (const loan of active) {
      const code = loan.xero_account_code
      const cpDate = checkpointDate || windowFrom
      newCheckpoint[code] = checkpoints[code] != null
        ? balanceAt(code, today, ledger, checkpoints[code], cpDate)
        : (checkpoints[code] ?? 0)
    }

    const counts = {
      findings_new: enriched.filter(f => f._state === 'new').length,
      findings_open: enriched.filter(f => f._state === 'open').length,
      findings_resolved: enriched.filter(f => f._state === 'resolved').length,
    }

    const meta = { loansChecked: active.length, previousRunAt: prev?.started_at ?? null, changedOldCount: relevantChangedOld.length }
    const html = renderReport({ ...run, mode, period_from: windowFrom, period_to: today }, enriched, {}, meta)
    const reportPath = `reconciliation/${today}-${run.id}.html`
    await supa.storage.from('loan-statements').upload(reportPath, new Blob([html], { type: 'text/html' }), { upsert: true, contentType: 'text/html' })

    await supa.from('reconciliation_runs').update({
      status: 'complete', finished_at: new Date().toISOString(),
      period_from: windowFrom, period_to: today,
      checks_run: 6, loans_checked: active.length, ...counts,
      summary: {
        checkpoint: newCheckpoint,
        xero_entries_scanned: allEntries.length,
        changed_old_entries: relevantChangedOld.length,
        checkpoint_trusted: checkpointDate != null,
      },
      narrative_source: 'template',
      report_path: reportPath,
    }).eq('id', run.id)

    return new Response(JSON.stringify({
      ok: true, run_id: run.id, mode, period_from: windowFrom, period_to: today,
      ...counts, report_path: reportPath,
      changed_old_entries: relevantChangedOld.length,
      findings: enriched.map(f => ({ state: f._state, severity: f.severity, check: f.check_key, title: f.title })),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } })
  } catch (err: any) {
    await supa.from('reconciliation_runs').update({
      status: 'failed', finished_at: new Date().toISOString(), error_message: String(err?.message || err),
    }).eq('id', run.id)
    return new Response(JSON.stringify({ error: String(err?.message || err), run_id: run.id }), { status: 500 })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const res = await handle(req)
  const h = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors)) h.set(k, v)
  if (!h.has('Content-Type')) h.set('Content-Type', 'application/json')
  return new Response(res.body, { status: res.status, headers: h })
})
