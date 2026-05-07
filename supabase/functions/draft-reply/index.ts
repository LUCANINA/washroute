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
  reschedule_request:'The customer wants to reschedule. Acknowledge by COMMITTING to a specific new time using the order data; do not ask multiple clarifying questions. End with a soft invite to adjust if the proposed time doesn\'t work.',
  status_check:      'The customer wants a status update. Use the order data provided to give a specific, accurate answer — pickup date, time window, or delivery window. Do not guess or make up times.',
  payment_issue:     'The customer has a billing or payment question. Be empathetic and direct. If it is a failed payment, let them know and ask them to update their card in the app at app.familylaundry.com.',
  complaint:         'The customer is frustrated or reporting a problem. Open with a genuine apology. Do not make excuses. Offer a clear next step or ask what would make it right.',
  cancellation:      'The customer may want to cancel or pause service. Acknowledge and ask if there is anything we can do to help. Do not pressure them.',
  skip_request:      'The customer wants to skip a pickup. Confirm that the skip has been noted and when we will see them next. Plain confirmation, not effusive.',
  new_order:         'The customer wants to book a pickup. ACT FIRST: commit to a concrete proposal using their stated date+window plus their default bag count from history. Do NOT ask clarifying questions like "what time works best?" — pick the most specific available window and end with a single soft invite to adjust if needed. Brief is better than thorough here.',
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
    // schedule_days convention in WashRoute: 0=Mon, 1=Tue, ... 6=Sun.
    // (Matches ISODOW-1 used by auto_route_order, generate_route_runs, etc.)
    // NOT Postgres EXTRACT(DOW) which is 0=Sun..6=Sat.
    const DOW_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
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

  // session 144 v17: surface a default bag count from the customer's most
  // recent order (any status — delivered/cancelled/skipped fine) so the AI
  // doesn't decline place_pickup_order just because the current SMS doesn't
  // mention bags. The "act on defaults" philosophy.
  const lastOrder = (orderContextRaw || [])[0];
  const defaultBags = (lastOrder && Number(lastOrder.total_bags) > 0) ? Number(lastOrder.total_bags) : null;

  // session 144 v18: removed confirmation_draft from the tool schemas. Claude
  // generates the action params + a rationale + an optional delivery_preference
  // (raw text of what the customer asked for, if anything). The server then
  // builds the confirmation_draft AFTER dry-run from a deterministic template
  // using the ACTUAL resolved sub-window times. Eliminates the bug where the
  // AI wrote the template's full window (e.g. "7-11 AM") while the routing
  // engine books only the first sub-window (e.g. "7-9 AM"), and where the AI
  // hallucinated phrases like "the next service day" instead of the actual
  // delivery date.
  const tools = [
    {
      name: 'place_pickup_order',
      description: 'Propose booking a NEW pickup for the customer (and optionally an explicit delivery date+window). Defaults from customer profile. Reviewed by admin before execution.',
      input_schema: {
        type: 'object',
        properties: {
          pickup_date:        { type: 'string', description: 'YYYY-MM-DD, Pacific time. Must match a day in the available windows list.' },
          pickup_window:      { type: 'string', enum: ['AM','PM','evening'] },
          bags:               { type: 'integer', minimum: 1, maximum: 30 },
          same_day_delivery:  { type: 'boolean' },
          notes:              { type: 'string' },
          rationale:          { type: 'string', description: 'One sentence explaining what in the conversation supports this proposal.' },
          delivery_date:      { type: 'string', description: 'If the customer specified a delivery date (e.g. "Monday evening" → translate to YYYY-MM-DD), set both delivery_date and delivery_window. Must be after pickup_date and match a day in the available windows list. Leave empty if customer did not specify a delivery date.' },
          delivery_window:    { type: 'string', enum: ['AM','PM','evening'], description: 'Time-of-day label for the requested delivery window. Set together with delivery_date or leave empty.' },
          delivery_preference:{ type: 'string', description: 'Free-form short phrase capturing what the customer said about delivery (e.g. "Monday evening", "as soon as possible"). Used in the confirmation message even when you also supply delivery_date+delivery_window. Empty string if customer said nothing about delivery.' }
        },
        required: ['pickup_date','pickup_window','bags','rationale']
      }
    },
    {
      name: 'reschedule_order',
      description: 'Propose MOVING an existing pickup or delivery. Must reference an order_id from the active_orders list.',
      input_schema: {
        type: 'object',
        properties: {
          order_id:    { type: 'string' },
          leg:         { type: 'string', enum: ['pickup','delivery'] },
          new_date:    { type: 'string' },
          new_window:  { type: 'string', enum: ['AM','PM','evening'] },
          rationale:   { type: 'string' }
        },
        required: ['order_id','leg','new_date','new_window','rationale']
      }
    }
  ];

  const systemPrompt = `You are an action-proposal assistant for Family Laundry, a laundry pickup and delivery service in the East Bay (Pacific time).

Your job: propose AT MOST ONE structured action by calling either place_pickup_order or reschedule_order. **Act on reasonable defaults rather than asking the customer for clarification.** The confirmation_draft is your channel to invite a change if needed — it should commit to a specific time first, then offer a soft invite to adjust.

## ACT FIRST PHILOSOPHY (v17)

The customer doesn't want a 5-message back-and-forth to confirm details. If you have enough to propose with reasonable defaults — propose. Only DECLINE (no tool) when you have GENUINE ambiguity that a default can't resolve:

- Two or more active orders that the customer's reference doesn't disambiguate → decline.
- A date that isn't in the available_windows list → decline.
- A vague non-date ("sometime", "whenever") → decline.
- A request the tool can't express at all (e.g., specific hour-tweak within a sub-window) → decline.

What is NOT a reason to decline:
- Customer didn't specify bags → use the default_bags value from the user message.
- Customer didn't specify which leg of an order to reschedule → if it's a "move my pickup" / "earlier pickup" → leg=pickup. If "deliver later" / "drop off later" → leg=delivery.
- Customer mentions a delivery date/window preference → the place_pickup_order tool ONLY books the pickup; delivery is computed automatically from the zone's turnaround. Acknowledge their delivery preference in the confirmation_draft, propose the pickup, and note that the admin can adjust delivery if the auto-computed time doesn't work.

## Date interpretation

- Today's date in Pacific time is ${todayPT()}.
- "tomorrow" → today + 1 day.
- "next [weekday]" → the soonest occurrence of that weekday at least 3 days out.
- "this [weekday]" → the soonest occurrence of that weekday in the next 6 days.
- Bare day name like "Thursday" with no "this"/"next" → the soonest occurrence in the next 6 days.
- Vague phrases ("sometime next week", "soon", "whenever you can") → do NOT call a tool.

## Available windows constraint

The user message lists the customer's zone's available pickup windows. You MUST only propose a date+window combination that exists in that list. If the customer asks for a day or window that isn't available, do NOT call a tool.

## Window-of-day labels

- AM = template starts before 12:00.
- PM = template starts 12:00–16:59.
- evening = template starts 17:00 or later.
- "early morning" or "7am" → AM if available.
- "after work" or "around 6" → evening if available, else PM.
- Hour-specific requests ("can you come at 2pm"): propose the available window that covers that hour with rationale noting the exact-hour ask. If no window covers it, decline.

## Bags

- If the customer specifies a number, use it.
- If they don't, USE THE default_bags value from the user message — that's the customer's most recent bag count. Don't ask.
- If default_bags is null, propose 1 bag (sensible single-person default) rather than declining.

## Reschedule scope

- pickup leg can only be moved while the order status is 'scheduled'.
- delivery leg can be moved through 'ready_for_delivery'.
- If two or more active orders match the customer's reference equally well, decline.

## You do NOT write the confirmation message

The confirmation SMS sent back to the customer is generated by the server AFTER your tool call, using the actual resolved pickup and delivery sub-window times from the routing engine. You only need to:

1. Call the right tool with correct parameters.
2. Provide a one-sentence rationale.
3. For place_pickup_order: if the customer mentioned a delivery preference the tool can't directly book (e.g. "Monday evening", "delivered same day"), capture that as a short phrase in the delivery_preference field. The server will incorporate it into the confirmation. If the customer didn't mention any delivery preference, leave delivery_preference empty.

## Worked examples

Example A — clear new pickup with delivery preference (RECOMMENDED PATTERN):
  Available: Mon/Tue/Wed/Thu/Fri/Sat 07:00–11:00 (AM, Berkeley AM, turnaround 1d)
             Mon/Tue/Wed/Thu/Fri/Sat 18:00–22:00 (evening, Berkeley PM, turnaround 1d)
  Today: 2026-05-07 (Wed). default_bags from history: 1.
  Customer: "I'd like to place a pickup tomorrow morning, returning Monday evening."
  → Tool: place_pickup_order {
      pickup_date: "2026-05-08", pickup_window: "AM", bags: 1, same_day_delivery: false,
      delivery_date: "2026-05-11", delivery_window: "evening",
      delivery_preference: "Monday evening",
      rationale: "Customer asked for tomorrow morning pickup, Monday evening delivery; last order was 1 bag. Both legs explicitly booked."
    }
  When the customer specifies a delivery preference that maps to a real available window, ALWAYS set delivery_date AND delivery_window so the booking honors it. Also set delivery_preference (free-form text) so the confirmation message echoes the customer's wording.

Example B — reschedule with single clear target:
  Active orders: one scheduled pickup #3850 Wed AM.
  Customer: "Need to push my pickup to Friday morning"
  → Tool: reschedule_order {
      order_id: "<#3850 uuid>", leg: "pickup", new_date: "<Friday>", new_window: "AM",
      rationale: "Move scheduled Wed AM pickup to Fri AM as requested."
    }

Example C — ambiguous, decline:
  Active orders: 2 (one pickup #3801, one delivery #3850).
  Customer: "Can we change the time?"
  → Do NOT call a tool. Two orders, no signal which one.

Example D — day not available in zone:
  Available: Mon/Wed/Fri only.
  Customer: "Pickup Tuesday morning?"
  → Do NOT call a tool. Tuesday isn't in the available list.

Example E — vague timing:
  Customer: "Sometime next week works"
  → Do NOT call a tool. No specific day to commit to.

Example F — bag count missing AND no default:
  default_bags: null.
  Customer: "Pickup tomorrow morning"
  → Tool: place_pickup_order { pickup_date, pickup_window, bags: 1, delivery_preference: "" } with rationale "no order history; defaulting to 1 bag".

Example G — hour-tweak that can't be expressed:
  Customer: "Can you come an hour earlier than usual?"
  → Do NOT call a tool. Sub-window granularity is fixed by templates.`;

  const userPrompt = `Customer: ${customerName}${customerFirstName ? ` (first name: ${customerFirstName})` : ''}
Primary address: ${primaryAddressLine || '(no saved address — do not propose place_pickup_order)'}
default_bags: ${defaultBags !== null ? defaultBags : 'null (no order history)'}

Available pickup windows for this customer's zone:
${zoneSummary}

Active orders (eligible for reschedule):
${activeOrders.length > 0 ? JSON.stringify(activeOrders, null, 2) : '(none)'}

Conversation history (oldest to newest):
${conversationText}

Propose at most one action by calling a tool, applying defaults where appropriate. Decline only on genuine ambiguity (per the system prompt).`;

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

      // Optional explicit delivery — both fields together or neither.
      let deliveryDate: string | null = (args.delivery_date || '').trim() || null;
      let deliveryWindow: string | null = (args.delivery_window || '').trim() || null;
      if (deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) deliveryDate = null;
      if (deliveryWindow && !['AM','PM','evening'].includes(deliveryWindow)) deliveryWindow = null;
      // If the AI supplied one without the other, drop both — the RPC requires
      // both-or-neither and we'd rather fall through to auto-compute than fail.
      if ((deliveryDate && !deliveryWindow) || (!deliveryDate && deliveryWindow)) {
        deliveryDate = null;
        deliveryWindow = null;
      }
      // If delivery date is in the past or before pickup, drop it.
      if (deliveryDate && deliveryDate < todayPT()) { deliveryDate = null; deliveryWindow = null; }
      if (deliveryDate && deliveryDate <= args.pickup_date && !args.same_day_delivery) {
        deliveryDate = null; deliveryWindow = null;
      }

      proposed = {
        type:                'place_pickup_order',
        customer_id:         customerId,
        pickup_date:         args.pickup_date,
        pickup_window:       args.pickup_window,
        bags:                args.bags,
        same_day_delivery:   !!args.same_day_delivery,
        notes:               args.notes || null,
        rationale:           args.rationale || '',
        delivery_date:       deliveryDate,
        delivery_window:     deliveryWindow,
        delivery_preference: (args.delivery_preference || '').trim(),
        // confirmation_draft built by server after dry-run, see below.
      };
    } else if (toolUse.name === 'reschedule_order') {
      if (!args.order_id || !args.new_date || !args.new_window || !args.leg) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.new_date)) return null;
      if (args.new_date < todayPT()) return null;
      const target = activeOrders.find((o: any) => o.order_id === args.order_id);
      if (!target) return null;
      proposed = {
        type:         'reschedule_order',
        order_id:     target.order_id,
        order_number: target.order_number,
        leg:          args.leg,
        new_date:     args.new_date,
        new_window:   args.new_window,
        rationale:    args.rationale || '',
        // confirmation_draft built by server after dry-run, see below.
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
      p_delivery_date:      proposed.delivery_date,
      p_delivery_window:    proposed.delivery_window,
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

  // If the AI proposed an explicit delivery_date+window that has no matching
  // template (e.g. customer asked for "Sunday delivery" in a Mon-Sat zone),
  // retry the dry-run without explicit delivery — we'd rather book the pickup
  // with auto-computed delivery and let the admin adjust than drop the
  // proposal entirely.
  if (!dryRun.ok && proposed.type === 'place_pickup_order' && (proposed.delivery_date || proposed.delivery_window)) {
    const errMsg = String(dryRun.data?.message || dryRun.data?.error || '');
    if (errMsg.includes('delivery zone+')) {
      console.warn(`[draft-reply] explicit delivery rejected (${errMsg}); retrying with auto-compute`);
      proposed.delivery_date = null;
      proposed.delivery_window = null;
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
    }
  }

  if (!dryRun.ok) {
    console.warn(`[draft-reply] dry-run failed for ${proposed.type}:`, JSON.stringify(dryRun.data));
    return null;
  }

  // Embed resolved values into the action so the card shows what will actually
  // be booked, not just what Claude proposed loosely. ALSO build the
  // confirmation_draft server-side from a deterministic template using the
  // dry-run's actual resolved sub-window times — Claude no longer writes
  // this string, so it can't hallucinate "the next service day" or use the
  // template's full window when only a sub-window is booked.
  const r = dryRun.data || {};
  const fname = customerFirstName || 'there';

  if (proposed.type === 'place_pickup_order') {
    const pStart = fmtTimeShort(r.pickup_window_start);
    const pEnd   = fmtTimeShort(r.pickup_window_end);
    const pickupDateLabel = new Date(proposed.pickup_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ });
    const pickupDayLong   = new Date(proposed.pickup_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: BIZ_TZ });

    const dStart = fmtTimeShort(r.delivery_window_start);
    const dEnd   = fmtTimeShort(r.delivery_window_end);
    const deliveryDateShort = r.delivery_window_start
      ? new Date(r.delivery_window_start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ })
      : '';
    const deliveryDayLong = r.delivery_window_start
      ? new Date(r.delivery_window_start).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: BIZ_TZ })
      : '';

    proposed.resolved_window           = `${pStart}–${pEnd}`;
    proposed.resolved_template         = r.template_name || '';
    proposed.resolved_delivery_template = r.delivery_template_name || r.template_name || '';

    // Two-line summary fields the admin client uses to render pickup +
    // delivery on the action card. The single-line label is preserved as a
    // fallback for older client code paths.
    proposed.pickup_summary   = `Pickup — ${pickupDateLabel}, ${pStart}–${pEnd}, ${proposed.bags} bag${proposed.bags !== 1 ? 's' : ''}${r.template_name ? ` · ${r.template_name}` : ''}`;
    proposed.delivery_summary = deliveryDateShort
      ? `Delivery — ${deliveryDateShort}, ${dStart}–${dEnd}${proposed.resolved_delivery_template ? ` · ${proposed.resolved_delivery_template}` : ''}`
      : '';
    proposed.label = `${proposed.pickup_summary}${proposed.delivery_summary ? ' / ' + proposed.delivery_summary : ''}`;

    // Build confirmation_draft from template using ACTUAL resolved values.
    // If we honored an explicit delivery_date, the customer's "preference"
    // matches the booking — no need for the "let us know" adjustment line.
    // If we fell back to auto-compute and the customer mentioned something,
    // include the soft invite to adjust.
    let msg = `Hi ${fname}, pickup is set for ${pickupDayLong}, ${pStart}–${pEnd}.`;
    if (deliveryDayLong) {
      msg += ` Delivery is scheduled for ${deliveryDayLong}, ${dStart}–${dEnd}.`;
    }
    const honoredExplicit = !!proposed.delivery_date;
    const pref = (proposed.delivery_preference || '').trim();
    if (honoredExplicit) {
      msg += ` Reply if you'd like to adjust anything.`;
    } else if (pref) {
      msg += ` You mentioned ${pref} for delivery — let us know if you'd like us to move the delivery to that day.`;
    } else {
      msg += ` Reply if you'd like to change anything.`;
    }
    proposed.confirmation_draft = msg;
  } else {
    const startStr = fmtTimeShort(r.new_window_start);
    const endStr   = fmtTimeShort(r.new_window_end);
    const dateLabel = new Date(proposed.new_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: BIZ_TZ });
    const dateLong  = new Date(proposed.new_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: BIZ_TZ });

    proposed.resolved_window     = `${startStr}–${endStr}`;
    proposed.resolved_template   = r.new_route_name || '';
    proposed.label               = `Move ${proposed.leg} of #${proposed.order_number} → ${dateLabel}, ${startStr}–${endStr}${r.new_route_name ? ` · ${r.new_route_name}` : ''}`;

    proposed.confirmation_draft = `Hi ${fname}, your ${proposed.leg} is moved to ${dateLong}, ${startStr}–${endStr}. Reply if you'd like a different time.`;
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
