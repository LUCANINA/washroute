import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { getXeroAuth } from "../_shared/xero-auth.ts"
import { effectiveCloseDate, isPeriodClosed, closedNote } from "../_shared/close-date.ts"

// xero-close-date — v1 (session 230)
// =============================================================================
// Reads the CPA's own close decision out of Xero, caches it, and (on request)
// files everything sitting in an already-closed period so it stops asking to be
// approved.
//
// Xero exposes two lock dates on the Organisation:
//   PeriodLockDate    -- set when a period is closed to everyone but advisers
//   EndOfYearLockDate -- set at year end, locks everyone including advisers
// The later of the two is what "closed" means in practice, so that is what gets
// cached. A manual override lives in settings for the case where the books are
// closed without a lock date being set; see _shared/close-date.ts for why the
// effective date is the LATER of the two and never the earlier.
//
// Body: {
//   confirm?: boolean,          // default false -- dry run, writes nothing
//   file_closed_splits?: boolean, // also file pending splits inside closed periods
//   manual_close_date?: 'YYYY-MM-DD' | null,  // set/clear the override
//   manual_note?: string,
// }

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}
const isoOrNull = (v: any): string | null => {
  const s = String(v ?? '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

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
      return new Response(JSON.stringify({ error: 'Changing the close date requires admin or manager.' }), { status: 403, headers: cors })
    }

    // ── 1. Ask Xero what it has locked ───────────────────────────────────────
    let xeroLock: string | null = null
    let xeroError: string | null = null
    try {
      const auth = await getXeroAuth()
      const res = await fetch('https://api.xero.com/api.xro/2.0/Organisation', { headers: auth.headers })
      if (!res.ok) {
        xeroError = `Xero returned ${res.status}`
      } else {
        const j = await res.json()
        const org = (j?.Organisations || [])[0] || {}
        // Xero dates arrive as '/Date(1750000000000+0000)/' or ISO depending on
        // endpoint and Accept header. Handle both rather than assuming one.
        const parse = (v: any): string | null => {
          if (!v) return null
          const s = String(v)
          const ms = s.match(/\/Date\((-?\d+)/)
          if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10)
          return isoOrNull(s)
        }
        const period = parse(org.PeriodLockDate)
        const eoy = parse(org.EndOfYearLockDate)
        xeroLock = [period, eoy].filter(Boolean).sort().pop() ?? null
      }
    } catch (e) {
      xeroError = String((e as any)?.message ?? e)
    }

    // ── 2. Persist what we learned (and any manual override) ─────────────────
    const patch: Record<string, any> = {}
    if (xeroLock) { patch.xero_period_lock_date = xeroLock; patch.xero_lock_date_synced_at = new Date().toISOString() }
    if ('manual_close_date' in body) {
      patch.books_closed_through = isoOrNull(body.manual_close_date)
      patch.books_closed_through_note = typeof body.manual_note === 'string' ? body.manual_note : null
    }
    if (confirm && Object.keys(patch).length) {
      await supa.from('settings').update(patch).eq('id', 1)
    }

    const cd = confirm
      ? await effectiveCloseDate(supa)
      : await (async () => {
          const live = await effectiveCloseDate(supa)
          // Show what the answer WOULD be, without writing it.
          const manual = 'manual_close_date' in body ? isoOrNull(body.manual_close_date) : live.manual
          const xero = xeroLock ?? live.xero
          const date = [manual, xero].filter(Boolean).sort().pop() ?? null
          return { ...live, date, xero, manual }
        })()

    // ── 3. File anything already sitting inside a closed period ──────────────
    // Never touches a split that has reached Xero (posted / staged /
    // already_in_xero): those are records of something real, and a close date is
    // not a reason to rewrite them. Only work-in-waiting is filed.
    const OPEN_STATUSES = ['pending_review', 'needs_attention']
    let candidates: any[] = []
    let filed = 0
    if (cd.date) {
      const { data: openSplits } = await supa.from('loan_splits')
        .select('id, loan_account_id, period_label, status, principal_amount, interest_amount, total_amount, loan_accounts(xero_account_name)')
        .in('status', OPEN_STATUSES)
      candidates = (openSplits || []).filter((s: any) => isPeriodClosed(s.period_label, cd.date))
      if (confirm && body.file_closed_splits === true) {
        for (const s of candidates) {
          const { error } = await supa.from('loan_splits').update({
            status: 'closed_period',
            review_notes: closedNote(cd, String(s.period_label)),
          }).eq('id', s.id).in('status', OPEN_STATUSES)   // never race a human's click
          if (!error) filed++
        }
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      dry_run: !confirm,
      close_date: cd,
      xero_lock_date_read: xeroLock,
      xero_error: xeroError,
      splits_in_closed_periods: candidates.map((s: any) => ({
        id: s.id, loan: s.loan_accounts?.xero_account_name, period_label: s.period_label,
        status: s.status, principal: Number(s.principal_amount), interest: Number(s.interest_amount),
      })),
      filed,
      note: !cd.date
        ? 'No close date is set. Xero has no lock date and no manual override is recorded, so nothing is treated as closed.'
        : `Books are closed through ${cd.date} (${cd.source.replace(/_/g, ' ')}). ${candidates.length} split${candidates.length === 1 ? '' : 's'} sit inside that range${confirm && body.file_closed_splits ? ` — ${filed} filed.` : '.'}`,
    }), { headers: cors })
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message ?? e), wrote_nothing: true }), { status: 500, headers: cors })
  }
})
