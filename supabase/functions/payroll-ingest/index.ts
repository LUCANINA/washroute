import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

// payroll-ingest v20 (Aug 17, 2026)
//
// Parses a Square Payroll Summary CSV, matches employees to departments, and
// writes payroll_imports + payroll_import_employee_lines. Never touches Xero.
//
// v20: fixes a DATA LOSS bug in v19's merge, discovered live -- Maria
// Castellanos' adjustment line was deleted and never came back. v19 deleted
// ALL existing lines on an adjustment import up front, then tried to
// reinsert (old lines it was keeping + the freshly parsed new ones) in one
// INSERT. That insert failed with "null value in column created_at violates
// not-null constraint" -- spreading a raw DB row (`...rest` after
// destructuring off id/import_id/matched_employee_id/department_key) back
// into an insert turned out to be fragile. Because the delete had already
// committed, the failure left the import with ZERO lines; a same-employee
// retry (Tulicia only) then "succeeded", silently discarding Maria's data.
// It was recovered by hand from her original CSV, matched against the
// governing gross/tax/net-pay identity to confirm the values were exactly
// right, and re-inserted directly -- but by the time this was caught, David
// had already posted that Xero journal, which is now short Maria's $144.00
// wages / $131.11 net pay. That needs manual resolution (see session log).
//
// The fix: NEVER delete a line unless its specific replacement is about to
// be written. An adjustment merge now only deletes the exact rows for
// employees being overwritten (via replace:true) -- one DELETE ... WHERE id
// IN (...) scoped to just the overlapping employee(s) -- and only inserts
// the freshly parsed rows from THIS CSV. Every other employee already on
// the adjustment is never touched: no delete, no reinsert, no spread of raw
// DB rows, so there is no window in which their data can vanish. If the
// insert of the new/replacement rows fails, the worst case is those
// specific rows are simply missing (caller sees the error and can retry) --
// every other employee's data was never at risk to begin with.
//
// v19: adjustment imports now MERGE by employee instead of the existing-
// import check treating a second CSV for the same pay date as a full
// collision. David's real first test uploaded Maria Castellanos, then
// Tulicia Lyle -- two DIFFERENT employees, but Square exported them as two
// separate single-employee CSVs sharing the exact same real Pay Date
// (2026-08-11), so they land on the same (period, type, pay_date) adjustment
// slot. The old logic required replace:true for the second upload, which
// would have deleted Maria's line entirely to make room for Tulicia's --
// wrong, since they're both legitimately part of the same small off-cycle
// correction batch and belong in the SAME journal (see v17's "own small
// separate journal" design). Now: an employee not already on the existing
// adjustment import is simply added (no replace needed); an employee who IS
// already on it only gets overwritten with replace:true, and only that
// person's line -- everyone else stays untouched. An already-POSTED
// adjustment import blocks outright (409, points at Claude for manual
// void+repost) rather than silently letting a merge happen underneath an
// already-posted Xero journal. regular and reimbursement_only import types
// are completely unaffected -- still exactly one row per period, full
// replace-only, same as always.
//
// v18: PTO Earnings, Sick Leave Earnings, ER/EE Health Insurance (Medical),
// and ER/EE Roth/Traditional 401K are now OPTIONAL columns, same treatment
// as "Insurance reimbursement (max $300)" already got in v14 -- default to 0
// per row when the column is entirely absent from the CSV, instead of hard-
// failing the whole upload. Caught by the very first real off-cycle
// adjustment attempt (David, session 219): a 1-employee correction CSV for
// an employee with no benefit elections has NO health/401k columns at all
// (Square omits them from the export when nothing in the run uses them),
// so the old "every one of these columns must exist" check rejected a
// perfectly valid CSV with "CSV is missing expected column(s): pto, sick,
// erHealth, erRoth, erTrad, eeHealth, eeRoth, eeTrad" -- even though the
// underlying num() helper already treats a missing column index (-1) as 0,
// so nothing downstream needed to change: the compute paths, the identity
// reconciliation check, and payroll-xero-post's posting logic are all
// unaffected. Verified by hand against both real adjustment CSVs (Maria
// Castellanos -- Sick Leave Earnings present, everything else absent;
// Tulicia Lyle -- all eight absent): both reconcile to the penny once these
// columns are allowed to default to 0. This was a pre-existing parser gap,
// not something introduced by the adjustment feature -- it would have hit
// ANY small regular-run CSV for employees with no benefit elections, too.
//
// v17: added a third import_type, 'adjustment', for off-cycle correction runs
// -- a small Square payroll (often just 1-2 employees) covering the SAME
// calendar pay period as an already-posted regular run, but paid on a LATER
// real date (e.g. the 07/27-08/02 period's regular run paid 08/07, then a
// late-added employee gets a separate Square run for the same nominal period
// paid 08/11). David tried uploading two of these and hit the existing-import
// guard, since a regular import for that period already existed and was
// already posted -- correctly blocked, since forcing it through with
// replace:true would have deleted all 31 employees' lines from the posted
// run and replaced them with just the 1-2 adjustment rows. This is an
// EXPLICIT caller choice, never auto-detected from the CSV shape (an
// adjustment CSV looks byte-for-byte identical to a small regular run --
// nothing in the file itself says "this is a correction"): the caller must
// pass `import_type: 'adjustment'` to use this path. Migration
// payroll_imports_add_adjustment_type re-keyed the DB's uniqueness so
// adjustment rows are deduped by (period, type, pay_date) instead of just
// (period, type) -- multiple adjustments can stack for the same nominal
// period as long as each has its own real pay date, while regular and
// reimbursement_only keep their exact original one-row-per-period behavior.
// Posts as its own small, clearly-dated Xero journal via payroll-xero-post,
// same pattern as the reimbursement_only run -- never merged into the
// original period's journal, and never requires voiding/reposting it.
//
// v16: v15 shipped without noticing payroll_imports had a hard DB-level
// UNIQUE(pay_period_start, pay_period_end) constraint. The very first real
// reimbursement-only upload (Aug 8, 2026) collided with it, because Square's
// two runs for 07/27-08/02 share the exact same calendar period -- uploading
// the regular biweekly CSV first (which succeeded) then blocked the
// reimbursement-only CSV with "already exists". Fixed at the DB layer
// (migration payroll_imports_add_import_type: new import_type column,
// re-keyed unique constraint on (pay_period_start, pay_period_end,
// import_type)) and here: the existing-import lookup and insert now both
// key on import_type, so a regular run and a reimbursement-only run for the
// same calendar dates create two independent payroll_imports rows, exactly
// as designed -- two separate Xero journals, never merged.
//
// v15: handles Square's monthly insurance-reimbursement-only payroll run.
// David runs it as its own separate Square payroll (once a month, dates that
// don't necessarily line up with a regular biweekly period) and its CSV
// export has NO individual employee rows at all -- confirmed against the
// actual Aug 2026 export, which goes straight from the header row to a
// single "Total" row carrying the whole reimbursement as one number. This
// used to hard-fail with "No employee rows found between the header row and
// the Total row." Now: if the row right after the header is already "Total",
// this is treated as a totals-only run. We require a Net Pay column and an
// Insurance reimbursement column, and require Net Pay to equal the
// reimbursement total (within a cent) -- if they don't match, there's
// unexplained money on this CSV this parser doesn't understand, and it
// refuses rather than guess. One synthetic line is written with
// line_type='reimbursement_only', department_key/matched_employee_id left
// NULL on purpose (it isn't wages and isn't tied to any employee -- the Xero
// journal debits it to account 675 as a single flat line regardless of
// department). This creates its OWN payroll_imports row using the CSV's own
// pay_period_start/end/pay_date -- confirmed with David it should post as
// its own small separate Xero journal, not merged into a nearby regular
// period, since the dates aren't guaranteed to align.
//
// payroll-xero-post and payroll-check-attention were updated in the same
// pass to exclude line_type='reimbursement_only' from their "unmatched
// employee, needs a department" checks -- a reimbursement-only line is
// supposed to have no department, that's not the same as an unresolved name.
//
// v13 captures EVERY component of the pay stub, because payroll-xero-post now
// builds the same journal shape the CPA has always used by hand, and that
// requires all of them. Confirmed against the CPA's own monthly journals in
// Xero (Apr/May/Jun 2026), which debit department wages + department tax and
// credit 170 (bank cash), 358 (employee 401k) and 675 (employee health), with
// the insurance-reimbursement stipend debited back to 675.
//
// The governing identity, verified to the penny on all 5 July 2026 periods:
//     gross - EE federal - EE CA - EE health - EE 401k + insurance reimb = net pay
// Everything the company actually paid out is on the left; nothing may be
// counted twice. In particular employee tax withholding is ALREADY inside
// gross pay -- see the payroll-xero-post header for the incident where
// treating it as an extra cost double-counted $4,465.21.
//
// wage_amount deliberately EXCLUDES Paycheck Tips so the two can be reported
// separately, but tips ARE a department wage debit (David, Aug 7) -- they are
// paid out monthly, land in Delivery and Laundry only, and go to those
// departments' Wages & Labor accounts (173 / 172).
//
// v14: "Insurance reimbursement (max $300)" made optional on the regular
// (per-employee) path -- Square dropped it from the main payroll export
// entirely (not renamed). Defaults to 0 per row when absent. See v15 above
// for where that money actually comes from now.
//
// Body: { csv_base64, csv_filename?, uploaded_by?, replace?, import_type? }
// import_type is optional and only meaningful as 'adjustment' -- omit it (or
// pass 'regular') for a normal upload; the totals-only shape is still always
// auto-detected as 'reimbursement_only' regardless of this param.

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

