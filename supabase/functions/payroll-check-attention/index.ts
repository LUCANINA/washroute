import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// payroll-check-attention v4 (built Aug 6, 2026; corrected Aug 7; Aug 8)
//
// ===================== v4: reimbursement-only lines (Aug 8) =====================
// A reimbursement_only line (Square's monthly insurance-reimbursement-only
// payroll run, no per-employee detail) has no department_key by design, not
// because it's unresolved -- excluded from the unmatched_employees check
// below. It still counts toward needFrom170 via net_pay_amount (mirrors
// payroll-xero-post v18, which credits 170 for that line's net pay too), so
// no other change is needed here.
//
// Proactively re-checks unresolved payroll imports and writes what it finds
// onto payroll_imports (attention_flag / attention_summary / attention_detail),
// so the dashboard renders columns instead of calling Xero on page load.
// Scheduled by pg_cron job wr-payroll-attention-check (every 2 hours), plus a
// manual "Refresh Now" button in the dashboard.
//
// ===================== v3: CORS (Aug 7) =====================
// The "Refresh Now" button had NEVER worked -- it failed with a bare
// "Failed to fetch". v1/v2 shipped with no CORS headers and no OPTIONS
// handler, but the dashboard's _payrollFn() calls edge functions with a raw
// cross-origin fetch() carrying apikey + Authorization + Content-Type, which
// always triggers a preflight. The preflight got a 200 with no
// Access-Control-* headers, so the browser blocked the real request. It went
// unnoticed because the pg_cron job invokes this server-side, where CORS does
// not apply -- so the data always looked fresh even though the button was dead.
// Every other payroll function already had this wrapper; this one was the
// outlier. Lesson: a browser-callable edge function needs the cors block AND
// the OPTIONS short-circuit, and "the cron keeps it fresh" hides a dead button.
//
// ===================== v2 fixes (Aug 7) =====================
// 1) STALE FLAGS. v1 selected only status in ('parsed','reviewed'), so once a
//    period posted it was never revisited and the flag written while it was
//    still 'reviewed' stuck on the dashboard forever. Three July periods sat
//    showing "waiting on cash" for hours after they had actually posted. The
//    real guarantee now lives in the database (trigger
//    trg_clear_payroll_attention nulls attention_* whenever status leaves the
//    actionable set). This function also sweeps orphans as defense in depth.
//
// 2) WRONG SHORTFALL MATH. v1 estimated the 170 credit as wage + employer tax.
//    payroll-xero-post v17 credits 170 by (net pay + employee federal tax +
//    employer tax) and 171 by employee CA tax. MUST mirror payroll-xero-post --
//    if that changes, change this too.
//
// 3) STANDING NOTICES -> payroll_notices, for problems not tied to a pay
//    period. Computed live so they clear themselves when resolved.
//
// Flags: unmapped_employees | insufficient_balance | xero_check_failed
// This function never posts to Xero and never changes an import's status.

const ACCT_DIRECT_WAGES = '170'
const ACCT_DIRECT_PAYROLL_TAXES = '171'
const BALANCE_TOLERANCE = 0.01
const LEGACY_171_NOTICE_KEY = 'legacy_171_balance'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}
const money = (n: number) => Math.round(n * 100) / 100
const n = (v: any) => Number(v || 0)

async function getXeroToken() {
  const clientId = Deno.env.get('XERO_CLIENT_ID')!
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')!
  const basic = btoa(`${clientId}:${clientSecret}`)
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`)
  return (await res.json()).access_token as string
}

// Kept intentionally in sync with the identical helper in payroll-xero-post --
// YTD columns (cells[3]/[4]), never the period columns, which reset monthly.
async function getAccountAvailableBalance(headers: Record<string, string>, accountCode: string): Promise<{ ok: boolean; available?: number; error?: string }> {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const r = await fetch(`https://api.xero.com/api.xro/2.0/Reports/TrialBalance?date=${today}`, { headers })
    const text = await r.text()
    if (!r.ok) return { ok: false, error: `TrialBalance report failed: ${r.status} ${text.slice(0, 200)}` }
    const j = JSON.parse(text)
    for (const section of j.Reports?.[0]?.Rows || []) {
      for (const row of section.Rows || []) {
        const label = row.Cells?.[0]?.Value || ''
        if (label.includes(`(${accountCode})`)) {
          const d = parseFloat(row.Cells?.[3]?.Value || '0') || 0
          const c = parseFloat(row.Cells?.[4]?.Value || '0') || 0
          return { ok: true, available: money(d - c) }
        }
      }
    }
    return { ok: true, available: 0 }
  } catch (err) {
    return { ok: false, error: String((err as any)?.message || err) }
  }
}

