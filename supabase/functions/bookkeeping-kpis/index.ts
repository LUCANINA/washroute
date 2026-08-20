import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'

// ────────────────────────────────────────────────────────────────────────
// Bookkeeping → Overview KPIs (session 223, 2026-08-19)
//
// Pulls the real financial KPIs shown on the Bookkeeping Overview page from
// Xero's report endpoints and stores one snapshot row in
// bookkeeping_kpi_snapshots. The page reads the latest snapshot instantly —
// it NEVER calls Xero on page load (same design as payroll-check-attention:
// a scheduled pull plus an on-demand refresh button).
//
// Design rules inherited from the rest of the module:
//  1. READ-ONLY against Xero. This function never writes to Xero, ever.
//  2. DETERMINISTIC — arithmetic over Xero's own report rows, no LLM.
//  3. Total debt is deliberately NOT computed here. The admin dashboard
//     computes it client-side from the same loan data the Debt Schedule uses
//     (_loanOutstandingBalance), so the Overview tile and the Debt Schedule
//     can never disagree — the "one function per number" invariant.
//  4. Xero fails silently; parse defensively. If a report row we expect is
//     missing, fail LOUDLY with a clear error instead of storing zeros —
//     a zero cash balance that's actually a parse failure is worse than no
//     number at all.
//
// Calls made per run (3 total, well inside rate limits at 4 runs/day):
//   GET /Reports/ProfitAndLoss   (current MTD + 11 prior full months, 1 call)
//   GET /Reports/ProfitAndLoss   (prior month, same day-span, for a fair
//                                 MTD-vs-MTD revenue delta)
//   GET /Reports/BalanceSheet    (bank totals at current date + 8 prior
//                                 month-ends)
// ────────────────────────────────────────────────────────────────────────

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Pacific business date. Never toISOString() — after 5pm PT that rolls to tomorrow.
const todayPacific = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })

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