function normalizeName(s: string) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function splitCsvLine(line: string) { return line.split(',') }

function num(v: string | undefined) {
  const n = Number((v || '0').trim())
  return Number.isFinite(n) ? n : 0
}
const r2 = (n: number) => Math.round(n * 100) / 100

function parseMetaDate(lines: string[], label: string): string | null {
  const line = lines.find(l => l.trim().toLowerCase().startsWith(label.toLowerCase() + ','))
  if (!line) return null
  const raw = line.split(',')[1]?.trim()
  if (!raw) return null
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${m[1]}-${m[2]}`
}

async function handleRequest(req: Request): Promise<Response> {
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405 })
    const body = await req.json().catch(() => ({}))
    const { csv_base64, csv_filename, uploaded_by, replace, import_type: requestedImportType } = body
    if (!csv_base64) return new Response(JSON.stringify({ error: 'csv_base64 is required' }), { status: 400 })
    if (requestedImportType !== undefined && requestedImportType !== 'adjustment' && requestedImportType !== 'regular') {
      return new Response(JSON.stringify({ error: `Unrecognized import_type "${requestedImportType}" -- omit this field for a normal upload, or pass "adjustment" for an off-cycle correction run.` }), { status: 400 })
    }

    const role = await callerRole(req)
    if (!role || !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Uploading payroll requires an admin or manager account.' }), { status: 403 })
    }

    const text = new TextDecoder().decode(Uint8Array.from(atob(csv_base64), c => c.charCodeAt(0)))
    const lines = text.split(/\r?\n/)

    const payPeriodStart = parseMetaDate(lines, 'Pay Period Start')
    const payPeriodEnd = parseMetaDate(lines, 'Pay Period End')
    const payDate = parseMetaDate(lines, 'Pay Date')
    if (!payPeriodStart || !payPeriodEnd || !payDate) {
      return new Response(JSON.stringify({ error: 'Could not find Pay Period Start/End/Pay Date in the CSV header rows. Is this a Square Payroll Summary export?' }), { status: 400 })
    }

    const headerIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('first name,last name'))
    if (headerIdx === -1) {
      return new Response(JSON.stringify({ error: 'Could not find the "First Name,Last Name,..." header row.' }), { status: 400 })
    }
    const headerCols = splitCsvLine(lines[headerIdx]).map(c => c.trim())
    const col = (name: string) => headerCols.indexOf(name)

    // Does this export have any individual employee rows at all, or does it
    // go straight from the header to a "Total" row? Square's monthly
    // insurance-reimbursement-only run does the latter -- no per-employee
    // breakdown, just one aggregate. Detect this BEFORE requiring the full
    // wage-column set below, since a totals-only export is missing most of
    // those columns entirely (it's a much simpler pay stub shape).
    let firstDataLineIdx = -1
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i] && lines[i].trim()) { firstDataLineIdx = i; break }
    }
    const isTotalsOnly = firstDataLineIdx !== -1 &&
      (splitCsvLine(lines[firstDataLineIdx])[0] || '').trim().toLowerCase() === 'total'

    if (requestedImportType === 'adjustment' && isTotalsOnly) {
      return new Response(JSON.stringify({ error: 'This CSV has no individual employee rows (it looks like the monthly insurance-reimbursement-only export) -- import_type:"adjustment" only applies to a per-employee correction run. Upload it as a normal reimbursement-only import instead (omit import_type).' }), { status: 400 })
    }

    // A pay period can now have up to THREE distinct kinds of payroll_imports
    // row for the same calendar dates: the regular biweekly run, the monthly
    // reimbursement-only run, and any number of off-cycle 'adjustment' runs.
    // 'adjustment' is never auto-detected -- it's purely the caller's
    // explicit choice (see v17 note above), since an adjustment CSV is
    // structurally identical to a small regular run.
    const importType: 'regular' | 'reimbursement_only' | 'adjustment' =
      isTotalsOnly ? 'reimbursement_only' : (requestedImportType === 'adjustment' ? 'adjustment' : 'regular')

    let employeeLines: any[] = []

    if (isTotalsOnly) {
      const netPayCol = col('Net Pay')
      const insReimbCol = col('Insurance reimbursement (max $300)')
      if (netPayCol === -1) {
        return new Response(JSON.stringify({ error: 'This CSV has no individual employee rows and no "Net Pay" column on its Total row -- not a recognized Square export shape. Send this to Claude to teach the parser about it.' }), { status: 400 })
      }
      if (insReimbCol === -1) {
        return new Response(JSON.stringify({ error: 'This CSV has no individual employee rows and no "Insurance reimbursement" column, so this parser doesn\'t know what kind of payroll run it is. Send this to Claude to teach the parser about it.' }), { status: 400 })
      }
      const totalCells = splitCsvLine(lines[firstDataLineIdx])
      const totalNetPay = r2(num(totalCells[netPayCol]))
      const totalInsReimb = r2(num(totalCells[insReimbCol]))
      if (totalNetPay <= 0) {
        return new Response(JSON.stringify({ error: 'Nothing to import -- this period totals $0.' }), { status: 400 })
      }
      if (Math.abs(totalNetPay - totalInsReimb) > 0.01) {
        return new Response(JSON.stringify({
          error: `This looks like a totals-only Square export (no individual employee rows), but its Net Pay ($${totalNetPay.toFixed(2)}) doesn't match its Insurance reimbursement total ($${totalInsReimb.toFixed(2)}) -- there's $${Math.abs(totalNetPay - totalInsReimb).toFixed(2)} of unexplained money this parser doesn't know how to categorize. Send this to Claude to teach the parser about it.`,
          net_pay: totalNetPay, insurance_reimbursement: totalInsReimb,
        }), { status: 400 })
      }
      employeeLines = [{
        raw_full_name: 'Insurance Reimbursement (no per-employee detail on this Square export)',
        full_name_normalized: normalizeName('insurance reimbursement (no per-employee detail on this square export)'),
        wage_amount: 0, er_tax_amount: 0, er_health_amount: 0, er_401k_amount: 0,
        paycheck_tips_amount: 0, gross_pay: 0,
        ee_ca_state_income_amount: 0, ee_ca_state_disability_amount: 0,
        ee_fed_income_amount: 0, ee_social_security_amount: 0, ee_medicare_amount: 0,
        ee_health_amount: 0, ee_401k_amount: 0,
        insurance_reimbursement_amount: totalInsReimb,
        net_pay_amount: totalNetPay,
        line_type: 'reimbursement_only',
      }]
    } else {
      // REQUIRED columns -- a CSV missing any of these isn't a shape this
      // parser understands at all, so it hard-fails.
      const requiredCols: Record<string, string> = {
        first: 'First Name', last: 'Last Name',
        reg: 'Reg Earnings', ot: 'OT Earnings', dt: 'DT Earnings',
        additional: 'Additional Pay', tips: 'Paycheck Tips', commissions: 'Commissions',
        gross: 'Gross Pay',
        erTaxes: 'ER Taxes',
        eeCaIncome: 'EE CA State Income', eeCaDisability: 'EE CA State Disability',
        eeFedIncome: 'EE Fed. Income', eeSocialSecurity: 'EE Soc. Security', eeMedicare: 'EE Medicare',
        netPay: 'Net Pay',
      }
      // OPTIONAL columns -- absent whenever nothing in this specific payroll
      // run uses them (e.g. no employee on this CSV has PTO, sick leave, or
      // a benefit election). Square omits the column entirely rather than
      // exporting it empty. num(cells[-1]) already evaluates to 0, so simply
      // not requiring these to exist is enough -- every downstream
      // computation (wage_amount, the identity reconciliation check,
      // payroll-xero-post's journal) already treats a missing value as $0
      // correctly. v14 already did this for "Insurance reimbursement (max
      // $300)"; v18 (session 219) extends the same treatment to these eight,
      // after a real 1-employee adjustment CSV with none of them hard-failed
      // the whole upload for no reason -- see v18 note above.
      const optionalCols: Record<string, string> = {
        pto: 'PTO Earnings', sick: 'Sick Leave Earnings',
        erHealth: 'ER Health Insurance (Medical)',
        erRoth: 'ER Roth 401K', erTrad: 'ER Traditional 401K',
        eeHealth: 'EE Health Insurance (Medical)',
        eeRoth: 'EE Roth 401K', eeTrad: 'EE Traditional 401K',
      }
      const idx: Record<string, number> = {}
      for (const [k, name] of Object.entries(requiredCols)) idx[k] = col(name)
      for (const [k, name] of Object.entries(optionalCols)) idx[k] = col(name)

      const missing = Object.keys(requiredCols).filter(k => idx[k] === -1)
      if (missing.length) {
        return new Response(JSON.stringify({ error: `CSV is missing expected column(s): ${missing.join(', ')}. Square may have changed its export format -- this parser needs updating.` }), { status: 400 })
      }

      // Optional as of v14 -- Square removed this column from the main
      // per-employee export entirely. Not fatal if absent: default every row
      // to 0. (This money now arrives via the totals-only branch above.)
      const insReimbCol = col('Insurance reimbursement (max $300)')

      const identityMismatches: any[] = []
      for (let i = headerIdx + 1; i < lines.length; i++) {
        const raw = lines[i]
        if (!raw || !raw.trim()) break
        const cells = splitCsvLine(raw)
        const first = (cells[idx.first] || '').trim()
        const last = (cells[idx.last] || '').trim()
        if (!first && !last) break
        if (first.toLowerCase() === 'total') break

        const wage_amount = num(cells[idx.reg]) + num(cells[idx.ot]) + num(cells[idx.dt]) +
          num(cells[idx.additional]) + num(cells[idx.commissions]) + num(cells[idx.pto]) + num(cells[idx.sick])
        const paycheck_tips_amount = num(cells[idx.tips])
        const ee_fed_income_amount = num(cells[idx.eeFedIncome])
        const ee_social_security_amount = num(cells[idx.eeSocialSecurity])
        const ee_medicare_amount = num(cells[idx.eeMedicare])
        const ee_ca_state_income_amount = num(cells[idx.eeCaIncome])
        const ee_ca_state_disability_amount = num(cells[idx.eeCaDisability])
        const ee_health_amount = num(cells[idx.eeHealth])
        const ee_401k_amount = num(cells[idx.eeRoth]) + num(cells[idx.eeTrad])
        const insurance_reimbursement_amount = insReimbCol === -1 ? 0 : num(cells[insReimbCol])
        const net_pay_amount = num(cells[idx.netPay])
        const gross_pay = num(cells[idx.gross])

        // Guard the identity that the whole Xero posting depends on. If Square
        // ever adds a new deduction column we don't read, this catches it here
        // rather than silently stranding money in 170 later.
        const derivedNet = wage_amount + paycheck_tips_amount
          - ee_fed_income_amount - ee_social_security_amount - ee_medicare_amount
          - ee_ca_state_income_amount - ee_ca_state_disability_amount
          - ee_health_amount - ee_401k_amount + insurance_reimbursement_amount
        if (Math.abs(r2(derivedNet) - r2(net_pay_amount)) > 0.01) {
          identityMismatches.push({ employee: `${first} ${last}`.trim(), derived_net_pay: r2(derivedNet), square_net_pay: r2(net_pay_amount), difference: r2(derivedNet - net_pay_amount) })
        }

        const raw_full_name = `${first} ${last}`.trim()
        employeeLines.push({
          raw_full_name,
          full_name_normalized: normalizeName(raw_full_name),
          wage_amount: r2(wage_amount),
          er_tax_amount: r2(num(cells[idx.erTaxes])),
          er_health_amount: r2(num(cells[idx.erHealth])),
          er_401k_amount: r2(num(cells[idx.erRoth]) + num(cells[idx.erTrad])),
          paycheck_tips_amount: r2(paycheck_tips_amount),
          gross_pay: r2(gross_pay),
          ee_ca_state_income_amount: r2(ee_ca_state_income_amount),
          ee_ca_state_disability_amount: r2(ee_ca_state_disability_amount),
          ee_fed_income_amount: r2(ee_fed_income_amount),
          ee_social_security_amount: r2(ee_social_security_amount),
          ee_medicare_amount: r2(ee_medicare_amount),
          ee_health_amount: r2(ee_health_amount),
          ee_401k_amount: r2(ee_401k_amount),
          insurance_reimbursement_amount: r2(insurance_reimbursement_amount),
          net_pay_amount: r2(net_pay_amount),
          line_type: 'employee',
        })
      }

      if (!employeeLines.length) {
        return new Response(JSON.stringify({ error: 'No employee rows found between the header row and the Total row.' }), { status: 400 })
      }
      if (identityMismatches.length) {
        return new Response(JSON.stringify({
          error: `This CSV does not reconcile: for ${identityMismatches.length} employee(s), gross + tips minus every deduction we read does not equal Square's own Net Pay. That usually means Square added a pay or deduction column this parser doesn't know about. Import stopped so nothing wrong reaches Xero -- send this to Claude to update the parser.`,
          identity_mismatches: identityMismatches.slice(0, 20),
        }), { status: 400 })
      }
    }

    const supa = admin()

    // 'adjustment' imports are deduped by (period, type, pay_date) instead of
    // just (period, type) -- see migration payroll_imports_add_adjustment_type
    // -- so multiple off-cycle runs can stack for the same nominal period as
    // long as each has its own real pay date. regular/reimbursement_only keep
    // their exact original one-row-per-period lookup, unchanged.
    let existingQuery = supa.from('payroll_imports').select('*')
      .eq('pay_period_start', payPeriodStart).eq('pay_period_end', payPeriodEnd).eq('import_type', importType)
    if (importType === 'adjustment') existingQuery = existingQuery.eq('pay_date', payDate)
    const { data: existing } = await existingQuery.maybeSingle()

    // Adjustment imports MERGE by employee -- see the v20 header note for
    // why this matters and what broke before this shape (partial, per-row
    // deletes only, never a blanket delete-then-reinsert).
    let importId = existing?.id

    if (existing && importType === 'adjustment') {
      if (existing.status === 'posted') {
        return new Response(JSON.stringify({
          error: `This adjustment payroll (paid ${payDate}) has already been posted to Xero (journal ${existing.xero_manual_journal_id}). Adding another employee to an already-posted adjustment isn't automatic -- send this to Claude for help voiding and reposting it with the new employee included.`,
          existing_import: existing,
        }), { status: 409 })
      }

      const { data: oldLines } = await supa.from('payroll_import_employee_lines').select('id, raw_full_name, full_name_normalized').eq('import_id', existing.id)
      const newNames = new Set(employeeLines.map((l: any) => l.full_name_normalized))
      const overlapping = (oldLines || []).filter((l: any) => newNames.has(l.full_name_normalized))

      if (overlapping.length && !replace) {
        return new Response(JSON.stringify({
          error: `This adjustment payroll (paid ${payDate}) already has a line for ${overlapping.map((l: any) => l.raw_full_name).join(', ')}. Pass replace:true to re-parse and overwrite just ${overlapping.length === 1 ? "that employee's" : "those employees'"} line with this CSV -- everyone else already on this adjustment is kept as-is.`,
          existing_import: existing,
          overlapping_employees: overlapping.map((l: any) => l.raw_full_name),
        }), { status: 409 })
      }

      // v20: only delete the SPECIFIC row(s) being replaced -- every other
      // employee already on this adjustment is never touched (no delete, no
      // reinsert). See the v20 header note: the previous approach (delete
      // everything, then reinsert kept-old + new together) lost Maria
      // Castellanos' line for real when that reinsert failed. This can't
      // repeat that failure mode -- if the delete or the insert below fails,
      // only THIS upload's employee(s) are affected; nobody else's data was
      // ever removed.
      if (overlapping.length) {
        const { error: delErr } = await supa.from('payroll_import_employee_lines').delete().in('id', overlapping.map((l: any) => l.id))
        if (delErr) return new Response(JSON.stringify({ error: 'Failed to remove the employee line(s) being replaced', details: delErr.message }), { status: 500 })
      }

      const { error: updErr } = await supa.from('payroll_imports').update({
        source_file_path: csv_filename || null, status: 'parsed',
        uploaded_by: uploaded_by || null, uploaded_at: new Date().toISOString(),
        reviewed_by: null, reviewed_at: null,
      }).eq('id', existing.id)
      if (updErr) return new Response(JSON.stringify({ error: 'Failed to update existing import', details: updErr.message }), { status: 500 })

      // employeeLines is left exactly as freshly parsed from THIS CSV --
      // nothing from the old row set is merged back in, because nothing
      // from the old row set was ever removed in the first place.
      importId = existing.id
    } else if (existing && !replace) {
      const kindLabel = importType === 'reimbursement_only' ? ' reimbursement-only' : ''
      return new Response(JSON.stringify({
        error: `A${kindLabel} payroll import already exists for ${payPeriodStart} to ${payPeriodEnd} (status: ${existing.status}). Pass replace:true to re-parse and overwrite it.`,
        existing_import: existing,
      }), { status: 409 })
    } else if (existing) {
      // regular/reimbursement_only: unchanged full-replace behavior --
      // exactly one row per period, so a full replace has always been the
      // correct semantics here (unlike adjustment, which can have several
      // employees' lines coexisting).
      await supa.from('payroll_import_employee_lines').delete().eq('import_id', existing.id)
      const { error: updErr } = await supa.from('payroll_imports').update({
        pay_date: payDate, source_file_path: csv_filename || null, status: 'parsed',
        uploaded_by: uploaded_by || null, uploaded_at: new Date().toISOString(),
        reviewed_by: null, reviewed_at: null,
      }).eq('id', existing.id)
      if (updErr) return new Response(JSON.stringify({ error: 'Failed to update existing import', details: updErr.message }), { status: 500 })
    } else {
      const { data: inserted, error: insErr } = await supa.from('payroll_imports').insert({
        pay_period_start: payPeriodStart, pay_period_end: payPeriodEnd, pay_date: payDate,
        source_file_path: csv_filename || null, status: 'parsed', uploaded_by: uploaded_by || null,
        import_type: importType,
      }).select('id').single()
      if (insErr || !inserted) return new Response(JSON.stringify({ error: 'Failed to create import', details: insErr?.message }), { status: 500 })
      importId = inserted.id
    }

    const { data: employees } = await supa.from('payroll_employees').select('*').eq('active', true)
    const byName = new Map((employees || []).map(e => [e.full_name_normalized, e]))

    const linesToInsert = employeeLines.map(l => {
      // A reimbursement_only line's full_name_normalized deliberately never
      // matches a real employee, so match stays undefined and
      // matched_employee_id/department_key correctly stay null below.
      const match = byName.get(l.full_name_normalized)
      return { ...l, import_id: importId, matched_employee_id: match?.id || null, department_key: match?.department_key || null }
    })
    const { error: linesErr } = await supa.from('payroll_import_employee_lines').insert(linesToInsert)
    if (linesErr) return new Response(JSON.stringify({ error: 'Failed to insert employee lines', details: linesErr.message }), { status: 500 })

    const { data: departments } = await supa.from('payroll_departments').select('*').order('sort_order')
    const totals: Record<string, any> = {}
    for (const d of departments || []) totals[d.key] = { department_key: d.key, display_name: d.display_name, wage_account_code: d.wage_account_code, wage_account_name: d.wage_account_name, tax_account_code: d.tax_account_code, tax_account_name: d.tax_account_name, wage_amount: 0, tips_amount: 0, er_tax_amount: 0, employee_count: 0 }
    // Only real employee lines can be "unmatched" (needing a department
    // picked) -- a reimbursement_only line has no department by design, not
    // by mistake, so it's excluded here rather than showing up asking to be
    // resolved.
    const unmatched: any[] = []
    for (const l of linesToInsert) {
      if (l.line_type === 'reimbursement_only') continue
      if (!l.department_key) { unmatched.push(l); continue }
      const t = totals[l.department_key]
      if (!t) continue
      t.wage_amount += l.wage_amount
      t.tips_amount += l.paycheck_tips_amount
      t.er_tax_amount += l.er_tax_amount
      t.employee_count += 1
    }
    for (const k of Object.keys(totals)) {
      totals[k].wage_amount = r2(totals[k].wage_amount)
      totals[k].tips_amount = r2(totals[k].tips_amount)
      totals[k].er_tax_amount = r2(totals[k].er_tax_amount)
    }
    const sum = (f: (l: any) => number) => r2(linesToInsert.reduce((s, l) => s + f(l), 0))
    const reimbursementOnlyTotal = r2(linesToInsert.filter(l => l.line_type === 'reimbursement_only').reduce((s, l) => s + l.insurance_reimbursement_amount, 0))

    return new Response(JSON.stringify({
      ok: true,
      import_id: importId,
      import_type: importType,
      pay_period_start: payPeriodStart, pay_period_end: payPeriodEnd, pay_date: payDate,
      employee_count: linesToInsert.filter(l => l.line_type !== 'reimbursement_only').length,
      is_reimbursement_only_period: isTotalsOnly,
      reimbursement_only_total: reimbursementOnlyTotal || undefined,
      unmatched_employees: unmatched.map(u => ({ raw_full_name: u.raw_full_name, wage_amount: u.wage_amount, er_tax_amount: u.er_tax_amount })),
      department_totals: Object.values(totals),
      grand_total_wage: sum(l => l.wage_amount),
      grand_total_tips: sum(l => l.paycheck_tips_amount),
      grand_total_er_tax: sum(l => l.er_tax_amount),
      grand_total_ee_ca_tax: sum(l => l.ee_ca_state_income_amount + l.ee_ca_state_disability_amount),
      grand_total_ee_federal_tax: sum(l => l.ee_fed_income_amount + l.ee_social_security_amount + l.ee_medicare_amount),
      grand_total_ee_health: sum(l => l.ee_health_amount),
      grand_total_ee_401k: sum(l => l.ee_401k_amount),
      grand_total_insurance_reimbursement: sum(l => l.insurance_reimbursement_amount),
      grand_total_net_pay: sum(l => l.net_pay_amount),
    }, null, 2), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500 })
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
