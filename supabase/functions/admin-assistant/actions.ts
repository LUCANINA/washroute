// admin-assistant / actions.ts — Phase 2 (session 318b): changes that wait for a Confirm click.
//
// Claude never changes anything directly. A propose_* tool validates the request,
// builds a before → after preview, and stores it in public.assistant_actions as
// 'pending'. The staff member sees a card with Confirm / Cancel. Only the Confirm
// call (a separate request from the same staff member) runs the change — through
// the same RPCs the admin buttons use, AS THAT STAFF MEMBER (their JWT), so every
// existing permission check, ledger write and order-history entry still applies.
//
// Rules baked in here (David, session 318):
//   • Credit changes: max $25 per change, through adjust_customer_credits (ledger).
//   • Customer texts: only reschedules can text, and only if staff tick the box
//     on the card (default OFF). Skips/cancels never text (the RPC has no template
//     for them and we pass p_notify_sms=false exactly like the admin Skip button).
//   • Skip/cancel only while the order is still 'scheduled' (before pickup).
//   • Bag-count / price edits are NOT offered — pricing logic lives in Edit Order.
//
// Session 318c — Undo: a confirmed reschedule / skip-cancel / credit / instructions
// change can be reversed for 7 days. The undo is itself a pending action (type
// 'undo') that needs its own Confirm, and it refuses if the thing was changed again
// since (it never overwrites someone else's later edit).

// deno-lint-ignore no-explicit-any
type Db = any
export type Caller = { id: string; name: string; role: string; jwt: string }
export type Ctx = { svc: Db; user: Db; caller: Caller; conversationId: string }
export type Proposal = {
  id: string; action_type: string; summary: string; can_notify: boolean
  preview: { lines: { label: string; before?: string | null; after: string }[]; warnings: string[] }
}

export const CREDIT_CAP = 25
const BIZ_TZ = 'America/Los_Angeles'
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: BIZ_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: BIZ_TZ, hour: 'numeric', minute: '2-digit' })
const money = (n: number) => '$' + (Math.round(n * 100) / 100).toFixed(2)
function range(start?: string | null, end?: string | null): string {
  if (!start) return 'not scheduled'
  const s = new Date(start)
  return end ? `${fmt.format(s)} – ${fmtTime.format(new Date(end))}` : fmt.format(s)
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
function orderNum(v: unknown): number {
  const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10)
  if (!Number.isFinite(n)) throw new Error('order_number must be a number like 15542')
  return n
}
function custName(c?: { first_name_cache?: string; last_name_cache?: string } | null) {
  return [c?.first_name_cache, c?.last_name_cache].filter(Boolean).join(' ').trim() || 'customer'
}
async function loadOrder(svc: Db, n: number) {
  const { data, error } = await svc.from('orders')
    .select('id, order_number, customer_id, status, recurring_interval, special_instructions, pickup_window_start, pickup_window_end, delivery_window_start, delivery_window_end, pickup_run_id, delivery_run_id, customers(first_name_cache, last_name_cache)')
    .eq('order_number', n).maybeSingle()
  if (error) throw new Error('order lookup: ' + error.message)
  if (!data) throw new Error(`No order #${n}`)
  return data
}
const actor = (c: Caller) => `${c.name} (via Claude)`

// ── New customer helpers (session 318d) ─────────────────────────────────────
// Same choices as Customers → New Customer ("How did they find us?").
const REFERRAL_SOURCES = ['nextdoor', 'yelp', 'google', 'friend_family', 'instagram', 'roots_soul', 'oakland_ballers', 'saw_van', 'other', 'ai', 'ambassador']
const digits10 = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
const fmtPhone = (d: string) => d ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Other accounts already using this email or phone. Staff inserts skip the
// duplicate-signup trigger, so this is the only check on this path.
async function contactMatches(svc: Db, email: string, phone10: string) {
  // deno-lint-ignore no-explicit-any
  const hits: any[] = []
  if (email) {
    const { data, error } = await svc.from('customers').select('id, first_name_cache, last_name_cache, billing_group_id, email_cache, phone_cache')
      .ilike('email_cache', email.replace(/[%_\\]/g, '\\$&')).limit(5)
    if (error) throw new Error('email check: ' + error.message)
    for (const c of data || []) if ((c.email_cache || '').trim().toLowerCase() === email) hits.push({ ...c, matched: 'email' })
  }
  if (phone10) {
    const { data, error } = await svc.from('customers').select('id, first_name_cache, last_name_cache, billing_group_id, email_cache, phone_cache')
      .ilike('phone_cache', `%${phone10.slice(-4)}%`).limit(300)
    if (error) throw new Error('phone check: ' + error.message)
    for (const c of data || []) if (digits10(c.phone_cache) === phone10 && !hits.some(h => h.id === c.id)) hits.push({ ...c, matched: 'phone' })
  }
  return hits
}

