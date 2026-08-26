import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { getXeroAuth } from '../_shared/xero-auth.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(supabaseUrl, supabaseServiceKey)
const cryptoProvider = Stripe.createSubtleCryptoProvider()

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
}

const XERO_STRIPE_CONTACT_ID = '7b92345a-f706-417b-af91-36dfe723355e'
const XERO_BANK_ACCOUNT_ID = '8fd57c83-6519-442b-a34f-26adb9343429'
const STRIPE_CAPITAL_ACCOUNT_CODE = '304'

const CATS: Record<string, { code: string; name: string }> = {
  subscription: { code: '405', name: 'Delivery - Subscription Fees' },
  delivery:     { code: '403', name: 'Delivery - Wash & Fold' },
  retail_wf:    { code: '404', name: 'Retail - Wash & Fold' },
  retail_vend:  { code: '401', name: 'Retail - Vending' },
  gift_card:    { code: '461', name: 'Delivery - Gift card sales' },
}

// Session 202: Credits and Discounts are WashRoute-side concepts (order line
// items), invisible to Stripe -- Stripe only ever sees the already-net charge
// amount. Revenue categories above are posted at full list-price gross
// (matching the gross-revenue philosophy already used for fees/the Capital
// loan), with the credit/discount amount that was actually taken off backed
// out here as its own visible line, instead of silently shrinking whichever
// category the order landed in. Only one set of accounts exists in Xero today
// (named "...- Delivery" from when that was the only real revenue stream) --
// per David, all credits/discounts/refunds post here regardless of which
// revenue category the underlying order was, matching how the WashRoute Daily
// Revenue report already reports them as flat, uncategorized totals. Refunds
// post to the general "Refunds & Replacements" account (691) per David, not
// the Delivery-specific 347.
const CREDITS_ACCOUNT = { code: '345', name: 'Credits - Delivery' }
const DISCOUNTS_ACCOUNT = { code: '346', name: 'Coupons - Delivery' }
const REFUNDS_ACCOUNT = { code: '691', name: 'Refunds & Replacements' }

const NON_REVENUE_TYPES = new Set([
  'payout', 'payout_minimum_balance_hold', 'payout_minimum_balance_release',
  'stripe_fee', 'financing_paydown',
])

function emptyBucket() { return { gross: 0, fee: 0, net: 0, count: 0 } }
const dollars = (c: number) => Math.round(c) / 100


