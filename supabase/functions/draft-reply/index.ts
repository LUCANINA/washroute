import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SVC_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const BIZ_TZ        = 'America/Los_Angeles';

const dbHeaders: Record<string, string> = {
  'Authorization': `Bearer ${SVC_KEY}`,
  'apikey': SVC_KEY,
  'Content-Type': 'application/json',
};

async function dbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders });
  return r.json();
}

// Call an RPC as the admin user (passes their JWT through). Required so the
// RPC's is_admin() guard succeeds. service_role bypasses RLS but auth.uid()
// is NULL under it, so is_admin() returns false.
async function callRpcAsAdmin(adminJwt: string, fnName: string, params: any): Promise<{ ok: boolean; data: any; status: number }> {
  if (!adminJwt) return { ok: false, data: { error: 'no admin jwt' }, status: 401 };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminJwt}`,
      'apikey':        ANON_KEY,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, status: res.status };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

// ── Intent detection ──
// session 144 accuracy pass 2: order tightened so new_order is checked
// BEFORE reschedule_request — reschedule patterns kept overshooting onto
// new-pickup requests like "I'd like a pickup tomorrow" (the loose
// `pickup.*day` triggered on "pickup for tomorrow... Monday"). Reschedule
// regex tightened to require an explicit "move/reschedule/change" verb on
// an existing order; ambiguous terms like bare "earlier"/"later" or
// "can you pick up" removed.
function detectIntent(msg: string): string {
  const m = msg.toLowerCase();
  if (/price|cost|how much|rate|per bag|per pound|fee|charge|pricing|breakdown/.test(m))  return 'pricing_inquiry';
  if (/where is|where.*order|status|update|eta|when.*arriv|how long|still coming|on the way|pick.*up.*yet|picked up|delivered|my order|my laundry|tracking/.test(m)) return 'status_check';
  if (/pay|payment|card|charge|bill|invoice|refund|credit|billing|transaction/.test(m))   return 'payment_issue';
  if (/problem|issue|wrong|missing|lost|damage|complain|never|didn.t|not happy|upset|frustrated|mistake|error/.test(m)) return 'complaint';
  if (/cancel|stop service|don.t need|no longer|end my/.test(m))                           return 'cancellation';
  if (/skip|no laundry this|not this week|don.t have laundry|no pickup this|away|out of town|traveling|vacation|pause/.test(m)) return 'skip_request';

  // new_order: any phrase that signals a fresh booking. Checked BEFORE
  // reschedule so polite request phrasings ("I'd like to place a pickup")
  // route correctly even when the body also mentions specific days that
  // would otherwise trip the reschedule regex.
  if (/\bnew order\b|\bbook\b|schedule.*pickup|want.*pickup|need.*pickup|sign.*up|add.*address|place.*pickup|like.*pickup|like.*to.*schedule|can you (do|come)|set up.*pickup/.test(m)) return 'new_order';

  // reschedule_request: explicit move/change verb required.
  if (/reschedule|postpone|move (my|the).*(pickup|delivery|order)|change (my|the).*(pickup|delivery|order|time|date|day)|different (day|time) for (my|the)|push (my|the).*(pickup|delivery)/.test(m)) return 'reschedule_request';

  return 'general';
}

// session 144: voice tightened — less exclamatory, more subdued/professional.
const INTENT_INSTRUCTION: Record<string, string> = {
  pricing_inquiry:   'The customer is asking about pricing. Our rates: $59 per bag (up to 25 lbs), $3/lb for each pound over 25, plus a $9.95 pickup and delivery fee. Be clear and specific. Do not guess at other charges.',
  reschedule_request:'The customer wants to reschedule. Acknowledge the request and confirm what time you can offer — use the order data if available. Note that the actual change still needs to be made in the admin dashboard; the draft should tell the customer what you are doing.',
  status_check:      'The customer wants a status update. Use the order data provided to give a specific, accurate answer — pickup date, time window, or delivery window. Do not guess or make up times.',
  payment_issue:     'The customer has a billing or payment question. Be empathetic and direct. If it is a failed payment, let them know and ask them to update their card in the app at app.familylaundry.com.',
  complaint:         'The customer is frustrated or reporting a problem. Open with a genuine apology. Do not make excuses. Offer a clear next step or ask what would make it right.',
  cancellation:      'The customer may want to cancel or pause service. Acknowledge and ask if there is anything we can do to help. Do not pressure them.',
  skip_request:      'The customer wants to skip a pickup. Confirm that the skip has been noted and when we will see them next. Plain confirmation, not effusive.',
  new_order:         'The customer wants to book a pickup or is asking about starting service. Acknowledge specifically and either propose a time (if you have enough context) or direct them to book at app.familylaundry.com.',
  general:           'Use the conversation history and order context to draft the most helpful, specific reply you can.',
};

function fmtDate(d: string): string {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ }); }
  catch { return ''; }
}

function fmtWindow(s: string, e: string): string {
  if (!s || !e) return '';
  try {
    const fmt = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: BIZ_TZ }).replace(':00', '').toLowerCase();
    return `${fmt(new Date(s))}–${fmt(new Date(e))}`;
  } catch { return ''; }
}

function fmtTimeShort(iso: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: BIZ_TZ }).replace(':00', '').toLowerCase();
  } catch { return ''; }
}

function todayPT(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: BIZ_TZ });
}

// ── Voice mining: real outbound replies for tone calibration ──
async function fetchVoiceExamples(): Promise<string> {
  try {
    const rows = await dbGet(
      `sms_messages?direction=eq.outbound` +
      `&body=not.ilike.*Hi from Family Laundry*` +
      `&body=not.ilike.*your pickup is confirmed*` +
      `&body=not.ilike.*your driver is on the way*` +
      `&body=not.ilike.*your order has been picked up*` +
      `&body=not.ilike.*your laundry is ready*` +
      `&body=not.ilike.*we will skip*` +
      `&body=not.ilike.*If you don*` +
      `&body=not.ilike.*Payment of*` +
      `&order=created_at.desc&limit=80` +
      `&select=body,customer_id,created_at`
    );
    if (!Array.isArray(rows) || rows.length === 0) return '';
    // session 144: prefer examples without trailing exclamation points so the
    // mined voice tilts toward the new subdued tone.
    rows.sort((a: any, b: any) => {
      const aBangs = ((a.body || '').match(/!/g) || []).length;
      const bBangs = ((b.body || '').match(/!/g) || []).length;
      return aBangs - bBangs;
    });
    const seen = new Set<string>();
    const examples: string[] = [];
    for (const row of rows) {
      const body = (row.body || '').trim();
      if (!body || seen.has(body) || body.length < 15) continue;
      seen.add(body);
      examples.push(`"${body}"`);
      if (examples.length >= 6) break;
    }
    return examples.length > 0 ? examples.join('\n') : '';
  } catch (e) {
    console.warn('[draft-reply] fetchVoiceExamples failed:', e);
    return '';
  }
}

// ── Skip resolver ──
async function resolveSkipAction(customerId: string, customerFirstName: string): Promise<any | null> {
  try {
    const rows = await dbGet(
      `orders?customer_id=eq.${customerId}` +
      `&status=eq.scheduled` +
      `&recurring_interval=not.is.null` +
      `&order=pickup_window_start.asc` +
      `&limit=1` +
      `&select=id,order_number,pickup_window_start,pickup_window_end,recurring_interval`
    );
    const order = Array.isArray(rows) ? rows[0] : null;
    if (!order) return null;

    const pickupLabel = `${fmtDate(order.pickup_window_start)} ${fmtWindow(order.pickup_window_start, order.pickup_window_end)}`.trim();
    const firstName   = customerFirstName || 'there';

    return {
      type:               'skip',
      order_id:           order.id,
      order_number:       order.order_number,
      pickup_label:       pickupLabel,
      label:              `Skip Order #${order.order_number} — ${pickupLabel}`,
      confirmation_draft: `Got it, ${firstName} — we'll skip your ${pickupLabel} pickup. See you next time.`,
    };
  } catch (e) {
    console.warn('[draft-reply] resolveSkipAction failed:', e);
    return null;
  }
}

