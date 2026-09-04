// loan-cross-check — v3
// v3 (session 230): CHECK D, off_schedule_principal_payment -- detects a balance
// that fell by more than the scheduled payment explains, and proposes booking the
// extra as its own entry (loan-record-principal-payment) so the period stops
// computing negative interest.
//
// v2 (session 230): finding titles now name the LOAN, not just the lender. Ford Pro
// FinSimple finances five vans on five separate loan accounts, so a title reading
// "Ford Pro FinSimple: a statement period looks missing" told nobody WHICH van's
// statement to go find. Titles use `xero_account_name` (the same label
// reconciliation-run's findings use, e.g. "E-Transit Loan - 4140"), falling back to
// the lender only when a loan has no Xero account name on file. One label helper,
// used by all three checks -- a per-check string would drift.

// =============================================================================
// Session 221, build step 5. The cross-validation layer David actually asked for:
// "If two pieces of information are available, say an amortization doc + an actual
// statement, the system should compare them and see if everything checks out. If
// not, the system flags the inconsistency."
//
// DRY RUN BY DEFAULT. Writes nothing unless `confirm: true` is passed explicitly.
//
// ── WHY THIS IS A SEPARATE FUNCTION FROM reconciliation-run ──────────────────
// reconciliation-run CANNOT be invoked scoped to one loan (audited session 221):
// its checkpoint map is global and self-overwriting, so a single-loan run would
// write a 1-key map and the NEXT run would find no checkpoint for the other 21
// loans and silently stop running balance_vs_lender and derived_drift for all of
// them. Its resolve sweep is likewise all-loans. So this layer writes its own
// findings directly rather than trying to call the engine.
//
// ── FINGERPRINT NAMESPACING IS A SAFETY MECHANISM, NOT A NAMING CHOICE ───────
// reconciliation_findings has a UNIQUE constraint on `fingerprint` alone, and the
// engine upserts with onConflict:'fingerprint' WITHOUT setting `source`. If an
// intake fingerprint ever collided with an engine one, the engine would overwrite
// this row -- including clobbering a human's pinned note. Every fingerprint below
// is therefore prefixed 'intake:'. Engine fingerprints always begin with one of
// its six check_keys (balance_vs_lender, lumped_payment, future_dated_rows,
// stale_anchor, derived_drift, non_live_counted), so the prefix makes collision
// impossible BY CONSTRUCTION rather than by convention. If a third writer is ever
// added, replace the unique index with (source, fingerprint) and update BOTH
// functions' onConflict together -- do not rely on prefixes alone at that point.
//
// ── THE RULE THESE CHECKS ENFORCE ───────────────────────────────────────────
// Two balance figures may only be compared when their `balance_basis` matches.
// principal_only / total_payback / payoff_quote measure different things. Session
// 221 found the engine comparing PayPal's total_payback schedule against a
// principal-basis ledger, which left a permanent unexplainable discrepancy. These
// checks convert where the relationship is known, and flag where it isn't. They
// never compare across bases silently.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { effectiveCloseDate, isPeriodClosed } from '../_shared/close-date.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const REAL_STATEMENT_SOURCES = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']
const MONEY_EPS = 0.01
// Xero books these loans on a principal basis (verified session 221 for PayPal's
// origination entry: RECEIVE $157,000.00, single line, fee never booked). So an
// anchor that is NOT principal_only cannot be compared to the ledger as-is.
const LEDGER_BASIS = 'principal_only'

function todayPacific(): string {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))
    .toISOString().slice(0, 10)
}
const n = (v: any) => (v == null ? null : Number(v))
const money = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)

interface Finding {
  fingerprint: string
  loan_account_id: string
  check_key: string
  severity: 'info' | 'warn' | 'error'
  title: string
  plain_english: string
  proposed_action: Record<string, any> | null
  detail: Record<string, any>
}

