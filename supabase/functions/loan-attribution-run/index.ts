// =============================================================================
// loan-attribution-run — the nightly attribution pass (session 261)
// =============================================================================
//
// WHAT IT DOES
//   For every loan carrying an open MATERIAL `balance_vs_lender` finding: ask
//   `loan-find-difference` (analyze mode, which writes nothing) to walk the loan, fetch
//   each accused bank transaction's Type fresh from Xero, run the walk through
//   `attributionFromWalk` + `buildAttributionPayload`, and store the result in
//   `loan_attributions`.
//
// WHY IT IS A JOB AND NOT PART OF reconciliation-run (session 259 cont. 14)
//   Because the free option is unusable, and the reason is a measurement rather than a
//   preference. `analyzeWalk()` is pure and `reconciliation-run` already holds a
//   compatible ledger, so calling it in-process looks like zero extra Xero calls. But
//   `reconciliation-run` FLOORS its ledger window at 120 days and the walk needs up to
//   18 months — E4-9744's variance originates 135 days back, outside that floor. Wired
//   naively, every pre-window span returns `divergent` with a FABRICATED gap equal to
//   the lender's whole movement, and it would reach the CPA looking confident. Do not
//   revive that idea without clamping `usable` to anchors >= windowFrom.
//   Measured cost of doing it properly: ~7 Xero calls per loan, ~35 per pass, against
//   1,000/day.
//
// WHAT IT NEVER DOES
//   It never writes to Xero and it cannot. It reaches `loan-find-difference` on the
//   x-wr-internal secret, which maps there to the role `internal_job` — outside the
//   ['admin','manager'] array every write gate in that file tests, and refused
//   explicitly by name if it ever asks for a write mode.
//
// INHERITED GAPS ARE REPORTED, NOT SUPPRESSED (David's call, session 259 cont. 14).
//   Suppressing them would hide the E4-9744 case that motivated the engine.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { attributionFromWalk } from '../_shared/attribution-from-walk.ts'
import { buildAttributionPayload, recordedEntryAmounts, ATTRIBUTION_SCHEMA } from '../_shared/attribution-store.ts'
import { effectiveCloseDate } from '../_shared/close-date.ts'
import { selectLoans, orderByStaleness, bankEntryIds, xeroIdWhereChunks, typeMapFromRows } from './selection.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Content-Type': 'application/json',
}

const FN = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1'

// A pass must end on its own terms rather than being cut off mid-loan by the platform.
// Whatever is left unvisited is NAMED in the report, and `orderByStaleness` guarantees
// those loans lead the next pass instead of being starved forever.
const TIME_BUDGET_MS = 210_000
// One loan's walk is an 18-month Xero crawl. Bound it so a single slow loan cannot eat
// the whole budget silently.
const PER_LOAN_MS = 90_000

function admin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
}

async function internalSecret(): Promise<string | null> {
  const { data } = await admin().from('wr_internal_auth').select('secret').maybeSingle()
  return data?.secret ?? null
}

async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const secret = await internalSecret().catch(() => null)
  return !!secret && provided === secret
}

async function callerRole(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  if (token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return 'service_role'
  try {
    const anon = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data } = await anon.auth.getUser(token)
    if (!data?.user) return null
    const { data: prof } = await admin().from('profiles').select('role').eq('id', data.user.id).single()
    return prof?.role ?? null
  } catch (_) {
    return null
  }
}

async function postJson(url: string, body: unknown, secret: string, timeoutMs: number) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wr-internal': secret },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch (_) { /* keep the raw text for the error */ }
    return { ok: res.ok, status: res.status, json, text }
  } finally {
    clearTimeout(t)
  }
}

/**
 * The types, fetched FRESH FROM XERO by id — the whole point of option (b). See
 * selection.ts's header for why they do not come from the walk.
 *
 * A chunk that fails does not fail the loan: the ids in it end up unmapped, their claims
 * refuse for want of a direction, and the count is reported. That is the honest outcome —
 * a refusal we can explain beats a verdict built on a type we did not actually read.
 */
async function fetchTxnTypes(ids: string[], secret: string) {
  const { chunks, rejected } = xeroIdWhereChunks(ids)
  const rows: Array<{ id?: unknown; type?: unknown }> = []
  const errors: string[] = []
  let calls = 0
  for (const where of chunks) {
    calls++
    try {
      const r = await postJson(`${FN}/xero-read`, { mode: 'bank_transactions', where }, secret, 45_000)
      if (!r.ok || !r.json?.ok) { errors.push(`xero-read ${r.status}: ${String(r.json?.error ?? r.text).slice(0, 160)}`); continue }
      // `results` is xero-read's list key, checked in its source -- not guessed. A
      // speculative `a ?? b ?? c` here would keep "working" through a shape change by
      // quietly returning nothing, and nothing is indistinguishable from a clean answer.
      if (!Array.isArray(r.json.results)) { errors.push('xero-read returned no results array'); continue }
      for (const row of r.json.results) rows.push(row)
    } catch (e) {
      errors.push(String((e as Error)?.message || e))
    }
  }
  const { map, missing } = typeMapFromRows(rows, ids)
  return { map, missing, rejected, errors, calls }
}

