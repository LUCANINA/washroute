import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { rederiveIfDerived, REAL_SOURCES } from "../_shared/derive-schedule.ts"

// Ingests one pulled loan statement (Ford Pro CSV today; other lenders/methods later):
//   1. stores the raw CSV in the loan-statements bucket (permanent proof record)
//   2. upserts the loan_statements row
//   3. if there's a prior month's statement, computes principal/interest split
//      (principal = balance delta, interest = total_amount_due - principal)
//      and upserts a loan_splits row with status 'pending_review'
//   4. if an amortization schedule also exists for this loan, cross-checks the
//      computed split against the schedule's row for the same period -- on a
//      mismatch beyond tolerance, flags the split 'needs_attention' instead of
//      posting it as clean 'pending_review'
//
// Body: {
//   lender_account_number: string,       // e.g. '61564140' -- matched against loan_accounts
//   statement_date: 'YYYY-MM-DD',
//   principal_balance: number,
//   payoff_amount?: number,
//   payoff_good_thru?: 'YYYY-MM-DD',
//   total_amount_due?: number,
//   payment_due_date?: 'YYYY-MM-DD',
//   csv_filename: string,
//   csv_base64: string,                  // raw CSV file content, base64-encoded
//   pulled_by?: string,
//   transactions?: { payments: [{date, amount}], fees: [{date, amount}] },  // see v15
//   explicit_split?: { principal: number, interest: number },              // see v21
//   anchors_only?: boolean,              // see v22 -- statement row only, never a split
//   balance_basis?: 'principal_only',    // see v22 -- mark the anchor's basis explicitly
// }
//
// v22 (session 225, 2026-08-21): ANCHORS ONLY -- for full transaction-history
// documents (Ford Pro's FinSimple export is the live case: David's 4140 history,
// 45 payments back to Nov 2022). Each payment row becomes a loan_statements
// anchor so the Find-the-difference engine can walk the loan from day one, but
// NO loan_splits are created: a 45-payment backfill must not flood the approvals
// queue with periods the books already handled. balance_basis may be passed as
// 'principal_only' (whitelisted; anything else is ignored) because these
// documents label the column "Principal Balance" in so many words -- without it
// the row defaults to 'unknown' and the reconciliation walk can't use it.
//
// v21 (session 220 cont., 2026-08-18): EXPLICIT SPLIT -- a third split source,
// alongside statement_delta (diff two statements) and the transactions-based path
// (v15). Statement Ingestion Breadth's inventory pass found that BayFirst SBA,
// iBusiness Funding/FC Marketplace, and SBA EIDL statements all STATE their own
// principal/interest breakdown directly (BayFirst: "PRINCIPAL DUE" / "INTEREST DUE"
// plus a matching "Principal Payment Split Out" / "Interest Payment Split Out"
// transaction ledger; iBusiness: "Past Payment Summary -- Principal: $X / Interest:
// $Y"; SBA EIDL: "Applied to Principal" / "Applied to Interest"). Neither existing
// path fits: statement_delta requires diffing against a prior statement (unnecessary
// here -- the lender already did the math, and unhelpfully means the very FIRST
// statement uploaded for a loan can't get a split at all), and the transactions path
// is shaped for a line-of-credit's separate payment/fee rows, not a single stated
// split. New optional `explicit_split: {principal, interest}` carries the lender's
// own numbers verbatim -- this function's only job is the same amortization
// cross-check every other path already does, then upsert. Never re-derive or
// "correct" a lender-stated split; if it doesn't reconcile against the schedule,
// flag needs_attention and let a human resolve it, per this module's double-entry
// invariant (see PROJECT-NOTES-BOOKKEEPING.md).
//
// Deliberately additive: when explicit_split is absent (every existing caller --
// Ford Pro, Rapid Finance), behavior is byte-identical to v20. This path also does
// NOT require a prior statement to exist (unlike statement_delta below), so the
// first-ever statement uploaded for a portal_manual loan can still produce a split.
//
// If the statement also reports a total-due figure that includes something beyond
// principal+interest (e.g. BayFirst's "TOTAL CURRENT DUE" can in principle include
// escrow/late/other charges, all $0 in every sample seen so far), and it doesn't
// match principal+interest, this flags needs_attention rather than silently
// understating the total or violating the principal+interest=total invariant by
// forcing total_amount to the statement's figure.
//
// v5 (session 205 cont., 2026-08-05): CORS fix -- see loan-xero-post v8 for the full
// story (short version: this function is called directly from the browser but never
// handled the OPTIONS preflight, so every real browser call failed with "Failed to
// fetch" even though the function itself worked fine). Wrapped the untouched original
// handler so every response gets Access-Control-Allow-Origin merged on; no ingestion
// logic below changed.
//
// v15 (session 218 cont., 2026-08-17): TRANSACTION-BASED SPLITS. The existing split
// logic above (step 3) only fires when the statement has a total_amount_due figure --
// it diffs the balance delta against that one number. That works for loans like Ford
// Pro (one "amount due" per statement) but not a revolving line of credit like Rapid
// Finance, whose statement has no such figure at all -- instead it lists every
// individual Payment and Balance Fee as its own line item. Without total_amount_due,
// step 3 silently produces no split, which meant an otherwise-successful statement
// upload left nothing in the review queue -- discovered live the first time this was
// tested against a real Rapid Finance PDF (session 218).
//
// New optional `transactions` param carries that per-transaction detail (parsed
// client-side from the PDF -- see admin-dashboard's LOAN_PDF_PARSERS). When present,
// each payment becomes its own split (full amount as principal, $0 interest -- a
// line-of-credit payment has nothing embedded to reallocate), and each fee becomes a
// separate split on its own date (negative principal, positive interest, net zero --
// reclassifying the fee dollar-for-dollar out of principal into interest expense).
// Mirrors the exact pattern already established by hand on this loan's July splits.
//
// Safety: this INSERTS only -- it never upserts/overwrites. Before inserting, it reads
// which of the candidate dates already have a loan_splits row (any status, including
// 'posted') and skips those entirely. A re-upload of the same statement is therefore a
// safe no-op for periods already reviewed or posted; it only ever adds genuinely new
// periods. This deliberately does NOT touch the amortization-schedule cross-check in
// step 4 above -- that check is specific to the single total_amount_due-based split and
// doesn't apply to a per-transaction line-of-credit statement.
//
// v20 (session 220, 2026-08-18): DIRECT-SPLIT PAIRING AT INGESTION. Discovered live
// (testing loan-xero-post v24, the first Direct Transaction Split matching code):
// v15's per-transaction splits always create TWO separate loan_splits rows per real
// payment -- a payment-only row (interest_amount = 0) and a fee-only reclass row
// (total_amount = 0) -- and loan-xero-post's two earlier no-bank-match short circuits
// (v19: "$0 interest, nothing to reallocate" / "$0 total, pure reclass") intercept
// BOTH of those shapes before they ever reach direct-split matching code, which needs
// a single row with BOTH principal and interest nonzero (the actual shape of one real
// combined bank payment). So Direct Transaction Split could never fire against Rapid's
// real data under the old two-row model, even with direct_split_enabled = true and
// working matching code downstream -- confirmed against Rapid's real posted history
// before David decided how to fix it ("combine at ingestion", his call over the
// alternative of combining at posting time).
//
// Fix: for direct_split_enabled loans only, pair each genuinely-new fee (i.e. already
// past the existingLabels + live-Xero-duplicate checks below -- a fee already covered
// elsewhere must never be pulled into a new pairing) with its nearest not-yet-claimed
// payment candidate within +/-DIRECT_SPLIT_PAIR_WINDOW_DAYS days, closest date wins.
// A tie (2+ equally-close payments) or no in-window candidate leaves that fee (and
// every payment) unpaired -- falls through to the original separate-row behavior,
// unchanged. Every loan with direct_split_enabled = false (the default, and every
// loan except Rapid Credit Line as of this version) is completely unaffected -- this
// whole block is skipped and produces byte-identical output to v19.
// One paired {fee, payment} becomes ONE combined loan_splits row: period_label is the
// PAYMENT's date (the real bank-transaction date loan-xero-post will search against),
// principal_amount = payment.amount - fee.amount, interest_amount = fee.amount,
// total_amount = payment.amount -- this is exactly the shape loan-xero-post's v24
// direct-split matching code expects (principal_amount + interest_amount = total_amount,
// both nonzero).
//
// v19 (session 218 cont. yet further, 2026-08-17): FIX THE REAL BUG -- A SILENT XERO
// QUERY TRUNCATION, NOT A MATCHING-LOGIC PROBLEM. v18's "11 duplicates" conclusion was
// ALSO wrong, for a different reason than v17's "34" was wrong. `fetchLiveXeroWindow`'s
// BankTransactions call filtered by DATE ONLY, across every account in the company --
// Family Laundry has more bank transactions in a 10-month window than Xero's API
// returns in 10 pages (1,000), so the fetch silently truncated and never saw most of
// Rapid's real weekly transactions (which, per David directly checking Xero's own
// Account Transactions report, already carry the interest split EMBEDDED on the SAME
// bank transaction as the payment -- see the Jun 16, 2026 example: one $2,068.89 Spend
// Money transaction with two lines, $1,462.02 to Rapid Credit Line (247) and $606.87 to
// Interest Expense (800)). Fixed by scoping the BankTransactions query to this loan's
// own bank account (`BankAccount.AccountID`, from `loan_accounts.xero_bank_account_id`)
// in addition to date, and raising the page cap from 10 to 30. Re-verified against
// Rapid's real 42-fee list with the corrected, unscoped-no-more query: 40 of 42 already
// in Xero (31 via the single-fee embedded-bank-transaction check, 9 via the existing
// lump-sum journal check), leaving exactly 2 genuinely new -- 2026-08-03 and
// 2026-08-10. That matches exactly what David expected from the start ("we're only
// missing two splits"). The matching logic itself (feeAlreadyInXero,
// findLumpSumMatches) needed no changes -- once fed the complete data, it already
// produced the right answer.
//
// v18 (session 218 cont. even further, 2026-08-17): CATCH LUMP-SUM REALLOCATIONS TOO.
// v17's feeAlreadyInXero() only matched a fee whose amount, alone, equals an interest
// line on a nearby bank transaction or journal. Re-tested live against Rapid's FULL
// real fee list (extracted straight from the actual PDF, not a partial diagnostic) and
// found the earlier "34 duplicates" figure from tonight's investigation was wrong --
// the real count is 11: 2 single-fee exact matches (2026-01-05 embedded on a bank
// transaction, 2026-03-12 via its own journal) PLUS 9 covered by ONE lump-sum journal
// (`cc9e141c-...`, 2025-12-31, $11,029.84) that bundles 2025-11-03's $4,000 draw fee
// with the following 8 weekly fees (2025-11-10 through 2025-12-29) -- their sum is
// exactly $11,029.84 to the penny. v17's per-fee check structurally cannot see this:
// no single fee equals $11,029.84, so all 9 were still showing as "new." Added
// `findLumpSumMatches()`: for each journal with a clean interest/account offsetting
// pair, slide over the still-unmatched fee candidates (sorted by date, capped a few
// days past the journal's own date) looking for a CONTIGUOUS run whose sum matches the
// journal amount exactly -- if found, every fee in that run is a duplicate. Verified
// against Rapid's real 42-fee history before deploying: single-fee matching alone finds
// 2, lump-sum matching finds the other 9, total 11 -- leaving 31 genuinely new fee
// weeks, which matches the real gap (most of this loan's history was in fact never
// reallocated in Xero at all, not "already handled" as first assumed).
//
// v17 (session 218 cont. further, 2026-08-17): DON'T SURFACE WHAT'S ALREADY IN XERO.
// v15's insert-only guard only checks OUR OWN loan_splits table -- it has no way to
// know a period's interest was already reallocated in Xero itself by some earlier,
// different process. Discovered live against Rapid Credit Line's real history: an
// older workflow had already split many weeks' interest -- sometimes coded directly
// onto that week's bank transaction line items, sometimes swept into a single
// lump-sum correction journal covering several weeks at once. v15 had no visibility
// into either, so re-parsing the full statement created 38 "new" pending splits, of
// which 34 were exact-dollar duplicates of interest already sitting in Xero. Two were
// caught only after some had already been posted for real and needed voiding.
//
// The fix: before creating a FEE-type candidate row (the only shape with double-post
// risk -- a payment-type row always has $0 interest, nothing to duplicate), check live
// Xero for this exact amount:
//   (a) a live bank transaction near the fee's date whose own LineItems already
//       include an interest-account line matching this fee's amount to the penny
//       (the "embedded at entry time" pattern), or
//   (b) a live Manual Journal near the fee's date whose interest line matches this
//       fee's amount to the penny (the "separate reallocation journal" pattern).
// Deliberately amount-exact, not just date-nearby -- an amount-blind check is what
// made the lump-sum correction journal look like it covered every neighboring week
// (it doesn't; only the two checks above, tied to this fee's own dollar figure,
// reliably tell duplicate from genuine gap). If the Xero check itself fails for any
// reason (auth, rate limit, transient network), this does NOT block the ingestion --
// it falls back to the v15 behavior (create the row) and flags the failure in the
// response, so a Xero hiccup never silently loses a genuine actionable item.

