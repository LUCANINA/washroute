import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'
import { effectiveCloseDate, postingDateFor, isProtectedDate } from '../_shared/close-date.ts'
import { diagnoseWorkedEntry } from './diagnose-exception.ts'

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
// mistakes. Pure read-side: candidates are QUESTIONS for the accountant, never
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
//
// v10 (session 228): LENDER-LEVEL ANALYSIS. Three Ford loans each carried a
// red card; each per-loan run pointed at candidate entries on its SIBLINGS —
// two of them claiming the very same journals. New mode
// ({ lender_analysis: true, lender }) walks EVERY flagged loan of one lender
// against ONE shared Xero pull, then solves them jointly: an entry explains
// at most one gap, a recode must shrink the gap on BOTH walks, and the
// output is one ≤5-bullet story + one ordered roadmap + a plain-text
// accountant handoff + the simulated end state each loan should show after a
// single re-run. Read-only; safe-fix approvals reuse the per-loan post_fix
// path and tokens (no new write path). The per-loan analysis is unchanged
// (analyzeWalk is the same function both modes call).
//
// v11 (session 229, same day — the first live run's lesson): HONESTY ABOUT
// DIRECTION. The live Ford run said "after the fixes: ~$8,103.41 above" with
// no explanation (David: "how is that a good thing? what am I missing?").
// Four fixes: (1) a loan whose number RISES because a wrong entry was
// masking an older gap now says exactly that — in the verdict, the expected
// labels, and the step copy; (2) a move with no concrete destination is an
// INVESTIGATE step, never a "recode" nobody can execute; (3) vetoed-but-
// promising moves (the leads the per-loan cards showed) surface as RULED OUT
// with the reason instead of silently vanishing; (4) when the gap predates
// the statements on file, the roadmap asks for the lender's full payment
// history per loan (one download beats sifting entries) — ingesting it
// auto-derives dense principal anchors (loan-ingest-amortization v15), which
// turns coarse statement spans into per-payment spans on the next run. Every
// solver decision is console.logged for live diagnosis (no DB writes).
//
// v12 (session 229, same night — David: "Feed me everything from the
// beginning, and I'll propose the manual adjustments. if you agree, click
// post. That should settle it."): CROSS-LOAN REALLOCATION PROPOSALS. In the
// strictest shape ONLY — the move closes BOTH loans' spans exactly
// (two-sided confirmed), exactly one candidate destination (an either/or
// tie stays a human call), entry untouched by the accountant — the lender
// mode now proposes a reallocation Manual Journal (debit the destination
// loan, credit the source; the original bank line is never edited, same law
// as the interest fix). Deterministic token; { post_crossloan: true,
// proposal_token } re-runs this entire analysis server-side and refuses on
// drift — which also makes a double-post self-defeating (after the journal
// lands, the re-analysis finds nothing to propose). Approving the journal
// and manually recoding the bank line are ALTERNATIVES; every rendering of
// the proposal says "do exactly one of the two."
//
// v13 (session 229, the first dense-anchor live run's lesson): LAG GRACE.
// Lender anchors are dated on the LENDER's posting date; the matching Xero
// bank line clears 1-4 days later. With sparse monthly statements the gap
// never mattered — boundaries sat far from payment dates. Dense payment-date
// anchors put a boundary exactly ON every payment date, so nearly every Xero
// entry landed one span late: the run manufactured offsetting spans in bulk
// (30 caught as timing; the misses became fake cross-loan recodes of loans'
// own routine payments, and the marquee 242→238 payoff match was blocked by
// ONE day). Every span's ENTRY window now extends LAG_GRACE_DAYS past its
// anchor dates, clamped so it never crosses the next anchor — valid lender-
// side because a lender balance only moves on payment dates. Same run also
// fixed: upload_history steps fired for histories already on file (gate is
// now genuine-missing-data only, never window truncation, never $0), and
// ruled_out named loans' own scheduled payments (suppressed as noise).
//
// v14 (same night, David's catch): the verdict said "Expect the numbers to
// RISE (to ~$9,668.09 combined)" when the combined figure ALREADY WAS
// $9,668.09 — because moves BETWEEN flagged loans can't change the combined
// total at all (one rises, one falls, the sum is invariant), and the template
// assumed any per-loan rise meant a combined rise. It also called $9,668 "the
// small number" unconditionally. The verdict now distinguishes: combined
// actually rising (one-sided moves) keeps the RISE copy; internal-only moves
// say the combined barely moves while naming which loans rise toward the gaps
// they were hiding and which come down; and the "deceptively small" framing
// only appears when the net really is small against the gross after-picture.
//
// v15 (same night): David — "Almost there. Abbreviate by 30%", now a standing
// project guideline: keep words at a minimum. Every lender-card template
// trimmed ~30% — same numbers, same structure, fewer words. Outcome lines are
// now "$X off → tied" instead of "goes from $X off to tied".

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
// session 234: `extra` carries the journal DATE. The date is now derived from
// the close date, which can move between the moment a human reads a proposal and
// the moment they approve it -- and a correction landing in a different month is
// a different correction. Folding it into the token makes that drift refuse to
// post, exactly like an amount change does.
function proposalToken(loanId: string, period: string, amount: number, direction: string, extra?: string): string {
  const s = `${loanId}|${period}|${amount.toFixed(2)}|${direction}${extra ? `|${extra}` : ''}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

// v4: the "could this have been a mistake?" list for one divergent span.
// Pure classification over data already pulled — no Xero calls, no writes.
// Candidates are QUESTIONS for the accountant, deliberately not proposals.
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
      if (!(r.date > (p.entry_from || p.from) && r.date <= (p.entry_to || p.to))) continue
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
      if (!(r.date > (p.entry_from || p.from) && r.date <= (p.entry_to || p.to))) continue
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

// v10: known lender amounts + the matcher, shared by the per-loan analysis and
// the lender-level analysis (which needs one per loan). Moved verbatim from the
// per-loan handler — same numbers, same tolerance.
function prepKnownAmounts(loan: any, splits: any[]) {
  // Known lender amounts — the "fingerprint" set an unexplained gap is tested
  // against. All read from lender-derived data, never invented.
  const knownAmounts: Array<{ amount: number, what: string }> = []
  if (loan.scheduled_monthly_payment) knownAmounts.push({ amount: Number(loan.scheduled_monthly_payment), what: 'the scheduled monthly payment' })
  for (const sp of splits) {
    if (sp.total_amount != null) knownAmounts.push({ amount: Number(sp.total_amount), what: `the full ${sp.period_label} payment` })
    if (sp.principal_amount != null) knownAmounts.push({ amount: Number(sp.principal_amount), what: `the ${sp.period_label} principal portion` })
    if (sp.interest_amount != null) knownAmounts.push({ amount: Number(sp.interest_amount), what: `the ${sp.period_label} interest portion` })
  }
  const matchKnown = (gap: number) => knownAmounts.find(k => Math.abs(Math.abs(gap) - k.amount) < TOL) || null
  return { knownAmounts, matchKnown }
}

// v10: hoisted from the per-loan handler so the lender-level analysis can trim
// each loan the same way. Verbatim logic: walk the most recent 18 months of
// anchors and record what was left out.
// v13: see the LAG GRACE header note. 5 days covers every observed Ford
// bank-posting lag (1-4 days) with margin; the per-boundary clamp keeps
// weekly-cadence loans (anchors 7 days apart) correct.
const LAG_GRACE_DAYS = 5
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const monthsSpanned = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) + 1
function trimAnchors(anchors: any[]): { usable: any[], truncated: string | null } {
  let usable = anchors
  let truncated: string | null = null
  while (usable.length > 2 && monthsSpanned(usable[0].statement_date, usable[usable.length - 1].statement_date) > 18) {
    truncated = usable[0].statement_date
    usable = usable.slice(1)
  }
  return { usable, truncated }
}

// ── v10 (session 228): analyzeWalk — the ENTIRE per-loan analysis (span walk,
// timing-pair detection, cross-loan candidate hunt, safe-fix proposal, CPA
// exception, conclusions) extracted into one shared function, because the
// lender-level analysis must run the exact same math on every sibling loan.
// The code inside was MOVED from the per-loan handler, not rewritten — per-loan
// behavior is unchanged. The fingerprint hunt stays in the per-loan handler
// (it makes its own Xero call; the lender mode's joint solver supersedes it).
function analyzeWalk(o: {
  loan: any, code: string, usable: any[], splits: any[], headline: any,
  entries: any[], siblingPool: any[], otherLoanByCode: Map<string, any>,
  matchKnown: (gap: number) => { amount: number, what: string } | null,
  acctMap: Record<string, string>, skippedForBasis: any[],
  // session 234: where a correction we propose is ALLOWED to land. Computed
  // once per request from the effective close date; see postingDateFor().
  postingDate: string, postingWhy: string, closeDate: string | null, today: string,
}) {
  const { loan, code, usable, splits, headline, entries, siblingPool, otherLoanByCode, matchKnown, acctMap, skippedForBasis } = o
  const { postingDate, postingWhy, closeDate, today } = o
  const winFrom = usable[0].statement_date
  const winTo = usable[usable.length - 1].statement_date

  // ── The walk: between each pair of consecutive statements, does Xero's net
  // movement on the loan account equal the lender's own balance change? ──
  // v13 LAG GRACE: each boundary's ENTRY window edge shifts right by up to
  // LAG_GRACE_DAYS (never past the next anchor's own date), so a bank line
  // that cleared days after the lender posted the payment stays in the span
  // the lender put it in. Lender deltas are untouched — a lender balance only
  // moves on payment dates, so the shifted edge reads the same balance.
  const entryBound = usable.map((s: any, i: number) => {
    const shifted = addDays(s.statement_date, LAG_GRACE_DAYS)
    const next = usable[i + 1]?.statement_date
    return next && shifted > next ? next : shifted
  })
  const periods: any[] = []
  for (let i = 1; i < usable.length; i++) {
    const A = usable[i - 1], B = usable[i]
    const lenderDelta = r2(Number(B.principal_balance) - Number(A.principal_balance))
    const inWin = entries.filter(r => r.date > entryBound[i - 1] && r.date <= entryBound[i])
    const xeroDelta = r2(inWin.reduce((s, r) => s + effect(r, code), 0))
    const diff = r2(xeroDelta - lenderDelta)
    const divergent = Math.abs(diff) >= TOL
    const period: any = {
      from: A.statement_date, to: B.statement_date,
      entry_from: entryBound[i - 1], entry_to: entryBound[i],
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
    const bLimit = addDays(b.entry_from || b.from, 7)
    const straddler = entries.find(r => r.date > (b.entry_from || b.from) && r.date <= bLimit && Math.abs(Math.abs(r2(effect(r, code))) - Math.abs(a.diff)) < TOL)
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

    // ── SESSION 236: FIND THE PAYMENT, NOT A ONE-MONTH GAP ──────────────────
    // The gate below this looks for a split whose interest equals the span's gap
    // to the cent, and everything — including the accountant-exception path —
    // hung off that. The first live 4140 run showed why it never fired: that
    // span's gap is $283.07, which is April $147.43 + May $135.64, a RUN of
    // months and not any single one. So the branch was never entered and the
    // cross-loan hunt filled the silence with a false lead (recode a sibling
    // loan's correctly-coded payment).
    //
    // `diagnoseWorkedEntry` already decomposes a run of months. It just has to be
    // ASKED. So this block locates an already-worked payment in the span by
    // matching it to its own split's TOTAL — no assumption about the gap's shape —
    // and lets the diagnosis decide whether it understands what it is looking at.
    if (!cpaException) {
      const spanEntries = entries.filter(r => r.date > (p.entry_from || p.from) && r.date <= (p.entry_to || p.to) && r.srcType === 'BankTransaction')
      for (const rec of spanEntries) {
        if (!alreadyWorked(rec)) continue
        const per = splits.filter(s => s.total_amount != null && Math.abs(Number(s.total_amount) - (rec.total ?? NaN)) < TOL)
        // Prefer an exact dated period (weekly loans), else the payment's month.
        const spx = per.find(s => String(s.period_label) === rec.date)
          || per.find(s => String(s.period_label).slice(0, 7) === rec.date.slice(0, 7))
        if (!spx) continue
        // Where did the journal that ALSO booked this month land? A correction
        // sits in the span its DATE puts it in, not the span of the period it
        // corrects — 4140's `12ef542c` carries June and is dated 2026-05-18.
        const ownJnlId = String(spx.xero_manual_journal_id || '').toLowerCase()
        const ownJournalInSpan = !!ownJnlId && entries.some(r => r.srcType === 'ManualJournal'
          && String(r.srcId || '').toLowerCase() === ownJnlId
          && r.date > (p.entry_from || p.from) && r.date <= (p.entry_to || p.to))
        // Session 236 cont.: corroborate an `already_in_xero` claim on a FOREIGN
        // month against Xero itself — is there a SECOND live transaction on this
        // loan that actually carves out that month's interest? E5-4751's 2026-04
        // is marked handled and has no such transaction anywhere; trusting the
        // marker proposed reversing $548.21 on a loan $266.42 above its lender.
        // Matching on the interest amount is safe here: within one loan the
        // monthly interest figures are distinct to the cent, and the candidate
        // must also touch this loan's own account code.
        const atSourceEvidence = (interest: number) => entries.some(r =>
          r !== rec && r.srcType === 'BankTransaction' && isLive(r)
          && r.lines.some((l: any) => String(l.c) === String(code))
          && r.lines.some((l: any) => String(l.c) === INTEREST_EXPENSE_ACCOUNT_CODE
            && Math.abs(Math.abs(Number(l.a || 0)) - interest) < TOL))
        const diagnosis = diagnoseWorkedEntry({
          lines: rec.lines, loanCode: code, interestCode: INTEREST_EXPENSE_ACCOUNT_CODE,
          splits, paymentPeriod: String(spx.period_label), gap: p.diff,
          postingDate, postingWhy, loanName: loan.xero_account_name || 'this loan',
          tol: TOL, ownJournalInSpan, atSourceEvidence,
        })
        if (!diagnosis) continue
        cpaException = {
          period: { from: p.from, to: p.to }, split_period: String(spx.period_label),
          entry: entryView(rec, code, acctMap),
          diagnosis,
          proposed_entry: diagnosis.entry ?? null,
          token: diagnosis.entry
            ? proposalToken(loan.id, `exception:${spx.period_label}`, diagnosis.entry.amount, diagnosis.entry.direction, diagnosis.entry.Date)
            : null,
          note: diagnosis.note,
        }
        // SESSION 236 cont.: this span is now EXPLAINED. Two consequences, and
        // missing either leaves the wrong answer on screen:
        //  * its cross-loan candidates are guesses about a gap we can now account
        //    for exactly -- on 4140 they named two sibling loans' own, correctly
        //    coded June payments, and recoding either would have broken them.
        //  * it must stop feeding `hypFor()`, which is what writes the headline
        //    bullets David actually reads. The first live re-run had the right
        //    entry attached to the wrong headline, because the diagnosis was
        //    added here and the conclusions were left alone.
        p.explained_by_exception = true
        p.cross_loan_candidates = []
        break
      }
    }
    // One span, one answer. If the block above diagnosed THIS span, do not also
    // let the single-month path raise a proposal for it — two corrections for one
    // gap is how a span gets fixed twice. (Session 231: put the guard where the
    // branches converge, not on one of them.)
    if (cpaException && cpaException.period && cpaException.period.from === p.from) continue

    const sp = splits.find(s => s.interest_amount != null && Math.abs(Math.abs(p.diff) - Number(s.interest_amount)) < TOL
      && s.period_label >= p.from.slice(0, 7) && s.period_label <= p.to.slice(0, 7))
    if (!sp) continue
    const inWin = entries.filter(r => r.date > (p.entry_from || p.from) && r.date <= (p.entry_to || p.to) && r.srcType === 'BankTransaction')
    const lumps = inWin.filter(r => sp.total_amount != null && Math.abs((r.total ?? NaN) - Number(sp.total_amount)) < TOL)
    // A span can hold several identical fixed payments — the culprit is the one
    // in the split's own month, not whichever came first (QA scenario C).
    const lump = lumps.find(r => r.date.slice(0, 7) === sp.period_label) || lumps[0]
    if (!lump) continue
    if (alreadyWorked(lump)) {
      // Session 236: the block at the top of this loop already diagnosed any
      // already-worked payment in this span, whatever the gap's shape. This is
      // now only the fallback for when it declined to say anything.
      if (cpaException) continue
      // ── session 234: DEFERENCE HAS TO CARRY A DIAGNOSIS ──────────────────
      // We still never touch her entry. But "she decides" with no working is
      // a flag, not an answer, and the 4140 case proved the engine already
      // holds everything needed to hand her the arithmetic: which months the
      // at-source split covers, which of them our own splits record as ALREADY
      // reallocated (by journal id, not by proximity), and the balanced entry
      // that reverses only the duplicated part -- dated into the first period
      // she can actually post into. diagnoseWorkedEntry() proposes nothing
      // unless the recorded journals AND the span's gap both agree.
      const diagnosis = diagnoseWorkedEntry({
        lines: lump.lines, loanCode: code, interestCode: INTEREST_EXPENSE_ACCOUNT_CODE,
        splits, paymentPeriod: sp.period_label, gap: p.diff,
        postingDate, postingWhy, loanName: loan.xero_account_name || 'this loan',
        tol: TOL,
      })
      cpaException = {
        period: { from: p.from, to: p.to }, split_period: sp.period_label,
        entry: entryView(lump, code, acctMap),
        diagnosis,
        proposed_entry: diagnosis?.entry ?? null,
        token: diagnosis?.entry
          ? proposalToken(loan.id, `exception:${sp.period_label}`, diagnosis.entry.amount, diagnosis.entry.direction, diagnosis.entry.Date)
          : null,
        note: diagnosis
          ? diagnosis.note
          : `The ${money(Math.abs(p.diff))} gap in this span traces to a payment your accountant has already split in Xero. Per your rule, nothing touches her work — this stays flagged for her to look at.`,
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
    // session 234: WHERE the correction lands. Until now this journal was dated
    // at the payment (`lump.date`). Session 233 nearly shipped exactly that -- a
    // 2026-06-17 recode -- into the middle of an active July close. A payment in
    // an OPEN month is still corrected at the payment, which is where an
    // accountant expects to find it; a payment inside a closed or closing month
    // moves to the first month she can actually post into.
    const protectedDate = isProtectedDate(lump.date, closeDate, today)
    const journalDate = protectedDate ? postingDate : lump.date
    proposal = {
      kind: 'interest_reallocation_journal',
      period: sp.period_label, span: { from: p.from, to: p.to },
      amount, direction,
      dated_into: journalDate,
      dated_because: protectedDate
        ? `the payment is dated ${lump.date}, and ${postingWhy} — so the correction lands at ${journalDate} instead`
        : `the ${lump.date} payment is in an open period, so the correction is dated at the payment`,
      based_on: `The lender's statements say this span's balance should move ${money(Math.abs(p.lender_delta))}; Xero moved ${money(Math.abs(p.xero_delta))}. The ${money(Math.abs(p.diff))} gap equals the ${sp.period_label} interest portion to the cent, and the payment sits in Xero as a single un-split line.`,
      journal: {
        Narration: `${loan.xero_account_name} — balance correction, ${sp.period_label}`,
        Date: journalDate, Status: 'POSTED',
        JournalLines: lines.map(l => ({ ...l, AccountName: acctMap[l.AccountCode] ?? null })),
      },
      token: proposalToken(loan.id, sp.period_label, amount, direction, journalDate),
    }
  }

  // ── v6: CONCLUSIONS — the whole story in 3-4 bullets, most confident first.
  // David's brief, verbatim: the system should say "I think I know what may
  // have happened. Either X or Z." Everything below the bullets is collapsed
  // evidence, not the message. ──
  const divergentPeriods = periods.filter(p => p.verdict === 'divergent')
  const realDivergent = divergentPeriods.filter(p => !p.timing_pair && !p.explained_by_exception)
  const pairFirsts = periods.filter(p => p.timing_pair?.role === 'first')
  const conclusions: string[] = []

  // The exception is the most confident statement the engine can make about a
  // span: every number in it is a recorded fact, not a candidate. It leads.
  if (cpaException?.diagnosis) {
    const dg = cpaException.diagnosis
    const sp0 = cpaException.period
    const booked = (dg.components || []).filter((c: any) => c.already_booked)
    let s = `${sp0.from} → ${sp0.to} is off by ${money(Math.abs(periods.find(p => p.from === sp0.from)?.diff ?? 0))} — your accountant's own split on the ${cpaException.entry?.date} payment carries `
    s += `${(dg.components || []).map((c: any) => c.period).join(' + ')} interest (${money(dg.at_source)}), `
    s += booked.length === (dg.components || []).length
      ? `and all ${booked.length} of those months were already booked. `
      : `of which ${money(dg.duplicated)} was already booked. `
    s += cpaException.proposed_entry
      ? `Approve the prepared ${money(cpaException.proposed_entry.amount)} correction below — nothing else to fix in this span.`
      : `Nothing is proposed: see the detail below.`
    conclusions.push(s)
  }

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
    // v9: statements that exist but were skipped for balance_basis are NOT missing --
    // telling the user to "upload earlier statements" they already uploaded (the 9744
    // $182 incident, session 226) sends them hunting for files that change nothing.
    // Name the real blocker instead.
    const skippedEarlier = skippedForBasis.filter(s => s.date < winFrom)
    const tail = skippedEarlier.length
      ? `${skippedEarlier.length} earlier statement${skippedEarlier.length === 1 ? ' is' : 's are'} on file but unusable (balance basis unmarked) — mark them principal-only to pin it down`
      : `upload earlier statements to pin it down`
    conclusions.push(`${money(Math.abs(residual))} predates the earliest usable statement (${winFrom})${k ? ` — equals ${k.what}` : ''}; ${tail}.`)
  }
  if (!divergentPeriods.length) conclusions.push(`Every span ties to the cent — Xero and the lender agree completely (${winFrom} → ${winTo}).`)
  const finalConclusions = conclusions.slice(0, 4)

  return {
    periods, agree_until: lastClean, total_period_diff: totalPeriodDiff, residual,
    proposal, cpa_exception: cpaException, conclusions: finalConclusions,
    divergent_count: divergentPeriods.length, win_from: winFrom, win_to: winTo,
  }
}

