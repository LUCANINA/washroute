import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'
// INTEREST_CODE, money and the Finding shape live beside the double-correction check
// so that check can be unit-tested without booting the whole function. See
// double-reallocation.test.ts -- the ±40-day pairing bug it guards against produced 33
// false 'corrected twice' findings in one run, and nothing here could have caught it.
import { INTEREST_CODE, money, checkDoubleReallocation, type Finding } from './double-reallocation.ts'
// The carrying-basis detector is a PURE module in _shared so that the same
// judgement runs here (on a schedule) and inside loan-bundle (when documents
// arrive). Session 242's lesson, learned twice in one day: a guard is only as
// good as the branch it sits on, so the two paths that need this answer must
// read it from one place rather than each growing their own copy.
import { detectCarryingBasisDrift } from '../_shared/carrying-basis-drift.ts'
import { explainBalanceGap, dailyWithholdingFromBalances } from '../_shared/settlement-lag.ts'

// ────────────────────────────────────────────────────────────────────────
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
// ────────────────────────────────────────────────────────────────────────

const STALE_ANCHOR_DAYS = 45
// How far either side of a lumped payment we'll look for its reallocation journal.
// Month-end corrections for an early-month payment can be ~30 days out.
const REALLOC_WINDOW_DAYS = 40
// Sources that represent a real document from the lender, as opposed to a balance
// we derived from Xero ourselves. Only these can anchor a reconciliation — comparing
// Xero against a number we computed from Xero proves nothing.
const REAL_ANCHOR_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']


// One monthly statement cycle plus slack. A lender document older than this
// against the newest row we hold has stopped being the better answer for
// "what is owed today", and the honest reading becomes "recent but
// unverified" -- which is exactly what the Variance column already says.
const ANCHOR_AUTHORITY_GRACE_DAYS = 45

function daysBetweenIso(aIso: string, bIso: string): number {
  return Math.round((Date.parse(aIso + 'T00:00:00Z') - Date.parse(bIso + 'T00:00:00Z')) / 86400000)
}

// Real lender evidence first (newest of it at the head) when it is current
// enough, then everything else newest-first. Never drops a row -- only the
// ORDER changes, so callers reading the whole list are unaffected.
// Input must already be sorted newest-first.
function rankAnchorsByAuthority<T extends { statement_date: string; source?: string | null }>(byDate: T[]): T[] {
  if (byDate.length < 2) return byDate
  const newestIso = byDate[0].statement_date
  const current = byDate.filter(r =>
    REAL_ANCHOR_SOURCES.includes(String(r.source ?? '')) &&
    daysBetweenIso(newestIso, r.statement_date) <= ANCHOR_AUTHORITY_GRACE_DAYS)
  if (!current.length) return byDate
  const currentSet = new Set(current)
  return [...current, ...byDate.filter(r => !currentSet.has(r))]
}
// A statement row is "derived" if it is NOT a lender document and NOT a schedule
// projection -- i.e. a balance we computed from Xero ourselves and stored. Deliberately
// defined as the complement of the known-good sources rather than as an allowlist:
// v11 filtered on source === 'xero_derived' alone, so the 46 rows written with
// source='xero_balance_snapshot' (Stripe Capital 304 and Pacific Community Ventures 254)
// were never once compared against Xero. That blind spot is exactly what let
// xero-payout-sync's sign inversion overstate Stripe Capital by $11,720.59 across ten
// days in Aug 2026 without the engine saying a word. A future writer inventing a new
// source string must not be able to escape this check the same way -- unknown sources
// now fail INTO the check, not out of it.
// 'amortization_schedule' is excluded because it is a projection of what the balance
// SHOULD be, not a record of what Xero says it is; drifting from it is expected.
const isDerivedSource = (src: string) =>
  !REAL_ANCHOR_SOURCES.includes(src) && src !== 'amortization_schedule'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
// Pacific business date. Never toISOString() — after 5pm PT that rolls to tomorrow.
const todayPacific = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
// The last day of the month before the one `iso` falls in. Used to derive the two
// month ends this run measures a books balance at, and derived FROM TODAY — never
// from effectiveCloseDate(). A measurement of what Xero said on 31 July must not
// move because the CPA has or has not finished closing July; if it did, the figure
// the rollforward opens on would change shape mid-close and `computed_at` would
// stop meaning anything.
const monthEndBefore = (iso: string) => addDays(iso.slice(0, 8) + '01', -1)

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

// ── Xero ─────────────────────────────────────────────────────────────────


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
  // Xero requires ISO 8601 here. toUTCString() emits RFC 1123 ("Mon, 18 Aug 2026 ...")
  // which Xero accepts with HTTP 200 and then SILENTLY IGNORES, returning the full
  // unfiltered set -- so this "incremental" pull was never incremental. Verified live
  // 2026-08-19: RFC 1123 returned 1183/1183 manual journals, ISO returned 1/1183.
  // See DESIGN-LOAN-POSTING-MODEL.md constraint C8.
  if (modifiedSince) headers['If-Modified-Since'] = new Date(modifiedSince).toISOString().slice(0, 19)
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

