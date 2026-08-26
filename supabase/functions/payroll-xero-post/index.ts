import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// payroll-xero-post
// v13 (Aug 6) real-cash safety check after the overdraw incident.
// v14 (Aug 6) began debiting employee CA tax to department tax accounts -- WRONG, double-count.
// v15 (Aug 7) same for employee federal tax -- WRONG, blocked by the cash check before posting.
// v16 (Aug 7) both reverted; wages + employer tax only.
// v17 (Aug 7) COMPLETE: reproduces the CPA's own journal so each period clears 170 to zero.
// v18 (Aug 8) excludes line_type='reimbursement_only' lines from the "unmatched
// employee, needs a department" gate -- a reimbursement-only synthetic line
// (Square's monthly insurance-reimbursement-only payroll run, no per-employee
// detail) has no department_key BY DESIGN, that's not an unresolved employee
// name. It still flows through the totals loop below unchanged: with
// wage/tips/er_tax all zero it contributes nothing to any department debit,
// only to tInsReimb/tNetPay, which is exactly right -- it debits to 675 and
// credits 170 like any other insurance reimbursement, with no department
// wage/tax line at all.
// v19 (Aug 17) shortened Narration + JournalLine Descriptions -- see
// "SUCCINCT NARRATIONS" note below. Purely cosmetic (Xero-display-facing
// strings only); the account codes, amounts, and posting logic are unchanged.
// v20 (Aug 17) Narration now tags the run kind ("Payroll adjustment" /
// "Payroll reimbursement" / "Payroll") based on imp.import_type -- needed
// once off-cycle adjustment imports can share the same nominal pay period as
// a regular run (see payroll_imports_add_adjustment_type migration + the
// payroll-ingest v17 adjustment upload path). Without this, two journals for
// the same period were only distinguishable by their (different) pay_date.
// Cosmetic only; posting logic unchanged.
//
// ===================== WHY v16 WAS STILL INCOMPLETE =====================
// v16 debited only wages + employer tax and credited only 170/171. That left
// employee health and employee 401k withholding unaccounted for, so 170 drifted
// about $600 NEGATIVE every period. It also stranded paycheck tips in 170.
//
// ===================== THE MODEL, VERIFIED =====================
// Governing identity, true to the penny on all 5 July 2026 periods:
//     gross - EE federal - EE CA - EE health - EE 401k + insurance reimb = net pay
// (gross INCLUDES paycheck tips.)
//
// Where the cash actually goes each period:
//     Square draws NET PAY .......................... 170
//     IRS draws EE federal + ER federal tax ......... 170
//     EDD draws ER California tax ................... 170
//     EDD draws EE California tax ................... 171
//   =>  170 cash = net pay + EE federal + ALL employer tax
//       171 cash = EE California
//
// Employee withholding is ALREADY inside gross pay. It is never an extra
// department debit -- it only determines WHICH account the credit comes from.
// Debiting it again is exactly the v14/v15 bug ($4,465.21 of duplicate expense
// reached the ledger and had to be reversed by payroll-fix-ca-doublecount).
//
// ===================== THE JOURNAL (matches the CPA's own) =====================
// Confirmed against the CPA's "To Allocate the Square payroll" journals for
// Apr/May/Jun 2026 pulled from Xero -- identical shape, and their June credit to
// 170 (-110,787.59) matches June's real bank cash exactly.
//
//   DEBIT  department wage account  = wages + paycheck tips
//   DEBIT  department tax account   = employer tax ONLY
//   DEBIT  675 Insurance - Medical  = insurance reimbursement stipend
//   CREDIT 170 Direct Wages         = net pay + EE federal + employer tax
//   CREDIT 171 Direct Payroll Taxes = EE California tax
//   CREDIT 675 Insurance - Medical  = EE health withheld
//   CREDIT 358 401k contributions   = EE 401k withheld
//
// Tips ride in the department WAGE accounts per David (Aug 7): they are paid out
// monthly and land only in Delivery (173) and Laundry (172).
//
// This clears 170 and 171 to exactly zero for the period. If a leftover ever
// appears, something real is unaccounted for -- investigate it, do NOT invent a
// catch-up to absorb it. That reasoning is what produced v14/v15.
//
// ===================== SUCCINCT NARRATIONS (v19, Aug 17) =====================
// Xero's Account Transactions report concatenates a ManualJournal's Narration
// with EVERY JournalLine's own Description when rendering -- a long Narration
// is effectively repeated once per line, and repeats again every pay period.
// Two periods' worth of the old ~300-char Narration + long per-line
// Descriptions rendered as an unreadable wall of text (flagged by David,
// session 219). Keep both fields short: Narration carries the period + pay
// date ONCE, per-line Descriptions carry only what's unique to that line
// (department + line purpose). Do not let this drift back to prose -- see the
// convention codified in PROJECT-NOTES-BOOKKEEPING.md's Invariants section.
//
// Body: { import_id, confirm?, posted_by? }. Default is a dry run.
// admin/manager/cpa may preview; only admin/manager may post.

