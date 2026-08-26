import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { measureRate, measureRateFromSchedule, refreshScheduleRates, num } from "../_shared/derive-schedule.ts"

// loan-derive-schedule — v3 (session 239)
// v3: a LENDER-ISSUED AMORTIZATION SCHEDULE is now a valid source for measuring a
//     rate, alongside statements. Plus `refresh_rates`, so a scheduled rate change
//     lands on the day it takes effect instead of when somebody remembers.
// v2: the projection itself moved to _shared/derive-schedule.ts, because two other
//     callers need it (loan-record-principal-payment when a lump lands,
//     loan-ingest-statement when a new anchor arrives) and neither can HTTP-call this
//     function -- they have no user JWT. This file is now only the HTTP door.
// =============================================================================
// Lets a loan with NO lender-issued amortization schedule take part in pre-staging,
// by DERIVING one from the loan's own statement history.
//
// ── THE BLOCKER THIS REMOVES ─────────────────────────────────────────────────
// ensureUpcomingSplit picks the period to stage from future payment rows on a
// loan_amortization_schedules row. The four active Ford loans have none, so they
// could never stage -- not because anything about them is unsuitable, but because
// Ford does not send a schedule. Everything downstream (stage mode, WR-STAGE
// reference, never-stage-twice guards, the sweep) is indifferent to where the rows
// came from. So this function supplies the missing INPUT and changes nothing else.
//
// ── WHY THIS IS A MEASUREMENT, NOT A GUESS ───────────────────────────────────
// Fitting one daily rate per loan against real statements reproduces every Ford
// period to within ONE CENT (4140 → 8.29%, E5-4751 → 9.99%, E6-7410 → 8.99%).
// Those are clean numbers; a model that was fitting noise would not land on them.
// The stored contract rate says 9.000% for all three -- wrong for two, by $10-12 a
// period. So the measured rate is stored separately and the contract note is never
// used for posting.
//
// ── THE CONVENTION IS PER-LENDER: FIT IT, DO NOT ASSUME IT ───────────────────
// Ford accrues DAILY on the outstanding balance (actual/365). Funding Circle
// accrues a FLAT amount per period (17.99%/yr, fits to a cent). Both models are
// tried, the better one wins, and NOTHING IS ENABLED when the residual is too
// large. A staged transaction that is wrong by $85 is worse than none at all.
//
// ── v3: THE SECOND SOURCE ────────────────────────────────────────────────────
// Dexter Loan 2 and Verdant Capital have never sent a statement, so they published
// loan_accounts.interest_rate -- the typed figure this whole apparatus exists to
// stop publishing -- on a Debt Schedule that now goes to lenders and vendors. Both
// hold the LENDER'S OWN amortization schedule, whose interest column is evidence of
// the same kind as a statement, and which measures dead flat:
//
//     Dexter Loan 2     6.6400 %/yr over 59 rows, worst error $0.01   (typed: 6.500)
//     Verdant Capital   8.7800 %/yr over 83 rows, worst error $0.01   (typed: 9.000)
//
// Statements always get first refusal, and a schedule may only stand in where there
// is NO statement evidence at all -- never where statements exist and simply fit
// badly. So no loan with a statement-based fit today can have it moved by this.
// The arithmetic is in _shared/schedule-fit.ts; the precedence rule is measureRate()
// in _shared/derive-schedule.ts.
//
// ── VARIABLE RATES, AND WHY `refresh_rates` EXISTS ───────────────────────────
// Dexter Loan 2 is a variable-rate product. Its schedule carries a rate_change row
// dated 2026-08-31 taking 6.640% to 5.890%, corroborated by its own later rows
// ($422.44 of interest on $86,066.61 is 5.8900%) and by the payment stepping from
// $3,839.38 to $3,810.26. Dexter Loan 1 changed rate too, in 2023. So this is the
// shape of the product, not a one-off.
//
// loan_accounts holds exactly ONE fitted_annual_rate, and the Debt Schedule reads
// that one field. Three ways to live with that:
//
//   (a) publish the rate IN FORCE TODAY and re-measure when it changes.
//   (b) store an effective-dated SERIES (a loan_rate_periods table) and have every
//       reader ask for the rate as at a date.
//   (c) publish the newest rate on the document, whenever it starts.
//
// (c) is wrong outright -- it would print 5.890% for the five days it is still
// 6.640%. (b) is the real answer: a rate has always had a date range, one column
// cannot hold two, and every historical question ("what did we pay in March") wants
// the series. But it is a migration plus a change to every reader, including the
// Debt Schedule itself, and this is a Sept 1 deadline.
//
// So (a) is implemented, with the re-measurement automated rather than remembered:
// the fit reports EVERY rate segment in the schedule, publishes the one in force on
// the as-of date, and names the next change and its date out loud. `refresh_rates`
// re-runs that daily, so on 2026-08-31 Dexter's published rate becomes 5.890% by
// itself. What it costs: history is still not queryable, and there is a window of up
// to one day between a change taking effect and the number moving. Both are
// acceptable for a rate on a debt schedule; neither would be for posting money,
// which is why nothing here posts money. (b) stays on the list.
//
// ── DRY RUN BY DEFAULT ───────────────────────────────────────────────────────
// Writes nothing unless `confirm: true`. Enables staging only on `enable_staging:
// true` AND a passing gate, and never on the schedule path. Never touches Xero.
//
// Body: {
//   lender_account_number?: string,   // or loan_account_id
//   loan_account_id?: string,
//   confirm?: boolean,                // default false -- dry run
//   enable_staging?: boolean,         // default false -- set prestage_enabled + make the first card
//   max_residual?: number,            // default 0.05 -- dollars
//   min_periods?: number,             // default 4
//   as_of?: string,                   // default today (Pacific) -- which rate segment is "in force"
//   force_source?: 'lender_schedule', // DRY RUN ONLY: show the schedule fit even where statements exist
//
//   refresh_rates?: true,             // every active loan; re-publishes schedule-sourced rates
// }
// Body for refresh_rates accepts the x-wr-internal secret so pg_cron can call it with
// the anon key, the same mechanism loan-xero-post's stage sweep uses.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Content-Type': 'application/json',
}

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

