// sync-sendgrid — keeps SendGrid Marketing Campaigns in step with WashRoute.
// Session 315 (2026-09-23). Replaces sync-klaviyo once Klaviyo is cancelled.
//
// WHAT IT DOES (fullsync, nightly):
//   1. PULL opt-outs FROM SendGrid → WashRoute. Anyone in the "Marketing emails"
//      unsubscribe group, the global unsubscribe list or the spam-report list gets
//      customers.email_marketing_opt_out_at set. SendGrid hard bounces go into
//      public.email_suppressions (an undeliverable ADDRESS, not a person's choice).
//   2. PUSH opt-outs TO SendGrid: every opted-out WashRoute email is added to the
//      "Marketing emails" group, so a newsletter sent with that group skips them.
//   3. UPSERT every marketable customer into the "WashRoute customers" list.
//   4. DELETE from SendGrid Marketing any contact whose WashRoute customer is no
//      longer marketable.
//
// IT NEVER SENDS EMAIL. It only edits contacts, lists and suppressions. The one
// way a list change could send is a SendGrid Automation triggered by "added to
// list" — confirm none exists before the first fullsync (preflight).
//
// Marketable = email_marketing_consent_at set, email_marketing_opt_out_at null,
// a valid-looking email, not a Starchup placeholder, not in email_suppressions,
// not on SendGrid's bounce list.
//
// SAFETY CAPS (a large number is far more likely a bug than real):
//   - Step 1 refuses to opt out more than PULL_OPTOUT_CAP customers in one run.
//   - Step 3 refuses to push more than PUSH_CAP contacts (plan limit is 10,000).
//   - Step 4 refuses to delete more than DELETE_CAP contacts in one run.
//   Pass {"allow_bulk": true} on a manual call to go past them after checking why.
//
// MODES:  verify  — API key scopes + group; creates the EMPTY list if missing (proves write access)
//         dryrun  — everything fullsync would do, as counts + samples, read-only
//         fullsync— does it (cron entry point)
//         jobstatus {job_id} — status of a contacts import job
//         lookup {emails:[...]} — read-only: what SendGrid holds for up to 20 contacts
//
// AUTH: x-wr-internal header (public.wr_internal_secret(), same as every pg_cron
// HTTP job). verify_jwt must be FALSE — the cron sends no Authorization header.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SG_KEY = Deno.env.get('SENDGRID_API_KEY') || ''
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const LIST_NAME = 'WashRoute customers'
const UNSUB_GROUP_ID = 34476            // "Marketing emails" (created 2026-09-23)
const PULL_OPTOUT_CAP = 50
const PUSH_CAP = 9500
const DELETE_CAP = 300