Deno.serve(async (req) => {
  const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers: H })

  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: H })
    }
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: H })
    const anon = createClient(SUPABASE_URL, ANON_KEY)
    const { data: userData, error: userErr } = await anon.auth.getUser(token)
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: H })
    }
    const supa = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data: prof } = await supa.from('profiles').select('role').eq('id', userData.user.id).single()
    const role = prof?.role
    if (!['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: `Forbidden (role: ${role ?? 'none'})` }), { status: 403, headers: H })
    }

    const body = await req.json().catch(() => ({}))
    const confirm = body.confirm === true
    const onlyLoanId: string | null = body.loan_account_id ?? null
    // Reading is advisory and safe for a CPA; persisting findings is a write.
    if (confirm && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Writing findings requires admin or manager.' }), { status: 403, headers: H })
    }

    const today = todayPacific()
    // Findings about a closed period are unactionable by construction: the CPA has
    // already adjusted and locked it. Only the checks that are ABOUT a period are
    // silenced -- a balance check is about today, not about a closed month, and
    // stays on. (Session 230.)
    const closeDate = await effectiveCloseDate(supa)
    const periodClosed = (d: string) => isPeriodClosed(String(d).slice(0, 7), closeDate.date)

    let loanQ = supa.from('loan_accounts')
      .select('id, lender, lender_account_number, status, ingestion_method, xero_account_code, xero_account_name, scheduled_monthly_payment, prestage_enabled')
    if (onlyLoanId) loanQ = loanQ.eq('id', onlyLoanId)
    const { data: loans } = await loanQ
    if (!loans?.length) {
      return new Response(JSON.stringify({ ok: true, dry_run: !confirm, findings: [], note: 'No loans matched.' }), { headers: H })
    }
    const loanIds = loans.map((l: any) => l.id)

    const { data: statements } = await supa.from('loan_statements')
      .select('id, loan_account_id, statement_date, principal_balance, balance_basis, source, total_amount_due')
      .in('loan_account_id', loanIds)
    const { data: schedules } = await supa.from('loan_amortization_schedules')
      .select('id, loan_account_id, balance_basis, schedule_generated_date, amort_type')
      .in('loan_account_id', loanIds)
    const schedIds = (schedules ?? []).map((s: any) => s.id)
    const { data: rows } = schedIds.length
      ? await supa.from('loan_amortization_rows')
          .select('schedule_id, row_date, row_type, balance, principal, interest, payment')
          .in('schedule_id', schedIds)
      : { data: [] as any[] }

    const findings: Finding[] = []

    for (const loan of loans) {
      // What a human calls this loan. Lender alone is ambiguous whenever one lender
      // holds several accounts (Ford Pro: five vans), which is exactly when a finding
      // is hardest to act on.
      const loanLabel = (loan.xero_account_name || '').trim() || loan.lender
      const stmts = (statements ?? [])
        .filter((s: any) => s.loan_account_id === loan.id && s.principal_balance != null)
      const realStmts = stmts
        .filter((s: any) => REAL_STATEMENT_SOURCES.includes(s.source))
        .sort((a: any, b: any) => a.statement_date.localeCompare(b.statement_date))
      const sched = (schedules ?? []).find((s: any) => s.loan_account_id === loan.id)
      // row_type filter is deliberate: annual_total / grand_total rows carry a balance
      // whose semantics differ from a payment row's, and the engine's own anchor query
      // omits this filter (noted session 221). Do not copy that omission here.
      const schedRows = sched
        ? (rows ?? [])
            .filter((r: any) => r.schedule_id === sched.id && r.balance != null
                             && (r.row_type === 'payment' || r.row_type === 'initial'))
            .sort((a: any, b: any) => a.row_date.localeCompare(b.row_date))
        : []

      // ── CHECK A: basis_conflict ────────────────────────────────────────────
      // The newest thing we treat as this loan's balance, and what it MEASURES.
      // If that is not principal, every comparison against the Xero ledger is
      // comparing two different quantities and will differ forever by the
      // unamortized fee -- which looks exactly like a real discrepancy.
      const anchorCandidates: Array<{ date: string; balance: number; basis: string; kind: string }> = []
      for (const s of realStmts) {
        if (s.statement_date <= today) {
          anchorCandidates.push({ date: s.statement_date, balance: n(s.principal_balance)!, basis: s.balance_basis, kind: 'statement' })
        }
      }
      for (const r of schedRows) {
        if (r.row_date <= today) {
          anchorCandidates.push({ date: r.row_date, balance: n(r.balance)!, basis: sched!.balance_basis, kind: 'amortization schedule' })
        }
      }
      anchorCandidates.sort((a, b) => b.date.localeCompare(a.date))
      const anchor = anchorCandidates[0]

      if (loan.status === 'active' && loan.ingestion_method !== 'automatic' && anchor
          && anchor.basis !== LEDGER_BASIS && anchor.basis !== 'unknown') {
        findings.push({
          fingerprint: `intake:basis_conflict:${loan.id}`,
          loan_account_id: loan.id,
          check_key: 'basis_conflict',
          severity: 'error',
          title: `${loanLabel}: balance is measured differently from the ledger`,
          plain_english:
            `The most recent balance on file for this loan comes from its ${anchor.kind} dated ${anchor.date}, `
            + `and that figure is a ${anchor.basis.replace(/_/g, ' ')} amount (${money(anchor.balance)}). `
            + `The Xero ledger records this loan on a principal-only basis. Those two measure different things — `
            + `${anchor.basis === 'total_payback'
                ? 'a total-payback figure still includes fees or interest not yet earned, so it will always read higher than the principal actually owed'
                : 'a payoff quote includes accrued interest and fees, so it will always read higher than the principal actually owed'}. `
            + `Any automatic comparison between them will show a difference that is not a real error. `
            + `This is almost certainly why this loan has looked out of balance.`,
          proposed_action: {
            kind: 'convert_or_retype_balance',
            note:
              `Either record a principal-only balance for this loan (importing the lender's own transaction history does this), `
              + `or convert before comparing: principal = ${anchor.basis} balance minus the unearned fee remaining at that date. `
              + `Do not "fix" the difference by adjusting the ledger — the ledger is not wrong.`,
            anchor_date: anchor.date,
            anchor_basis: anchor.basis,
            anchor_balance: anchor.balance,
            ledger_basis: LEDGER_BASIS,
          },
          detail: {
            anchor_kind: anchor.kind, anchor_date: anchor.date,
            anchor_basis: anchor.basis, anchor_balance: anchor.balance,
            ledger_basis: LEDGER_BASIS,
            real_statement_count: realStmts.length,
            has_schedule: !!sched,
          },
        })
      }

      // ── CHECK B: schedule_vs_statement ─────────────────────────────────────
      // The headline cross-check. For a loan with BOTH sources, does the lender's
      // own statement agree with what the schedule projected for that date?
      // Compares ONLY when both bases are known and equal -- a mismatch in basis
      // is Check A's business, not a discrepancy to report as a number.
      if (sched && realStmts.length && schedRows.length) {
        for (const s of realStmts) {
          if (s.statement_date > today) continue
          if (periodClosed(s.statement_date)) continue   // closed period -- settled, not work
          if (s.balance_basis === 'unknown' || sched.balance_basis === 'unknown') continue
          if (s.balance_basis !== sched.balance_basis) continue  // Check A owns this
          // nearest schedule row within 5 days either side
          let best: any = null, bestGap = 99
          for (const r of schedRows) {
            const g = Math.abs(daysBetween(r.row_date, s.statement_date))
            if (g <= 5 && g < bestGap) { best = r; bestGap = g }
          }
          if (!best) continue
          const diff = Number((n(s.principal_balance)! - n(best.balance)!).toFixed(2))
          if (Math.abs(diff) < MONEY_EPS) continue
          findings.push({
            fingerprint: `intake:schedule_vs_statement:${loan.id}:${s.statement_date}`,
            loan_account_id: loan.id,
            check_key: 'schedule_vs_statement',
            severity: Math.abs(diff) >= 50 ? 'warn' : 'info',
            title: `${loanLabel}: statement and schedule disagree on ${s.statement_date}`,
            plain_english:
              `The lender's statement dated ${s.statement_date} says the balance is ${money(n(s.principal_balance)!)}, `
              + `but the amortization schedule for ${best.row_date} projects ${money(n(best.balance)!)} — `
              + `a difference of ${money(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than projected. `
              + `Both figures are ${s.balance_basis.replace(/_/g, ' ')} amounts, so this is a genuine disagreement, not a units problem. `
              + `Common causes: an extra or missed payment, a rate change, or fees added since the schedule was drawn up.`,
            proposed_action: {
              kind: 'reconcile_schedule_drift',
              note: `Confirm which source is right. If the lender's statement is correct and the loan has genuinely drifted from the schedule, the schedule should be regenerated from the lender's current figures rather than left to disagree every period.`,
              statement_date: s.statement_date, statement_balance: n(s.principal_balance),
              schedule_date: best.row_date, schedule_balance: n(best.balance),
              difference: diff,
            },
            detail: {
              statement_date: s.statement_date, statement_balance: n(s.principal_balance),
              schedule_date: best.row_date, schedule_balance: n(best.balance),
              difference: diff, basis: s.balance_basis, day_gap: bestGap,
            },
          })
        }
      }

      // ── CHECK C: missing_statement_period ──────────────────────────────────
      // Only for loans that actually have a regular monthly-ish rhythm. Rapid's
      // line of credit is pulled ad hoc (median gap ~3 days, wildly variable), so
      // requiring a >= 20 day median keeps this from firing on irregular-by-design
      // loans -- verified against real data before shipping.
      if (loan.status === 'active' && realStmts.length >= 3) {
        const gaps: number[] = []
        for (let i = 1; i < realStmts.length; i++) {
          gaps.push(daysBetween(realStmts[i - 1].statement_date, realStmts[i].statement_date))
        }
        const sorted = [...gaps].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]
        if (median >= 20) {
          for (let i = 1; i < realStmts.length; i++) {
            const gap = daysBetween(realStmts[i - 1].statement_date, realStmts[i].statement_date)
            if (gap <= median * 1.5) continue
            // A missing statement inside closed books cannot be chased any more.
            if (periodClosed(realStmts[i].statement_date)) continue
            const missing = Math.max(1, Math.round(gap / median) - 1)
            findings.push({
              fingerprint: `intake:missing_statement_period:${loan.id}:${realStmts[i - 1].statement_date}`,
              loan_account_id: loan.id,
              check_key: 'missing_statement_period',
              severity: 'warn',
              title: `${loanLabel}: a statement period looks missing`,
              plain_english:
                `Statements for this loan normally arrive about every ${median} days, but there is a ${gap}-day gap `
                + `between ${realStmts[i - 1].statement_date} and ${realStmts[i].statement_date} — roughly `
                + `${missing} statement${missing === 1 ? '' : 's'} unaccounted for. `
                + `A missing statement means the principal/interest split for that period was never computed, `
                + `so that period's interest is probably still sitting in the loan account instead of interest expense.`,
              proposed_action: {
                kind: 'upload_missing_statement',
                note: `Upload the statement(s) covering ${realStmts[i - 1].statement_date} to ${realStmts[i].statement_date}. The split for that period will be computed automatically once it is on file.`,
                gap_start: realStmts[i - 1].statement_date,
                gap_end: realStmts[i].statement_date,
                gap_days: gap, typical_days: median, estimated_missing: missing,
              },
              detail: {
                gap_start: realStmts[i - 1].statement_date, gap_end: realStmts[i].statement_date,
                gap_days: gap, typical_days: median, estimated_missing: missing,
              },
            })
          }
        }
      }
      // ── CHECK D: off_schedule_principal_payment ────────────────────────────
      // The balance fell by MORE than the scheduled payment can explain, which means
      // an extra principal payment landed inside the window. Until session 230 this
      // was silently absorbed into the period's interest -- as a negative number,
      // which then posted (E5-4751 and E6-7410, both 2026-06). The split invariant
      // now refuses to book it; this check is what tells a human WHY and what to do.
      //
      // Detection is automatic. The booking is not: only the bank feed (or a person)
      // knows the DATE the extra payment left the account, and the date decides which
      // period it belongs to. So this proposes, and loan-record-principal-payment
      // does the work once someone confirms.
      if (loan.status === 'active' && realStmts.length >= 2) {
        for (let i = 1; i < realStmts.length; i++) {
          const prev = realStmts[i - 1], cur = realStmts[i]
          if (prev.statement_date > today || cur.statement_date > today) continue
          const drop = Number((n(prev.principal_balance)! - n(cur.principal_balance)!).toFixed(2))
          // Session 270: this read `?? n(loan.scheduled_monthly_payment)`. The extra
          // payment is computed as `drop - scheduled`, so a typed figure that is too
          // LOW manufactures an extra payment out of the difference, every period,
          // for ever. Funding Circle's note says $2,000.00 against a real $2,033.77 --
          // $33.77 of invented "off-schedule principal" per period had the statements
          // not carried the amount. The typed figure is a monthly estimate on a loan
          // whose periods may be weekly; it cannot stand in for what the lender says.
          // No stated amount means the period is not measurable, so it is skipped.
          const scheduled = n(cur.total_amount_due)
          if (scheduled == null || scheduled <= 0) continue
          const extra = Number((drop - scheduled).toFixed(2))
          // A dollar of slack absorbs rounding; anything real is far larger. And a
          // window longer than ~1.5 payment cycles is a MISSING STATEMENT, not an
          // extra payment -- Check C owns that, and double-flagging one gap as two
          // different problems is how a list stops being believed.
          const gap = daysBetween(prev.statement_date, cur.statement_date)
          if (extra <= 1) continue
          if (gap > 46) continue
          findings.push({
            fingerprint: `intake:off_schedule_principal:${loan.id}:${cur.statement_date}`,
            loan_account_id: loan.id,
            check_key: 'off_schedule_principal_payment',
            severity: 'warn',
            title: `${loanLabel}: an extra principal payment around ${cur.statement_date}`,
            plain_english:
              `Between ${prev.statement_date} and ${cur.statement_date} this loan's balance fell ${money(drop)}, `
              + `but the scheduled payment is only ${money(scheduled)} — ${money(extra)} more principal came off than the regular payment explains. `
              + `That is almost always a deliberate extra principal payment. It matters because a period's interest is worked out as payment minus principal: `
              + `with the extra payment folded in, the interest comes out negative, which is impossible and cannot be booked. `
              + `Two readings fit these numbers and only you can say which is right: either the extra payment was ${money(drop)} `
              + `and the regular payment fell outside this window, or it was ${money(extra)} alongside a regular payment inside it.`,
            proposed_action: {
              kind: 'record_principal_payment',
              note: `Confirm the date the extra payment left the bank and which amount is right — ${money(drop)} if the regular payment is not in this window, or ${money(extra)} if it is — then record it as its own entry. Whatever is left in the window is recomputed as the ordinary period.`,
              loan_account_id: loan.id,
              suggested_amount: extra,
              alternative_amount: drop,
              window_from: prev.statement_date,
              window_to: cur.statement_date,
              scheduled_payment: scheduled,
            },
            detail: {
              window_from: prev.statement_date, window_to: cur.statement_date, gap_days: gap,
              balance_fell: drop, scheduled_payment: scheduled, extra_principal: extra,
              prior_balance: n(prev.principal_balance), current_balance: n(cur.principal_balance),
            },
          })
        }
      }

      // ── CHECK E: derivable_not_derived ─────────────────────────────────────
      // A loan becomes pre-stageable the moment it has enough real lender balances
      // to measure a rate against -- and until session 231 NOTHING NOTICED. BayFirst
      // SBA crossed that line on an upload, sat there silently, and was only found
      // because David said "the system did not stage a transaction in future". The
      // absence of a card is invisible by construction: there is nothing on screen
      // to be wrong. So this check exists to make a silence audible.
      //
      // The threshold is the fitter's own: distinct balances, since the fitter
      // collapses repeated ones (Ford's portal is pulled twice a month at the same
      // balance), and minPeriods + 1 = 5 because four periods need five balances.
      // Deliberately NOT re-run here -- this proposes, deriveSchedule measures, and
      // the residual gate is what decides whether it is really fittable. Telling a
      // human "this MIGHT now be derivable, go look" is honest; asserting a rate
      // this function never fitted would not be.
      //
      // Loans that are structurally unstageable (Rapid's draw line, Stripe Capital's
      // percent-of-sales) will trip this and should be SUPPRESSED once -- the upsert
      // below preserves status='suppressed' across re-runs, so saying "not this one"
      // sticks. That is the right shape: the system keeps noticing, the human
      // decides once.
      if (loan.status === 'active' && !loan.prestage_enabled) {
        const distinct: number[] = []
        for (const st of realStmts) {
          const b = n(st.principal_balance)!
          if (distinct.length && Math.abs(distinct[distinct.length - 1] - b) < 0.005) continue
          distinct.push(b)
        }
        // A schedule with rows still ahead of today means this loan already has the
        // input staging needs; why it is not enabled is a different question from
        // this one, and answering it here would double-flag.
        const hasFutureRows = (rows ?? []).some((r: any) =>
          r.row_type === 'payment'
          && (schedules ?? []).some((sc: any) => sc.id === r.schedule_id && sc.loan_account_id === loan.id)
          && String(r.row_date).slice(0, 10) >= today)
        if (distinct.length >= 5 && !hasFutureRows) {
          const first = realStmts[0], last = realStmts[realStmts.length - 1]
          findings.push({
            fingerprint: `intake:derivable_not_derived:${loan.id}`,
            loan_account_id: loan.id,
            check_key: 'derivable_not_derived',
            severity: 'info',
            title: `${loanLabel}: enough lender balances to project a schedule, but none exists`,
            plain_english:
              `This loan now has ${distinct.length} distinct balances straight from the lender, running `
              + `${first.statement_date} to ${last.statement_date}. That is enough to measure what rate it is actually `
              + `charging and project the remaining payments from it, which is what lets a period be staged for approval `
              + `ahead of the bank feed. Right now it has no schedule with any future payments on it, so nothing can stage `
              + `and each payment has to be split by hand after the fact. `
              + `Deriving it is a measurement, not a guess: the projection is only kept if it reproduces every one of this `
              + `loan's own past periods to within five cents, and it is discarded outright if it does not. `
              + `If this loan cannot follow a schedule by its nature — a draw line, or a payment set as a percentage of sales — `
              + `suppress this finding and it will stay suppressed.`,
            proposed_action: {
              kind: 'derive_schedule',
              note: `Run the derived-schedule fit for this loan as a dry run and look at the worst error before enabling anything.`,
              loan_account_id: loan.id,
              lender_account_number: loan.lender_account_number,
              distinct_balances: distinct.length,
            },
            detail: {
              distinct_real_balances: distinct.length,
              real_statements: realStmts.length,
              earliest: first.statement_date,
              latest: last.statement_date,
              has_schedule: !!sched,
              has_future_rows: hasFutureRows,
              prestage_enabled: !!loan.prestage_enabled,
            },
          })
        }
      }
    }

    let written = 0
    if (confirm && findings.length) {
      const nowIso = new Date().toISOString()
      for (const f of findings) {
        const { data: prev } = await supa.from('reconciliation_findings')
          .select('id, pinned_note, status').eq('fingerprint', f.fingerprint).maybeSingle()
        // Respect the same pinning contract the engine honours: a human write-up
        // survives re-runs. Severity and detail still refresh so the numbers stay
        // current; the prose does not get clobbered.
        const payload: Record<string, any> = {
          fingerprint: f.fingerprint,
          loan_account_id: f.loan_account_id,
          check_key: f.check_key,
          severity: f.severity,
          detail: f.detail,
          source: 'intake',
          status: prev?.status === 'suppressed' ? 'suppressed' : 'open',
          last_seen_at: nowIso,
        }
        if (!prev?.pinned_note) {
          payload.title = f.title
          payload.plain_english = f.plain_english
          payload.proposed_action = f.proposed_action
        }
        if (!prev) { payload.first_seen_at = nowIso; payload.resolved_at = null; payload.resolved_run_id = null }
        const { error } = await supa.from('reconciliation_findings').upsert(payload, { onConflict: 'fingerprint' })
        if (!error) written++
      }
    }

    // ── resolve sweep ─────────────────────────────────────────────────────────
    // Without this, a finding stays open forever after the underlying problem is
    // fixed -- and the UI card explicitly promises "Clears automatically once a
    // check confirms it's fixed." A promise the code doesn't keep is worse than no
    // promise, because it teaches people to ignore the list.
    //
    // Scoped TWO ways, both deliberate:
    //   * source='intake'  -- never resolve findings this function does not own.
    //     (reconciliation-run v10 gained the mirror-image guard for the same reason.)
    //   * loan_account_id IN (the loans actually examined) -- a single-loan run must
    //     not resolve every OTHER loan's findings just because it didn't look at them.
    //     This is exactly the bug that makes reconciliation-run unsafe to scope, and
    //     it would be careless to reproduce it here having just written it up.
    let resolved = 0
    if (confirm) {
      const seen = new Set(findings.map((f) => f.fingerprint))
      const { data: openIntake } = await supa.from('reconciliation_findings')
        .select('id, fingerprint')
        .eq('source', 'intake')
        .eq('status', 'open')
        .in('loan_account_id', loanIds)
      for (const row of openIntake ?? []) {
        if (seen.has(row.fingerprint)) continue
        const { error } = await supa.from('reconciliation_findings')
          .update({ status: 'resolved', resolved_at: new Date().toISOString() })
          .eq('id', row.id)
        if (!error) resolved++
      }
    }

    const byCheck: Record<string, number> = {}
    for (const f of findings) byCheck[f.check_key] = (byCheck[f.check_key] ?? 0) + 1

    return new Response(JSON.stringify({
      ok: true,
      dry_run: !confirm,
      wrote_nothing: !confirm,
      loans_examined: loans.length,
      findings_count: findings.length,
      by_check: byCheck,
      written,
      resolved,
      findings,
    }), { headers: H })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e), wrote_nothing: true }), { status: 500, headers: H })
  }
})