const MISMATCH_TOLERANCE = 2.00 // dollars
const AMOUNT_TOLERANCE = 0.02   // dollars -- for exact-dollar Xero matching
const INTEREST_ACCOUNT_CODE = '800'
const DIRECT_SPLIT_PAIR_WINDOW_DAYS = 2 // v20 -- same window as loan-xero-post's own +/-2-day match
const money = (n: number) => Math.round(n * 100) / 100

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// Storage object keys are not a free-text field. Session 230: David photographed
// the Ford portal and macOS named it "Screenshot 2026-08-24 at 2.30.19 PM.png";
// dropped into the path verbatim it produced a key with spaces and repeated dots
// that Storage refused, and the whole import failed with a bare "Storage upload
// failed" AFTER the figures had been read and checked -- the most frustrating
// possible place to stop, since everything hard had already succeeded.
//
// Uploads have only ever come from parsers producing tidy names, so this never
// showed. Now that a human's own file names reach it, the key gets built rather
// than concatenated: the extension is preserved (it is what contentTypeFor reads),
// everything else is reduced to letters, digits, dot, dash and underscore, and the
// length is capped so a long name cannot push the key past Storage's limit.
function safeObjectName(filename: string): string {
  const raw = String(filename || 'upload').trim()
  const lastDot = raw.lastIndexOf('.')
  const ext = lastDot > 0 ? raw.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : ''
  const stem = (lastDot > 0 ? raw.slice(0, lastDot) : raw)
    .replace(/[^A-Za-z0-9._-]+/g, '-')   // spaces and punctuation become dashes
    .replace(/\.+/g, '.')                // no runs of dots
    .replace(/-+/g, '-')                 // no runs of dashes
    .replace(/^[-.]+|[-.]+$/g, '')       // never lead or trail with one
    .slice(0, 80)
  const base = stem || 'upload'
  return ext ? `${base}.${ext}` : base
}

