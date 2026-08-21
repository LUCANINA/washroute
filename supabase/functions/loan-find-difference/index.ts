import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'

// ── loan-find-difference (session 225) ──────────────────────────────────────
// "Find the difference": when the reconciliation engine says a loan's Xero
// balance disagrees with the lender, THIS function answers WHERE and WHY.
//
// It walks the lender's own statement history against Xero's live entries,
// period by period, finds the exact span where the two histories split apart,
// names the culprit entries with evidence from both sides, and — only in the
// one shape where the fix is mechanically safe (an interest/principal
// allocation correction between the loan account and Interest Expense) —
// proposes the closing journal for review.
//
// Design rules, inherited from the rest of the system:
//  * Option B: every number here is read from a lender document or from Xero.
//    Nothing is ever invented. When the engine can't attribute the gap, it
//    says exactly that and what evidence would pin it down.
//  * Review-before-write: analyze mode NEVER writes anything, to Xero or the
//    DB. post_fix requires admin/manager, re-runs the whole analysis
//    server-side, and refuses if the proposal changed since the human saw it.
//  * The CPA's work is untouchable (David, session 224): if a culprit traces
//    to an entry that is already split/multi-line (her fingerprint), the
//    engine flags an exception instead of proposing anything.
//  * Same "only live entries count" law as reconciliation-run: AUTHORISED
//    bank transactions, POSTED manual journals; everything else is ignored.
//  * Balance walks only run between statements whose balance_basis is
//    confirmed principal_only — never compare two figures whose bases differ.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const INTEREST_EXPENSE_ACCOUNT_CODE = '800'
const TOL = 0.02 // dollars — same near-zero tolerance as the reconciliation engine

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r2 = (n: number) => Math.round(n * 100) / 100

function normDate(dateString: any, dateRaw: any): string {
  if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dateString)) return dateString.slice(0, 10)
  const m = String(dateString || dateRaw || '').match(/\/Date\((-?\d+)/)
  if (m) return new Date(Number(m[1])).toISOString().slice(0, 10)
  return String(dateString || dateRaw || '').slice(0, 10)
}

// Same paged fetch discipline as reconciliation-run: hard-fail on a truncated
// pull rather than analyze partial data (a partial ledger fabricates mismatches).
async function fetchPaged(baseUrl: string, headers: Record<string, string>, key: string, maxPages = 25) {
  const all: any[] = []
  for (let page = 1; page <= maxPages; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    let res: Response | null = null, text = ''
    for (let retry = 0; retry < 5; retry++) {
      res = await fetch(`${baseUrl}${sep}page=${page}`, { headers })
      if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || (2 + retry * 3)) * 1000); continue }
      text = await res.text(); break
    }
    if (!res) throw new Error('Xero: no response after retries')
    if (res.status === 429) throw new Error('Xero rate limit hit — try again in a few minutes.')
    let j: any
    try { j = JSON.parse(text) } catch { throw new Error(`Xero returned non-JSON (${res.status}): ${text.slice(0, 200)}`) }
    if (!res.ok) throw new Error(`Xero error ${res.status}: ${JSON.stringify(j).slice(0, 300)}`)
    const items = j[key] || []
    all.push(...items)
    if (items.length < 100) break
    if (page === maxPages) throw new Error(`Xero pull hit the ${maxPages}-page cap for ${key} — window too wide.`)
    await sleep(300)
  }
  return all
}

const isLive = (r: any) => r.srcType === 'BankTransaction' ? r.status === 'AUTHORISED' : r.status === 'POSTED'

/** Signed effect on a liability balance (same math as reconciliation-run). */
function effect(rec: any, code: string) {
  const amt = rec.lines.filter((l: any) => l.c === code).reduce((s: number, l: any) => s + Number(l.a || 0), 0)
  if (rec.srcType === 'BankTransaction') return String(rec.type || '').startsWith('RECEIVE') ? amt : -amt
  return -amt
}

