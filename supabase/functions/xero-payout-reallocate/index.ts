import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Retroactively fixes a Stripe payout that was already posted to Xero as a single
// lumped line (e.g. every July 2026 payout, posted before the categorized
// pipeline in xero-payout-sync existed) -- WITHOUT touching the original bank
// transaction, which is typically already reconciled by the time this runs and
// which Xero flatly refuses to let anyone edit once reconciled (confirmed live,
// session 205, on both the loan payments and these payouts).
//
// Uses the exact same classification logic as xero-payout-sync (classifyPayout/
// buildPlan, duplicated here rather than shared -- there's no module-sharing
// setup across these edge functions -- keep the two in sync if either changes)
// to compute what SHOULD have been posted, then builds a correcting Manual
// Journal: every category that should have gone somewhere other than the
// original lumped account gets moved there, offset by a single line on the
// original account for the net difference. The original bank transaction's own
// line items are never touched.
//
// ⚠️ SIGN CONVENTION (session 205 bug, fixed): plan.lineItems/UnitAmount values
// come from buildPlan(), which was written for BankTransaction LineItems, where
// sign just means "add to" or "subtract from" the transaction total -- there's
// no debit/credit concept there. A ManualJournal's LineAmount is NOT that --
// positive = debit, negative = credit, full stop. The first version of this
// function copied UnitAmount straight into LineAmount, which is backwards for
// EVERY line: revenue accounts (405/401/404/403) need to be CREDITED (negative)
// to increase, but got debited (positive); cost/fee accounts (345/346/605/828/691)
// need to be DEBITED (positive) to increase, but got credited (negative).
// Confirmed live against 1 posted journal + the Chart of Accounts Type/Class for
// every touched code -- the fix is a straight sign flip on every line, which is
// what buildJournalLines() below does. See PROJECT-NOTES.md session 205 for the
// full writeup and the 22-journal void-and-repost correction this necessitated.
//
// 📝 NARRATION CONVENTION (session 205 cont.): keep it minimal -- payout id,
// arrival date, and the original bank transaction id are enough for anyone to
// trace this journal back to its source. No prose, no correction-history
// annotations (that history lives in PROJECT-NOTES.md, not in every future
// journal narration). Mirrors the loan-correction-journal convention.
//
// Body: { payout_id: string, confirm?: boolean }
// Default is a dry run: returns the matched original transaction and the
// proposed correcting journal without posting.

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
})
const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(supabaseUrl, supabaseServiceKey)

const XERO_BANK_ACCOUNT_ID = '8fd57c83-6519-442b-a34f-26adb9343429'
const LUMPED_ACCOUNT_CODE = '403' // every pre-pipeline payout was posted in full to this account

const CATS: Record<string, { code: string; name: string }> = {
  subscription: { code: '405', name: 'Delivery - Subscription Fees' },
  delivery:     { code: '403', name: 'Delivery - Wash & Fold' },
  retail_wf:    { code: '404', name: 'Retail - Wash & Fold' },
  retail_vend:  { code: '401', name: 'Retail - Vending' },
  gift_card:    { code: '461', name: 'Delivery - Gift card sales' },
}
const CREDITS_ACCOUNT = { code: '345', name: 'Credits - Delivery' }
const DISCOUNTS_ACCOUNT = { code: '346', name: 'Coupons - Delivery' }
const REFUNDS_ACCOUNT = { code: '691', name: 'Refunds & Replacements' }
const NON_REVENUE_TYPES = new Set(['payout', 'payout_minimum_balance_hold', 'payout_minimum_balance_release', 'stripe_fee', 'financing_paydown'])

function emptyBucket() { return { gross: 0, fee: 0, net: 0, count: 0 } }
const dollars = (c: number) => Math.round(c) / 100

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