async function runOne(supa: any, loanId: string, findingId: string, secret: string, priorCloseDate: string | null, generatedAt: string) {
  const walkRes = await postJson(`${FN}/loan-find-difference`, { loan_account_id: loanId }, secret, PER_LOAN_MS)
  if (!walkRes.ok || !walkRes.json?.ok) {
    throw new Error(`loan-find-difference ${walkRes.status}: ${String(walkRes.json?.error ?? walkRes.text).slice(0, 300)}`)
  }
  const walk = walkRes.json

  // Our own splits, so the adapter never accuses an entry we filed ourselves at the
  // amount we filed it at. An entry on file at a DIFFERENT amount is the PCV shape and
  // is still reported — see recordedEntryAmounts.
  const { data: splits } = await supa.from('loan_splits')
    .select('xero_manual_journal_id, matched_xero_bank_transaction_id, principal_amount, voided_at')
    .eq('loan_account_id', loanId)

  const ids = bankEntryIds(walk)
  const types = ids.length ? await fetchTxnTypes(ids, secret) : { map: new Map(), missing: [], rejected: [], errors: [], calls: 0 }

  const att = attributionFromWalk(walk, {
    txnTypeById: types.map,
    recordedEntryIds: recordedEntryAmounts(splits ?? []),
  })

  const payload = buildAttributionPayload({
    verdicts: att.verdicts,
    skipped: att.skipped,
    generatedAt,
    notEnoughHistory: att.notEnoughHistory,
    priorCloseDate,
    source: 'loan-attribution-run',
  })

  return {
    payload,
    diagnostics: {
      bank_entry_ids: ids.length,
      types_resolved: types.map.size,
      types_missing: types.missing.length,
      ids_rejected: types.rejected.length,
      xero_calls: types.calls,
      type_errors: types.errors,
    },
  }
}

async function handle(req: Request): Promise<Response> {
  const supa = admin()
  const body = await req.json().catch(() => ({} as any))
  const dryRun = !!body?.dry_run
  const onlyLoan = typeof body?.loan_account_id === 'string' ? body.loan_account_id : null

  const role = await callerRole(req)
  const internal = await isInternalCall(req)
  if (!internal && !(role && ['admin', 'manager', 'cpa', 'service_role'].includes(role))) {
    return new Response(JSON.stringify({ error: 'Not authorized.' }), { status: 403, headers: cors })
  }

  const secret = await internalSecret()
  if (!secret) {
    return new Response(JSON.stringify({ error: 'No internal call secret on file; cannot reach loan-find-difference.' }), { status: 500, headers: cors })
  }

  const began = Date.now()
  const generatedAt = new Date().toISOString()
  const close = await effectiveCloseDate(supa)

  const { data: findings, error: fErr } = await supa.from('reconciliation_findings')
    .select('id, loan_account_id, check_key, status, severity, last_seen_at')
    .eq('check_key', 'balance_vs_lender').eq('status', 'open')
  if (fErr) return new Response(JSON.stringify({ error: `findings: ${fErr.message}` }), { status: 500, headers: cors })

  let selected = selectLoans(findings ?? [])
  if (onlyLoan) selected = selected.filter(s => s.loan_account_id === onlyLoan)

  const { data: stored } = await supa.from('loan_attributions').select('loan_account_id, generated_at')
  const ordered = orderByStaleness(selected, stored ?? [])

  const results: any[] = []
  const notAttempted: string[] = []

  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]
    if (Date.now() - began > TIME_BUDGET_MS) { notAttempted.push(...ordered.slice(i).map(x => x.loan_account_id)); break }
    try {
      const { payload, diagnostics } = await runOne(supa, s.loan_account_id, s.finding_id, secret, close.date, generatedAt)
      if (!dryRun) {
        const { error } = await supa.from('loan_attributions').upsert({
          loan_account_id: s.loan_account_id,
          schema_version: ATTRIBUTION_SCHEMA,
          generated_at: generatedAt,
          headline: payload.headline,
          payload,
          run_status: 'ok',
          error_message: null,
          source_finding_id: s.finding_id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'loan_account_id' })
        if (error) throw new Error(`upsert: ${error.message}`)
      }
      results.push({ loan_account_id: s.loan_account_id, run_status: 'ok', headline: payload.headline, counts: payload.counts, diagnostics })
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 500)
      // A loan that could not be walked gets a row saying so. The alternative — leaving
      // yesterday's payload in place — would show the CPA a stale answer with a fresh
      // look and no way to tell. `run_status='error'` is not "nothing found".
      if (!dryRun) {
        await supa.from('loan_attributions').upsert({
          loan_account_id: s.loan_account_id,
          schema_version: ATTRIBUTION_SCHEMA,
          generated_at: generatedAt,
          headline: null,
          payload: {},
          run_status: 'error',
          error_message: msg,
          source_finding_id: s.finding_id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'loan_account_id' })
      }
      results.push({ loan_account_id: s.loan_account_id, run_status: 'error', error: msg })
    }
  }

  // A row must never outlive its finding. When a gap is resolved the attribution that
  // explained it becomes an answer to a question nobody is asking any more, and a stale
  // explanation sitting beside a cleared loan is worse than no explanation at all.
  // Scoped to loans NOT selected this pass; nothing written above can be caught by it.
  let cleared = 0
  if (!dryRun && !onlyLoan) {
    const keep = new Set(selected.map(s => s.loan_account_id))
    const { data: all } = await supa.from('loan_attributions').select('loan_account_id')
    const stale = (all ?? []).map((r: any) => r.loan_account_id).filter((id: string) => !keep.has(id))
    if (stale.length) {
      const { error } = await supa.from('loan_attributions').delete().in('loan_account_id', stale)
      if (!error) cleared = stale.length
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    generated_at: generatedAt,
    close_date: close.date,
    close_source: close.source,
    selected: selected.length,
    attempted: results.length,
    not_attempted: notAttempted,
    cleared,
    elapsed_ms: Date.now() - began,
    results,
  }, null, 2), { headers: cors })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    return await handle(req)
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 500, headers: cors })
  }
})