const normBT = (x: any) => ({
  srcType: 'BankTransaction', srcId: x.BankTransactionID, date: normDate(x.DateString, x.Date),
  status: x.Status, type: x.Type, ref: x.Reference || null, contact: x.Contact?.Name || null,
  total: Number(x.Total || 0), reconciled: !!x.IsReconciled,
  lines: (x.LineItems || []).map((l: any) => ({ d: l.Description, c: l.AccountCode, a: l.LineAmount })),
})
const normMJ = (x: any) => ({
  srcType: 'ManualJournal', srcId: x.ManualJournalID, date: normDate(x.DateString, x.Date),
  status: x.Status, narration: x.Narration || null, total: null, reconciled: null,
  lines: (x.JournalLines || []).map((l: any) => ({ d: l.Description, c: l.AccountCode, a: l.LineAmount })),
})

// Window pull. Two speeds (session 225, after the first live run timed out):
//
// FAST PATH — when the loan knows its own bank account, ONE BankTransactions
// query scoped by BankAccount.AccountID covers the whole window in a handful of
// pages. This is loan-ingest-statement's v19 lesson applied here: an 18-month
// org-wide crawl is ~70 pages and ~90 seconds of month slices; the same window
// scoped to one bank account is a few hundred rows. Manual journals are always
// pulled org-wide for the window (they carry the split/correction entries and
// number in the hundreds, not thousands). The 30-page cap still HARD-FAILS on
// truncation rather than analyzing partial data.
//
// SLOW FALLBACK — a loan with no xero_bank_account_id gets the original
// month-sliced org-wide pull (complete but slow; a single wide unscoped window
// can silently truncate, monthly slices never approach the cap).
async function pullWindow(fromDate: string, toDate: string, headers: Record<string, string>, bankAccountId: string | null) {
  const [fy, fm, fd] = fromDate.split('-').map(Number)
  const [ty, tm, td] = toDate.split('-').map(Number)
  const dateClause = `Date>=DateTime(${fy},${fm},${fd})&&Date<=DateTime(${ty},${tm},${td})`
  const bt: any[] = [], mj: any[] = []

  if (bankAccountId) {
    const w = encodeURIComponent(`BankAccount.AccountID==Guid("${bankAccountId}")&&${dateClause}`)
    bt.push(...(await fetchPaged(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${w}&order=Date`, headers, 'BankTransactions', 30)).map(normBT))
    await sleep(300)
  } else {
    const months: Array<[string, string]> = []
    for (let cur = fromDate.slice(0, 8) + '01'; cur <= toDate;) {
      const d = new Date(cur + 'T00:00:00Z')
      const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      const endOfMonth = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10)
      months.push([cur < fromDate ? fromDate : cur, endOfMonth > toDate ? toDate : endOfMonth])
      cur = nextMonth.toISOString().slice(0, 10)
    }
    if (months.length > 18) throw new Error(`window_too_wide:${months.length}`)
    for (const [mFrom, mTo] of months) {
      const [ay, am, ad] = mFrom.split('-').map(Number)
      const [by, bm, bd] = mTo.split('-').map(Number)
      const w = encodeURIComponent(`Date>=DateTime(${ay},${am},${ad})&&Date<=DateTime(${by},${bm},${bd})`)
      bt.push(...(await fetchPaged(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${w}&order=Date`, headers, 'BankTransactions')).map(normBT))
      await sleep(300)
    }
  }

  mj.push(...(await fetchPaged(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${encodeURIComponent(dateClause)}&order=Date`, headers, 'ManualJournals', 30)).map(normMJ))

  const seen = new Set<string>()
  return [...bt, ...mj].filter(r => { if (seen.has(r.srcId)) return false; seen.add(r.srcId); return true })
}

async function fetchAccountsMap(headers: Record<string, string>): Promise<Record<string, string>> {
  try {
    const res = await fetch('https://api.xero.com/api.xro/2.0/Accounts', { headers })
    if (!res.ok) return {}
    const json = await res.json().catch(() => null)
    const map: Record<string, string> = {}
    for (const a of json?.Accounts || []) if (a?.Code) map[a.Code] = a.Name
    return map
  } catch { return {} }
}

// The CPA fingerprint, verbatim from loan-xero-post v39/v40: a bank transaction
// that is already split into multiple lines, or carries an Interest Expense
// line, was already worked by a human. The engine never proposes on top of it.
const alreadyWorked = (rec: any) =>
  rec.srcType === 'BankTransaction' && (rec.lines.length > 1 || rec.lines.some((l: any) => String(l.c) === INTEREST_EXPENSE_ACCOUNT_CODE))

// Deterministic proposal token: the human approves EXACTLY this journal; a
// re-analysis that lands anywhere else refuses to post. FNV-1a over the fields
// that define the journal.
function proposalToken(loanId: string, period: string, amount: number, direction: string): string {
  const s = `${loanId}|${period}|${amount.toFixed(2)}|${direction}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

function entryView(rec: any, code: string, acctMap: Record<string, string>) {
  return {
    src_type: rec.srcType, id: rec.srcId, date: rec.date, status: rec.status,
    reconciled: rec.reconciled, ref: rec.ref, contact: rec.contact, narration: rec.narration,
    total: rec.total, effect_on_loan: r2(effect(rec, code)),
    already_worked: alreadyWorked(rec),
    lines: rec.lines.map((l: any) => ({ description: l.d ?? null, amount: l.a, account_code: l.c, account_name: acctMap[l.c] ?? null })),
  }
}

async function handle(req: Request): Promise<Response> {
  const supa = admin()
  const body = await req.json().catch(() => ({}))
  const { loan_account_id, post_fix, proposal_token, posted_by } = body

  const role = await callerRole(req)
  if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
    return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  if (post_fix && !['admin', 'manager'].includes(role)) {
    return new Response(JSON.stringify({ error: 'Only an admin or manager can post a correction. Your account can review the analysis but not write.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  if (!loan_account_id) {
    return new Response(JSON.stringify({ error: 'loan_account_id is required.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  const { data: loan } = await supa.from('loan_accounts').select('*').eq('id', loan_account_id).single()
  if (!loan || !loan.xero_account_code) {
    return new Response(JSON.stringify({ error: 'Loan not found, or it has no Xero account code.' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const code = loan.xero_account_code
  const today = new Date().toISOString().slice(0, 10)

  const [{ data: statements }, { data: splits }, { data: findings }] = await Promise.all([
    supa.from('loan_statements').select('*').eq('loan_account_id', loan_account_id).lte('statement_date', today).order('statement_date', { ascending: true }),
    supa.from('loan_splits').select('*').eq('loan_account_id', loan_account_id).order('period_label', { ascending: true }),
    supa.from('reconciliation_findings').select('*').eq('loan_account_id', loan_account_id).eq('check_key', 'balance_vs_lender').eq('status', 'open').order('last_seen_at', { ascending: false }).limit(1),
  ])
  const headline = findings?.[0]?.detail?.difference != null
    ? { difference: Number(findings[0].detail.difference), as_of: findings[0].detail.anchor_date || null }
    : null

  // Reliable anchors: principal_only basis only — the walk subtracts balances,
  // and mixing bases fabricates differences (the PayPal lesson, session 222).
  const anchors = (statements || []).filter(s => s.balance_basis === 'principal_only' && s.principal_balance != null)
  const skippedForBasis = (statements || []).filter(s => s.balance_basis !== 'principal_only').map(s => ({ date: s.statement_date, basis: s.balance_basis || 'unknown' }))

  // Known lender amounts — the "fingerprint" set an unexplained gap is tested
  // against. All read from lender-derived data, never invented.
  const knownAmounts: Array<{ amount: number, what: string }> = []
  if (loan.scheduled_monthly_payment) knownAmounts.push({ amount: Number(loan.scheduled_monthly_payment), what: 'the scheduled monthly payment' })
  for (const sp of splits || []) {
    if (sp.total_amount != null) knownAmounts.push({ amount: Number(sp.total_amount), what: `the full ${sp.period_label} payment` })
    if (sp.principal_amount != null) knownAmounts.push({ amount: Number(sp.principal_amount), what: `the ${sp.period_label} principal portion` })
    if (sp.interest_amount != null) knownAmounts.push({ amount: Number(sp.interest_amount), what: `the ${sp.period_label} interest portion` })
  }
  const matchKnown = (gap: number) => knownAmounts.find(k => Math.abs(Math.abs(gap) - k.amount) < TOL) || null

  if (anchors.length < 2) {
    return new Response(JSON.stringify({
      ok: true, mode: 'analyze', verdict: 'not_enough_history',
      loan: { id: loan.id, name: loan.xero_account_name, code },
      headline,
      anchors_on_file: anchors.length, skipped_for_basis: skippedForBasis,
      narrative: `The difference engine needs at least two lender statements with a confirmed principal balance to walk the two histories side by side — this loan has ${anchors.length}. Upload more of the lender's statements and run this again.`,
      proposed_action: { kind: 'upload_earlier_statement', loan_account_id: loan.id },
    }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  // Window = the span the anchors cover, capped at 18 months of pull (the
  // month-sliced fetch's own safety limit). If the history is wider, walk the
  // most recent 18 months and say exactly what was left out.
  let usable = anchors
  let truncated: string | null = null
  const monthsSpanned = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) + 1
  while (usable.length > 2 && monthsSpanned(usable[0].statement_date, usable[usable.length - 1].statement_date) > 18) {
    truncated = usable[0].statement_date
    usable = usable.slice(1)
  }

  const { accessToken, tenantId } = await getXeroAuth()
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json' }
  const acctMap = await fetchAccountsMap(headers)

  const winFrom = usable[0].statement_date
  const winTo = usable[usable.length - 1].statement_date
  let entries: any[]
  try {
    entries = (await pullWindow(winFrom, winTo, headers, loan.xero_bank_account_id ?? null)).filter(r => isLive(r) && r.lines.some((l: any) => String(l.c) === String(code)))
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  entries.sort((a, b) => a.date.localeCompare(b.date))

  // ── The walk: between each pair of consecutive statements, does Xero's net
  // movement on the loan account equal the lender's own balance change? ──
  const periods: any[] = []
  for (let i = 1; i < usable.length; i++) {
    const A = usable[i - 1], B = usable[i]
    const lenderDelta = r2(Number(B.principal_balance) - Number(A.principal_balance))
    const inWin = entries.filter(r => r.date > A.statement_date && r.date <= B.statement_date)
    const xeroDelta = r2(inWin.reduce((s, r) => s + effect(r, code), 0))
    const diff = r2(xeroDelta - lenderDelta)
    const divergent = Math.abs(diff) >= TOL
    const period: any = {
      from: A.statement_date, to: B.statement_date,
      lender_delta: lenderDelta, xero_delta: xeroDelta, diff,
      verdict: divergent ? 'divergent' : 'clean',
      entry_count: inWin.length,
    }
    if (divergent) {
      period.entries = inWin.slice(0, 12).map(r => entryView(r, code, acctMap))
      // Does one single entry explain the whole gap? (Extra/duplicate entry.)
      const solo = inWin.find(r => Math.abs(r2(effect(r, code)) - diff) < TOL)
      if (solo) {
        const twin = inWin.find(r => r !== solo && r.srcType === solo.srcType && Math.abs((r.total ?? NaN) - (solo.total ?? NaN)) < TOL)
        period.culprit = { kind: twin ? 'duplicate_suspected' : 'extra_entry', entry: entryView(solo, code, acctMap), twin: twin ? entryView(twin, code, acctMap) : null }
      } else {
        const known = matchKnown(diff)
        if (known) period.culprit = { kind: diff > 0 ? 'missing_reduction' : 'excess_reduction', matches: known.what, amount: Math.abs(diff) }
        else period.culprit = { kind: 'unexplained' }
      }
    }
    periods.push(period)
  }

  const totalPeriodDiff = r2(periods.reduce((s, p) => s + p.diff, 0))
  const lastClean = (() => { let d = usable[0].statement_date; for (const p of periods) { if (p.verdict !== 'clean') break; d = p.to } return d })()
  const residual = headline ? r2(headline.difference - totalPeriodDiff) : null

  // ── Fingerprint hunt: when a gap equals a known lender amount to the cent,
  // search ALL of Xero for live transactions of exactly that amount and show
  // where each one's money actually went. This is how "one payment's worth"
  // stops being a coincidence and becomes a named transaction. ──
  let hunt: any = null
  const huntGap = residual != null && Math.abs(residual) >= TOL ? residual
    : (periods.find(p => p.culprit?.kind === 'missing_reduction' || p.culprit?.kind === 'unexplained')?.diff ?? null)
  const huntKnown = huntGap != null ? matchKnown(huntGap) : null
  if (huntKnown) {
    try {
      const w = encodeURIComponent(`Total == ${huntKnown.amount.toFixed(2)}`)
      const raw = await fetchPaged(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${w}&order=Date`, headers, 'BankTransactions', 4)
      const all = raw.map(normBT)
      hunt = {
        amount: huntKnown.amount, equals: huntKnown.what,
        matches: all.slice(0, 40).map(r => ({
          id: r.srcId, date: r.date, type: r.type, status: r.status, reconciled: r.reconciled,
          ref: r.ref, contact: r.contact,
          touches_this_loan: r.lines.some((l: any) => String(l.c) === String(code)),
          coded_to: Array.from(new Set(r.lines.map((l: any) => `${l.c} — ${acctMap[l.c] ?? '?'}`))),
          live: isLive(r),
        })),
        live_on_this_loan: all.filter(r => isLive(r) && r.lines.some((l: any) => String(l.c) === String(code))).length,
        live_elsewhere: all.filter(r => isLive(r) && !r.lines.some((l: any) => String(l.c) === String(code))).length,
      }
    } catch { hunt = { amount: huntKnown.amount, equals: huntKnown.what, error: 'Xero amount search failed — the rest of the analysis stands.' } }
  }

  // ── Proposal: ONLY the mechanically safe shape — a divergent period whose
  // gap equals that period's interest portion to the cent, where the payment
  // sits in Xero as a single un-split lump the CPA has not touched. That is an
  // allocation error between the loan account and Interest Expense, and the
  // correcting journal is fully determined by lender data. Everything else is
  // an exception for a human. ──
  let proposal: any = null
  let cpaException: any = null
  for (const p of periods) {
    if (p.verdict !== 'divergent' || proposal) continue
    const sp = (splits || []).find(s => s.interest_amount != null && Math.abs(Math.abs(p.diff) - Number(s.interest_amount)) < TOL
      && s.period_label >= p.from.slice(0, 7) && s.period_label <= p.to.slice(0, 7))
    if (!sp) continue
    const inWin = entries.filter(r => r.date > p.from && r.date <= p.to && r.srcType === 'BankTransaction')
    const lumps = inWin.filter(r => sp.total_amount != null && Math.abs((r.total ?? NaN) - Number(sp.total_amount)) < TOL)
    // A span can hold several identical fixed payments — the culprit is the one
    // in the split's own month, not whichever came first (QA scenario C).
    const lump = lumps.find(r => r.date.slice(0, 7) === sp.period_label) || lumps[0]
    if (!lump) continue
    if (alreadyWorked(lump)) {
      cpaException = {
        period: { from: p.from, to: p.to }, split_period: sp.period_label,
        entry: entryView(lump, code, acctMap),
        note: `The ${money(Math.abs(p.diff))} gap in this span traces to a payment your bookkeeper has already split in Xero. Per your rule, nothing touches her work — this stays flagged for her to look at.`,
      }
      continue
    }
    const amount = Number(sp.interest_amount)
    // p.diff < 0 → Xero below lender → interest was never carved out of the
    // loan account → the standard reallocation (debit 800, credit loan).
    // p.diff > 0 → the mirror image.
    const direction = p.diff < 0 ? 'interest_out_of_loan' : 'interest_back_to_loan'
    const lines = direction === 'interest_out_of_loan'
      ? [
        { LineAmount: amount, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, Description: 'Interest', TaxType: 'NONE' },
        { LineAmount: -amount, AccountCode: code, Description: `${loan.xero_account_name} principal correction`, TaxType: 'NONE' },
      ]
      : [
        { LineAmount: -amount, AccountCode: INTEREST_EXPENSE_ACCOUNT_CODE, Description: 'Interest correction', TaxType: 'NONE' },
        { LineAmount: amount, AccountCode: code, Description: `${loan.xero_account_name} principal correction`, TaxType: 'NONE' },
      ]
    proposal = {
      kind: 'interest_reallocation_journal',
      period: sp.period_label, span: { from: p.from, to: p.to },
      amount, direction,
      based_on: `The lender's statements say this span's balance should move ${money(Math.abs(p.lender_delta))}; Xero moved ${money(Math.abs(p.xero_delta))}. The ${money(Math.abs(p.diff))} gap equals the ${sp.period_label} interest portion to the cent, and the payment sits in Xero as a single un-split line.`,
      journal: {
        Narration: `${loan.xero_account_name} — balance correction, ${sp.period_label}`,
        Date: lump.date, Status: 'POSTED',
        JournalLines: lines.map(l => ({ ...l, AccountName: acctMap[l.AccountCode] ?? null })),
      },
      token: proposalToken(loan.id, sp.period_label, amount, direction),
    }
  }

  // ── The story, in plain language ──
  const divergentPeriods = periods.filter(p => p.verdict === 'divergent')
  const bits: string[] = []
  bits.push(`We walked ${periods.length} statement span${periods.length === 1 ? '' : 's'} (${winFrom} → ${winTo}), comparing the lender's own balances against every live Xero entry on ${loan.xero_account_name}.`)
  if (!divergentPeriods.length) bits.push(`Every span ties to the cent — within this window, Xero and the lender agree completely.`)
  else bits.push(`The histories agree until ${lastClean}, then split apart: ${divergentPeriods.map(p => `${p.from} → ${p.to} is off by ${money(Math.abs(p.diff))}`).join('; ')}.`)
  if (residual != null && Math.abs(residual) >= TOL) {
    const k = matchKnown(residual)
    bits.push(`${money(Math.abs(residual))} of the headline difference is OLDER than the earliest reliable statement on file (${winFrom}) — the walk can't see before that date.${k ? ` That amount equals ${k.what} to the cent, which strongly suggests exactly one payment is recorded differently in Xero than the lender applied it, sometime before ${winFrom}.` : ''} ${truncated ? `(History before ${truncated} was also outside this walk's 18-month window.) ` : ''}Uploading earlier lender statements would let the walk pin down the exact month.`)
  }
  if (hunt && !hunt.error) bits.push(`Amount search: Xero holds ${hunt.live_on_this_loan + hunt.live_elsewhere} live transaction${(hunt.live_on_this_loan + hunt.live_elsewhere) === 1 ? '' : 's'} of exactly ${money(hunt.amount)} — ${hunt.live_on_this_loan} coded to this loan, ${hunt.live_elsewhere} coded elsewhere. The list below shows where each one's money went.`)
  if (proposal) bits.push(`One span has a mechanically safe fix: the gap equals the ${proposal.period} interest portion exactly, so the correcting journal below closes it using only the lender's own figures. Nothing posts until you approve.`)
  if (cpaException) bits.push(cpaException.note)
  if (!proposal && divergentPeriods.length && !cpaException) bits.push(`No automatic fix is safe here — the evidence above names the exact span and entries, which is what your CPA needs to correct it in Xero.`)

  const analysis = {
    ok: true, mode: 'analyze' as string,
    loan: { id: loan.id, name: loan.xero_account_name, code },
    headline,
    window: { from: winFrom, to: winTo, anchors_used: usable.length, truncated_before: truncated, skipped_for_basis: skippedForBasis,
      read_via: loan.xero_bank_account_id ? 'bank transactions scoped to this loan\'s own bank account, plus every manual journal in the window' : 'org-wide month-sliced pull' },
    periods, agree_until: lastClean,
    total_period_diff: totalPeriodDiff, residual_before_window: residual,
    fingerprint_hunt: hunt,
    proposal, cpa_exception: cpaException,
    can_post: !!proposal && ['admin', 'manager'].includes(role),
    narrative: bits.join(' '),
  }

  if (!post_fix) {
    return new Response(JSON.stringify(analysis, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  // ── post_fix: the human approved the proposal they saw. Re-verified above by
  // re-running the entire analysis on this same request; refuse on any drift. ──
  if (!proposal) {
    return new Response(JSON.stringify({ error: 'Re-analysis found no safe fix to post — the books may have changed since you looked. Review the fresh analysis.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  if (proposal.token !== proposal_token) {
    return new Response(JSON.stringify({ error: 'The proposal changed since you reviewed it — approve the current one instead.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ManualJournals: [{ ...proposal.journal, JournalLines: proposal.journal.JournalLines.map((l: any) => ({ LineAmount: l.LineAmount, AccountCode: l.AccountCode, Description: l.Description, TaxType: l.TaxType })) }] }),
  })
  const postJson = await postRes.json().catch(() => null)
  if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
    return new Response(JSON.stringify({ error: 'Xero journal post failed', status: postRes.status, details: postJson }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const journal = postJson.ManualJournals?.[0]
  return new Response(JSON.stringify({
    ok: true, mode: 'post_fix',
    posted_journal: { id: journal?.ManualJournalID, narration: proposal.journal.Narration, date: proposal.journal.Date, lines: proposal.journal.JournalLines },
    posted_by: posted_by || null,
    note: 'Correction posted. Run a reconciliation check to confirm the loan now ties — the red card clears itself once the check passes.',
  }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    return await handle(req)
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