// --- classifyPayout / buildPlan: duplicated from xero-payout-sync (see header note) ---
async function classifyPayout(payout: any) {
  const btxns: any[] = []
  let startingAfter: string | undefined
  while (true) {
    const page = await stripe.balanceTransactions.list({ payout: payout.id, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) })
    btxns.push(...page.data)
    if (!page.has_more) break
    startingAfter = page.data[page.data.length - 1].id
  }
  const chargeCache = new Map<string, any>()
  async function getCharge(id: string) { if (chargeCache.has(id)) return chargeCache.get(id); const c = await stripe.charges.retrieve(id); chargeCache.set(id, c); return c }
  const orderCache = new Map<string, any>()
  async function getOrderByPI(pi: string) { if (orderCache.has(pi)) return orderCache.get(pi); const { data } = await supabase.from('orders').select('id, order_number, source, line_items').eq('stripe_payment_intent_id', pi).maybeSingle(); orderCache.set(pi, data); return data }

  const buckets: Record<string, any> = {}
  for (const key of Object.keys(CATS)) buckets[key] = emptyBucket()
  buckets.unclassified = emptyBucket()
  const unclassifiedDetail: any[] = []
  const nonRevenue: Record<string, any> = {}
  for (const t of NON_REVENUE_TYPES) nonRevenue[t] = emptyBucket()
  const refundsBucket = emptyBucket()
  let creditsTotalCents = 0
  let discountsTotalCents = 0
  const creditDiscountExamples: any[] = []

  for (const bt of btxns) {
    if (NON_REVENUE_TYPES.has(bt.type)) { nonRevenue[bt.type].gross += bt.amount; nonRevenue[bt.type].fee += bt.fee; nonRevenue[bt.type].net += bt.net; nonRevenue[bt.type].count += 1; continue }
    if (bt.type === 'refund' || bt.type === 'payment_refund') { refundsBucket.gross += bt.amount; refundsBucket.fee += bt.fee; refundsBucket.net += bt.net; refundsBucket.count += 1; continue }
    if (!['charge', 'payment'].includes(bt.type)) { buckets.unclassified.gross += bt.amount; buckets.unclassified.fee += bt.fee; buckets.unclassified.net += bt.net; buckets.unclassified.count += 1; unclassifiedDetail.push({ id: bt.id, type: bt.type, amount: bt.amount, reason: `unhandled balance_transaction type '${bt.type}'` }); continue }

    const charge = await getCharge(bt.source)
    let category = 'unclassified'
    let splitOverride: { cat: string; fraction: number }[] | null = null
    let order: any = null

    if (charge.invoice) category = 'subscription'
    else if (charge.description && charge.description.startsWith('Gift Up:')) category = 'gift_card'
    else if (charge.payment_intent) {
      order = await getOrderByPI(charge.payment_intent as string)
      if (order) {
        if (order.source === 'walk_in') {
          const items = Array.isArray(order.line_items) ? order.line_items : []
          let wfTotal = 0, vendTotal = 0
          items.forEach((li: any) => { const kind = (li?.kind || li?.type || '').toString(); const amt = parseFloat(li?.amount ?? li?.subtotal ?? 0); if (kind === 'merchandise') vendTotal += amt; else wfTotal += amt })
          const total = wfTotal + vendTotal
          if (total > 0) splitOverride = [{ cat: 'retail_wf', fraction: wfTotal / total }, { cat: 'retail_vend', fraction: vendTotal / total }]
          else { category = 'retail_wf'; unclassifiedDetail.push({ id: bt.id, orderId: order.id, reason: 'POS order had no line_items to split, defaulted to Retail Wash & Fold' }) }
        } else category = 'delivery'
      }
    }

    let creditCents = 0, discountCents = 0
    if (order && Array.isArray(order.line_items)) {
      for (const li of order.line_items) {
        const t = li?.type
        const amt = Math.round(Math.abs(parseFloat(li?.amount ?? 0)) * 100)
        if (t === 'credit') creditCents += amt; else if (t === 'discount') discountCents += amt
      }
      if (creditCents || discountCents) creditDiscountExamples.push({ orderId: order.id, orderNumber: order.order_number, creditCents, discountCents })
    }
    creditsTotalCents += creditCents
    discountsTotalCents += discountCents
    const grossUpCents = creditCents + discountCents

    if (splitOverride) {
      splitOverride.forEach(({ cat, fraction }) => { buckets[cat].gross += (bt.amount + grossUpCents) * fraction; buckets[cat].fee += bt.fee * fraction; buckets[cat].net += bt.net * fraction; buckets[cat].count += fraction })
    } else {
      buckets[category].gross += bt.amount + grossUpCents; buckets[category].fee += bt.fee; buckets[category].net += bt.net; buckets[category].count += 1
      if (category === 'unclassified') unclassifiedDetail.push({ id: bt.id, chargeId: charge.id, amount: bt.amount, description: charge.description, paymentIntent: charge.payment_intent, reason: charge.payment_intent ? 'no matching WashRoute order found' : 'no payment_intent, invoice, or Gift Up description' })
    }
  }
  return { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents, creditDiscountExamples, unclassifiedDetail, transactionCount: btxns.length }
}