// ── date helpers (all on YYYY-MM-DD strings, no Date-object timezone traps) ──
const firstOfMonth = (iso: string) => iso.slice(0, 8) + '01'
const monthKey = (iso: string) => iso.slice(0, 7)
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = (y * 12 + (m - 1)) + n
  const ny = Math.floor(total / 12), nm = (total % 12) + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`
}

// ── Xero report parsing ──────────────────────────────────────────────────
// Xero reports are a tree: Reports[0].Rows[] where a row is a Header (period
// labels), a Section (with nested Rows), or a Row/SummaryRow (Cells[0] =
// label, Cells[1..] = one value per period column, newest first).
type XeroRow = { RowType: string; Title?: string; Rows?: XeroRow[]; Cells?: { Value?: string }[] }

function flattenRows(rows: XeroRow[] | undefined, out: XeroRow[] = []): XeroRow[] {
  for (const r of rows || []) {
    if (r.Rows) flattenRows(r.Rows, out)
    if (r.Cells) out.push(r)
  }
  return out
}

// Returns the numeric period values (newest first) for the first row whose
// label matches, or null if no such row exists in the report.
function reportRowValues(report: any, labelRe: RegExp): number[] | null {
  const rows = flattenRows(report?.Rows)
  const row = rows.find(r => labelRe.test(String(r.Cells?.[0]?.Value || '').trim()))
  if (!row) return null
  return (row.Cells || []).slice(1).map(c => {
    const n = Number(String(c.Value ?? '').replace(/,/g, ''))
    return Number.isFinite(n) ? n : 0
  })
}

async function xeroReport(headers: Record<string, string>, path: string): Promise<any> {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, { headers })
  if (!res.ok) throw new Error(`Xero ${path.split('?')[0]} failed: ${res.status} ${await res.text()}`)
  const body = await res.json()
  const report = body?.Reports?.[0]
  if (!report) throw new Error(`Xero ${path.split('?')[0]} returned no report`)
  return report
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    const body = await req.json().catch(() => ({}))
    const isCron = body?.source === 'pg_cron'

    // Same gate as reconciliation-run: a signed-in admin/manager/cpa, or the
    // scheduled job. (The cron carries the anon key; 'source' just routes it
    // to the throttle below — this endpoint is read-only against Xero and
    // writes nothing but its own snapshot table, so the blast radius of an
    // unauthorized call is one extra snapshot row.)
    if (!isCron) {
      const role = await callerRole(req)
      if (!role || !['admin', 'manager', 'cpa'].includes(role)) {
        return json({ ok: false, error: 'Not authorized' }, 403)
      }
    }

    const db = admin()

    // Throttle: skip if we already have a snapshot newer than 5 minutes,
    // unless a human explicitly asked for a refresh.
    const force = body?.force === true
    if (!force) {
      const { data: latest } = await db.from('bookkeeping_kpi_snapshots')
        .select('id, captured_at').is('error', null)
        .order('captured_at', { ascending: false }).limit(1)
      if (latest?.[0] && Date.now() - new Date(latest[0].captured_at).getTime() < 5 * 60 * 1000) {
        return json({ ok: true, skipped: 'recent snapshot exists', captured_at: latest[0].captured_at })
      }
    }

    const { headers } = await getXeroAuth()
    const today = todayPacific()
    const monthStart = firstOfMonth(today)
    const priorMonthStart = firstOfMonth(addMonths(monthStart, -1))
    // last day of the prior month = day before the 1st of this month
    const [py, pm] = monthStart.split('-').map(Number)
    const lastDayPrior = new Date(Date.UTC(py, pm - 1, 0)).getUTCDate()
    const priorMonthLast = `${priorMonthStart.slice(0, 8)}${String(lastDayPrior).padStart(2, '0')}`
    const priorSameDay = addMonths(today, -1)

    // ⚠️ Xero comparison-column trap (verified live 2026-08-19): with
    // periods+timeframe, each comparison column mirrors the REQUESTED DAY-SPAN
    // in the earlier month — ask for Aug 1–19 and "July" comes back as Jul
    // 1–19, not full July. So the monthly series is anchored on the last FULL
    // month, and the current partial month is fetched separately.
    // 1) P&L monthly series: 11 full months ending with last month.
    const pl = await xeroReport(headers,
      `Reports/ProfitAndLoss?fromDate=${priorMonthStart}&toDate=${priorMonthLast}&periods=10&timeframe=MONTH&standardLayout=true`)
    // 2) P&L: this month to date (tile value).
    const plMtd = await xeroReport(headers,
      `Reports/ProfitAndLoss?fromDate=${monthStart}&toDate=${today}&standardLayout=true`)
    // 3) P&L: prior month over the SAME day-span, so the revenue delta is
    //    MTD-vs-MTD rather than partial-month-vs-full-month (which always lies).
    const plPrior = await xeroReport(headers,
      `Reports/ProfitAndLoss?fromDate=${priorMonthStart}&toDate=${priorSameDay}&standardLayout=true`)
    // 4) Balance Sheet: bank totals today + the same day-of-month in 8 prior
    //    months (the mirror behavior gives 19th-to-19th deltas — a clean
    //    month-over-month cadence, just not month-ends; labelled honestly).
    const bs = await xeroReport(headers,
      `Reports/BalanceSheet?date=${today}&periods=8&timeframe=MONTH&standardLayout=true`)

    // Parse — fail loudly if a row we depend on is missing (rule 4).
    const income = reportRowValues(pl, /^total (income|revenue)$/i)          // full months, newest first
    const netProfit = reportRowValues(pl, /^net (profit|income)$/i)
    if (!income || !netProfit) throw new Error('P&L parse failed: Total Income / Net Profit row not found')
    const incomeMtd = reportRowValues(plMtd, /^total (income|revenue)$/i)
    const netProfitMtd = reportRowValues(plMtd, /^net (profit|income)$/i)
    if (!incomeMtd || !netProfitMtd) throw new Error('P&L MTD parse failed: Total Income / Net Profit row not found')
    const incomePrior = reportRowValues(plPrior, /^total (income|revenue)$/i)
    // Family Laundry's org uses the US-GAAP layout: the bank section is titled
    // "Cash and Cash Equivalents" (verified live 2026-08-19), not "Bank".
    let bank = reportRowValues(bs, /^total (bank|cash and cash equivalents)$/i)
    if (!bank) {
      // Fallback: the SummaryRow of the bank/cash section, whatever its label.
      const bankSection = (bs?.Rows || []).find((r: XeroRow) =>
        r.RowType === 'Section' && /(bank|cash and cash equivalents)/i.test(String(r.Title || '')))
      const sum = (bankSection?.Rows || []).find((r: XeroRow) => r.RowType === 'SummaryRow')
      if (sum?.Cells) {
        bank = sum.Cells.slice(1).map(c => {
          const n = Number(String(c.Value ?? '').replace(/,/g, ''))
          return Number.isFinite(n) ? n : 0
        })
      }
    }
    if (!bank) {
      // Diagnostic: list what the report actually contains, so a layout change
      // is a 2-minute fix instead of a mystery.
      const labels = flattenRows(bs?.Rows).map(r => String(r.Cells?.[0]?.Value || '').trim()).filter(Boolean).slice(0, 40)
      const sections = (bs?.Rows || []).filter((r: XeroRow) => r.RowType === 'Section').map((r: XeroRow) => r.Title).filter(Boolean)
      throw new Error(`Balance Sheet parse failed: Total Bank row not found. Sections: [${sections.join(' | ')}]. Rows: [${labels.join(' | ')}]`)
    }

    // Series columns are newest-first FULL months, starting at last month.
    const monthLabels: string[] = []
    for (let i = 0; i < income.length; i++) monthLabels.push(monthKey(addMonths(priorMonthStart, -i)))

    // Cash runway: average net cash change over the last 3 month-over-month
    // deltas (same day-of-month cadence, e.g. 19th-to-19th). Positive or zero
    // average → the business isn't burning cash → runway is null (the UI
    // shows "cash-flow positive" instead of a fake number).
    let avgFlow3mo: number | null = null
    if (bank.length >= 4) {
      const deltas = [0, 1, 2].map(i => bank[i] - bank[i + 1])
      avgFlow3mo = deltas.reduce((a, b) => a + b, 0) / deltas.length
    }
    const cashNow = bank[0]
    const runwayMonths = (avgFlow3mo != null && avgFlow3mo < 0) ? cashNow / -avgFlow3mo : null

    const payload = {
      as_of: new Date().toISOString(),
      report_date: today,
      months: monthLabels,                       // newest first, FULL months, aligned with revenue/net_profit series
      cash: {
        current: cashNow,
        series: bank,                            // today + same day-of-month in prior months, newest first
        month_ago: bank[1] ?? null,              // same day last month (NOT month-end)
      },
      revenue: {
        mtd: incomeMtd[0],
        prior_mtd: incomePrior ? incomePrior[0] : null,   // same day-span last month
        series: income,                          // full months, newest first
      },
      net_profit: {
        mtd: netProfitMtd[0],
        last_month: netProfit[0] ?? null,        // last FULL month
        prior_month: netProfit[1] ?? null,
        series: netProfit,
      },
      avg_net_cash_flow_3mo: avgFlow3mo,
      runway_months: runwayMonths,
    }

    const { error: insErr } = await db.from('bookkeeping_kpi_snapshots')
      .insert({ source: isCron ? 'scheduled' : 'manual', payload })
    if (insErr) throw new Error('Snapshot insert failed: ' + insErr.message)

    // Prune history the page will never read.
    await db.from('bookkeeping_kpi_snapshots')
      .delete().lt('captured_at', new Date(Date.now() - 90 * 86400000).toISOString())

    return json({ ok: true, payload })
  } catch (e) {
    // Record failed scheduled runs so a stale "as of" stamp is diagnosable,
    // then return the error. Failed rows carry error != null and are never
    // read as data by the page.
    try {
      await admin().from('bookkeeping_kpi_snapshots')
        .insert({ source: 'scheduled', payload: {}, error: String((e as Error)?.message || e) })
    } catch (_) { /* best effort */ }
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500)
  }
})
