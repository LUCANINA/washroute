import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'
import { effectiveCloseDate, postingDateFor, isProtectedDate } from '../_shared/close-date.ts'
import { deriveIncreaseCause } from './derive-cause.ts'
import { diagnoseWorkedEntry } from './diagnose-exception.ts'
import { anchorsByBalanceDate, refusedAnchors, looksPeriodLabelled, normalizeBasis } from '../_shared/statement-period.ts'
import { findStaleSplits, trueUpJournalLines, trueUpCard } from '../_shared/stale-split-trueup.ts'
import { readRateLimit, rateLimitMessage } from '../_shared/xero-429.ts'
import { isMaterialGap, MATERIAL_FLOOR, MATERIAL_SHARE } from '../_shared/materiality.ts'
import { canWriteBookkeeping } from '../_shared/bk-write-roles.ts'

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
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
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

// A SCHEDULED JOB HAS NO USER TO BE (session 261).
//
// `loan-attribution-run` runs nightly with nobody logged in, so `callerRole` can only
// ever return null for it. Same shared-secret contract as xero-read and loan-xero-post
// (migration session_227h_internal_call_secret).
//
// The secret maps to the role `internal_job`, and the name is doing real work: EVERY
// write gate in this file is `canWriteBookkeeping(role)` (session 289) -- five of them, at
// lines that post a Manual Journal (post_fix), the exception correction (post_exception)
// and the cross-loan reallocation (post_crossloan), plus the two `can_post` flags. A role
// outside that array cannot reach a single one of them by construction.
//
// That is an absence, though, and session 231's rule is that a guard belongs where the
// dangerous paths CONVERGE and should say so out loud rather than depend on a role
// simply not appearing in an array someone may widen later. So `handle` also refuses an
// internal caller that asks for any write mode, explicitly, before anything else runs.
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const money = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const r2 = (n: number) => Math.round(n * 100) / 100
/** Last day of a 'YYYY-MM' period label. UTC, so no zone can shift it (s272). */
const endOfMonthLabel = (label: string): string => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label || ''))
  if (!m) return String(label || '')
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).toISOString().slice(0, 10)
}
// session 272: '2026-08' -> 'August 2026'. Built from a fixed table rather than
// toLocaleString because this runs on an edge runtime whose default locale is
// not the reader's, and a month name that changes with the server is not a fact.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (yyyymm: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(yyyymm || ''))
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : String(yyyymm || '')
}

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
    // ── s290: A RETRY-AFTER OF 45,461 SECONDS IS NOT A RETRY ────────────────
    // This loop obeyed Retry-After literally. On the DAILY cap Xero sends ~12.6
    // hours, so the function slept until the gateway killed it and the caller
    // got a 504 with no body — which the card renders as "try again in a
    // moment", the one action that makes a rolling daily window worse. The
    // throw below was unreachable. See _shared/xero-429.ts.
    let rate: any = null
    for (let retry = 0; retry < 5; retry++) {
      res = await fetch(`${baseUrl}${sep}page=${page}`, { headers })
      if (res.status === 429) {
        rate = readRateLimit(res, retry)
        if (!rate.waitable) break
        await sleep(rate.waitSeconds * 1000)
        continue
      }
      text = await res.text(); break
    }
    if (!res) throw new Error('Xero: no response after retries')
    if (res.status === 429) throw new Error(rateLimitMessage(rate || readRateLimit(res)))
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
  // session 272: the month the caller's row is about ('YYYY-MM'), or null when
  // nothing in particular. It NEVER changes what is computed -- only what leads.
  focusPeriod?: string | null,
}) {
  const { loan, code, usable, splits, headline, entries, siblingPool, otherLoanByCode, matchKnown, acctMap, skippedForBasis } = o
  const { postingDate, postingWhy, closeDate, today } = o
  const focusPeriod = o.focusPeriod || null
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
    // ── session 272: A CLOSED SPAN IS HISTORY, NOT WORK ─────────────────
    // Session 230 established that a closed month stops generating work, and
    // session 231 that the close date binds WRITES. Neither reached the thing
    // that ACCUSES. This walk happily reported twelve months of red spans on
    // PayPal 2 -- every one of them inside books closed through 2026-06-30,
    // and most of them the accountant's own month-end corrections read at
    // weekly resolution. David: "what should be a straightforward 'here's a
    // suggested adjustment' becomes a 12 month witchhunt."
    //
    // A span is closed only when its END is on or before the close date. A
    // span that STRADDLES the close date stays open -- half its movement is
    // still live, and the same reasoning that makes isPeriodClosed() refuse to
    // close a half-closed month applies here. Unknown means open, always.
    //
    // The flag changes what is REPORTED, never what is COMPUTED: `diff`,
    // `total_period_diff` and `residual` are untouched, so the arithmetic still
    // foots and a closed-period difference still rolls forward into the
    // headline. Hiding the work is the point; hiding the money never is.
    period.closed_period = !!(closeDate && B.statement_date <= closeDate)
    // session 272: a span belongs to the month its CLOSING anchor falls in --
    // the same rule the close band uses to decide which statement settles a
    // month. A span that straddles a month boundary is judged by where it ends.
    period.in_focus = !!(focusPeriod && B.statement_date.slice(0, 7) === focusPeriod)
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

  // ── session 272: THE MONTH IS THE RULER; THE WEEK IS THE MAGNIFYING GLASS ──
  // David: "the problem with the fix is that it identifies mistakes in prior
  // months while ignoring the fixes made by our accountant by making the proper
  // adjustment throughout."
  //
  // This walk asks its question between consecutive LENDER STATEMENTS. On a
  // weekly lender that is a seven-day window. The accountant does not work in
  // seven-day windows -- she corrects at month end, in one journal, covering
  // several weeks at once. So her correction lands inside ONE weekly span and
  // makes it read long, while the weeks it corrects read short. Four true
  // statements about the same book, reported as four errors.
  //
  // Weekly resolution is the right tool to LOCATE an entry and the wrong one to
  // JUDGE a book that is corrected monthly. So the question is asked at the month
  // first: when a month's spans sum to zero, the movement inside it is
  // distribution, not error, and no amount of week-by-week staring will find
  // anything -- there is nothing there. The weeks are still walked, still
  // printed, still carry their own figures; they simply stop generating work.
  // When the MONTH itself does not tie, every span in it keeps the full
  // treatment, which is where the magnifying glass belongs.
  //
  // A span belongs to the month its CLOSING anchor falls in -- the same rule
  // in_focus and the close band use. Grouping by the opening anchor instead would
  // put a payment in the month before the one the lender put it in.
  //
  // WHAT THIS DOES NOT DO: it never nets across a month boundary (that is the
  // offsetting-pair detector's job, and it is deliberately a different rule with a
  // different name), and it changes no figure -- `diff`, `total_period_diff` and
  // `residual` are untouched, so a month that nets still contributes its exact
  // zero and a month that does not still contributes its exact difference.
  const monthGroups = new Map<string, any[]>()
  for (const p of periods) {
    const k = String(p.to).slice(0, 7)
    const g = monthGroups.get(k); if (g) g.push(p); else monthGroups.set(k, [p])
  }
  const months: any[] = []
  for (const [key, group] of monthGroups) {
    const diff = r2(group.reduce((t, p) => t + p.diff, 0))
    const divergentInMonth = group.filter(p => p.verdict === 'divergent')
    // Only spans still considered REAL at this point can be cleared by the month.
    // A timing pair has already been explained by a better rule and keeps its own
    // (more specific) sentence -- two explanations for one span is the defect.
    const unexplained = divergentInMonth.filter(p => !p.timing_pair)
    // ⚠ THE NETTING SUM MUST EXCLUDE WHAT ANOTHER RULE ALREADY EXPLAINED.
    // Caught in review, and it was a real suppression of a real error. The
    // adjacent-pair detector runs BEFORE this and pairs span i with i+1 across a
    // month boundary, which parks one leg's difference inside the later month's
    // total while that leg is NOT eligible to be cleared here. Summing all spans
    // then let the leaked leg cancel a genuine error of the same size:
    //
    //   2026-03-18 → 03-25   −$40.27  ┐ an ordinary cutoff straddle,
    //   2026-03-25 → 04-01   +$40.27  ┘ correctly paired, one leg in April
    //   2026-04-08 → 04-15   −$40.27    a GENUINE error
    //
    // April summed to $0.00, the real span was marked month_nets, and the modal
    // said "the month ties to the cent — nothing to fix". It did not tie.
    //
    // The rule the sum has to obey: a month may only clear what it is actually
    // being asked about. Anything already explained elsewhere is out of both the
    // question and the answer.
    const unexplainedDiff = r2(unexplained.reduce((t, p) => t + p.diff, 0))
    const nets = Math.abs(unexplainedDiff) < TOL && unexplained.length > 0
    if (nets) {
      for (const p of unexplained) {
        p.month_nets = {
          month: key, spans: unexplained.length,
          // Both figures survive: what this span alone reads, and what the month
          // it belongs to reads. A reader can see the claim and reject it.
          span_gap: r2(p.diff), month_gap: unexplainedDiff,
        }
      }
    }
    months.push({
      month: key, from: group[0].from, to: group[group.length - 1].to,
      lender_delta: r2(group.reduce((t, p) => t + p.lender_delta, 0)),
      xero_delta: r2(group.reduce((t, p) => t + p.xero_delta, 0)),
      // `diff` is EVERY span in the month, so the months still foot to the walk.
      // `unexplained_diff` is the question this rule asked. They differ exactly
      // when a pair straddles the boundary, and both are published so the
      // difference is visible rather than a silent choice.
      diff, unexplained_diff: unexplainedDiff,
      span_count: group.length,
      divergent_spans: divergentInMonth.length,
      // Named for what it counts: the spans this month actually cleared.
      netted_spans: nets ? unexplained.length : 0,
      verdict: Math.abs(diff) < TOL ? 'ties' : 'divergent',
      nets_internally: nets,
      closed_period: group.every(p => p.closed_period),
    })
  }

  // ── session 272: PAIRS THAT ARE NOT NEIGHBOURS ─────────────────────────────
  // The v6 detector above compares span i with span i+1 only, because the shape it
  // was written for is a payment dated a day after the cutoff: one span short, the
  // very next one long. Real books produce a second shape it cannot see.
  //
  // PayPal 2, from the screen David sent:
  //     2026-02-25 → 03-04   lender $2,811.55   Xero $2,851.82   off +$40.27
  //     2026-03-18 → 03-25   lender $2,851.82   Xero $2,811.55   off −$40.27
  // Each span carries the OTHER'S lender figure. Two payments recorded against
  // swapped weeks — every dollar present, none of it missing, and three weeks
  // apart so the adjacency check never looked. It reported two errors.
  //
  // WHY THIS IS SAFE, given this module's standing distrust of amount-matching
  // (session 247): the match must be EXACT to the cent, both spans must still be
  // unexplained, the partner must be found within a bounded window, and the match
  // must be UNIQUE in that window — an ambiguous tie refuses rather than guesses,
  // which is session 245's rule for dating a ledger applied to pairing. It can
  // only ever REMOVE a claim of error, never create one, and both spans keep their
  // own figures on the row so a reader can see the claim and reject it.
  //
  // It runs AFTER the month rollup on purpose. A pair inside one month is better
  // explained by "the month ties" — a statement about the book — than by a
  // transposition, which is a statement about two rows. This only sees what the
  // month rule could not: pairs that straddle a month boundary.
  const PAIR_LOOKAHEAD_SPANS = 6
  const PAIR_LOOKAHEAD_DAYS = 45
  const pairable = (p: any) => p.verdict === 'divergent' && !p.timing_pair && !p.month_nets
  const dayGap = (a: string, b: string) =>
    Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
  for (let i = 0; i < periods.length; i++) {
    const a = periods[i]
    if (!pairable(a)) continue
    const hits: any[] = []
    for (let j = i + 1; j < periods.length && j <= i + PAIR_LOOKAHEAD_SPANS; j++) {
      const b = periods[j]
      if (!pairable(b)) continue
      if (dayGap(a.to, b.to) > PAIR_LOOKAHEAD_DAYS) break
      // ⚠ CANCELLATION IS NOT EVIDENCE OF A TRANSPOSITION — CHECK THE SWAP.
      // Caught in review, and the reviewer was right to call it the module's own
      // amount-matching mistake in new clothes. Exact cancellation alone is a
      // coincidence that gets ORDINARY once the window widens to six spans on a
      // weekly loan where the same figures recur: two unrelated $500 errors three
      // weeks apart cancelled, and the walk dismissed both with a confident
      // sentence about a swap that had not happened.
      //
      // The claim being made is specific and it is checkable: each span carries
      // the OTHER'S lender figure. So check exactly that. In the real PayPal 2
      // case it holds to the cent —
      //     2026-02-25 → 03-04   lender $2,811.55   Xero $2,851.82
      //     2026-03-18 → 03-25   lender $2,851.82   Xero $2,811.55
      // — and in the two-unrelated-errors case it does not, so nothing is paired
      // and both stay findings. The check is the sentence; if we cannot make the
      // check we do not get to say the sentence.
      if (Math.abs(r2(a.diff + b.diff)) >= TOL) continue
      const swapped = Math.abs(r2(a.lender_delta - b.xero_delta)) < TOL
        && Math.abs(r2(b.lender_delta - a.xero_delta)) < TOL
      if (!swapped) continue
      hits.push(b)
    }
    // Two possible partners is not a finding about either of them. Leave both
    // spans as they are and let the reader see the amounts.
    if (hits.length !== 1) continue
    const b = hits[0]
    const info = {
      distant: true, kind: 'transposed',
      spans_apart: periods.indexOf(b) - i,
      net: 0, pure: true,
      // Stated, not implied: this is the reason the pairing is believable at all.
      // Stated because it was verified, not because it was assumed: this string
      // is only reachable when the two spans really do carry each other's
      // lender figure to the cent.
      why: `each span carries the other's figure — ${money(Math.abs(a.diff))} recorded against the wrong week, not missing`,
      verified_swap: { a_lender: a.lender_delta, a_xero: a.xero_delta, b_lender: b.lender_delta, b_xero: b.xero_delta },
    }
    a.timing_pair = { role: 'first', with: `${b.from} → ${b.to}`, ...info }
    b.timing_pair = { role: 'second', with: `${a.from} → ${a.to}`, ...info }
  }

  // The misallocation hunt only for spans that remain REAL after pairing.
  // v7: no per-span entry dumps are emitted anymore — the candidates feed the
  // hypothesis bullets and nothing else renders.
  // session 272: and not for a span whose month nets. Hunting a cross-loan
  // candidate for a difference that is not there is precisely how a false lead
  // gets manufactured (session 236's 4140 run) -- and it costs a Xero call.
  for (const period of periods) {
    if (period.verdict !== 'divergent' || period.timing_pair || period.month_nets) continue
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
  // s290: carried even when nothing is proposed, because `refusal` is what lets
  // the card say what would have to change instead of showing an absence.
  let trueUp: any = null
  let cpaException: any = null
  for (const p of periods) {
    if (p.verdict !== 'divergent' || proposal) continue
    // v6: a paired span is timing, not an allocation error — proposing a
    // correction journal for it would CREATE a discrepancy, not close one.
    // session 272: the same is true, for the same reason, of a span whose month
    // nets to zero. Posting a correction there would break a book that balances.
    if (p.timing_pair || p.month_nets) continue

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
  // session 272: the close date gates the FINDING, not just the posting. A
  // divergence inside settled books is stated once, in aggregate, and never
  // enumerated as a hypothesis, a candidate hunt or a thing to go fix.
  const closedDivergent = divergentPeriods.filter(p => p.closed_period && !p.timing_pair)
  const openDivergent = divergentPeriods.filter(p => !p.closed_period)
  // session 272: a span inside a month that nets is not a finding. It keeps its
  // figures and its row; it stops being work.
  const realDivergent = openDivergent.filter(p => !p.timing_pair && !p.explained_by_exception && !p.month_nets)
  const nettedMonths = months.filter(m => m.nets_internally && !m.closed_period)

  // ⚠️ s290: THE TRUE-UP RUNS HERE, NOT WHERE THE OTHER PROPOSALS ARE BUILT.
  // It reads `realDivergent` -- the walk's own verdict on what is still work --
  // and that is computed just above. Placed with the other proposals it threw
  // "Cannot access 'realDivergent' before initialization" on the first test run.
  // Ordering is the guard here: a proposal that outranks the walk's judgement is
  // exactly the plug this module refuses to be.
  // ══════════════════════════════════════════════════════════════════════════
  //  SESSION 290 — THE STALE-SPLIT TRUE-UP IS WIRED AT LAST
  // ══════════════════════════════════════════════════════════════════════════
  // David: "What would make it great is if i could post an adjustment for either
  // of these variances. What's keeping us from proposing a fix?"
  //
  // The answer was that nothing was. `_shared/stale-split-trueup.ts` has computed
  // exactly this correction since session 275 -- 34 passing assertions, the right
  // refusals, Funding Circle's own $15.14 and $15.38 in its header -- and a
  // repo-wide grep for its exports outside its own test returned NOTHING. Its
  // header says "shipping either alone leaves the job half done"; only the
  // re-anchoring half shipped. Same shape as `set_loan_chosen_schedule` (in the
  // database since s277, called from nowhere) and the balance-note write path.
  // ⚠️ WHEN A MODULE'S HEADER SAYS IT IS HALF OF A PAIR, GREP FOR THE OTHER HALF
  // BEFORE BELIEVING IT SHIPPED.
  //
  // ── IT IS A `proposal`, NOT A FIFTH SHAPE, AND THAT IS THE MODULE'S OWN RULE
  // "Deliberately NOT a new write path: it hands back lines for the existing
  // approval → token → server-side re-verify → close-date → duplicate-check
  // machinery to carry." So it builds the same object `post_fix` already posts,
  // and inherits every guard on that path -- including the close date binding the
  // WRITE and not merely the proposal (s231), and the Xero duplicate search that
  // makes a second click a no-op rather than a second journal.
  //
  // ── WHY THIS IS NOT THE PLUG BUTTON DAVID REJECTED IN SESSION 272 ──────────
  // It does not fire on a difference. It fires on a SIGNATURE, and the signature
  // is falsifiable: Xero's movement equals the PREVIOUS period's lender figure to
  // the cent AND does not equal this period's. A mis-keyed amount, a missing
  // payment, a duplicate or a fee lands nowhere near the previous period's
  // principal to the cent. A loan whose books are right produces no signature and
  // therefore no button.
  if (!proposal && !cpaException?.proposed_entry) {
    // The walk's own spans ARE PeriodMovement. `lender_delta`/`xero_delta` are
    // negative for a reduction; the module wants reductions positive.
    const movements = periods
      .slice()
      .sort((a: any, b: any) => String(a.to).localeCompare(String(b.to)))
      .map((p: any) => ({
        period_label: String(p.to).slice(0, 7),
        lender_principal: r2(-Number(p.lender_delta)),
        xero_principal: r2(-Number(p.xero_delta)),
        booked_principal: (() => {
          const sp = (splits || []).find((x: any) => String(x.period_label) === String(p.to).slice(0, 7))
          return sp && sp.principal_amount != null ? Number(sp.principal_amount) : null
        })(),
        closed: !!p.closed_period,
      }))
    // ⚠️ TWO GATES, AND THE SUITE FOUND THE NEED FOR BOTH.
    //
    // (a) ONE ROW PER PERIOD, OR NOT AT ALL. The module compares rows[i-1] to
    //     rows[i] with no adjacency test, because it was written for monthly
    //     periods. On a weekly lender (PayPal 2) several spans collapse to one
    //     'YYYY-MM' label, so consecutive rows can share a period and the
    //     signature can match by coincidence. Refusing is right: a stale SPLIT is
    //     a statement about a period's booked split, and a loan with four spans
    //     in a month does not have one.
    //
    // (b) THE WALK'S OWN JUDGEMENT OUTRANKS THE SIGNATURE. `tests/find-difference-walk`
    //     caught this on the first run: a correction was offered inside a month
    //     the walk had already explained as internally netting. A span the walk
    //     has ruled out as work -- a timing pair, a netting month, one the
    //     accountant already handled -- must not become a journal because a
    //     coincidence upstream looks like the fingerprint. So the RESULT is
    //     filtered, not the input: filtering the input would silently compare
    //     across a gap, which is a worse bug than the one it fixes.
    const labels = movements.map((m: any) => m.period_label)
    const duplicated = labels.some((l: string, i: number) => i > 0 && l === labels[i - 1])
    const tu = duplicated
      ? { correctable: [], closed_periods: [], total: 0,
          refusal: 'This lender reports more than once a month, so a period does not have a single booked split to be stale — the true-up does not apply here.' }
      : findStaleSplits(movements)
    const workable = new Set(realDivergent.map((p: any) => String(p.to).slice(0, 7)))
    const gated = tu.correctable.filter((r: any) => workable.has(r.period_label))
    const gatedOut = tu.correctable.filter((r: any) => !workable.has(r.period_label))
    trueUp = {
      correctable: gated, closed_periods: tu.closed_periods, total: r2(gated.reduce((t: number, r: any) => t + (r.direction === 'interest_back_to_loan' ? r.amount : -r.amount), 0)),
      refusal: gated.length ? null : (tu.refusal
        || (gatedOut.length
          ? `${gatedOut.length} period${gatedOut.length === 1 ? '' : 's'} carry the previous period's split, but the walk has already accounted for ${gatedOut.length === 1 ? 'that span' : 'those spans'} — as timing, as a month that nets, or as work your accountant has done. Nothing is proposed over an explanation that already exists.`
          : null)),
    }
    if (gated.length) {
      tu.correctable = gated
      tu.total = trueUp.total
      // ⚠️ MIXED DIRECTIONS ARE REFUSED RATHER THAN NETTED. Two corrections that
      // point opposite ways may both be right, but one journal for their net
      // states a figure neither period owns, and the card would have to describe
      // it as something no statement says. Rare enough to refuse and say so.
      const dirs = new Set(tu.correctable.map((r: any) => r.direction))
      if (dirs.size > 1) {
        trueUp.refusal = `${tu.correctable.length} periods carry the previous period's split but they correct in opposite directions, so no single journal states them honestly. They need to be worked one at a time.`
      } else {
        const direction = tu.correctable[0].direction
        const amount = r2(Math.abs(tu.total))
        const card = trueUpCard(tu.correctable, loan.xero_account_name || 'this loan')
        // Dated at the END of the latest period it corrects, which is where an
        // accountant looks for it -- moved forward only when that month is
        // closed or closing, exactly as the lump correction above does.
        const latest = tu.correctable[tu.correctable.length - 1].period_label
        const naturalDate = endOfMonthLabel(latest)
        const protectedDate = isProtectedDate(naturalDate, closeDate, today)
        const journalDate = protectedDate ? postingDate : naturalDate
        const periodsText = tu.correctable.map((r: any) => r.period_label).join(', ')
        proposal = {
          kind: 'stale_split_trueup',
          period: periodsText,
          span: { from: tu.correctable[0].period_label, to: latest },
          amount, direction,
          dated_into: journalDate,
          dated_because: protectedDate
            ? `${naturalDate} sits in a period that is closed or closing, and ${postingWhy} — so the correction lands at ${journalDate} instead`
            : `${latest} is still open, so the correction is dated at that period's end`,
          based_on: card.plain_english,
          trueup_working: card.working,
          trueup_rows: tu.correctable,
          journal: {
            Narration: `${loan.xero_account_name} — stale split true-up, ${periodsText} [WR-TRUEUP ${code} ${journalDate}]`,
            Date: journalDate, Status: 'POSTED',
            JournalLines: trueUpJournalLines({
              amount, direction,
              loanAccountCode: String(code),
              interestAccountCode: INTEREST_EXPENSE_ACCOUNT_CODE,
              loanName: loan.xero_account_name || 'this loan',
            }).map((l: any) => ({ ...l, AccountName: acctMap[l.AccountCode] ?? null })),
          },
          token: proposalToken(loan.id, `trueup:${periodsText}`, amount, direction, journalDate),
        }
      }
    }
  }


  // ⚠ A PAIR IS ONE EVENT, SO ITS CLOSEDNESS IS A PROPERTY OF THE PAIR.
  // Caught in review. `pairFirsts` used to filter on the FIRST leg's own
  // close flag, and `closedDivergent` excludes anything paired -- so a pair
  // straddling the close date fell into the hole between them:
  //
  //   2026-06-17 → 06-24   −$1,000   closed  ┐ one ordinary cutoff straddle
  //   2026-06-24 → 07-01   +$1,000   open    ┘
  //
  // The closed leg was in no count (paired, so not "closed divergent"; closed,
  // so not "flagged"), and because the first leg was closed there was no pair
  // sentence either. The walk emitted ZERO conclusions about $1,000 of movement:
  // two grey rows and an empty explanation box. That is the denominator quietly
  // shrinking, which is the exact thing session 262 forbids.
  //
  // So a pair is spoken about whenever ANY leg of it is open, and the counts
  // below are taken over SPANS rather than over pairs, so a half-closed pair
  // contributes the one leg that is actually open and the arithmetic still adds up.
  const pairFirsts = periods.filter(p => {
    if (p.timing_pair?.role !== 'first') return false
    const partner = periods.find(q => q.timing_pair?.role === 'second' && q.timing_pair.with === `${p.from} → ${p.to}`)
    return !p.closed_period || !(partner?.closed_period ?? true)
  })
  // Explained-and-open, counted directly. `pairFirsts.length * 2` would overcount
  // a straddling pair by the leg that is closed.
  const openPairLegs = periods.filter(p => p.timing_pair && !p.closed_period).length
  const conclusions: string[] = []
  // s279: set when the focus bullet has already said the lender and Xero agree,
  // so the closed-books line below does not say it a second time.
  let focusTiesStated = false

  // ── session 272: THE FOCUS MONTH LEADS ─────────────────────────────────────
  // The caller's row is about one month. If this walk has nothing to say about
  // that month, that IS the answer -- and it is the answer PayPal 2 needed: the
  // Loans row measured August against a statement dated 2026-08-05, while the
  // walk's most recent span ended in May. Saying "no span covers August" turns a
  // twelve-month hunt into one sentence and one missing document.
  //
  // This only ever REORDERS and ANNOTATES. No span is dropped for being out of
  // focus, and the counts, totals and residual are untouched.
  const focusSpans = focusPeriod ? periods.filter(p => p.in_focus) : []
  if (focusPeriod && !focusSpans.length) {
    const lastAnchor = usable[usable.length - 1]?.statement_date
    // ⚠ "nothing here to investigate" is only true when there is nothing here to
    // investigate. Caught in review: with three real open findings below it, this
    // was the first sentence a reader saw and it contradicted every one of them.
    // The claim about the FOCUS MONTH is unconditional; the claim about the whole
    // walk is not, and must be earned.
    // ── s289 rule D/E: SAY THE ASK, NOT THE REASONING BEHIND IT ────────────
    // 45 words became 20. What went: the clause restating which month the row is
    // about (the modal title already says it), and the clause promising there is
    // nothing to investigate (the ✓ line says what is outstanding, so saying it
    // here made one card state the same reassurance twice).
    //
    // ⚠️ Those two clauses are NOT quoted here on purpose. copy-budget.test.mts
    // asserts their absence from this file, and a comment naming them verbatim
    // makes that assertion pass forever — a guard defeated by the note
    // explaining the guard. It caught exactly that on the first run.
    // The DATE we hold stays -- it is the one fact a reader cannot get from
    // anywhere else on the card, and it is what tells them which file to fetch.
    // ⚠️ s289: NAME THE DATE FOR WHAT IT IS. `lastAnchor` is a BALANCE date --
    // on a due_date lender it is nothing like the date on the document -- and
    // this sentence used to call it "the newest lender statement on file",
    // which told David his September upload was missing while it sat on the
    // row. The filed date is what he recognises; the balance date is what the
    // walk can use; the sentence now carries both and asks for neither when the
    // document is already here.
    const lastFiled = usable[usable.length - 1]?.filed_date
    const heldPhrase = lastFiled && lastFiled !== lastAnchor
      ? `the newest balance we can use is ${lastAnchor}, from the statement filed ${lastFiled}`
      : `the newest balance we hold is ${lastAnchor}`
    conclusions.push(
      `Nothing on file yet places a balance inside ${monthName(focusPeriod)} — ${heldPhrase}. Upload that month's statement and this row can be measured`
      + (realDivergent.length
        ? `. Separately, ${realDivergent.length} earlier span${realDivergent.length === 1 ? '' : 's'} still ${realDivergent.length === 1 ? 'needs' : 'need'} a look — below.`
        : `.`))
  } else if (focusPeriod && focusSpans.every(p => p.verdict === 'clean')) {
    // ── s289: THE FOCUS-TIE BULLET EARNS ITS PLACE ONLY WHEN SOMETHING ELSE
    //    IS OFF ─────────────────────────────────────────────────────────────
    //
    // David, on the card the anchor fix had just improved: this bullet said
    // "Every span in August 2026 ties to the cent" directly above a ✓ line
    // reading "Jun 22, 2026 → Aug 24, 2026 ties to the cent, nothing else
    // outstanding". Same claim, and the second range CONTAINS the first.
    //
    // ⚠️ THE DUPLICATION WAS CREATED BY §0ae, WHICH IS THE INTERESTING PART.
    // Those two sentences had never overlapped before, because until the walk
    // could see the September balance the focus month had NO SPAN — this
    // branch could not be reached with everything tying. A fix widened the
    // walk and, in doing so, made a previously-disjoint pair of statements
    // collide. The dedup assertion missed it because no fixture carried the
    // shape (all spans clean AND a focus month present), which is the s245
    // lesson again: an assertion only ever measures the payloads it is given.
    //
    // So the bullet says something worth saying ONLY when the reader's month is
    // fine and the trouble is elsewhere — "yours is clean, look below". With
    // nothing off anywhere, the ✓ line makes the same claim over a wider range
    // and makes it better, so this one goes. `focusTiesStated` is still set
    // either way: the closed-books line below must not restate it (s279).
    if (realDivergent.length) {
      conclusions.push(
        `Every span in ${monthName(focusPeriod)} ties to the cent — the rest of this walk is where the difference is.`)
    }
    focusTiesStated = true
  }

  // The exception is the most confident statement the engine can make about a
  // span: every number in it is a recorded fact, not a candidate. It leads.
  //
  // session 272: unless its span is CLOSED. PayPal 2 led with a $15,671.08
  // exception on 2025-12-24 → 2025-12-31 -- nine months inside settled books,
  // proposing nothing, and it was the first thing a reader saw. It folds into
  // the closed-books line below instead; the detail card still renders.
  // ⚠ AND ONLY WHEN IT PROPOSES NOTHING. Caught in review. A correction for a
  // payment inside a closed month is legitimate -- session 234 re-dates it into
  // the first month the accountant can actually post into, which is why the
  // Approve button exists at all. Folding its sentence into the closed-books line
  // while leaving that button on screen produced a modal that said "Nothing to
  // do" directly above a live button posting $15,671.08. Suppress the headline
  // only when there is genuinely nothing to act on.
  const cpaExceptionInClosedSpan = !!(cpaException && periods.find(p => p.from === cpaException.period?.from)?.closed_period)
  const cpaExceptionClosed = cpaExceptionInClosedSpan && !cpaException?.proposed_entry
  if (cpaException?.diagnosis && !cpaExceptionClosed) {
    const dg = cpaException.diagnosis
    const sp0 = cpaException.period
    const comps = (dg.components || [])
    const booked = comps.filter((c: any) => c.already_booked)
    // ── session 279: A CLAIM IS STATED ONCE PER SCREEN ────────────────────
    // This bullet used to spell out the month list and the at-source figure,
    // both of which are the exception table rendered a few centimetres below
    // it -- 42 words to say what the reader was about to read anyway. It now
    // states only what leads: the span, its gap, the cause in one clause, and
    // the action. Every figure removed is still on screen, in the table.
    // The span and its gap are the table's own row and the fold summary above
    // it; this bullet is the DECISION, so it leads with the money that gets
    // written and names the payment once (s279).
    let s = `Your accountant's own split on the ${cpaException.entry?.date} payment `
    // session 272: `booked.length === comps.length` is also true when BOTH are
    // zero, which printed the nonsense "and all 0 of those months were already
    // booked" on PayPal 2. An empty decomposition is not a statement that
    // everything was booked -- it is a statement that we could not decompose it.
    s += comps.length === 0
      ? `could not be decomposed into months. `
      : booked.length === comps.length
        ? `duplicates interest we had already booked. `
        : `duplicates ${money(dg.duplicated)} of interest we had already booked. `
    s += cpaException.proposed_entry
      ? `Approve the prepared ${money(cpaException.proposed_entry.amount)} correction below — nothing else to fix in this span.`
      : `Nothing is proposed: see the detail below.`
    s = s.charAt(0).toUpperCase() + s.slice(1)
    conclusions.push(s)
  }

  // ── session 272: THE LINES THAT SAY "NOTHING TO DO" ────────────────────────
  // Four rules can now explain a span away, and each wanted its own sentence.
  // With David's 3-4 bullet cap that starved the actual findings: a walk with a
  // focus line, a timing line and a month line spent three of its four bullets
  // before naming a single thing to fix, and the "1 more span" roll-up — the line
  // that guarantees nothing is dropped — fell off the end.
  //
  // So they are collected here and emitted AFTER the work, and when more than one
  // applies they collapse into a single sentence. No claim is lost: each clause
  // keeps its own count, and the money and the months stay in the fields and on
  // the rows. LESS IS BEST, applied to the reassurances rather than the findings.
  const noAction: string[] = []
  // s279: true when the closed-books sentence is already made by the client's
  // closed-spans fold, so it is not also made as a bullet.
  // Its INDEX, not a boolean: `slice(0, -1)` would silently drop the wrong
  // sentence the day a category is added after this one.
  let closedCarriedByFold = -1
  const noActionShort: string[] = []
  // session 272: a distant pair is a DIFFERENT story from an adjacent one and gets
  // its own sentence. Folding both into "a payment dated just after the cutoff"
  // would describe a transposition as something it is not — and a sentence that is
  // wrong beside a number that is right is the harder mistake to catch (s247).
  const distantFirsts = pairFirsts.filter(p => p.timing_pair.distant)
  const adjacentFirsts = pairFirsts.filter(p => !p.timing_pair.distant)
  // Legs, not pairs — see openPairLegs above.
  const distantLegs = periods.filter(p => p.timing_pair?.distant && !p.closed_period).length
  const adjacentLegs = periods.filter(p => p.timing_pair && !p.timing_pair.distant && !p.closed_period).length
  if (distantFirsts.length) {
    const ex = distantFirsts[0]
    noAction.push(
      `${distantLegs} flagged span${distantLegs === 1 ? '' : 's'} pair off exactly across the weeks between them `
      + `(e.g. ${ex.from} → ${ex.to} and ${ex.timing_pair.with}, ${money(Math.abs(ex.diff))} each way) — `
      + `each span carries the other's figure, so the money is recorded against the wrong week rather than missing. Nothing to fix.`)
    noActionShort.push(`${distantLegs} pair off across the weeks between them`)
  }
  if (adjacentFirsts.length) {
    const purePairs = adjacentFirsts.filter(p => p.timing_pair.pure)
    const resPairs = adjacentFirsts.filter(p => !p.timing_pair.pure)
    const straddleEx = adjacentFirsts.find(p => p.timing_pair.straddler)?.timing_pair.straddler
    let s = `${adjacentLegs} of ${openDivergent.length} flagged spans are timing, not errors — a payment dated just after the cutoff lands in the next span`
    if (straddleEx) s += ` (e.g. ${money(straddleEx.amount)} on ${straddleEx.date})`
    s += purePairs.length === adjacentFirsts.length
      ? `. They cancel to $0.00 — nothing to fix.`
      : `. They cancel${resPairs.length ? ` to within ${resPairs.map(p => `${money(p.timing_pair.net)}${p.timing_pair.residue ? ` (${p.timing_pair.residue.what})` : ''}`).join(' and ')}` : ''} — nothing to fix.`
    noAction.push(s)
    noActionShort.push(`${adjacentLegs} are timing, a payment landing just after a cutoff`)
  }

  // ── session 272: THE MONTH-NETS LINE ───────────────────────────────────────
  // One sentence for the whole shape, with the months named and the money in it,
  // because the reader has to be able to disagree. It says what happened (a
  // correction covering several weeks landed in one of them) and what to do
  // (nothing) -- not "unresolved", which is what these rows used to read as.
  if (nettedMonths.length) {
    // netted_spans, NOT divergent_spans: the latter counts paired legs this
    // sentence is not talking about, so it read "2 flagged spans ... $40.27".
    const spans = nettedMonths.reduce((n, m) => n + m.netted_spans, 0)
    const gross = money(nettedMonths.reduce((t, m) =>
      t + periods.filter(p => p.month_nets && p.month_nets.month === m.month).reduce((u, p) => u + Math.abs(p.diff), 0), 0))
    noAction.push(
      `${spans} flagged span${spans === 1 ? '' : 's'} in ${nettedMonths.map(m => monthName(m.month)).join(', ')} `
      + `cancel out within ${nettedMonths.length === 1 ? 'that month' : 'their own months'} — ${gross} moved between weeks, `
      + `${nettedMonths.length === 1 ? 'the month' : 'each month'} ties to the cent. `
      + `That is a month-end correction landing in one week and the weeks it corrects reading short; nothing to fix.`)
    noActionShort.push(`${spans} cancel out within ${nettedMonths.map(m => monthName(m.month)).join(' and ')}`)
  }

  // One hypothesis bullet per REAL span (at most two spelled out). v8: half
  // the words — David: "Reduce by 50%."
  const candDesc = (c: any) => c.direction === 'maybe_belongs_elsewhere'
    ? `the ${money(c.amount)} payment (${c.date}) coded here likely belongs to another loan`
    : `the ${money(c.amount)} ${c.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${c.date}) on ${c.coded_to?.loan_name || 'another loan'}${c.same_lender ? ' — same lender —' : ''} likely belongs here`
  // ── session 273 cont.: AN ENTRY THAT CANNOT EXPLAIN THE GAP IS NOT A LEAD ──
  // David, on Funding Circle: the conclusions offered "the $457.14 journal
  // (2026-08-31) on Rapid Credit Line likely belongs here. Recode it and re-run"
  // to explain a gap of $15.38. The amounts are not close and were never claimed
  // to be -- `in_span` means only "this entry fell inside the same date window
  // and is coded to another loan". crossLoanCandidatesFor() already knows that
  // and words its own `question` honestly ("sits inside this divergent span --
  // worth confirming"). This bullet threw the tier away and promoted every
  // candidate to "likely belongs here", with an instruction to go and recode it.
  //
  // That is the witch hunt David objected to in session 272, generated one loan
  // at a time: a confident wrong lead costs more than no lead, because someone
  // acts on it. Only `explains_exactly` and `explains_with_known` are arithmetic
  // claims -- the gap equals the amount, or equals it once a named figure is set
  // aside. Nothing else may be phrased as an explanation or carry "recode it".
  //
  // NOTHING IS DROPPED (the ce17 limit): weak candidates keep their own
  // `question`, stay in `cross_loan_candidates`, and the count of what was
  // considered is stated, so the reader can see the denominator did not quietly
  // shrink (s262) -- they simply stop being announced as the answer.
  const explanatory = (c: any) => !!c && (c.confidence === 'explains_exactly' || c.confidence === 'explains_with_known')
  // ── SESSION 290: THE CAUSE BELONGS TO THE ROW, NOT TO A PARAGRAPH ABOVE IT
  //
  // David, on the Funding Circle card: it opened with three bullets, and the
  // table directly beneath them stated the same spans, the same amounts and the
  // same verdicts. Measured: 229 visible words against a 225 budget, $1,041.09
  // three times, $15.38 and $15.14 twice each, the anchor date three times.
  //
  // This function used to return `${from} → ${to} is off by ${gap} — <cause>`,
  // and EVERY WORD BEFORE THE DASH is what the row already says. s279's own
  // wording: "a per-month figure is the table's row, never a paragraph above
  // the table". So the prefix goes and what is left — the cause, which the
  // table could not say — is attached to the period and rendered ON the row.
  //
  // "(dates in the table)" goes with it. It was a pointer from a paragraph to
  // a table; on the row it points at itself.
  //
  // ⚠️ NOTHING IS DELETED (ce17). The cause is not dropped, it is rehoused, and
  // it now reaches EVERY divergent span rather than the first two — the roll-up
  // bullet that stood in for the rest ("1 more span … fix the above, then
  // re-run") said only a count and a figure the fold summary already carries.
  const causeFor = (p: any) => {
    const gap = money(Math.abs(p.diff))
    const cands = p.cross_loan_candidates || []
    const c1 = cands[0]
    if (p.culprit?.kind === 'duplicate_suspected' && p.culprit.entry) {
      return `likely a duplicate: the ${money(Math.abs(p.culprit.entry.effect_on_loan))} entry on ${p.culprit.entry.date}. Remove the copy and re-run.`
    }
    if (!c1) return `no clear candidate — one for your CPA.`
    // Nothing on file can account for the gap. Say so, say what WAS looked at,
    // and -- only where the shape genuinely warrants a look (a sibling loan of
    // the SAME lender, which is how a payment lands on the wrong one) -- name
    // the nearest entry as something to CONFIRM, never to recode.
    if (!explanatory(c1)) {
      const looked = cands.length === 1 ? '1 entry sits' : `${cands.length} entries sit`
      const sib = cands.find((c: any) => c.same_lender)
      const base = `nothing on file explains it (${looked} inside the span; none matches the amount)`
      return sib
        ? `${base}. Closest worth a look: the ${money(sib.amount)} ${sib.src_type === 'ManualJournal' ? 'journal' : 'payment'} (${sib.date}) on ${sib.coded_to?.loan_name || 'a sibling loan'} — same lender, so worth confirming it went to the right loan. The amount does not match this gap, so confirm it rather than recode it.`
        : `${base} — one for your CPA.`
    }
    const c2 = cands[1]
    // Both legs of an "either/or" must be able to explain the gap -- offering a
    // real candidate beside one that cannot is worse than offering one alone.
    const secondStrong = explanatory(c2)
    if (secondStrong) {
      return `either ${candDesc(c1)}, or ${candDesc(c2)}. Fix the right one and re-run.`
    }
    let s = `${candDesc(c1)}. Recode it and re-run`
    if (c1.explains_after) s += `; the span should close to ~${money(c1.explains_after.amount)}`
    else if (c1.confidence === 'explains_exactly') s += `; the span should tie`
    s += `.`
    return s
  }
  // session 272: the month the reader asked about is spelled out before any
  // other. A stable sort -- in-focus spans keep their chronological order, and so
  // does everything else; only the two groups swap places.
  const ordered = focusPeriod
    ? [...realDivergent.filter(p => p.in_focus), ...realDivergent.filter(p => !p.in_focus)]
    : realDivergent
  // s290: attached, not pushed. `realDivergent` holds the SAME objects the
  // client renders as rows (they come straight off `periods`), so writing the
  // cause here puts it on the row without a second lookup that could drift.
  // Every divergent span gets one — the cap of two existed because bullets
  // compete for a reader's attention and rows do not.
  for (const p of ordered) p.cause = causeFor(p)

  // ── session 272: THE CLOSED-BOOKS LINE ──────────────────────────────────
  // One sentence for the whole of settled history, never a list. It states the
  // count and the money so nothing is deleted (the LESS IS BEST limit), names
  // who closed the period, and says plainly that there is nothing to do -- which
  // is the actual answer, not a softer way of saying "unresolved". The spans
  // themselves stay in the table, greyed, for anyone who wants to look.
  if (closedDivergent.length) {
    const tot = r2(closedDivergent.reduce((t, p) => t + p.diff, 0))
    const first = closedDivergent[0], last = closedDivergent[closedDivergent.length - 1]
    const span = closedDivergent.length === 1 ? `${first.from} → ${first.to}` : `${first.from} → ${last.to}`
    noActionShort.push(`${closedDivergent.length} sit in books closed through ${closeDate}${Math.abs(tot) >= TOL ? ` (${money(Math.abs(tot))})` : ''}`)
    noAction.push(
      `${closedDivergent.length} span${closedDivergent.length === 1 ? '' : 's'} (${span}) sit${closedDivergent.length === 1 ? 's' : ''} inside books closed through ${closeDate}`
      + `${Math.abs(tot) >= TOL ? `, ${money(Math.abs(tot))} in total` : ''} — your accountant has already settled those months with her own adjustments. `
      + `Nothing to do; they are listed below for reference only.`)
    // ── session 279: A CLAIM IS STATED ONCE PER SCREEN ──────────────────────
    // The client's own closed-books fold is this sentence: it states the count,
    // the money, that they are settled and that they are there for reference,
    // and it sits directly under the table it is about. A bullet repeating it
    // is the second statement, and on 4140 it spent 34 of 420 visible words
    // doing so. It stays, unabridged, in `no_action_detail` -- which the client
    // now renders behind "Show the working" even when it holds a single entry,
    // so the claim is one click away rather than deleted (the ce17 limit).
    // Every OTHER no-action category has no such fold, so it still speaks.
    closedCarriedByFold = noAction.length - 1
  }

  // One category keeps its full, specific sentence. Two or more collapse, because
  // three reassurances in a row is how the findings got pushed off the screen.
  const visibleNoAction = noAction.filter((_, i) => i !== closedCarriedByFold)
  const visibleShort = noActionShort.filter((_, i) => i !== closedCarriedByFold)
  if (visibleNoAction.length === 1) conclusions.push(visibleNoAction[0])
  else if (visibleNoAction.length > 1) {
    const total = openPairLegs + periods.filter(p => p.month_nets && !p.closed_period).length
      + (closedCarriedByFold >= 0 ? 0 : closedDivergent.length)
    conclusions.push(`${total} flagged span${total === 1 ? '' : 's'} need no action: ${visibleShort.join('; ')}. The rows are below with their figures.`)
  }
  // The unabridged sentences survive the collapse and ship every time, so the
  // client can offer them behind "Show the working". A claim that leaves the
  // visible text has to live somewhere, or the cut is a deletion (ce17).
  const noActionDetail = noAction.slice()

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
    const sentence = `${money(Math.abs(residual))} predates the earliest usable statement (${winFrom})${k ? ` — equals ${k.what}` : ''}; ${tail}.`
    // ── session 289: AN ESTABLISHED CAUSE OUTRANKS THE ASK ──────────────────
    //
    // David, on the EIDL SBA card. A human had recorded what the $5.00 IS —
    // the SBA added it between the March and April 2026 payments, proven by
    // three statements, with a date and a source document. Directly underneath,
    // this bullet said the $5.00 "predates the earliest usable statement" and
    // sent the reader off to mark nine statements principal-only "to pin it
    // down". Both sentences were true of their own inputs: the WALK cannot see
    // before its window, and it never knew the note existed — `balanceNoteOf`
    // runs at the response, five hundred lines from here, and nothing carried
    // it in. So the card asked a bookkeeper to go and establish a fact that the
    // paragraph above it had already established, in the one place they had no
    // reason to doubt.
    //
    // That is session 262's rule exactly ("ask when evidence is missing; STATE
    // the cause when it is established"), and s279's at screen level: two
    // sections answering "what is this?" and disagreeing about the answer.
    //
    // The test is narrow on purpose. The note is written about the WHOLE
    // books-vs-lender difference, so it only answers this bullet when the
    // residual IS that difference — a note explaining $5.00 of a $500.00 gap
    // leaves the other $495.00 genuinely unexplained, and the ask still earns
    // its place. `balanceNoteOf` supplies "current": a note with no recorded
    // amount is stale by construction, so this can never fail open (s245).
    const note = balanceNoteOf(loan, headline?.difference ?? null)
    const noteAnswersIt = !!note && !note.stale && headline?.difference != null
      && Math.abs(Math.abs(r2(Number(headline.difference))) - Math.abs(residual)) <= TOL
    // NOTHING IS DELETED (ce17). It moves behind "Show the working", where the
    // reader who distrusts the note still finds the walk's own account of the
    // same figure, unabridged and in the same words.
    if (noteAnswersIt) noActionDetail.push(sentence)
    else conclusions.push(sentence)
  }
  // session 272: "every span ties" is now a statement about the OPEN book. Saying
  // it while closed spans diverge would be false; saying nothing at all when the
  // open book is clean would leave the reader without the one answer they came
  // for. So it states the open result and names the closed ones it is excluding.
  if (!openDivergent.length && !nettedMonths.length && !pairFirsts.length) {
    // The "Xero and the lender agree" clause is the focus bullet's, when there
    // is one -- saying it twice on one screen is the s279 defect (a claim is
    // stated once). Without a focus bullet this is the only place it is said.
    // s279: with a focus bullet on screen, this sentence is made twice — once
    // for the focus month above, and once by every open fold's own "— all tie".
    // Without one it is the only place the open book is spoken about, so it
    // stays. The claim never disappears; only the second statement of it does.
    if (!focusTiesStated) {
      conclusions.push(closedDivergent.length
        // ⚠️ s289 rule D: A RANGE IS STATED BY THE THING IT GOVERNS. This
        // bullet used to carry `(${winFrom} → ${winTo})` while the client's ✓
        // line carried the FOCUS month's range -- so one card stated the same
        // claim with two different ranges, and a reader could not reconcile
        // them. The ✓ line owns the range now; this sentence owns the verdict.
        ? `Every span since the books closed ties to the cent.`
        : `Every span ties to the cent — Xero and the lender agree completely.`)
    }
  }
  const finalConclusions = conclusions.slice(0, 4)

  return {
    periods, agree_until: lastClean, total_period_diff: totalPeriodDiff, residual,
    proposal, cpa_exception: cpaException, conclusions: finalConclusions,
    // s290: the true-up's result travels whether or not it proposed anything.
    trueup: trueUp,
    // session 272: divergent_count is what a reader treats as "things to go and
    // fix", so it must mean exactly that -- open, and not already explained by the
    // close date, a timing pair, the month rollup or the accountant's own entry.
    // Until now it counted every flagged span, which is why a walk that had
    // explained all twelve of its spans still announced twelve.
    //
    // The denominator does not vanish with it: flagged_span_count is the number
    // BEFORE any explanation, and every explained span is itself counted below.
    // A number that quietly shrinks is not a gate (session 262).
    divergent_count: realDivergent.length,
    flagged_span_count: openDivergent.length,
    timing_pair_span_count: openPairLegs,
    month_netted_span_count: periods.filter(p => p.month_nets && !p.closed_period).length,
    closed_divergent_count: closedDivergent.length,
    closed_divergent_total: closedDivergent.length ? r2(closedDivergent.reduce((t, p) => t + p.diff, 0)) : 0,
    close_date: closeDate,
    cpa_exception_closed: cpaExceptionClosed,
    focus_period: focusPeriod,
    focus_span_count: focusSpans.length,
    // session 272: the month rollup is the ruler the walk is now judged by, so it
    // is part of the answer, not an internal. The weekly spans stay in `periods`.
    months,
    netted_month_count: nettedMonths.length,
    no_action_detail: noActionDetail,
    win_from: winFrom, win_to: winTo,
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
// Returns the duplicate if one exists, null if we positively confirmed there is
// none, and THROWS if we could not find out.
//
// Session 240 correction: this used to `return null` when the lookup failed —
// "Xero unreachable: fall through to the post rather than block a legitimate
// correction". That is backwards, and `loan-xero-post` has had the right answer
// since the staging work: when its own Reference pre-check fails it returns 502
// and says **"refusing to stage blind"**. A failed lookup is not evidence of
// absence. The scenario the check exists for is precisely a transient GET
// failure followed by a POST that succeeds — which is how you get the second
// journal. Refusing costs a retry; falling through costs a duplicate in the
// customer's books, and this module's whole contract is that that never happens.
async function alreadyPostedInXero(narration: string, date: string, headers: Record<string, string>): Promise<any | null> {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number)
  const w = encodeURIComponent(`Date==DateTime(${y},${m},${d})&&Status=="POSTED"`)
  let res: Response
  try {
    res = await fetch(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${w}`, { headers })
  } catch (e) {
    throw new Error(`Could not reach Xero to check whether this correction is already posted (${String((e as Error)?.message || e)}) — refusing to post blind.`)
  }
  if (!res.ok) throw new Error(`Could not check Xero for an existing copy of this correction (status ${res.status}) — refusing to post blind.`)
  const json = await res.json().catch(() => null)
  if (!json) throw new Error('Xero returned an unreadable response to the duplicate check — refusing to post blind.')
  const hit = (json?.ManualJournals || []).find((j: any) => String(j?.Narration || '').trim() === String(narration).trim())
  return hit ? { id: hit.ManualJournalID, narration: hit.Narration, date: normDate(hit.DateString, hit.Date) } : null
}

const duplicateJournalError = (hit: any) =>
  `This correction is already in Xero — manual journal ${String(hit.id || '').slice(0, 8)} ("${hit.narration}") dated ${hit.date}. Nothing was posted a second time. Run a reconciliation check to see where the loan stands now.`

// ── session 234: the posting window, computed once per request ──────────────
// Session 231's lesson, applied: the close date binds WRITES, not just what we
// propose. This org's Xero carries no lock date, so nothing downstream will
// refuse a journal dated into a settled month -- this is the only thing that
// will. Every proposal gets its date from here, and both post paths re-check it
// against the freshly-computed value before touching Xero.
/**
 * A human's recorded explanation of this loan's difference, with the one fact
 * that keeps it honest: WHAT FIGURE IT WAS WRITTEN ABOUT.
 *
 * An explanation of a $5.00 difference must not keep explaining a $500.00 one.
 * A note is a suppression — it turns a red question into a settled one — so it
 * earns the same test session 245 gave dismissals: a suppression that cannot
 * verify what it is suppressing must let the finding through. When the live
 * difference has moved, the note is returned STALE rather than withheld, because
 * what somebody found out last month is still worth reading; it just stops
 * counting as the answer.
 */
function balanceNoteOf(loan: any, difference: number | null) {
  const text = typeof loan?.balance_note === 'string' ? loan.balance_note.trim() : ''
  if (!text) return null
  const writtenAbout = loan.balance_note_amount == null ? null : r2(Number(loan.balance_note_amount))
  // No amount on file cannot be treated as "still current" — that is the failing-
  // open shape. It is stale until somebody says what it was about.
  const stale = writtenAbout == null || difference == null
    ? true
    : Math.abs(writtenAbout - r2(difference)) > TOL
  return {
    text,
    written_about: writtenAbout,
    set_by: loan.balance_note_set_by ?? null,
    set_at: loan.balance_note_set_at ?? null,
    stale,
    stale_why: !stale ? null
      : writtenAbout == null
        ? 'this explanation does not record which figure it was written about, so it cannot be confirmed as still current'
        : `this explanation was written about ${money(Math.abs(writtenAbout))} and the difference is now ${money(Math.abs(difference ?? 0))}`,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// THE WRITE-OFF: the one correction NOT derived from a diagnosis (session 284)
// ═══════════════════════════════════════════════════════════════════════════
// David: "person clicks Find the fix, sees a history and/or explanation, is
// proposed a one-time post/adjustment, clicks Post or Ignore."
//
// Every other entry this file proposes is built FROM a cause. `proposal`
// reallocates one identified lumped payment; diagnose-exception refuses to
// propose anything unless its entry equals the span's gap to the cent. Those are
// safe because the arithmetic has to work out before a button appears.
//
// A write-off has no such property. It is, by definition, the amount nobody
// could explain -- so it is the only posting path here capable of becoming a
// plug machine, and the reason it is fenced this hard. The fences:
//
//  1. IMMATERIAL ONLY, by the shared policy (_shared/materiality.ts), not a
//     threshold invented for this feature. Above it there is no button and the
//     difference must be diagnosed. This is the fence that matters: it is what
//     stops "tidy up $5" from becoming "make $2,000 go away".
//  2. NOTHING WAS DIAGNOSED -- no proposal, no CPA exception, no self-diagnosis
//     on the finding. If any of those produced an answer, that answer is the
//     action, and a write-off would be papering over a fix we already have.
//  3. THE SEARCH ACTUALLY RAN AND CAME BACK EMPTY. The span walk found nothing
//     to attribute, and the fingerprint hunt matched no live transaction of that
//     amount. A crash, a timeout or an unexamined span must never present as
//     "unexplained" -- that would turn a failure to look into a licence to post.
//  4. THE WHOLE GAP IS THE UNEXPLAINED PART. If later entries account for some
//     of it, the remainder is a different question with a different answer.
//  5. A REAL LENDER DOCUMENT anchors the comparison. Writing our books off to
//     agree with our own arithmetic would be circular -- session 246's rule.
//  6. AN ACCOUNT IS CONFIGURED. NULL means the feature is off; see the migration.
//
// And the narration states, in words, that the cause is UNKNOWN and what was
// looked for. That sentence is the entire long-term value of the entry: an
// adjustment that does not say why is indistinguishable, a year later, from a
// correction of something real, and this module has spent a great many sessions
// on the consequences of not being able to tell those apart.
//
// ── THE SIGN, because getting it backwards is silent ──────────────────────
// `difference` is books MINUS lender. Xero credits a liability with a NEGATIVE
// LineAmount -- measured, not assumed: the 2024-03-31 EIDL journal posted
// -10,280.81 to account 299 and the balance ROSE by exactly that, 949,719.19 ->
// 960,000.00. So the loan leg takes `difference` itself and the offset takes its
// negation. The card also prints the resulting balance in words, so a sign error
// reads as an obviously wrong sentence instead of posting quietly.

// Mirrors reconciliation-run's REAL_ANCHOR_SOURCES. Belt and braces: a
// balance_vs_lender finding can only be raised off one of these already, so this
// re-checks a property rather than establishing it -- but the day that changes,
// this is the fence that should refuse rather than the one that assumes.
const WRITEOFF_REAL_ANCHORS = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']

function buildWriteoff(o: {
  loan: any, code: string, headline: any, detail: any,
  proposal: any, cpaException: any, totalPeriodDiff: number, hunt: any,
  postingDate: string, postingWhy: string, closeDate: string | null, today: string,
  writeoffAccount: string | null, acctMap: Record<string, string>, balanceNote: any,
}): any {
  const { loan, code, headline, detail, proposal, cpaException, totalPeriodDiff, hunt,
          postingDate, postingWhy, closeDate, today, writeoffAccount, acctMap, balanceNote } = o

  // Every refusal is RECORDED rather than returned as a bare null. A button that
  // is simply absent teaches nobody anything; "not offered, because X" is the
  // difference between a fence and a mystery, and it is what lets the card say
  // what would have to change.
  const refuse = (why: string) => ({ eligible: false, why })

  if (!writeoffAccount) return refuse('no write-off account has been nominated yet, so nothing can be posted anywhere')
  if (!headline || headline.difference == null) return refuse('there is no open books-vs-lender difference on this loan')
  const difference = r2(Number(headline.difference))
  if (Math.abs(difference) < 0.01) return refuse('the books already agree with the lender')

  if (proposal) return refuse('a specific correction has already been identified — post that instead')
  if (cpaException?.proposed_entry) return refuse('a prepared CPA exception already explains this — post that instead')
  if (detail?.self_diagnosis) return refuse('the reconciliation check has already named a cause for this difference')
  // ⚠️ A RECORDED EXPLANATION IS A CAUSE, AND A WRITE-OFF SAYS THERE ISN'T ONE.
  // Posting "CAUSE UNKNOWN" into Xero while a person's written explanation sits
  // on the same screen would put a lie in the ledger — the exact thing the
  // narration was written to prevent. A STALE note does not refuse: it was
  // written about a different figure and says so, so it is not an answer to this
  // one.
  if (balanceNote && !balanceNote.stale) {
    return refuse('someone has recorded an explanation for this difference — it is not unexplained, so read that and act on it')
  }

  const stillUnexplained = detail?.still_unexplained == null ? null : r2(Number(detail.still_unexplained))
  if (stillUnexplained == null || Math.abs(stillUnexplained - difference) > TOL) {
    return refuse('later entries account for part of this difference, so the remainder is a different question')
  }
  if (Math.abs(totalPeriodDiff) >= TOL) {
    return refuse('the period-by-period walk found differences to attribute — those are the lead, not a write-off')
  }
  if (hunt?.matches?.length) {
    return refuse(`a live transaction of exactly ${money(Math.abs(difference))} exists in Xero — look at that before writing anything off`)
  }
  if (!WRITEOFF_REAL_ANCHORS.includes(String(detail?.anchor_source ?? ''))) {
    return refuse('the balance this is measured against did not come from a lender document')
  }

  const lenderBalance = detail?.lender_balance == null ? null : Number(detail.lender_balance)
  const mat = isMaterialGap(difference, lenderBalance)

  // ⚠️ THE CEILING IS STRICTER THAN `!isMaterialGap`, AND THE DIFFERENCE MATTERS.
  //
  // isMaterialGap is an AND: material means big in dollars AND big as a share.
  // So NOT-material is an OR — under the floor, *or* under the share. That is
  // right for its own job, which is deciding how loudly to print a number: a
  // variance that is tiny by either measure should not shout.
  //
  // Reused unchanged as a POSTING ceiling it says something else entirely. On
  // this book's largest loan, 0.25% of $960,005 is $2,400, so every difference
  // up to roughly $2,400 comes back "not material" and would have been offered
  // as a one-click write-off with no cause. That is precisely the plug machine
  // this action was fenced against, arriving through the fence itself.
  //
  // So a write-off requires BOTH to be small: under the absolute floor AND under
  // the share. In practice the floor binds, which is the intent — an unexplained
  // difference is capped in DOLLARS regardless of how large the loan is, because
  // "small relative to the balance" is an argument about presentation and never
  // an argument about being allowed to write money off without knowing why.
  //
  // Raising it is a deliberate decision, not a side effect of a loan being big.
  const withinShare = mat.share < MATERIAL_SHARE
  const withinFloor = Math.abs(difference) < MATERIAL_FLOOR
  if (!withinFloor || !withinShare) {
    return refuse(`${money(Math.abs(difference))} is over the write-off ceiling — a write-off is capped at ${money(MATERIAL_FLOOR)} AND ${(MATERIAL_SHARE * 100).toFixed(2)}% of the balance, and this is ${!withinFloor ? `over the ${money(MATERIAL_FLOOR)} cap` : `${(mat.share * 100).toFixed(3)}% of the balance`}. A difference this size is diagnosed, never written off`)
  }
  if (isProtectedDate(postingDate, closeDate, today)) {
    return refuse(`the only date this could be posted to (${postingDate}) falls in a period your accountant has closed`)
  }

  const booksBal = detail?.xero_balance == null ? null : Number(detail.xero_balance)
  const asOf = headline.as_of || detail?.anchor_date || null
  const loanName = loan.xero_account_name || loan.lender || 'this loan'
  const offsetName = acctMap[String(writeoffAccount)] ?? null

  const narration =
    `${loanName} — ${money(Math.abs(difference))} difference between our books and the lender, CAUSE UNKNOWN, written off. `
    + `Our balance ${booksBal == null ? '(unknown)' : money(booksBal)} against the lender's ${lenderBalance == null ? '(unknown)' : money(lenderBalance)}`
    + `${asOf ? ` as of ${asOf}` : ''}, from a ${String(detail?.anchor_source ?? 'lender').replace(/_/g, ' ')}. `
    + `No cause was found: the period-by-period walk attributed nothing, no prepared correction applies, and no transaction of this amount exists in Xero. `
    + `Written off as immaterial (under ${money(MATERIAL_FLOOR)} and under ${(MATERIAL_SHARE * 100).toFixed(2)}% of the balance). `
    + `[WR-WRITEOFF ${code} ${postingDate}]`

  return {
    eligible: true,
    kind: 'unexplained_difference_writeoff',
    amount: difference,
    as_of: asOf,
    books_balance: booksBal,
    lender_balance: lenderBalance,
    // Said in words so a sign error is legible rather than silent.
    result_sentence: lenderBalance == null ? null
      : `After this, your books read ${money(lenderBalance)} for ${loanName} — the same as the lender.`,
    material_share: mat.share,
    dated_into: postingDate,
    dated_because: postingWhy,
    account: { code: String(writeoffAccount), name: offsetName },
    searched: [
      'the period-by-period walk against every usable lender statement',
      'a prepared reallocation for a lumped payment',
      'a CPA exception on an entry already worked',
      `every live Xero transaction totalling exactly ${money(Math.abs(difference))}`,
    ],
    journal: {
      Narration: narration,
      Date: postingDate,
      Status: 'POSTED',
      JournalLines: [
        { LineAmount: difference, AccountCode: String(code), Description: `${loanName} — unexplained difference written off`, TaxType: 'NONE', AccountName: acctMap[String(code)] ?? null },
        { LineAmount: r2(-difference), AccountCode: String(writeoffAccount), Description: `${loanName} — unexplained loan balance difference, cause not found`, TaxType: 'NONE', AccountName: offsetName },
      ],
    },
    token: proposalToken(loan.id, 'writeoff', difference, 'unexplained_writeoff', postingDate),
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// THE RECORDED-CAUSE ENTRY (session 289) — the fourth proposal
// ═══════════════════════════════════════════════════════════════════════════
//
// David, on the EIDL SBA card: "Offer a solution (in this case, a $5 adjustment
// to the loan principal)."
//
// The card could not. There were three proposals and none of them fit:
//   `proposal`      reallocates a lumped payment we identified
//   `cpa_exception` reverses interest the accountant double-booked
//   `writeoff`      posts a difference NOBODY could explain
//
// EIDL's $5.00 is the one shape none of those covers: a difference a HUMAN
// explained. And the write-off does not merely fail to fit — it REFUSES, and
// correctly, because posting "CAUSE UNKNOWN" into the ledger under a written
// explanation would put a lie in the books.
//
// So the product diagnosed the difference, proved it from three statements,
// wrote the cause down, and then dead-ended: "read that and act on it", with
// nothing on the screen to act WITH. A card that names the fix and cannot offer
// it is the same screen as a card that found nothing, for the person holding
// the mouse.
//
// This is that fourth path. It is the write-off's mirror image and every
// difference between them follows from one fact — this one HAS a cause:
//
//   * The note is the ENABLING condition here and the REFUSING condition there.
//   * There is no materiality ceiling. The ceiling exists to stop money being
//     plugged away unexamined; a recorded explanation is the examination. What
//     replaces it is stricter in the way that matters: `balanceNoteOf` already
//     requires the note to record the figure it was written about and to equal
//     the live difference to the cent, so a human has looked at THIS number.
//     A note with no amount is stale by construction and never reaches here.
//   * The narration cites the explanation and its author instead of reciting
//     what was searched for and not found.
//
// ⚠️ THE ACCOUNT IS NOT GUESSED, AND THAT IS THE WHOLE DESIGN OF THIS FUNCTION.
// The other side of this entry is a real GL code, and a wrong one posts money
// somewhere silently — the payroll `wage_account_code` failure mode exactly.
// Worse, on the loan this was built for the note's own closing line IS "which
// account should the $5.00 go to?", so guessing would be answering the open
// question on the reader's behalf and burying it in a journal. Session 230's
// rule says a typed number is never evidence; a GUESSED account is not even a
// typed one. So the journal ships with the offset leg's AccountCode NULL, the
// card makes the person choose, and the post path validates the choice against
// Xero's own chart. It is one dropdown, and it is the only thing on this card
// a machine has no business deciding.
function buildRecordedCauseEntry(o: {
  loan: any, code: string, headline: any, detail: any,
  proposal: any, cpaException: any, totalPeriodDiff: number,
  postingDate: string, postingWhy: string, closeDate: string | null, today: string,
  acctMap: Record<string, string>, balanceNote: any,
}): any {
  const { loan, code, headline, detail, proposal, cpaException, totalPeriodDiff,
          postingDate, postingWhy, closeDate, today, acctMap, balanceNote } = o

  // Same discipline as the write-off: a refusal is RECORDED, never a bare null.
  const refuse = (why: string) => ({ eligible: false, why })

  // The one condition that makes this action exist. A STALE note is not an
  // answer to the figure on screen and says so itself, so it does not enable a
  // posting either -- it would be booking today's difference on last month's
  // reasoning.
  if (!balanceNote || balanceNote.stale) {
    return refuse('nobody has recorded what this difference is, so there is no explanation to book it against')
  }
  if (!headline || headline.difference == null) return refuse('there is no open books-vs-lender difference on this loan')
  const difference = r2(Number(headline.difference))
  if (Math.abs(difference) < 0.01) return refuse('the books already agree with the lender')

  // A more specific correction always wins. These are ordered causes; this is a
  // recorded one, and a machine-derived entry that names the actual transaction
  // is better evidence than prose about it.
  if (proposal) return refuse('a specific correction has already been identified — post that instead')
  if (cpaException?.proposed_entry) return refuse('a prepared CPA exception already explains this — post that instead')

  // The note explains the WHOLE books-vs-lender difference. If later entries
  // account for part of it, the remainder is a different question and the note
  // is not evidence about it (the same test the residual bullet uses upstream).
  const stillUnexplained = detail?.still_unexplained == null ? null : r2(Number(detail.still_unexplained))
  if (stillUnexplained == null || Math.abs(stillUnexplained - difference) > TOL) {
    return refuse('later entries account for part of this difference, so the remainder is a different question')
  }
  // If the walk itself attributed differences period by period, those are the
  // lead. An explanation of the closing gap must not paper over spans that
  // disagree for reasons of their own.
  if (Math.abs(totalPeriodDiff) >= TOL) {
    return refuse('the period-by-period walk found differences to attribute — those are the lead, not a single adjustment')
  }
  // Same anchor rule as the write-off, and for the same reason: an entry that
  // moves the books to agree with "the lender" must be measured against a
  // document the LENDER produced, never against our own record of one.
  if (!WRITEOFF_REAL_ANCHORS.includes(String(detail?.anchor_source ?? ''))) {
    return refuse('the balance this is measured against did not come from a lender document')
  }
  // s231: the close date binds WRITES, not just proposals. This org's Xero
  // carries no lock date, so nothing downstream would refuse it.
  if (isProtectedDate(postingDate, closeDate, today)) {
    return refuse(`the only date this could be posted to (${postingDate}) falls in a period your accountant has closed`)
  }

  const booksBal = detail?.xero_balance == null ? null : Number(detail.xero_balance)
  const lenderBalance = detail?.lender_balance == null ? null : Number(detail.lender_balance)
  const asOf = headline.as_of || detail?.anchor_date || null
  const loanName = loan.xero_account_name || loan.lender || 'this loan'
  const who = balanceNote.set_by ? String(balanceNote.set_by) : null
  // The explanation goes into the ledger with the entry. A journal is read years
  // later by someone who does not have this screen -- s247's lesson is that the
  // sentence beside the number is what a CPA actually reads, so the sentence
  // travels with the number.
  const cited = String(balanceNote.text || '').replace(/\s+/g, ' ').trim().slice(0, 1200)

  const narration =
    `${loanName} — ${money(Math.abs(difference))} adjustment to agree with the lender, cause RECORDED. `
    + `Our balance ${booksBal == null ? '(unknown)' : money(booksBal)} against the lender's ${lenderBalance == null ? '(unknown)' : money(lenderBalance)}`
    + `${asOf ? ` as of ${asOf}` : ''}, from a ${String(detail?.anchor_source ?? 'lender').replace(/_/g, ' ')}. `
    + `Explanation on file${who ? ` (${who})` : ''}${balanceNote.set_at ? `, recorded ${String(balanceNote.set_at).slice(0, 10)}` : ''}: ${cited} `
    + `[WR-ADJUST ${code} ${postingDate}]`

  return {
    eligible: true,
    kind: 'recorded_cause_adjustment',
    amount: difference,
    as_of: asOf,
    books_balance: booksBal,
    lender_balance: lenderBalance,
    // Said in words so a sign error is legible rather than silent (s284).
    result_sentence: lenderBalance == null ? null
      : `After this, your books read ${money(lenderBalance)} for ${loanName} — the same as the lender.`,
    dated_into: postingDate,
    dated_because: postingWhy,
    recorded_by: who,
    recorded_at: balanceNote.set_at ?? null,
    // The leg we know, and the leg the person must choose. Kept as two named
    // fields rather than a half-filled JournalLines array, so nothing can post
    // this by accident with a null AccountCode in it.
    loan_leg: {
      AccountCode: String(code),
      AccountName: acctMap[String(code)] ?? null,
      LineAmount: difference,
      Description: `${loanName} — balance adjustment, cause recorded`,
    },
    offset_leg: {
      AccountCode: null,
      LineAmount: r2(-difference),
      Description: `${loanName} — ${money(Math.abs(difference))} added by the lender, per the recorded explanation`,
    },
    narration,
    // ⚠️ A DEFAULT, AND IT IS NOT A GUESS. `INTEREST_EXPENSE_ACCOUNT_CODE` is
    // the constant `loan-xero-post` puts the interest leg of EVERY loan payment
    // on, on this book. Refusing to pre-select it was over-caution of the kind
    // that costs a bookkeeper a decision they have no way to make better: the
    // account is the product's own established convention, and the FIRST card
    // this was built for showed a picker with nothing in it beside an
    // explanation that already said "interest".
    //
    // The real question the human is answering is not "which account exists?"
    // but "is this interest, or is it a fee?" -- and if it is a fee, this
    // default is wrong and they change it. So it is offered as a default and
    // never as an answer, which is why `default_account_why` travels with it
    // and the picker stays a picker. Null when the chart does not carry the
    // code, because a default that is not in Xero would fail at the post.
    default_account: Object.prototype.hasOwnProperty.call(acctMap, INTEREST_EXPENSE_ACCOUNT_CODE)
      ? { code: INTEREST_EXPENSE_ACCOUNT_CODE, name: acctMap[INTEREST_EXPENSE_ACCOUNT_CODE] }
      : null,
    default_account_why: 'the account every loan interest posting on this book already uses',
    // Every account Xero will accept, for the picker. The card cannot invent a
    // code that is not on this list, and the post path re-checks it anyway.
    accounts: Object.entries(acctMap)
      .filter(([c]) => String(c) !== String(code))
      .map(([c, n]) => ({ code: String(c), name: String(n) }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    // The token pins the FIGURE and the DATE the person read. It deliberately
    // does NOT pin the account: the account is what they are choosing, and
    // baking it in would mean every change of the dropdown invalidated the
    // approval it is part of.
    token: proposalToken(loan.id, 'recorded', difference, 'recorded_cause', postingDate),
  }
}

/**
 * The account a write-off may post to, or null. NULL is the shipped state and it
 * disables the action entirely -- see the migration comment on
 * settings.loan_writeoff_account_code for why this is configuration rather than
 * a constant. A read failure returns null, i.e. OFF: the safe direction for a
 * setting whose only job is to permit a posting.
 */
async function writeoffAccount(supa: any): Promise<string | null> {
  const { data } = await supa.from('settings')
    .select('loan_writeoff_account_code').eq('id', 1).maybeSingle()
  const code = data?.loan_writeoff_account_code
  return code ? String(code).trim() || null : null
}

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

  const { data: allLoans } = await supa.from('loan_accounts').select('id, xero_account_code, xero_account_name, xero_bank_account_id, lender, lender_account_number, status, scheduled_monthly_payment, statement_date_basis')
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
      // s289: NO `.lte('statement_date', today)`. On a due_date lender that filed
      // date is a payment due date, so filtering here threw away a statement
      // whose BALANCE was a fortnight old. The test now runs inside
      // anchorsByBalanceDate, on the re-dated value. See its header.
      supa.from('loan_statements').select('*').eq('loan_account_id', loan.id).order('statement_date', { ascending: true }),
      supa.from('loan_splits').select('*').eq('loan_account_id', loan.id).order('period_label', { ascending: true }),
    ])
    const finding = (openFindings || []).filter((f: any) => f.loan_account_id === loan.id)
      .sort((a: any, b: any) => String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')))[0]
    const headline = finding?.detail?.difference != null
      ? { difference: Number(finding.detail.difference), as_of: finding.detail.anchor_date || null } : null
    // Same re-dating as the per-loan path -- see the long note there. One rule,
    // both call sites; a lender-level walk that disagreed with the per-loan walk
    // about which month a payment fell in would be the worse bug.
    // s290: one rule, both call sites. anchorsByBalanceDate drops the rows a
    // human ruled out; refusedAnchors names them, so the lender-level view can
    // never quietly disagree with the per-loan one about which documents count.
    const lenderBasis = normalizeBasis((loan as any)?.statement_date_basis)
    const anchorCandidates = (statements || []).filter((s: any) => s.balance_basis === 'principal_only' && s.principal_balance != null)
    const anchors = anchorsByBalanceDate(anchorCandidates, lenderBasis, today)
    const refusedAnchorRows = refusedAnchors(anchorCandidates as any, lenderBasis, today)
      .map((r: any) => ({ date: r.filed_date || r.statement_date, why: r.anchor_refusal }))
    const skippedForBasis = (statements || []).filter((s: any) => s.balance_basis !== 'principal_only').map((s: any) => ({ date: s.statement_date, basis: s.balance_basis || 'unknown' }))
    const { matchKnown } = prepKnownAmounts(loan, splits || [])
    bundles.push({ loan, code: String(loan.xero_account_code), finding, headline, anchors, skippedForBasis, refusedAnchorRows, splits: splits || [], matchKnown })
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
      // session 272: a settled month contributes no MOVES to the roadmap. The
      // joint solve is a list of recodes for someone to go and perform, and a
      // recode inside closed books is work nobody can do -- the same reason
      // session 230 stopped raising approvals there. The span still shows in
      // the table; it just stops generating instructions.
      if (p.verdict !== 'divergent' || p.timing_pair || p.closed_period || !p.cross_loan_candidates) continue
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
  const pairSpans = walkable.reduce((s: number, b: any) => s + b.aw.periods.filter((p: any) => p.timing_pair && !p.closed_period).length, 0)
  // session 272: one line for settled history across the whole lender, same as
  // the per-loan walk. Stated once, with the money, never enumerated.
  const closedSpansAll = walkable.reduce((acc: any[], b: any) => acc.concat(b.aw.periods.filter((p: any) => p.verdict === 'divergent' && p.closed_period && !p.timing_pair)), [] as any[])
  if (closedSpansAll.length) {
    const tot = r2(closedSpansAll.reduce((t: number, p: any) => t + p.diff, 0))
    conclusions.push(`${closedSpansAll.length} flagged span${closedSpansAll.length === 1 ? '' : 's'} across these loans sit inside books closed through ${pw.closeDate}${Math.abs(tot) >= TOL ? ` (${money(Math.abs(tot))} in total)` : ''} — already settled by your accountant's adjustments. Nothing to do.`)
  }
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
    let dupX: any = null
    try { dupX = await alreadyPostedInXero(step.journal.Narration, step.journal.Date, headers) }
    catch (e) { return jres({ error: String((e as Error).message) }, 502) }
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
      refused_anchors: b.refusedAnchorRows,
    })),
    skipped_loans: skippedLoans,
    window: { from: winFrom, to: winTo, read_via: oneBank ? 'one pull: bank transactions scoped to the shared checking account, plus every manual journal in the window' : 'one pull: org-wide month-sliced' },
    can_post: canWriteBookkeeping(role),
  })
}


async function handle(req: Request): Promise<Response> {
  const supa = admin()
  const body = await req.json().catch(() => ({}))
  const { loan_account_id, post_fix, proposal_token, posted_by } = body
  const post_writeoff = body.post_writeoff === true
  // s289: the recorded-cause adjustment. `adjust_account_code` is the one leg
  // the server refuses to choose -- see buildRecordedCauseEntry's header.
  const post_recorded = body.post_recorded === true
  const adjust_account_code = typeof body.adjust_account_code === 'string'
    ? body.adjust_account_code.trim() : ''
  // Optional. The journal always carries the computed story; this is only for a
  // person who knows something the system does not, and an empty one never blocks.
  const writeoff_note = typeof body.writeoff_note === 'string' ? body.writeoff_note.trim().slice(0, 500) : ''
  // ── session 272: THE BUTTON MATCHES THE ROW ────────────────────────────────
  // David, on PayPal 2: the Loans row showed an August variance and the modal it
  // opened led with December. Two different investigations behind one button, and
  // the reader is left to notice that for themselves. The caller now says which
  // month its row is about; the walk answers about that month first.
  //
  // Validated to 'YYYY-MM' rather than trusted: it reaches a string comparison
  // against span dates, and a malformed value would silently focus on nothing --
  // which looks exactly like a month with no spans.
  const focus_period = /^\d{4}-\d{2}$/.test(String(body.focus_period ?? '')) ? String(body.focus_period) : null
  // session 234: approving the exception's prepared correction. Same contract as
  // post_fix in every respect -- admin/manager, full server-side re-analysis on
  // this same request, exact-token match or nothing posts.
  const post_exception = !!body.post_exception

  let role = await callerRole(req)
  // session 261: the nightly attribution job, authenticating on the shared secret
  // because it has no user. Read the isInternalCall comment above before widening this.
  const internal = !role && await isInternalCall(req)
  if (internal) role = 'internal_job'
  if (!(canWriteBookkeeping(role) || role === 'internal_job')) {
    return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  // The convergence guard. `internal_job` already fails every canWriteBookkeeping() gate
  // below, so this refuses nothing those would have allowed -- it exists so the refusal
  // is a STATEMENT rather than a side effect of a role's absence from an array, and so
  // that widening one of those arrays cannot silently hand a write path to a cron job.
  if (internal && (post_fix || post_exception || post_writeoff || post_recorded || body.post_crossloan || body.lender_analysis)) {
    return new Response(JSON.stringify({ error: 'The internal job may run analyze only. Nothing was posted.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  if ((post_fix || post_exception || post_writeoff || post_recorded) && !canWriteBookkeeping(role)) {
    return new Response(JSON.stringify({ error: 'Your account can review the analysis but not write.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
  // v10: lender-level analysis — read-only by construction; corrections are
  // posted from their own loan card (per-loan post_fix), never from here.
  if (body.lender_analysis) {
    if (post_fix) {
      return new Response(JSON.stringify({ error: 'Post a correction from its own loan card — the lender-level analysis is read-only.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // v12: posting a reallocation is a write — same bar as post_fix.
    if (body.post_crossloan && !canWriteBookkeeping(role)) {
      return new Response(JSON.stringify({ error: 'Your account can review the analysis but not write.' }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
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
    // s289: see the note at the lender-level query — the future test belongs to
    // the BALANCE date and now lives in anchorsByBalanceDate.
    supa.from('loan_statements').select('*').eq('loan_account_id', loan_account_id).order('statement_date', { ascending: true }),
    supa.from('loan_splits').select('*').eq('loan_account_id', loan_account_id).order('period_label', { ascending: true }),
    supa.from('reconciliation_findings').select('*').eq('loan_account_id', loan_account_id).eq('check_key', 'balance_vs_lender').eq('status', 'open').order('last_seen_at', { ascending: false }).limit(1),
  ])
  const headline = findings?.[0]?.detail?.difference != null
    ? { difference: Number(findings[0].detail.difference), as_of: findings[0].detail.anchor_date || null }
    : null

  // Reliable anchors: principal_only basis only — the walk subtracts balances,
  // and mixing bases fabricates differences (the PayPal lesson, session 222).
  // ── session 273 cont.: THE DATE ON A STATEMENT IS NOT ALWAYS ITS BALANCE DATE
  // Everything below subtracts one anchor's balance from the next and compares
  // that against Xero's movement BETWEEN THOSE DATES -- which is only valid if a
  // statement's date is the date its balance was true. Funding Circle files each
  // statement under the FIRST day of the period it covers (issued the 18th of the
  // following month), so its "2026-07-01" row is the JULY MONTH-END balance. Left
  // unshifted, the walk paired each lender period against the wrong Xero month and
  // reported ~$30/month of drift on a loan whose real drift is ~$15/month.
  //
  // Re-dated ONCE, here, so every line after this point -- spans, entry windows,
  // closed_period, in_focus, the proposal -- is right without knowing the rule
  // exists. The filed date is kept in `filed_date`; nothing is lost.
  //
  // A NO-OP for every loan not explicitly marked. The basis is recorded per loan
  // from evidence on the lender's PDF, never inferred here: Ford's 2026-08-23
  // statements mean exactly what they say, and shifting those to month end would
  // fabricate differences. A false ask is worse than a missing one.
  const dateBasis = normalizeBasis((loan as any)?.statement_date_basis)
  const anchorCandidates = (statements || []).filter(s => s.balance_basis === 'principal_only' && s.principal_balance != null)
  const anchors = anchorsByBalanceDate(anchorCandidates, dateBasis, today)
  // ── s290: THE PAIR STAYS A PAIR ─────────────────────────────────────────
  // anchorsByBalanceDate now drops rows a HUMAN ruled out (see its s290 note),
  // which is what stops Funding Circle's duplicate 08-03 pull building a span
  // from Aug 31 to Aug 31. A row that leaves the walk silently is evidence
  // deleted (s245), so the reasons ship with the answer and the card puts them
  // behind "Show the working". They are NOT bullets: a document a person has
  // already ruled out is not a question anybody still has.
  const refusedAnchorRows = refusedAnchors(anchorCandidates as any, dateBasis, today)
    .map((r: any) => ({ date: r.filed_date || r.statement_date, why: r.anchor_refusal }))
  // The suspicion, for a HUMAN to settle against one PDF -- never acted on here.
  const dateBasisSuspicion = looksPeriodLabelled((statements || []) as any, dateBasis)
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
    focusPeriod: focus_period,
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

  // ── The write-off proposal (session 284) ──────────────────────────────
  // Built LAST, because it is defined by what everything above failed to find:
  // it consults `proposal`, `cpaException`, the walk's own total and the
  // fingerprint hunt, and refuses if any of them produced a lead. Computing it
  // earlier would mean deciding "nothing was found" before the finding was done.
  const woAccount = await writeoffAccount(supa)
  const balanceNote = balanceNoteOf(loan, headline?.difference ?? null)
  const wo = buildWriteoff({
    loan, code, headline, detail: findings?.[0]?.detail ?? null,
    proposal, cpaException, totalPeriodDiff, hunt,
    postingDate: pw.postingDate, postingWhy: pw.postingWhy, closeDate: pw.closeDate, today,
    writeoffAccount: woAccount, acctMap, balanceNote,
  })
  // s289: the fourth proposal. Built from the SAME freshly-walked figures as the
  // write-off, right beside it, so the two can never disagree about what the
  // difference is -- they are mutually exclusive by construction (one requires a
  // current note, the other refuses one) and this is where that is visible.
  // s289 cont.: measured, every walk, and independent of whether anybody has
  // written a note. It is EVIDENCE, so it renders whether or not the entry is
  // eligible -- a reader deciding what to do about a difference wants it even
  // on a loan nobody has attested to yet.
  const derivedCause = deriveIncreaseCause({
    splits: splits || [], headline, winFrom: usable[0]?.statement_date || '', residual: aw.residual,
    // s289: the RAW statements, including rows refused as anchors. Refused as an
    // anchor is not the same as unusable as evidence -- a document that cannot
    // be placed in time still STATES a balance, and two of them straddling the
    // change are what let the card say when it appeared.
    statements: statements || [],
    lenderBalance: findings?.[0]?.detail?.lender_balance == null ? null : Number(findings[0].detail.lender_balance),
  })
  const rec = buildRecordedCauseEntry({
    loan, code, headline, detail: findings?.[0]?.detail ?? null,
    proposal, cpaException, totalPeriodDiff,
    postingDate: pw.postingDate, postingWhy: pw.postingWhy, closeDate: pw.closeDate, today,
    acctMap, balanceNote,
  })

  const analysis = {
    ok: true, mode: 'analyze' as string,
    posting_window: pw,
    loan: { id: loan.id, name: loan.xero_account_name, code },
    headline,
    // session 273 cont.: which of the two date meanings this walk assumed, always
    // stated. A reader who cannot see WHICH alignment produced a number cannot
    // check it, and this is the assumption that was wrong for a year.
    statement_date_basis: dateBasis,
    // A question, never an action -- null unless the loan's own statements
    // contradict the basis it is filed under. See looksPeriodLabelled().
    date_basis_suspicion: dateBasisSuspicion,
    window: { from: winFrom, to: winTo, anchors_used: usable.length, truncated_before: truncated, skipped_for_basis: skippedForBasis,
      refused_anchors: refusedAnchorRows,
      read_via: loan.xero_bank_account_id ? 'bank transactions scoped to this loan\'s own bank account, plus every manual journal in the window' : 'org-wide month-sliced pull' },
    periods, agree_until: lastClean,
    total_period_diff: totalPeriodDiff, residual_before_window: residual,
    // session 272: what the close date excluded, stated to the client so the
    // table can grey those rows and the reader can see the denominator did not
    // quietly shrink (session 262: a denominator that shrinks is not a gate).
    close_date: aw.close_date,
    months: aw.months,
    netted_month_count: aw.netted_month_count,
    no_action_detail: aw.no_action_detail,
    focus_period: aw.focus_period,
    focus_span_count: aw.focus_span_count,
    divergent_count: aw.divergent_count,
    flagged_span_count: aw.flagged_span_count,
    timing_pair_span_count: aw.timing_pair_span_count,
    month_netted_span_count: aw.month_netted_span_count,
    closed_divergent_count: aw.closed_divergent_count,
    closed_divergent_total: aw.closed_divergent_total,
    cpa_exception_closed: aw.cpa_exception_closed,
    fingerprint_hunt: hunt,
    proposal, cpa_exception: cpaException,
    // session 284: the third proposal, and the only one not built from a cause.
    // Carried even when NOT eligible, because `why` is what lets the card say
    // what would have to change instead of just showing no button.
    writeoff: wo,
    // s289: carried even when NOT eligible, exactly like the write-off, because
    // `why` is what lets the card say what would have to change instead of
    // showing an absence the reader has to interpret.
    recorded_entry: rec,
    // s290: the true-up's own refusal travels even when it proposes nothing —
    // a row that cannot say WHY it has no button cannot be told apart from a
    // feature that failed to run, which is what hid this module for 15 sessions.
    trueup: aw.trueup,
    derived_cause: derivedCause,
    // session 284: rendered at the TOP of the fix modal and summarised in the
    // close band's Action column, because an explanation filed where nobody
    // looks is the same as no explanation.
    balance_note: balanceNote,
    can_post: !!proposal && canWriteBookkeeping(role),
    can_post_exception: !!cpaException?.proposed_entry && canWriteBookkeeping(role),
    can_post_writeoff: !!wo?.eligible && canWriteBookkeeping(role),
    can_post_recorded: !!rec?.eligible && canWriteBookkeeping(role),
    conclusions: finalConclusions,
    narrative: bits.join(' '),
  }

  // ── post_recorded: the difference somebody DID explain (session 289) ─────
  //
  // Same shape as post_writeoff below and for the same reason: every guard is
  // RE-CHECKED here on freshly-walked data rather than trusted from the render,
  // because between looking and clicking the difference can move, a better
  // correction can appear, the close date can advance, or the note can be
  // edited to be about a different figure. s231: a guard is only as good as the
  // branch it sits on, and this is a branch that spends money.
  if (post_recorded) {
    if (!rec?.eligible) {
      return new Response(JSON.stringify({ error: `This can no longer be adjusted — ${rec?.why || 'the analysis has changed since you looked'}. Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (rec.token !== proposal_token) {
      return new Response(JSON.stringify({ error: 'The figure changed since you reviewed it — check the current one and approve that instead. Nothing was posted.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // ⚠️ THE ACCOUNT IS VALIDATED HERE, NOT TRUSTED FROM THE CARD. The picker
    // is built from `rec.accounts`, but the request is just JSON and anything
    // can send one. A code that is not in Xero's own chart, or that is the loan
    // account itself (which would post both legs to one account and net to
    // nothing while reporting success), is refused before the write.
    if (!adjust_account_code) {
      return new Response(JSON.stringify({ error: 'Choose the account the adjustment should go to — the system will not pick one for you. Nothing was posted.', analysis }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (!Object.prototype.hasOwnProperty.call(acctMap, adjust_account_code)) {
      return new Response(JSON.stringify({ error: `Account ${adjust_account_code} is not in your Xero chart of accounts. Nothing was posted.`, analysis }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (String(adjust_account_code) === String(code)) {
      return new Response(JSON.stringify({ error: 'Both sides of the entry cannot be the loan account — that would post a journal that changes nothing. Nothing was posted.', analysis }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (isProtectedDate(rec.dated_into, pw.closeDate, today)) {
      return new Response(JSON.stringify({ error: `That adjustment is dated ${rec.dated_into}, which falls in a period your accountant has closed or is closing (books closed through ${pw.closeDate}). Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // The narration carries the loan code and the posting date, so a second
    // click, a double submit or a re-run finds its own journal and stops. This
    // is the loan module's Stripe-idempotency standard: a retry is a no-op or a
    // loud error, NEVER a duplicate journal.
    let dupR: any = null
    try { dupR = await alreadyPostedInXero(rec.narration, rec.dated_into, headers) }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error).message), analysis }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (dupR) {
      return new Response(JSON.stringify({ error: duplicateJournalError(dupR), already_posted: dupR }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const offsetName = acctMap[String(adjust_account_code)] ?? null
    const recLines = [
      { LineAmount: rec.loan_leg.LineAmount, AccountCode: rec.loan_leg.AccountCode, Description: rec.loan_leg.Description, TaxType: 'NONE' },
      { LineAmount: rec.offset_leg.LineAmount, AccountCode: String(adjust_account_code), Description: rec.offset_leg.Description, TaxType: 'NONE' },
    ]
    const recNarration = (rec.narration
      + (posted_by ? ` Approved by ${posted_by}, posted to ${adjust_account_code}${offsetName ? ` ${offsetName}` : ''}.` : '')).slice(0, 4000)
    const recRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ManualJournals: [{ Narration: recNarration, Date: rec.dated_into, Status: 'POSTED', JournalLines: recLines }] }),
    })
    const recJson = await recRes.json().catch(() => null)
    if (!recRes.ok || recJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: recRes.status, details: recJson }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const recJournal = recJson.ManualJournals?.[0]
    return new Response(JSON.stringify({
      ok: true, mode: 'post_recorded',
      posted_journal: { id: recJournal?.ManualJournalID, narration: recNarration, date: rec.dated_into, lines: recLines },
      posted_by: posted_by || null,
      note: 'Posted. The journal carries the recorded explanation, so the reason travels with the number into the ledger. Run a reconciliation check to confirm the loan now ties.',
    }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  // ── post_writeoff: the difference nobody could explain (session 284) ──────
  //
  // Every guard below is RE-CHECKED here rather than trusted from the render.
  // buildWriteoff has just run again on fresh data, so a difference that grew
  // past the ceiling, a cause found since, a close date that moved, or an
  // account un-nominated between looking and clicking all refuse at this point.
  // The token then pins the exact figure and date the person actually read --
  // an approval is for one number, not for the idea of writing something off.
  if (post_writeoff) {
    if (!wo?.eligible) {
      return new Response(JSON.stringify({ error: `This can no longer be written off — ${wo?.why || 'the analysis has changed since you looked'}. Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (wo.token !== proposal_token) {
      return new Response(JSON.stringify({ error: 'The figure changed since you reviewed it — check the current one and approve that instead. Nothing was posted.', analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // Belt and braces on the fence that matters most. buildWriteoff already
    // refused a material gap; this says so again at the last instant before a
    // write, because session 231's lesson is that a guard is only as good as the
    // branch it sits on, and this is the branch that spends money.
    // Note this repeats buildWriteoff's STRICT ceiling (floor AND share), not
    // `isMaterialGap` — using the looser one here would mean the last guard
    // before the write was the weakest one on the path.
    const matNow = isMaterialGap(wo.amount, wo.lender_balance)
    if (Math.abs(wo.amount) >= MATERIAL_FLOOR || matNow.share >= MATERIAL_SHARE) {
      return new Response(JSON.stringify({ error: `${money(Math.abs(wo.amount))} is over the write-off ceiling — it must be diagnosed, not written off. Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (isProtectedDate(wo.journal.Date, pw.closeDate, today)) {
      return new Response(JSON.stringify({ error: `That write-off is dated ${wo.journal.Date}, which falls in a period your accountant has closed or is closing (books closed through ${pw.closeDate}). Nothing was posted.`, analysis }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    // The narration carries the loan code and the posting date, so a second
    // click, a double submit or a re-run finds its own journal and stops.
    let dupW: any = null
    try { dupW = await alreadyPostedInXero(wo.journal.Narration, wo.journal.Date, headers) }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error).message), analysis }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    if (dupW) {
      return new Response(JSON.stringify({ error: duplicateJournalError(dupW), already_posted: dupW }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const narration = (wo.journal.Narration
      + (writeoff_note ? ` Note from ${posted_by || 'the approver'}: ${writeoff_note}` : '')
      + (posted_by ? ` Approved by ${posted_by}.` : '')).slice(0, 4000)
    const woRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ManualJournals: [{ Narration: narration, Date: wo.journal.Date, Status: wo.journal.Status, JournalLines: wo.journal.JournalLines.map((l: any) => ({ LineAmount: l.LineAmount, AccountCode: l.AccountCode, Description: l.Description, TaxType: l.TaxType })) }] }),
    })
    const woJson = await woRes.json().catch(() => null)
    if (!woRes.ok || woJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: woRes.status, details: woJson }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const woJournal = woJson.ManualJournals?.[0]
    return new Response(JSON.stringify({
      ok: true, mode: 'post_writeoff',
      posted_journal: { id: woJournal?.ManualJournalID, narration, date: wo.journal.Date, lines: wo.journal.JournalLines },
      posted_by: posted_by || null,
      note: 'Written off. The journal says the cause was not found and what was looked for — it is a record of an open question closed deliberately, not of a problem solved. Run a reconciliation check to confirm the loan now ties.',
    }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
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
    let dupE: any = null
    try { dupE = await alreadyPostedInXero(prepared.Narration, prepared.Date, headers) }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error).message), analysis }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
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
  let dupF: any = null
  try { dupF = await alreadyPostedInXero(proposal.journal.Narration, proposal.journal.Date, headers) }
  catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message), analysis }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
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