// ── v10 (session 228): LENDER-LEVEL ANALYSIS — "look across ALL loans, find the
// culprit once, propose ONE roadmap." Born the day three Ford loans each carried
// a red card and each per-loan analysis pointed at journals on its SIBLINGS:
// three silos describing one tangle, two of them claiming the very same
// candidate journals. The joint rules that fix that:
//  * ONE ENTRY, ONE EXPLANATION — an entry may be assigned to at most one
//    loan's gap. Per-loan runs let two loans both claim the same $135.64
//    journal; the joint solve assigns it once, to the best fit.
//  * BOTH SIDES MUST IMPROVE — a recode from loan M to loan L is only a
//    confident step when it shrinks the gap on BOTH walks (money extra on one
//    side, missing on the other, in matching spans — conservation of money).
//    A move that would worsen any walked span is rejected outright.
//  * ZERO-SUM VERDICT FIRST — the first bullet says how much of the combined
//    gap is money in the wrong bucket (stays in the books) vs. unexplained.
//  * SIMULATED END STATE — every accepted step is applied arithmetically to
//    the pulled data, so the last step says what each loan should show after
//    ONE re-run. No fix/re-run/fix loops across three cards.
//  * Read-only, like analyze mode. Safe-fix approvals reuse the per-loan
//    post_fix path and its deterministic tokens — this mode adds NO new write
//    path to Xero or the DB.
const jres = (obj: any, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json' } })


// ── session 234: NEVER A DUPLICATE JOURNAL ─────────────────────────────────
// Every other Xero write in this module checks whether it has already happened
// before it happens (`xero_manual_journal_id` on loan_splits / payroll_imports).
// The three post paths here had no such check -- their only protection was "a
// re-analysis can never produce this proposal again once it is posted", which is
// true but only AFTER the first post lands. A double-click, a retried request or
// two admins on the same card all race that window.
//
// These journals write no id to a row of ours, so there is nothing local to
// check. Xero itself is the ledger: a POSTED manual journal with the same
// narration on the same date IS this correction, already made. One GET before
// the write, and the answer is a loud explicit error -- never a second journal.
async function alreadyPostedInXero(narration: string, date: string, headers: Record<string, string>): Promise<any | null> {
  try {
    const [y, m, d] = String(date).slice(0, 10).split('-').map(Number)
    const w = encodeURIComponent(`Date==DateTime(${y},${m},${d})&&Status=="POSTED"`)
    const res = await fetch(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${w}`, { headers })
    if (!res.ok) return null // Xero unreachable: fall through to the post rather than block a legitimate correction
    const json = await res.json().catch(() => null)
    const hit = (json?.ManualJournals || []).find((j: any) => String(j?.Narration || '').trim() === String(narration).trim())
    return hit ? { id: hit.ManualJournalID, narration: hit.Narration, date: normDate(hit.DateString, hit.Date) } : null
  } catch { return null }
}

const duplicateJournalError = (hit: any) =>
  `This correction is already in Xero — manual journal ${String(hit.id || '').slice(0, 8)} ("${hit.narration}") dated ${hit.date}. Nothing was posted a second time. Run a reconciliation check to see where the loan stands now.`

// ── session 234: the posting window, computed once per request ──────────────
// Session 231's lesson, applied: the close date binds WRITES, not just what we
// propose. This org's Xero carries no lock date, so nothing downstream will
// refuse a journal dated into a settled month -- this is the only thing that
// will. Every proposal gets its date from here, and both post paths re-check it
// against the freshly-computed value before touching Xero.
async function postingWindow(supa: any, today: string) {
  const cd = await effectiveCloseDate(supa)
  const postingDate = postingDateFor(cd.date, today)
  const postingWhy = cd.date
    ? `books are closed through ${cd.date} (${cd.source === 'manual' ? 'the close date set in Bookkeeping' : "Xero's lock date"}) and the month after that is being closed`
    : `no close date is set, so the correction is dated at this month's end`
  return { closeDate: cd.date, closeSource: cd.source, postingDate, postingWhy }
}

async function handleLender(supa: any, body: any, role: string): Promise<Response> {
  const lenderName = String(body.lender || '').trim()
  if (!lenderName) return jres({ error: 'lender is required for a lender-level analysis.' }, 400)

  const { data: allLoans } = await supa.from('loan_accounts').select('id, xero_account_code, xero_account_name, xero_bank_account_id, lender, lender_account_number, status, scheduled_monthly_payment')
  const lenderLoans = (allLoans || []).filter((l: any) => l.lender === lenderName && l.xero_account_code)
  if (!lenderLoans.length) return jres({ error: `No loans found for lender "${lenderName}".` }, 404)

  const ids = lenderLoans.map((l: any) => l.id)
  const { data: openFindings } = await supa.from('reconciliation_findings')
    .select('*').in('loan_account_id', ids)
    .eq('check_key', 'balance_vs_lender').eq('status', 'open')
  const flaggedIds = new Set((openFindings || []).map((f: any) => f.loan_account_id))
  const flagged = lenderLoans.filter((l: any) => flaggedIds.has(l.id))
    .sort((a: any, b: any) => String(a.xero_account_name || '').localeCompare(String(b.xero_account_name || '')))
  if (flagged.length < 2) {
    return jres({ error: `Only ${flagged.length} ${lenderName} loan${flagged.length === 1 ? ' has' : 's have'} an open balance-vs-lender finding — the per-loan "Find the difference" covers that case.` }, 400)
  }

  const today = new Date().toISOString().slice(0, 10)
  const pw = await postingWindow(supa, today)
  const bundles: any[] = []
  for (const loan of flagged) {
    const [{ data: statements }, { data: splits }] = await Promise.all([
      supa.from('loan_statements').select('*').eq('loan_account_id', loan.id).lte('statement_date', today).order('statement_date', { ascending: true }),
      supa.from('loan_splits').select('*').eq('loan_account_id', loan.id).order('period_label', { ascending: true }),
    ])
    const finding = (openFindings || []).filter((f: any) => f.loan_account_id === loan.id)
      .sort((a: any, b: any) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))[0]
    const headline = finding?.detail?.difference != null
      ? { difference: Number(finding.detail.difference), as_of: finding.detail.anchor_date || null } : null
    const anchors = (statements || []).filter((s: any) => s.balance_basis === 'principal_only' && s.principal_balance != null)
    const skippedForBasis = (statements || []).filter((s: any) => s.balance_basis !== 'principal_only').map((s: any) => ({ date: s.statement_date, basis: s.balance_basis || 'unknown' }))
    const { matchKnown } = prepKnownAmounts(loan, splits || [])
    bundles.push({ loan, code: String(loan.xero_account_code), finding, headline, anchors, skippedForBasis, splits: splits || [], matchKnown })
  }

  const skippedLoans: any[] = []
  const walkable: any[] = []
  for (const b of bundles) {
    if (b.anchors.length < 2) {
      skippedLoans.push({ id: b.loan.id, name: b.loan.xero_account_name, reason: `only ${b.anchors.length} usable lender statement${b.anchors.length === 1 ? '' : 's'} on file — needs two to walk` })
      continue
    }
    const t = trimAnchors(b.anchors)
    b.usable = t.usable; b.truncated = t.truncated
    walkable.push(b)
  }
  if (walkable.length < 2) {
    return jres({ error: `Fewer than two ${lenderName} loans have enough lender statements to walk — analyze the one that does with the per-loan button.`, skipped_loans: skippedLoans }, 400)
  }

  // Union window across the walkable loans, floored so the month-sliced
  // fallback pull can never exceed its own 18-month safety cap. A loan whose
  // anchors fall entirely before the floor is reported, not silently walked
  // on partial data (the "never reconcile from partial data" law).
  let winFrom = walkable.map((b: any) => b.usable[0].statement_date).sort()[0]
  const winTo = walkable.map((b: any) => b.usable[b.usable.length - 1].statement_date).sort().slice(-1)[0]
  if (monthsSpanned(winFrom, winTo) > 18) {
    const ty = Number(winTo.slice(0, 4)), tm = Number(winTo.slice(5, 7))
    const fm = tm - 17, fy = ty + Math.floor((fm - 1) / 12), fmm = ((fm - 1) % 12 + 12) % 12 + 1
    winFrom = `${fy}-${String(fmm).padStart(2, '0')}-01`
    for (let i = walkable.length - 1; i >= 0; i--) {
      const b = walkable[i]
      while (b.usable.length > 2 && b.usable[0].statement_date < winFrom) { b.truncated = b.usable[0].statement_date; b.usable = b.usable.slice(1) }
      if (b.usable[0].statement_date < winFrom) {
        skippedLoans.push({ id: b.loan.id, name: b.loan.xero_account_name, reason: `its statements fall outside the shared 18-month window (${winFrom} →) — analyze it with the per-loan button` })
        walkable.splice(i, 1)
      }
    }
    if (walkable.length < 2) return jres({ error: 'After capping the shared window at 18 months, fewer than two loans remain walkable — use the per-loan analysis.', skipped_loans: skippedLoans }, 400)
    winFrom = walkable.map((b: any) => b.usable[0].statement_date).sort()[0]
  }

  const { accessToken, tenantId } = await getXeroAuth()
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json' }
  const acctMap = await fetchAccountsMap(headers)

  // ONE pull for every loan. The fast path is only safe when every walkable
  // loan pays from the same known bank account (true for the whole book today:
  // one Wells Fargo checking account); otherwise the complete month-sliced
  // org-wide pull runs once for everyone.
  const bankIds = Array.from(new Set(walkable.map((b: any) => b.loan.xero_bank_account_id).filter(Boolean)))
  const oneBank = (bankIds.length === 1 && walkable.every((b: any) => b.loan.xero_bank_account_id)) ? bankIds[0] : null
  let pulled: any[]
  try {
    pulled = await pullWindow(winFrom, winTo, headers, oneBank)
  } catch (e) {
    return jres({ error: String((e as Error).message || e) }, 502)
  }
  pulled.sort((a, b) => a.date.localeCompare(b.date))
  const entryById = new Map<string, any>(pulled.map((r: any) => [r.srcId, r]))

  // Per-loan walks — the exact same analyzeWalk the per-loan button runs.
  for (const b of walkable) {
    const otherLoanByCode = new Map<string, any>()
    for (const la of allLoans || []) if (la.id !== b.loan.id && la.xero_account_code) otherLoanByCode.set(String(la.xero_account_code), la)
    b.otherLoanByCode = otherLoanByCode
    b.entries = pulled.filter((r: any) => isLive(r) && r.lines.some((l: any) => String(l.c) === b.code))
    b.siblingPool = pulled.filter((r: any) => isLive(r)
      && !r.lines.some((l: any) => String(l.c) === b.code)
      && r.lines.some((l: any) => otherLoanByCode.has(String(l.c)))
      && !(r.ref && String(r.ref).startsWith('WR-STAGE')))
    b.aw = analyzeWalk({
      loan: b.loan, code: b.code, usable: b.usable, splits: b.splits, headline: b.headline,
      entries: b.entries, siblingPool: b.siblingPool, otherLoanByCode,
      matchKnown: b.matchKnown, acctMap, skippedForBasis: b.skippedForBasis,
      postingDate: pw.postingDate, postingWhy: pw.postingWhy, closeDate: pw.closeDate, today,
    })
  }

  // ── THE JOINT SOLVE ────────────────────────────────────────────────────────
  // 1. Gather every candidate move (entry E, currently coded to FROM,
  //    hypothesized to belong to TO) from every loan's span candidates. The
  //    same physical entry seen from both sides (one loan says "belongs here",
  //    the sibling says "belongs elsewhere") merges into ONE move — that merge
  //    IS the two-sided confirmation.
  const bByCode = new Map<string, any>(walkable.map((b: any) => [b.code, b]))
  const moves = new Map<string, any>()
  for (const b of walkable) {
    for (const p of b.aw.periods) {
      if (p.verdict !== 'divergent' || p.timing_pair || !p.cross_loan_candidates) continue
      for (const c of p.cross_loan_candidates) {
        const rec = entryById.get(c.id)
        if (!rec) continue
        const mv = moves.get(c.id) || {
          id: c.id, src_type: c.src_type, date: c.date, amount: c.amount,
          ref: c.ref ?? null, contact: c.contact ?? null, narration: c.narration ?? null,
          already_worked: !!c.already_worked, rec,
          from: null, to: null, confidence: c.confidence, same_lender: !!c.same_lender,
        }
        if (c.direction === 'maybe_belongs_here') {
          // Several loans may claim the same entry (the exact shape that broke
          // the per-loan silos): keep EVERY claimant; evalMove picks the best,
          // and a tie is reported as "either X or Z", never double-assigned.
          const fromB = c.coded_to?.account_code != null ? bByCode.get(String(c.coded_to.account_code)) : null
          mv.toClaims = mv.toClaims || []
          if (!mv.toClaims.some((x: any) => x.loan.id === b.loan.id)) mv.toClaims.push(b)
          mv.from = (mv.from?.bundle ? mv.from : null) || (fromB ? { bundle: fromB } : { external: c.coded_to || null, account_code: c.coded_to?.account_code ?? null })
        } else {
          mv.from = { bundle: b }
          // destination unknown from this side alone — the siblings'
          // belongs-here claims (if any) fill mv.toClaims when they merge.
        }
        if (c.confidence === 'explains_exactly' || (mv.confidence !== 'explains_exactly' && c.confidence === 'explains_with_known')) mv.confidence = c.confidence
        moves.set(c.id, mv)
      }
    }
  }

  // 2. Simulated span diffs per loan — greedy assignment mutates these, so a
  //    second move is never justified by a gap the first move already closed.
  const sim = new Map<string, any[]>(walkable.map((b: any) => [b.loan.id, b.aw.periods.map((p: any) => ({ ...p }))]))
  const spanFor = (b: any, date: string) => (sim.get(b.loan.id) || []).find((p: any) => date > (p.entry_from ?? p.from) && date <= (p.entry_to ?? p.to))
  const fromCodeOf = (mv: any) => mv.from?.bundle ? mv.from.bundle.code : String(mv.from?.account_code ?? '')

  // Signed effect of the entry on a liability balance at its CURRENT coding.
  // Recoding moves that whole effect: FROM loses it, TO gains it. Every
  // claimant destination is evaluated; the best-ranked one wins, and an exact
  // tie between claimants is reported as "either X or Z" — never assigned to
  // both (ONE ENTRY, ONE EXPLANATION). v11: a vetoed move comes back as a veto
  // record instead of null — promising leads the per-loan cards showed (same
  // lender, or amount-exact) must surface as RULED OUT with the reason, because
  // a silently vanished hypothesis reads as a bug to the human who saw it on
  // yesterday's card.
  const evalMove = (mv: any) => {
    let eff = effect(mv.rec, fromCodeOf(mv))
    if (!eff) eff = -Math.abs(mv.amount) // external coding we can't read line-by-line: a payment reduces the liability
    const improves = (d: any) => d == null ? null : Math.abs(d.after) < Math.abs(d.before) - TOL / 2
    const closes = (d: any) => d == null ? null : Math.abs(d.after) < TOL
    const sFrom = mv.from?.bundle ? spanFor(mv.from.bundle, mv.date) : null
    const dFrom = sFrom ? { span: sFrom, bundle: mv.from.bundle, before: sFrom.diff, after: r2(sFrom.diff - eff) } : null
    if (dFrom && improves(dFrom) === false) return { veto: true, side: 'from', eff, dFrom }
    const claimants: any[] = (mv.toClaims && mv.toClaims.length) ? mv.toClaims : [null]
    let best: any = null
    let claimantVetoed = false
    const rankOne = (toB: any) => {
      const sTo = toB ? spanFor(toB, mv.date) : null
      const dTo = sTo ? { span: sTo, bundle: toB, before: sTo.diff, after: r2(sTo.diff + eff) } : null
      if (dTo && improves(dTo) === false) { claimantVetoed = true; return null } // veto on the receiving side too
      if (!dFrom && !dTo) return null
      const twoSided = !!(dFrom && dTo)
      let rank: number
      if (twoSided && closes(dFrom) && closes(dTo)) rank = 0
      else if (twoSided) rank = 1
      else if (closes(dFrom) || closes(dTo)) rank = 2
      else if (mv.confidence === 'explains_with_known' || mv.confidence === 'explains_exactly') rank = 3
      else if (mv.same_lender) rank = 4
      else return null
      return { eff, dFrom, dTo, toBundle: toB, rank, twoSided, closesBoth: !!(twoSided && closes(dFrom) && closes(dTo)) }
    }
    const alternates: any[] = []
    for (const toB of claimants) {
      const r = rankOne(toB)
      if (!r) continue
      if (!best || r.rank < best.rank) { if (best) alternates.length = 0; best = r }
      else if (best && r.rank === best.rank && r.toBundle && best.toBundle && r.toBundle !== best.toBundle) alternates.push(r.toBundle)
    }
    if (!best) return claimantVetoed ? { veto: true, side: 'to', eff } : null
    return { ...best, alternates }
  }

  // 3. Greedy assignment, best-explanation first, re-evaluated against the
  //    live simulation at every step. Ranks 0–3 become roadmap steps; rank 4
  //    (same-lender, in-span only) becomes at most one "worth checking" step
  //    per span, and only when nothing better claimed that span. v11: a move
  //    with a concrete destination is a RECODE; one whose destination is
  //    unknown is an INVESTIGATE step ("recode it to… check the payee" is not
  //    an instruction anyone can execute). Vetoed-but-promising moves are kept
  //    as ruled_out, and every decision is console.logged so a live run can be
  //    diagnosed from the function logs — analyze mode still writes nothing.
  const ordered = Array.from(moves.values()).sort((a: any, b: any) => {
    const ea = evalMove(a), eb = evalMove(b)
    return (((ea && !ea.veto) ? ea.rank : 9) - ((eb && !eb.veto) ? eb.rank : 9)) || (Math.abs(b.amount) - Math.abs(a.amount)) || a.date.localeCompare(b.date)
  })
  const assigned: any[] = []
  const ruledOut: any[] = []
  const trace: any[] = []
  const usedSpanChecks = new Set<any>()
  for (const mv of ordered) {
    const ev = evalMove(mv)
    trace.push({ id: mv.id, amt: mv.amount, date: mv.date, conf: mv.confidence, same_lender: mv.same_lender, outcome: !ev ? 'no_span' : ev.veto ? `veto_${ev.side}` : `rank_${ev.rank}` })
    if (!ev) continue
    if (ev.veto) {
      // Only surface leads a human plausibly believed in: amount-exact/known
      // matches, or same-lender JOURNALS (the Ford shape). A sibling's routine
      // in-span payment getting vetoed is the system working, not news.
      const promising = mv.confidence !== 'in_span' || (mv.same_lender && mv.src_type === 'ManualJournal')
      // v13: a loan's OWN scheduled monthly payment being vetoed from moving
      // away is the system working, not news — naming it as a "ruled out
      // suspect" (the live E4 $1,144.55 case) reads as noise. Suppress.
      const sched = mv.from?.bundle?.loan?.scheduled_monthly_payment
      const routineSelf = sched != null && Math.abs(mv.amount - Number(sched)) < 1.00
      if (promising && !routineSelf && ruledOut.length < 3 && !ruledOut.some((r: any) => r.id === mv.id)) {
        const fromName = mv.from?.bundle ? mv.from.bundle.loan.xero_account_name : (mv.from?.external?.loan_name || `account ${mv.from?.account_code ?? '?'}`)
        const claimNames = (mv.toClaims || []).map((x: any) => x.loan.xero_account_name)
        ruledOut.push({
          id: mv.id, src_type: mv.src_type, date: mv.date, amount: mv.amount, from: fromName, claimed_by: claimNames,
          reason: ev.side === 'from'
            ? `moving it off ${fromName} would push ${fromName} further from the lender — it belongs where it is`
            : `moving it${claimNames.length ? ` to ${claimNames.join(' or ')}` : ''} would push the receiving loan further from the lender, not closer`,
        })
      }
      continue
    }
    if (ev.rank === 4) {
      const key = ev.dTo?.span || ev.dFrom?.span
      if (!key || usedSpanChecks.has(key) || Math.abs((ev.dTo || ev.dFrom)!.before) < TOL) continue
      usedSpanChecks.add(key)
      assigned.push({ ...mv, ev, kind: 'check' })
      continue
    }
    if (assigned.length >= 8) break
    assigned.push({ ...mv, ev, kind: mv.already_worked ? 'cpa_review' : (ev.toBundle ? 'recode' : 'investigate') })
    if (ev.dFrom) ev.dFrom.span.diff = ev.dFrom.after
    if (ev.dTo) ev.dTo.span.diff = ev.dTo.after
  }
  console.log('[lender-solver]', JSON.stringify({
    lender: lenderName,
    spans: walkable.map((b: any) => ({ loan: b.loan.xero_account_name, residual: b.aw.residual, periods: b.aw.periods.map((p: any) => ({ f: p.from, t: p.to, d: p.diff, timing: !!p.timing_pair })) })),
    decisions: trace.slice(0, 80),
  }))

  // v12: the "click post, settled" shape. See the header note — strictest
  // eligibility only, and the journal moves the ENTRY'S EFFECT (sign-correct
  // for payments and journals alike): TO gets the effect, FROM gets it back.
  for (const m of assigned) {
    if (m.kind !== 'recode' || !m.ev.closesBoth || (m.ev.alternates || []).length || !m.from?.bundle || !m.ev.toBundle) continue
    const amount = r2(Math.abs(m.ev.eff))
    if (amount < TOL) continue
    const fromCode = m.from.bundle.code, toCode = m.ev.toBundle.code
    m.xl = {
      kind: 'crossloan_reallocation_journal',
      amount, entry_id: m.id, entry_date: m.date,
      from: { loan: m.from.bundle.loan.xero_account_name, code: fromCode },
      to: { loan: m.ev.toBundle.loan.xero_account_name, code: toCode },
      journal: {
        Narration: `Reallocation — ${money(amount)} ${m.src_type === 'ManualJournal' ? 'journal' : 'payment'} ${m.date} (${fromCode} → ${toCode})`,
        Date: m.date, Status: 'POSTED',
        JournalLines: [
          { LineAmount: r2(-m.ev.eff), AccountCode: toCode, Description: 'Reallocated in', TaxType: 'NONE', AccountName: acctMap[toCode] ?? null },
          { LineAmount: r2(m.ev.eff), AccountCode: fromCode, Description: 'Reallocated out', TaxType: 'NONE', AccountName: acctMap[fromCode] ?? null },
        ],
      },
      token: proposalToken(m.id, `${fromCode}>${toCode}`, amount, 'xl'),
    }
  }

  // 4. Safe-fix approvals (the per-loan proposal, unchanged, same token). Only
  //    offered inline for loans NO recode step touches — a recode changes that
  //    loan's history, and the token discipline would (rightly) refuse a stale
  //    proposal anyway. Touched loans get theirs after the re-run.
  const touchedLoanIds = new Set(assigned.filter((m: any) => m.kind === 'recode' || m.kind === 'cpa_review')
    .flatMap((m: any) => [m.from?.bundle?.loan?.id, m.ev?.toBundle?.loan?.id].filter(Boolean)))
  const approvals: any[] = []
  const deferredApprovals: any[] = []
  for (const b of walkable) {
    if (!b.aw.proposal) continue
    if (touchedLoanIds.has(b.loan.id)) { deferredApprovals.push(b); continue }
    approvals.push(b)
    const s = (sim.get(b.loan.id) || []).find((p: any) => p.from === b.aw.proposal.span.from && p.to === b.aw.proposal.span.to)
    if (s) s.diff = 0
  }

  // 5. Expected end state per loan, from the simulation. v11: the label tells
  //    the TRUTH about direction — a loan whose number RISES because a wrong
  //    entry was masking an older gap says so, instead of presenting a bigger
  //    number as if it were the goal (the live-run lesson, David verbatim:
  //    "How is $8,103.41 above the lender a good thing? what am I missing?" —
  //    it isn't good; it's the real gap surfacing from under offsetting errors).
  const expected: any[] = []
  for (const b of walkable) {
    const simTotal = r2((sim.get(b.loan.id) || []).reduce((s: number, p: any) => s + p.diff, 0))
    const after = r2(simTotal + (b.aw.residual ?? 0))
    const before = b.headline?.difference ?? r2(b.aw.total_period_diff + (b.aw.residual ?? 0))
    const changed = Math.abs(after - before) >= TOL
    const uncovers = changed && Math.abs(after) > Math.abs(before) + TOL
    const dirW = after > 0 ? 'above' : 'below'
    let base: string
    if (!changed) base = 'unchanged'
    else if (Math.abs(after) < TOL) base = 'should tie'
    else if (uncovers) base = `should RISE to ~${money(after)} ${dirW} the lender`
    else base = `should come down to ~${money(after)} ${dirW} the lender`
    expected.push({
      loan_account_id: b.loan.id, loan: b.loan.xero_account_name,
      before, after_expected: after, changed, uncovers,
      residual: b.aw.residual, win_from: b.aw.win_from, truncated_before: b.truncated ?? null,
      label: uncovers ? `${base} — was masking an older gap` : base,
      label_base: base,
    })
  }
  const combinedBefore = r2(expected.reduce((s: number, e: any) => s + Number(e.before || 0), 0))
  const combinedAfter = r2(expected.reduce((s: number, e: any) => s + Number(e.after_expected || 0), 0))
  const recodes = assigned.filter((m: any) => m.kind === 'recode')
  const internalMoved = r2(assigned.filter((m: any) => m.ev.twoSided && m.kind !== 'check').reduce((s: number, m: any) => s + Math.abs(m.amount), 0))

  // 6. The roadmap — one numbered list, ordered so no step invalidates a later
  //    one: recodes → CPA reviews → independent safe-fix approvals → ONE re-run.
  const loanShort = (b: any) => b?.loan?.xero_account_name || '?'
  const spanShort = (d: any) => d ? `${d.span.from} → ${d.span.to}` : null
  const roadmap: any[] = []
  let n = 1
  for (const m of assigned) {
    if (m.kind === 'check') continue
    const fromName = m.from?.bundle ? loanShort(m.from.bundle) : (m.from?.external?.loan_name || m.from?.external?.account_name || `account ${m.from?.account_code ?? '?'}`)
    const toName = m.ev.toBundle ? loanShort({ loan: m.ev.toBundle.loan }) : null
    const what = m.src_type === 'ManualJournal' ? 'journal' : 'payment'
    const stateAfter = (d: any) => Math.abs(d.after) < TOL ? 'tied' : `${money(d.after)} off`
    const outcomes = [
      m.ev.dFrom ? `${fromName} ${spanShort(m.ev.dFrom)}: ${money(m.ev.dFrom.before)} off → ${stateAfter(m.ev.dFrom)}` : null,
      m.ev.dTo ? `${toName} ${spanShort(m.ev.dTo)}: ${money(m.ev.dTo.before)} off → ${stateAfter(m.ev.dTo)}` : null,
    ].filter(Boolean).join('; ')
    const fromExp = m.from?.bundle ? expected.find((e: any) => e.loan_account_id === m.from.bundle.loan.id) : null
    const riseNote = fromExp?.uncovers ? ` ${fromName}'s headline will RISE — an older gap surfacing, not new damage.` : ''
    let why: string
    if (m.kind === 'cpa_review') {
      why = `The ${money(m.amount)} ${what} on ${m.date} looks misallocated (${fromName} → ${toName || 'another loan'}), but your accountant already worked it — per your rule, she decides.`
    } else if (m.kind === 'investigate') {
      const known = m.ev.dFrom && m.from?.bundle ? m.from.bundle.matchKnown(m.ev.dFrom.after) : null
      why = `The ${money(m.amount)} ${what} dated ${m.date}${m.contact ? ` (${m.contact})` : ''} is coded to ${fromName}, but its lender statements never saw it — it belongs to another loan. Check the bank line's payee / lender account number, then recode. After: ${outcomes}${known ? ` (remainder equals ${known.what} — an older item)` : ''}.${riseNote}`
    } else {
      why = `In Xero, recode the ${money(m.amount)} ${what} dated ${m.date}${m.contact ? ` (${m.contact})` : ''} from ${fromName} to ${toName}.${(m.ev.alternates || []).length ? ` Could equally belong to ${m.ev.alternates.map((x: any) => x.loan.xero_account_name).join(' or ')} — check which loan's statement shows it first.` : ''} After: ${outcomes}.${riseNote}`
    }
    if (m.xl) {
      why = `Closes both loans' spans exactly: the ${money(m.amount)} ${what} dated ${m.date}${m.contact ? ` (${m.contact})` : ''} belongs to ${toName}, not ${fromName}. Approve below to post a reallocation journal (${m.xl.from.code} → ${m.xl.to.code}) — OR have your accountant recode the bank line. Do exactly ONE. After: ${outcomes}.${riseNote}`
    }
    roadmap.push({
      step: n++, kind: m.xl ? 'approve_reallocation' : m.kind,
      entry: { type: m.src_type, id: m.id, date: m.date, amount: m.amount, contact: m.contact, ref: m.ref, narration: m.narration },
      move_from: { loan: fromName, account_code: m.from?.bundle ? m.from.bundle.code : (m.from?.account_code ?? null) },
      move_to: toName ? { loan: toName, account_code: m.ev.toBundle.code } : { loan: 'to be determined — check the payee', account_code: null },
      alternate_destinations: (m.ev.alternates || []).map((x: any) => ({ loan: x.loan.xero_account_name, account_code: x.code })),
      confidence: m.ev.closesBoth ? 'confirmed both sides' : m.ev.twoSided ? 'improves both sides' : 'one-sided',
      ...(m.xl ? { amount: m.xl.amount, journal: m.xl.journal, token: m.xl.token } : {}),
      why,
    })
  }
  for (const m of assigned) {
    if (m.kind !== 'check') continue
    const fromName = m.from?.bundle ? loanShort(m.from.bundle) : (m.from?.external?.loan_name || `account ${m.from?.account_code ?? '?'}`)
    const toName = m.ev.toBundle ? loanShort({ loan: m.ev.toBundle.loan }) : '?'
    roadmap.push({
      step: n++, kind: 'check',
      entry: { type: m.src_type, id: m.id, date: m.date, amount: m.amount, contact: m.contact, ref: m.ref, narration: m.narration },
      move_from: { loan: fromName, account_code: m.from?.bundle ? m.from.bundle.code : (m.from?.account_code ?? null) },
      move_to: { loan: toName, account_code: m.ev.toBundle ? m.ev.toBundle.code : null },
      confidence: 'worth checking',
      why: `Worth a look, not a confident call: the ${money(m.amount)} ${m.src_type === 'ManualJournal' ? 'journal' : 'payment'} on ${m.date} (coded to ${fromName}) sits inside an unexplained span on ${toName} — same lender. Confirm against the lender's statement before moving.`,
    })
  }
  for (const b of approvals) {
    roadmap.push({
      step: n++, kind: 'approve_journal',
      loan_account_id: b.loan.id, loan: b.loan.xero_account_name,
      finding_id: b.finding?.id ?? null,
      period: b.aw.proposal.period, amount: b.aw.proposal.amount,
      token: b.aw.proposal.token, based_on: b.aw.proposal.based_on, journal: b.aw.proposal.journal,
      why: `${b.loan.xero_account_name}: the ${b.aw.proposal.period} gap equals that period's interest to the cent — approve the prepared correction below (nothing posts until you click).`,
    })
  }
  for (const b of walkable) {
    if (!b.aw.cpa_exception) continue
    roadmap.push({
      step: n++, kind: 'cpa_review', loan: b.loan.xero_account_name,
      why: b.aw.cpa_exception.note,
      // session 234: the step carries the working, not just the deferral.
      diagnosis: b.aw.cpa_exception.diagnosis ?? null,
      proposed_entry: b.aw.cpa_exception.proposed_entry ?? null,
      token: b.aw.cpa_exception.token ?? null,
    })
  }
  // v11: when a loan's real gap predates its statements on file (the masked
  // case), the single most useful thing a human can provide is the lender's
  // FULL payment history for that loan — one download per account instead of
  // sifting entries one by one (David's ask, verbatim). Ingesting it
  // auto-derives dense principal-only anchors (loan-ingest-amortization v15),
  // which turns these coarse statement spans into per-payment spans on the
  // next run — at that point the engine can name individual missing or
  // misplaced payments instead of inferring from span gaps.
  for (const e of expected) {
    // v13 (the live incident: the roadmap asked for histories David had JUST
    // uploaded, one step even saying "~$0.00 predates"): this step exists for
    // GENUINELY MISSING data only. Residual must be real money, and there must
    // be no earlier statements on file — a residual that sits before the
    // 18-month walk window while history IS on file is a deep-walk item, not
    // an upload request; it gets a note, never a button.
    if (e.residual == null || Math.abs(e.residual) < TOL) continue
    if (e.truncated_before) {
      roadmap.push({
        step: n++, kind: 'cpa_review', loan: e.loan,
        why: `${e.loan}: ~${money(e.residual)} sits before the walk window (${e.win_from}); history is on file — nothing to upload, needs a deeper pass later.`,
      })
      continue
    }
    roadmap.push({
      step: n++, kind: 'upload_history', loan_account_id: e.loan_account_id, loan: e.loan,
      why: `Ask the lender for ${e.loan}'s full payment/transaction history and upload it to the loan. ~${money(e.residual)} of its gap predates the earliest statement on file (${e.win_from}) — the next run then names exactly what's missing or misplaced.`,
    })
  }
  const changedExp = expected.filter((e: any) => e.changed)
  const unchangedExp = expected.filter((e: any) => !e.changed)
  const expectedLine = [
    ...changedExp.map((e: any) => `${e.loan} ${e.label_base}`),
    unchangedExp.length ? `${unchangedExp.map((e: any) => e.loan).join(' and ')} unchanged` : null,
  ].filter(Boolean).join('; ')
  roadmap.push({
    step: n++, kind: 'rerun',
    why: `Then run ONE reconciliation check in WashRoute. Expected: ${expectedLine}.${deferredApprovals.length ? ` ${deferredApprovals.map((b: any) => b.loan.xero_account_name).join(', ')} may then offer a prepared interest correction to approve.` : ''}`,
  })

  // 7. Conclusions — ≤5 bullets, and HONEST about direction (v11). Never claim
  //    "nothing is missing, it's in the wrong buckets" unless the simulation
  //    actually closes the books; when fixing things makes a number RISE, lead
  //    with why (offsetting errors surfacing, not new damage). Ruled-out leads
  //    are named — a hypothesis the per-loan cards showed must never just
  //    vanish. Priority order when over five: verdict, masking, top move,
  //    ruled-out, timing.
  const uncoverers = expected.filter((e: any) => e.uncovers)
  const actionable = assigned.filter((m: any) => m.kind === 'recode' || m.kind === 'investigate')
  const conclusions: string[] = []
  const grossAfter = r2(expected.reduce((s: number, e: any) => s + Math.abs(Number(e.after_expected) || 0), 0))
  const nameFew = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  let verdict = `Across ${walkable.length} ${lenderName} loans, Xero is a combined ${money(combinedBefore)} ${combinedBefore >= 0 ? 'above' : 'below'} the lender.`
  if (!actionable.length && !approvals.length) verdict += ` No cross-loan move survives the math — see the steps and per-loan sections below.`
  else if (Math.abs(combinedAfter) < TOL) verdict += ` The steps below close it — the money is all in the books, just in the wrong buckets.`
  else if (uncoverers.length) {
    // v14: an internal move between flagged loans can't change the combined
    // total (one rises, one falls) — never promise a combined RISE the
    // arithmetic doesn't deliver, and only call the net "deceptively small"
    // when it actually is small against the gross after-picture.
    const riseNames = nameFew(uncoverers.map((e: any) => e.loan))
    const downers = expected.filter((e: any) => e.changed && !e.uncovers && Math.abs(e.after_expected) < Math.abs(e.before) - TOL)
    const deceptive = Math.abs(combinedBefore) + TOL < grossAfter / 2
    if (Math.abs(combinedAfter) > Math.abs(combinedBefore) + TOL) {
      verdict += `${deceptive ? ` That small number hides larger canceling errors on ${riseNames}.` : ''} Expect the combined to RISE to ~${money(combinedAfter)} as wrong entries come off — progress, not damage.`
    } else {
      verdict += ` The fixes mostly move money BETWEEN loans, so the combined barely moves — ${riseNames} ${uncoverers.length === 1 ? 'rises' : 'rise'} toward the hidden gap${uncoverers.length === 1 ? '' : 's'}${downers.length ? ` while ${nameFew(downers.map((e: any) => e.loan))} ${downers.length === 1 ? 'comes' : 'come'} down` : ''}.`
    }
  }
  else verdict += ` The steps below explain ${money(r2(Math.abs(combinedBefore) - Math.abs(combinedAfter)))}; ~${money(combinedAfter)} remains (per-loan details below).`
  conclusions.push(verdict)
  for (const e of uncoverers.slice(0, 1)) {
    const inWin = r2(e.after_expected - (e.residual ?? 0))
    const parts: string[] = []
    if (e.residual != null && Math.abs(e.residual) >= TOL) parts.push(e.truncated_before ? `~${money(e.residual)} sits before the walk window (${e.win_from}) — a deeper pass chases it` : `~${money(e.residual)} predates its earliest statement on file (${e.win_from})`)
    if (Math.abs(inWin) >= TOL) parts.push(`~${money(inWin)} of in-window entries don't line up`)
    conclusions.push(`${e.loan}'s ${money(e.before)} is deceptively small — bigger errors cancel inside it: ${parts.join(', and ')}. Removing wrong entries makes it rise toward the real gap — more honest, not worse.`)
  }
  for (const m of actionable.slice(0, uncoverers.length ? 1 : 2)) {
    const fromName = m.from?.bundle ? loanShort(m.from.bundle) : (m.from?.external?.loan_name || `account ${m.from?.account_code ?? '?'}`)
    const toName = m.ev.toBundle ? loanShort({ loan: m.ev.toBundle.loan }) : null
    if (m.kind === 'investigate') {
      conclusions.push(`The ${money(m.amount)} ${m.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${m.date}) on ${fromName} doesn't belong there — the lender never saw it. Find its real loan (check the payee) and recode it.`)
    } else {
      conclusions.push(`The ${money(m.amount)} ${m.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${m.date}) on ${fromName} belongs to ${(m.ev.alternates || []).length ? `either ${toName} or ${m.ev.alternates.map((x: any) => x.loan.xero_account_name).join(' or ')}` : toName}${m.ev.closesBoth ? ' — moving it closes a span on BOTH loans' : m.ev.twoSided ? ' — moving it shrinks both loans’ gaps' : ''}.`)
    }
  }
  if (ruledOut.length) {
    conclusions.push(`Ruled out — leave in place: ${ruledOut.map((r: any) => `the ${money(r.amount)} ${r.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${r.date}) on ${r.from}`).join(', ')}; moving ${ruledOut.length === 1 ? 'it' : 'them'} makes things worse.`)
  }
  const pairSpans = walkable.reduce((s: number, b: any) => s + b.aw.periods.filter((p: any) => p.timing_pair).length, 0)
  if (pairSpans) conclusions.push(`${pairSpans} flagged span${pairSpans === 1 ? ' is' : 's are'} timing, not errors — payments dated just after a cutoff. They cancel; nothing to fix.`)
  if (conclusions.length === 1 && Math.abs(combinedAfter) < TOL) conclusions.push(`After the roadmap and one re-run, every ${lenderName} loan should tie with the lender.`)
  const finalConclusions = conclusions.slice(0, 5)

  // 8. The plain-text handoff — everything the accountant needs WITHOUT the
  //    dashboard: one checklist, copy/paste into an email or text. v11: carries
  //    the RISE warning and the do-not-move list so she is never surprised or
  //    tempted to "fix" a ruled-out entry.
  const hand: string[] = []
  hand.push(`${lenderName} — loan cleanup checklist (${today})`)
  hand.push(`Xero vs lender, combined: ${money(combinedBefore)} ${combinedBefore >= 0 ? 'above' : 'below'} across ${walkable.length} loans.`)
  if (uncoverers.length) hand.push(`NOTE: expect ${uncoverers.map((e: any) => e.loan).join(' and ')} to RISE after these fixes — an older gap surfacing, not new damage.`)
  if (ruledOut.length) hand.push(`DO NOT MOVE: ${ruledOut.map((r: any) => `${money(r.amount)} ${r.src_type === 'ManualJournal' ? 'journal' : 'payment'} ${r.date} on ${r.from}`).join('; ')} — ruled out; moving them makes things worse.`)
  hand.push('')
  for (const s of roadmap) {
    if (s.kind === 'recode' || s.kind === 'check') {
      hand.push(`${s.step}. ${s.kind === 'recode' ? 'RECODE' : 'CHECK'} — ${money(s.entry.amount)} ${s.entry.type === 'ManualJournal' ? 'manual journal' : 'payment'} dated ${s.entry.date}${s.entry.contact ? ` (${s.entry.contact})` : ''}${s.entry.ref ? `, ref ${s.entry.ref}` : ''}${s.entry.narration ? `, "${s.entry.narration}"` : ''}`)
      hand.push(`   now on: ${s.move_from.account_code ? `${s.move_from.account_code} ` : ''}${s.move_from.loan}  →  move to: ${s.move_to.account_code ? `${s.move_to.account_code} ` : ''}${s.move_to.loan}`)
      if (s.kind === 'check') hand.push(`   (not a confident call — confirm against the lender's statement first)`)
    } else if (s.kind === 'investigate') {
      hand.push(`${s.step}. FIND WHERE IT BELONGS — ${money(s.entry.amount)} ${s.entry.type === 'ManualJournal' ? 'manual journal' : 'payment'} dated ${s.entry.date}${s.entry.contact ? ` (${s.entry.contact})` : ''}${s.entry.ref ? `, ref ${s.entry.ref}` : ''}`)
      hand.push(`   currently on: ${s.move_from.account_code ? `${s.move_from.account_code} ` : ''}${s.move_from.loan} — the lender never saw it. Check the payee / lender account number, recode to the right loan.`)
    } else if (s.kind === 'upload_history') {
      hand.push(`${s.step}. GET THE LENDER'S HISTORY — download ${s.loan}'s full payment/transaction history from the lender portal and upload it in WashRoute.`)
    } else if (s.kind === 'approve_reallocation') {
      hand.push(`${s.step}. DAVID APPROVES IN WASHROUTE — reallocation journal ${money(s.amount)}: ${s.move_from.account_code} ${s.move_from.loan} → ${s.move_to.account_code} ${s.move_to.loan}`)
      hand.push(`   (or recode the ${s.entry.date} bank line yourself — do exactly ONE of the two, never both)`)
    } else if (s.kind === 'approve_journal') {
      hand.push(`${s.step}. APPROVE IN WASHROUTE — ${s.loan}: prepared ${s.period} interest correction of ${money(s.amount)} (button on the ${lenderName} card; David/admin only)`)
    } else if (s.kind === 'cpa_review') {
      hand.push(`${s.step}. YOUR ACCOUNTANT DECIDES — ${s.why}`)
      if (s.proposed_entry) {
        hand.push(`   Prepared entry (${s.proposed_entry.Date}): ${s.proposed_entry.Narration}`)
        for (const l of s.proposed_entry.JournalLines) {
          hand.push(`     ${l.LineAmount >= 0 ? 'DEBIT ' : 'CREDIT'} ${l.AccountCode}  ${money(l.LineAmount)}  — ${l.Description}`)
        }
        hand.push(`   Approve it in WashRoute; nothing posts until then.`)
      }
    } else if (s.kind === 'rerun') {
      hand.push(`${s.step}. RE-RUN — in WashRoute, run one Reconciliation Check after all steps above.`)
      hand.push(`   Expected: ${expectedLine}`)
    }
  }
  const handoffText = hand.join('\n')

  // v12: the human approved a reallocation they saw. This entire analysis just
  // re-ran fresh above; the token must still match EXACTLY or nothing posts.
  // Once posted, the next re-analysis finds those spans tied and can never
  // produce this proposal again — that is the double-post protection.
  if (body.post_crossloan) {
    const step = roadmap.find((s: any) => s.kind === 'approve_reallocation' && s.token === body.proposal_token)
    if (!step) {
      return jres({ error: 'Re-analysis found no matching reallocation to post — the books may have changed since you looked. Run the analysis again and review the fresh roadmap.', conclusions: finalConclusions, roadmap }, 409)
    }
    // session 234 (session 231's rule): the close date binds the WRITE. This
    // org's Xero has no lock date, so nothing downstream will refuse a journal
    // dated into a settled month.
    if (isProtectedDate(step.journal.Date, pw.closeDate, today)) {
      return jres({
        error: `That journal is dated ${step.journal.Date}, which falls in a period your accountant has closed or is closing (books closed through ${pw.closeDate}). Nothing was posted. Re-run the analysis — the correction will re-date itself to ${pw.postingDate}.`,
      }, 409)
    }
    const dupX = await alreadyPostedInXero(step.journal.Narration, step.journal.Date, headers)
    if (dupX) return jres({ error: duplicateJournalError(dupX), already_posted: dupX }, 409)
    const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ManualJournals: [{ ...step.journal, JournalLines: step.journal.JournalLines.map((l: any) => ({ LineAmount: l.LineAmount, AccountCode: l.AccountCode, Description: l.Description, TaxType: l.TaxType })) }] }),
    })
    const postJson = await postRes.json().catch(() => null)
    if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
      return jres({ error: 'Xero journal post failed', status: postRes.status, details: postJson }, 502)
    }
    const journal = postJson.ManualJournals?.[0]
    return jres({
      ok: true, mode: 'post_crossloan',
      posted_journal: { id: journal?.ManualJournalID, narration: step.journal.Narration, date: step.journal.Date, lines: step.journal.JournalLines },
      posted_by: body.posted_by || null,
      note: 'Reallocation posted. Do NOT also recode the original bank line. Run a reconciliation check — both loans should move.',
    })
  }

  return jres({
    ok: true, mode: 'lender_analysis', lender: lenderName, posting_window: pw,
    combined: { before: combinedBefore, after_expected: combinedAfter, direction: combinedBefore >= 0 ? 'xero_above_lender' : 'xero_below_lender', explained_two_sided: internalMoved },
    conclusions: finalConclusions,
    roadmap,
    ruled_out: ruledOut,
    handoff_text: handoffText,
    expected,
    loans: walkable.map((b: any) => ({
      id: b.loan.id, name: b.loan.xero_account_name, code: b.code,
      finding_id: b.finding?.id ?? null, headline: b.headline,
      periods: b.aw.periods, agree_until: b.aw.agree_until,
      conclusions: b.aw.conclusions, proposal: b.aw.proposal, cpa_exception: b.aw.cpa_exception,
      truncated_before: b.truncated, skipped_for_basis: b.skippedForBasis,
    })),
    skipped_loans: skippedLoans,
    window: { from: winFrom, to: winTo, read_via: oneBank ? 'one pull: bank transactions scoped to the shared checking account, plus every manual journal in the window' : 'one pull: org-wide month-sliced' },
    can_post: ['admin', 'manager'].includes(role),
  })
}