function buildPlan(payout: any, buckets: any, nonRevenue: any, refundsBucket: any, creditsTotalCents: number, discountsTotalCents: number) {
  const arrivalDate = new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
  const reserveNet = nonRevenue.payout_minimum_balance_hold.net + nonRevenue.payout_minimum_balance_release.net
  const safetyFailed = buckets.unclassified.count > 0 || Math.abs(reserveNet) > 1

  const lineItems: any[] = []
  for (const [key, cat] of Object.entries(CATS)) { const gross = dollars(buckets[key].gross); if (gross !== 0) lineItems.push({ Description: `${cat.name} — Stripe payout ${payout.id}`, UnitAmount: gross, AccountCode: cat.code }) }
  const creditsAmt = dollars(creditsTotalCents); if (creditsAmt !== 0) lineItems.push({ Description: `Account credits applied — Stripe payout ${payout.id}`, UnitAmount: -Math.abs(creditsAmt), AccountCode: CREDITS_ACCOUNT.code })
  const discountsAmt = dollars(discountsTotalCents); if (discountsAmt !== 0) lineItems.push({ Description: `Discounts applied — Stripe payout ${payout.id}`, UnitAmount: -Math.abs(discountsAmt), AccountCode: DISCOUNTS_ACCOUNT.code })
  const refundsAmt = dollars(refundsBucket.gross); if (refundsAmt !== 0) lineItems.push({ Description: `Refunds — Stripe payout ${payout.id}`, UnitAmount: refundsAmt, AccountCode: REFUNDS_ACCOUNT.code })
  const perChargeFees = dollars(Object.keys(CATS).reduce((s, k) => s + buckets[k].fee, 0) + refundsBucket.fee); if (perChargeFees !== 0) lineItems.push({ Description: `Stripe processing fees (per-transaction) — payout ${payout.id}`, UnitAmount: -Math.abs(perChargeFees), AccountCode: '605' })
  const acctFee = dollars(nonRevenue.stripe_fee.net); if (acctFee !== 0) lineItems.push({ Description: `Stripe account fees — payout ${payout.id}`, UnitAmount: -Math.abs(acctFee), AccountCode: '828' })
  const loanPaydown = dollars(nonRevenue.financing_paydown.net); if (loanPaydown !== 0) lineItems.push({ Description: `Stripe Capital loan repayment — payout ${payout.id}`, UnitAmount: -Math.abs(loanPaydown), AccountCode: '304' })

  const total = dollars(lineItems.reduce((s, li) => s + li.UnitAmount * 100, 0))
  const payoutDollars = dollars(payout.amount)
  const balances = Math.abs(total - payoutDollars) < 0.02
  const blockedReason = safetyFailed
    ? (buckets.unclassified.count > 0 ? `${buckets.unclassified.count} unclassified transactions need manual review` : `Reserve hold/release did not net to zero ($${dollars(reserveNet)}) — no Xero account mapped for this yet`)
    : (!balances ? `Line items sum to $${total}, expected $${payoutDollars}` : null)

  return { lineItems, total, payoutDollars, arrivalDate, safetyFailed, balances, blockedReason }
}
// --- end duplicated logic ---

// Converts plan.lineItems (BankTransaction-style "add/subtract from total" sign
// convention) into proper ManualJournal debit/credit lines. Revenue accounts
// (everything in CATS) must be CREDITED (negative) to increase; cost/fee/contra
// accounts (credits, discounts, refunds, stripe fees, loan paydown) must be
// DEBITED (positive) to increase. plan.lineItems already encodes revenue as
// positive and costs as negative in the OPPOSITE sense (BankTransaction-total
// sense, not debit/credit sense) -- so the correct journal LineAmount for every
// one of them is simply the negation of li.UnitAmount. The offset line back onto
// the lumped account follows the same rule: it must equal the negation of the
// sum of the other (already-negated) lines so the journal still balances to zero.
function buildJournalLines(lineItems: any[]) {
  const nonLumpedLines = lineItems.filter(li => li.AccountCode !== LUMPED_ACCOUNT_CODE)
  const journalNonLumped = nonLumpedLines.map(li => ({ LineAmount: -li.UnitAmount, AccountCode: li.AccountCode, Description: li.Description, TaxType: 'NONE' }))
  const offsetAmount = -Math.round(journalNonLumped.reduce((s, l) => s + l.LineAmount * 100, 0)) / 100
  return [
    ...journalNonLumped,
    { LineAmount: offsetAmount, AccountCode: LUMPED_ACCOUNT_CODE, Description: `Reallocation offset — moves the above out of Delivery — Stripe payout`, TaxType: 'NONE' },
  ]
}

