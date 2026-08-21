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
//
// v4 (session 226, 2026-08-21): CROSS-LOAN MISALLOCATION HUNT. David found the
// real cause of 4140's biggest gap himself — a $5,000 payment coded to the
// WRONG Ford loan account (E4-9744 instead of 4140) — and asked that the tool
// surface exactly this kind of candidate: "I noticed a $5,000 payment to X
// loan on this day. Could this have been a mistake?" The mechanics: every
// loan's payments leave the same checking account, so the window pull ALREADY
// contains every sibling loan's entries — they were simply filtered out before
// the walk. v4 keeps the unfiltered pull and, for each divergent span, lists
// live entries coded to OTHER loan accounts inside that span, scored by how
// well each explains the gap: equals it exactly; equals it once a known lender
// amount (e.g. the span's un-split interest portion) is set aside — the exact
// 4140 shape, $5,000 = $4,889.97 gap + $110.03 interest; or merely sits inside
// the span (worth a look). The mirror case is covered too: when Xero moved
// MORE than the lender (excess_reduction), this loan's own matching-size
// payments are flagged as possibly belonging to a different loan. Product-
// managed stages (Reference WR-STAGE …) are excluded — they are never
// mistakes. Pure read-side: candidates are QUESTIONS for the bookkeeper, never
// proposals; the CPA recodes the transaction in Xero, re-runs the analysis,
// and the span ties or shrinks.
//
// v6 (session 226, same evening): CONCLUSIONS FIRST. David, on seeing v5's
// live output ("The exact opposite of abstraction… The system needs to be
// smart enough to say 'I think I know what may have happened. Either X or Z.'
// 3-4 bullet points MAX"): two structural changes. (1) OFFSETTING-PAIR
// detection — adjacent divergent spans whose diffs cancel (exactly, or to a
// known lender amount) are a payment straddling a statement cutoff: timing,
// not error. They collapse to one sentence and get no candidates, no entry
// dump, and never a correction proposal. On the 4140 run this alone removed
// 8 of 11 red spans. (2) A `conclusions` array (max 4 bullets): the timing
// sentence, one confident hypothesis per remaining real span ("either X or
// Z" when two strong candidates exist), and the pre-window residual. The
// client renders ONLY the bullets up front; the span table, entries, and
// candidate cards live behind a "show the full evidence" toggle.
//
// v7 (session 226, third pass — David: "Keep whittling down the text to the
// absolute minimum. Where things go off the rails is everything past those 2
// sections. Remove it entirely."): the OUTPUT is the bullets plus the span
// table, full stop. Per-span entry dumps are no longer emitted at all, and
// the client renders no candidate cards and no amount-hunt list — candidates
// still power the hypothesis bullets internally, they just never appear as
// their own wall of cards. The safe-fix proposal and the CPA exception
// remain (they are actions, not evidence).

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