async function handleRequest(_req: Request): Promise<Response> {
  const supa = admin()

  const [{ data: imports }, { data: allImports }, { data: lines }] = await Promise.all([
    supa.from('payroll_imports').select('*').in('status', ['parsed', 'reviewed']).order('pay_date', { ascending: true }),
    supa.from('payroll_imports').select('id,status,attention_flag'),
    supa.from('payroll_import_employee_lines').select('*'),
  ])

  // Defense in depth behind trg_clear_payroll_attention.
  const orphans = (allImports || []).filter((i: any) => !['parsed', 'reviewed'].includes(i.status) && i.attention_flag)
  for (const o of orphans) {
    await supa.from('payroll_imports').update({ attention_flag: null, attention_summary: null, attention_detail: null }).eq('id', o.id)
  }

  const results: any[] = []
  const updates: any[] = []

  let avail170 = 0, avail171 = 0
  let balanceOk = true
  let balanceError: string | undefined

  try {
    const token = await getXeroToken()
    const tenantId = Deno.env.get('XERO_TENANT_ID')!
    const xeroHeaders = { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json' }
    const [b170, b171] = await Promise.all([
      getAccountAvailableBalance(xeroHeaders, ACCT_DIRECT_WAGES),
      getAccountAvailableBalance(xeroHeaders, ACCT_DIRECT_PAYROLL_TAXES),
    ])
    balanceOk = b170.ok && b171.ok
    balanceError = b170.error || b171.error
    avail170 = b170.available ?? 0
    avail171 = b171.available ?? 0
  } catch (err) {
    balanceOk = false
    balanceError = String((err as any)?.message || err)
  }

  // Employee CA tax still owed by periods that haven't posted yet. Excluded
  // from the legacy-171 figure so a normal mid-week EDD payment sitting in 171
  // waiting for its period to post never looks like a legacy problem.
  let pendingEeCa = 0

  for (const imp of imports || []) {
    const impLines = (lines || []).filter((l: any) => l.import_id === imp.id)
    const unmatched = impLines.filter((l: any) => !l.department_key && l.line_type !== 'reimbursement_only')

    let flag: string | null = null
    let summary: string | null = null
    let detail: string | null = null

    const impEeCa = money(impLines.reduce((s: number, l: any) => s + n(l.ee_ca_state_income_amount) + n(l.ee_ca_state_disability_amount), 0))
    pendingEeCa = money(pendingEeCa + impEeCa)

    if (unmatched.length) {
      flag = 'unmapped_employees'
      summary = `${unmatched.length} employee${unmatched.length === 1 ? '' : 's'} still need${unmatched.length === 1 ? 's' : ''} a department`
      detail = `On the pay period ${imp.pay_period_start} to ${imp.pay_period_end}, these names on the Square report don't match anyone in the department mapping yet: ${[...new Set(unmatched.map((u: any) => u.raw_full_name))].join(', ')}. Open the review screen to map them.`
    } else if (imp.status === 'reviewed') {
      const missingFields = impLines.some((l: any) => l.net_pay_amount === null || l.ee_health_amount === null)
      // Mirrors payroll-xero-post v17 exactly.
      const needFrom170 = money(impLines.reduce((s: number, l: any) =>
        s + n(l.net_pay_amount)
          + n(l.ee_fed_income_amount) + n(l.ee_social_security_amount) + n(l.ee_medicare_amount)
          + n(l.er_tax_amount), 0))
      const needFrom171 = impEeCa

      if (missingFields) {
        flag = 'unmapped_employees'
        summary = 'This period was parsed by an older version and is missing pay-stub fields'
        detail = `The employee lines for ${imp.pay_period_start} to ${imp.pay_period_end} predate the full pay-stub parser, so the amounts to post can't be computed reliably. Re-upload this period's Square CSV using Replace so it re-parses, then post.`
      } else if (!balanceOk) {
        flag = 'xero_check_failed'
        summary = `Couldn't verify the Xero balance before this can post`
        detail = `The last check of the payroll clearing accounts failed: ${balanceError}. This doesn't mean anything is wrong with this period -- it means the Xero connection needs a look before it can be safely posted.`
      } else if (needFrom170 > avail170 + BALANCE_TOLERANCE || needFrom171 > avail171 + BALANCE_TOLERANCE) {
        const parts: string[] = []
        if (needFrom170 > avail170 + BALANCE_TOLERANCE) parts.push(`$${money(needFrom170 - avail170).toFixed(2)} short in "170 Direct Wages"`)
        if (needFrom171 > avail171 + BALANCE_TOLERANCE) parts.push(`$${money(needFrom171 - avail171).toFixed(2)} short in "171 Direct Payroll Taxes"`)
        flag = 'insufficient_balance'
        summary = `Not enough cash landed in Xero yet to post (${parts.join('; ')})`
        detail = `Posting this period would credit $${needFrom170.toFixed(2)} out of "170 Direct Wages" (net pay + employee federal tax + employer tax) and $${needFrom171.toFixed(2)} out of "171 Direct Payroll Taxes" (employee CA tax). Right now those accounts hold $${avail170.toFixed(2)} and $${avail171.toFixed(2)} (after accounting for any earlier periods that would post first). This normally clears on its own once the Square draft, the IRS deposit and the EDD remittance all land in the bank feed -- no action needed unless it's been sitting for a while.`
      } else {
        avail170 = money(avail170 - needFrom170)
        avail171 = money(avail171 - needFrom171)
      }
    }

    updates.push({ id: imp.id, attention_flag: flag, attention_summary: summary, attention_detail: detail })
    results.push({ import_id: imp.id, period: `${imp.pay_period_start} to ${imp.pay_period_end}`, status: imp.status, flag, summary })
  }

  for (const u of updates) {
    await supa.from('payroll_imports').update({
      attention_flag: u.attention_flag,
      attention_summary: u.attention_summary,
      attention_detail: u.attention_detail,
      attention_checked_at: new Date().toISOString(),
    }).eq('id', u.id)
  }

  // ---- Standing notice: legacy balance in 171 Direct Payroll Taxes ----
  // 171 receives the EDD draw of employee CA tax withholding, and
  // payroll-xero-post clears each period's share when that period posts. So a
  // residual beyond what unposted periods still owe is money nobody has ever
  // reallocated -- currently $5,389.23 dating to May 2026, predating this
  // system. It matters because employee withholding is already inside gross
  // wages, so leaving it in a cost account may double-count the same dollars
  // in the CPA's books. Flagged for a human, never auto-cleared.
  let notice: any = null
  if (balanceOk) {
    // avail171 has already been drawn down by the reviewed periods above that
    // would post, so what remains is the legacy portion.
    const legacy = money(avail171)
    if (legacy > BALANCE_TOLERANCE) {
      notice = {
        key: LEGACY_171_NOTICE_KEY,
        severity: 'warning',
        title: `$${legacy.toFixed(2)} sitting in "171 Direct Payroll Taxes" that nobody has ever reallocated`,
        detail: `Account 171 holds employee California tax withheld from paychecks and remitted to the EDD. Every pay period this system posts now clears its own share automatically, so this balance is left over from before that -- it dates to May 2026 and no journal has ever moved it.\n\nWhy it matters: employee withholding is already included in gross wages, which are expensed to the department Wages accounts. If this balance is also sitting in a cost account, the same dollars may be counted twice on the P&L. That is exactly the mistake that was found and corrected inside this system on Aug 7, 2026 -- but this portion predates the system and lives in your CPA's own bookkeeping.\n\nSuggested next step: ask your CPA whether 171 is meant to carry a balance at all, or whether it should be cleared against wages. Don't clear it here without their answer.${pendingEeCa > BALANCE_TOLERANCE ? `\n\nNote: $${pendingEeCa.toFixed(2)} of employee CA tax belonging to pay periods that haven't posted yet is already excluded from this figure.` : ''}`,
        amount: legacy,
        active: true,
        checked_at: new Date().toISOString(),
      }
      await supa.from('payroll_notices').upsert(notice, { onConflict: 'key' })
    } else {
      await supa.from('payroll_notices').upsert({
        key: LEGACY_171_NOTICE_KEY, severity: 'warning',
        title: 'Legacy balance in 171 Direct Payroll Taxes', detail: null, amount: 0,
        active: false, checked_at: new Date().toISOString(),
      }, { onConflict: 'key' })
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    checked: updates.length,
    flagged: updates.filter(u => u.attention_flag).length,
    stale_flags_cleared: orphans.length,
    notice: notice ? { key: notice.key, amount: notice.amount } : null,
    results,
  }, null, 2), { headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const res = await handleRequest(req)
    const merged = new Headers(res.headers)
    for (const [k, v] of Object.entries(cors)) merged.set(k, v)
    if (!merged.has('Content-Type')) merged.set('Content-Type', 'application/json')
    return new Response(res.body, { status: res.status, headers: merged })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