// ── v19 (session 226, 2026-08-21): CHECKPOINT FROM XERO'S OWN TRIAL BALANCE ──
// The rolling checkpoint had a poisoning hole, found live: David recoded two
// 4140 transactions in Xero (the $5,000 Aug-11 payment and the Aug-17 interest
// split), re-ran the check, and the finding stayed frozen at $6,070.29 across
// four runs — checkpoint['242'] was carried forward at 16,755.81 forever. The
// mechanism: cp lived at the window END (prev run's period_to) and the anchor
// balance walked BACKWARD from it, so an edit to any entry dated at-or-before
// the anchor changed the true balance but never entered the walk. Nothing ever
// invalidated the cache; re-running could not recover, and neither could deep
// mode. changedOld only caught edits dated before the WINDOW, and only added
// them to the ledger — it never repaired cp.
//
// The fix removes the fragile state instead of patching it: every run now asks
// Xero itself for each loan account's balance at the day before windowFrom
// (GET /Reports/TrialBalance?date=…, verified live in the capability matrix
// and already used in production by payroll-check-attention), then walks
// FORWARD through the freshly pulled window. Any edit, any date, any age is
// self-healing: in-window edits are re-read every run, and pre-window edits
// move the Trial Balance figure automatically. The stored rolling checkpoint
// remains ONLY as a fallback for a failed report fetch (marked untrusted in
// the run summary so the report says which basis was used).
//
// Sign convention: loan accounts are liabilities, so the report's YTD columns
// give balance = credit − debit (mirrors payroll-check-attention's cells[3]/
// cells[4] parse, sign flipped for the liability side).
async function fetchTrialBalances(date: string): Promise<Record<string, number> | null> {
  try {
    const { accessToken: token, tenantId } = await getXeroAuth()
    const r = await fetch(`https://api.xero.com/api.xro/2.0/Reports/TrialBalance?date=${date}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json' },
    })
    if (!r.ok) return null
    const j = await r.json().catch(() => null)
    if (!j?.Reports?.[0]) return null
    const out: Record<string, number> = {}
    for (const section of j.Reports[0].Rows || []) {
      for (const row of section.Rows || []) {
        const label = row.Cells?.[0]?.Value || ''
        const m = label.match(/\((\S+)\)\s*$/)
        if (!m) continue
        const d = parseFloat(row.Cells?.[3]?.Value || '0') || 0
        const c = parseFloat(row.Cells?.[4]?.Value || '0') || 0
        out[m[1]] = Math.round((c - d) * 100) / 100
      }
    }
    return out
  } catch { return null }
}

async function pullXero(fromDate: string, toDate: string, modifiedSince: string | null) {
  const { accessToken: token, tenantId } = await getXeroAuth()

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
  // catches an accountant deleting a March entry in August.
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

// ── Checks ──────────────────────────────────────────────────────────────
// Each returns findings. A finding is a plain object; the runner handles storage,
// fingerprint dedup and new/open/resolved bookkeeping.


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

/** How many ledger entries balanceAt() actually walked to reach D. Exists only so a
 *  stored books balance can say in `detail.entries_counted` how much evidence sits
 *  behind it — "0 entries" and "31 entries" are very different claims to have made
 *  about the same figure. The predicate is a line-for-line mirror of the walk above
 *  and the two are deliberately adjacent: if they ever disagree, this one is the one
 *  that is wrong, and a reader has to be able to see both at once to notice. */
function entriesWalked(code: string, D: string, ledger: Record<string, any[]>, checkpointDate: string): number {
  const rows = ledger[code] || []
  return D >= checkpointDate
    ? rows.filter((r: any) => r.date > checkpointDate && r.date <= D).length
    : rows.filter((r: any) => r.date > D && r.date <= checkpointDate).length
}

/** ── WHAT MOVED THE BALANCE THIS MONTH, MEASURED (session 246 follow-up) ──────
 *  The rollforward's formula is `opening - principal paid = closing`, which is only
 *  true if nothing was BORROWED during the month. Stripe Capital drew $125,000 in
 *  July: 6/30 books $20,875.00, 7/31 books $136,578.25, principal booked $9,296.75.
 *  20,875.00 - 9,296.75 = 11,578.25 against a real $136,578.25, short by exactly the
 *  drawdown. Three more loans move in ways the splits do not account for (PayPal 2
 *  -$3,142.26, BayFirst SBA 2 +$858.66, Funding Circle +$15.14).
 *
 *  THE DRAW IS MEASURED FROM THE ENTRIES, NEVER DERIVED FROM THE BALANCES.
 *  `drawn = closeBooks - openBooks + principal` would make the rollforward foot for
 *  ANY input -- it is the equation rearranged, so it can only ever print a tie. That
 *  is the same tautology as session 245's `gap / mean` and the same one this whole
 *  session was spent removing from Verdant. This sums `effect()` over the ledger rows
 *  that actually fall in the month, so a rollforward built on it can still fail, which
 *  is the only property that makes it worth having.
 *
 *  Window is (from, to] -- half-open at the start, because the opening balance is
 *  stated AS OF `from` and already contains everything dated on that day.
 *
 *  `effect()` is the signed movement of ONE entry on ONE account: positive grew the
 *  liability, negative paid it down. Classification is therefore per ENTRY, which is
 *  what `effect()` means and what Xero's balance sheet moves by. An entry whose lines
 *  on this code carry BOTH signs (a manual journal that debits and credits the same
 *  account) nets to one number and lands wholly in one bucket, so its gross halves are
 *  invisible here. That is a real limit, not a rounding one, so it is COUNTED
 *  (`mixed_sign_entries`) rather than left to be discovered later. */
function measureMovement(code: string, from: string, to: string, ledger: Record<string, any[]>) {
  let drawn = 0, reduced = 0, drawnEntries = 0, reducedEntries = 0, mixed = 0
  for (const r of ledger[code] || []) {
    if (!(r.date > from && r.date <= to)) continue
    const amounts = (r.lines || []).filter((l: any) => l.c === code).map((l: any) => Number(l.a || 0))
    if (amounts.some((a: number) => a > 0) && amounts.some((a: number) => a < 0)) mixed++
    const e = effect(r, code)
    if (e > 0) { drawn += e; drawnEntries++ }
    else if (e < 0) { reduced += -e; reducedEntries++ }
    // e === 0 is a real entry that moved nothing; it belongs in neither bucket, and
    // inflating either count with it would misdescribe the evidence behind a figure.
  }
  return {
    drawn: Math.round(drawn * 100) / 100,
    reduced: Math.round(reduced * 100) / 100,
    drawn_entries: drawnEntries,
    reduced_entries: reducedEntries,
    mixed_sign_entries: mixed,
  }
}

/** The Xero ledger date of a STAGED split's pre-created transaction, or null when
 *  the record does not state one. loan-xero-post writes the reference as
 *  `WR-STAGE <code> <rowDate>` and creates the BankTransaction with Date = that same
 *  rowDate, so the reference IS the date the entry sits on in Xero — which is the
 *  date balanceAt() counted it on, since a staged transaction is AUTHORISED and
 *  isLive() returns true for it. period_label is the fallback and ONLY when it is a
 *  full date: weekly cadences label 'YYYY-MM-DD', monthly ones label 'YYYY-MM', and
 *  a month names no day. Guessing one would be inventing the very thing this count
 *  exists to state honestly. */
function stagedLedgerDate(split: any): string | null {
  const m = String(split?.stage_reference ?? '').match(/(\d{4}-\d{2}-\d{2})\s*$/)
  if (m) return m[1]
  const label = String(split?.period_label ?? '')
  return /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : null
}

/** How much of a month's measured movement is money that has NOT moved.
 *
 *  loan-xero-post pre-creates staged SPEND transactions with Status 'AUTHORISED', so
 *  isLive() returns true and measureMovement() counts them in `reduced` exactly like a
 *  real payment -- while the rollforward deliberately excludes staged splits from the
 *  month's principal. Left unstated, the rollforward absorbs the difference as an
 *  unexplained variance the size of a payment. As with the balances, the answer is to
 *  SAY SO, not to net it out: Xero's own balance sheet includes these, and this row
 *  means "what Xero says".
 *
 *  MEASURED FROM THE LEDGER, GATED ON THE SPLIT RECORD. The amount is the entry's own
 *  effect(), not the split's stored principal_amount, so it is the same arithmetic as
 *  everything else on the row. But the SELECTION cannot be the `WR-STAGE` reference
 *  alone: a stage that the CPA has matched goes staged -> posted in loan_splits
 *  (loan-xero-post handleStageSweep) and BOTH the reference on the Xero transaction and
 *  loan_splits.stage_reference SURVIVE that transition -- verified in the source, not
 *  assumed. Matching on the prefix would therefore count real, settled payments as
 *  money that has not moved. Only a split whose status is CURRENTLY 'staged' says the
 *  payment has not happened, so that is the gate. */
function stagedMovementInWindow(code: string, from: string, to: string, ledger: Record<string, any[]>, mySplits: any[]) {
  const refs = new Set(mySplits
    .filter((s: any) => s.status === 'staged' && s.stage_reference)
    .map((s: any) => String(s.stage_reference)))
  if (!refs.size) return { staged_reduction_in_month: 0, staged_entries_in_month: 0, staged_refs_not_in_ledger: 0 }
  let amount = 0, count = 0
  const seen = new Set<string>()
  for (const r of ledger[code] || []) {
    if (!(r.date > from && r.date <= to)) continue
    const ref = String(r.ref ?? '')
    if (!refs.has(ref)) continue
    seen.add(ref)
    amount += -effect(r, code)   // a staged SPEND reduces the liability; report it positive
    count++
  }
  return {
    staged_reduction_in_month: Math.round(amount * 100) / 100,
    staged_entries_in_month: count,
    // A staged split whose transaction is NOT in the window's ledger rows. Usually it
    // is simply dated outside the month and means nothing; it is recorded so that
    // "0 staged in this month" can be told apart from "we looked in the wrong place".
    staged_refs_not_in_ledger: [...refs].filter(x => !seen.has(x)).length,
  }
}

// Rows on an amortization schedule that state a balance you may anchor to. A payment
// row states the balance AFTER that payment; `initial` states the day-one balance.
// Everything else — annual_total, grand_total, rate_change — carries a number whose
// meaning is not "what is owed on this date", and Dexter proves all three of those can
// carry a POPULATED one. Mirrors loan-cross-check's filter, which has carried a comment
// since session 221 saying this engine omitted it.
const SCHEDULE_ANCHOR_ROW_TYPES = ['payment', 'initial']

/** Which of a loan's schedules to read, when it has more than one. Newest
 *  schedule_generated_date, tie-broken by created_at, tie-broken by id — the same
 *  rule and the same reasoning as _shared/staging-next.ts. The last key is not
 *  decoration: two schedules generated on one day with the same stated generation
 *  date is a real shape (derive a projection at 10am, ingest a statement at 2pm,
 *  re-derive), and without a total order the choice falls back to whatever order
 *  PostgREST happened to return the rows in. A null date sorts lowest, so a schedule
 *  that states when it was generated always beats one that does not — matching
 *  staging-next's `nullsFirst: false` on a descending sort. */
function pickScheduleId(rows: any[]): string | null {
  const keyOf = (s: any, r: any) => [String(s?.schedule_generated_date ?? ''), String(s?.created_at ?? ''), String(s?.id ?? r?.schedule_id ?? '')]
  const cmp = (a: string[], b: string[]) => a[0] !== b[0] ? a[0].localeCompare(b[0]) : (a[1] !== b[1] ? a[1].localeCompare(b[1]) : a[2].localeCompare(b[2]))
  let bestKey: string[] | null = null
  let bestId: string | null = null
  for (const r of rows) {
    const s = r.loan_amortization_schedules
    if (!s) continue
    const k = keyOf(s, r)
    if (!bestKey || cmp(k, bestKey) > 0) { bestKey = k; bestId = s.id ?? r.schedule_id ?? null }
  }
  return bestId
}

// Tech Debt follow-up (shipped session 222, 2026-08-19, same day as v14): this check
// rebuilds Xero's ledger balance -- always principal-only, since it's summed straight
// from live BankTransaction/ManualJournal lines on the loan's own account -- and
// compared it against anchors[0], the single newest document of any kind, with no
// regard for what that document actually measures. PayPal 2's amortization schedule
// is typed 'total_payback' (principal + unamortized fee), confirmed exact-to-the-cent
// against a real statement in an earlier session (schedule $64,879.69 minus true
// principal $61,896.57 equals the $2,983.12 unamortized fee, verified precisely).
// Comparing that total-payback figure straight against Xero's principal-only rebuild
// produced a $144.39 "error" that was really just two incompatible numbers landing
// close together by coincidence -- not a real gap. The separate document-intake
// system already knows this (`basis_conflict`, source='intake') but this engine's own
// balance_vs_lender check didn't yet carry the same basis-awareness, so it kept
// reporting the false positive it lacked the information to recognize as false.
//
// Fix: only trust an anchor whose balance_basis is confirmed 'principal_only' -- the
// same "never compare two figures whose bases differ" rule the intake system already
// lives by. All 244 real lender-document anchors (lender_statement / portal_manual_pull
// / email_pdf_upload) are already typed principal_only, so this changes nothing for
// them. It only takes effect for schedule-sourced anchors, where 4 of 5 schedules
// (Dexter x2, PCV, Verdant) are principal_only and unaffected, and PayPal's
// total_payback schedule is now correctly skipped instead of misread. If the newest
// anchor fails the basis check, older anchors are tried in order rather than giving up
// outright -- a usable real statement further back should still be used. If NONE of a
// loan's anchors are confirmed principal_only, this check produces nothing rather than
// guessing; that loan's basis gap, if any, is the intake system's basis_conflict to
// report, not a second inconsistent message from here.
// v17 (session 222, 2026-08-19): split into computeTieOut() + a thin finding builder.
//
// WHY. This check returned [] in FIVE different situations that mean completely different
// things: the loan ties perfectly; there is no anchor at all; the only anchors predate the
// pulled window; no anchor is confirmed principal_only; there is no trustworthy checkpoint.
// From the outside all five are indistinguishable -- "no finding" reads as "fine". That is
// exactly the false pass a tie-out must not have, because a CPA signing off on a portfolio
// needs "we checked and it ties" to be a different statement from "we never checked".
//
// So the comparison now always produces an explicit verdict, and the finding is derived
// FROM that verdict rather than computed alongside it. One computation, two consumers --
// the finding text and the tie-out row can never disagree, which they would within a
// session or two if this logic were duplicated.
//
// Findings emitted are byte-for-byte what they were before: 'tied' and 'not_comparable'
// produce nothing, exactly as the old early returns did.
interface TieOut {
  loan_account_id: string
  status: 'tied' | 'explained' | 'exception' | 'not_comparable'
  reason_code: string | null
  as_of: string | null
  xero_balance: number | null
  lender_balance: number | null
  difference: number | null
  balance_basis: string | null
  anchor_source: string | null
  statement_id: string | null
  storage_path: string | null
  /**
   * `detail.material` / `detail.material_share` — is an 'exception' big enough to
   * be worth a person? Decided in computeTieOut and read everywhere else, so the
   * roster and the Needs Attention queue can never disagree about the same loan.
   *
   * Both bars must be cleared: $25 AND 0.25% of the lender's balance. The rule was
   * a flat $1, on a book running from a $10,685 van loan to a $960,005 SBA loan —
   * so EIDL's $5.00 gap wore the same red as Funding Circle's 4.6%.
   *
   * Deliberately inside `detail` and NOT two new columns. This row is written by
   * PostgREST upsert, so a column that does not exist yet fails the write for
   * EVERY loan — and adding one means a migration plus the session 176/177
   * ordering dance (add, prove the data API sees it, only then ship the code).
   * `detail` is already jsonb and already carries exactly this kind of derived
   * figure. A schema change you do not need is a deployment hazard you do not need.
   */
  detail: Record<string, unknown>
}

export const MATERIAL_FLOOR = 25
export const MATERIAL_SHARE = 0.0025
export function isMaterialGap(residual: number, lenderBalance: number | null): { material: boolean; share: number } {
  const lender = Math.abs(Number(lenderBalance ?? 0))
  const share = lender > 0 ? Math.abs(residual) / lender : 1
  return { material: Math.abs(residual) >= MATERIAL_FLOOR && share >= MATERIAL_SHARE, share }
}

function computeTieOut(loan: any, ledger: any, cp: number, cpDate: string, anchors: any[], windowFrom: string, haveCheckpoint: boolean, today: string): TieOut {
  const base: TieOut = {
    loan_account_id: loan.id,
    status: 'not_comparable',
    reason_code: null,
    as_of: null, xero_balance: null, lender_balance: null, difference: null,
    balance_basis: null, anchor_source: null, statement_id: null, storage_path: null,
    detail: {},
  }

  // Balance-dependent comparison needs a trustworthy starting point. Without a prior
  // run's checkpoint the rebuilt balance is only as old as the pulled window.
  if (!haveCheckpoint) return { ...base, reason_code: 'no_checkpoint' }
  if (!anchors.length) return { ...base, reason_code: 'no_anchor' }

  // Never compare two figures whose bases differ -- a total_payback schedule includes the
  // unamortized fee and will land near a principal-only rebuild by coincidence.
  const anchor = anchors.find((a: any) => a.balance_basis === 'principal_only')
  if (!anchor) {
    return { ...base, reason_code: 'no_principal_only_basis',
      detail: { available_bases: Array.from(new Set(anchors.map((a: any) => a.balance_basis ?? 'unknown'))) } }
  }

  // Comparing against an anchor older than the pulled window means walking the balance
  // back through transactions we never fetched -- a confident, wrong answer.
  if (anchor.statement_date < windowFrom) {
    return { ...base, reason_code: 'anchor_before_window',
      as_of: anchor.statement_date, anchor_source: anchor.source, balance_basis: anchor.balance_basis,
      lender_balance: Number(anchor.principal_balance),
      statement_id: anchor.statement_id ?? null, storage_path: anchor.storage_path ?? null,
      detail: { window_from: windowFrom } }
  }

  const code = loan.xero_account_code
  const xeroAtAnchor = balanceAt(code, anchor.statement_date, ledger, cp, cpDate)
  const diff = Math.round((xeroAtAnchor - Number(anchor.principal_balance)) * 100) / 100

  // Is there a POSTED entry dated after the anchor that would close the gap? A month-end
  // correction for an early-month payment looks like a mismatch on the anchor date but is
  // already handled.
  //
  // ── SESSION 231: THIS TEST WAS TOO NARROW, IN TWO WAYS ──────────────────────
  // It reported four false exceptions out of ten findings, and the balance sheet
  // disproved every one of them:
  //
  //   N202-8562      $8,588.48  paid off; later entries net EXACTLY -8,588.48
  //   Aquarecycle    $1,286.28  paid off; later entries net EXACTLY -1,286.28
  //   BayFirst SBA   $  971.56  Xero today 114,289.33 = lender 114,289.33
  //   BayFirst SBA 2 $  858.66  Xero today 135,901.60 = lender 135,901.60
  //
  // Two independent bugs, and a gap had to hit only one of them to be reported:
  //
  // 1. srcType === 'ManualJournal' ONLY. The two ways to book a split are a manual
  //    journal and splitting the bank transaction itself, and the second is the
  //    cleaner one -- it keeps the split attached to the payment instead of parked
  //    in a separate journal. David booked BayFirst that way, deliberately, after
  //    declining the suggested journal. A loan payoff is likewise usually a bank
  //    payment, not a journal. Insisting on the journal form marked correct books
  //    wrong and would have taught people to ignore this list.
  //
  // 2. .some() -- ONE entry had to match the whole gap alone. Two entries of
  //    -971.56 and -1,046.56 close a 971.56 gap and then some, but neither equals
  //    it, so .some() saw nothing. The gap is closed by the SUM.
  //
  // Both are replaced by the honest question: do the entries dated after the anchor
  // account for the difference? laterNet is already computed for the detail payload;
  // it was the answer all along and was being reported rather than used.
  //
  // Sign: diff is (xero - lender), so a POSITIVE diff (Xero reads high) needs
  // NEGATIVE later entries. They cancel when diff + laterNet is ~0.
  //
  // Tolerance is 2 cents matched exactly, as before. Deliberately not widened into
  // a band: this decides whether a real discrepancy is shown to a human at all, and
  // a loose threshold here hides money. Over-cancelling (the later entries move MORE
  // than the gap, because a following period also posted) is reported separately
  // rather than silently swallowed -- it is not evidence of a problem, but it is not
  // proof of tying either, and the balance sheet is the place to settle it.
  //
  // ── AND NOT FUTURE-DATED (the same session, caught before shipping) ─────────
  // A STAGED transaction is a real, dated entry sitting in Xero for a payment that
  // has not happened yet. Counting it here made the first version of this fix
  // overshoot in the opposite direction: BayFirst SBA Loan's later entries netted
  // -2,018.12 against a 971.56 gap, because -971.56 was August (real) and -1,046.56
  // was the September card staged an hour earlier. The gap would have flipped to
  // "$1,046.56 BELOW the lender" -- a brand-new false alarm, wearing the fix as a
  // disguise. Xero's own balance sheet excludes future-dated entries; so must this.
  const laterOnLoan = (ledger[code] || []).filter((r: any) =>
    r.date > anchor.statement_date && r.date <= today)
  const laterNet = laterOnLoan.reduce((sum: number, r: any) => sum + effect(r, code), 0)
  const residualAfterLater = Math.round((diff + laterNet) * 100) / 100
  const closesIt = laterOnLoan.length > 0 && Math.abs(residualAfterLater) < 0.02
  const ties = Math.abs(diff) < 0.02

  const gap = isMaterialGap(residualAfterLater, Number(anchor.principal_balance))

  return {
    ...base,
    status: ties ? 'tied' : (closesIt ? 'explained' : 'exception'),
    reason_code: ties ? null : (closesIt ? 'later_entries_close_gap' : null),
    as_of: anchor.statement_date,
    xero_balance: xeroAtAnchor,
    lender_balance: Number(anchor.principal_balance),
    difference: diff,
    balance_basis: anchor.balance_basis,
    anchor_source: anchor.source,
    statement_id: anchor.statement_id ?? null,
    storage_path: anchor.storage_path ?? null,
    detail: {
      code,
      entries_after_anchor: laterOnLoan.length,
      net_after_anchor: Math.round(laterNet * 100) / 100,
      // What is STILL unexplained once the later entries are counted. This is the
      // number a human should act on; `difference` is measured on the anchor date
      // and is a snapshot, not a verdict.
      residual_after_later: residualAfterLater,
      // Only meaningful on an exception; tied and explained are already agreement.
      material: ties || closesIt ? null : gap.material,
      material_share: ties || closesIt ? null : Math.round(gap.share * 1e6) / 1e6,
      later_entry_types: Array.from(new Set(laterOnLoan.map((r: any) => String(r.srcType)))),
    },
  }
}

// ── THE PREVIOUS CLOSE'S GAP, FOR THE SETTLEMENT-LAG GROWTH TEST (session 244) ──
// Two observations of the same loan's gap only mean something together if they are
// two CLOSES. They are not looked up by fingerprint: the fingerprint embeds
// tie.as_of, so consecutive months are different rows by construction and a
// fingerprint match would only ever find THIS close again. The key is
// (check_key, loan_account_id), newest earlier anchor_date wins.
//
// And not simply the newest earlier one. On this book the previous anchor is
// routinely days old, not a month: PCV holds balance_vs_lender findings dated
// 2026-08-01 and 2026-08-04, Rapid Credit Line 2026-08-16 and 2026-08-18, and
// E-Transit 4140 takes a portal pull most weekdays. A gap measured on Friday and
// again on Monday legitimately grows by three days of unsettled sales — Stripe
// Capital's $2,166.05 becomes about $3,000 — which is +38% and would raise a
// "growing" finding every Monday forever. That is the crying-wolf failure this
// module exists to stop, so the baseline has to be far enough back to be a
// different close. Twenty days keeps every real month-over-month pair on this book
// (E-Transit E5's 07-23 -> 08-12 is exactly 20) and rejects every same-week pair.
//
// Status is deliberately ignored: a resolved or suppressed finding still recorded
// what the gap MEASURED that month, and that measurement is what growth is against.
const PRIOR_GAP_MIN_SPACING_DAYS = 20
function priorBalanceGap(existing: any[], loanId: string, asOf: string | null): { gap: number; asOf: string } | null {
  if (!asOf) return null
  const earlier = (existing || []).filter((f: any) =>
    f.check_key === 'balance_vs_lender' &&
    f.loan_account_id === loanId &&
    typeof f.detail?.anchor_date === 'string' &&
    f.detail.anchor_date < asOf &&
    daysBetween(f.detail.anchor_date, asOf) >= PRIOR_GAP_MIN_SPACING_DAYS)
  if (!earlier.length) return null
  const newest = earlier.sort((a: any, b: any) => b.detail.anchor_date.localeCompare(a.detail.anchor_date))[0]
  // `still_unexplained` is the figure the finding is actually about; `difference` is
  // the anchor-date snapshot, and is all the rows written before session 231 carry.
  const gap = Number(newest.detail.still_unexplained ?? newest.detail.difference)
  if (!Number.isFinite(gap)) return null
  return { gap, asOf: newest.detail.anchor_date }
}

function checkBalanceVsLender(
  loan: any, tie: TieOut,
  // Added session 242 for the settlement-lag test below. Both were already in
  // scope at the call site; nothing new is read from the database.
  myStatements: any[] = [], contractTerms: any[] = [], today = '',
  // Session 244: the same loan's gap at the previous close, or null when there is
  // no earlier close to compare against — in which case explainBalanceGap behaves
  // exactly as it did before the growth test existed.
  prior: { gap: number; asOf: string } | null = null,
): Finding[] {
  // A tie and an un-checkable loan both produced no finding before this refactor; they
  // still do. The un-checkable case is now VISIBLE in the tie-out instead of silent.
  if (tie.status === 'tied' || tie.status === 'not_comparable') return []

  // ── 'EXPLAINED' IS NOT A FINDING (session 231) ──────────────────────────────
  // David, looking at four of these on his board: "we know (or should know) the
  // reason for the gaps. No need to display non issues."
  //
  // He is right, and the previous line proves it: 'tied' already returns nothing.
  // 'explained' means the entries dated after the anchor account for the gap to the
  // cent -- the books are correct and there is no action. Printing that is printing
  // "nothing is wrong" as an item in a list of things that are wrong, which is how a
  // list of five becomes a list nobody reads. The tie-out row still records it, so it
  // stays inspectable; it just does not take a human's attention.
  if (tie.status === 'explained') return []

  // ── AND NEITHER IS A DISAGREEMENT WITH OUR OWN PROJECTION ───────────────────
  // When no lender statement exists, the anchor is our own projected schedule row.
  // "Xero is $1,198.54 above its projected schedule" is Xero disagreeing with our
  // arithmetic, not with a fact, and the number moves every time the projection is
  // re-derived. The REAL problem there is that no lender document exists to check
  // against -- and checkStaleAnchor owns exactly that, says it in one actionable
  // sentence, and does not attach a spurious dollar figure to it.
  if (!REAL_ANCHOR_SOURCES.includes(String(tie.anchor_source ?? ''))) return []

  const code = loan.xero_account_code
  const diff = tie.difference as number
  const lender = tie.lender_balance as number
  const xeroAtAnchor = tie.xero_balance as number
  const d = tie.detail as any
  const laterCount = Number(d.entries_after_anchor ?? 0)
  const laterNet = Number(d.net_after_anchor ?? 0)

  // The HEADLINE number is what is STILL unexplained once the later entries are
  // counted, not the anchor-date difference (session 231). Reporting the anchor-date
  // figure overstated four of ten findings and, on the two paid-off loans, described
  // ~$9,900 of debt the balance sheet does not carry. `difference` stays in the detail
  // as the raw measurement; everything a human reads follows the residual.
  //
  // Anything reaching here is a genuine exception: a tie, a gap the later entries
  // close, and a comparison against our own projection have all already returned
  // above. Under a dollar is rounding and gets info rather than a red dot.
  const residual = Number(d.residual_after_later ?? diff)

  // ── SETTLEMENT LAG IS NOT A DISCREPANCY (session 242) ───────────────────────
  // David: "the lender calculates the payback at the time of a successful card
  // transaction, but Xero only sees the update 2-3 business days later when we
  // receive our daily deposit... this will be an issue with most, if not all,
  // payment provider loans like this one."
  //
  // On a loan repaid out of settled card receipts the lender is PERMANENTLY a few
  // business days ahead, so this check fires every month forever and can never be
  // cleared. That is how a queue becomes something people scroll past — and this
  // module's whole history is the cost of that (see the close-date section).
  //
  // The claim is tested, not assumed: the gap either is a few business days of
  // this loan's own withholding or it is not. Only a contract that states a
  // repayment RATE counts as continuous repayment — the lender's own words, not
  // an inference from the shape of the data.
  //
  // Deliberately DOWNGRADED and never suppressed. `tie.status === 'explained'`
  // above returns nothing because the later entries account for the gap to the
  // cent; settlement lag explains it only approximately, and the module's standing
  // rule is that the BALANCE is always checked. It stays on the board, in black
  // rather than red, carrying the arithmetic.
  const repaysContinuously = (contractTerms || []).some((t: any) =>
    t.loan_account_id === loan.id && t.term_key === 'repayment_rate_percent' && !t.superseded_at)

  // The rows handed to the estimator are filtered HERE as well as inside it
  // (session 244). Not belt-and-braces for its own sake: `myStatements` is every
  // statement row on the loan, and on Stripe Capital that is 35 rows of
  // source='xero_balance_snapshot' — the BOOKS balance, which sits above the
  // lender's by exactly the lag being measured. Interleaved with lender rows it
  // read $863.68/day against a true $430.47/day, 2.01x, and 2.01x of rate is a real
  // $6,000 shortfall coming back 'explained'. The module refuses those rows itself;
  // this call site should never have been the thing offering them.
  const rateRows = (myStatements || []).filter((s: any) =>
    REAL_ANCHOR_SOURCES.includes(String(s.source ?? '')) && s.balance_basis === 'principal_only')
  const rate = repaysContinuously && today
    ? dailyWithholdingFromBalances(rateRows, today)
    : { rate: null, basis: '' }
  // ── NO lenderExport IS PASSED HERE, AND THAT IS THE POINT (session 245) ──────
  // The scheduled run has no transaction export to offer: nothing stores a parsed
  // one (loan_documents keeps a storage path and no parse), and re-reading a CSV
  // out of storage on every loan of every run is not what this function is for. So
  // this call site can now only ever reach a NON-benign verdict, and the one it
  // reaches on a gap the size of settlement timing is 'unconfirmed_no_export' —
  // which is what the previous three sessions were calling 'explained' on the
  // strength of a rate this call site inferred from its own balance history.
  //
  // That is a deliberate loss of a reassurance the module was not entitled to
  // give. What it costs on this book, measured against the 2026-08-26 snapshot:
  // nothing. No loan reaches 'explained' here today — Stripe Capital, the only
  // loan with a repayment_rate_percent term, holds 35 statement rows and every one
  // of them is a xero_balance_snapshot, so it has no lender anchor, its tie-out is
  // 'not_comparable' and this function returns before the lag test. The six loans
  // that do reach the test are term loans with no such term and come back
  // 'not_continuous' exactly as before.
  const lag = explainBalanceGap({
    gap: residual, lenderAsOf: tie.as_of as string,
    dailyWithholding: rate.rate, rateBasis: rate.basis,
    repaysContinuously,
    priorGap: prior?.gap ?? null, priorGapAsOf: prior?.asOf ?? null,
  })

  // Materiality is decided ONCE, in computeTieOut, and read here. It used to be
  // computed in this function alone — which meant the roster (driven by tie-out
  // status) and this queue could disagree about the same loan, and "two numbers on
  // one page with no way to tell which is real" is the oldest bug in this module.
  const material = (tie.detail as any)?.material !== false
  const share = Number((tie.detail as any)?.material_share ?? 1)
  // 'Unconfirmed' is not 'wrong', and the severity has to say which one this is
  // (session 245). The gap is the size of a few days of this loan's own
  // withholding and nothing has checked it against what the lender actually took:
  // that is a missing document, not an established error. 'warn' is what
  // checkStaleAnchor already gives a missing document, and the dashboard counts
  // warn in Needs Attention exactly as it counts error — so it stays in front of a
  // person without claiming money has gone astray.
  const sev: Finding['severity'] =
    !material || lag.benign ? 'info'
      : lag.verdict === 'unconfirmed_no_export' ? 'warn'
        : 'error'

  // Name HOW the later entries were booked. Splitting the bank transaction is the
  // cleaner of the two ways to record a payment split, and this check used to refuse
  // to recognise it, so it is worth showing rather than hiding.
  const howBooked = laterCount && Array.isArray(d.later_entry_types) && d.later_entry_types.length
    ? ` (${d.later_entry_types.join(', ')})` : ''

  return [{
    fingerprint: `balance_vs_lender:${code}:${tie.as_of}`,
    check_key: 'balance_vs_lender',
    severity: sev,
    loan_account_id: loan.id,
    // The suffix names the verdict, and 'unconfirmed_no_export' gets one of its own
    // rather than falling through to the bare title: a gap that is the SIZE of
    // settlement timing and has not been confirmed is a different thing from a gap
    // nobody has an account of, and the title is where a person decides which of
    // the two they are looking at.
    title: `${loan.xero_account_name} — Xero is ${money(Math.abs(residual))} ${residual < 0 ? 'below' : 'above'} the lender${lag.benign ? ' (settlement timing)' : lag.verdict === 'growing' ? ' (gap growing)' : lag.verdict === 'unconfirmed_no_export' ? ' (needs a current lender export)' : ''}`,
    plain_english:
      `Rebuilt from every live entry in Xero, this loan comes to ${money(xeroAtAnchor)} on ${tie.as_of}, `
      + `against ${money(lender)} on the lender's own statement for that date. `
      + (laterCount
          ? `${laterCount} entr${laterCount === 1 ? 'y' : 'ies'} dated after that statement${howBooked} move it by ${money(Math.abs(laterNet))}, leaving ${money(Math.abs(residual))} unexplained. `
          : `Nothing is dated after that statement, so the whole ${money(Math.abs(diff))} is unexplained. `)
      + (lag.benign
          ? `That remainder is settlement timing, not money: ${lag.statement}`
          : lag.verdict === 'unconfirmed_no_export'
            // Without this branch an unconfirmed gap would print the generic
            // "missing from Xero or recorded twice" line, which is a claim this
            // check has NOT made and cannot make: the gap is the size of a few
            // days of withholding, and what is missing is the evidence, not
            // necessarily the money.
            ? `That remainder is the size of settlement timing, but nothing has confirmed it: ${lag.statement}`
            : lag.verdict === 'growing'
            // Without this branch the growth finding would print the generic
            // "missing from Xero or recorded twice" line and never say that what
            // raised it was the gap growing since the last close.
            ? `That remainder is the size of settlement timing, but it is growing: ${lag.statement}`
            : !material
            ? `At ${(share * 100).toFixed(4)}% of the lender's balance that is below the level worth chasing on its own, so it is noted rather than raised — but it is still counted, and it will go red the moment it grows.`
            : `That remainder is either missing from Xero or recorded twice.`),
    detail: {
      code, anchor_date: tie.as_of, anchor_source: tie.anchor_source,
      lender_balance: lender, xero_balance: xeroAtAnchor,
      difference: diff,
      entries_after_anchor: laterCount,
      net_after_anchor: laterNet,
      still_unexplained: residual,
      later_entry_types: d.later_entry_types ?? [],
      material, material_share: Math.round(share * 1e6) / 1e6,
      settlement_lag: { verdict: lag.verdict, implied_calendar_days: lag.impliedCalendarDays,
                        implied_business_days: lag.impliedBusinessDays,
                        implied_books_through: lag.impliedBooksThrough, rate_basis: rate.basis,
                        prior_gap: prior?.gap ?? null, prior_gap_as_of: prior?.asOf ?? null,
                        // What evidence actually settled this, so a reader of the
                        // stored row can tell a measurement from an assumption
                        // without re-deriving it (session 245).
                        export_evidence: lag.exportEvidence, export_through: lag.exportThrough,
                        window_from: lag.windowFrom, window_withholding: lag.windowWithholding },
    },
  }]
}