const REQUIRED_SCOPES = [
  'marketing.read', 'marketing.write',
  'asm.groups.suppressions.read', 'asm.groups.suppressions.create',
  'suppression.bounces.read', 'suppression.unsubscribes.read', 'suppression.spam_reports.read',
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isPlaceholder = (e: string) => /\+app\.starchup\.com@/i.test(e)
const norm = (e: string | null | undefined) => (e || '').trim().toLowerCase()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// ── SendGrid HTTP ──────────────────────────────────────────────────────────
async function sg(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.sendgrid.com' + path, {
      method,
      headers: { 'Authorization': `Bearer ${SG_KEY}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue }
    const text = await r.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    return { ok: r.ok, status: r.status, data }
  }
  return { ok: false, status: 429, data: 'rate limited after retries' }
}
function sgErr(label: string, r: { status: number; data: any }): Error {
  const detail = r.data?.errors?.map((e: any) => e.message).join('; ') || JSON.stringify(r.data)?.slice(0, 300)
  return new Error(`SendGrid ${label} failed (${r.status}): ${detail}`)
}

// Suppression lists (/v3/suppression/*) page with limit/offset.
async function sgSuppressionList(kind: 'bounces' | 'unsubscribes' | 'spam_reports'): Promise<{ email: string; created: number }[]> {
  const out: { email: string; created: number }[] = []
  for (let offset = 0; offset < 200_000; offset += 500) {
    const r = await sg('GET', `/v3/suppression/${kind}?limit=500&offset=${offset}`)
    if (!r.ok) throw sgErr(`read ${kind}`, r)
    const rows = Array.isArray(r.data) ? r.data : []
    for (const x of rows) if (x?.email) out.push({ email: norm(x.email), created: Number(x.created || 0) })
    if (rows.length < 500) return out
  }
  throw new Error(`SendGrid ${kind}: runaway paging`)
}

async function sgGroupSuppressions(): Promise<Set<string>> {
  const r = await sg('GET', `/v3/asm/groups/${UNSUB_GROUP_ID}/suppressions`)
  if (!r.ok) throw sgErr('read group suppressions', r)
  return new Set((Array.isArray(r.data) ? r.data : []).map((e: string) => norm(e)))
}

async function findList(createIfMissing: boolean): Promise<{ id: string | null; contact_count: number | null }> {
  const r = await sg('GET', '/v3/marketing/lists?page_size=1000')
  if (!r.ok) throw sgErr('read lists', r)
  const hit = (r.data?.result || []).find((l: any) => l.name === LIST_NAME)
  if (hit) return { id: hit.id, contact_count: hit.contact_count ?? null }
  if (!createIfMissing) return { id: null, contact_count: null }
  const c = await sg('POST', '/v3/marketing/lists', { name: LIST_NAME })
  if (!c.ok) throw sgErr('create list', c)
  return { id: c.data.id, contact_count: 0 }
}

// Contact ids for a set of emails (search is 100 emails per call; 404 = none found).
async function contactIdsFor(emails: string[]): Promise<{ email: string; id: string }[]> {
  const out: { email: string; id: string }[] = []
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100)
    const r = await sg('POST', '/v3/marketing/contacts/search/emails', { emails: chunk })
    if (r.status === 404) continue
    if (!r.ok) throw sgErr('search contacts', r)
    for (const [email, v] of Object.entries(r.data?.result || {})) {
      const id = (v as any)?.contact?.id
      if (id) out.push({ email: norm(email), id })
    }
  }
  return out
}

// ── WashRoute reads ────────────────────────────────────────────────────────
type Cust = {
  id: string; email_cache: string | null; first_name_cache: string | null; last_name_cache: string | null
  email_marketing_consent_at: string | null; email_marketing_opt_out_at: string | null
}
async function allCustomersWithEmail(): Promise<Cust[]> {
  const out: Cust[] = []
  for (let page = 0; page < 100; page++) {
    const from = page * 1000
    const { data, error } = await db.from('customers')
      .select('id, email_cache, first_name_cache, last_name_cache, email_marketing_consent_at, email_marketing_opt_out_at')
      .not('email_cache', 'is', null).neq('email_cache', '')
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`customers page ${page + 1}: ${error.message} — refusing to continue on a partial read`)
    out.push(...(data || []) as Cust[])
    if ((data || []).length < 1000) return out
  }
  throw new Error('customers: runaway paging')
}
async function suppressedAddresses(): Promise<Set<string>> {
  // PostgREST caps a select at 1,000 rows without saying so — page it.
  const out = new Set<string>()
  for (let page = 0; page < 200; page++) {
    const from = page * 1000
    const { data, error } = await db.from('email_suppressions').select('email')
      .order('email', { ascending: true }).range(from, from + 999)
    if (error) throw new Error(`email_suppressions page ${page + 1}: ${error.message}`)
    for (const r of data || []) out.add(norm((r as any).email))
    if ((data || []).length < 1000) return out
  }
  throw new Error('email_suppressions: runaway paging')
}

// ── The plan: everything fullsync would do, computed read-only ─────────────
async function buildPlan() {
  const [customers, suppressedWR, groupSupp, sgUnsubs, sgSpam, sgBounces] = await Promise.all([
    allCustomersWithEmail(), suppressedAddresses(), sgGroupSuppressions(),
    sgSuppressionList('unsubscribes'), sgSuppressionList('spam_reports'), sgSuppressionList('bounces'),
  ])

  // 1a. People who opted out in SendGrid but are still marketable in WashRoute.
  const sgOptOut = new Map<string, number>()   // email → unix seconds (0 = unknown)
  for (const e of groupSupp) sgOptOut.set(e, 0)
  for (const x of [...sgUnsubs, ...sgSpam]) sgOptOut.set(x.email, x.created || sgOptOut.get(x.email) || 0)
  const pullOptOut = customers.filter(c => !c.email_marketing_opt_out_at && sgOptOut.has(norm(c.email_cache)))

  // 1b. SendGrid bounces not yet in email_suppressions.
  const newBounces = sgBounces.filter(b => b.email && !suppressedWR.has(b.email))
  const bounced = new Set<string>([...suppressedWR, ...sgBounces.map(b => b.email)])

  // Marketable, AFTER applying 1a (so a fresh SendGrid opt-out is never pushed back).
  const pulledIds = new Set(pullOptOut.map(c => c.id))
  const marketable = new Map<string, Cust>()   // email → first customer with it
  const optedOutEmails = new Set<string>()
  const excluded = { no_consent: 0, opted_out: 0, bounced: 0, invalid_email: 0, placeholder: 0 }
  for (const c of customers) {
    const e = norm(c.email_cache)
    const optedOut = !!c.email_marketing_opt_out_at || pulledIds.has(c.id)
    if (optedOut) { optedOutEmails.add(e); excluded.opted_out++; continue }
    if (!c.email_marketing_consent_at) { excluded.no_consent++; continue }
    if (!EMAIL_RE.test(e)) { excluded.invalid_email++; continue }
    if (isPlaceholder(e)) { excluded.placeholder++; continue }
    if (bounced.has(e)) { excluded.bounced++; continue }
    if (!marketable.has(e)) marketable.set(e, c)
  }
  // An email shared by an opted-out and a consenting customer: the opt-out wins.
  for (const e of optedOutEmails) marketable.delete(e)

  // 2. Opted-out emails the SendGrid group doesn't have yet.
  const groupAdds = [...optedOutEmails].filter(e => EMAIL_RE.test(e) && !groupSupp.has(e))

  // 4. Candidates for deletion from SendGrid: every WashRoute email that is NOT marketable.
  const allEmails = new Set(customers.map(c => norm(c.email_cache)))
  const notMarketable = [...allEmails].filter(e => EMAIL_RE.test(e) && !marketable.has(e))

  return {
    customers: customers.length, marketable, excluded, pullOptOut, sgOptOut, newBounces,
    groupAdds, notMarketable,
    sendgrid: { group_suppressions: groupSupp.size, unsubscribes: sgUnsubs.length, spam_reports: sgSpam.length, bounces: sgBounces.length },
  }
}

// ── Internal-caller auth (same mechanism as sync-klaviyo, session 228) ─────
async function isInternalCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-wr-internal') || ''
  if (!provided) return false
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle()
  return !!data?.secret && provided === data.secret
}

Deno.serve(async (req) => {
  const started = Date.now()
  try {
    if (!(await isInternalCall(req))) {
      console.warn('sync-sendgrid: rejected caller without a valid x-wr-internal secret')
      return json({ error: 'forbidden' }, 403)
    }
    if (!SG_KEY) return json({ error: 'SENDGRID_API_KEY not set' }, 500)
    const body = await req.json().catch(() => ({}))
    const mode = body.mode || 'verify'
    const allowBulk = body.allow_bulk === true

    if (mode === 'verify') {
      const s = await sg('GET', '/v3/scopes')
      const scopes: string[] = s.ok ? (s.data?.scopes || []) : []
      const missing = REQUIRED_SCOPES.filter(x => !scopes.includes(x))
      let list: any = null, group: any = null
      // Creating the (empty) list is harmless and is the real test of marketing write access —
      // scope names alone have proved unreliable.
      if (!missing.includes('marketing.read')) list = await findList(true).catch(e => ({ error: e.message }))
      const g = await sg('GET', `/v3/asm/groups/${UNSUB_GROUP_ID}`)
      group = g.ok ? { id: g.data?.id, name: g.data?.name, unsubscribes: g.data?.unsubscribes } : { error: g.status }
      // Scope names vary by account type, so also show every relevant scope the key has.
      const relevant = scopes.filter(x => /marketing|^mc\.|asm|suppression/.test(x)).sort()
      return json({ ok: s.ok && missing.length === 0, scopes_status: s.status, missing_scopes: missing, relevant_scopes: relevant, list, group })
    }

    if (mode === 'jobstatus') {
      const r = await sg('GET', `/v3/marketing/contacts/imports/${encodeURIComponent(body.job_id || '')}`)
      return json({ ok: r.ok, status: r.status, job: r.data })
    }

    if (mode === 'lookup') {
      const emails: string[] = (Array.isArray(body.emails) ? body.emails : []).map((e: string) => norm(e)).filter((e: string) => EMAIL_RE.test(e)).slice(0, 20)
      if (!emails.length) return json({ error: 'emails required' }, 400)
      const r = await sg('POST', '/v3/marketing/contacts/search/emails', { emails })
      if (r.status === 404) return json({ found: {} })
      if (!r.ok) throw sgErr('search contacts', r)
      const found: Record<string, unknown> = {}
      for (const [email, v] of Object.entries(r.data?.result || {})) {
        const c = (v as any)?.contact
        found[norm(email)] = c ? { first_name: c.first_name ?? null, last_name: c.last_name ?? null, list_ids: c.list_ids || [], created_at: c.created_at, updated_at: c.updated_at } : (v as any)?.error || null
      }
      return json({ found })
    }

    if (mode !== 'dryrun' && mode !== 'fullsync') return json({ error: 'unknown mode' }, 400)

    const plan = await buildPlan()
    const deleteCandidates = await contactIdsFor(plan.notMarketable)   // read-only search
    const list = await findList(mode === 'fullsync')

    const summary: any = {
      mode, customers_with_email: plan.customers, marketable: plan.marketable.size,
      excluded: plan.excluded, sendgrid: plan.sendgrid, list,
      step1_pull_optouts: plan.pullOptOut.length, step1_new_bounces: plan.newBounces.length,
      step2_group_adds: plan.groupAdds.length, step3_upsert: plan.marketable.size,
      step4_delete: deleteCandidates.length,
      samples: {
        pull_optouts: plan.pullOptOut.slice(0, 5).map(c => norm(c.email_cache)),
        delete: deleteCandidates.slice(0, 5).map(x => x.email),
      },
    }

    const overCap: string[] = []
    if (plan.pullOptOut.length > PULL_OPTOUT_CAP) overCap.push(`step1 would opt out ${plan.pullOptOut.length} (cap ${PULL_OPTOUT_CAP})`)
    if (plan.marketable.size > PUSH_CAP) overCap.push(`step3 would push ${plan.marketable.size} (cap ${PUSH_CAP})`)
    if (deleteCandidates.length > DELETE_CAP) overCap.push(`step4 would delete ${deleteCandidates.length} (cap ${DELETE_CAP})`)
    summary.over_cap = overCap

    if (mode === 'dryrun') { summary.ms = Date.now() - started; return json(summary) }
    if (overCap.length && !allowBulk) {
      console.error('sync-sendgrid: refused, over safety cap', overCap)
      return json({ ...summary, refused: true, reason: 'over safety cap — run dryrun, check why, then pass allow_bulk' }, 409)
    }

    // ── Step 1: pull ──
    const nowIso = new Date().toISOString()
    const ids = plan.pullOptOut.map(c => c.id)
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await db.from('customers')
        .update({ email_marketing_opt_out_at: nowIso, updated_at: nowIso })
        .in('id', ids.slice(i, i + 100)).is('email_marketing_opt_out_at', null)
      if (error) throw new Error(`step1 opt-out write failed: ${error.message} — stopping before any SendGrid change`)
    }
    if (plan.newBounces.length) {
      const rows = plan.newBounces.filter(b => EMAIL_RE.test(b.email)).map(b => ({
        email: b.email, reason: 'hard_bounce', source: 'sendgrid',
        first_seen_at: b.created ? new Date(b.created * 1000).toISOString() : null,
      }))
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('email_suppressions').upsert(rows.slice(i, i + 500), { onConflict: 'email', ignoreDuplicates: true })
        if (error) throw new Error(`step1 bounce write failed: ${error.message} — stopping before any SendGrid change`)
      }
    }

    // ── Step 2: opt-outs → SendGrid group ──
    for (let i = 0; i < plan.groupAdds.length; i += 500) {
      const r = await sg('POST', `/v3/asm/groups/${UNSUB_GROUP_ID}/suppressions`, { recipient_emails: plan.groupAdds.slice(i, i + 500) })
      if (!r.ok) throw sgErr('add group suppressions', r)
    }

    // ── Step 3: upsert marketable contacts into the list ──
    const contacts = [...plan.marketable.entries()].map(([email, c]) => {
      const x: any = { email }
      if (c.first_name_cache) x.first_name = c.first_name_cache.trim().slice(0, 50)
      if (c.last_name_cache) x.last_name = c.last_name_cache.trim().slice(0, 50)
      return x
    })
    const jobs: string[] = []
    for (let i = 0; i < contacts.length; i += 5000) {
      const r = await sg('PUT', '/v3/marketing/contacts', { list_ids: [list.id], contacts: contacts.slice(i, i + 5000) })
      if (!r.ok) throw sgErr('upsert contacts', r)
      if (r.data?.job_id) jobs.push(r.data.job_id)
    }

    // ── Step 4: remove contacts that are no longer marketable ──
    let deleted = 0
    for (let i = 0; i < deleteCandidates.length; i += 100) {
      const chunk = deleteCandidates.slice(i, i + 100).map(x => x.id)
      const r = await sg('DELETE', `/v3/marketing/contacts?ids=${chunk.join(',')}`)
      if (!r.ok) throw sgErr('delete contacts', r)
      deleted += chunk.length
    }

    summary.done = { opted_out: ids.length, bounces_saved: plan.newBounces.length, group_added: plan.groupAdds.length, upserted: contacts.length, import_jobs: jobs, deleted }
    summary.ms = Date.now() - started
    console.log('sync-sendgrid fullsync', JSON.stringify(summary.done))
    return json(summary)
  } catch (e: any) {
    console.error('sync-sendgrid error:', e?.message || e)
    return json({ error: e?.message || String(e) }, 500)
  }
})