function contentTypeFor(filename: string) {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'csv') return 'text/csv'
  return 'application/octet-stream'
}

// Ingesting is a write action -- 'cpa' accounts (read-only) may not call this.
async function callerRole(req: Request) {
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
  const { data: { user } } = await anon.auth.getUser(token)
  if (!user) return null
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).single()
  return profile?.role || null
}

// ── Xero (v17) ───────────────────────────────────────────────────────────────
// Minimal, read-only. Mirrors reconciliation-run's isLive()/norm() conventions so
// behavior stays consistent across every place this codebase reads Xero.

function normXeroDate(dateString: any, dateRaw: any): string {
  if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateString)) return dateString.slice(0, 10)
  const m = String(dateString || dateRaw || '').match(/\/Date\((-?\d+)/)
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10)
  return String(dateString || dateRaw || '').slice(0, 10)
}

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

async function fetchXeroPaged(url: string, token: string, tenantId: string, key: string, maxPages = 30) {
  const all: any[] = []
  const headers = { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json' }
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes('?') ? '&' : '?'
    const res = await fetch(`${url}${sep}page=${page}`, { headers })
    if (!res.ok) throw new Error(`Xero ${key} fetch failed: ${res.status}`)
    const j = await res.json()
    const items = j[key] || []
    all.push(...items)
    if (items.length < 100) break
  }
  return all
}

// Fetches live BankTransactions + ManualJournals touching `accountCode`, in a window
// covering `fromDate`..`toDate` (padded a few days each side). Returns normalized,
// LIVE-ONLY (AUTHORISED / POSTED) rows -- see reconciliation-run's isLive() for why
// this filter matters (Xero returns DELETED/VOIDED from the same endpoints).
//
// v19 (session 218 cont. yet further, 2026-08-17): FIX A SILENT PAGINATION TRUNCATION
// THAT MADE EVERY PRIOR VERSION OF THIS CHECK WRONG. The BankTransactions query below
// used to filter by DATE ONLY, company-wide -- every bank transaction on every account,
// not just this loan's. Family Laundry has far more than 1,000 bank transactions in a
// 10-month window, and fetchXeroPaged capped at 10 pages x 100 = 1,000, so the fetch
// silently truncated and the real embedded-interest-split transactions (most of them
// dated later in the window) were never even seen. This is what made v17/v18's "34
// duplicates, then 11 duplicates" conclusions both wrong -- the real number, once the
// query is scoped correctly and NOT truncated, is 40 of 42 fees already in Xero
// (confirmed live against Rapid's real bank account), leaving exactly 2 genuinely new
// (2026-08-03, 2026-08-10) -- exactly what David expected from the start. Fix: pass
// `bankAccountId` and add `BankAccount.AccountID==Guid("...")` to the where clause so
// Xero only returns this loan's own transactions (a few hundred, not 1,700+
// company-wide), and raised fetchXeroPaged's page cap from 10 to 30 as defense in
// depth. ManualJournals has no per-account "where" filter available and stayed well
// under 1,000 in testing (230), so it's left as a date-only fetch.
async function fetchLiveXeroWindow(accountCode: string, bankAccountId: string | null, fromDate: string, toDate: string) {
  const token = await getXeroToken()
  const tenantId = Deno.env.get('XERO_TENANT_ID')!
  const pad = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
  const from = pad(fromDate, -10)
  const to = pad(toDate, 10)
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const dateClause = `Date>=DateTime(${fy},${fm},${fd})&&Date<=DateTime(${ty},${tm},${td})`
  const btWhere = encodeURIComponent(bankAccountId ? `BankAccount.AccountID==Guid("${bankAccountId}")&&${dateClause}` : dateClause)
  const mjWhere = encodeURIComponent(dateClause)

  const [btRaw, mjRaw] = await Promise.all([
    fetchXeroPaged(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${btWhere}&order=Date`, token, tenantId, 'BankTransactions'),
    fetchXeroPaged(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${mjWhere}&order=Date`, token, tenantId, 'ManualJournals'),
  ])

  const bt = btRaw
    .filter((x: any) => x.Status === 'AUTHORISED')
    .map((x: any) => ({
      date: normXeroDate(x.DateString, x.Date),
      lines: (x.LineItems || []).map((l: any) => ({ code: l.AccountCode, amt: Number(l.LineAmount) })),
    }))
  const mj = mjRaw
    .filter((x: any) => x.Status === 'POSTED')
    .map((x: any) => ({
      date: normXeroDate(x.DateString, x.Date),
      lines: (x.JournalLines || []).map((l: any) => ({ code: l.AccountCode, amt: Number(l.LineAmount) })),
    }))
  return { bt, mj, accountCode }
}

// Is this fee amount already reflected in Xero, either embedded on a nearby bank
// transaction's own line items or via a separate reallocation journal? Amount-exact
// (see the v17 header note for why a date-only/amount-blind check is unsafe here).
function feeAlreadyInXero(feeAmount: number, xero: { bt: any[], mj: any[], accountCode: string }) {
  const embeddedBt = xero.bt.find((t: any) =>
    t.lines.some((l: any) => l.code === xero.accountCode) &&
    t.lines.some((l: any) => l.code === INTEREST_ACCOUNT_CODE && Math.abs(l.amt - feeAmount) < AMOUNT_TOLERANCE))
  if (embeddedBt) return { matched: true, via: 'bank_transaction', date: embeddedBt.date }

  const matchingJournal = xero.mj.find((j: any) =>
    j.lines.some((l: any) => l.code === INTEREST_ACCOUNT_CODE && Math.abs(l.amt - feeAmount) < AMOUNT_TOLERANCE) &&
    j.lines.some((l: any) => l.code === xero.accountCode && Math.abs(l.amt + feeAmount) < AMOUNT_TOLERANCE))
  if (matchingJournal) return { matched: true, via: 'manual_journal', date: matchingJournal.date }

  return { matched: false }
}