// ── Pull customer's zone + active templates for prompt grounding ──
// The AI needs to know what windows actually exist for the customer's zone so
// it doesn't propose dates+windows that have no matching route template.
async function fetchZoneAvailability(customerId: string): Promise<{ summary: string; zoneFound: boolean }> {
  try {
    // 1. Most recent zone_id from this customer's orders
    const rows = await dbGet(
      `orders?customer_id=eq.${customerId}&zone_id=not.is.null&order=created_at.desc&limit=1&select=zone_id`
    );
    const zoneId = Array.isArray(rows) && rows[0]?.zone_id;
    if (!zoneId) return { summary: '(zone not yet established — do not call place_pickup_order until zone is confirmed)', zoneFound: false };

    // 2. Active templates for the zone
    const tmpls = await dbGet(
      `route_templates?zone_id=eq.${zoneId}&is_active=eq.true&order=window_start&select=name,window_start,window_end,arrival_window_hours,schedule_days,turnaround_days,turnaround_hours`
    );
    if (!Array.isArray(tmpls) || tmpls.length === 0) {
      return { summary: '(no active templates for this customer\'s zone — do not call place_pickup_order or reschedule_order)', zoneFound: true };
    }

    // 3. Format as a list the model can reason over.
    // Postgres EXTRACT(DOW): 0=Sun, 1=Mon, ... 6=Sat. WashRoute schedule_days uses same.
    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const labelOf = (start: string) => {
      const h = parseInt((start || '').slice(0, 2), 10);
      if (h < 12) return 'AM';
      if (h < 17) return 'PM';
      return 'evening';
    };
    const lines = tmpls.map((t: any) => {
      const days = (t.schedule_days || []).map((d: number) => DOW_NAMES[d]).join('/');
      const sub = t.arrival_window_hours || 3;
      return `- ${days}, ${t.window_start.slice(0,5)}–${t.window_end.slice(0,5)} (sub-window ${sub}h, label "${labelOf(t.window_start)}", route "${t.name}", turnaround ${t.turnaround_days || 1}d${t.turnaround_hours ? ` or ${t.turnaround_hours}h same-day` : ''})`;
    });
    return { summary: lines.join('\n'), zoneFound: true };
  } catch (e) {
    console.warn('[draft-reply] fetchZoneAvailability failed:', e);
    return { summary: '(zone lookup failed)', zoneFound: false };
  }
}