async function handle(req: Request): Promise<Response> {
  const supa = admin()
  const body = await req.json().catch(() => ({}))
  const { loan_account_id, post_fix, proposal_token, posted_by } = body
  // session 234: approving the exception's prepared correction. Same contract as
  // post_fix in every respect -- admin/manager, full server-side re-analysis on
  // this same request, exact-token match or nothing posts.
  const post_exception = !!body.post_exception

  const role = await callerRole(req)
  if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
    return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  if ((post_fix || post_exception) && !['admin', 'manager'].includes(role)) {
    return new Response(JSON.stringify({ error: 'Only an admin or manager can post a correction. Your account can review the analysis but not write.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  // v10: lender-level analysis — read-only by construction; corrections are
  // posted from their own loan card (per-loan post_fix), never from here.
  if (body.lender_analysis) {
    if (post_fix) {
      return new Response(JSON.stringify({ error: 'Post a correction from its own loan card — the lender-level analysis is read-only.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // v12: posting a reallocation is a write — admin/manager only, same bar as post_fix.
    if (body.post_crossloan && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Only an admin or manager can post a reallocation. Your account can review the analysis but not write.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    return await handleLender(supa, body, role)
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

  const { knownAmounts, matchKnown } = prepKnownAmounts(loan, splits || [])

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

  // Window = the span the anchors cover, capped at 18 months of pull — see
  // trimAnchors() (hoisted in v10, logic unchanged).
  const { usable, truncated } = trimAnchors(anchors)

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

  // v10: the whole walk — spans, timing pairs, candidates, proposal,
  // conclusions — now runs through the shared analyzeWalk() (the lender-level
  // analysis calls the same function per loan). Behavior here is unchanged.
  const pw = await postingWindow(supa, today)
  const aw = analyzeWalk({
    loan, code, usable, splits: splits || [], headline, entries, siblingPool,
    otherLoanByCode, matchKnown, acctMap, skippedForBasis,
    postingDate: pw.postingDate, postingWhy: pw.postingWhy, closeDate: pw.closeDate, today,
  })
  const periods = aw.periods
  const totalPeriodDiff = aw.total_period_diff
  const lastClean = aw.agree_until
  const residual = aw.residual
  const proposal = aw.proposal
  const cpaException = aw.cpa_exception
  const finalConclusions = aw.conclusions

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


  // Narrative for API consumers = intro + the same bullets; the client renders
  // the bullets. The old exhaustive span-listing paragraph is gone on purpose.
  const bits: string[] = []
  bits.push(`Walked ${periods.length} statement span${periods.length === 1 ? '' : 's'} (${winFrom} → ${winTo}) on ${loan.xero_account_name}.`)
  bits.push(...finalConclusions)
  if (proposal) bits.push(`One span has a mechanically safe fix: the gap equals the ${proposal.period} interest portion exactly — the correcting journal below closes it using only the lender's own figures. Nothing posts until you approve.`)
  if (cpaException) bits.push(cpaException.note)

  const analysis = {
    ok: true, mode: 'analyze' as string,
    posting_window: pw,
    loan: { id: loan.id, name: loan.xero_account_name, code },
    headline,
    window: { from: winFrom, to: winTo, anchors_used: usable.length, truncated_before: truncated, skipped_for_basis: skippedForBasis,
      read_via: loan.xero_bank_account_id ? 'bank transactions scoped to this loan\'s own bank account, plus every manual journal in the window' : 'org-wide month-sliced pull' },
    periods, agree_until: lastClean,
    total_period_diff: totalPeriodDiff, residual_before_window: residual,
    fingerprint_hunt: hunt,
    proposal, cpa_exception: cpaException,
    can_post: !!proposal && ['admin', 'manager'].includes(role),
    can_post_exception: !!cpaException?.proposed_entry && ['admin', 'manager'].includes(role),
    conclusions: finalConclusions,
    narrative: bits.join(' '),
  }

  // ── post_exception: the prepared correction for an entry the accountant
  //    already worked. It never touches her entry -- it is a separate journal
  //    reversing only what our own splits record as already reallocated. ──
  if (post_exception) {
    const prepared = cpaException?.proposed_entry
    if (!prepared) {
      return new Response(JSON.stringify({ error: 'Re-analysis found no prepared correction to post — the books may have changed since you looked. Review the fresh analysis.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (cpaException.token !== proposal_token) {
      return new Response(JSON.stringify({ error: 'The prepared correction changed since you reviewed it — approve the current one instead.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (isProtectedDate(prepared.Date, pw.closeDate, today)) {
      return new Response(JSON.stringify({ error: `That correction is dated ${prepared.Date}, which falls in a period your accountant has closed or is closing (books closed through ${pw.closeDate}). Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const dupE = await alreadyPostedInXero(prepared.Narration, prepared.Date, headers)
    if (dupE) {
      return new Response(JSON.stringify({ error: duplicateJournalError(dupE), already_posted: dupE }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const exRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ManualJournals: [{ Narration: prepared.Narration, Date: prepared.Date, Status: prepared.Status, JournalLines: prepared.JournalLines.map((l: any) => ({ LineAmount: l.LineAmount, AccountCode: l.AccountCode, Description: l.Description, TaxType: l.TaxType })) }] }),
    })
    const exJson = await exRes.json().catch(() => null)
    if (!exRes.ok || exJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: exRes.status, details: exJson }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const exJournal = exJson.ManualJournals?.[0]
    return new Response(JSON.stringify({
      ok: true, mode: 'post_exception',
      posted_journal: { id: exJournal?.ManualJournalID, narration: prepared.Narration, date: prepared.Date, lines: prepared.JournalLines },
      posted_by: posted_by || null,
      note: 'Correction posted as a separate journal. Your accountant\'s own entry was not touched. Run a reconciliation check — the loan should now tie.',
    }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
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
  // session 234 (session 231's rule): the close date binds the WRITE, not just
  // the proposal. Same check on both post paths -- a guard on one branch of two
  // is the shape of bug session 231 found six times in one night.
  if (isProtectedDate(proposal.journal.Date, pw.closeDate, today)) {
    return new Response(JSON.stringify({
      error: `That correction is dated ${proposal.journal.Date}, which falls in a period your accountant has closed or is closing (books closed through ${pw.closeDate}). Nothing was posted. Re-run the analysis — it will re-date itself to ${pw.postingDate}.`,
      analysis,
    }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  const dupF = await alreadyPostedInXero(proposal.journal.Narration, proposal.journal.Date, headers)
  if (dupF) {
    return new Response(JSON.stringify({ error: duplicateJournalError(dupF), already_posted: dupF, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
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