// Lump-sum match (v18): a single journal whose interest-account total equals the sum
// of a CONTIGUOUS run of still-unmatched fee candidates (sorted by date), ending on or
// before the journal's own date (+5 days' slack for posting lag). Catches "one
// correction journal covering several weeks at once" -- see the v18 header note for
// why per-fee exact matching alone structurally cannot see this pattern, and the real
// Rapid case ($11,029.84 covering 9 weeks) this was built and verified against.
function findLumpSumMatches(
  fees: { date: string, amount: number }[],
  xero: { mj: any[], accountCode: string },
  alreadyMatched: Set<string>,
) {
  const lumpMatches = new Map<string, { via: string, id: string }>()
  const sorted = fees.filter(f => !alreadyMatched.has(f.date)).slice().sort((a, b) => a.date.localeCompare(b.date))
  for (const j of xero.mj) {
    const interestLines = j.lines.filter((l: any) => l.code === INTEREST_ACCOUNT_CODE)
    const acctLines = j.lines.filter((l: any) => l.code === xero.accountCode)
    if (!interestLines.length || !acctLines.length) continue
    const interestSum = interestLines.reduce((s: number, l: any) => s + l.amt, 0)
    const acctSum = acctLines.reduce((s: number, l: any) => s + l.amt, 0)
    if (interestSum <= 0 || Math.abs(interestSum + acctSum) > AMOUNT_TOLERANCE) continue // not a clean offsetting pair
    const jDatePad = new Date(j.date + 'T00:00:00Z'); jDatePad.setUTCDate(jDatePad.getUTCDate() + 5)
    const cutoff = jDatePad.toISOString().slice(0, 10)
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].date > cutoff) break
      let running = 0
      for (let k = i; k < sorted.length; k++) {
        if (sorted[k].date > cutoff) break
        running = Math.round((running + sorted[k].amount) * 100) / 100
        if (Math.abs(running - interestSum) < AMOUNT_TOLERANCE) {
          for (let m = i; m <= k; m++) lumpMatches.set(sorted[m].date, { via: 'manual_journal_lump_sum', id: j.id })
          break
        }
        if (running > interestSum + AMOUNT_TOLERANCE) break
      }
    }
  }
  return lumpMatches
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const body = await req.json()
    const {
      lender_account_number, statement_date, principal_balance,
      payoff_amount, payoff_good_thru, total_amount_due, payment_due_date,
      csv_filename, csv_base64, pulled_by, transactions, explicit_split,
      anchors_only, balance_basis,
    } = body

    if (!lender_account_number || !statement_date || principal_balance == null || !csv_base64) {
      return new Response(JSON.stringify({ error: 'lender_account_number, statement_date, principal_balance, csv_base64 are required' }), { status: 400 })
    }

    const role = await callerRole(req)
    if (!role || !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized -- ingesting statements requires an admin or manager account.' }), { status: 403 })
    }

    const supa = admin()

    const { data: loanAcct, error: loanErr } = await supa
      .from('loan_accounts')
      .select('id, xero_account_id, xero_account_code, xero_bank_account_id, status, direct_split_enabled')
      .eq('lender_account_number', lender_account_number)
      .single()
    if (loanErr || !loanAcct) {
      return new Response(JSON.stringify({ error: `No loan_accounts row for lender_account_number ${lender_account_number}. Add it first.`, details: loanErr?.message }), { status: 404 })
    }

    // 1. Upload the raw CSV to storage (permanent proof record)
    const storagePath = `${loanAcct.id}/${statement_date}-${safeObjectName(csv_filename)}`
    const csvBytes = Uint8Array.from(atob(csv_base64), c => c.charCodeAt(0))
    const { error: uploadErr } = await supa.storage
      .from('loan-statements')
      .upload(storagePath, csvBytes, { contentType: contentTypeFor(csv_filename), upsert: true })
    if (uploadErr) {
      return new Response(JSON.stringify({ error: 'Storage upload failed', details: uploadErr.message, attempted_path: storagePath }), { status: 500 })
    }

    // 2. Upsert the statement row
    const { data: stmt, error: stmtErr } = await supa
      .from('loan_statements')
      .upsert({
        loan_account_id: loanAcct.id,
        statement_date,
        principal_balance,
        payoff_amount: payoff_amount ?? null,
        payoff_good_thru: payoff_good_thru ?? null,
        total_amount_due: total_amount_due ?? null,
        payment_due_date: payment_due_date ?? null,
        storage_path: storagePath,
        source: 'portal_manual_pull',
        pulled_by: pulled_by ?? null,
        // v22: only the whitelisted value ever lands; everything else keeps the
        // column's default. Never let a caller invent a basis.
        ...(balance_basis === 'principal_only' ? { balance_basis: 'principal_only' } : {}),
      }, { onConflict: 'loan_account_id,statement_date' })
      .select()
      .single()
    if (stmtErr) {
      return new Response(JSON.stringify({ error: 'loan_statements upsert failed', details: stmtErr.message }), { status: 500 })
    }

    // v22: anchors_only -- the statement row above IS the deliverable. Skip every
    // split path (delta, explicit, transactions, backfill) so a bulk history
    // import creates zero approvals.
    //
    // v24 (session 230) -- ONE narrow exception, because v22 turned out to have a
    // permanent side effect nobody intended. Ford statements only ever arrive
    // through this path, so those four loans stopped getting splits ENTIRELY: 4140
    // took its regular 2026-08 payment and there was no entry for it anywhere, so
    // $110.03 of interest sat in the loan account instead of interest expense, and
    // the same would have happened every month forever.
    //
    // The exception is deliberately the narrowest thing that fixes it: a row that
    // carries the lender's OWN principal AND interest figures, for a period we have
    // not already accounted for, at or after the newest period already posted.
    // Everything about v22's original reason survives -- importing a 2022-2026
    // history still creates zero approvals, because every one of those periods is
    // older than the newest posted one.
    //
    // Four conditions, each earning its place:
    //   1. explicit principal AND interest, both > 0 -- nothing is inferred here.
    //      This also excludes a lump-sum row (principal only, no interest), which
    //      is loan-record-principal-payment's job and is keyed by DATE not month.
    //   2. no split already exists for that month -- never overwrite, never
    //      duplicate.
    //   3. no principal_payment split already recorded on that exact date -- the
    //      lump David booked by hand this morning must not come back as a second
    //      entry when the same history is re-uploaded.
    //   4. the period is not older than the newest posted/already_in_xero period.
    //      A loan with no posted period at all stays anchors-only: without a
    //      cutoff there is nothing to stop a full history becoming 45 approvals,
    //      which is precisely what v22 was written to prevent.
    if (anchors_only) {
      const exP = explicit_split != null ? Number((explicit_split as any).principal) : NaN
      const exI = explicit_split != null ? Number((explicit_split as any).interest) : NaN
      const hasExplicit = Number.isFinite(exP) && Number.isFinite(exI) && exP > 0 && exI > 0
      const periodLabel = statement_date.slice(0, 7)
      let anchorSplit: any = null
      let anchorNote = 'Filed as a reconciliation history anchor -- no split was generated.'

      if (!hasExplicit) {
        anchorNote = 'Filed as a reconciliation history anchor -- this row carries no lender principal/interest split, so no entry was generated.'
      } else {
        const { data: sameMonth } = await supa.from('loan_splits')
          .select('id, status').eq('loan_account_id', loanAcct.id).eq('period_label', periodLabel).maybeSingle()
        const { data: sameDay } = await supa.from('loan_splits')
          .select('id, status').eq('loan_account_id', loanAcct.id).eq('period_label', statement_date).maybeSingle()
        const { data: doneSplits } = await supa.from('loan_splits')
          .select('period_label').eq('loan_account_id', loanAcct.id).in('status', ['posted', 'already_in_xero'])
        const doneMonths = (doneSplits || [])
          .map((r: any) => String(r.period_label).slice(0, 7))
          .filter((m: string) => /^\d{4}-\d{2}$/.test(m)).sort()
        const cutoff = doneMonths.length ? doneMonths[doneMonths.length - 1] : null

        if (sameMonth) {
          anchorNote = `Filed as a history anchor -- a ${sameMonth.status} entry already exists for ${periodLabel}, so nothing was added.`
        } else if (sameDay) {
          anchorNote = `Filed as a history anchor -- an entry dated ${statement_date} already exists (${sameDay.status}), so nothing was added.`
        } else if (!cutoff) {
          anchorNote = 'Filed as a history anchor -- this loan has no posted period yet, so the whole history stays anchors-only.'
        } else if (periodLabel < cutoff) {
          anchorNote = `Filed as a history anchor -- ${periodLabel} is older than the newest posted period (${cutoff}), so it is history rather than new work.`
        } else {
          const p = money(exP), i = money(exI)
          const t = money(exP + exI)
          const { data: created, error: createErr } = await supa.from('loan_splits').insert({
            loan_account_id: loanAcct.id,
            period_label: periodLabel,
            current_statement_id: stmt.id,
            prior_statement_id: null,
            source: 'explicit_split',
            principal_amount: p, interest_amount: i, total_amount: t,
            status: 'pending_review',
            review_notes: `Taken from the lender's own transaction history for ${statement_date}: principal $${p.toFixed(2)} + interest $${i.toFixed(2)}. Both figures are the lender's, not computed from a balance difference.`,
          }).select().single()
          if (createErr) {
            anchorNote = `Filed as a history anchor, but the entry for ${periodLabel} could not be created: ${createErr.message}`
          } else {
            anchorSplit = created
            anchorNote = `Filed as a history anchor, and the ${periodLabel} payment was entered from the lender's own principal/interest split.`
          }
        }
      }

      // A new real anchor can also move a derived projection -- same reasoning as
      // the ordinary ingest path below.
      let rederivedAnchor: any = { skipped: 'not a real lender statement' }
      if (REAL_SOURCES.includes(String(stmt?.source ?? ''))) {
        rederivedAnchor = await rederiveIfDerived(supa, loanAcct.id, `new lender statement dated ${stmt.statement_date}`)
      }

      return new Response(JSON.stringify({
        ok: true,
        statement: { id: stmt.id, statement_date: stmt.statement_date, principal_balance: stmt.principal_balance },
        anchors_only: true,
        split: anchorSplit,
        splits_created: anchorSplit ? [anchorSplit] : [],
        rederived: rederivedAnchor,
        note: anchorNote,
      }), { headers: { 'Content-Type': 'application/json' } })
    }

    // 3. Find the prior statement (most recent before this one) to compute a split
    const { data: priorStmts } = await supa
      .from('loan_statements')
      .select('*')
      .eq('loan_account_id', loanAcct.id)
      .lt('statement_date', statement_date)
      .order('statement_date', { ascending: false })
      .limit(1)
    const prior = priorStmts?.[0]

    let split = null
    let scheduleComparison = null

    if (explicit_split && explicit_split.principal != null && explicit_split.interest != null) {
      // v21: EXPLICIT SPLIT -- see the version note at the top of this file. Runs
      // instead of (not in addition to) the statement_delta path below, and does not
      // require `prior` to exist.
      const periodLabel = statement_date.slice(0, 7) // 'YYYY-MM'
      const principalAmount = money(Number(explicit_split.principal))
      const interestAmount = money(Number(explicit_split.interest))
      const totalAmount = money(principalAmount + interestAmount)

      let status = 'pending_review'
      let reviewNotes: string | null = `From the lender statement's own stated principal/interest breakdown (not computed by diffing against a prior statement).`
      let amortizationRowId: string | null = null

      const { data: schedules } = await supa
        .from('loan_amortization_schedules')
        .select('id')
        .eq('loan_account_id', loanAcct.id)
        .order('schedule_generated_date', { ascending: false })
        .limit(1)
      if (schedules?.length) {
        const monthStart = `${periodLabel}-01`
        const [y, m] = periodLabel.split('-').map((x: string) => parseInt(x, 10))
        const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
        const { data: schedRows } = await supa
          .from('loan_amortization_rows')
          .select('*')
          .eq('schedule_id', schedules[0].id)
          .eq('row_type', 'payment')
          .gte('row_date', monthStart)
          .lt('row_date', nextMonth)
        if (schedRows?.length) {
          const schedPrincipal = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
          const schedInterest = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
          amortizationRowId = schedRows[0].id
          const principalDiff = Math.abs(schedPrincipal - principalAmount)
          const interestDiff = Math.abs(schedInterest - interestAmount)
          scheduleComparison = { schedPrincipal, schedInterest, principalDiff, interestDiff }
          if (principalDiff > MISMATCH_TOLERANCE || interestDiff > MISMATCH_TOLERANCE) {
            status = 'needs_attention'
            reviewNotes += ` Mismatch vs. amortization schedule for ${periodLabel}: statement shows principal $${principalAmount.toFixed(2)} / interest $${interestAmount.toFixed(2)}, schedule expects principal $${schedPrincipal.toFixed(2)} / interest $${schedInterest.toFixed(2)}.`
          }
        }
      }

      // If the statement also reports a total-due figure and it doesn't match
      // principal+interest, flag it rather than silently drop the discrepancy --
      // total_amount stays principal+interest either way (the invariant this module
      // enforces everywhere: principal_amount + interest_amount = total_amount), the
      // mismatch just becomes a human review item instead of a posted number.
      if (total_amount_due != null) {
        const statedTotal = money(Number(total_amount_due))
        if (Math.abs(statedTotal - totalAmount) > MISMATCH_TOLERANCE) {
          status = 'needs_attention'
          reviewNotes += ` Statement's total due ($${statedTotal.toFixed(2)}) doesn't match principal+interest ($${totalAmount.toFixed(2)}) -- likely escrow/late/other charges not captured; review before posting.`
        }
      }

      const { data: splitRow, error: splitErr } = await supa
        .from('loan_splits')
        .upsert({
          loan_account_id: loanAcct.id,
          period_label: periodLabel,
          prior_statement_id: prior ? prior.id : null,
          current_statement_id: stmt.id,
          source: 'explicit_split',
          amortization_row_id: amortizationRowId,
          principal_amount: principalAmount,
          interest_amount: interestAmount,
          total_amount: totalAmount,
          status,
          review_notes: reviewNotes,
        }, { onConflict: 'loan_account_id,period_label' })
        .select()
        .single()
      if (splitErr) {
        return new Response(JSON.stringify({ error: 'loan_splits upsert failed', details: splitErr.message, statement: stmt }), { status: 500 })
      }
      split = splitRow
    } else if (prior) {
      const principalPaid = Math.round((Number(prior.principal_balance) - Number(stmt.principal_balance)) * 100) / 100
      const totalDue = stmt.total_amount_due != null ? Number(stmt.total_amount_due) : null
      const interestPaid = totalDue != null ? Math.round((totalDue - principalPaid) * 100) / 100 : null

      if (totalDue && totalDue > 0) {
        const periodLabel = statement_date.slice(0, 7) // 'YYYY-MM'

        // 4. Cross-check against an amortization schedule for this loan+period, if one exists.
        let status = 'pending_review'
        let reviewNotes: string | null = null
        let amortizationRowId: string | null = null

        const { data: schedules } = await supa
          .from('loan_amortization_schedules')
          .select('id')
          .eq('loan_account_id', loanAcct.id)
          .order('schedule_generated_date', { ascending: false })
          .limit(1)
        if (schedules?.length) {
          const monthStart = `${periodLabel}-01`
          const [y, m] = periodLabel.split('-').map((x: string) => parseInt(x, 10))
          const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
          const { data: schedRows } = await supa
            .from('loan_amortization_rows')
            .select('*')
            .eq('schedule_id', schedules[0].id)
            .eq('row_type', 'payment')
            .gte('row_date', monthStart)
            .lt('row_date', nextMonth)
          if (schedRows?.length) {
            const schedPrincipal = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
            const schedInterest = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
            amortizationRowId = schedRows[0].id
            const principalDiff = Math.abs(schedPrincipal - principalPaid)
            const interestDiff = interestPaid != null ? Math.abs(schedInterest - interestPaid) : 0
            scheduleComparison = { schedPrincipal, schedInterest, principalDiff, interestDiff }
            if (principalDiff > MISMATCH_TOLERANCE || interestDiff > MISMATCH_TOLERANCE) {
              status = 'needs_attention'
              reviewNotes = `Statement vs. amortization schedule mismatch for ${periodLabel}: statement shows principal $${principalPaid.toFixed(2)} / interest ${interestPaid != null ? '$' + interestPaid.toFixed(2) : 'n/a'}, schedule expects principal $${schedPrincipal.toFixed(2)} / interest $${schedInterest.toFixed(2)}.`
            }
          }
        }

        const { data: splitRow, error: splitErr } = await supa
          .from('loan_splits')
          .upsert({
            loan_account_id: loanAcct.id,
            period_label: periodLabel,
            prior_statement_id: prior.id,
            current_statement_id: stmt.id,
            source: 'statement_delta',
            amortization_row_id: amortizationRowId,
            principal_amount: principalPaid,
            interest_amount: interestPaid,
            total_amount: totalDue,
            status,
            review_notes: reviewNotes,
          }, { onConflict: 'loan_account_id,period_label' })
          .select()
          .single()
        if (splitErr) {
          return new Response(JSON.stringify({ error: 'loan_splits upsert failed', details: splitErr.message, statement: stmt }), { status: 500 })
        }
        split = splitRow
      }
    }

    // 3b. Backward-fill (v16, v23). v23 (torture-test BUG-0002 fix): the existence
    // check used to be "does ANY loan_splits row already exist for next period" --
    // that let a Staging Engine schedule projection (source='amortization_schedule',
    // still pending_review -- see staging-next.ts's ensureUpcomingSplit) masquerade
    // as an already-handled period and permanently block the real, statement-backed
    // number from ever being computed on out-of-order/backfilled ingestion. Mirrors
    // the same source+status check ensureUpcomingSplit's rule 4 already uses: only a
    // row that is NOT a still-pending schedule projection counts as "already real."
    let backfilledSplit: any = null
    {
      const { data: nextStmts } = await supa
        .from('loan_statements')
        .select('*')
        .eq('loan_account_id', loanAcct.id)
        .gt('statement_date', statement_date)
        .order('statement_date', { ascending: true })
        .limit(1)
      const next = nextStmts?.[0]
      if (next && next.total_amount_due && Number(next.total_amount_due) > 0) {
        const nextPeriodLabel = next.statement_date.slice(0, 7)
        const { data: existingForNext } = await supa
          .from('loan_splits')
          .select('id, status, source')
          .eq('loan_account_id', loanAcct.id)
          .eq('period_label', nextPeriodLabel)
          .maybeSingle()
        // A schedule-projected placeholder that hasn't been consumed yet is not a
        // real, statement-backed split -- it must not block the real backfilled
        // number from being computed. Any other existing row (already statement_delta,
        // explicit_split, staged, posted, etc.) is real/consumed and still blocks, same
        // as before.
        const isUnconsumedProjection = existingForNext
          && existingForNext.status === 'pending_review'
          && existingForNext.source === 'amortization_schedule'
        if (!existingForNext || isUnconsumedProjection) {
          const principalPaid = Math.round((Number(stmt.principal_balance) - Number(next.principal_balance)) * 100) / 100
          const totalDue = Number(next.total_amount_due)
          const interestPaid = Math.round((totalDue - principalPaid) * 100) / 100

          let status = 'pending_review'
          let reviewNotes: string | null = isUnconsumedProjection
            ? `Backfilled retroactively after the missing ${statement_date} statement was uploaded -- replaces an unconfirmed amortization-schedule projection for this period with a real, statement-backed number.`
            : `Backfilled retroactively after the missing ${statement_date} statement was uploaded -- this period's split couldn't be computed before because no earlier statement existed to diff against.`
          let amortizationRowId: string | null = null
          const { data: schedules } = await supa
            .from('loan_amortization_schedules')
            .select('id')
            .eq('loan_account_id', loanAcct.id)
            .order('schedule_generated_date', { ascending: false })
            .limit(1)
          if (schedules?.length) {
            const monthStart = `${nextPeriodLabel}-01`
            const [y, m] = nextPeriodLabel.split('-').map((x: string) => parseInt(x, 10))
            const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
            const { data: schedRows } = await supa
              .from('loan_amortization_rows')
              .select('*')
              .eq('schedule_id', schedules[0].id)
              .eq('row_type', 'payment')
              .gte('row_date', monthStart)
              .lt('row_date', nextMonth)
            if (schedRows?.length) {
              const schedPrincipal = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
              const schedInterest = Math.round(schedRows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
              amortizationRowId = schedRows[0].id
              const principalDiff = Math.abs(schedPrincipal - principalPaid)
              const interestDiff = Math.abs(schedInterest - interestPaid)
              if (principalDiff > MISMATCH_TOLERANCE || interestDiff > MISMATCH_TOLERANCE) {
                status = 'needs_attention'
                reviewNotes = `Backfilled after the missing ${statement_date} statement was uploaded, but doesn't match the amortization schedule for ${nextPeriodLabel}: computed principal $${principalPaid.toFixed(2)} / interest $${interestPaid.toFixed(2)}, schedule expects principal $${schedPrincipal.toFixed(2)} / interest $${schedInterest.toFixed(2)}.`
              }
            }
          }

          const { data: backfillRow, error: backfillErr } = await supa
            .from('loan_splits')
            .upsert({
              loan_account_id: loanAcct.id,
              period_label: nextPeriodLabel,
              prior_statement_id: stmt.id,
              current_statement_id: next.id,
              source: 'statement_delta',
              amortization_row_id: amortizationRowId,
              principal_amount: principalPaid,
              interest_amount: interestPaid,
              total_amount: totalDue,
              status,
              review_notes: reviewNotes,
            }, { onConflict: 'loan_account_id,period_label' })
            .select()
            .single()
          if (backfillErr) {
            backfilledSplit = { error: backfillErr.message }
          } else {
            backfilledSplit = backfillRow
          }
        }
      }
    }

    // 5. Transaction-based splits (v15, extended v17, v20). Runs independently of step
    //    3/4; a statement can have both, either, or neither.
    let splitsCreated: any[] = []
    let skippedExisting = 0
    let skippedAlreadyInXero: any[] = []
    let xeroCheckError: string | null = null
    let directSplitPairs: any[] = []
    if (transactions && ((transactions.payments?.length || 0) + (transactions.fees?.length || 0) > 0)) {
      const payments = Array.isArray(transactions.payments) ? transactions.payments : []
      const fees = Array.isArray(transactions.fees) ? transactions.fees : []
      const candidateDates = Array.from(new Set([...payments.map((p: any) => p.date), ...fees.map((f: any) => f.date)]))

      const { data: existingSplits, error: existingErr } = await supa
        .from('loan_splits')
        .select('period_label')
        .eq('loan_account_id', loanAcct.id)
        .in('period_label', candidateDates)
      if (existingErr) {
        return new Response(JSON.stringify({ error: 'Could not check for existing splits before generating new ones', details: existingErr.message, statement: stmt, split }), { status: 500 })
      }
      const existingLabels = new Set((existingSplits || []).map((s: any) => s.period_label))

      // Unchanged skip-counting semantics from v19: count a candidate as "skipped
      // existing" only if it has a date+amount AND that date already has a row.
      for (const p of payments) if (p?.date && p.amount != null && existingLabels.has(p.date)) skippedExisting++
      for (const f of fees) if (f?.date && f.amount != null && existingLabels.has(f.date)) skippedExisting++

      const feeCandidates = fees.filter((f: any) => f?.date && f.amount != null && !existingLabels.has(f.date))
      const paymentCandidates = payments.filter((p: any) => p?.date && p.amount != null && !existingLabels.has(p.date))

      // v17: pull the live Xero window ONCE for every fee candidate not already
      // filtered out by existingLabels, so a duplicate already sitting in Xero
      // (embedded on a bank transaction, or covered by a separate reallocation
      // journal) never gets a redundant pending row. See the v19 header note on
      // fetchLiveXeroWindow for why this MUST be scoped to the loan's own bank
      // account, not date-only -- an unscoped query silently truncates and misses
      // real matches. Scoped to fee candidates only (payments carry $0 interest --
      // nothing to duplicate).
      let xero: { bt: any[], mj: any[], accountCode: string } | null = null
      if (feeCandidates.length && loanAcct.xero_account_code) {
        try {
          const dates = feeCandidates.map((f: any) => f.date).sort()
          xero = await fetchLiveXeroWindow(loanAcct.xero_account_code, loanAcct.xero_bank_account_id ?? null, dates[0], dates[dates.length - 1])
        } catch (e) {
          // Never let a Xero hiccup silently drop a genuine gap -- fall back to
          // creating every fee candidate (the v15 behavior) and say so plainly.
          xeroCheckError = String((e as any)?.message || e)
        }
      }

      // v18: run the single-fee check for every candidate first, then run the
      // lump-sum check against whatever's left over -- a fee already caught by the
      // single-fee check is excluded from the lump-sum window search (it's already
      // accounted for, and leaving it in could let it get double-claimed).
      let lumpMatches = new Map<string, { via: string, id: string }>()
      const singleMatchedDates = new Set<string>()
      if (xero) {
        for (const f of feeCandidates) {
          if (feeAlreadyInXero(money(Number(f.amount)), xero).matched) singleMatchedDates.add(f.date)
        }
        lumpMatches = findLumpSumMatches(
          feeCandidates.map((f: any) => ({ date: f.date, amount: money(Number(f.amount)) })),
          xero,
          singleMatchedDates,
        )
      }

      // Fees genuinely new: past existingLabels AND not already reflected live in
      // Xero (either check above). Records skippedAlreadyInXero along the way --
      // this replaces v19's inline check inside the fee row-building loop with the
      // same logic, computed once up front so v20's pairing step (below) has a
      // clean "eligible to pair or become its own row" list to work from.
      const genuinelyNewFees: any[] = []
      for (const f of feeCandidates) {
        if (xero) {
          if (singleMatchedDates.has(f.date)) {
            const check = feeAlreadyInXero(money(Number(f.amount)), xero)
            skippedAlreadyInXero.push({ date: f.date, amount: money(Number(f.amount)), matched_via: check.via, matched_date: check.date })
            continue
          }
          const lump = lumpMatches.get(f.date)
          if (lump) {
            skippedAlreadyInXero.push({ date: f.date, amount: money(Number(f.amount)), matched_via: lump.via, matched_journal_id: lump.id })
            continue
          }
        }
        genuinelyNewFees.push(f)
      }

      // v20 (session 220): DIRECT-SPLIT PAIRING. For direct_split_enabled loans, pair
      // each genuinely-new fee with its nearest not-yet-claimed payment candidate
      // within +/-DIRECT_SPLIT_PAIR_WINDOW_DAYS, closest date wins. See the version
      // note above for the full "why" -- short version: this produces the single
      // combined loan_splits row (both principal and interest nonzero) that
      // loan-xero-post's v24 direct-split matching code actually needs, instead of
      // the two separate rows that used to make that matching code unreachable.
      // A tie or no in-window candidate leaves everything unpaired, falling through
      // to the original separate-row behavior below. direct_split_enabled = false
      // (every loan except Rapid as of this version) skips this block entirely.
      const claimedPaymentDates = new Set<string>()
      const pairedFeeDates = new Set<string>()
      const pairs: { fee: any, payment: any }[] = []
      if (loanAcct.direct_split_enabled) {
        const sortedFees = genuinelyNewFees.slice().sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)))
        for (const f of sortedFees) {
          const feeTime = new Date(f.date + 'T00:00:00Z').getTime()
          const inWindow = paymentCandidates
            .filter((p: any) => !claimedPaymentDates.has(p.date))
            .map((p: any) => ({ p, dist: Math.abs(new Date(p.date + 'T00:00:00Z').getTime() - feeTime) }))
            .filter((x: any) => x.dist <= DIRECT_SPLIT_PAIR_WINDOW_DAYS * 86400000)
            .sort((a: any, b: any) => a.dist - b.dist)
          if (!inWindow.length) continue // no candidate in window -- unpaired, falls through
          if (inWindow.length > 1 && inWindow[0].dist === inWindow[1].dist) continue // ambiguous tie -- unpaired
          const chosen = inWindow[0].p
          claimedPaymentDates.add(chosen.date)
          pairedFeeDates.add(f.date)
          pairs.push({ fee: f, payment: chosen })
        }
      }
      directSplitPairs = pairs.map(pr => ({
        fee_date: pr.fee.date,
        payment_date: pr.payment.date,
        principal: money(Number(pr.payment.amount) - Number(pr.fee.amount)),
        interest: money(Number(pr.fee.amount)),
        total: money(Number(pr.payment.amount)),
      }))

      const rows: any[] = []
      for (const p of paymentCandidates) {
        if (claimedPaymentDates.has(p.date)) continue // consumed by a direct-split pair below
        rows.push({
          loan_account_id: loanAcct.id,
          period_label: p.date,
          current_statement_id: stmt.id,
          source: 'statement_delta',
          principal_amount: money(Number(p.amount)),
          interest_amount: 0,
          total_amount: money(Number(p.amount)),
          status: 'pending_review',
          review_notes: `Auto-generated from uploaded statement's transaction detail (${statement_date}) -- weekly payment, no fee same-day.`,
        })
      }
      for (const f of genuinelyNewFees) {
        if (pairedFeeDates.has(f.date)) continue // consumed by a direct-split pair below
        rows.push({
          loan_account_id: loanAcct.id,
          period_label: f.date,
          current_statement_id: stmt.id,
          source: 'statement_delta',
          principal_amount: money(-Number(f.amount)),
          interest_amount: money(Number(f.amount)),
          total_amount: 0,
          status: 'pending_review',
          review_notes: `Auto-generated from uploaded statement's transaction detail (${statement_date}) -- fee reclassified from principal to interest, net zero.`,
        })
      }
      for (const pr of pairs) {
        rows.push({
          loan_account_id: loanAcct.id,
          period_label: pr.payment.date,
          current_statement_id: stmt.id,
          source: 'statement_delta',
          principal_amount: money(Number(pr.payment.amount) - Number(pr.fee.amount)),
          interest_amount: money(Number(pr.fee.amount)),
          total_amount: money(Number(pr.payment.amount)),
          status: 'pending_review',
          review_notes: `Auto-generated, combined for Direct Transaction Split -- fee dated ${pr.fee.date} ($${money(Number(pr.fee.amount)).toFixed(2)}) paired with the payment dated ${pr.payment.date} ($${money(Number(pr.payment.amount)).toFixed(2)}), within the +/-${DIRECT_SPLIT_PAIR_WINDOW_DAYS}-day window.`,
        })
      }

      if (rows.length) {
        // INSERT only, never upsert -- a period that already has a split (pending
        // OR posted) was already filtered out above by the existingLabels check.
        // This is deliberate: it must be structurally impossible for a re-upload
        // to silently touch a row that's already been reviewed or posted.
        const { data: inserted, error: insertErr } = await supa
          .from('loan_splits')
          .insert(rows)
          .select()
        if (insertErr) {
          return new Response(JSON.stringify({ error: 'loan_splits insert failed (transaction-based)', details: insertErr.message, statement: stmt, split }), { status: 500 })
        }
        splitsCreated = inserted || []
      }
    }

    // ── Re-derive, because a new anchor supersedes the projection ──────────
    // A derived schedule is only ever as good as the statement it was anchored
    // to. A newer lender balance is strictly better evidence -- it may also carry
    // a rate change (4140 changed rate for eleven months in 2024 and changed
    // back), which only a re-fit will notice. No-op on lender-issued schedules,
    // and it can never fail this request: storing the statement is the primary
    // job and has already succeeded.
    let rederived: any = { skipped: 'not a real lender statement' }
    if (REAL_SOURCES.includes(String(stmt?.source ?? ''))) {
      rederived = await rederiveIfDerived(supa, loanAcct.id, `new lender statement dated ${stmt.statement_date}`)
    }

    return new Response(JSON.stringify({
      ok: true,
      loan_account: loanAcct,
      statement: stmt,
      rederived,
      split,
      schedule_comparison: scheduleComparison,
      splits_created: splitsCreated,
      splits_skipped_existing: skippedExisting,
      splits_skipped_already_in_xero: skippedAlreadyInXero,
      xero_check_error: xeroCheckError,
      direct_split_pairs: directSplitPairs,
      backfilled_split: backfilledSplit,
      note: (split || splitsCreated.length || (backfilledSplit && !backfilledSplit.error))
        ? undefined
        : (prior
          ? 'No total_amount_due on this statement and no transaction detail produced a new split -- nothing due this period, no split computed.'
          : 'No prior statement found -- this is the first pulled statement for this loan, nothing to diff yet.'),
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const res = await handleRequest(req)
  const mergedHeaders = new Headers(res.headers)
  for (const [k, v] of Object.entries(cors)) mergedHeaders.set(k, v)
  if (!mergedHeaders.has('Content-Type')) mergedHeaders.set('Content-Type', 'application/json')
  return new Response(res.body, { status: res.status, headers: mergedHeaders })
})
