import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { ensureUpcomingSplit } from "../_shared/staging-next.ts"

// Ingests a full-life-of-loan amortization schedule (distinct from a monthly statement).
// The row data is parsed by Claude from the lender's PDF/CSV (formats vary too much
// across lenders to auto-parse client-side, and these are uploaded rarely -- at
// origination or after a refi/rate change -- unlike the recurring monthly statement flow).
//
// v12 (session 226, 2026-08-21): first version committed to git (v11 and earlier were
// deployed-only). Adds the Staging Engine hook: after a successful ingest, if the
// schedule contains future payment rows, the loan is switched to prestage_enabled and
// the next period's pending_review split is created via ensureUpcomingSplit -- so
// uploading a schedule (new or re-uploaded) immediately puts a "ready to stage" card
// in front of the CPA. DB-only; nothing is written to Xero here. A past-only schedule
// (e.g. PayPal 2's) changes nothing.
//
// Body: {
//   lender_account_number: string,     // matches loan_accounts.lender_account_number
//   contract_id?: string,
//   amort_type?: string,
//   schedule_generated_date?: 'YYYY-MM-DD',  // the date printed on the schedule itself
//   filename: string,
//   file_base64: string,               // raw PDF/file content, base64-encoded
//   uploaded_by?: string,
//   rows: Array<{
//     row_date: 'YYYY-MM-DD',
//     row_type: 'initial' | 'payment' | 'rate_change' | 'annual_total' | 'grand_total',
//     source_label?: string,           // raw label e.g. 'Auto Payment', 'Cash Payment'
//     loan_amt?: number,
//     rate?: number,
//     payment?: number,
//     interest?: number,
//     principal?: number,
//     balance?: number,
//     addl_info?: string,
//   }>
// }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    const body = await req.json()
    const {
      lender_account_number, contract_id, amort_type, schedule_generated_date,
      filename, file_base64, uploaded_by, rows, balance_basis, source,
    } = body

    // What the 'balance' column actually represents varies by lender, and plenty of
    // schedules never say. 'unknown' is a deliberately representable state -- an untyped
    // balance must NOT be assumed to be principal-only downstream.
    const VALID_BALANCE_BASIS = ['principal_only', 'total_payback', 'payoff_quote', 'unknown']
    const balanceBasis = VALID_BALANCE_BASIS.includes(balance_basis) ? balance_basis : 'unknown'

    if (!lender_account_number || !filename || !file_base64 || !Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({ error: 'lender_account_number, filename, file_base64, and a non-empty rows array are required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const role = await callerRole(req)
    if (!role || !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized -- ingesting amortization schedules requires an admin or manager account.' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const supa = admin()

    const { data: loanAcct, error: loanErr } = await supa
      .from('loan_accounts')
      .select('id, xero_account_id, xero_account_code, xero_bank_account_id, status, prestage_enabled')
      .eq('lender_account_number', lender_account_number)
      .single()
    if (loanErr || !loanAcct) {
      return new Response(JSON.stringify({ error: `No loan_accounts row for lender_account_number ${lender_account_number}. Add it first.`, details: loanErr?.message }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 1. Upload the raw schedule file to storage (permanent proof record), same
    //    bucket as statements, kept in an amortization/ subfolder.
    const genDate = schedule_generated_date || 'unknown-date'
    const storagePath = `${loanAcct.id}/amortization/${genDate}-${filename}`
    const fileBytes = Uint8Array.from(atob(file_base64), c => c.charCodeAt(0))
    const { error: uploadErr } = await supa.storage
      .from('loan-statements')
      .upload(storagePath, fileBytes, { contentType: contentTypeFor(filename), upsert: true })
    if (uploadErr) {
      return new Response(JSON.stringify({ error: 'Storage upload failed', details: uploadErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 2. Upsert the schedule row
    const { data: schedule, error: schedErr } = await supa
      .from('loan_amortization_schedules')
      .upsert({
        loan_account_id: loanAcct.id,
        contract_id: contract_id ?? null,
        amort_type: amort_type ?? null,
        schedule_generated_date: schedule_generated_date ?? null,
        storage_path: storagePath,
        source: source ?? 'claude_assisted_parse',
        balance_basis: balanceBasis,
        uploaded_by: uploaded_by ?? null,
      }, { onConflict: 'loan_account_id,contract_id,schedule_generated_date' })
      .select()
      .single()
    if (schedErr) {
      return new Response(JSON.stringify({ error: 'loan_amortization_schedules upsert failed', details: schedErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 3. Replace any existing rows for this schedule (re-upload = full replace, keeps things simple and consistent)
    const rowsToInsert = rows.map((r: any) => ({
      row_date: r.row_date,
      row_type: r.row_type,
      source_label: r.source_label ?? null,
      loan_amt: r.loan_amt ?? null,
      rate: r.rate ?? null,
      payment: r.payment ?? null,
      interest: r.interest ?? null,
      principal: r.principal ?? null,
      balance: r.balance ?? null,
      addl_info: r.addl_info ?? null,
    }))
    // Delete + insert run inside ONE transaction in the RPC. The previous
    // delete-then-insert from here committed the delete first, so any insert error
    // destroyed the prior schedule's rows with nothing to roll back to.
    const { data: insertedCount, error: rowsErr } = await supa.rpc('replace_amortization_rows', {
      p_schedule_id: schedule.id,
      p_rows: rowsToInsert,
    })
    if (rowsErr) {
      return new Response(JSON.stringify({ error: 'loan_amortization_rows insert failed', details: rowsErr.message, schedule }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // 4. Staging Engine hook (v12): a schedule with future payment rows means this loan
    //    can be pre-staged. Flip prestage_enabled on and put the next period's card in
    //    front of the CPA. Failures here are reported but never fail the ingest -- the
    //    schedule itself landed fine.
    let staging: any = null
    try {
      const hasFuturePayment = rows.some((r: any) => r.row_type === 'payment' && String(r.row_date) >= new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }))
      if (hasFuturePayment) {
        if (!loanAcct.prestage_enabled) {
          const { error: enableErr } = await supa.from('loan_accounts').update({ prestage_enabled: true }).eq('id', loanAcct.id)
          if (enableErr) throw new Error(`prestage_enabled update failed: ${enableErr.message}`)
        }
        const ensured = await ensureUpcomingSplit(supa, loanAcct.id)
        staging = { prestage_enabled: true, ...ensured }
      } else {
        staging = { prestage_enabled: !!loanAcct.prestage_enabled, action: 'skipped', reason: 'no_future_payment_rows' }
      }
    } catch (stageErr) {
      staging = { error: String((stageErr as any)?.message || stageErr) }
    }

    // The upsert conflict key is (loan_account_id, contract_id, schedule_generated_date),
    // and Postgres treats NULLs as distinct -- so a null in either of the last two means
    // the upsert silently INSERTS a duplicate schedule instead of updating the prior one.
    const idempotencyWarning = (contract_id ?? null) === null || (schedule_generated_date ?? null) === null
      ? 'contract_id and/or schedule_generated_date was null, so this ingest could not match an existing schedule and may have created a duplicate. Supply both to make re-uploads update in place.'
      : null

    return new Response(JSON.stringify({ ok: true, loan_account: loanAcct, schedule, rows_inserted: insertedCount, staging, idempotency_warning: idempotencyWarning }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
