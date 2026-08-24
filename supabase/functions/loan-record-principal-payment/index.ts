import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// loan-record-principal-payment — v1 (session 230)
// =============================================================================
// Books an OFF-SCHEDULE principal payment as its own entry, and repairs the
// scheduled period it was hiding inside.
//
// ── THE PROBLEM ──────────────────────────────────────────────────────────────
// Every split derived from statements assumes exactly one scheduled payment between
// two balances:  interest = payment - (prior_balance - balance).
// An extra principal payment inside that window makes the balance fall further than
// the payment explains, and the excess is pushed into interest as a negative number.
// Real cases: E-Transit 4140 paid an extra $5,000 between the 2026-07-28 and
// 2026-08-10 statements; E4 -9744 paid $4,903.21 in May 2026; N202-8562 paid $5,000
// and then a $7,653.54 payoff.
//
// ── THE SHAPE OF THE FIX ─────────────────────────────────────────────────────
// TWO entries, because two things happened and each has its own bank-feed line:
//   1. the lump          -- source 'principal_payment', all principal, no interest
//   2. the scheduled one -- the ordinary period, computed on what remains
// This is the same one-split-per-feed-line rule the Staging Engine already enforces
// for weekly loans. Never one blended entry: a blended entry cannot be matched
// against either line, and it is what produced the negative interest.
//
// ── DETECTION IS AUTOMATIC, BOOKING IS NOT ───────────────────────────────────
// loan-cross-check flags the discrepancy and proposes these numbers. This function
// only ever runs on an explicit confirm, because the DATE of the lump decides which
// period it belongs to and only a human (or the bank feed) knows it.
//
// Body: {
//   loan_account_id: string,
//   payment_date: 'YYYY-MM-DD',   // the date the extra payment left the bank
//   amount: number,               // the extra principal, positive
//   confirm?: boolean,            // default false -- dry run
//   scheduled_payment?: number,   // override; otherwise the loan's own figure
// }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}
const r2 = (n: number) => Math.round(n * 100) / 100
const money = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (v: any): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors })
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: cors })
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: userData } = await anon.auth.getUser(token)
    if (!userData?.user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: cors })
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: prof } = await supa.from('profiles').select('role').eq('id', userData.user.id).single()
    const role = prof?.role
    if (!['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: `Forbidden (role: ${role ?? 'none'})` }), { status: 403, headers: cors })
    }

    const body = await req.json().catch(() => ({}))
    const confirm = body.confirm === true
    if (confirm && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Recording a payment requires admin or manager.' }), { status: 403, headers: cors })
    }
    const loanId = String(body.loan_account_id || '')
    const payDate = String(body.payment_date || '')
    const amount = num(body.amount)
    if (!loanId || !/^\d{4}-\d{2}-\d{2}$/.test(payDate) || amount === null || amount <= 0) {
      return new Response(JSON.stringify({ error: 'loan_account_id, payment_date (YYYY-MM-DD) and a positive amount are all required.' }), { status: 400, headers: cors })
    }

    const { data: loan } = await supa.from('loan_accounts').select('*').eq('id', loanId).single()
    if (!loan) return new Response(JSON.stringify({ error: 'No such loan account.' }), { status: 404, headers: cors })

    // ── The window the lump falls inside ─────────────────────────────────────
    // The two real statements either side of the payment date. Without both, the
    // scheduled period cannot be recomputed and there is nothing to repair.
    const REAL = ['lender_statement', 'email_pdf_upload', 'portal_manual_pull']
    const { data: before } = await supa.from('loan_statements')
      .select('id, statement_date, principal_balance, total_amount_due')
      .eq('loan_account_id', loanId).in('source', REAL).not('principal_balance', 'is', null)
      .lte('statement_date', payDate).order('statement_date', { ascending: false }).limit(1)
    const { data: after } = await supa.from('loan_statements')
      .select('id, statement_date, principal_balance, total_amount_due')
      .eq('loan_account_id', loanId).in('source', REAL).not('principal_balance', 'is', null)
      .gte('statement_date', payDate).order('statement_date', { ascending: true }).limit(1)
    const b = before?.[0], a = after?.[0]
    if (!b || !a) {
      return new Response(JSON.stringify({
        error: 'This payment date is not bracketed by two lender statements on file, so the period it belongs to cannot be recomputed. Upload the statement that covers it first.',
        have_before: !!b, have_after: !!a,
      }), { status: 409, headers: cors })
    }

    const drop = r2(Number(b.principal_balance) - Number(a.principal_balance))
    const scheduled = num(body.scheduled_payment) ?? num(a.total_amount_due) ?? num(loan.scheduled_monthly_payment)
    if (scheduled === null) {
      return new Response(JSON.stringify({ error: 'No scheduled payment amount is known for this loan, so the ordinary period cannot be separated from the extra payment.' }), { status: 409, headers: cors })
    }
    if (amount > drop + 0.01) {
      return new Response(JSON.stringify({
        error: `The balance only fell ${money(drop)} between ${b.statement_date} and ${a.statement_date}, so an extra principal payment of ${money(amount)} cannot have happened inside it.`,
      }), { status: 409, headers: cors })
    }

    // What the scheduled period looks like once the lump is taken out of it.
    //
    // A window can hold ONLY the lump: Ford's portal was pulled on 2026-08-10 the day
    // after a $5,000 extra payment, and the regular August payment landed in the NEXT
    // window. Then there is no ordinary period hiding in here to repair -- inventing
    // one would book a period with no principal and a full month of interest, and it
    // would collide with the real period's label.
    const schedPrincipal = r2(drop - amount)
    const schedInterest = r2(scheduled - schedPrincipal)
    const lumpOnlyWindow = schedPrincipal <= 0.01
    const periodLabel = a.statement_date.slice(0, 7)
    const plan = {
      lump: { period_label: payDate, source: 'principal_payment', principal: r2(amount), interest: 0, total: r2(amount) },
      scheduled_period: lumpOnlyWindow
        ? { skipped: true, reason: `The whole ${money(drop)} drop in this window is the extra payment, so there is no ordinary period inside it to recompute. This loan's regular payment for ${periodLabel} sits in a different window and is computed as usual.` }
        : { period_label: periodLabel, source: 'statement_delta', principal: schedPrincipal, interest: schedInterest, total: scheduled },
      window: { from: b.statement_date, to: a.statement_date, balance_fell: drop },
    }
    // Refuse to propose something the ledger would reject anyway -- if the leftover
    // period still doesn't make sense, the lump amount or its date is wrong.
    const { data: inv } = lumpOnlyWindow ? { data: null } : await supa.rpc('split_invariant_check', {
      p_principal: schedPrincipal, p_interest: schedInterest, p_total: scheduled,
    })
    if (inv && inv.ok === false) {
      return new Response(JSON.stringify({
        error: `Taking ${money(amount)} out of this window leaves a period that still doesn't add up: ${inv.note}`,
        plan, reason: 'residual_period_invalid',
      }), { status: 409, headers: cors })
    }

    if (!confirm) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, wrote_nothing: true, loan: loan.xero_account_name, plan }), { headers: cors })
    }

    // ── Write ────────────────────────────────────────────────────────────────
    // The lump is keyed on its own date so it can never collide with a monthly
    // period label, and it carries the closing statement as provenance.
    const { data: existing } = await supa.from('loan_splits')
      .select('id, status').eq('loan_account_id', loanId).eq('period_label', payDate).maybeSingle()
    if (existing) {
      return new Response(JSON.stringify({ error: `An entry already exists for ${payDate} (${existing.status}) -- nothing was written.`, split_id: existing.id }), { status: 409, headers: cors })
    }
    const { data: lumpRow, error: lumpErr } = await supa.from('loan_splits').insert({
      loan_account_id: loanId,
      period_label: payDate,
      current_statement_id: a.id,
      prior_statement_id: b.id,
      source: 'principal_payment',
      principal_amount: r2(amount), interest_amount: 0, total_amount: r2(amount),
      status: 'pending_review',
      review_notes: `Extra principal payment of ${money(amount)} on ${payDate}, recorded as its own entry so the ${periodLabel} period computes correctly. All principal, no interest -- the bank feed line for it codes straight to the loan account.`,
    }).select().single()
    if (lumpErr) {
      return new Response(JSON.stringify({ error: 'Could not record the extra payment', details: lumpErr.message }), { status: 500, headers: cors })
    }

    // Repair the scheduled period. Only ever an UNPOSTED row: a period already
    // posted or staged is history, and correcting it is a human decision with a
    // Xero side to it, not something to rewrite underneath.
    let scheduledSplit: any = plan.scheduled_period
    if (lumpOnlyWindow) {
      return new Response(JSON.stringify({ ok: true, dry_run: false, loan: loan.xero_account_name, plan, lump_split: lumpRow, scheduled_split: scheduledSplit }), { headers: cors })
    }
    const { data: prior } = await supa.from('loan_splits')
      .select('id, status').eq('loan_account_id', loanId).eq('period_label', periodLabel).maybeSingle()
    if (prior && !['pending_review', 'needs_attention'].includes(prior.status)) {
      scheduledSplit = { skipped: true, reason: `The ${periodLabel} period is already ${prior.status}; it was left alone. If it was booked with the extra payment folded into it, it needs correcting in Xero by hand.`, split_id: prior.id }
    } else {
      const { data: fixed, error: fixErr } = await supa.from('loan_splits').upsert({
        loan_account_id: loanId,
        period_label: periodLabel,
        prior_statement_id: b.id,
        current_statement_id: a.id,
        source: 'statement_delta',
        principal_amount: schedPrincipal, interest_amount: schedInterest, total_amount: scheduled,
        status: 'pending_review',
        review_notes: `Recomputed after the ${money(amount)} extra principal payment on ${payDate} was recorded separately: the balance fell ${money(drop)} in this window, of which ${money(amount)} was the extra payment, leaving ${money(schedPrincipal)} of scheduled principal and ${money(schedInterest)} of interest.`,
      }, { onConflict: 'loan_account_id,period_label' }).select().single()
      if (fixErr) {
        return new Response(JSON.stringify({ error: 'The extra payment was recorded, but the scheduled period could not be recomputed', details: fixErr.message, lump_split_id: lumpRow.id }), { status: 500, headers: cors })
      }
      scheduledSplit = fixed
    }

    return new Response(JSON.stringify({ ok: true, dry_run: false, loan: loan.xero_account_name, plan, lump_split: lumpRow, scheduled_split: scheduledSplit }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