type Geo = { lat: number | null; lng: number | null; formatted: string; city: string; state: string; zip: string; verified: boolean; note?: string }
async function geocode(line1: string, city: string, state: string, zip: string): Promise<Geo> {
  const q = [line1, city, state, zip].filter(Boolean).join(', ')
  const key = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? ''
  const fallback = (note: string): Geo => ({ lat: null, lng: null, formatted: q, city, state, zip, verified: false, note })
  if (!key) return fallback('address lookup is not configured')
  let j: { status?: string; results?: any[]; error_message?: string }  // deno-lint-ignore no-explicit-any
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:US&key=${key}`)
    j = await res.json()
  } catch (e) { return fallback('Google could not be reached') }
  if (j.status === 'ZERO_RESULTS') throw new Error(`Google can't find "${q}". Check the street and ZIP.`)
  if (j.status !== 'OK' || !j.results?.length) return fallback(`Google lookup failed (${j.status})`)
  const r0 = j.results[0]
  // deno-lint-ignore no-explicit-any
  const comp = (t: string, short = false) => (r0.address_components || []).find((c: any) => (c.types || []).includes(t))?.[short ? 'short_name' : 'long_name'] || ''
  if (!comp('street_number')) throw new Error(`Google only found an area, not a street address, for "${q}". Check the house number.`)
  return {
    lat: r0.geometry?.location?.lat ?? null, lng: r0.geometry?.location?.lng ?? null,
    formatted: r0.formatted_address || q,
    city: comp('locality') || comp('sublocality') || comp('neighborhood') || city,
    state: comp('administrative_area_level_1', true) || state,
    zip: comp('postal_code') || zip,
    verified: true,
    note: r0.partial_match ? 'Google only partly matched this address — double-check it' : undefined,
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const NOTE = 'This only PROPOSES the change: it shows the staff member a card with Confirm / Cancel. Nothing happens until they click Confirm.'
export const ACTION_TOOLS = [
  {
    name: 'propose_reschedule',
    description: `Move an order's pickup or delivery to another day and window (AM, PM or evening). Pickups can only move while the order is scheduled. ${NOTE} Staff choose on the card whether the customer gets the usual reschedule text.`,
    input_schema: {
      type: 'object',
      properties: {
        order_number: { type: 'integer' },
        leg: { type: 'string', enum: ['pickup', 'delivery'] },
        new_date: { type: 'string', description: 'YYYY-MM-DD (Pacific)' },
        window: { type: 'string', enum: ['AM', 'PM', 'evening'] },
      },
      required: ['order_number', 'leg', 'new_date', 'window'],
    },
  },
  {
    name: 'propose_skip_or_cancel',
    description: `Stop an order that hasn't been picked up yet (status scheduled). Recurring orders are SKIPPED (the next one is created automatically); one-off orders are CANCELLED. The customer is not texted. ${NOTE}`,
    input_schema: {
      type: 'object',
      properties: { order_number: { type: 'integer' }, reason: { type: 'string', description: 'Why, in a few words — saved to the order history' } },
      required: ['order_number', 'reason'],
    },
  },
  {
    name: 'propose_credit',
    description: `Add or remove account credit for a customer. Limit: $${CREDIT_CAP} per customer per 24 hours through this assistant. If the staff member asks for more than that, do NOT propose a partial amount or split it up — tell them the whole credit must be done by hand in Customers → Credits. Goes through the credit ledger so it shows in Billing History. ${NOTE}`,
    input_schema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        direction: { type: 'string', enum: ['add', 'remove'] },
        amount: { type: 'number', description: 'Dollars, e.g. 9.95' },
        reason: { type: 'string', description: 'Why — saved on the ledger entry' },
        order_number: { type: 'integer', description: 'Optional: the order this relates to' },
      },
      required: ['customer_id', 'direction', 'amount', 'reason'],
    },
  },
  {
    name: 'propose_instructions_update',
    description: `Replace an order's laundry instructions / notes (the special instructions the plant sees). Only before processing starts (scheduled or picked_up). ${NOTE}`,
    input_schema: {
      type: 'object',
      properties: { order_number: { type: 'integer' }, new_instructions: { type: 'string', description: 'The full new text (empty string clears it)' } },
      required: ['order_number', 'new_instructions'],
    },
  },
  {
    name: 'propose_create_customer',
    description: `Create a NEW customer account (residential or business). Before proposing, search with find_customers — if the person or business already has an account, use that one instead. The tool itself refuses when the email or phone is already on another account (unless that account is in the same billing group, e.g. another Kidango site), and it checks the address with Google. Required: first name (for a business, the business or site name), how they found us, and a full street address with ZIP. Ask the staff member for anything missing instead of guessing. Plans/subscriptions, cards and orders are NOT set up here. ${NOTE}`,
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'First name — or the business / site name for a business account' },
        last_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        address_line1: { type: 'string', description: 'Street address, e.g. "2050 20th Ave"' },
        address_line2: { type: 'string', description: 'Apt / unit / suite' },
        city: { type: 'string' }, state: { type: 'string', description: 'Default CA' }, zip: { type: 'string' },
        access_instructions: { type: 'string', description: 'Gate codes, where to leave bags — what the DRIVER needs' },
        pricelist: { type: 'string', enum: ['Delivery', 'Commercial', 'HCEB'], description: 'Default Delivery (residential). Commercial for businesses.' },
        billing_type: { type: 'string', enum: ['automatic', 'on_account'], description: 'automatic = card on file (default); on_account = invoiced' },
        billing_group: { type: 'string', description: 'Optional: billing group name, e.g. "Kidango Group"' },
        discount: { type: 'string', description: 'Optional: discount name, e.g. "NON PROFIT"' },
        referral_source: { type: 'string', enum: REFERRAL_SOURCES },
        ambassador_code: { type: 'string', description: 'Only when referral_source is ambassador' },
        notes: { type: 'string', description: 'Internal staff notes' },
      },
      required: ['first_name', 'referral_source', 'address_line1', 'zip'],
    },
  },
  {
    name: 'propose_issue',
    description: `Open a staff issue (e.g. to report a suspected bug to David, or track a customer problem). ${NOTE}`,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        details: { type: 'string', description: 'Evidence / what happened — saved as the first comment' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        category: { type: 'string', enum: ['billing', 'schedule', 'delivery', 'complaint', 'damaged', 'lost_found', 'other'] },
        customer_id: { type: 'string' },
        order_number: { type: 'integer' },
      },
      required: ['title', 'details'],
    },
  },
  {
    name: 'propose_issue_comment',
    description: `Add a comment to an existing staff issue. ${NOTE}`,
    input_schema: { type: 'object', properties: { issue_id: { type: 'integer' }, comment: { type: 'string' } }, required: ['issue_id', 'comment'] },
  },
]
const TYPE_BY_TOOL: Record<string, string> = {
  propose_create_customer: 'create_customer',
  propose_reschedule: 'reschedule', propose_skip_or_cancel: 'skip_or_cancel', propose_credit: 'adjust_credit',
  propose_instructions_update: 'update_instructions', propose_issue: 'create_issue', propose_issue_comment: 'add_issue_comment',
}
export const isActionTool = (name: string) => name in TYPE_BY_TOOL