// v4: the "could this have been a mistake?" list for one divergent span.
// Pure classification over data already pulled — no Xero calls, no writes.
// Candidates are QUESTIONS for the bookkeeper, deliberately not proposals.
function crossLoanCandidatesFor(
  p: any,
  siblingPool: any[],
  ownEntries: any[],
  otherLoanByCode: Map<string, any>,
  matchKnown: (gap: number) => { amount: number, what: string } | null,
  acctMap: Record<string, string>,
  loanName: string,
  loanLender: string | null,
): any[] {
  const gap = Math.abs(p.diff)
  const out: any[] = []
  const rank: Record<string, number> = { explains_exactly: 0, explains_with_known: 1, in_span: 2 }

  if (p.diff > 0) {
    // Xero moved LESS than the lender: a reduction the lender saw is missing
    // here — it may be coded to a different loan's account.
    for (const r of siblingPool) {
      if (!(r.date > p.from && r.date <= p.to)) continue
      const otherLines = r.lines.filter((l: any) => otherLoanByCode.has(String(l.c)))
      if (!otherLines.length) continue
      const la = otherLoanByCode.get(String(otherLines[0].c))
      const amt = r.srcType === 'BankTransaction'
        ? Math.abs(Number(r.total || 0))
        : r2(Math.abs(otherLines.reduce((s: number, l: any) => s + Number(l.a || 0), 0)))
      if (amt < TOL) continue
      const residue = r2(Math.abs(amt - gap))
      const known = residue < TOL ? null : matchKnown(residue)
      const confidence = residue < TOL ? 'explains_exactly' : (known ? 'explains_with_known' : 'in_span')
      // v4 live-run lesson (4140): ranking inside the "in span" tier is what
      // decides whether the real mistake survives the 5-candidate cap. Two
      // strong signals, both from loan_accounts data, not guesses:
      //  * same_lender — a payment coded to a SIBLING loan of the SAME lender
      //    is exactly how a misallocation happens (two Ford loans, one wrong
      //    click). These outrank everything else in the tier.
      //  * routine_payment — an amount equal to the sibling loan's own
      //    scheduled monthly payment is almost certainly where it belongs;
      //    those sink to the bottom instead of crowding the list.
      // Closeness to the gap breaks remaining ties, then date.
      const sameLender = !!(loanLender && la?.lender && la.lender === loanLender)
      const routine = la?.scheduled_monthly_payment != null && Math.abs(amt - Number(la.scheduled_monthly_payment)) < 1.00
      const closeness = Math.abs(amt - gap) / Math.max(gap, amt, 1)
      const what = r.srcType === 'BankTransaction' ? 'payment' : 'journal'
      const target = la?.xero_account_name || la?.lender || `account ${otherLines[0].c}`
      const question = confidence === 'explains_exactly'
        ? `A ${money(amt)} ${what} on ${r.date} is coded to ${target} — and it equals this span's gap exactly. Could it have been meant for ${loanName}? If so, recode it in Xero and run this again: this span should tie.`
        : confidence === 'explains_with_known'
          ? `A ${money(amt)} ${what} on ${r.date} is coded to ${target}. It explains this span's gap once ${known!.what} (${money(residue)}) is set aside. Could it have been meant for ${loanName}? If so, recode it in Xero and run this again — this span should shrink to ${money(residue)} or tie.`
          : sameLender
            ? `A ${money(amt)} ${what} on ${r.date} went to the same lender but is coded to ${target} — two loans from one lender is exactly where a payment lands on the wrong one. Could it have been meant for ${loanName}? If so, recode it in Xero and run this again.`
            : `A ${money(amt)} ${what} on ${r.date} to ${target} sits inside this divergent span — worth confirming it went to the right loan.`
      out.push({
        direction: 'maybe_belongs_here', confidence,
        src_type: r.srcType, id: r.srcId, date: r.date, amount: amt,
        contact: r.contact || null, ref: r.ref || null, narration: r.narration || null,
        reconciled: r.reconciled ?? null, already_worked: alreadyWorked(r),
        same_lender: sameLender, routine_payment: routine, _closeness: closeness,
        coded_to: { account_code: otherLines[0].c ?? null, account_name: acctMap[otherLines[0].c] ?? null, loan_name: la?.xero_account_name || la?.lender || null },
        explains_after: known ? { what: known.what, amount: r2(residue) } : null,
        question,
      })
    }
  } else {
    // Xero moved MORE than the lender: one of THIS loan's entries may belong to
    // a different loan. Only strong matches are listed — naming every ordinary
    // payment on the loan's own account would be noise, not help.
    for (const r of ownEntries) {
      if (!(r.date > p.from && r.date <= p.to)) continue
      if (r.srcType !== 'BankTransaction') continue
      if (r.ref && String(r.ref).startsWith('WR-STAGE')) continue
      const amt = Math.abs(Number(r.total || 0))
      if (amt < TOL) continue
      const residue = r2(Math.abs(amt - gap))
      const known = residue < TOL ? null : matchKnown(residue)
      if (residue >= TOL && !known) continue
      const confidence = residue < TOL ? 'explains_exactly' : 'explains_with_known'
      out.push({
        direction: 'maybe_belongs_elsewhere', confidence,
        src_type: r.srcType, id: r.srcId, date: r.date, amount: amt,
        contact: r.contact || null, ref: r.ref || null, narration: null,
        reconciled: r.reconciled ?? null, already_worked: alreadyWorked(r),
        coded_to: null,
        explains_after: known ? { what: known.what, amount: r2(residue) } : null,
        question: `The ${money(amt)} payment on ${r.date}${r.contact ? ` to ${r.contact}` : ''} is coded to this loan, but this span shows Xero reducing the loan by MORE than the lender saw${residue < TOL ? ' — by exactly this amount' : ''}. Could this payment belong to a different loan? Check the payee and the lender account it was actually paid against.`,
      })
    }
  }
  out.sort((a, b) =>
    (rank[a.confidence] - rank[b.confidence])
    || ((a.same_lender ? 0 : 1) - (b.same_lender ? 0 : 1))
    || ((a.routine_payment ? 1 : 0) - (b.routine_payment ? 1 : 0))
    || ((a._closeness ?? 1) - (b._closeness ?? 1))
    || a.date.localeCompare(b.date))
  return out.slice(0, 5).map(({ _closeness, ...c }) => c)
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

  // v4: every other loan's account code, for the cross-loan misallocation hunt.
  const { data: allLoans } = await supa.from('loan_accounts').select('id, xero_account_code, xero_account_name, lender, lender_account_number, status, scheduled_monthly_payment')
  const otherLoanByCode = new Map<string, any>()
  for (const la of allLoans || []) {
    if (la.id !== loan.id && la.xero_account_code) otherLoanByCode.set(String(la.xero_account_code), la)
  }
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
  // v4: keep the WHOLE pull. `entries` (this loan's own history) drives the walk
  // exactly as before; `siblingPool` (live entries coded to OTHER loan accounts,
  // excluding product-managed WR-STAGE transactions) feeds the misallocation
  // hunt. Every loan pays from the same checking account, so no extra Xero
  // calls are needed — the candidates were in the pull all along.
  let entries: any[]
  let siblingPool: any[]
  try {
    const pulled = await pullWindow(winFrom, winTo, headers, loan.xero_bank_account_id ?? null)
    entries = pulled.filter(r => isLive(r) && r.lines.some((l: any) => String(l.c) === String(code)))
    siblingPool = pulled.filter(r => isLive(r)
      && !r.lines.some((l: any) => String(l.c) === String(code))
      && r.lines.some((l: any) => otherLoanByCode.has(String(l.c)))
      && !(r.ref && String(r.ref).startsWith('WR-STAGE')))
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  entries.sort((a, b) => a.date.localeCompare(b.date))
  siblingPool.sort((a, b) => a.date.localeCompare(b.date))

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

  // ── v6: OFFSETTING-PAIR DETECTION — abstraction before evidence (David,
  // session 226: "The system needs to be smart enough to say 'I think I know
  // what may have happened.' 3-4 bullet points MAX."). The 4140 run that
  // prompted this had ELEVEN red spans, of which EIGHT were four offsetting
  // pairs: +$1,180.32 then −$1,180.32, and so on — a payment dated a day or
  // two after the statement cutoff lands in the NEXT span, so one span reads
  // short and the next reads long by the same amount. That is timing, not an
  // error: the pair contributes $0.00 to the headline difference and needs no
  // fix. Pairs whose sum is not zero but equals a known lender amount (e.g.
  // one period's interest portion) collapse the same way, with the residue
  // named. Paired spans get NO candidate hunt, NO entry dump, and NO
  // correction proposal — they get one calm sentence. ──
  for (let i = 0; i < periods.length; i++) {
    const a = periods[i]
    if (a.verdict !== 'divergent' || a.timing_pair) continue
    const b = periods[i + 1]
    if (!b || b.verdict !== 'divergent' || b.timing_pair) continue
    if (a.diff * b.diff >= 0) continue // must offset, not compound
    const net = r2(a.diff + b.diff)
    const pure = Math.abs(net) < TOL
    const known = pure ? null : matchKnown(net)
    // The residue must be small relative to the offsets themselves — a $5,000
    // gap "paired" with a $500 gap is not a timing straddle.
    const residueOk = known && Math.abs(net) < Math.min(Math.abs(a.diff), Math.abs(b.diff)) / 2
    if (!pure && !residueOk) continue
    // Best evidence: the straddling entry — dated within a week after the
    // boundary, of the offset amount. Named when found; the pair collapses
    // either way (the arithmetic alone is conclusive about the net effect).
    const bLimit = (() => { const d = new Date(b.from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10) })()
    const straddler = entries.find(r => r.date > b.from && r.date <= bLimit && Math.abs(Math.abs(r2(effect(r, code))) - Math.abs(a.diff)) < TOL)
    const pairInfo = {
      net, pure,
      residue: known ? { amount: net, what: known.what } : null,
      straddler: straddler ? { date: straddler.date, amount: r2(Math.abs(effect(straddler, code))), contact: straddler.contact || null } : null,
    }
    a.timing_pair = { role: 'first', with: `${b.from} → ${b.to}`, ...pairInfo }
    b.timing_pair = { role: 'second', with: `${a.from} → ${a.to}`, ...pairInfo }
  }

  // The misallocation hunt only for spans that remain REAL after pairing.
  // v7: no per-span entry dumps are emitted anymore — the candidates feed the
  // hypothesis bullets and nothing else renders.
  for (const period of periods) {
    if (period.verdict !== 'divergent' || period.timing_pair) continue
    period.cross_loan_candidates = crossLoanCandidatesFor(period, siblingPool, entries, otherLoanByCode, matchKnown, acctMap, loan.xero_account_name || 'this loan', loan.lender ?? null)
  }

  const totalPeriodDiff = r2(periods.reduce((s, p) => s + p.diff, 0))
  const lastClean = (() => { let d = usable[0].statement_date; for (const p of periods) { if (p.verdict !== 'clean') break; d = p.to } return d })()
  const residual = headline ? r2(headline.difference - totalPeriodDiff) : null

  // ── Fingerprint hunt: when a gap equals a known lender amount to the cent,
  // search ALL of Xero for live transactions of exactly that amount and show
  // where each one's money actually went. This is how "one payment's worth"
  // stops being a coincidence and becomes a named transaction. ──
  let hunt: any = null
  // v6: paired (timing) spans are explained — they never drive the hunt.
  const huntGap = residual != null && Math.abs(residual) >= TOL ? residual
    : (periods.find(p => !p.timing_pair && (p.culprit?.kind === 'missing_reduction' || p.culprit?.kind === 'unexplained'))?.diff ?? null)
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
    // v6: a paired span is timing, not an allocation error — proposing a
    // correction journal for it would CREATE a discrepancy, not close one.
    if (p.timing_pair) continue
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

  // ── v6: CONCLUSIONS — the whole story in 3-4 bullets, most confident first.
  // David's brief, verbatim: the system should say "I think I know what may
  // have happened. Either X or Z." Everything below the bullets is collapsed
  // evidence, not the message. ──
  const divergentPeriods = periods.filter(p => p.verdict === 'divergent')
  const realDivergent = divergentPeriods.filter(p => !p.timing_pair)
  const pairFirsts = periods.filter(p => p.timing_pair?.role === 'first')
  const conclusions: string[] = []

  if (pairFirsts.length) {
    const purePairs = pairFirsts.filter(p => p.timing_pair.pure)
    const resPairs = pairFirsts.filter(p => !p.timing_pair.pure)
    const straddleEx = pairFirsts.find(p => p.timing_pair.straddler)?.timing_pair.straddler
    let s = `${pairFirsts.length * 2} of ${divergentPeriods.length} flagged spans are timing, not errors — a payment dated just after the cutoff lands in the next span`
    if (straddleEx) s += ` (e.g. ${money(straddleEx.amount)} on ${straddleEx.date})`
    s += purePairs.length === pairFirsts.length
      ? `. They cancel to $0.00 — nothing to fix.`
      : `. They cancel${resPairs.length ? ` to within ${resPairs.map(p => `${money(p.timing_pair.net)}${p.timing_pair.residue ? ` (${p.timing_pair.residue.what})` : ''}`).join(' and ')}` : ''} — nothing to fix.`
    conclusions.push(s)
  }

  // One hypothesis bullet per REAL span (at most two spelled out). v8: half
  // the words — David: "Reduce by 50%."
  const candDesc = (c: any) => c.direction === 'maybe_belongs_elsewhere'
    ? `the ${money(c.amount)} payment (${c.date}) coded here likely belongs to another loan`
    : `the ${money(c.amount)} ${c.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${c.date}) on ${c.coded_to?.loan_name || 'another loan'}${c.same_lender ? ' — same lender —' : ''} likely belongs here`
  const hypFor = (p: any) => {
    const gap = money(Math.abs(p.diff))
    const cands = p.cross_loan_candidates || []
    const c1 = cands[0]
    if (p.culprit?.kind === 'duplicate_suspected' && p.culprit.entry) {
      return `${p.from} → ${p.to} is off by ${gap} — likely a duplicate: the ${money(Math.abs(p.culprit.entry.effect_on_loan))} entry on ${p.culprit.entry.date}. Remove the copy and re-run.`
    }
    if (!c1) return `${p.from} → ${p.to} is off by ${gap} — no clear candidate; one for your CPA (dates in the table).`
    const c2 = cands[1]
    const secondStrong = c2 && (c2.confidence !== 'in_span' || (c2.same_lender && c1.same_lender))
    if (secondStrong) {
      return `${p.from} → ${p.to} is off by ${gap} — either ${candDesc(c1)}, or ${candDesc(c2)}. Fix the right one and re-run.`
    }
    let s = `${p.from} → ${p.to} is off by ${gap} — ${candDesc(c1)}. Recode it and re-run`
    if (c1.explains_after) s += `; the span should close to ~${money(c1.explains_after.amount)}`
    else if (c1.confidence === 'explains_exactly') s += `; the span should tie`
    s += `.`
    return s
  }
  for (const p of realDivergent.slice(0, 2)) conclusions.push(hypFor(p))
  if (realDivergent.length > 2) {
    const rest = realDivergent.slice(2)
    conclusions.push(`${rest.length} more span${rest.length === 1 ? '' : 's'} (${rest.map(p => `${p.from} → ${p.to}, ${money(Math.abs(p.diff))}`).join('; ')}) — fix the above, then re-run.`)
  }

  if (residual != null && Math.abs(residual) >= TOL && conclusions.length < 4) {
    const k = matchKnown(residual)
    conclusions.push(`${money(Math.abs(residual))} predates the earliest statement on file (${winFrom})${k ? ` — equals ${k.what}` : ''}; upload earlier statements to pin it down.`)
  }
  if (!divergentPeriods.length) conclusions.push(`Every span ties to the cent — Xero and the lender agree completely (${winFrom} → ${winTo}).`)
  const finalConclusions = conclusions.slice(0, 4)

  // Narrative for API consumers = intro + the same bullets; the client renders
  // the bullets. The old exhaustive span-listing paragraph is gone on purpose.
  const bits: string[] = []
  bits.push(`Walked ${periods.length} statement span${periods.length === 1 ? '' : 's'} (${winFrom} → ${winTo}) on ${loan.xero_account_name}.`)
  bits.push(...finalConclusions)
  if (proposal) bits.push(`One span has a mechanically safe fix: the gap equals the ${proposal.period} interest portion exactly — the correcting journal below closes it using only the lender's own figures. Nothing posts until you approve.`)
  if (cpaException) bits.push(cpaException.note)

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
    conclusions: finalConclusions,
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
