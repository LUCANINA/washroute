import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// v11 (session 185): serve Stripe processing fees from a Postgres MIRROR instead of
// paginating the Stripe balance-transactions API live on every report load (~2.5s+).
// The mirror (stripe_fee_cache) is kept current by an incremental forward sync + a
// bounded backward backfill (one chunk per call). Settled balance transactions are
// immutable, so once mirrored a window is answered instantly from the DB.
// SAFETY: the entire mirror path is wrapped in try/catch — on ANY error it falls
// back to the original live-Stripe pagination, so the reports can never break.

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Per-call backfill chunk (~1500 balance txns) — bounded so no single call is slow.
const BACKWARD_PAGES = 15
// Re-scan the last 2 days on every forward sync to catch late-settling charges.
const OVERLAP_SEC = 2 * 86400

// verify_jwt:false — auth enforced here via requireAdmin (session 134 pattern).
async function requireAdmin(req: Request): Promise<void> {
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) throw new Error('Missing Authorization header')
  const { data: { user }, error: userErr } = await db.auth.getUser(jwt)
  if (userErr || !user) throw new Error('Unauthorized')
  const { data: profile, error: profErr } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (profErr) throw new Error('Could not verify role: ' + profErr.message)
  if (profile?.role !== 'admin') throw new Error('Admin only')
}

function btToRow(bt: any) {
  const ch: any = bt.source
  const piId: string | undefined = typeof ch?.payment_intent === 'string' ? ch.payment_intent : ch?.payment_intent?.id
  if (!piId) return null
  return {
    payment_intent_id: piId,
    fee_cents: bt.fee,
    net_cents: bt.net,
    charge_cents: bt.amount,
    bt_id: bt.id,
    bt_created: new Date(bt.created * 1000).toISOString(),
  }
}

async function upsertRows(rows: any[]) {
  if (!rows.length) return
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('stripe_fee_cache').upsert(rows.slice(i, i + 500), { onConflict: 'payment_intent_id' })
    if (error) throw new Error('cache upsert: ' + error.message)
  }
}

// Forward: pull anything newer than the forward cursor (tiny in steady state).
async function syncForward(fwd: string | null): Promise<number> {
  const since = (fwd ? Math.floor(new Date(fwd).getTime() / 1000) : Math.floor(Date.now() / 1000)) - OVERLAP_SEC
  let startingAfter: string | undefined, hasMore = true, safety = 80, maxCreated = 0
  const rows: any[] = []
  while (hasMore && safety-- > 0) {
    const page: any = await stripe.balanceTransactions.list({ created: { gte: since }, type: 'charge', limit: 100, expand: ['data.source'], starting_after: startingAfter })
    for (const bt of page.data) { const r = btToRow(bt); if (r) rows.push(r); if (bt.created > maxCreated) maxCreated = bt.created }
    hasMore = page.has_more
    if (hasMore && page.data.length) startingAfter = page.data[page.data.length - 1].id
  }
  await upsertRows(rows)
  return maxCreated
}

// Backward: one bounded chunk older than the backward cursor.
async function syncBackwardChunk(bwd: string | null): Promise<{ minCreated: number; reachedEnd: boolean }> {
  const before = bwd ? Math.floor(new Date(bwd).getTime() / 1000) : Math.floor(Date.now() / 1000)
  let startingAfter: string | undefined, hasMore = true, pages = 0, minCreated = before, reachedEnd = false
  const rows: any[] = []
  while (hasMore && pages < BACKWARD_PAGES) {
    const page: any = await stripe.balanceTransactions.list({ created: { lt: before }, type: 'charge', limit: 100, expand: ['data.source'], starting_after: startingAfter })
    for (const bt of page.data) { const r = btToRow(bt); if (r) rows.push(r); if (bt.created < minCreated) minCreated = bt.created }
    pages++
    hasMore = page.has_more
    if (hasMore && page.data.length) startingAfter = page.data[page.data.length - 1].id
    if (!hasMore) reachedEnd = true
  }
  await upsertRows(rows)
  return { minCreated, reachedEnd }
}