async function requireAdmin(req: Request) {
  const auth = req.headers.get('authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('Missing Authorization header')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) throw new Error('Invalid or expired session')
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
  if (!profile || !['admin', 'manager'].includes(profile.role)) throw new Error('Admin/manager role required')
  return user
}

async function classifyPayout(payout: any) {
  const btxns: any[] = []
  let startingAfter: string | undefined
  while (true) {
    const page = await stripe.balanceTransactions.list({
      payout: payout.id, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    btxns.push(...page.data)
    if (!page.has_more) break
    startingAfter = page.data[page.data.length - 1].id
  }

  const chargeCache = new Map<string, any>()
  async function getCharge(id: string) {
    if (chargeCache.has(id)) return chargeCache.get(id)
    const c = await stripe.charges.retrieve(id)
    chargeCache.set(id, c)
    return c
  }
  const orderCache = new Map<string, any>()
  async function getOrderByPI(pi: string) {
    if (orderCache.has(pi)) return orderCache.get(pi)
    const { data } = await supabase.from('orders').select('id, order_number, source, line_items').eq('stripe_payment_intent_id', pi).maybeSingle()
    orderCache.set(pi, data)
    return data
  }

  const buckets: Record<string, any> = {}
  for (const key of Object.keys(CATS)) buckets[key] = emptyBucket()
  buckets.unclassified = emptyBucket()
  const unclassifiedDetail: any[] = []

  const nonRevenue: Record<string, any> = {}
  for (const t of NON_REVENUE_TYPES) nonRevenue[t] = emptyBucket()

  // Session 202 additions: refunds get their own flat bucket (see comment on
  // REFUNDS_ACCOUNT above -- they no longer need to be traced back to a
  // revenue category at all), and credits/discounts are pulled straight out of
  // each order's own line_items since Stripe never sees them as separate
  // transactions.
  const refundsBucket = emptyBucket()
  let creditsTotalCents = 0
  let discountsTotalCents = 0
  const creditDiscountExamples: any[] = []

  for (const bt of btxns) {
    if (NON_REVENUE_TYPES.has(bt.type)) {
      nonRevenue[bt.type].gross += bt.amount; nonRevenue[bt.type].fee += bt.fee
      nonRevenue[bt.type].net += bt.net; nonRevenue[bt.type].count += 1
      continue
    }

    if (bt.type === 'refund' || bt.type === 'payment_refund') {
      // Flat bucket, not split by revenue category -- see REFUNDS_ACCOUNT comment.
      refundsBucket.gross += bt.amount; refundsBucket.fee += bt.fee
      refundsBucket.net += bt.net; refundsBucket.count += 1
      continue
    }

    if (!['charge', 'payment'].includes(bt.type)) {
      buckets.unclassified.gross += bt.amount; buckets.unclassified.fee += bt.fee
      buckets.unclassified.net += bt.net; buckets.unclassified.count += 1
      unclassifiedDetail.push({ id: bt.id, type: bt.type, amount: bt.amount, reason: `unhandled balance_transaction type '${bt.type}'` })
      continue
    }

    const charge = await getCharge(bt.source)

    let category = 'unclassified'
    let splitOverride: { cat: string; fraction: number }[] | null = null
    let order: any = null

    if (charge.invoice) {
      category = 'subscription'
    } else if (charge.description && charge.description.startsWith('Gift Up:')) {
      category = 'gift_card'
    } else if (charge.payment_intent) {
      order = await getOrderByPI(charge.payment_intent as string)
      if (order) {
        if (order.source === 'walk_in') {
          const items = Array.isArray(order.line_items) ? order.line_items : []
          let wfTotal = 0, vendTotal = 0
          items.forEach((li: any) => {
            const kind = (li?.kind || li?.type || '').toString()
            const amt = parseFloat(li?.amount ?? li?.subtotal ?? 0)
            if (kind === 'merchandise') vendTotal += amt; else wfTotal += amt
          })
          const total = wfTotal + vendTotal
          if (total > 0) {
            splitOverride = [
              { cat: 'retail_wf', fraction: wfTotal / total },
              { cat: 'retail_vend', fraction: vendTotal / total },
            ]
          } else {
            category = 'retail_wf'
            unclassifiedDetail.push({ id: bt.id, orderId: order.id, reason: 'POS order had no line_items to split, defaulted to Retail Wash & Fold' })
          }
        } else {
          category = 'delivery'
        }
      }
    }

    // Pull credit/discount amounts straight from the order's own line_items
    // (only orders have these -- native Stripe subscription-invoice charges
    // and Gift Up charges never resolve an `order` above, so they're skipped
    // automatically, which matches reality: neither has ever carried a
    // WashRoute credit/discount).
    let creditCents = 0, discountCents = 0
    if (order && Array.isArray(order.line_items)) {
      for (const li of order.line_items) {
        const t = li?.type
        const amt = Math.round(Math.abs(parseFloat(li?.amount ?? 0)) * 100)
        if (t === 'credit') creditCents += amt
        else if (t === 'discount') discountCents += amt
      }
      if (creditCents || discountCents) {
        creditDiscountExamples.push({ orderId: order.id, orderNumber: order.order_number, creditCents, discountCents })
      }
    }
    creditsTotalCents += creditCents
    discountsTotalCents += discountCents
    const grossUpCents = creditCents + discountCents

    if (splitOverride) {
      splitOverride.forEach(({ cat, fraction }) => {
        buckets[cat].gross += (bt.amount + grossUpCents) * fraction; buckets[cat].fee += bt.fee * fraction
        buckets[cat].net += bt.net * fraction; buckets[cat].count += fraction
      })
    } else {
      buckets[category].gross += bt.amount + grossUpCents; buckets[category].fee += bt.fee
      buckets[category].net += bt.net; buckets[category].count += 1
      if (category === 'unclassified') {
        unclassifiedDetail.push({
          id: bt.id, chargeId: charge.id, amount: bt.amount, description: charge.description,
          paymentIntent: charge.payment_intent,
          reason: charge.payment_intent ? 'no matching WashRoute order found' : 'no payment_intent, invoice, or Gift Up description',
        })
      }
    }
  }

  return {
    buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents,
    creditDiscountExamples, unclassifiedDetail, transactionCount: btxns.length,
  }
}

function buildPlan(payout: any, buckets: any, nonRevenue: any, refundsBucket: any, creditsTotalCents: number, discountsTotalCents: number) {
  const arrivalDate = new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
  const reserveNet = nonRevenue.payout_minimum_balance_hold.net + nonRevenue.payout_minimum_balance_release.net
  const safetyFailed = buckets.unclassified.count > 0 || Math.abs(reserveNet) > 1

  const lineItems: any[] = []
  for (const [key, cat] of Object.entries(CATS)) {
    const gross = dollars(buckets[key].gross)
    if (gross !== 0) lineItems.push({ Description: `${cat.name} — Stripe payout ${payout.id}`, Quantity: 1, UnitAmount: gross, AccountCode: cat.code, TaxType: 'NONE' })
  }

  const creditsAmt = dollars(creditsTotalCents)
  if (creditsAmt !== 0) lineItems.push({ Description: `Account credits applied — Stripe payout ${payout.id}`, Quantity: 1, UnitAmount: -Math.abs(creditsAmt), AccountCode: CREDITS_ACCOUNT.code, TaxType: 'NONE' })
  const discountsAmt = dollars(discountsTotalCents)
  if (discountsAmt !== 0) lineItems.push({ Description: `Discounts applied — Stripe payout ${payout.id}`, Quantity: 1, UnitAmount: -Math.abs(discountsAmt), AccountCode: DISCOUNTS_ACCOUNT.code, TaxType: 'NONE' })
  const refundsAmt = dollars(refundsBucket.gross) // Stripe's refund amount is already negative
  if (refundsAmt !== 0) lineItems.push({ Description: `Refunds — Stripe payout ${payout.id}`, Quantity: 1, UnitAmount: refundsAmt, AccountCode: REFUNDS_ACCOUNT.code, TaxType: 'NONE' })

  const perChargeFees = dollars(Object.keys(CATS).reduce((s, k) => s + buckets[k].fee, 0) + refundsBucket.fee)
  if (perChargeFees !== 0) lineItems.push({ Description: `Stripe processing fees (per-transaction) — payout ${payout.id}`, Quantity: 1, UnitAmount: -Math.abs(perChargeFees), AccountCode: '605', TaxType: 'NONE' })
  const acctFee = dollars(nonRevenue.stripe_fee.net)
  if (acctFee !== 0) lineItems.push({ Description: `Stripe account fees — payout ${payout.id}`, Quantity: 1, UnitAmount: -Math.abs(acctFee), AccountCode: '828', TaxType: 'NONE' })
  const loanPaydown = dollars(nonRevenue.financing_paydown.net)
  if (loanPaydown !== 0) lineItems.push({ Description: `Stripe Capital loan repayment — payout ${payout.id}`, Quantity: 1, UnitAmount: -Math.abs(loanPaydown), AccountCode: STRIPE_CAPITAL_ACCOUNT_CODE, TaxType: 'NONE' })

  const total = dollars(lineItems.reduce((s, li) => s + li.UnitAmount * 100, 0))
  const payoutDollars = dollars(payout.amount)
  const balances = Math.abs(total - payoutDollars) < 0.02

  const blockedReason = safetyFailed
    ? (buckets.unclassified.count > 0 ? `${buckets.unclassified.count} unclassified transactions need manual review` : `Reserve hold/release did not net to zero ($${dollars(reserveNet)}) — no Xero account mapped for this yet`)
    : (!balances ? `Line items sum to $${total}, expected $${payoutDollars}` : null)

  const bankTxnPayload = {
    BankTransactions: [{
      Type: 'RECEIVE',
      Contact: { ContactID: XERO_STRIPE_CONTACT_ID },
      BankAccount: { AccountID: XERO_BANK_ACCOUNT_ID },
      Date: arrivalDate,
      Reference: `Stripe payout ${payout.id}`,
      LineAmountTypes: 'NoTax',
      LineItems: lineItems,
    }],
  }

  return { lineItems, total, payoutDollars, arrivalDate, safetyFailed, balances, blockedReason, bankTxnPayload, loanPaydown }
}

// Session 205 cont.: Stripe Capital's loan_accounts row (added when the loan
// was onboarded onto the Loans dashboard, ingestion_method='automatic') never
// gets a statement pulled or a schedule ingested -- its balance/history is
// this function's own job to keep current. Every time a payout includes a
// financing_paydown, write a loan_statements snapshot (this period's resulting
// balance) + a loan_splits row (pure principal, $0 interest -- there's no
// reallocation needed since the paydown is already coded correctly) so the
// Paid Last Month/YTD tiles and the loan's own balance stay accurate with no
// manual backfill ever needed again. Best-effort: logs and swallows errors
// rather than failing the whole payout (the Xero posting above is what
// actually matters financially; this is bookkeeping metadata on top of it,
// recoverable via backfill if it ever misses).
async function recordStripeCapitalPaydown(payout: any, loanPaydown: number, arrivalDate: string, xeroBankTransactionId: string | undefined) {
  try {
    if (!loanPaydown) return

    // Stripe reports a financing_paydown as a NEGATIVE net (money withheld from the
    // balance). The Xero line item above launders that with -Math.abs(), which is why the
    // Xero ledger has always been correct -- but every write below used the raw value, so
    // `previous - (-437.75)` ADDED the repayment to the liability instead of subtracting
    // it, and stored the split as a negative. Between 2026-08-06 and 2026-08-19 that
    // overstated Stripe Capital by $11,720.59 and understated Paid-YTD by $12,240.80,
    // compounding at roughly twice each payout. Normalise once, here, and use the
    // normalised value for all three writes. Do NOT "simplify" by passing the raw value
    // through again -- the two paths need opposite signs and that is exactly the trap.
    const paydownAbs = Math.abs(loanPaydown)
    const { data: loanAcct } = await supabase
      .from('loan_accounts')
      .select('id')
      .eq('xero_account_code', STRIPE_CAPITAL_ACCOUNT_CODE)
      .maybeSingle()
    if (!loanAcct) {
      console.warn('[xero-payout-sync] no loan_accounts row for Stripe Capital (code 304) -- skipping paydown bookkeeping')
      return
    }

    // .lte(arrivalDate) is load-bearing: without it this takes the newest row overall, so
    // a payout processed out of order chains off a LATER row and its own delta is
    // orphaned. That really happened on 2026-08-07 (the 08-07 payout was processed at
    // 02:17 UTC, the 08-06 one at 04:32 UTC), which is why the stored balance drifted by
    // a different amount than the sign bug alone would explain.
    const { data: lastStmt } = await supabase
      .from('loan_statements')
      .select('principal_balance, statement_date')
      .eq('loan_account_id', loanAcct.id)
      .lte('statement_date', arrivalDate)
      .order('statement_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!lastStmt) {
      console.warn('[xero-payout-sync] Stripe Capital has no prior loan_statements row -- cannot derive new balance, skipping paydown bookkeeping')
      return
    }

    const newBalance = Math.round((Number(lastStmt.principal_balance) - paydownAbs) * 100) / 100

    // A repayment can only ever REDUCE this liability. If it doesn't, something about the
    // sign or the base row is wrong again -- refuse to write and shout, rather than
    // persist a number that will quietly compound. The original bug ran for thirteen days
    // precisely because nothing objected to a loan balance going up.
    if (!(newBalance < Number(lastStmt.principal_balance))) {
      console.error('[xero-payout-sync] REFUSING to write Stripe Capital paydown: new balance '
        + `${newBalance} is not below previous ${lastStmt.principal_balance} `
        + `(paydown ${paydownAbs}, raw ${loanPaydown}, base row ${lastStmt.statement_date}). `
        + 'Xero was still written correctly; only the bookkeeping snapshot was skipped.')
      return
    }

    const { data: newStmt, error: stmtErr } = await supabase
      .from('loan_statements')
      .insert({
        loan_account_id: loanAcct.id,
        statement_date: arrivalDate,
        principal_balance: newBalance,
        source: 'xero_balance_snapshot',
        pulled_by: 'xero-payout-sync (automatic)',
      })
      .select('id')
      .single()
    if (stmtErr || !newStmt) {
      console.error('[xero-payout-sync] failed to insert Stripe Capital loan_statements snapshot', stmtErr?.message)
      return
    }

    const { error: splitErr } = await supabase.from('loan_splits').insert({
      loan_account_id: loanAcct.id,
      period_label: arrivalDate,
      current_statement_id: newStmt.id,
      principal_amount: paydownAbs,
      interest_amount: 0,
      total_amount: paydownAbs,
      matched_xero_bank_transaction_id: xeroBankTransactionId ?? null,
      status: 'posted',
      source: 'statement_delta',
      xero_posted_at: new Date().toISOString(),
      xero_posted_by: 'xero-payout-sync (automatic)',
      review_notes: `Automatic repayment via Stripe payout ${payout.id} -- already fully and correctly coded in Xero, pure principal paydown with $0 interest (no reallocation needed).`,
    })
    if (splitErr) {
      // Most likely cause: two payouts landed on the same calendar day, tripping
      // the (loan_account_id, period_label) unique constraint -- rare, and not
      // worth failing the payout over. Logged for visibility; a future session
      // can decide whether same-day payouts need a disambiguated period_label.
      console.error('[xero-payout-sync] failed to insert Stripe Capital loan_splits row', splitErr.message)
    }
  } catch (err) {
    console.error('[xero-payout-sync] recordStripeCapitalPaydown threw', err)
  }
}

async function processPayout(payout: any, opts: { force?: boolean } = {}) {
  const { data: existing } = await supabase.from('xero_payout_syncs').select('*').eq('stripe_payout_id', payout.id).maybeSingle()
  if (existing?.status === 'posted' && !opts.force) {
    console.log(`[xero-payout-sync] ${payout.id} already posted, skipping`)
    return { skipped: true, reason: 'already posted', existing }
  }

  const { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents, unclassifiedDetail } = await classifyPayout(payout)
  const plan = buildPlan(payout, buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents)

  const { data: syncRow, error: upsertErr } = await supabase.from('xero_payout_syncs').upsert({
    stripe_payout_id: payout.id, payout_amount: plan.payoutDollars, payout_arrival_date: plan.arrivalDate, status: 'pending',
  }, { onConflict: 'stripe_payout_id' }).select().single()
  if (upsertErr) throw new Error(`Failed to claim sync row: ${upsertErr.message}`)

  if (plan.safetyFailed || !plan.balances) {
    await supabase.from('xero_payout_syncs').update({
      status: 'failed', error_message: plan.blockedReason,
      category_breakdown: { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents, unclassifiedDetail },
    }).eq('id', syncRow.id)
    console.error(`[xero-payout-sync] ${payout.id} blocked: ${plan.blockedReason}`)
    return { posted: false, blocked_reason: plan.blockedReason }
  }

  const { accessToken: token, tenantId } = await getXeroAuth()

  // ── SESSION 241: ASK XERO BEFORE POSTING. ALWAYS, INCLUDING UNDER force ──
  // The only idempotency check used to be `existing?.status === 'posted'` at the
  // top of this function -- our own row -- and `force=true` skipped it entirely.
  // Meanwhile the watchdog, on finding a row stranded on 'pending', declared the
  // payout "MISSING from Xero" WITHOUT asking Xero, and recommended force=true.
  // Those two facts compose into a full day's revenue posted twice, and the
  // stranding is real: the update at the end of this function never checked its
  // own error, so an isolate killed after the POST leaves 'pending' beside a live
  // BankTransaction.
  //
  // The idempotency key already exists -- buildPlan stamps every payout with
  // `Reference: Stripe payout <id>` -- so one GET settles it. force may override
  // OUR bookkeeping; it may never override what is actually in Xero.
  //
  // A failed lookup REFUSES, matching loan-xero-post's "refusing to stage blind":
  // not being able to see is not evidence of absence.
  const payoutRef = `Stripe payout ${payout.id}`
  const xeroHeaders = { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json' }
  let refJson: any = null
  try {
    const refRes = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(`Reference=="${payoutRef}"`)}`, { headers: xeroHeaders })
    if (!refRes.ok) throw new Error(`status ${refRes.status}`)
    refJson = await refRes.json()
  } catch (e) {
    const msg = `Could not check Xero for an existing "${payoutRef}" before posting (${String((e as Error)?.message || e)}) -- refusing to post blind.`
    await supabase.from('xero_payout_syncs').update({ status: 'failed', error_message: msg }).eq('id', syncRow.id)
    console.error(`[xero-payout-sync] ${payout.id} ${msg}`)
    return { posted: false, blocked_reason: msg }
  }
  const alreadyInXero = (refJson?.BankTransactions || []).find((t: any) =>
    String(t?.Status || '').toUpperCase() !== 'DELETED' && String(t?.Status || '').toUpperCase() !== 'VOIDED')
  if (alreadyInXero) {
    const id = alreadyInXero.BankTransactionID
    const msg = `Xero already holds a live transaction with reference "${payoutRef}" (${id}). This payout IS posted -- our row just did not say so. Nothing was posted a second time; the row has been repaired instead.`
    await supabase.from('xero_payout_syncs').update({
      status: 'posted', xero_bank_transaction_id: id, synced_at: new Date().toISOString(), error_message: msg,
    }).eq('id', syncRow.id)
    console.log(`[xero-payout-sync] ${payout.id} self-healed -> ${id}`)
    return { posted: false, skipped: true, reason: 'already in Xero', xero_bank_transaction_id: id, self_healed: true }
  }

  const postRes = await fetch('https://api.xero.com/api.xro/2.0/BankTransactions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(plan.bankTxnPayload),
  })
  const postJson = await postRes.json()

  if (!postRes.ok) {
    await supabase.from('xero_payout_syncs').update({ status: 'failed', error_message: JSON.stringify(postJson).slice(0, 2000), category_breakdown: { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents } }).eq('id', syncRow.id)
    console.error(`[xero-payout-sync] ${payout.id} Xero post failed`, postJson)
    return { posted: false, xero_error: postJson }
  }

  const createdTxnId = postJson?.BankTransactions?.[0]?.BankTransactionID
  // Session 241: this update's error was never read. When it failed (or the
  // isolate died right here) the row stayed 'pending' next to a live Xero
  // transaction -- which is exactly the state the watchdog then misread as
  // "MISSING from Xero". The pre-check above now makes that state recoverable,
  // but it still has to be SAID rather than swallowed.
  const { error: postedUpdErr } = await supabase.from('xero_payout_syncs').update({
    status: 'posted', xero_bank_transaction_id: createdTxnId, synced_at: new Date().toISOString(),
    category_breakdown: { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents },
  }).eq('id', syncRow.id)
  if (postedUpdErr) {
    console.error(`[xero-payout-sync] ${payout.id} XERO AHEAD OF US: posted ${createdTxnId} but row update failed: ${postedUpdErr.message}`)
    return {
      posted: true, xero_bank_transaction_id: createdTxnId, line_items: plan.lineItems, total: plan.total,
      xero_write_succeeded: true, db_error: postedUpdErr.message,
      warning: `The payout WAS posted to Xero (${createdTxnId}) but our row could not be updated: ${postedUpdErr.message}. Xero is ahead of our records. Do NOT re-run with force -- the pre-check will now find it and repair the row.`,
    }
  }
  console.log(`[xero-payout-sync] ${payout.id} posted -> ${createdTxnId}`)

  if (plan.loanPaydown) {
    await recordStripeCapitalPaydown(payout, plan.loanPaydown, plan.arrivalDate, createdTxnId)
  }

  return { posted: true, xero_bank_transaction_id: createdTxnId, line_items: plan.lineItems, total: plan.total }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const sig = req.headers.get('stripe-signature')
  if (sig) {
    // Real Stripe webhook call — authenticated via signature, not a Supabase JWT.
    const body = await req.text()
    const webhookSecret = Deno.env.get('STRIPE_PAYOUT_WEBHOOK_SECRET')
    if (!webhookSecret) return new Response('Webhook secret not configured', { status: 500 })
    let event
    try {
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret, undefined, cryptoProvider)
    } catch (err) {
      console.error('[xero-payout-sync] signature verification failed', err)
      return new Response(`Webhook signature verification failed: ${(err as any).message}`, { status: 400 })
    }

    if (event.type === 'payout.paid') {
      const payout = event.data.object
      // Ack Stripe immediately; do the ~100+ API call classification/posting in the background
      // so Stripe doesn't time out and retry into a duplicate attempt.
      // deno-lint-ignore no-explicit-any
      const bg = (globalThis as any).EdgeRuntime?.waitUntil
      const task = processPayout(payout).catch((e) => console.error('[xero-payout-sync] background processing error', e))
      if (bg) bg(task)
    }
    return new Response(JSON.stringify({ received: true }), { headers: { ...cors, 'Content-Type': 'application/json' } })
  }

  // Manual / testing path — requires an authenticated admin or manager session,
  // since verify_jwt is off at the gateway (Stripe's calls can't carry a Supabase JWT).
  try {
    await requireAdmin(req)

    const url = new URL(req.url)
    const payoutIdParam = url.searchParams.get('payout_id')
    const dryRun = url.searchParams.get('dry_run') === 'true'
    const force = url.searchParams.get('force') === 'true'

    let payout
    if (payoutIdParam) payout = await stripe.payouts.retrieve(payoutIdParam)
    else {
      const list = await stripe.payouts.list({ limit: 1, status: 'paid' })
      payout = list.data[0]
      if (!payout) throw new Error('No paid payouts found on this Stripe account')
    }

    if (dryRun) {
      const { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents, creditDiscountExamples, unclassifiedDetail, transactionCount } = await classifyPayout(payout)
      const plan = buildPlan(payout, buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents)
      return new Response(JSON.stringify({
        would_post: !plan.safetyFailed && plan.balances,
        blocked_reason: plan.blockedReason,
        payout: { id: payout.id, amount: plan.payoutDollars, arrival_date: plan.arrivalDate },
        line_items_total: plan.total,
        bank_transaction_payload: plan.bankTxnPayload,
        credits_total: dollars(creditsTotalCents),
        discounts_total: dollars(discountsTotalCents),
        refunds_total: dollars(refundsBucket.gross),
        credit_discount_examples: creditDiscountExamples,
        unclassified_detail: unclassifiedDetail,
        transaction_count: transactionCount,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const result = await processPayout(payout, { force })
    return new Response(JSON.stringify(result, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
