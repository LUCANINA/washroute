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
    .select('id, order_number, customer_id, status, recurring_interval, special_instructions, pickup_window_start, pickup_window_end, delivery_window_start, delivery_window_end, customers(first_name_cache, last_name_cache)')
    .eq('order_number', n).maybeSingle()
  if (error) throw new Error('order lookup: ' + error.message)
  if (!data) throw new Error(`No order #${n}`)
  return data
}
const actor = (c: Caller) => `${c.name} (via Claude)`

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
      params = { order_id: o.id, order_number: o.order_number, leg, new_date: newDate, window: win }
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
  if (claimErr) throw new Error('Could not start the change: ' + claimErr.message)
  if (!act) throw new Error('That change was already handled, has expired (30 min), or was proposed by someone else. Ask Claude again.')

  // deno-lint-ignore no-explicit-any
  const p = act.params as Record<string, any>
  let result: unknown = null
  let message = ''
  try {
    // Order-level actions: write the attributed order-history entry FIRST (house rule:
    // log, then change). If the log write fails, nothing is changed.
    if (p.order_id && act.action_type !== 'create_issue') {
      const { error: evErr } = await user.from('order_events').insert({
        order_id: p.order_id, event_type: 'assistant_action', actor_name: actor(caller),
        description: act.summary + (act.action_type === 'reschedule' ? (notify ? ' · customer texted' : ' · customer not texted') : ''),
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
        result = data
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
  return { message, result }
}