// pg_cron can only ever carry the ANON key -- the database has no safe place for the
// service-role key. So an internally-called function authenticates on x-wr-internal
// instead (migration session_227h_internal_call_secret; charge-order, send-email,
// bookkeeping-kpis and loan-xero-post already use it).
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

async function callerRole(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  try {
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: userData } = await anon.auth.getUser(token)
    if (!userData?.user) return null
    const { data: prof } = await admin().from('profiles').select('role').eq('id', userData.user.id).single()
    return prof?.role ?? null
  } catch (_) {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors })

    const body = await req.json().catch(() => ({}))
    const confirm = body.confirm === true
    const asOf = typeof body.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.as_of) ? body.as_of : undefined

    // ── The scheduled refresh ────────────────────────────────────────────────
    if (body.refresh_rates === true) {
      const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      const isService = !!bearer && bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      if (!isService && !(await isInternalCall(req))) {
        const role = await callerRole(req)
        if (!role || !['admin', 'manager'].includes(role)) {
          return new Response(JSON.stringify({ error: 'Refreshing measured rates requires an admin or manager account.' }), { status: 403, headers: cors })
        }
      }
      const result = await refreshScheduleRates(admin(), {
        confirm, asOf,
        maxResidual: num(body.max_residual) ?? undefined,
        minPeriods: num(body.min_periods) ?? undefined,
        actor: 'loan-derive-schedule refresh_rates',
      })
      return new Response(JSON.stringify(result), { status: 200, headers: cors })
    }

    // ── One loan ─────────────────────────────────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!token) return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: cors })
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: userData } = await anon.auth.getUser(token)
    if (!userData?.user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: cors })
    const supa = admin()
    const { data: prof } = await supa.from('profiles').select('role').eq('id', userData.user.id).single()
    const role = prof?.role
    if (!['admin', 'manager', 'cpa'].includes(role)) {
      return new Response(JSON.stringify({ error: `Forbidden (role: ${role ?? 'none'})` }), { status: 403, headers: cors })
    }

    // Reading is advisory; writing is admin/manager, same contract as every other
    // function in this module.
    if (confirm && !['admin', 'manager'].includes(role)) {
      return new Response(JSON.stringify({ error: 'Writing a derived schedule requires admin or manager.' }), { status: 403, headers: cors })
    }

    // force_source exists so a human can LOOK at what a loan's lender schedule says
    // even where statements are the source of truth. It must never change what gets
    // written, or it becomes a way to publish the weaker evidence.
    const forceSource = typeof body.force_source === 'string' ? body.force_source : null
    if (forceSource && forceSource !== 'lender_schedule') {
      return new Response(JSON.stringify({ error: `force_source must be 'lender_schedule' (got '${forceSource}').` }), { status: 400, headers: cors })
    }
    if (forceSource && confirm) {
      return new Response(JSON.stringify({
        error: 'force_source is available on a dry run only. It shows you what a lender schedule works out to; it can never be the reason a rate gets written, because statements are the stronger evidence wherever they exist.',
      }), { status: 400, headers: cors })
    }

    let q = supa.from('loan_accounts').select('*')
    if (body.loan_account_id) q = q.eq('id', body.loan_account_id)
    else if (body.lender_account_number) q = q.eq('lender_account_number', String(body.lender_account_number))
    else return new Response(JSON.stringify({ error: 'Pass loan_account_id or lender_account_number.' }), { status: 400, headers: cors })
    const { data: loans } = await q
    const loan = loans?.[0]
    if (!loan) return new Response(JSON.stringify({ error: 'No matching loan account.' }), { status: 404, headers: cors })

    const opts = {
      confirm,
      enableStaging: body.enable_staging === true,
      maxResidual: num(body.max_residual) ?? undefined,
      minPeriods: num(body.min_periods) ?? undefined,
      asOf,
      actor: `loan-derive-schedule (${userData.user.email ?? role})`,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    }

    const result = forceSource === 'lender_schedule'
      ? { ...(await measureRateFromSchedule(supa, loan, { ...opts, confirm: false })), forced_source: true, wrote_nothing: true }
      : await measureRate(supa, loan, opts)

    const status = result.ok === false && result.reason === 'loan_not_active' ? 409 : 200
    return new Response(JSON.stringify(result), { status, headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