// v8 (session 218 cont.): `statements` is now passed in so this check can tell WHY a
// payment hasn't been split, not just THAT it hasn't. Before this, every unsplit
// payment got the same generic "split once the lender statement or schedule gives the
// exact figures" note — even when the real reason was a specific, fixable gap: no
// lender statement on file predates the payment, so loan-ingest-statement's diff logic
// (which needs a PRIOR statement to compute principal vs. interest) has nothing to work
// from. That was exactly David's E-Transit Loan 4140 case (statements 04-27, 06-27,
// 07-28 on file; nothing before the 04-17 payment). The fix: distinguish that specific,
// actionable case from the general "we just haven't gotten to it yet" case, and name
// what's missing and what to do about it.
function checkLumpedPayments(loan: any, ledger: any, today: string, statements: any[]): Finding[] {
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

  // Real lender documents on file for this loan, oldest first. Only these can ever
  // serve as the "prior statement" loan-ingest-statement diffs against — an
  // amortization-schedule row or a derived balance doesn't count, same rule as anchors.
  const realStatementDates = (statements || [])
    .filter((s: any) => REAL_ANCHOR_SOURCES.includes(s.source))
    .map((s: any) => s.statement_date)
    .sort()
  const oldestStatementDate = realStatementDates[0] ?? null

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

    // Does at least one real statement predate this payment? If not, but the loan DOES
    // have real statements on file (just none early enough), that's the specific,
    // nameable, fixable gap — as opposed to "no statements at all" (a different,
    // pre-existing problem the stale_anchor check already covers) or "a prior statement
    // exists but ingestion just hasn't produced a split yet" (the generic case below).
    out.push(lumpedFinding(loan, {
      date: r.date, amount: Math.abs(Number(r.total || 0)), srcId: r.srcId, contact: r.contact,
    }, today, realStatementDates))
  }
  return out
}