const ACCT_DIRECT_WAGES = '170'
const ACCT_DIRECT_PAYROLL_TAXES = '171'
const ACCT_401K = '358'
const ACCT_HEALTH = '675'
const BALANCE_TOLERANCE = 0.01

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function callerRole(req: Request) {
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
  const { data: { user } } = await anon.auth.getUser(token)
  if (!user) return null
  const { data: profile } = await admin().from('profiles').select('role').eq('id', user.id).single()
  return profile?.role || null
}

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

const money = (n: number) => Math.round(n * 100) / 100

// YTD debit/credit pair (cells[3]/[4]), NOT the period pair -- the period
// columns reset on the 1st of each month and would wrongly report $0 available
// for cash genuinely still sitting in the account from the prior month.
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
          const ytdDebit = parseFloat(row.Cells?.[3]?.Value || '0') || 0
          const ytdCredit = parseFloat(row.Cells?.[4]?.Value || '0') || 0
          return { ok: true, available: money(ytdDebit - ytdCredit) }
        }
      }
    }
    return { ok: true, available: 0 }
  } catch (err) {
    return { ok: false, error: String((err as any)?.message || err) }
  }
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const body = await req.json().catch(() => ({}))
    const { import_id, confirm, posted_by } = body
    if (!import_id) return new Response(JSON.stringify({ error: 'import_id is required' }), { status: 400 })

    const role = await callerRole(req)
    if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403 })
    }
    if (confirm && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Your account has read-only access -- posting to Xero requires an admin or manager.' }), { status: 403 })
    }

    const supa = admin()
    const { data: imp, error: impErr } = await supa.from('payroll_imports').select('*').eq('id', import_id).single()
    if (impErr || !imp) return new Response(JSON.stringify({ error: 'payroll_imports row not found', details: impErr?.message }), { status: 404 })
    if (imp.status === 'posted') return new Response(JSON.stringify({ error: 'This payroll period is already posted to Xero.', xero_manual_journal_id: imp.xero_manual_journal_id }), { status: 409 })
    // ── SESSION 241: STATUS ALONE IS NOT ENOUGH ─────────────────────────────
    // A row can carry a journal id while its status says otherwise. That is not
    // hypothetical: payroll-ingest's replace branch used to reset a POSTED period
    // to 'parsed' and leave the id in place, and any row created that way is
    // still out there. Posting on status alone puts a second journal in Xero for
    // a period that already has one.
    //
    // Copied from loan-xero-post (v42), which has refused exactly this shape for
    // months: the id is evidence about Xero, and a local status may not outrank
    // it. Repair the row or void the journal -- never resolve it by posting again.
    if (imp.xero_manual_journal_id) {
      return new Response(JSON.stringify({
        error: `This payroll period already carries Xero Manual Journal ${imp.xero_manual_journal_id} even though its status is '${imp.status}' -- posting again would create a duplicate journal. This usually means a posted period was re-uploaded. Check the journal in Xero; if it should not exist, void it there; if it should, this row needs its status repaired, not a second post.`,
        xero_manual_journal_id: imp.xero_manual_journal_id,
        status: imp.status,
      }), { status: 409 })
    }
    if (imp.status === 'void') return new Response(JSON.stringify({ error: 'This payroll period is marked void and cannot be posted.' }), { status: 409 })
    if (imp.status !== 'reviewed') return new Response(JSON.stringify({ error: 'This payroll period must be marked Reviewed (with every employee mapped to a department) before it can be posted to Xero.' }), { status: 400 })

    const [{ data: lines }, { data: departments }] = await Promise.all([
      supa.from('payroll_import_employee_lines').select('*').eq('import_id', import_id),
      supa.from('payroll_departments').select('*').eq('active', true).order('sort_order'),
    ])

    // A reimbursement_only line (Square's monthly insurance-reimbursement-only
    // run, no per-employee detail) has no department_key by design -- it isn't
    // wages and isn't tied to any employee. That's not the same as an
    // unresolved employee name, so it's excluded from this gate.
    const unmatched = (lines || []).filter((l: any) => !l.department_key && l.line_type !== 'reimbursement_only')
    if (unmatched.length) {
      return new Response(JSON.stringify({ error: `${unmatched.length} employee(s) on this import still aren't mapped to a department -- resolve them on the review screen first.`, unmatched: unmatched.map((u: any) => u.raw_full_name) }), { status: 400 })
    }

    // Older imports (before Aug 7 2026) predate the benefit/net-pay columns.
    // Refuse rather than silently coalescing them to zero and stranding cash.
    const stale = (lines || []).filter((l: any) => l.ee_health_amount === null || l.ee_401k_amount === null || l.insurance_reimbursement_amount === null)
    if (stale.length) {
      return new Response(JSON.stringify({ error: `${stale.length} employee line(s) on this import are missing the benefit-deduction fields (they were parsed by an older version). Re-upload this period's CSV with Replace so it re-parses, then post.` }), { status: 400 })
    }

    const n = (v: any) => Number(v || 0)
    const byDept: Record<string, { wage: number; tips: number; erTax: number }> = {}
    let tEeCa = 0, tEeFed = 0, tEeHealth = 0, tEe401k = 0, tInsReimb = 0, tNetPay = 0
    for (const l of lines || []) {
      const t = byDept[l.department_key] || (byDept[l.department_key] = { wage: 0, tips: 0, erTax: 0 })
      t.wage += n(l.wage_amount); t.tips += n(l.paycheck_tips_amount); t.erTax += n(l.er_tax_amount)
      tEeCa += n(l.ee_ca_state_income_amount) + n(l.ee_ca_state_disability_amount)
      tEeFed += n(l.ee_fed_income_amount) + n(l.ee_social_security_amount) + n(l.ee_medicare_amount)
      tEeHealth += n(l.ee_health_amount); tEe401k += n(l.ee_401k_amount)
      tInsReimb += n(l.insurance_reimbursement_amount); tNetPay += n(l.net_pay_amount)
    }
    tEeCa = money(tEeCa); tEeFed = money(tEeFed); tEeHealth = money(tEeHealth)
    tEe401k = money(tEe401k); tInsReimb = money(tInsReimb); tNetPay = money(tNetPay)

    const periodLabel = `${imp.pay_period_start} – ${imp.pay_period_end}`
    const runLabel = imp.import_type === 'adjustment' ? 'Payroll adjustment' : imp.import_type === 'reimbursement_only' ? 'Payroll reimbursement' : 'Payroll'
    const journalLines: any[] = []
    let tWage = 0, tTips = 0, tErTax = 0
    for (const d of departments || []) {
      const t = byDept[d.key]
      if (!t) continue
      const wageAndTips = money(t.wage + t.tips)
      const erTax = money(t.erTax)
      if (wageAndTips > 0) {
        journalLines.push({ AccountCode: d.wage_account_code, LineAmount: wageAndTips, Description: t.tips > 0 ? `${d.display_name} wages (+$${money(t.tips).toFixed(2)} tips)` : `${d.display_name} wages`, TaxType: 'NONE' })
      }
      if (erTax > 0) {
        journalLines.push({ AccountCode: d.tax_account_code, LineAmount: erTax, Description: `${d.display_name} ER tax`, TaxType: 'NONE' })
      }
      tWage += t.wage; tTips += t.tips; tErTax += erTax
    }
    tWage = money(tWage); tTips = money(tTips); tErTax = money(tErTax)

    if (tInsReimb > 0) {
      journalLines.push({ AccountCode: ACCT_HEALTH, LineAmount: tInsReimb, Description: `Insurance reimbursement`, TaxType: 'NONE' })
    }

    const creditFrom171 = tEeCa
    const creditFrom170 = money(tNetPay + tEeFed + tErTax)

    if (creditFrom170 <= 0 && creditFrom171 <= 0) {
      return new Response(JSON.stringify({ error: 'Nothing to post -- this period has no payroll cash.' }), { status: 400 })
    }
    if (creditFrom170 > 0) journalLines.push({ AccountCode: ACCT_DIRECT_WAGES, LineAmount: -creditFrom170, Description: `Payroll cash draw (net pay + EE fed + ER tax)`, TaxType: 'NONE' })
    if (creditFrom171 > 0) journalLines.push({ AccountCode: ACCT_DIRECT_PAYROLL_TAXES, LineAmount: -creditFrom171, Description: `EE CA tax to EDD`, TaxType: 'NONE' })
    if (tEeHealth > 0) journalLines.push({ AccountCode: ACCT_HEALTH, LineAmount: -tEeHealth, Description: `EE health withheld`, TaxType: 'NONE' })
    if (tEe401k > 0) journalLines.push({ AccountCode: ACCT_401K, LineAmount: -tEe401k, Description: `EE 401k withheld`, TaxType: 'NONE' })

    // Self-check: the journal must balance to zero. If it doesn't, the pay-stub
    // identity broke (Square added a column we don't read) -- refuse rather than
    // let Xero silently absorb the difference.
    const journalSum = money(journalLines.reduce((s, l) => s + l.LineAmount, 0))
    if (Math.abs(journalSum) > BALANCE_TOLERANCE) {
      return new Response(JSON.stringify({
        error: `Refusing to post: the computed journal does not balance (off by $${journalSum.toFixed(2)}). This means the Square pay-stub figures no longer reconcile -- most likely a new pay or deduction column. Send this to Claude.`,
        debug: { tWage, tTips, tErTax, tEeCa, tEeFed, tEeHealth, tEe401k, tInsReimb, tNetPay, creditFrom170, creditFrom171 },
      }), { status: 400 })
    }

    const journalPayload = {
      ManualJournals: [{
        Narration: `${runLabel} ${periodLabel} (paid ${imp.pay_date})`,
        Date: imp.pay_date,
        Status: 'POSTED',
        JournalLines: journalLines,
      }],
    }

    const token = await getXeroToken()
    const tenantId = Deno.env.get('XERO_TENANT_ID')!
    const xeroHeaders = { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json' }

    const [bc170, bc171] = await Promise.all([
      getAccountAvailableBalance(xeroHeaders, ACCT_DIRECT_WAGES),
      getAccountAvailableBalance(xeroHeaders, ACCT_DIRECT_PAYROLL_TAXES),
    ])
    const avail170 = bc170.available ?? 0
    const avail171 = bc171.available ?? 0
    const short170 = bc170.ok ? money(creditFrom170 - avail170) : null
    const short171 = bc171.ok ? money(creditFrom171 - avail171) : null
    const over170 = bc170.ok ? short170! > BALANCE_TOLERANCE : creditFrom170 > 0
    const over171 = bc171.ok ? short171! > BALANCE_TOLERANCE : creditFrom171 > 0
    const anyBlocked = over170 || over171
    const anyCheckFailed = (creditFrom170 > 0 && !bc170.ok) || (creditFrom171 > 0 && !bc171.ok)

    const balance_check = {
      direct_wages: { currently_available: bc170.ok ? avail170 : null, amount_this_posting_would_credit: creditFrom170, would_overdraw: over170, shortfall: over170 && short170 !== null ? short170 : null, error: bc170.error },
      direct_payroll_taxes: { currently_available: bc171.ok ? avail171 : null, amount_this_posting_would_credit: creditFrom171, would_overdraw: over171, shortfall: over171 && short171 !== null ? short171 : null, error: bc171.error },
    }

    if (!confirm) {
      let note: string
      if (anyCheckFailed) note = `Could not verify real Xero balance before posting (${bc170.error || bc171.error}) -- posting is blocked until this check succeeds.`
      else if (over170 && over171) note = `Blocked: this would take BOTH "170 Direct Wages" (short $${short170!.toFixed(2)}) and "171 Direct Payroll Taxes" (short $${short171!.toFixed(2)}) negative.`
      else if (over170) note = `Blocked: this would credit $${creditFrom170.toFixed(2)} out of "170 Direct Wages" but only $${avail170.toFixed(2)} is there (short $${short170!.toFixed(2)}). Usually this period's Square draft or IRS deposit hasn't hit the bank feed yet.`
      else if (over171) note = `Blocked: this would credit $${creditFrom171.toFixed(2)} out of "171 Direct Payroll Taxes" but only $${avail171.toFixed(2)} is there (short $${short171!.toFixed(2)}). Usually the EDD remittance hasn't cleared yet.`
      else note = 'Dry run only -- nothing has been sent to Xero. This fits within the real cash in both 170 and 171, and the journal balances to zero.'
      return new Response(JSON.stringify({
        dry_run: true,
        import: imp,
        totals: { wages: tWage, tips: tTips, employer_tax: tErTax, employee_ca_tax: tEeCa, employee_federal_tax: tEeFed, employee_health: tEeHealth, employee_401k: tEe401k, insurance_reimbursement: tInsReimb, net_pay: tNetPay },
        department_totals: Object.entries(byDept).map(([key, t]) => ({ department_key: key, wage: money(t.wage), tips: money(t.tips), erTax: money(t.erTax) })),
        withholding_note: 'Employee tax withholding is shown for reference only. It is already inside gross wages, so it is never debited to the department tax accounts -- it only determines which account the credit comes from.',
        proposed_journal: journalPayload.ManualJournals[0],
        journal_balances_to_zero: true,
        balance_check,
        note,
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    if (anyCheckFailed) return new Response(JSON.stringify({ error: `Could not verify Xero's real account balance before posting (${bc170.error || bc171.error}). Refusing to post blind.` }), { status: 502 })
    if (anyBlocked) {
      const parts: string[] = []
      if (over170) parts.push(`170 Direct Wages short $${short170!.toFixed(2)}`)
      if (over171) parts.push(`171 Direct Payroll Taxes short $${short171!.toFixed(2)}`)
      return new Response(JSON.stringify({ error: `Blocked: posting would take an account negative (${parts.join('; ')}). Usually this period's bank drafts or tax remittances haven't cleared yet.` }), { status: 409 })
    }

    const { data: freshImp } = await supa.from('payroll_imports').select('status, xero_manual_journal_id').eq('id', import_id).single()
    if (freshImp?.status !== 'reviewed') {
      return new Response(JSON.stringify({ error: `This payroll period's status changed to "${freshImp?.status}" since you opened this review -- refresh and try again.` }), { status: 409 })
    }
    // Re-check the id here too, not just at the top: this is the last read before
    // the write, and a guard that only sits on the earlier branch is a guard with
    // a race in front of it.
    if (freshImp?.xero_manual_journal_id) {
      return new Response(JSON.stringify({
        error: `This payroll period picked up Xero Manual Journal ${freshImp.xero_manual_journal_id} since you opened this review -- it may already have been posted by someone else. Nothing was posted. Refresh and check Xero.`,
        xero_manual_journal_id: freshImp.xero_manual_journal_id,
      }), { status: 409 })
    }

    const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', { method: 'POST', headers: xeroHeaders, body: JSON.stringify(journalPayload) })
    const postJson = await postRes.json().catch(() => null)
    if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: postRes.status, details: postJson }), { status: 502 })
    }
    const journal = postJson.ManualJournals?.[0]

    const { error: updateErr } = await supa.from('payroll_imports').update({
      status: 'posted',
      xero_manual_journal_id: journal?.ManualJournalID ?? null,
      xero_posted_at: new Date().toISOString(),
      xero_posted_by: posted_by ?? null,
    }).eq('id', import_id)

    // ── SESSION 241: XERO IS AHEAD OF US -- SAY SO, LOUDLY ──────────────────
    // This used to return ok:true and tuck the failure into
    // `payroll_imports_update_error`, a field the UI never reads. So the journal
    // landed in Xero, the row stayed 'reviewed', the operator saw success, and
    // the next click posted a SECOND journal for the same period. Live example
    // found by the session-240 audit: import 08ea6dc8, pay date 2026-08-21,
    // ~$20.5k.
    //
    // Same answer as loan-xero-post's xeroAheadOfUs(): a write that half
    // succeeded is a 500 that names both halves. Never a success.
    if (updateErr) {
      return new Response(JSON.stringify({
        error: `The payroll journal WAS posted to Xero (${journal?.ManualJournalID ?? 'id unknown'}), but our own record could not be updated: ${updateErr.message}. Xero is now ahead of our records. Do NOT retry -- posting again would duplicate the journal. Set this period's status to 'posted' and record the journal id, or void the journal in Xero.`,
        xero_write_succeeded: true,
        xero_manual_journal_id: journal?.ManualJournalID ?? null,
        db_error: updateErr.message,
      }, null, 2), { status: 500, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      ok: true,
      manual_journal: { id: journal?.ManualJournalID, lines: journal?.JournalLines },
      direct_wages_balance_before_posting: avail170,
      direct_payroll_taxes_balance_before_posting: avail171,
    }, null, 2), { headers: { 'Content-Type': 'application/json' } })
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