// Fallback (original behavior): serve a window straight from Stripe. Used if the
// mirror path errors for ANY reason, so the reports can never break.
async function serveDirectFromStripe(fromUnix: number, toUnix: number) {
  const feesByPI: Record<string, any> = {}
  let hasMore = true, startingAfter: string | undefined, safety = 50
  while (hasMore && safety-- > 0) {
    const page: any = await stripe.balanceTransactions.list({ created: { gte: fromUnix, lte: toUnix }, type: 'charge', limit: 100, expand: ['data.source'], starting_after: startingAfter })
    for (const bt of page.data) { const r = btToRow(bt); if (r) feesByPI[r.payment_intent_id] = { fee_cents: r.fee_cents, net_cents: r.net_cents, charge_cents: r.charge_cents } }
    hasMore = page.has_more
    if (hasMore && page.data.length) startingAfter = page.data[page.data.length - 1].id
  }
  return feesByPI
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    await requireAdmin(req)
    const { from, to } = await req.json()
    if (!from || !to) throw new Error('from and to required (YYYY-MM-DD)')

    const fromUnix = Math.floor(new Date(from + 'T00:00:00-08:00').getTime() / 1000) - 86400
    const toUnix   = Math.floor(new Date(to   + 'T23:59:59-08:00').getTime() / 1000) + 86400
    const fromISO = new Date(fromUnix * 1000).toISOString()
    const toISO   = new Date(toUnix * 1000).toISOString()

    let feesByPI: Record<string, any> = {}
    let source = 'mirror'
    try {
      const { data: state } = await db.from('stripe_fee_sync').select('*').eq('id', 1).maybeSingle()

      // 1) Forward sync — keep recent txns current (tiny once caught up)
      const newMax = await syncForward(state?.forward_cursor ?? null)
      const nextState: any = {
        id: 1,
        forward_cursor: newMax ? new Date(newMax * 1000).toISOString() : (state?.forward_cursor ?? new Date().toISOString()),
        backward_cursor: state?.backward_cursor ?? new Date().toISOString(),
        backfill_done: state?.backfill_done ?? false,
        updated_at: new Date().toISOString(),
      }

      // 2) Backward backfill — one bounded chunk per call until complete
      if (!nextState.backfill_done) {
        const { minCreated, reachedEnd } = await syncBackwardChunk(state?.backward_cursor ?? null)
        nextState.backward_cursor = new Date(minCreated * 1000).toISOString()
        nextState.backfill_done = reachedEnd
      }
      await db.from('stripe_fee_sync').upsert(nextState, { onConflict: 'id' })

      // 3) Serve the requested window from the mirror (fast DB read)
      const { data: rows, error: selErr } = await db.from('stripe_fee_cache')
        .select('payment_intent_id, fee_cents, net_cents, charge_cents')
        .gte('bt_created', fromISO).lte('bt_created', toISO)
        .limit(20000)
      if (selErr) throw new Error('cache read: ' + selErr.message)
      for (const r of rows || []) feesByPI[r.payment_intent_id] = { fee_cents: r.fee_cents, net_cents: r.net_cents, charge_cents: r.charge_cents }
    } catch (mirrorErr) {
      console.warn('get-stripe-fees mirror path failed, falling back to live Stripe:', (mirrorErr as any)?.message)
      source = 'stripe-fallback'
      feesByPI = await serveDirectFromStripe(fromUnix, toUnix)
    }

    return new Response(JSON.stringify({ feesByPI, count: Object.keys(feesByPI).length, source }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('get-stripe-fees error:', (error as any).message)
    const status = /unauthorized|admin only|missing authorization/i.test((error as any).message) ? 403 : 500
    return new Response(JSON.stringify({ error: (error as any).message }), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
