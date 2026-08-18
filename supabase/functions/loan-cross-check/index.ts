// loan-cross-check — v1
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

    let loanQ = supa.from('loan_accounts')
      .select('id, lender, lender_account_number, status, ingestion_method, xero_account_code')
    if (onlyLoanId) loanQ = loanQ.eq('id', onlyLoanId)
    const { data: loans } = await loanQ
    if (!loans?.length) {
      return new Response(JSON.stringify({ ok: true, dry_run: !confirm, findings: [], note: 'No loans matched.' }), { headers: H })
    }
    const loanIds = loans.map((l: any) => l.id)

    const { data: statements } = await supa.from('loan_statements')
      .select('id, loan_account_id, statement_date, principal_balance, balance_basis, source')
      .in('loan_account_id', loanIds)
    const { data: schedules } = await supa.from('loan_amortization_schedules')
      .select('id, loan_account_id, balance_basis, schedule_generated_date')
      .in('loan_account_id', loanIds)
    const schedIds = (schedules ?? []).map((s: any) => s.id)
    const { data: rows } = schedIds.length
      ? await supa.from('loan_amortization_rows')
          .select('schedule_id, row_date, row_type, balance, principal, interest, payment')
          .in('schedule_id', schedIds)
      : { data: [] as any[] }

    const findings: Finding[] = []

    for (const loan of loans) {
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
          title: `${loan.lender}: balance is measured differently from the ledger`,
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
            title: `${loan.lender}: statement and schedule disagree on ${s.statement_date}`,
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
            const missing = Math.max(1, Math.round(gap / median) - 1)
            findings.push({
              fingerprint: `intake:missing_statement_period:${loan.id}:${realStmts[i - 1].statement_date}`,
              loan_account_id: loan.id,
              check_key: 'missing_statement_period',
              severity: 'warn',
              title: `${loan.lender}: a statement period looks missing`,
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
