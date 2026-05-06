import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(supabaseUrl, supabaseServiceKey)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Session 134: deployed with verify_jwt:false to match the project-wide pattern
// (see PROJECT-NOTES Guiding Principle on edge function JWT). Auth is enforced
// in-function via requireAdmin() — decode the caller's JWT, look up profiles.role,
// require 'admin'. Previous verify_jwt:true caused expired-token requests to bounce
// at the gateway with HTTP 401 and no useful error message.
async function requireAdmin(req: Request): Promise<void> {
  const authHeader = req.headers.get('Authorization') || ''
  const jwt = authHeader.replace(/^Bearer\s+/i, '')
  if (!jwt) throw new Error('Missing Authorization header')
  const { data: { user }, error: userErr } = await db.auth.getUser(jwt)
  if (userErr || !user) throw new Error('Unauthorized')
  const { data: profile, error: profErr } = await db
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  if (profErr) throw new Error('Could not verify role: ' + profErr.message)
  if (profile?.role !== 'admin') throw new Error('Admin only')
}

// Returns a map of { [payment_intent_id]: { fee_cents, net_cents, charge_cents } }
// for all successful charges whose balance transaction was created within the window.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    await requireAdmin(req)

    const { from, to } = await req.json()
    if (!from || !to) throw new Error('from and to required (YYYY-MM-DD)')

    // Pacific offset is naive but good enough for a ±1d padded window.
    const fromUnix = Math.floor(new Date(from + 'T00:00:00-08:00').getTime() / 1000) - 86400
    const toUnix   = Math.floor(new Date(to   + 'T23:59:59-08:00').getTime() / 1000) + 86400

    const feesByPI: Record<string, { fee_cents: number; net_cents: number; charge_cents: number }> = {}
    let hasMore = true
    let startingAfter: string | undefined = undefined
    let safety = 50

    while (hasMore && safety-- > 0) {
      const page: any = await stripe.balanceTransactions.list({
        created: { gte: fromUnix, lte: toUnix },
        type: 'charge',
        limit: 100,
        expand: ['data.source'],
        starting_after: startingAfter,
      })

      for (const bt of page.data) {
        const ch: any = bt.source
        if (!ch || !ch.payment_intent) continue
        const piId: string = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id
        if (!piId) continue
        feesByPI[piId] = {
          fee_cents: bt.fee,
          net_cents: bt.net,
          charge_cents: bt.amount,
        }
      }

      hasMore = page.has_more
      if (hasMore && page.data.length) startingAfter = page.data[page.data.length - 1].id
    }

    return new Response(JSON.stringify({ feesByPI, count: Object.keys(feesByPI).length }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('get-stripe-fees error:', error.message)
    const status = /unauthorized|admin only|missing authorization/i.test(error.message) ? 403 : 500
    return new Response(JSON.stringify({ error: error.message }), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