// ── Tool-using resolver: place_pickup_order or reschedule_order ──
// Phase 1 of the agent system. When intent is new_order or reschedule_request,
// fire a tool-calling Claude request with structured schemas. The model picks
// place_pickup_order, reschedule_order, or no tool (fall back to text-only draft).
//
// session 144 accuracy pass: the user prompt now lists the customer's zone's
// available windows so the AI can't propose unreachable date/window combos.
// Every proposal is dry-run server-side via the corresponding RPC's p_dry_run
// mode before the action is returned, so the admin never sees a card that
// would fail at click-time. The card label is rewritten to reflect the
// SERVER-RESOLVED sub-window (not the AI's loose AM/PM/evening label).
async function resolveAgentAction(
  customerId: string,
  customerName: string,
  customerFirstName: string,
  conversationText: string,
  orderContextRaw: any[],
  primaryAddressLine: string,
  zoneSummary: string,
  adminJwt: string,
): Promise<any | null> {
  if (!ANTHROPIC_KEY) return null;

  // Build a compact list of active orders for the model. Only orders that are
  // candidates for reschedule (status in scheduled/picked_up/processing) are
  // included; cancelled/delivered ones aren't reschedulable.
  const activeOrders = (orderContextRaw || [])
    .filter((o: any) => ['scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery','on_hold'].includes(o.status))
    .slice(0, 5)
    .map((o: any) => ({
      order_id:              o.id,
      order_number:          o.order_number,
      status:                o.status,
      pickup_window_start:   o.pickup_window_start,
      pickup_window_end:     o.pickup_window_end,
      delivery_window_start: o.delivery_window_start,
      delivery_window_end:   o.delivery_window_end,
      bags:                  o.total_bags,
      recurring:             !!o.recurring_interval,
    }));

  const tools = [
    {
      name: 'place_pickup_order',
      description: 'Propose booking a NEW pickup for the customer. Use this when the customer is asking to schedule a fresh pickup (not modify an existing one). Defaults are filled from the customer profile (primary address, last service used). The proposal will be reviewed by the admin before it executes.',
      input_schema: {
        type: 'object',
        properties: {
          pickup_date:       { type: 'string', description: 'Pickup date in YYYY-MM-DD format, Pacific time. Must be today or in the future.' },
          pickup_window:     { type: 'string', enum: ['AM','PM','evening'], description: 'AM = morning (before noon). PM = afternoon (12-5pm). evening = after 5pm.' },
          bags:              { type: 'integer', minimum: 1, maximum: 30, description: 'Estimated number of bags. Use the customer\'s last order bag count if they did not specify.' },
          same_day_delivery: { type: 'boolean', description: 'True only if customer explicitly asked for same-day. Default false.' },
          notes:             { type: 'string', description: 'Special instructions if customer mentioned any (e.g. "leave at side door"). Empty string if none.' },
          rationale:         { type: 'string', description: 'One sentence quoting or paraphrasing the part of the conversation that supports this proposal.' },
          confirmation_draft:{ type: 'string', description: 'A short SMS reply (1-2 sentences) confirming the booking with specific date and window. Subdued and professional voice. No exclamation points.' }
        },
        required: ['pickup_date','pickup_window','bags','rationale','confirmation_draft']
      }
    },
    {
      name: 'reschedule_order',
      description: 'Propose MOVING an existing pickup or delivery to a different date and time window. Use this when the customer wants to change something already scheduled, not book something new.',
      input_schema: {
        type: 'object',
        properties: {
          order_id:          { type: 'string', description: 'UUID from the active_orders list. Pick the order the customer is most likely referring to.' },
          leg:               { type: 'string', enum: ['pickup','delivery'], description: 'Which leg to move. "pickup" if they want to change when laundry is collected, "delivery" if when it is returned.' },
          new_date:          { type: 'string', description: 'New date in YYYY-MM-DD format, Pacific time.' },
          new_window:        { type: 'string', enum: ['AM','PM','evening'] },
          rationale:         { type: 'string', description: 'One sentence on what in the conversation supports this proposal.' },
          confirmation_draft:{ type: 'string', description: 'Short SMS reply (1-2 sentences) confirming the reschedule with specific new date and window. Subdued and professional voice. No exclamation points.' }
        },
        required: ['order_id','leg','new_date','new_window','rationale','confirmation_draft']
      }
    }
  ];

  const systemPrompt = `You are an action-proposal assistant for Family Laundry, a laundry pickup and delivery service in the East Bay (Pacific time).

Your job: propose AT MOST ONE structured action by calling either place_pickup_order or reschedule_order. If the customer's intent is ambiguous, decline by NOT calling any tool.

## HARD RULE: prefer to decline

If you would need to ask a follow-up question to be confident about ANY of these — the date, the time window, the bags count, or which order they're referring to — do NOT call a tool. Return text only. The admin can ask the follow-up themselves. False precision is much worse than no proposal.

## Date interpretation

- Today's date in Pacific time is ${todayPT()}.
- "tomorrow" → today + 1 day.
- "next [weekday]" → the soonest occurrence of that weekday at least 3 days out.
- "this [weekday]" → the soonest occurrence of that weekday in the next 6 days.
- Bare day name like "Thursday" with no "this"/"next" → the soonest occurrence in the next 6 days.
- Vague phrases ("sometime next week", "soon", "whenever you can") → do NOT call a tool.

## Available windows constraint

The user message will list the customer's zone's available pickup windows (days + time-of-day labels). You MUST only propose a date+window combination that exists in that list. If the customer asks for a day or window that isn't available, do NOT call a tool — the admin will need to suggest an alternative.

## Window-of-day labels

- AM = template window starts before 12:00.
- PM = template window starts 12:00–16:59.
- evening = template window starts 17:00 or later.
- A request like "early morning" or "7am" maps to AM if the AM window is available.
- A request like "after work" or "around 6" maps to evening if available, else PM.
- Hour-specific requests ("can you come at 2pm") that don't align with the available sub-windows: if the closest available window covers that hour, propose that window with rationale noting the customer asked for an exact hour. If it doesn't, decline.

## Bags

- If the customer specifies a number, use it.
- If they don't, use the bag count from their MOST RECENT active or delivered order.
- If they have no order history at all, decline (we don't have a sensible default).

## Reschedule scope

- pickup leg can only be moved while the order status is 'scheduled'.
- delivery leg can be moved through 'ready_for_delivery'.
- If the customer references an order whose status doesn't allow a move, decline.
- If two or more active orders match the customer's reference equally well, decline.

## Confirmation draft style

- 1–2 sentences. Plain SMS text. No emojis, no markdown.
- Use the customer's first name at the start.
- Include the specific date and time window you're proposing.
- Subdued and professional. No exclamation points.
- Do not sign off as "Family Laundry" or "the team".

## Worked examples

Example A — clear new pickup, available window:
  Available: Mon/Wed/Fri 07:00–10:00 AM (Berkeley AM)
  Today: 2026-05-07 (Wed)
  Customer: "Hi, can I get a pickup tomorrow morning? Same as last time"
  Last order had 2 bags.
  → Tool: place_pickup_order { pickup_date: "2026-05-08", pickup_window: "AM", bags: 2, rationale: "Customer asked for tomorrow morning; last order was 2 bags.", confirmation_draft: "Hi [name], pickup is set for Thu May 8, 7–10 AM. We'll see you then." }
  Wait — 2026-05-08 is Friday, but the available list says Mon/Wed/Fri AM is open, so this works. If it had been Tue (no AM), DECLINE.

Example B — reschedule with single clear target:
  Active orders: one scheduled pickup #3850 Wed AM.
  Customer: "Need to push my pickup to Friday morning"
  Available windows include Fri AM.
  → Tool: reschedule_order { order_id: "<#3850 uuid>", leg: "pickup", new_date: "<Friday>", new_window: "AM", rationale: "Move scheduled Wed AM pickup to Fri AM as requested.", confirmation_draft: "Hi [name], your pickup is moved to Fri May 10, 7–10 AM." }

Example C — ambiguous, decline:
  Active orders: 2 (one pickup, one delivery).
  Customer: "Can we change the time?"
  → Do NOT call a tool. Both leg and direction are unclear. The admin should ask which order.

Example D — day not available in zone:
  Available: Mon/Wed/Fri only.
  Customer: "Pickup Tuesday morning?"
  → Do NOT call a tool. Tuesday isn't available. The admin should propose Mon or Wed instead.

Example E — vague timing, decline:
  Customer: "Sometime next week works"
  → Do NOT call a tool. No specific day. The admin should ask which day.

Example F — hour-tweak that can't be expressed:
  Customer: "Can you come an hour earlier than usual?"
  → Do NOT call a tool. Sub-window granularity is fixed by the templates. The admin should clarify whether the customer wants a different window-of-day or wait for the existing window.`;

  const userPrompt = `Customer: ${customerName}${customerFirstName ? ` (first name: ${customerFirstName})` : ''}
Primary address: ${primaryAddressLine || '(no saved address — do not propose place_pickup_order)'}

Available pickup windows for this customer's zone:
${zoneSummary}

Active orders (eligible for reschedule):
${activeOrders.length > 0 ? JSON.stringify(activeOrders, null, 2) : '(none)'}

Conversation history (oldest to newest):
${conversationText}

Propose at most one action by calling a tool, or no tool if any criterion above isn't satisfied.`;

  let proposed: any = null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       'claude-haiku-4-5-20251001',
        max_tokens:  500,
        system:      systemPrompt,
        tools,
        tool_choice: { type: 'auto' },
        messages:    [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[draft-reply] resolveAgentAction Anthropic error:', JSON.stringify(data));
      return null;
    }

    // Parse tool_use blocks from the content array
    const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
    if (!toolUse) {
      console.log('[draft-reply] resolveAgentAction: model declined to call a tool');
      return null;
    }

    const args = toolUse.input || {};
    if (toolUse.name === 'place_pickup_order') {
      if (!args.pickup_date || !args.pickup_window || !args.bags) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.pickup_date)) return null;
      if (args.pickup_date < todayPT()) return null;
      proposed = {
        type:               'place_pickup_order',
        customer_id:        customerId,
        pickup_date:        args.pickup_date,
        pickup_window:      args.pickup_window,
        bags:               args.bags,
        same_day_delivery:  !!args.same_day_delivery,
        notes:              args.notes || null,
        rationale:          args.rationale || '',
        confirmation_draft: args.confirmation_draft || '',
      };
    } else if (toolUse.name === 'reschedule_order') {
      if (!args.order_id || !args.new_date || !args.new_window || !args.leg) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.new_date)) return null;
      if (args.new_date < todayPT()) return null;
      const target = activeOrders.find((o: any) => o.order_id === args.order_id);
      if (!target) return null;
      proposed = {
        type:               'reschedule_order',
        order_id:           target.order_id,
        order_number:       target.order_number,
        leg:                args.leg,
        new_date:           args.new_date,
        new_window:         args.new_window,
        rationale:          args.rationale || '',
        confirmation_draft: args.confirmation_draft || '',
      };
    } else {
      return null;
    }
  } catch (e) {
    console.warn('[draft-reply] resolveAgentAction failed:', e);
    return null;
  }

  if (!proposed) return null;

  // ── Server-side dry-run validation ──
  // Calls the same RPC the admin will invoke on Confirm, with p_dry_run=true.
  // If validation fails (no template, address has no coords, status not
  // reschedulable, etc.) we drop the proposal so the admin doesn't see a card
  // that will fail at click-time.
  let dryRun;
  if (proposed.type === 'place_pickup_order') {
    dryRun = await callRpcAsAdmin(adminJwt, 'place_pickup_order_for_customer', {
      p_customer_id:        proposed.customer_id,
      p_pickup_date:        proposed.pickup_date,
      p_pickup_window:      proposed.pickup_window,
      p_bags:               proposed.bags,
      p_same_day_delivery:  proposed.same_day_delivery,
      p_notes:              proposed.notes,
      p_actor_name:         'Agent (dry-run)',
      p_dry_run:            true,
    });
  } else {
    dryRun = await callRpcAsAdmin(adminJwt, 'reschedule_order_to_window', {
      p_order_id:    proposed.order_id,
      p_leg:         proposed.leg,
      p_new_date:    proposed.new_date,
      p_new_window:  proposed.new_window,
      p_actor_name:  'Agent (dry-run)',
      p_dry_run:     true,
    });
  }

  if (!dryRun.ok) {
    console.warn(`[draft-reply] dry-run failed for ${proposed.type}:`, JSON.stringify(dryRun.data));
    return null;
  }

  // Embed resolved values into the action so the card shows what will actually
  // be booked, not just what Claude proposed loosely.
  const r = dryRun.data || {};
  if (proposed.type === 'place_pickup_order') {
    const startStr = fmtTimeShort(r.pickup_window_start);
    const endStr   = fmtTimeShort(r.pickup_window_end);
    const dateLabel = new Date(proposed.pickup_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ });
    proposed.resolved_window     = `${startStr}–${endStr}`;
    proposed.resolved_template   = r.template_name || '';
    proposed.label               = `New pickup — ${dateLabel}, ${startStr}–${endStr}, ${proposed.bags} bag${proposed.bags !== 1 ? 's' : ''}${proposed.same_day_delivery ? ' (same-day)' : ''}${r.template_name ? ` · ${r.template_name}` : ''}`;
  } else {
    const startStr = fmtTimeShort(r.new_window_start);
    const endStr   = fmtTimeShort(r.new_window_end);
    const dateLabel = new Date(proposed.new_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ });
    proposed.resolved_window     = `${startStr}–${endStr}`;
    proposed.resolved_template   = r.new_route_name || '';
    proposed.label               = `Move ${proposed.leg} of #${proposed.order_number} → ${dateLabel}, ${startStr}–${endStr}${r.new_route_name ? ` · ${r.new_route_name}` : ''}`;
  }

  return proposed;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    if (!ANTHROPIC_KEY) {
      console.error('[draft-reply] ANTHROPIC_API_KEY secret not set');
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500, headers: CORS });
    }

    const adminJwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();

    const { customer_id, phone, current_draft, admin_profile_id } = await req.json();
    if (!customer_id && !phone) {
      return new Response(JSON.stringify({ error: 'customer_id or phone is required' }), { status: 400, headers: CORS });
    }

    const isRefineMode = typeof current_draft === 'string' && current_draft.trim().length > 0;
    console.log(`[draft-reply] mode=${isRefineMode ? 'refine' : 'generate'} customer=${customer_id || phone}`);

    // ── 1. Customer ──
    let customer: any = null;
    if (customer_id) {
      const rows = await dbGet(`customers?id=eq.${customer_id}&select=id,first_name_cache,last_name_cache,phone_cache,address_cache&limit=1`);
      customer = Array.isArray(rows) ? rows[0] : null;
    }
    const customerFirstName = customer?.first_name_cache?.trim() || '';
    const customerName = customer
      ? `${customerFirstName} ${customer.last_name_cache || ''}`.trim() || phone
      : (phone || 'Customer');

    // ── 2. Conversation ──
    let msgPath = `sms_messages?order=created_at.desc&limit=20&select=direction,body,created_at`;
    if (customer_id) msgPath += `&customer_id=eq.${customer_id}`;
    else             msgPath += `&or=(from_number.eq.${phone},to_number.eq.${phone})`;
    const msgsRaw = await dbGet(msgPath);
    const msgs    = Array.isArray(msgsRaw) ? msgsRaw.reverse() : [];

    const conversationText = msgs.length > 0
      ? msgs.map((m: any) => {
          const role = m.direction === 'inbound' ? 'Customer' : 'Family Laundry';
          const ts   = m.created_at
            ? new Date(m.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: BIZ_TZ })
            : '';
          return `[${ts}] ${role}: ${m.body}`;
        }).join('\n')
      : '(no message history)';

    // ── 3. Intent ──
    const lastInbound = [...msgs].reverse().find((m: any) => m.direction === 'inbound');
    const intent      = lastInbound ? detectIntent(lastInbound.body || '') : 'general';
    const intentGuide = INTENT_INSTRUCTION[intent] || INTENT_INSTRUCTION.general;
    console.log(`[draft-reply] intent=${intent}`);

    // ── 4. Recent orders + primary address (for context AND tool-calling) ──
    let orderContext = 'No recent orders found.';
    let orderRows: any[] = [];
    if (customer_id) {
      const ordRows = await dbGet(
        `orders?customer_id=eq.${customer_id}&order=created_at.desc&select=id,order_number,status,pickup_window_start,pickup_window_end,delivery_window_start,delivery_window_end,total_bags,total_amount,recurring_interval&limit=5`
      );
      orderRows = Array.isArray(ordRows) ? ordRows : [];
      if (orderRows.length > 0) {
        orderContext = orderRows.slice(0, 2).map((o: any) => {
          const pu = `${fmtDate(o.pickup_window_start)} ${fmtWindow(o.pickup_window_start, o.pickup_window_end)}`.trim();
          const dl = `${fmtDate(o.delivery_window_start)} ${fmtWindow(o.delivery_window_start, o.delivery_window_end)}`.trim();
          return `Order #${o.order_number}: status=${o.status}, pickup=${pu || 'TBD'}, delivery=${dl || 'TBD'}, bags=${o.total_bags || '?'}, $${Number(o.total_amount || 0).toFixed(2)}${o.recurring_interval ? ' [recurring]' : ''}`;
        }).join('\n');
      }
    }

    let primaryAddressLine = '';
    if (customer_id) {
      const addrRows = await dbGet(
        `addresses?customer_id=eq.${customer_id}&order=is_default.desc.nullslast,created_at.desc&limit=1&select=line1,city,state,zip`
      );
      const addr = Array.isArray(addrRows) ? addrRows[0] : null;
      if (addr) {
        primaryAddressLine = [addr.line1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      }
    }

    // ── 5. Resolve action (generate mode only) ──
    let action: any = null;
    if (!isRefineMode && customer_id) {
      if (intent === 'skip_request') {
        action = await resolveSkipAction(customer_id, customerFirstName);
      } else if (intent === 'new_order' || intent === 'reschedule_request') {
        const { summary: zoneSummary } = await fetchZoneAvailability(customer_id);
        action = await resolveAgentAction(
          customer_id, customerName, customerFirstName,
          conversationText, orderRows, primaryAddressLine,
          zoneSummary, adminJwt
        );
      }
      if (action) console.log(`[draft-reply] action=${action.type}`);
    }

    // ── 6. Voice mining ──
    const voiceExamples = await fetchVoiceExamples();
    const voiceSection  = voiceExamples
      ? `Here are recent real replies sent by the Family Laundry team. Match this voice exactly:\n${voiceExamples}`
      : '';

    // ── 7. System prompt for the free-form draft ──
    // session 144: tone tightened.
    const systemPrompt = `You are a writing assistant for Family Laundry, a laundry pickup and delivery service in the East Bay. You help the admin team compose SMS replies to customers.

Voice and style rules:
- SHORT: 1 to 3 sentences maximum.
- Use the customer's first name at the start if you have it.
- Direct and specific — always include actual dates, times, or amounts when available from the order data.
- Subdued and professional. Warm without being effusive.
- AVOID exclamation points. Default to declarative statements. Reserve "!" for genuine moments of empathy or apology, never for routine confirmations.
- No emojis. No markdown. No bullet points. Plain SMS text only.
- Do not add sign-offs like "Family Laundry" or "the team" — the customer knows who they're texting.
- Never make up information you do not have.

${voiceSection}

IMPORTANT: Return ONLY the message text. No labels, no quotes, no explanation, no preamble.`;

    // ── 8. User prompt ──
    let userPrompt: string;

    if (isRefineMode) {
      userPrompt = `Customer name: ${customerName}\n\nRecent orders:\n${orderContext}\n\nConversation history:\n${conversationText}\n\nThe admin has already drafted this reply:\n---\n${current_draft.trim()}\n---\n\nPlease refine this draft for clarity, grammar, and tone while preserving the admin's intent and all specific details (names, times, amounts, addresses). Strip exclamation points unless they're carrying real emotional weight. Do not change the meaning. Return only the improved message text.`;
    } else {
      userPrompt = `Customer name: ${customerName}\n\nRecent orders:\n${orderContext}\n\nConversation history (oldest to newest):\n${conversationText}\n\nWhat the customer is asking about: ${intent.replace(/_/g, ' ')}\nDrafting guidance: ${intentGuide}\n\nDraft a reply to the customer's most recent message.`;
    }

    // ── 9. Anthropic call (text draft) ──
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 220,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const result = await anthropicRes.json();
    if (!anthropicRes.ok) {
      console.error('[draft-reply] Anthropic error:', JSON.stringify(result));
      return new Response(JSON.stringify({ error: 'AI service error', detail: result.error?.message || result }), { status: 502, headers: CORS });
    }

    const draft = (result.content?.[0]?.text || '').trim();
    console.log(`[draft-reply] Done: mode=${isRefineMode ? 'refine' : 'generate'} intent=${intent} chars=${draft.length} action=${action?.type || 'none'}`);

    // ── Usage log (fire-and-forget) ──
    fetch(`${SUPABASE_URL}/rest/v1/draft_events`, {
      method: 'POST',
      headers: { ...dbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        admin_profile_id: admin_profile_id || null,
        customer_id:      customer_id || null,
        phone:            phone || null,
        intent,
        mode:             isRefineMode ? 'refine' : 'generate',
        action_type:      action?.type || null,
      }),
    }).catch(e => console.warn('[draft-reply] Usage log failed:', e));

    // If the agent action came with a confirmation_draft, prefer that for the
    // composer so the message and the action stay in sync. Otherwise use the
    // free-form draft.
    const finalDraft = (action && action.confirmation_draft) ? action.confirmation_draft : draft;

    return new Response(JSON.stringify({
      ok:     true,
      draft:  finalDraft,
      intent,
      mode:   isRefineMode ? 'refine' : 'generate',
      action: action || null,
    }), { headers: CORS });

  } catch (e) {
    console.error('[draft-reply] Unhandled error:', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
});