// ── Propose: validate + preview + store as pending ───────────────────────────
export async function proposeAction(ctx: Ctx, tool: string, input: Record<string, unknown>): Promise<Proposal> {
  const { svc, user, caller } = ctx
  let params: Record<string, unknown> = {}
  let summary = ''
  let canNotify = false
  const lines: Proposal['preview']['lines'] = []
  const warnings: string[] = []

  switch (tool) {
    case 'propose_reschedule': {
      const o = await loadOrder(svc, orderNum(input.order_number))
      const leg = input.leg === 'delivery' ? 'delivery' : 'pickup'
      const newDate = text(input.new_date, 10)
      const win = ['AM', 'PM', 'evening'].includes(String(input.window)) ? String(input.window) : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) throw new Error('new_date must be YYYY-MM-DD')
      if (!win) throw new Error('window must be AM, PM or evening')
      // Dry run AS THE STAFF MEMBER: same checks the real call will make (status, template, past date).
      const { data: dry, error } = await user.rpc('reschedule_order_to_window', {
        p_order_id: o.id, p_leg: leg, p_new_date: newDate, p_new_window: win, p_actor_name: actor(caller), p_dry_run: true,
      })
      if (error) throw new Error(error.message)
      const before = leg === 'pickup' ? range(o.pickup_window_start, o.pickup_window_end) : range(o.delivery_window_start, o.delivery_window_end)
      const after = range(dry.new_window_start, dry.new_window_end)
      params = {
        order_id: o.id, order_number: o.order_number, leg, new_date: newDate, window: win,
        // 318c: what Undo puts back.
        orig_run_id: leg === 'pickup' ? o.pickup_run_id : o.delivery_run_id,
        orig_start:  leg === 'pickup' ? o.pickup_window_start : o.delivery_window_start,
        orig_end:    leg === 'pickup' ? o.pickup_window_end : o.delivery_window_end,
      }
      summary = `Move ${leg} for order #${o.order_number} (${custName(o.customers)}) to ${after}`
      lines.push({ label: `${leg === 'pickup' ? 'Pickup' : 'Delivery'} window`, before, after: `${after} · ${dry.new_route_name}` })
      if (leg === 'pickup' && o.delivery_window_start && new Date(dry.new_window_end) >= new Date(o.delivery_window_start)) {
        warnings.push('The new pickup is at or after the current delivery — the delivery will need moving too, or the change will be refused.')
      }
      canNotify = true
      break
    }

    case 'propose_skip_or_cancel': {
      const o = await loadOrder(svc, orderNum(input.order_number))
      const reason = text(input.reason, 300)
      if (!reason) throw new Error('reason is required')
      if (o.status !== 'scheduled') throw new Error(`Order #${o.order_number} is '${o.status}' — only scheduled orders (not yet picked up) can be skipped or cancelled here.`)
      const target = o.recurring_interval ? 'skipped' : 'cancelled'
      params = { order_id: o.id, order_number: o.order_number, new_status: target, reason }
      summary = `${target === 'skipped' ? 'Skip' : 'Cancel'} order #${o.order_number} (${custName(o.customers)}) — ${reason}`
      lines.push({ label: 'Status', before: 'Scheduled', after: target === 'skipped' ? 'Skipped' : 'Cancelled' })
      lines.push({ label: 'Pickup that won’t happen', after: range(o.pickup_window_start, o.pickup_window_end) })
      if (target === 'skipped') warnings.push(`Recurring (${o.recurring_interval}): the next pickup is created automatically. Two skips in a row end the recurring schedule.`)
      warnings.push('The customer is not texted — tell them if they didn’t ask for this.')
      break
    }

    case 'propose_credit': {
      const custId = String(input.customer_id ?? '').trim()
      if (!UUID.test(custId)) throw new Error('customer_id must be an id from find_customers')
      const dir = input.direction === 'remove' ? 'remove' : 'add'
      const amount = Math.round(Number(input.amount) * 100) / 100
      const reason = text(input.reason, 300)
      if (!(amount > 0)) throw new Error('amount must be more than $0')
      if (amount > CREDIT_CAP) throw new Error(`Credits over $${CREDIT_CAP} must be done by hand in Customers → Credits (policy). Don't propose a smaller or split amount instead.`)
      // The cap is per customer per 24h, so it can't be dodged by splitting into several proposals.
      const { data: recent, error: rErr } = await svc.from('assistant_actions').select('params')
        .eq('action_type', 'adjust_credit').in('status', ['pending', 'executing', 'done'])
        .gte('created_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
        .eq('params->>customer_id', custId)
        .is('undone_at', null)
      if (rErr) throw new Error('credit limit check: ' + rErr.message)
      const used = (recent || []).reduce((s: number, r: { params: { amount?: number } }) => s + Number(r.params?.amount || 0), 0)
      if (used + amount > CREDIT_CAP + 0.004) throw new Error(`That would take this customer past the $${CREDIT_CAP}-per-24h assistant limit (${money(used)} already proposed or done). Do the rest by hand in Customers → Credits.`)
      if (!reason) throw new Error('reason is required')
      const { data: c, error } = await svc.from('customers').select('id, first_name_cache, last_name_cache, credits').eq('id', custId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!c) throw new Error('No customer with that id')
      let orderNumber: number | null = null
      if (input.order_number) orderNumber = (await loadOrder(svc, orderNum(input.order_number))).order_number
      const bal = Number(c.credits || 0)
      const actual = dir === 'add' ? amount : Math.min(amount, bal)
      if (dir === 'remove' && bal <= 0) throw new Error(`${custName(c)} has no credit to remove.`)
      params = { customer_id: c.id, direction: dir, amount, reason, order_number: orderNumber, expected_balance: bal }
      summary = `${dir === 'add' ? 'Add' : 'Remove'} ${money(actual)} credit ${dir === 'add' ? 'to' : 'from'} ${custName(c)} — ${reason}`
      lines.push({ label: 'Credit balance', before: money(bal), after: money(dir === 'add' ? bal + amount : bal - actual) })
      if (dir === 'remove' && actual < amount) warnings.push(`Only ${money(actual)} can be removed (that’s their whole balance).`)
      break
    }

    case 'propose_instructions_update': {
      const o = await loadOrder(svc, orderNum(input.order_number))
      if (!['scheduled', 'picked_up'].includes(o.status)) throw new Error(`Order #${o.order_number} is '${o.status}' — instructions can only change before processing starts.`)
      const next = String(input.new_instructions ?? '').trim().slice(0, 1000)
      const cur = (o.special_instructions || '').trim()
      if (next === cur) throw new Error('Those are already the instructions on this order.')
      params = { order_id: o.id, order_number: o.order_number, new_instructions: next, expected_current: cur }
      summary = `Update instructions on order #${o.order_number} (${custName(o.customers)})`
      lines.push({ label: 'Instructions', before: cur || '(none)', after: next || '(none)' })
      break
    }

    case 'propose_create_customer': {
      const first = text(input.first_name, 80)
      const last = text(input.last_name, 80)
      const email = text(input.email, 160).toLowerCase()
      const phoneRaw = text(input.phone, 40)
      const phone10 = digits10(phoneRaw)
      const line1 = text(input.address_line1, 160)
      const line2 = text(input.address_line2, 60)
      const cityIn = text(input.city, 60)
      const stateIn = (text(input.state, 20) || 'CA').toUpperCase()
      const zipIn = text(input.zip, 10)
      const access = String(input.access_instructions ?? '').trim().slice(0, 1000)
      const notes = String(input.notes ?? '').trim().slice(0, 2000)
      const pricelist = ['Delivery', 'Commercial', 'HCEB'].includes(String(input.pricelist)) ? String(input.pricelist) : 'Delivery'
      const billingType = input.billing_type === 'on_account' ? 'on_account' : 'automatic'
      const source = String(input.referral_source ?? '')
      const ambassador = source === 'ambassador' ? text(input.ambassador_code, 40).toUpperCase() : ''

      if (!first) throw new Error('first_name is required (the business or site name for a business).')
      if (!REFERRAL_SOURCES.includes(source)) throw new Error(`referral_source is required — one of: ${REFERRAL_SOURCES.join(', ')}. Ask the staff member how they found us.`)
      if (source === 'ambassador' && !ambassador) throw new Error('ambassador_code is required when they came through an ambassador.')
      if (email && !EMAIL_RE.test(email)) throw new Error(`"${email}" doesn't look like an email address.`)
      if (phoneRaw && !phone10) throw new Error(`"${phoneRaw}" isn't a 10-digit phone number.`)
      if (!line1 || !/^\d{5}$/.test(zipIn)) throw new Error('A street address and a 5-digit ZIP are required so pickups can be routed.')

      // Billing group / discount by name (or id).
      let group: { id: string; name: string } | null = null
      if (text(input.billing_group, 120)) {
        const g = text(input.billing_group, 120)
        const q = UUID.test(g) ? svc.from('billing_groups').select('id, name').eq('id', g) : svc.from('billing_groups').select('id, name').ilike('name', `%${g.replace(/[%_]/g, ' ')}%`)
        const { data, error } = await q.limit(3)
        if (error) throw new Error(error.message)
        if (!data?.length) throw new Error(`No billing group matches "${g}".`)
        if (data.length > 1) throw new Error(`"${g}" matches several billing groups: ${data.map((x: { name: string }) => x.name).join(', ')}. Which one?`)
        group = data[0]
      }
      let discount: { id: string; name: string; value: number; type: string } | null = null
      if (text(input.discount, 80)) {
        const dn = text(input.discount, 80)
        const { data, error } = await svc.from('discounts').select('id, name, value, type')
          .ilike('name', dn.replace(/[%_]/g, ' ')).eq('active', true).is('deleted_at', null).limit(2)
        if (error) throw new Error(error.message)
        if (!data?.length) throw new Error(`No active discount named "${dn}".`)
        discount = data[0]
      }

      // David's rule (session 290): never create a second account for someone we
      // already have — stop and show the match. Exception: a sibling site in the
      // SAME billing group (Kidango sites share one contact email/phone).
      const hits = await contactMatches(svc, email, phone10)
      const blocking = hits.filter(h => !(group && h.billing_group_id === group.id))
      if (blocking.length) {
        throw new Error('Not created — this ' + [...new Set(blocking.map(h => h.matched))].join(' and ') + ' is already on file: ' +
          blocking.map(h => `${custName(h)} (${h.matched === 'email' ? h.email_cache : h.phone_cache}, id ${h.id})`).join('; ') +
          '. Use the existing account (get_customer), or ask the staff member whether this really is a different person.')
      }
      if (hits.length) warnings.push(`Shares its ${[...new Set(hits.map(h => h.matched))].join(' and ')} with ${hits.map(h => custName(h)).join(', ')} in ${group!.name} — OK for another site of the same organization.`)

      const geo = await geocode(line1, cityIn, stateIn, zipIn)
      if (!geo.city || !geo.state || !geo.zip) throw new Error('City, state and ZIP are needed — Google could not fill them in.')
      if (!geo.verified) warnings.push(`Address not verified (${geo.note}). The stop won’t show on the route map until it’s fixed in the customer panel.`)
      else if (geo.note) warnings.push(geo.note)
      let zoneName = ''
      if (geo.lat != null && geo.lng != null) {
        const { data: zid } = await svc.rpc('get_zone_for_point', { lat: geo.lat, lng: geo.lng, p_city: geo.city })
        if (zid) { const { data: z } = await svc.from('service_zones').select('name').eq('id', zid).maybeSingle(); zoneName = z?.name || '' }
        if (!zoneName) warnings.push('This address is outside every service zone — pickups there can’t be routed.')
      }
      // Same address already on another account → probably the same household/business.
      const { data: sameAddr } = await svc.from('addresses').select('customer_id, line2, customers(first_name_cache, last_name_cache)')
        .ilike('line1', line1.replace(/[%_]/g, ' ')).eq('zip', geo.zip).limit(5)
      const addrHits = (sameAddr || []).filter((a: { line2?: string }) => (a.line2 || '').trim().toLowerCase() === line2.toLowerCase())
      if (addrHits.length) warnings.push(`This exact address is already on ${addrHits.map((a: { customers?: { first_name_cache?: string; last_name_cache?: string } }) => custName(a.customers)).join(', ')}'s account. Make sure this is a different person or business.`)

      const addressText = geo.verified ? geo.formatted + (line2 ? ` (${line2})` : '') : `${line1}${line2 ? ' ' + line2 : ''}, ${geo.city}, ${geo.state} ${geo.zip}`
      params = {
        first, last, email, phone10, line1, line2, city: geo.city, state: geo.state, zip: geo.zip,
        lat: geo.lat, lng: geo.lng, address_text: addressText, access, notes, pricelist, billing_type: billingType,
        billing_group_id: group?.id || null, discount_id: discount?.id || null, referral_source: source, ambassador_code: ambassador || null,
      }
      const fullName = [first, last].filter(Boolean).join(' ')
      summary = `Create customer ${fullName}`
      lines.push({ label: 'Name', after: fullName })
      if (email) lines.push({ label: 'Email', after: email })
      if (phone10) lines.push({ label: 'Phone', after: fmtPhone(phone10) + ' · gets order texts' })
      lines.push({ label: 'Address', after: addressText + (zoneName ? ` · zone ${zoneName}` : '') })
      if (access) lines.push({ label: 'Driver notes', after: access })
      lines.push({ label: 'Price list', after: pricelist })
      lines.push({ label: 'Billing', after: billingType === 'on_account' ? 'On account (invoiced)' : 'Card on file' })
      if (group) lines.push({ label: 'Billing group', after: group.name })
      if (discount) lines.push({ label: 'Discount', after: `${discount.name}${discount.type === 'percent' ? ` (${discount.value}% off)` : ''}` })
      lines.push({ label: 'Found us via', after: source + (ambassador ? ` · ${ambassador}` : '') })
      if (notes) lines.push({ label: 'Staff notes', after: notes })
      if (!email && !phone10) warnings.push('No email or phone — they won’t get any order updates.')
      if (billingType === 'automatic') warnings.push('No card yet — they need to add one in the customer app before their first charge.')
      break
    }

    case 'propose_issue': {
      const title = text(input.title, 160)
      const details = String(input.details ?? '').trim().slice(0, 4000)
      if (!title || !details) throw new Error('title and details are required')
      const priority = ['low', 'normal', 'high', 'urgent'].includes(String(input.priority)) ? String(input.priority) : 'normal'
      const category = ['billing', 'schedule', 'delivery', 'complaint', 'damaged', 'lost_found', 'other'].includes(String(input.category)) ? String(input.category) : 'other'
      let customerId: string | null = null
      let orderId: string | null = null
      let orderNumber: number | null = null
      if (input.order_number) { const o = await loadOrder(svc, orderNum(input.order_number)); orderId = o.id; orderNumber = o.order_number; customerId = o.customer_id }
      if (input.customer_id) { if (!UUID.test(String(input.customer_id))) throw new Error('customer_id must be an id from find_customers'); customerId = String(input.customer_id) }
      // Mirrors trg_enforce_issue_order_link so the refusal happens here, not after Confirm.
      if (!orderId && ['delivery', 'damaged'].includes(category)) throw new Error(`A '${category}' issue must be linked to an order — give the order number.`)
      params = { title, details, priority, category, customer_id: customerId, order_id: orderId }
      summary = `Open issue: ${title}`
      lines.push({ label: 'Issue', after: `${title} · ${priority} · ${category}${orderNumber ? ` · order #${orderNumber}` : ''}` })
      lines.push({ label: 'First comment', after: details.length > 400 ? details.slice(0, 400) + '…' : details })
      break
    }

    case 'propose_issue_comment': {
      const issueId = parseInt(String(input.issue_id ?? ''), 10)
      const comment = String(input.comment ?? '').trim().slice(0, 4000)
      if (!Number.isFinite(issueId) || !comment) throw new Error('issue_id and comment are required')
      const { data: iss, error } = await svc.from('cs_issues').select('id, title, status').eq('id', issueId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!iss) throw new Error(`No issue #${issueId}`)
      params = { issue_id: iss.id, comment }
      summary = `Comment on issue #${iss.id} (${iss.title})`
      lines.push({ label: `Issue #${iss.id}`, after: comment.length > 400 ? comment.slice(0, 400) + '…' : comment })
      break
    }

    default:
      throw new Error(`Unknown action tool ${tool}`)
  }

  const preview = { lines, warnings }
  const { data: row, error: insErr } = await svc.from('assistant_actions').insert({
    conversation_id: ctx.conversationId, proposed_by: caller.id, proposed_by_name: caller.name,
    action_type: TYPE_BY_TOOL[tool], params, summary, preview,
  }).select('id').single()
  if (insErr || !row) throw new Error('Could not save the proposal: ' + (insErr?.message || 'unknown'))
  return { id: row.id, action_type: TYPE_BY_TOOL[tool], summary, preview, can_notify: canNotify }
}

// ── Confirm / cancel ─────────────────────────────────────────────────────────
export async function cancelAction(ctx: Ctx, actionId: string) {
  if (!UUID.test(actionId)) throw new Error('bad action id')
  const { data, error } = await ctx.svc.from('assistant_actions')
    .update({ status: 'cancelled', decided_at: new Date().toISOString(), decided_by: ctx.caller.id })
    .eq('id', actionId).eq('proposed_by', ctx.caller.id).eq('status', 'pending').select('id, summary').maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('That change was already handled or isn’t yours.')
  return { message: `Cancelled: ${data.summary}` }
}

export async function confirmAction(ctx: Ctx, actionId: string, notify: boolean) {
  const { svc, user, caller } = ctx
  if (!UUID.test(actionId)) throw new Error('bad action id')
  // Claim it atomically — a double click or a second tab can't run it twice.
  const { data: act, error: claimErr } = await svc.from('assistant_actions')
    .update({ status: 'executing', decided_at: new Date().toISOString(), decided_by: caller.id, notify })
    .eq('id', actionId).eq('proposed_by', caller.id).eq('status', 'pending').gt('expires_at', new Date().toISOString())
    .select('*').maybeSingle()
  if (claimErr) {
    if (claimErr.code === '23505') throw new Error('That change has already been undone.')
    throw new Error('Could not start the change: ' + claimErr.message)
  }
  if (!act) throw new Error('That change was already handled, has expired (30 min), or was proposed by someone else. Ask Claude again.')

  // deno-lint-ignore no-explicit-any
  const p = act.params as Record<string, any>
  let result: unknown = null
  let message = ''
  try {
    // Order-level actions: write the attributed order-history entry FIRST (house rule:
    // log, then change). If the log write fails, nothing is changed.
    if (p.order_id && act.action_type !== 'create_issue') {
      const isReschedule = act.action_type === 'reschedule' || (act.action_type === 'undo' && p.undo_type === 'reschedule')
      // 318c: instruction changes keep the old and new text in the order history.
      const oldNew = act.action_type === 'update_instructions'
        ? { old_value: p.expected_current || null, new_value: p.new_instructions || null }
        : (act.action_type === 'undo' && p.undo_type === 'update_instructions')
          ? { old_value: p.expected_current || null, new_value: p.restore || null }
          : {}
      const { error: evErr } = await user.from('order_events').insert({
        order_id: p.order_id, event_type: 'assistant_action', actor_name: actor(caller),
        description: act.summary + (isReschedule ? (notify ? ' · customer texted' : ' · customer not texted') : ''),
        ...oldNew,
      })
      if (evErr) throw new Error('Could not write the order history entry, so nothing was changed: ' + evErr.message)
    }

    switch (act.action_type) {
      case 'reschedule': {
        const { data, error } = await user.rpc('reschedule_order_to_window', {
          p_order_id: p.order_id, p_leg: p.leg, p_new_date: p.new_date, p_new_window: p.window,
          p_actor_name: actor(caller), p_dry_run: false, p_notify: !!notify,
        })
        if (error) throw new Error(error.message)
        const { data: now } = await svc.from('orders')
          .select('pickup_window_start, pickup_window_end, delivery_window_start, delivery_window_end').eq('id', p.order_id).single()
        result = { ...data,
          after_start: p.leg === 'pickup' ? now?.pickup_window_start : now?.delivery_window_start,
          after_end:   p.leg === 'pickup' ? now?.pickup_window_end   : now?.delivery_window_end }
        message = `Done — order #${p.order_number} ${p.leg} moved to ${range(data?.new_window_start, data?.new_window_end)}${notify ? '; customer texted' : ''}.`
        break
      }
      case 'skip_or_cancel': {
        const { data, error } = await user.rpc('advance_order_status', {
          p_order_id: p.order_id, p_new_status: p.new_status, p_actor_name: actor(caller),
          p_cancelled_by: 'admin', p_notify_sms: false,
        })
        if (error) throw new Error(error.message)
        result = data
        message = `Done — order #${p.order_number} ${p.new_status}.`
        break
      }
      case 'adjust_credit': {
        // Refuse if the balance moved since the preview, so staff never confirm stale numbers.
        const { data: c, error: cErr } = await svc.from('customers').select('credits').eq('id', p.customer_id).single()
        if (cErr) throw new Error(cErr.message)
        if (Math.abs(Number(c.credits || 0) - Number(p.expected_balance)) > 0.004) {
          throw new Error(`Their balance changed since this was proposed (now ${money(Number(c.credits || 0))}). Ask Claude again.`)
        }
        const note = `${p.reason}${p.order_number ? ` (order #${p.order_number})` : ''} — ${actor(caller)}`
        const { data, error } = await user.rpc('adjust_customer_credits', {
          p_customer_id: p.customer_id, p_amount: p.amount, p_type: p.direction === 'add' ? 'credit_add' : 'credit_remove',
          p_note: note, p_actor_name: actor(caller),
        })
        if (error) throw new Error(error.message)
        result = data
        message = `Done — ${p.direction === 'add' ? 'added' : 'removed'} ${money(Number(data?.actual ?? p.amount))}. New balance ${money(Number(data?.new_balance ?? 0))}.`
        break
      }
      case 'update_instructions': {
        const { data: cur, error: curErr } = await svc.from('orders').select('special_instructions, status').eq('id', p.order_id).single()
        if (curErr) throw new Error(curErr.message)
        if ((cur.special_instructions || '').trim() !== p.expected_current) throw new Error('The instructions changed since this was proposed. Ask Claude again.')
        if (!['scheduled', 'picked_up'].includes(cur.status)) throw new Error(`The order is now '${cur.status}' — too late to change instructions here.`)
        const { error } = await user.from('orders').update({ special_instructions: p.new_instructions || null, updated_at: new Date().toISOString() }).eq('id', p.order_id)
        if (error) throw new Error(error.message)
        result = { updated: true }
        message = `Done — instructions updated on order #${p.order_number}.`
        break
      }
      case 'create_customer': {
        // Re-check duplicates at the moment of creation (someone may have signed up since).
        const hits = await contactMatches(svc, p.email || '', p.phone10 || '')
        const blocking = hits.filter(h => !(p.billing_group_id && h.billing_group_id === p.billing_group_id))
        if (blocking.length) throw new Error(`Not created — ${custName(blocking[0])} now has this ${blocking[0].matched}. Use that account.`)
        const nowIso = new Date().toISOString()
        // The pricelist trigger turns anything but Delivery/Commercial into Delivery on
        // INSERT, so HCEB is set with a follow-up update (the UPDATE path keeps it).
        const insertPl = ['Delivery', 'Commercial'].includes(p.pricelist) ? p.pricelist : 'Delivery'
        const { data: cust, error: cErr } = await user.from('customers').insert({
          risk_status: 'active', notes: p.notes || null, referral_source: p.referral_source, ambassador_code: p.ambassador_code || null,
          pricelist: insertPl, billing_type: p.billing_type, billing_group_id: p.billing_group_id || null, discount_id: p.discount_id || null,
          first_name_cache: p.first, last_name_cache: p.last || null, email_cache: p.email || null,
          phone_cache: p.phone10 ? fmtPhone(p.phone10) : null, address_cache: p.address_text,
          access_instructions: p.access || null,
          // Same as Customers → New Customer: staff adding a phone means order texts are on (David, 318d).
          sms_consent_at: p.phone10 ? nowIso : null,
        }).select('id').single()
        if (cErr || !cust) throw new Error('Could not create the customer: ' + (cErr?.message || 'unknown'))
        const rollback = async (why: string) => {
          await svc.from('customers').delete().eq('id', cust.id)
          throw new Error(why + ' — nothing was created.')
        }
        if (p.pricelist !== insertPl) {
          const { error: plErr } = await user.from('customers').update({ pricelist: p.pricelist }).eq('id', cust.id)
          if (plErr) await rollback('Could not set the price list: ' + plErr.message)
        }
        const { error: aErr } = await user.from('addresses').insert({
          customer_id: cust.id, label: p.billing_type === 'on_account' ? 'Site' : 'Home',
          line1: p.line1, line2: p.line2 || null, city: p.city, state: p.state, zip: p.zip,
          lat: p.lat ?? null, lng: p.lng ?? null, delivery_instructions: p.access || null, is_default: true,
        })
        if (aErr) await rollback('Could not save the address: ' + aErr.message)
        result = { customer_id: cust.id }
        message = `Done — ${[p.first, p.last].filter(Boolean).join(' ')} created. Open Customers to add a plan, card or first order.`
        break
      }
      case 'create_issue': {
        const { data: iss, error } = await user.from('cs_issues').insert({
          title: p.title, priority: p.priority, category: p.category, customer_id: p.customer_id, order_id: p.order_id,
          created_by: actor(caller), status: 'open',
        }).select('id').single()
        if (error) throw new Error(error.message)
        const { error: cErr } = await user.from('cs_issue_comments').insert({ issue_id: iss.id, author: actor(caller), body: p.details, comment_type: 'comment' })
        if (cErr) throw new Error(`Issue #${iss.id} was created but the details comment failed: ${cErr.message}`)
        result = { issue_id: iss.id }
        message = `Done — opened issue #${iss.id}.`
        break
      }
      case 'add_issue_comment': {
        const { error } = await user.from('cs_issue_comments').insert({ issue_id: p.issue_id, author: actor(caller), body: p.comment, comment_type: 'comment' })
        if (error) throw new Error(error.message)
        result = { issue_id: p.issue_id }
        message = `Done — comment added to issue #${p.issue_id}.`
        break
      }
      case 'undo': {
        const out = await runUndo(ctx, p, !!notify)
        result = out.result
        message = out.message
        break
      }
      default:
        throw new Error('Unknown action type ' + act.action_type)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const { error: fErr } = await svc.from('assistant_actions').update({ status: 'failed', error: msg }).eq('id', actionId)
    if (fErr) console.error('[admin-assistant] could not mark action failed:', fErr.message)
    throw new Error(msg)
  }

  const { error: dErr } = await svc.from('assistant_actions').update({ status: 'done', result }).eq('id', actionId)
  if (dErr) console.error('[admin-assistant] change ran but could not mark action done:', dErr.message)
  if (act.action_type === 'undo') {
    const { error: uErr } = await svc.from('assistant_actions')
      .update({ undone_at: new Date().toISOString(), undone_by_action_id: actionId }).eq('id', p.undoes)
    if (uErr) console.error('[admin-assistant] undo ran but could not stamp the original:', uErr.message)
  }
  return { message, result, undoes: act.action_type === 'undo' ? p.undoes : null }
}

// ── Undo (session 318c) ──────────────────────────────────────────────────────
export const UNDOABLE = new Set(['reschedule', 'skip_or_cancel', 'adjust_credit', 'update_instructions', 'create_customer'])

// A new account can be undone only while nothing has happened on it yet; undoing
// deletes it (and its address). Anything attached → close it by hand instead.
async function customerIsUntouched(svc: Db, id: string): Promise<string | null> {
  const checks: [string, string][] = [['orders', 'orders'], ['customer_transactions', 'billing history'], ['subscriptions', 'a subscription'],
    ['sms_messages', 'text messages'], ['payments', 'payments'], ['cs_issues', 'staff issues'], ['invoices', 'invoices'], ['customer_payment_methods', 'a saved card']]
  for (const [tbl, label] of checks) {
    const { count, error } = await svc.from(tbl).select('id', { count: 'exact', head: true }).eq('customer_id', id)
    if (error) throw new Error(`${tbl} check: ${error.message}`)
    if ((count || 0) > 0) return label
  }
  const { data: c } = await svc.from('customers').select('profile_id, credits').eq('id', id).maybeSingle()
  if (!c) return 'it no longer exists'
  if (c.profile_id) return 'a customer-app login'
  if (Number(c.credits || 0) !== 0) return 'account credit'
  return null
}
const UNDO_DAYS = 7
const sameTime = (a?: string | null, b?: string | null) =>
  (!a && !b) || (!!a && !!b && new Date(a).getTime() === new Date(b).getTime())

// Builds the undo as a PENDING action with a before → after preview. Nothing changes
// until the staff member clicks Confirm on it. Any admin/manager may undo any change.
export async function proposeUndo(ctx: Ctx, originalId: string): Promise<Proposal> {
  const { svc, caller } = ctx
  if (!UUID.test(originalId)) throw new Error('bad action id')
  const { data: a, error } = await svc.from('assistant_actions').select('*').eq('id', originalId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!a) throw new Error('No such change.')
  if (a.status !== 'done') throw new Error('Only changes that actually went through can be undone.')
  if (!UNDOABLE.has(a.action_type)) throw new Error('Issues and comments can’t be undone here — resolve the issue instead.')
  if (a.undone_at) throw new Error('This change has already been undone.')
  if (Date.now() - new Date(a.decided_at || a.created_at).getTime() > UNDO_DAYS * 86400000) {
    throw new Error(`This change is more than ${UNDO_DAYS} days old — undo it by hand.`)
  }
  // deno-lint-ignore no-explicit-any
  const p = a.params as Record<string, any>
  // deno-lint-ignore no-explicit-any
  const r = (a.result || {}) as Record<string, any>
  let params: Record<string, unknown> = { undoes: a.id, undo_type: a.action_type }
  let summary = ''
  let canNotify = false
  const lines: Proposal['preview']['lines'] = []
  const warnings: string[] = []

  switch (a.action_type) {
    case 'reschedule': {
      if (!p.orig_start || !p.orig_run_id) throw new Error('This reschedule was made before Undo existed (or had no route), so the original slot wasn’t recorded. Reschedule it by hand.')
      const o = await loadOrder(svc, Number(p.order_number))
      const leg = p.leg === 'delivery' ? 'delivery' : 'pickup'
      const curStart = leg === 'pickup' ? o.pickup_window_start : o.delivery_window_start
      const curEnd   = leg === 'pickup' ? o.pickup_window_end   : o.delivery_window_end
      if (r.after_start && !sameTime(curStart, r.after_start)) throw new Error(`Order #${o.order_number}’s ${leg} has been moved again since — undoing would overwrite that. Reschedule it by hand.`)
      if (new Date(p.orig_start).getTime() <= Date.now()) throw new Error(`The original ${leg} time (${range(p.orig_start, p.orig_end)}) has already passed — pick a new time instead.`)
      const { data: route } = await svc.from('routes').select('id').eq('id', p.orig_run_id).maybeSingle()
      if (!route) throw new Error('The original route no longer exists — reschedule it by hand.')
      params = { ...params, order_id: o.id, order_number: o.order_number, leg,
        orig_run_id: p.orig_run_id, orig_start: p.orig_start, orig_end: p.orig_end, expected_start: curStart }
      summary = `Undo: move ${leg} for order #${o.order_number} (${custName(o.customers)}) back to ${range(p.orig_start, p.orig_end)}`
      lines.push({ label: `${leg === 'pickup' ? 'Pickup' : 'Delivery'} window`, before: range(curStart, curEnd), after: range(p.orig_start, p.orig_end) })
      if (a.notify) warnings.push('The customer was texted about the first change. Tick the box below to text them the restored time.')
      canNotify = true
      break
    }

    case 'skip_or_cancel': {
      const o = await loadOrder(svc, Number(p.order_number))
      if (o.status !== p.new_status) throw new Error(`Order #${o.order_number} is now '${o.status}' — it can’t be put back from here.`)
      if (!o.pickup_window_start || new Date(o.pickup_window_start).getTime() <= Date.now()) {
        throw new Error(`The pickup time for order #${o.order_number} has already passed — book a new pickup instead.`)
      }
      params = { ...params, order_id: o.id, order_number: o.order_number, from_status: o.status }
      summary = `Undo: put order #${o.order_number} (${custName(o.customers)}) back on the schedule`
      lines.push({ label: 'Status', before: o.status === 'skipped' ? 'Skipped' : 'Cancelled', after: 'Scheduled' })
      lines.push({ label: 'Pickup', after: range(o.pickup_window_start, o.pickup_window_end) })
      if (o.status === 'skipped' && o.recurring_interval) {
        const { data: nxt } = await svc.from('orders').select('order_number, pickup_window_start')
          .eq('customer_id', o.customer_id).eq('status', 'scheduled').not('recurring_interval', 'is', null)
          .gt('pickup_window_start', o.pickup_window_start).gte('created_at', a.decided_at || a.created_at)
          .order('pickup_window_start').limit(1).maybeSingle()
        if (nxt) warnings.push(`The next recurring pickup (#${nxt.order_number}, ${range(nxt.pickup_window_start)}) was created when this was skipped. It stays booked too.`)
      }
      warnings.push('The customer is not texted — let them know their pickup is back on.')
      break
    }

    case 'adjust_credit': {
      const { data: c, error: cErr } = await svc.from('customers').select('id, first_name_cache, last_name_cache, credits').eq('id', p.customer_id).maybeSingle()
      if (cErr) throw new Error(cErr.message)
      if (!c) throw new Error('That customer no longer exists.')
      const bal = Math.round(Number(c.credits || 0) * 100) / 100
      const done = Math.round(Number(r.actual ?? p.amount) * 100) / 100
      if (!(done > 0)) throw new Error('Nothing was actually moved by that change, so there is nothing to undo.')
      let dir: 'add' | 'remove'
      let amt: number
      if (p.direction === 'add') {
        if (bal <= 0) throw new Error(`${custName(c)} has already used that credit — there is nothing left to take back.`)
        dir = 'remove'; amt = Math.min(done, bal)
        if (amt < done) warnings.push(`They’ve already used some of it — only ${money(amt)} of the ${money(done)} can be taken back.`)
      } else {
        dir = 'add'; amt = done
      }
      params = { ...params, customer_id: c.id, direction: dir, amount: amt, expected_balance: bal, original_reason: p.reason }
      summary = `Undo: ${dir === 'remove' ? 'take back' : 'give back'} ${money(amt)} credit ${dir === 'remove' ? 'from' : 'to'} ${custName(c)}`
      lines.push({ label: 'Credit balance', before: money(bal), after: money(dir === 'add' ? bal + amt : bal - amt) })
      break
    }

    case 'create_customer': {
      const cid = String(r.customer_id || '')
      if (!UUID.test(cid)) throw new Error('The new customer’s id wasn’t recorded — close the account by hand.')
      const blocker = await customerIsUntouched(svc, cid)
      if (blocker) throw new Error(`The account already has ${blocker}, so it can’t simply be removed. Close or merge it by hand in Customers.`)
      params = { ...params, customer_id: cid, name: [p.first, p.last].filter(Boolean).join(' ') }
      summary = `Undo: remove the new account for ${[p.first, p.last].filter(Boolean).join(' ')}`
      lines.push({ label: 'Account', before: [p.first, p.last].filter(Boolean).join(' ') + ' · ' + p.address_text, after: 'Removed (it has no orders or history yet)' })
      break
    }

    case 'update_instructions': {
      const o = await loadOrder(svc, Number(p.order_number))
      const cur = (o.special_instructions || '').trim()
      if (cur !== (p.new_instructions || '')) throw new Error(`The instructions on order #${o.order_number} were changed again since — undoing would overwrite that.`)
      if (!['scheduled', 'picked_up'].includes(o.status)) throw new Error(`Order #${o.order_number} is now '${o.status}' — too late to change its instructions here.`)
      params = { ...params, order_id: o.id, order_number: o.order_number, restore: p.expected_current || '', expected_current: cur }
      summary = `Undo: restore the previous instructions on order #${o.order_number} (${custName(o.customers)})`
      lines.push({ label: 'Instructions', before: cur || '(none)', after: p.expected_current || '(none)' })
      break
    }
  }

  const preview = { lines, warnings }
  const { data: row, error: insErr } = await svc.from('assistant_actions').insert({
    conversation_id: ctx.conversationId, proposed_by: caller.id, proposed_by_name: caller.name,
    action_type: 'undo', params, summary, preview,
  }).select('id').single()
  if (insErr || !row) throw new Error('Could not save the undo: ' + (insErr?.message || 'unknown'))
  return { id: row.id, action_type: 'undo', summary, preview, can_notify: canNotify }
}

// Runs a confirmed undo. Every branch re-checks that nothing moved since the preview.
// deno-lint-ignore no-explicit-any
async function runUndo(ctx: Ctx, p: Record<string, any>, notify: boolean): Promise<{ result: unknown; message: string }> {
  const { svc, user, caller } = ctx
  const { data: orig, error: oErr } = await svc.from('assistant_actions').select('id, status, undone_at').eq('id', p.undoes).maybeSingle()
  if (oErr) throw new Error(oErr.message)
  if (!orig || orig.status !== 'done' || orig.undone_at) throw new Error('That change has already been undone.')

  switch (p.undo_type) {
    case 'reschedule': {
      const { data: o, error } = await svc.from('orders').select('pickup_window_start, delivery_window_start').eq('id', p.order_id).single()
      if (error) throw new Error(error.message)
      if (!sameTime(p.leg === 'pickup' ? o.pickup_window_start : o.delivery_window_start, p.expected_start)) {
        throw new Error('The order was moved again since this undo was prepared. Nothing changed.')
      }
      const { data, error: rErr } = await user.rpc('reschedule_order_leg', {
        p_order_id: p.order_id, p_leg: p.leg, p_new_route_id: p.orig_run_id,
        p_new_window_start: p.orig_start, p_new_window_end: p.orig_end,
        p_actor_name: actor(caller), p_notify: notify,
      })
      if (rErr) throw new Error(rErr.message)
      return { result: data, message: `Undone — order #${p.order_number} ${p.leg} is back to ${range(p.orig_start, p.orig_end)}${notify ? '; customer texted' : ''}.` }
    }
    case 'skip_or_cancel': {
      const { data, error } = await user.rpc('restore_order_to_scheduled', { p_order_id: p.order_id, p_actor_name: actor(caller) })
      if (error) throw new Error(error.message)
      return { result: data, message: `Undone — order #${p.order_number} is scheduled again.` }
    }
    case 'adjust_credit': {
      const { data: c, error: cErr } = await svc.from('customers').select('credits').eq('id', p.customer_id).single()
      if (cErr) throw new Error(cErr.message)
      if (Math.abs(Number(c.credits || 0) - Number(p.expected_balance)) > 0.004) {
        throw new Error(`Their balance changed since this undo was prepared (now ${money(Number(c.credits || 0))}). Nothing changed — try Undo again.`)
      }
      const { data, error } = await user.rpc('adjust_customer_credits', {
        p_customer_id: p.customer_id, p_amount: p.amount, p_type: p.direction === 'add' ? 'credit_add' : 'credit_remove',
        p_note: `Undo of: ${p.original_reason || 'earlier credit change'} — ${actor(caller)}`, p_actor_name: actor(caller),
      })
      if (error) throw new Error(error.message)
      return { result: data, message: `Undone — ${p.direction === 'add' ? 'gave back' : 'took back'} ${money(Number(data?.actual ?? p.amount))}. New balance ${money(Number(data?.new_balance ?? 0))}.` }
    }
    case 'update_instructions': {
      const { data: cur, error: curErr } = await svc.from('orders').select('special_instructions, status').eq('id', p.order_id).single()
      if (curErr) throw new Error(curErr.message)
      if ((cur.special_instructions || '').trim() !== p.expected_current) throw new Error('The instructions changed since this undo was prepared. Nothing changed.')
      if (!['scheduled', 'picked_up'].includes(cur.status)) throw new Error(`The order is now '${cur.status}' — too late to change instructions here.`)
      const { error } = await user.from('orders').update({ special_instructions: p.restore || null, updated_at: new Date().toISOString() }).eq('id', p.order_id)
      if (error) throw new Error(error.message)
      return { result: { updated: true }, message: `Undone — previous instructions restored on order #${p.order_number}.` }
    }
    case 'create_customer': {
      const blocker = await customerIsUntouched(svc, p.customer_id)
      if (blocker) throw new Error(`The account now has ${blocker} — nothing was removed. Close or merge it by hand.`)
      // As the staff member: RLS (is_admin) decides. Addresses cascade.
      const { error } = await user.from('customers').delete().eq('id', p.customer_id)
      if (error) throw new Error(error.message)
      return { result: { deleted: p.customer_id }, message: `Undone — the account for ${p.name} was removed.` }
    }
    default:
      throw new Error('Unknown undo type ' + p.undo_type)
  }
}