// The finding itself, built in ONE place. The out-of-window refresh below needs
// to produce a byte-identical shape, and two copies of this would drift the way
// the client's copies of the math did before session 231 folded them together.
function lumpedFinding(loan: any, p: { date: string, amount: number, srcId: string, contact?: any },
                       today: string, realStatementDates: string[]): Finding {
    const code = loan.xero_account_code
    const r = { date: p.date, srcId: p.srcId, contact: p.contact }
    const amt = p.amount
    const oldestStatementDate = realStatementDates[0] ?? null
    const hasPriorStatement = realStatementDates.some((d: string) => d < r.date)
    const missingPrior = !hasPriorStatement && oldestStatementDate != null
    const ageDays = daysBetween(r.date, today)

    return ({
      fingerprint: `lumped_payment:${code}:${r.srcId}`,
      check_key: missingPrior ? 'lumped_payment_missing_prior_statement' : 'lumped_payment',
      // SEVERITY CEILING, removed session 241 (David: "surface this issue to the
      // accountant through the ISSUE list. In fact, why isn't it here yet?").
      //
      // It WAS in the list. This line is why nobody saw it: capped at 'warn', a
      // lumped payment could never reach 'error', and the Issues pane's "Fix
      // first" band renders errors only. Funding Circle's 2026-04-20 payment --
      // $2,033.77 booked entirely to the loan with no interest line, verified
      // against Xero as still uncorrected four months later, roughly $1,038 of
      // interest expense that never reached the P&L -- sat under "worth a look"
      // the whole time.
      //
      // Money in the wrong account for six weeks is not a note to read later. An
      // unsplit payment that is still unsplit after 45 days is an error, and it
      // says so now.
      //
      // The one case that stays 'warn' is missingPrior: it cannot be split until
      // a document arrives, so it is genuinely blocked rather than neglected, and
      // ranking a blocked item above things the accountant can actually act on
      // just teaches them to ignore the top of the list.
      severity: missingPrior ? 'warn' : (ageDays > 45 ? 'error' : 'info'),
      loan_account_id: loan.id,
      title: missingPrior
        ? `${loan.xero_account_name} — ${r.date} payment of ${money(amt)} needs a statement from before ${oldestStatementDate}`
        : `${loan.xero_account_name} — ${r.date} payment of ${money(amt)} has no interest split`,
      plain_english: missingPrior
        ? `The whole ${money(amt)} was recorded as paying down the loan, with nothing booked as interest. This can't be split yet because it needs to be compared against the statement from just before it, and the oldest lender statement on file for this loan is ${oldestStatementDate} — after this payment, not before it. Upload a statement dated before ${r.date} for this loan and the split will be computed and posted for review automatically.`
        : `The whole ${money(amt)} was recorded as paying down the loan, with nothing booked as interest. Until it's split, this loan looks smaller than it is and the month's interest expense is understated. ${ageDays > 45 ? `This one is ${ageDays} days old, so it is genuinely missed rather than pending month-end — the interest belongs in that month's expense and is not there.` : 'Recent — most likely just waiting for month-end or the lender statement.'}`,
      detail: { code, date: r.date, amount: amt, bank_transaction_id: r.srcId, contact: r.contact, age_days: ageDays, oldest_statement_on_file: oldestStatementDate },
      proposed_action: missingPrior
        ? { kind: 'upload_earlier_statement', note: `Upload the lender statement covering the period just before ${r.date} for this loan (the oldest one on file is dated ${oldestStatementDate}). Once it's on file, this split will be computed and posted for review automatically — no other action needed.` }
        : { kind: 'reallocation_journal', note: 'Split principal/interest once the lender statement or schedule gives the exact figures, then post via loan-xero-post.' },
    })
}

