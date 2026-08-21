import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// For lenders with NO monthly statement (schedule-only, e.g. Dexter) -- generates
// a pending_review loan_splits row directly from the amortization schedule for a
// given period, instead of the usual balance-delta-between-two-statements method.
//
// Body: {
//   lender_account_number: string,   // matches loan_accounts.lender_account_number
//   period_label: 'YYYY-MM',         // e.g. '2026-07'
// }
// If more than one 'payment' row falls in that month (e.g. an origination month with
// multiple partial payments), they are summed into a single period split and the
// review_notes flag that so a human can see it's an aggregate.
//
// v2 (session 205 cont., 2026-08-05): CORS fix -- see loan-xero-post v8 for the full
// story (this function is called directly from the browser but never handled the
// OPTIONS preflight, so every real browser call failed with "Failed to fetch"). Wrapped
// the untouched original handler so every response gets Access-Control-Allow-Origin
// merged on; no split-generation logic below changed.
//
// v3 (session 226 end-of-session review, 2026-08-21): Tech Debt #21 closed. The upsert
// on (loan_account_id, period_label) used to blindly reset ANY existing split to
// pending_review without clearing its posting/stage fields -- regenerating an
// already-posted period left a journal-carrying row one Approve away from a duplicate
// (blocked since loan-xero-post v42's hard 409), and regenerating a STAGED period
// would have orphaned a live staged Xero transaction. Client-side guards existed
// (submitLoanScheduleGenerate refuses staged/posted/already_in_xero), but the server
// accepted the destructive upsert from any direct caller. Now the server refuses too:
// an existing split whose status isn't pending_review is a hard 409 naming the status
// and the safe path. Also first version committed to git (v1/v2 were deployed-only),
// and the latest-schedule pick gets nullsFirst:false so a schedule ingested without a
// generated date can never beat a properly dated one (Postgres puts NULLs first on
// DESC by default -- same fix as _shared/staging-next.ts).

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

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const { lender_account_number, period_label } = await req.json()
    if (!lender_account_number || !period_label) {
      return new Response(JSON.stringify({ error: 'lender_account_number and period_label (YYYY-MM) are required' }), { status: 400 })
    }

    const role = await callerRole(req)
    if (!role || !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized -- generating splits requires an admin or manager account.' }), { status: 403 })
    }

    const supa = admin()

    const { data: loanAcct, error: loanErr } = await supa
      .from('loan_accounts')
      .select('id, lender, ingestion_method')
      .eq('lender_account_number', lender_account_number)
      .single()
    if (loanErr || !loanAcct) {
      return new Response(JSON.stringify({ error: `No loan_accounts row for lender_account_number ${lender_account_number}` }), { status: 404 })
    }

    // v3: refuse to regenerate a period whose split has moved past review. The upsert
    // below resets status to pending_review WITHOUT clearing posting/stage fields, so
    // letting it land on a posted split invites a duplicate journal, and letting it
    // land on a staged split orphans a live staged transaction in Xero.
    const { data: priorSplits, error: priorErr } = await supa
      .from('loan_splits')
      .select('id, status')
      .eq('loan_account_id', loanAcct.id)
      .eq('period_label', period_label)
      .limit(1)
    if (priorErr) {
      return new Response(JSON.stringify({ error: 'Lookup failed', details: priorErr.message }), { status: 500 })
    }
    const prior = priorSplits?.[0]
    if (prior && prior.status !== 'pending_review') {
      return new Response(JSON.stringify({
        error: `A split for ${period_label} already exists with status '${prior.status}' -- regenerating it would ${prior.status === 'staged' ? 'orphan the live staged transaction in Xero (unstage it first if you really mean to redo this period)' : 'reset a completed period and risk a duplicate posting'}. Nothing was changed.`,
        existing_split_id: prior.id,
        existing_status: prior.status,
      }), { status: 409 })
    }

    // Most recent amortization schedule for this loan
    const { data: schedules, error: schedErr } = await supa
      .from('loan_amortization_schedules')
      .select('id, schedule_generated_date')
      .eq('loan_account_id', loanAcct.id)
      .order('schedule_generated_date', { ascending: false, nullsFirst: false })
      .limit(1)
    if (schedErr || !schedules?.length) {
      return new Response(JSON.stringify({ error: 'No amortization schedule found for this loan. Ingest one first via loan-ingest-amortization.' }), { status: 404 })
    }
    const scheduleId = schedules[0].id

    const monthStart = `${period_label}-01`
    const [y, m] = period_label.split('-').map((x: string) => parseInt(x, 10))
    const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`

    const { data: rows, error: rowsErr } = await supa
      .from('loan_amortization_rows')
      .select('*')
      .eq('schedule_id', scheduleId)
      .eq('row_type', 'payment')
      .gte('row_date', monthStart)
      .lt('row_date', nextMonth)
      .order('row_date', { ascending: true })
    if (rowsErr) {
      return new Response(JSON.stringify({ error: 'Lookup failed', details: rowsErr.message }), { status: 500 })
    }
    if (!rows?.length) {
      return new Response(JSON.stringify({ error: `No 'payment' rows found in the amortization schedule for period ${period_label}` }), { status: 404 })
    }

    const principal = Math.round(rows.reduce((s: number, r: any) => s + Number(r.principal || 0), 0) * 100) / 100
    const interest = Math.round(rows.reduce((s: number, r: any) => s + Number(r.interest || 0), 0) * 100) / 100
    const total = Math.round(rows.reduce((s: number, r: any) => s + Number(r.payment || 0), 0) * 100) / 100
    const isAggregate = rows.length > 1

    const { data: split, error: splitErr } = await supa
      .from('loan_splits')
      .upsert({
        loan_account_id: loanAcct.id,
        period_label,
        prior_statement_id: null,
        current_statement_id: null,
        source: 'amortization_schedule',
        amortization_row_id: rows[0].id,
        principal_amount: principal,
        interest_amount: interest,
        total_amount: total,
        status: 'pending_review',
        review_notes: isAggregate ? `Aggregated from ${rows.length} schedule rows in ${period_label} (e.g. origination month with multiple partial payments).` : null,
      }, { onConflict: 'loan_account_id,period_label' })
      .select()
      .single()
    if (splitErr) {
      return new Response(JSON.stringify({ error: 'loan_splits upsert failed', details: splitErr.message }), { status: 500 })
    }

    return new Response(JSON.stringify({ ok: true, loan_account: loanAcct, split, source_rows: rows.length }), { headers: { 'Content-Type': 'application/json' } })
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