Deno.serve(async (req) => {
  try {
    await requireAdmin(req)
    const { payout_id, confirm } = await req.json()
    if (!payout_id) return new Response(JSON.stringify({ error: 'payout_id is required' }), { status: 400 })

    const payout = await stripe.payouts.retrieve(payout_id)
    const { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents, unclassifiedDetail, transactionCount } = await classifyPayout(payout)
    const plan = buildPlan(payout, buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents)

    if (plan.safetyFailed || !plan.balances) {
      return new Response(JSON.stringify({ error: 'blocked', blocked_reason: plan.blockedReason, unclassified_detail: unclassifiedDetail, transaction_count: transactionCount }), { status: 422 })
    }

    // Find the existing (untouched) bank transaction for this payout
    const token = await getXeroToken()
    const tenantId = Deno.env.get('XERO_TENANT_ID')!
    const headers = { 'Authorization': `Bearer ${token}`, 'Xero-tenant-id': tenantId, 'Accept': 'application/json' }
    const arrival = new Date(payout.arrival_date * 1000)
    const from = new Date(arrival); from.setDate(from.getDate() - 2)
    const to = new Date(arrival); to.setDate(to.getDate() + 2)
    const fmt = (d: Date) => `${d.getFullYear()},${d.getMonth() + 1},${d.getDate()}`
    const whereClause = `Date >= DateTime(${fmt(from)}) && Date <= DateTime(${fmt(to)})`
    const r1 = await fetch(`https://api.xero.com/api.xro/2.0/BankTransactions?where=${encodeURIComponent(whereClause)}&order=Date DESC`, { headers })
    const list = r1.ok ? ((await r1.json()).BankTransactions || []) : []
    const target = plan.payoutDollars
    // ── SESSION 266 FIX 1: a DELETED transaction is not a candidate ───────────
    // Xero keeps deleted bank transactions in the API response with
    // Status: 'DELETED'. They have no effect on the ledger, but they still match
    // on date, amount and bank account -- so a single deleted duplicate makes this
    // function see TWO candidates and refuse forever. That is exactly the state
    // this book was in on 2026-09-03 after a double-post was removed: the live
    // deposit and its deleted twin, both $10,630.05 on 22 July.
    //
    // Filtering by status is not a loosening of the "exactly 1" rule -- it is what
    // makes that rule mean "exactly one transaction that actually affects the
    // books". Anything not AUTHORISED is excluded, so an unexpected status fails
    // safe by being ignored rather than silently accepted.
    const LIVE_STATUSES = new Set(['AUTHORISED'])
    const allMatches = list.filter((t: any) => t.BankAccount?.AccountID?.toLowerCase() === XERO_BANK_ACCOUNT_ID.toLowerCase() && Math.abs(Number(t.Total) - target) < 0.02)
    const candidates = allMatches.filter((t: any) => LIVE_STATUSES.has(String(t.Status || '').toUpperCase()))
    const excluded = allMatches.filter((t: any) => !LIVE_STATUSES.has(String(t.Status || '').toUpperCase()))
    if (candidates.length !== 1) {
      return new Response(JSON.stringify({
        error: `expected exactly 1 live (AUTHORISED) bank transaction near ${plan.arrivalDate} for $${target}, found ${candidates.length}`,
        candidates: candidates.map((c: any) => ({ id: c.BankTransactionID, date: c.DateString, total: c.Total, reference: c.Reference, status: c.Status })),
        // Named, not hidden. A reader who sees "found 0" needs to know a deleted
        // twin exists, or they will go looking for a transaction that is right there.
        excluded_non_live: excluded.map((c: any) => ({ id: c.BankTransactionID, status: c.Status, reference: c.Reference })),
      }), { status: 409 })
    }
    const original = candidates[0]

    // ── SESSION 266 FIX 2: refuse a transaction THIS PIPELINE created ─────────
    // A reallocation journal assumes the bank transaction codes the whole payout
    // to 403, which is what the bank feed does. A transaction carrying our own
    // Reference was created by xero-payout-sync and is ALREADY split across every
    // account -- reallocating it would move money a second time.
    const ourReference = `Stripe payout ${payout.id}`
    if (String(original.Reference || '').trim() === ourReference) {
      return new Response(JSON.stringify({
        error: 'refusing to reallocate: the matched bank transaction was created by xero-payout-sync and is already split across accounts. A reallocation journal would double-count it. This payout does not need reallocating.',
        bank_transaction: { id: original.BankTransactionID, reference: original.Reference, status: original.Status },
      }), { status: 409 })
    }

    // ── SESSION 266 FIX 3: never post a second journal for the same payout ────
    // The original version upserted status='posted' with a fresh
    // xero_manual_journal_id and no guard whatsoever, so a re-run silently created
    // a duplicate journal and orphaned the first one -- our row would name the new
    // journal while the old one stayed live in Xero, doubling the correction.
    //
    // XERO IS THE AUTHORITY HERE, NOT OUR ROW. A row can be missing or wrong
    // (session 241 put a full day of revenue in twice by trusting one), so this
    // asks Xero directly: any live journal in the window whose Narration names
    // this payout means the work is already done.
    const jFrom = new Date(arrival); jFrom.setDate(jFrom.getDate() - 5)
    const jTo = new Date(arrival); jTo.setDate(jTo.getDate() + 5)
    const jWhere = `Date >= DateTime(${fmt(jFrom)}) && Date <= DateTime(${fmt(jTo)})`
    const rj = await fetch(`https://api.xero.com/api.xro/2.0/ManualJournals?where=${encodeURIComponent(jWhere)}`, { headers })
    if (!rj.ok) {
      // Cannot answer "is it already done?" -> refuse rather than post blind. Same
      // stance xero-payout-sync takes when its own pre-check cannot reach Xero.
      return new Response(JSON.stringify({ error: `could not check Xero for an existing reallocation journal (${rj.status}) -- refusing to post blind` }), { status: 502 })
    }
    const existingJournals = ((await rj.json()).ManualJournals || []).filter((j: any) =>
      String(j.Status || '').toUpperCase() === 'POSTED' && String(j.Narration || '').includes(payout.id))
    if (existingJournals.length) {
      return new Response(JSON.stringify({
        error: 'a reallocation journal for this payout already exists in Xero -- nothing posted',
        existing_journals: existingJournals.map((j: any) => ({ id: j.ManualJournalID, date: j.DateString, narration: j.Narration })),
      }), { status: 409 })
    }

    // Build the correction journal (see buildJournalLines header comment for the
    // debit/credit sign reasoning -- this replaces the session-205-bug version).
    const journalLines = buildJournalLines(plan.lineItems)

    const journalPayload = {
      ManualJournals: [{
        Narration: `Stripe payout ${payout.id} (${plan.arrivalDate}) — category reallocation. Orig BankTxn ${original.BankTransactionID}.`,
        Date: plan.arrivalDate,
        Status: 'POSTED',
        JournalLines: journalLines,
      }],
    }

    if (!confirm) {
      return new Response(JSON.stringify({
        dry_run: true,
        payout: { id: payout.id, amount: plan.payoutDollars, arrival_date: plan.arrivalDate },
        original_bank_transaction: { id: original.BankTransactionID, date: original.DateString, total: original.Total, reconciled: original.IsReconciled },
        computed_correct_breakdown: plan.lineItems,
        proposed_journal: journalPayload.ManualJournals[0],
      }, null, 2), { headers: { 'Content-Type': 'application/json' } })
    }

    const postRes = await fetch('https://api.xero.com/api.xro/2.0/ManualJournals', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(journalPayload),
    })
    const postJson = await postRes.json().catch(() => null)
    if (!postRes.ok || postJson?.Elements?.[0]?.ValidationErrors?.length) {
      return new Response(JSON.stringify({ error: 'Xero journal post failed', status: postRes.status, details: postJson }), { status: 502 })
    }
    const journal = postJson.ManualJournals?.[0]

    await supabase.from('xero_payout_syncs').upsert({
      stripe_payout_id: payout.id,
      payout_amount: plan.payoutDollars,
      payout_arrival_date: plan.arrivalDate,
      status: 'posted',
      method: 'reallocation_journal',
      xero_bank_transaction_id: original.BankTransactionID,
      xero_manual_journal_id: journal?.ManualJournalID ?? null,
      synced_at: new Date().toISOString(),
      category_breakdown: { buckets, nonRevenue, refundsBucket, creditsTotalCents, discountsTotalCents },
    }, { onConflict: 'stripe_payout_id' })

    return new Response(JSON.stringify({
      ok: true,
      original_bank_transaction: { id: original.BankTransactionID, note: 'left untouched, not edited' },
      manual_journal: { id: journal?.ManualJournalID, lines: journal?.JournalLines },
    }, null, 2), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as any)?.message || err) }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