// ── OUT-OF-WINDOW LUMPED PAYMENTS ────────────────────────────────────────────
//
// A finding whose date falls before this run's pulled window is deliberately NOT
// resolved (see the resolve block below -- "not re-found" means "out of range",
// not "fixed"). But it is also never re-examined, so its text freezes on the day
// it last ran and then quietly rots.
//
// Funding Circle's 2026-04-20 payment froze on 19 August still saying "needs a
// statement from before 2026-08-03". Nine such statements were uploaded on
// 22 August. The sentence became false three days later and nothing could
// correct it, because the only code that writes that sentence needs ledger rows
// the pull no longer fetches.
//
// It does not need them. Everything in that sentence -- whether a prior
// statement exists, how old the payment is, what it should now say -- comes from
// the statements and the finding's own stored detail. So rebuild those from what
// we already have, using the same builder, and leave the ledger out of it.
function refreshOutOfWindowLumped(existing: any[], loans: any[], statements: any[],
                                  today: string, windowFrom: string, seenFps: Set<string>): Finding[] {
  const out: Finding[] = []
  for (const f of existing || []) {
    if (f.status !== 'open') continue
    if (!String(f.check_key || '').startsWith('lumped_payment')) continue
    if (seenFps.has(f.fingerprint)) continue          // the live check already handled it
    const d = f.detail?.date
    if (!d || d >= windowFrom) continue               // in window: absence means fixed, not stale
    const loan = loans.find((l: any) => l.id === f.loan_account_id)
    if (!loan) continue
    const realStatementDates = (statements || [])
      .filter((s: any) => s.loan_account_id === loan.id && REAL_ANCHOR_SOURCES.includes(s.source))
      .map((s: any) => s.statement_date)
      .sort()
    out.push(lumpedFinding(loan, {
      date: d, amount: Number(f.detail?.amount || 0),
      srcId: String(f.detail?.bank_transaction_id || ''), contact: f.detail?.contact,
    }, today, realStatementDates))
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

function checkStaleAnchor(loan: any, anchors: any[], today: string, futureOnlyAnchor: boolean, scheduleOnFile = false): Finding[] {
  if (loan.status !== 'active') return []
  // Stripe Capital repays automatically out of each payout and has no statement to
  // chase — its balance is a live Xero snapshot by design. Asking for a document
  // that will never exist is not a finding.
  if (loan.ingestion_method === 'automatic') return []

  // ── THE RECORDED CLOSING POLICY (session 246, DESIGN-CLOSING-EVIDENCE A8) ────
  // `close_basis = 'amortization_schedule'` is a named, dated, human decision that
  // this lender issues no usable statement: Dexter Financial issues none at all, and
  // Verdant's monthly notice carries a payment amount with no balance and no
  // principal/interest split. Chasing a document that is never coming is not a gate,
  // it is a queue people learn to ignore — the same failure the close date fixed in
  // session 230, in a third costume. Without this gate the close band would read
  // "Verdant: per schedule, accepted" two clicks from this queue saying "no lender
  // document on file", which is the two-numbers-on-one-page failure this module's
  // whole history is made of.
  //
  // BUT ONLY WHEN A SCHEDULE ACTUALLY EXISTS. A stated policy does not conjure a
  // document (draft §"Three rules the policy must obey", rule 3). A loan carrying
  // this policy with no usable schedule behind it is grade C, and going quiet about
  // it would hide the one loan the policy failed to cover — so it still reports, it
  // just reports the truth, which is that the policy has nothing to stand on.
  //
  // Nothing here suppresses a real lender document: rule 1 is that a document always
  // wins, and the exemption is a decision not to ASK for one, not a decision to
  // ignore one that arrives. A Dexter statement landing tomorrow closes Dexter at
  // grade A and is compared exactly as it is today.
  //
  // `loan_accounts` is read with select('*') at the call site, so close_basis arrives
  // here for free; a row written before the column existed, or a harness fixture
  // pulled before it, reads as the 'lender_statement' default and behaves as today.
  const closeBasis = String(loan.close_basis || 'lender_statement')
  const perSchedule = closeBasis === 'amortization_schedule'
  if (perSchedule && scheduleOnFile) return []
  // 'none' is deliberately NOT given a branch. It says no month-end balance is
  // expected at all, which is a different question from whether a lender document is
  // on file; no loan in production carries it; and inventing behaviour for an unused
  // value is untested surface on a check that decides what a CPA is asked to chase.
  // Raise it with David rather than guess.
  // Age is measured from the newest LENDER document, never from a projected schedule
  // row (session 231). A derived schedule regenerates a row dated today every time it
  // is re-derived, so counting one as an anchor would keep all eleven pre-staging
  // loans permanently "fresh" and this check could never fire for any of them --
  // precisely when it matters most, since a projection with no recent statement behind
  // it is the thing most in need of an independent figure. This check now carries the
  // whole job of saying "nothing has confirmed this loan lately", because
  // checkBalanceVsLender no longer reports gaps against a projection.
  const anchor = anchors.find((a: any) => REAL_ANCHOR_SOURCES.includes(String(a.source ?? '')))
  const age = anchor ? daysBetween(anchor.statement_date, today) : null
  if (anchor && age !== null && age <= STALE_ANCHOR_DAYS) return []
  return [{
    fingerprint: `stale_anchor:${loan.xero_account_code}`,
    check_key: 'stale_anchor',
    severity: age === null || age > 365 ? 'warn' : 'info',
    loan_account_id: loan.id,
    // Reaching here WITH the policy means the schedule it names is not on file — the
    // exemption above already returned for every loan whose policy is backed. So the
    // headline is the missing schedule, not the missing statement: asking for a
    // statement is asking for the wrong thing on a loan whose recorded answer is that
    // no statement is coming.
    title: perSchedule
      ? `${loan.xero_account_name} — set to close on its amortization schedule, and no schedule is on file`
      : anchor
      ? `${loan.xero_account_name} — newest lender document is ${age} days old`
      : futureOnlyAnchor
        ? `${loan.xero_account_name} — the only lender document on file is dated in the future`
        : `${loan.xero_account_name} — no lender document on file`,
    plain_english: perSchedule
      ? `This loan's recorded closing policy is "per amortization schedule", so a lender statement is not what it is waiting for.${loan.close_basis_reason ? ` The recorded reason: ${loan.close_basis_reason}` : ''} But there is no usable amortization schedule on file for it either${anchor ? `, and the newest lender document is dated ${anchor.statement_date}, ${age} days ago` : ''} — which leaves nothing at all to establish a month-end balance against. Upload the contractual amortization schedule, or change the closing policy to say what should establish this loan's balance instead.`
      : anchor
      ? `The most recent statement from this lender is dated ${anchor.statement_date}, ${age} days ago. Everything since is our own arithmetic with nothing independent to check it against. A current document is what turns this loan from "probably right" into "verified".`
      : futureOnlyAnchor
        ? `Every lender document on file for this loan is dated ahead of today, so none of them can confirm what the balance is now. A current statement would fix that.`
        : `No statement or portal pull from this lender is on file, so this loan's balance has never been checked against anything outside Xero. A projected schedule is not a substitute — it is our own arithmetic, so comparing the books to it cannot catch an error in the books.`,
    detail: { code: loan.xero_account_code, latest_anchor: anchor?.statement_date ?? null, anchor_source: anchor?.source ?? null, age_days: age, future_only: futureOnlyAnchor, close_basis: closeBasis, schedule_on_file: scheduleOnFile },
  }]
}

// Tech Debt #4 (opened + shipped session 222, 2026-08-19): comparing against a
// "derived" statement row is only meaningful if something is actually keeping that
// row current. Audited every loan_statements row with source in ('xero_derived',
// 'xero_balance_snapshot') against the codebase: NOTHING writes 'xero_derived' —
// grepping the whole repo turns up zero INSERT/UPSERT sites, so every one of the
// 341 existing rows is a permanently frozen one-time historical backfill from
// Aug 5-15, 2026 (11 of 12 affected loans show exactly ONE distinct created_at
// batch for their entire history — confirmed via SQL, not assumed). 'xero_balance_snapshot'
// has exactly one live writer, xero-payout-sync, and it is hardcoded to Stripe
// Capital (xero_account_code '304', loan_accounts.ingestion_method='automatic') --
// PCV Good and Green's 16 xero_balance_snapshot rows are the same kind of one-shot
// backfill (1 batch, 2026-08-05), not a second live source.
//
// Before this fix, checkDerivedDrift compared ALL of it, so a loan whose only
// "derived" data was a dead 2021-era backfill (Rapid Credit Line: 10+ weekly
// findings, all the identical $1,056.19 -- a frozen historical gap, not a new one
// each week) generated the exact same unfixable warning on every single run,
// forever, since nothing will ever update that row to make the gap close.
// Permanent, unfixable noise defeats the entire point of this engine -- a report
// worth reading leads with what's actionable, and a finding nobody can ever
// resolve by definition isn't. THIS IS THE ROOT-CAUSE FIX, not a one-time
// cleanup: it holds for any future backfill too, without needing another patch,
// because the gate is "is this loan's derived source actually live-maintained"
// (verifiable from loan_accounts.ingestion_method), not "is this specific row
// old" -- a fresh one-shot backfill written tomorrow would be excluded on day
// one, not just after it goes stale.
//
// Nothing in loan_statements is touched by this change -- the Debt Schedule's
// displayed balance (_loanOutstandingBalance() in admin-dashboard) reads
// loan_statements directly and is completely unaffected either way. This is
// purely about what reconciliation-run is willing to treat as a live signal
// worth re-checking every run.
const isLiveDerivedSource = (loan: any, source: string) =>
  source === 'xero_balance_snapshot' && loan.ingestion_method === 'automatic'

function checkDerivedDrift(loan: any, ledger: any, cp: number, cpDate: string, derived: any[], windowFrom: string): Finding[] {
  const code = loan.xero_account_code
  const out: Finding[] = []
  for (const d of derived) {
    if (!isLiveDerivedSource(loan, d.source)) continue  // frozen historical backfill -- see Tech Debt #4 above
    if (d.statement_date < windowFrom) continue      // outside what we pulled — can't judge
    if (d.principal_balance == null) continue
    const computed = balanceAt(code, d.statement_date, ledger, cp, cpDate)
    const diff = Math.round((Number(d.principal_balance) - computed) * 100) / 100
    if (Math.abs(diff) < 0.02) continue

    // Tech Debt #1 (opened session 221): checkLumpedPayments already knows that a
    // month-end correcting entry for an early-month posting can land up to
    // REALLOC_WINDOW_DAYS later. balanceAt() rebuilds strictly as-of d.statement_date,
    // so a correction dated after that cutoff is invisible to `computed` even though
    // it's exactly what accounts for the gap (PCV Good and Green, 254: an April/May
    // and an August pair each netted to the stored figure once the forward-dated leg
    // was included). Sum every live entry on this code posted in that forward window
    // — only when their combined effect closes the gap to the cent do we call this a
    // dating difference instead of real drift. Recency or tolerance alone never
    // qualifies: the Stripe Capital sign inversion this check exists to catch
    // ($11,720.59, session 221) had no correcting entry anywhere in any window and
    // must still fire. Reuses the same constant checkLumpedPayments uses — do not
    // introduce a second, slightly-different window.
    const laterInWindow = (ledger[code] || []).filter((r: any) =>
      r.date > d.statement_date && daysBetween(d.statement_date, r.date) <= REALLOC_WINDOW_DAYS)
    const laterNet = Math.round(laterInWindow.reduce((s: number, r: any) => s + effect(r, code), 0) * 100) / 100
    const closesIt = laterInWindow.length > 0 && Math.abs(laterNet - diff) < 0.02

    out.push({
      fingerprint: `derived_drift:${code}:${d.statement_date}`,
      check_key: 'derived_drift',
      severity: closesIt ? 'info' : 'warn',
      loan_account_id: loan.id,
      title: closesIt
        ? `${loan.xero_account_name} — our stored balance for ${d.statement_date} ties once later-dated entries take effect`
        : `${loan.xero_account_name} — our stored balance for ${d.statement_date} disagrees with Xero by ${money(Math.abs(diff))}`,
      plain_english: closesIt
        ? `WashRoute has ${money(Number(d.principal_balance))} recorded for ${d.statement_date}, and rebuilding that date from Xero's live entries alone gives ${money(computed)}. But ${laterInWindow.length === 1 ? 'an entry' : `${laterInWindow.length} entries`} posted within ${REALLOC_WINDOW_DAYS} days after ${d.statement_date} account for exactly the ${money(Math.abs(diff))} difference, so nothing is wrong — the two only line up from those entries' dates onward. Dating the correction at the original transaction instead would make them agree continuously.`
        : `WashRoute has ${money(Number(d.principal_balance))} recorded for ${d.statement_date}, but rebuilding that date from Xero's live entries gives ${money(computed)}. Xero is the source of truth here, so our stored copy is the one that's wrong. The usual causes are a deleted Xero entry our records still count, or a sync that wrote the balance with the wrong sign.`,
      detail: {
        code, date: d.statement_date, stored: Number(d.principal_balance), computed, difference: diff,
        closed_by_later_entries: closesIt, later_entries_in_window: laterInWindow.length,
        later_entries_net: laterInWindow.length ? laterNet : null, window_days: REALLOC_WINDOW_DAYS,
      },
    })
  }
  return out
}

function checkNonLiveCounted(loan: any, allEntries: any[], splits: any[]): Finding[] {
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

// v11 (session 219): PayPal A00845102 carries ~20 hand-posted adjustment journals over
// nine months, because the bank feed books each weekly payment entirely to the loan
// liability with $0 interest and a person posts a correction every week. One of those
// corrections (2026-07-31, "To reclass the payment made for paypal", −$3,142.26) books
// a payment that had not happened yet; the real bank entry then books it again days
// later — a double-count. Matching on amount would never have caught it: the journal is
// $3,142.26 and the payment is $3,414.71. The detectable, generalisable signal is the
// correction trail itself. A loan whose ledger needs repeated manual adjustment is a
// loan whose automated posting is wrong, and every hand-correction is an opportunity to
// count a payment twice.
//
// Journals THIS system posted are expected, not corrections, so they are excluded via
// loan_splits.xero_manual_journal_id. Postgres returns uuids lowercased and Xero returns
// GUIDs in mixed case, so both sides are lowercased before comparing. `splits` is the
// per-loan slice the runner already computed — no extra query, no extra Xero fetch.
function checkUnexplainedLedgerAdjustment(loan: any, ledger: any, splits: any[], windowFrom: string): Finding[] {
  const code = loan.xero_account_code
  // Same skips as checkLumpedPayments / checkStaleAnchor. Stripe Capital (automatic)
  // repays by straight principal deduction with no interest to reallocate, so it has
  // nothing to correct; a paid-off loan's correction trail is history, not an open risk.
  if (loan.ingestion_method === 'automatic') return []
  if (loan.status === 'paid_off') return []

  const ours = new Set((splits || [])
    .map((sp: any) => sp.xero_manual_journal_id)
    .filter(Boolean)
    .map((id: any) => String(id).toLowerCase()))

  // ledger[code] is already live-only (POSTED) and already narrowed to entries that
  // touch this loan's account — reuse it rather than re-scanning allEntries.
  const handPosted = (ledger[code] || []).filter((r: any) =>
    r.srcType === 'ManualJournal'
    && r.date >= windowFrom
    && !ours.has(String(r.srcId || '').toLowerCase()))
  if (!handPosted.length) return []

  const count = handPosted.length
  const totalAbs = Math.round(handPosted.reduce((s: number, r: any) => s + Math.abs(effect(r, code)), 0) * 100) / 100
  // Either a repeated trail, or a small number of large ones. Both mean the automated
  // posting is not landing where it should.
  if (count < 3 && totalAbs <= 1000) return []

  const newestFirst = handPosted.slice().sort((a: any, b: any) => b.date.localeCompare(a.date))
  const latest = newestFirst[0]
  const largest = handPosted.slice().sort((a: any, b: any) => Math.abs(effect(b, code)) - Math.abs(effect(a, code)))[0]
  const largestAbs = Math.round(Math.abs(effect(largest, code)) * 100) / 100
  const narr = (s: any) => String(s ?? '').trim().slice(0, 80)
  const examples = newestFirst.slice(0, 4).map((r: any) => ({
    date: r.date, amount: Math.round(effect(r, code) * 100) / 100, narration: narr(r.narration),
  }))

  return [{
    fingerprint: `unexplained_ledger_adjustment:${code}`,
    check_key: 'unexplained_ledger_adjustment',
    severity: count >= 3 ? 'warn' : 'info',
    loan_account_id: loan.id,
    title: `${loan.xero_account_name} — ${count} hand-posted correction${count === 1 ? '' : 's'} totalling ${money(totalAbs)} since ${windowFrom}`,
    plain_english: `This loan's ledger has needed ${count} manual correction${count === 1 ? '' : 's'} in this period, moving ${money(totalAbs)} in total. The largest was ${money(largestAbs)} on ${largest.date}${narr(largest.narration) ? ` ("${narr(largest.narration)}")` : ''}. When a loan needs hand-fixing this often it usually means the payment is being recorded wrong in the first place — typically the bank feed puts the whole payment against the loan and someone has to move the interest back by hand afterwards. That matters beyond the tidying: each correction is a chance for the same payment to end up on the books twice, once when the correction is posted and again when the real payment comes through the bank. Worth fixing where the payment is first recorded, so no correction is needed next time.`,
    detail: {
      code,
      // `date` is load-bearing, not decoration: the resolve sweep only protects a
      // finding from being auto-resolved when it can read a date off it, and both
      // stale_anchor and future_dated_rows carry none. Newest adjustment date keeps
      // this finding inside that guard.
      date: latest.date,
      adjustment_count: count,
      total_abs_effect: totalAbs,
      examples,
    },
    proposed_action: {
      kind: 'review_manual_adjustments',
      note: `Review the ${count} manual journal${count === 1 ? '' : 's'} posted against ${loan.xero_account_name} since ${windowFrom}, starting with the ${money(largestAbs)} one dated ${largest.date}, and confirm none of them books a payment that the bank feed also recorded. Then fix the posting at source — split principal and interest on the payment itself — so the weekly hand-correction is no longer needed.`,
    },
  }]
}

// ── Report ──────────────────────────────────────────────────────────────

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

/**
 * Does this loan still behave like the kind of loan we have it recorded as?
 *
 * The question nothing asked before session 242, and the one that decides
 * whether every payment on a loan needs splitting into principal and financing
 * cost. A loan's carrying basis can change under you — reversing the entry that
 * capitalised a fee at origination converts a payoff-basis loan into a
 * principal-basis one in a single journal, with no announcement — and from that
 * moment every payment needs a split and none is getting one.
 *
 * Deliberately DIFFERENT from the two checks already in this file that mention
 * "basis", and worded so nobody has to work out which is which:
 *   - intake's `basis_conflict` is about statements disagreeing with each other
 *     about what THEY measure.
 *   - `no_principal_only_basis` is a tie-out reason code meaning "I had nothing
 *     principal-only to compare against".
 *   - this is about the LOAN: given the agreement's own figures and the payments
 *     recorded, does the balance still behave the way we think it does.
 *
 * Silent when there is nothing to say, which matters: every loan carries
 * `carrying_basis = 'unknown'` until a bundle establishes it, and a check that
 * fired on all 22 would bury the ones that mean something. No agreement terms on
 * file means no prediction is possible, so this returns nothing at all rather
 * than 21 findings saying "upload a document".
 */
function checkCarryingBasis(loan: any, terms: any[], balances: any[], mySplits: any[], today: string): Finding[] {
  if (loan.status !== 'active') return []

  const mine = terms.filter((t: any) => t.loan_account_id === loan.id)

  // Two live rows for one term_key is not a bug — migration 242 says so out
  // loud: "a DIFFERENT document stating the same term is a separate row on
  // purpose, because two documents disagreeing is exactly the thing worth
  // seeing." So the consumer must not quietly pick one. `find()` did, taking
  // whatever the scan yielded first, which is not even STABLE: applying a term
  // UPDATEs those rows, an UPDATE relocates the tuple, and the answer changes.
  // A drift error could appear one run and resolve itself the next with nothing
  // about the loan having changed.
  const disagreements: string[] = []
  const val = (k: string) => {
    const rows = mine.filter((x: any) => x.term_key === k && x.value_numeric != null)
    if (!rows.length) return null
    const distinct = [...new Set(rows.map((r: any) => Number(r.value_numeric)))]
    if (distinct.length > 1) {
      disagreements.push(`${k}: ${distinct.map(v => money(Number(v))).join(' vs ')}`)
      return null
    }
    return distinct[0]
  }
  const loanTerms = {
    loan_amount: val('loan_amount'),
    fixed_fee: val('fixed_fee'),
    total_repayment_amount: val('total_repayment_amount'),
  }
  // Documents on file contradict each other about this loan's own terms. That is
  // worth saying, and it is emphatically NOT the moment to predict a balance
  // from one of them.
  if (disagreements.length) {
    return [{
      fingerprint: `carrying_basis:${loan.xero_account_code}`,
      check_key: 'contract_terms_disagree',
      severity: 'warn',
      loan_account_id: loan.id,
      title: `${loan.xero_account_name || loan.lender} — two documents state different terms for this loan`,
      plain_english:
        `More than one document on file states this loan's terms, and they do not match: ${disagreements.join('; ')}. ` +
        `Until it is clear which is current, nothing can check that this loan's balance behaves the way it should — so that check is switched off for this loan rather than run against a guess.\n\n` +
        `Open the loan's documents, decide which agreement is the operative one, and remove or supersede the other.`,
      detail: { code: loan.xero_account_code, disagreements },
      proposed_action: { kind: 'resolve_contract_terms', note: 'Decide which document states the current terms.' },
    }]
  }

  // Nothing to predict from. Stay quiet -- see the note above.
  if (loanTerms.loan_amount === null && loanTerms.total_repayment_amount === null) return []

  // Only real, past-dated balances. A future-dated row is a projection, and
  // treating one as a live balance is the exact bug session 196 shipped.
  const live = balances
    .filter((b: any) => b.statement_date <= today && b.principal_balance != null)
    .slice().sort((a: any, b: any) => a.statement_date.localeCompare(b.statement_date))
  if (!live.length) return []

  // BOTH SIDES MUST BE CUT AT THE SAME DATE.
  // The balance is a point in time; the payments are a sum of movements. Compare
  // a past-dated balance against every non-voided split and the staged, future-
  // dated projections that sit on ten of fourteen loans get subtracted from a
  // balance that has not seen them yet. The models then miss by exactly the
  // staged amount, nothing fits, and the check reports 'the balance does not
  // match any expected shape' at severity error — sending someone hunting for a
  // rogue journal that does not exist. Same shape as the bug session 196 shipped,
  // pointed the other way.
  const asOf = live[live.length - 1].statement_date
  const alive = mySplits.filter((s: any) => !s.voided_at)

  // A label that names no date (Verdant's 'Period 84') cannot be placed on either
  // side of that line. Excluding it understates payments; including it overstates
  // them. Neither is a judgement worth making, so a loan carrying any such label
  // is not one this check can speak about at all.
  if (alive.some((s: any) => !/^\d{4}-\d{2}(-\d{2})?$/.test(String(s.period_label || '')))) return []

  // A month label carries no day, so a '2026-08' split cannot be placed against a
  // balance dated 2026-08-12: including it subtracts a whole month of payments
  // the balance has only seen half of. Only months that CLOSED before the balance
  // date count — unless the balance itself sits on the month end, in which case
  // its own month is complete and counts too.
  const asOfMonth = asOf.slice(0, 7)
  const asOfIsMonthEnd = (() => {
    const [y, m] = asOfMonth.split('-').map(Number)
    return asOf === new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  })()
  const inWindow = alive.filter((s: any) => {
    const label = String(s.period_label)
    if (label.length === 7) return asOfIsMonthEnd ? label <= asOfMonth : label < asOfMonth
    return label <= asOf
  })

  const r = detectCarryingBasisDrift({
    loan_id: loan.id,
    loan_label: loan.xero_account_name || loan.lender,
    recorded_basis: (loan.carrying_basis ?? 'unknown'),
    terms: loanTerms,
    balances: live.map((b: any) => ({
      statement_date: b.statement_date, principal_balance: Number(b.principal_balance),
      balance_basis: b.balance_basis, source: b.source,
    })),
    splits: inWindow.map((s: any) => ({
      period_label: s.period_label,
      principal_amount: Number(s.principal_amount), interest_amount: Number(s.interest_amount),
      total_amount: Number(s.total_amount), source: s.source, voided_at: s.voided_at,
    })),
  })

  // 'consistent' and 'not_enough_evidence' are both "nothing to do". Returning
  // them would put a permanent info row on every healthy loan, and the resolve
  // sweep closes a finding by ABSENCE, so silence here is also what marks a
  // previously-drifting loan fixed.
  if (r.verdict === 'consistent' || r.verdict === 'not_enough_evidence') return []

  return [{
    fingerprint: `carrying_basis:${loan.xero_account_code}`,
    check_key: r.verdict === 'payments_unsplit' ? 'carrying_basis_payments_unsplit' : 'carrying_basis_drift',
    severity: r.severity,
    loan_account_id: loan.id,
    title: r.title,
    plain_english: `${r.plain_english}\n\n${r.suggested_next_step}`,
    detail: { code: loan.xero_account_code, ...r.detail },
    proposed_action: { kind: 'confirm_carrying_basis', note: r.suggested_next_step },
  }]
}

// ── Runner ──────────────────────────────────────────────────────────────

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
    const [{ data: loans }, { data: statements }, { data: splits }, { data: amortRows }, { data: contractTerms }] = await Promise.all([
      supa.from('loan_accounts').select('*'),
      supa.from('loan_statements').select('*').order('statement_date', { ascending: false }),
      supa.from('loan_splits').select('*'),
      // An amortization schedule IS a lender document. Several loans here (Dexter 2,
      // PCV, Verdant, PayPal 2) are reconciled against a schedule rather than a
      // monthly statement, and the first live version of this check told David they
      // had "never been checked against anything outside Xero" — flatly untrue, and
      // the kind of wrong that erodes trust in every other finding on the page.
      // v20 (session 246): schedule_id + the schedule's own id / generated date /
      // created_at ride along so ONE schedule can be chosen deterministically
      // (Verdant holds two, with overlapping rows and duplicate dates), and row_type
      // rides along so totals and rate-change rows can be excluded (Dexter's carry
      // POPULATED balances). The row_type filter is applied HERE as well as at the
      // point of use: server-side it buys headroom under PostgREST's row cap, and
      // client-side it keeps the invariant visible at the line that depends on it.
      //
      // THE HEADROOM IS THIN AND SHOULD NOT BE MISTAKEN FOR SAFETY. Measured
      // 2026-08-28: loan_amortization_rows holds 926 rows against a 1,000 cap, and
      // this filter takes the read to 886 — forty rows, not a margin. One more
      // Verdant-sized schedule crosses it, and a silently truncated read here would
      // decide which schedule wins and which balance answers a date, with no error
      // anywhere. That is why the count is checked below rather than assumed; raising
      // the cap is the real fix and is A9's open item.
      supa.from('loan_amortization_rows')
        .select('row_date, row_type, balance, schedule_id, loan_amortization_schedules!inner(id, loan_account_id, balance_basis, schedule_generated_date, created_at)')
        .in('row_type', SCHEDULE_ANCHOR_ROW_TYPES)
        .not('balance', 'is', null),
      // Terms as the LENDER stated them (session 242). Only live rows: a superseded
      // term is history, and predicting a balance from a superseded agreement would
      // report drift that is really just an old contract.
      // A failed read here is indistinguishable from an empty table, and an empty
      // table makes checkCarryingBasis silent. Logged so a broken read cannot
      // masquerade as "no loan has terms yet".
      supa.from('loan_contract_terms')
        .select('loan_account_id, term_key, value_numeric, superseded_at')
        .is('superseded_at', null),
    ])
    if (!contractTerms) console.error('reconciliation-run: loan_contract_terms read returned no data; the carrying-basis check will stay silent this run')
    // A truncated amortization read is not a smaller answer, it is a DIFFERENT one:
    // the schedule chosen below and the balance answering a date both come from these
    // rows, and PostgREST truncates at its cap without an error. Never let that decide
    // a closing balance silently. 1,000 is the project's configured cap; anything at
    // or above it means the pick was made from a partial set.
    if ((amortRows?.length ?? 0) >= 1000) {
      console.error(`reconciliation-run: loan_amortization_rows returned ${amortRows!.length} rows — at or above the PostgREST cap. The schedule choice and every schedule anchor this run may be made from a PARTIAL set. Raise the cap or page this read before trusting a close.`)
    }
    const active = (loans || []).filter(l => l.xero_account_code)
    const codes = active.map(l => l.xero_account_code)

    // ── THE TWO MONTH ENDS THIS RUN MEASURES (session 246) ──────────────────
    // The month being closed, and the month the rollforward OPENS on. Derived from
    // `today`, NOT from effectiveCloseDate(): a measurement must not depend on the
    // CPA's progress through the close, or the opening balance moves under her while
    // she works and `computed_at` stops meaning anything. On 2026-08-28 these are
    // 2026-07-31 and 2026-06-30.
    const closingMonthEnd = monthEndBefore(today)
    const priorMonthEnd = monthEndBefore(closingMonthEnd)

    // Window: far enough back to cover every lender anchor we need to compare against,
    // plus the checkpoint, plus a small buffer. Anchors on active loans are recent, so
    // this stays cheap — a normal run pulls ~60 days, not ten years.
    //
    // ── priorMonthEnd IS A CANDIDATE, AND THIS IS THE LOAD-BEARING LINE ──────
    // balanceAt() walks an in-memory ledger from a checkpoint. Ask it for a date
    // OUTSIDE the pulled window and it finds nothing to walk, so it hands back the
    // CHECKPOINT wearing the target date's label — a confident wrong number, with no
    // error and nothing on the row to distinguish it from a real one. Without this
    // candidate, a run whose newest checkpoint is yesterday opens the window at
    // yesterday-5 and every stored "balance at 30 June" would be June's label on
    // August's figure. The refusal guard in the loan loop is the second line of
    // defence; this is the first, and the one that means the guard rarely fires.
    // Cost: the window floor moves from ~5 days to ~35-67 days on runs that would
    // otherwise have been short — inside the "~60 days" this comment already
    // budgeted for, and pullXero slices it a month at a time so the page cap is
    // untouched.
    const anchorDates = (statements || [])
      .filter(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date <= today)
      .map(s => s.statement_date)
    let windowFrom = body.from_date
      || [checkpointDate, priorMonthEnd, ...anchorDates.slice().sort()].filter(Boolean).sort()[0]
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

    // v19: the checkpoint is Xero's own Trial Balance at the day before the
    // window opens — primary data, refreshed every run, immune to edits of any
    // age. The stored rolling checkpoint is only the fallback below.
    const tbDate = addDays(windowFrom, -1)
    const tb = await fetchTrialBalances(tbDate)

    const { entries, changedOld } = await pullXero(windowFrom, pullTo, prev?.started_at ?? null)
    const relevantChangedOld = changedOld.filter(r => r.lines.some((l: any) => codes.includes(l.c)))
    const allEntries = [...entries, ...relevantChangedOld]
    const ledger = buildLedger(allEntries, codes)

    // ── new / still-open / resolved, by fingerprint ──
    // Engine-owned rows only. This table is now shared with the intake subsystem
    // (source='intake'), and the resolve sweep below closes anything it did not
    // re-find. The engine never produces intake check_keys, so an unscoped load
    // would silently auto-resolve every intake finding. Never resolve what we don't own.
    //
    // Read BEFORE the loan loop (session 244), not after it, because the loop now
    // needs last close's balance_vs_lender gap for the settlement-lag growth test.
    // Nothing is written to this table until the loop has finished, so moving the
    // read earlier changes no row it sees.
    const { data: existing } = await supa.from('reconciliation_findings').select('*').eq('source', 'engine')

    const findings: Finding[] = []
    const tieOuts: TieOut[] = []
    // Month-end books balances, and the refusals. See the block beside tieOuts.push().
    const bookBalances: any[] = []
    const bookBalanceSkips: Array<{ loan_account_id: string; code: string; as_of: string; reason: string }> = []
    // The month's measured movement, and its refusals. Kept separate from the balance
    // skips because the two can diverge: an explicit `from_date` inside the closing
    // month leaves the closing BALANCE measurable while the movement window is not.
    const drawSkips: Array<{ loan_account_id: string; code: string; month: string; reason: string }> = []
    let drawsMeasured = 0
    for (const loan of active) {
      const code = loan.xero_account_code
      // v19: Trial Balance first (a code absent from the report is a genuine
      // zero balance — Xero omits zero rows); the rolled checkpoint only when
      // the report fetch failed this run.
      const cpDate = tb ? tbDate : (checkpointDate || windowFrom)
      const cp = tb ? (tb[code] ?? 0) : (checkpoints[code] ?? 0)
      const haveCheckpoint = tb ? true : (checkpointDate != null && checkpoints[code] != null)
      const mine = (statements || []).filter(s => s.loan_account_id === loan.id)
      const stmtAnchors = mine
        .filter(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date <= today)
        // statement_id + storage_path ride along so a tie-out row can link straight to the
        // actual document, and keep linking after the statement row is gone.
        .map(s => ({ statement_date: s.statement_date, principal_balance: s.principal_balance, source: s.source, balance_basis: s.balance_basis, statement_id: s.id, storage_path: s.storage_path }))
      // ── ONE SCHEDULE, PAYMENT-BEARING ROWS ONLY (session 246, amendment A3) ──
      // Two live hazards this walked straight into, both silent, both worse than the
      // draft design assumed:
      //
      //  1. NO row_type FILTER. Dexter's schedule carries an `initial` row, eight
      //     `annual_total` rows with POPULATED balances (2025-12-31 -> 112,314.00;
      //     2026-12-31 -> 72,415.24), a `grand_total` at 0.00, and a `rate_change`
      //     dated 2026-08-31 with balance 0.00 SHARING THAT DATE with the real
      //     payment row at 86,066.61. Which of those two won was decided by
      //     Array.prototype.sort stability — i.e. by luck — and the losing coin flip
      //     reads Dexter as paid off. A `balance != null` test does NOT catch this:
      //     Verdant's total rows are null but Dexter's are not, so do not generalise
      //     from Verdant. loan-cross-check has filtered correctly since session 221
      //     and left a comment saying this engine did not; that ends here.
      //
      //  2. NO SCHEDULE DE-DUPLICATION. Verdant holds TWO schedules (generated
      //     2026-08-25 and 2025-06-12) with overlapping rows and duplicate dates, and
      //     all 168 rows were merged into one walk — so which row answered "the
      //     balance on this date" depended on which schedule PostgREST returned
      //     first. Pick ONE deterministically and read only its rows.
      //
      // The winner is chosen from rows that have ALREADY passed the row_type and
      // balance filters, and before the `<= today` cut. Choosing after the date cut
      // would let a loan's schedule identity change as time passes; choosing from
      // unfiltered rows would let a schedule made only of totals rows win and leave
      // the loan with no anchor at all rather than the older, usable one.
      const myAmortRows = (amortRows || []).filter((r: any) =>
        r.loan_amortization_schedules?.loan_account_id === loan.id &&
        SCHEDULE_ANCHOR_ROW_TYPES.includes(String(r.row_type ?? '')))
      const chosenScheduleId = pickScheduleId(myAmortRows)
      const schedAnchors = myAmortRows
        .filter((r: any) => r.schedule_id === chosenScheduleId && r.row_date <= today)
        .map((r: any) => ({ statement_date: r.row_date, principal_balance: r.balance, source: 'amortization_schedule', balance_basis: r.loan_amortization_schedules?.balance_basis ?? null }))
      // ── AUTHORITY RANKING (session 239) ──────────────────────────────────
      // Was: sort the merged list by DATE alone. Both halves are individually
      // filtered, but the RANKING was not — so an amortization projection
      // outranked a lender document purely by being newer.
      //
      // Live cost: PCV holds a real portal statement dated 2026-08-01 and a
      // projected schedule row dated 2026-08-04. Three days, and the tie-out
      // anchored to OUR OWN ARITHMETIC — so anchor_source came back
      // 'amortization_schedule', _loanVariance() correctly downgraded the
      // exception to 'unverified', and the Loans page told David to "upload a
      // statement to make this a real check" about a loan holding sixteen of
      // them. One of the three largest deviations on the page was an artifact
      // of this sort.
      //
      // The rule, and why it is not simply authority-first: a two-year-old
      // lender document is not a better answer for "what is owed today" than
      // last week's schedule row. So authority wins WITHIN A TOLERANCE —
      // a lender document outranks our own arithmetic unless it is more than
      // ANCHOR_AUTHORITY_GRACE_DAYS staler than the newest row we hold.
      // Mirrors _rankByAuthority() in admin-dashboard/index.html; the two
      // copies exist because the client cannot import from _shared/.
      const merged = [...stmtAnchors, ...schedAnchors]
        .sort((a, b) => b.statement_date.localeCompare(a.statement_date))
      const anchors = rankAnchorsByAuthority(merged)
      const futureOnlyAnchor = !anchors.length && mine.some(s => REAL_ANCHOR_SOURCES.includes(s.source) && s.statement_date > today)
      const derived = mine.filter(s => isDerivedSource(s.source) && s.statement_date <= today)
      const mySplits = (splits || []).filter(s => s.loan_account_id === loan.id)

      // Always produce a verdict, even when it is "could not compare" -- that is the whole
      // point of the tie-out. checkBalanceVsLender then derives its finding from it.
      const tie = computeTieOut(loan, ledger, cp, cpDate, anchors, windowFrom, haveCheckpoint, today)
      tieOuts.push(tie)

      // ── MONTH-END BOOKS BALANCE (session 246, DESIGN-CLOSING-EVIDENCE) ────────
      // The same Xero rebuild computeTieOut() just did, snapshotted at two fixed
      // dates instead of one anchor date, and RETAINED. This is the whole reason
      // grade B is worth shipping: for Verdant, every loan_statements row IS the
      // schedule, every split is schedule-generated, and the closing figure would be
      // the schedule too — opening, movement and closing all one document, so the
      // variance is identically zero by construction, for every month, forever. That
      // is not a test. A books-side opening from Xero is independent of any schedule,
      // so opening − principal versus closing becomes a check that can actually fail.
      //
      // It is a pure in-memory walk over an already-sorted ledger: no Xero call, no
      // extra read, ~44 array scans and one batched upsert against an ~18-second run.
      // ── WHAT MOVED THE BALANCE IN THE CLOSING MONTH ────────────────────────────
      // Its own coverage test, deliberately NOT inherited from the closing balance's.
      // The movement window opens the day after priorMonthEnd, so it needs the ledger
      // back to priorMonthEnd + 1, while the closing BALANCE only needs it back to the
      // checkpoint. An explicit `from_date` of 2026-07-15 leaves 7/31's balance
      // perfectly measurable and the July movement window half-missing — and a
      // half-summed month is not a smaller draw, it is a WRONG one.
      //
      // A ZERO DRAW AND AN UNMEASURABLE DRAW MUST NOT LOOK ALIKE. Eight of these
      // loans genuinely drew nothing in July, and the rollforward will subtract that
      // zero and foot. If an unmeasurable month also came back 0.00 the rollforward
      // would subtract that too and print a confident tie over a month it never read.
      // So `movement_measured` is an explicit flag, `drawn`/`reduced` are null when it
      // is false, and the refusal is counted in the run summary.
      const movementCovered = priorMonthEnd >= addDays(windowFrom, -1)
      const movement = movementCovered
        ? { ...measureMovement(code, priorMonthEnd, closingMonthEnd, ledger),
            ...stagedMovementInWindow(code, priorMonthEnd, closingMonthEnd, ledger, mySplits) }
        : null

      for (const asOf of [closingMonthEnd, priorMonthEnd]) {
        // ── REFUSE RATHER THAN WRITE ────────────────────────────────────────────
        // Outside the pulled window balanceAt() has nothing to walk and returns the
        // CHECKPOINT wearing the target date's label. Nothing about the stored row
        // would show it: same shape, same precision, same confident two decimals.
        // The rollforward would then open July on August's balance and report a
        // variance attributed to nothing. An absence the run summary explains beats
        // a number nobody can trust, so refuse and say why.
        //
        // The bound is `windowFrom - 1`, not `windowFrom`: the checkpoint sits a day
        // before the window opens (v19's Trial Balance date), and a walk that starts
        // exactly there needs no ledger row at all. Below it, the backward walk needs
        // entries the pull never fetched.
        if (!haveCheckpoint) {
          bookBalanceSkips.push({ loan_account_id: loan.id, code, as_of: asOf, reason: 'no_checkpoint' })
          continue
        }
        if (asOf < addDays(windowFrom, -1)) {
          bookBalanceSkips.push({ loan_account_id: loan.id, code, as_of: asOf, reason: 'before_window' })
          continue
        }
        // The walk covers (min(asOf, cpDate), max(asOf, cpDate)], so BOTH ends have to
        // sit inside the pull, not just the target date. On the Trial Balance path
        // cpDate IS windowFrom - 1 and this can never fire. It exists for the rolled
        // fallback: a failed report fetch puts the checkpoint at the PREVIOUS run's
        // period_to, and an operator passing an explicit `from_date` later than that
        // leaves the forward walk missing every entry between them — the same silent
        // wrong number from the other direction.
        if (cpDate < addDays(windowFrom, -1)) {
          bookBalanceSkips.push({ loan_account_id: loan.id, code, as_of: asOf, reason: 'checkpoint_before_window' })
          continue
        }
        // ── STAGED SPLITS ARE COUNTED, AND SAID SO (amendment A6) ───────────────
        // loan-xero-post creates pre-staged SPEND transactions with Status
        // 'AUTHORISED', dated on the schedule row's own due date — routinely a month
        // end. isLive() returns true for those, so balanceAt() includes them, while
        // the rollforward deliberately excludes staged splits from the month's
        // principal. DO NOT net them out: Xero's own balance sheet includes them and
        // this table means "what Xero says". Record the count instead, so the
        // rollforward can explain the difference rather than report a variance equal
        // to a payment that has not happened, attributed to nothing.
        const stagedDates: Array<string | null> = mySplits.filter((s: any) => s.status === 'staged').map(stagedLedgerDate)
        bookBalances.push({
          loan_account_id: loan.id,
          as_of: asOf,
          balance: balanceAt(code, asOf, ledger, cp, cpDate),
          basis: 'xero_rebuild',
          run_id: run.id,
          // EXPLICIT, not the column default. A default does not fire on an upsert
          // that lands on an existing row, so a re-run would silently keep the first
          // run's timestamp beside a freshly recomputed balance — and "when was this
          // measured" is this table's whole value.
          computed_at: new Date().toISOString(),
          detail: {
            code,
            checkpoint: cp,
            checkpoint_date: cpDate,
            checkpoint_basis: tb ? 'trial_balance' : 'rolled_fallback',
            window_from: windowFrom,
            entries_counted: entriesWalked(code, asOf, ledger, cpDate),
            staged_entries_at_or_before: stagedDates.filter(d => d !== null && d <= asOf).length,
            // Staged splits whose record states no ledger date (no stage_reference and
            // a month-only period_label). Never guessed at; counted, so a reader can
            // see the count above is complete rather than assume it.
            staged_entries_undated: stagedDates.filter(d => d === null).length,
            // ── THE MONTH'S MOVEMENT, ON THE CLOSING ROW ONLY ──────────────────
            // It describes the interval (priorMonthEnd, closingMonthEnd], which is the
            // month this row CLOSES. Repeating it on the opening row would attach the
            // same figures to a date they do not describe.
            ...(asOf === closingMonthEnd ? {
              movement_from: priorMonthEnd,
              movement_to: closingMonthEnd,
              movement_measured: movement != null,
              ...(movement ?? {
                // Explicit nulls, not absent keys and not zeros. A reader branching on
                // movement_measured gets the right answer either way; a reader that
                // forgets to branch gets null and an arithmetic error, which is loud.
                // A zero here would be silently subtracted and print a tie.
                drawn: null, reduced: null, drawn_entries: null, reduced_entries: null,
                mixed_sign_entries: null, staged_reduction_in_month: null,
                staged_entries_in_month: null, staged_refs_not_in_ledger: null,
                movement_skip_reason: 'window_not_covered',
              }),
            } : {}),
          },
        })
        if (asOf === closingMonthEnd) {
          if (movement) drawsMeasured++
          else drawSkips.push({ loan_account_id: loan.id, code, month: closingMonthEnd, reason: 'window_not_covered' })
        }
      }
      // The closing balance row itself was refused, so there is nowhere to record the
      // month's movement. Counted here so that measured + skipped always equals one
      // per loan — a total that silently falls short is how a missing month hides.
      if (!bookBalances.some(b => b.loan_account_id === loan.id && b.as_of === closingMonthEnd)) {
        drawSkips.push({ loan_account_id: loan.id, code, month: closingMonthEnd, reason: 'no_closing_balance_row' })
      }
      findings.push(...checkBalanceVsLender(loan, tie, mine, contractTerms || [], today,
                                            priorBalanceGap(existing || [], loan.id, tie.as_of)))

      // Still gated: derived drift genuinely has nothing to say without a checkpoint.
      if (haveCheckpoint) {
        findings.push(...checkDerivedDrift(loan, ledger, cp, cpDate, derived, windowFrom))
      }
      findings.push(...checkLumpedPayments(loan, ledger, today, mine))
      findings.push(...checkDoubleReallocation(loan, ledger, mySplits))
      findings.push(...checkFutureDatedStatements(loan, mine, today))
      // A recorded 'amortization_schedule' close policy only exempts a loan from the
      // stale-anchor nag when a usable schedule actually stands behind it: at least
      // one payment-bearing row, from the ONE chosen schedule, dated on or before
      // today. A policy with nothing behind it is grade C and must still report.
      findings.push(...checkStaleAnchor(loan, anchors, today, futureOnlyAnchor, schedAnchors.length > 0))
      findings.push(...checkNonLiveCounted(loan, allEntries.filter((r: any) => r.date >= windowFrom), mySplits))
      findings.push(...checkUnexplainedLedgerAdjustment(loan, ledger, mySplits, windowFrom))
      // Window-independent by construction: reads loan_accounts, loan_contract_terms,
      // loan_statements and loan_splits, none of which are windowed. So it cannot go
      // stale the way a ledger-derived finding can.
      findings.push(...checkCarryingBasis(loan, contractTerms || [], mine, mySplits, today))
    }

    const byFp: Record<string, any> = Object.fromEntries((existing || []).map(f => [f.fingerprint, f]))
    let seenFps = new Set(findings.map(f => f.fingerprint))
    // Rebuild the ones the window can no longer reach, before anything is written.
    // They keep their fingerprints, so this UPDATES the existing rows rather than
    // creating new ones -- the point is to correct text that has gone stale, not
    // to re-raise anything.
    const refreshed = refreshOutOfWindowLumped(existing || [], active, statements || [], today, windowFrom, seenFps)
    if (refreshed.length) {
      findings.push(...refreshed)
      seenFps = new Set(findings.map(f => f.fingerprint))
    }
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
    // v19: the stored checkpoint is now only a fallback, but keep it fresh from
    // whichever basis THIS run trusted, so a future run with a failed Trial
    // Balance fetch falls back to something recent rather than something stale.
    const newCheckpoint: Record<string, number> = {}
    for (const loan of active) {
      const code = loan.xero_account_code
      const cpDateForRoll = tb ? tbDate : (checkpointDate || windowFrom)
      const cpForRoll = tb ? (tb[code] ?? 0) : (checkpoints[code] ?? 0)
      newCheckpoint[code] = balanceAt(code, today, ledger, cpForRoll, cpDateForRoll)
    }

    const counts = {
      findings_new: enriched.filter(f => f._state === 'new').length,
      findings_open: enriched.filter(f => f._state === 'open').length,
      findings_resolved: enriched.filter(f => f._state === 'resolved').length,
    }

    // Persist the tie-out snapshot. Deliberately non-fatal: the findings and the report are
    // the run's primary output, and losing a snapshot must not fail a run that otherwise
    // succeeded. Upsert on (run_id, loan_account_id) so a re-run is idempotent.
    if (tieOuts.length) {
      const { error: tieErr } = await supa.from('loan_tie_outs')
        .upsert(tieOuts.map(t => ({ ...t, run_id: run.id })), { onConflict: 'run_id,loan_account_id' })
      if (tieErr) console.error('loan_tie_outs write failed (run continues):', tieErr.message)
    }

    // Persist the month-end books balances. Same discipline as the tie-outs above:
    // ONE batched upsert, non-fatal, keyed on the slot (loan, date, basis) so a
    // re-run of the same month end UPDATES that month end rather than stacking a
    // second opinion beside the first. Deliberately NOT the sequential per-row await
    // the findings loop uses — that shape exists there because each finding needs its
    // own previous row read first, which these do not, and ~44 round-trips inside an
    // ~18-second run would be pure cost.
    //
    // onConflict names bare columns because that is all PostgREST ever emits;
    // loan_book_balances_slot_uniq is a real UNIQUE CONSTRAINT for exactly that
    // reason (session 242: a partial or expression index raises 42P10 and every
    // upsert fails, leaving the table permanently empty with the error visible
    // nowhere but a per-action line).
    let bookBalancesWritten = bookBalances.length
    let bookBalanceWriteError: string | null = null
    if (bookBalances.length) {
      const { error: bbErr } = await supa.from('loan_book_balances')
        .upsert(bookBalances, { onConflict: 'loan_account_id,as_of,basis' })
      if (bbErr) {
        // The summary must never claim a write that did not land: a reader has no
        // other way to tell an empty table from a silent failure, and the rollforward
        // falls back to the possibly-circular opening when a row is missing.
        console.error('loan_book_balances write failed (run continues):', bbErr.message)
        bookBalancesWritten = 0
        bookBalanceWriteError = bbErr.message
      }
    }

    const meta = { loansChecked: active.length, previousRunAt: prev?.started_at ?? null, changedOldCount: relevantChangedOld.length }
    const html = renderReport({ ...run, mode, period_from: windowFrom, period_to: today }, enriched, {}, meta)
    const reportPath = `reconciliation/${today}-${run.id}.html`
    await supa.storage.from('loan-statements').upload(reportPath, new Blob([html], { type: 'text/html' }), { upsert: true, contentType: 'text/html' })

    await supa.from('reconciliation_runs').update({
      status: 'complete', finished_at: new Date().toISOString(),
      period_from: windowFrom, period_to: today,
      checks_run: 9, loans_checked: active.length, ...counts,
      summary: {
        checkpoint: newCheckpoint,
        xero_entries_scanned: allEntries.length,
        changed_old_entries: relevantChangedOld.length,
        checkpoint_trusted: tb != null || checkpointDate != null,
        checkpoint_basis: tb ? 'trial_balance' : (checkpointDate != null ? 'rolled_fallback' : 'none'),
        // What this run measured for the close, and what it REFUSED to measure. The
        // skip list is not decoration: two counts alone would say a number is missing
        // without saying why, and "an absence the summary explains" is the whole
        // reason the guard refuses instead of writing.
        book_balance_month_ends: { closing: closingMonthEnd, prior: priorMonthEnd },
        book_balances_written: bookBalancesWritten,
        book_balances_skipped: bookBalanceSkips.length,
        book_balance_skips: bookBalanceSkips,
        // The month's movement, measured or refused. draws_measured + draws_skipped is
        // one per loan by construction; if it is not, a month went missing quietly.
        draws_measured: drawsMeasured,
        draws_skipped: drawSkips.length,
        draw_skips: drawSkips,
        ...(bookBalanceWriteError ? { book_balance_write_error: bookBalanceWriteError } : {}),
      },
      narrative_source: 'template',
      report_path: reportPath,
    }).eq('id', run.id)

    return new Response(JSON.stringify({
      ok: true, run_id: run.id, mode, period_from: windowFrom, period_to: today,
      ...counts, report_path: reportPath,
      changed_old_entries: relevantChangedOld.length,
      book_balances_written: bookBalancesWritten,
      book_balances_skipped: bookBalanceSkips.length,
      draws_measured: drawsMeasured,
      draws_skipped: drawSkips.length,
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
