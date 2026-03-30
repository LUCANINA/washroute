import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SVC_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Content-Type': 'application/json',
};

// ── Intent detection ──
function detectIntent(msg: string): string {
  const m = msg.toLowerCase();
  if (/price|cost|how much|rate|per bag|per pound|fee|charge|pricing|breakdown/.test(m))  return 'pricing_inquiry';
  if (/reschedule|move my|change.*time|change.*date|different day|different time|postpone|earlier|later|can you pick up|pickup.*day|move.*pickup|move.*delivery/.test(m)) return 'reschedule_request';
  if (/where is|where.*order|status|update|eta|when.*arriv|how long|still coming|on the way|pick.*up.*yet|picked up|delivered|my order|my laundry|tracking/.test(m)) return 'status_check';
  if (/pay|payment|card|charge|bill|invoice|refund|credit|billing|transaction/.test(m))   return 'payment_issue';
  if (/problem|issue|wrong|missing|lost|damage|complain|never|didn.t|not happy|upset|frustrated|mistake|error/.test(m)) return 'complaint';
  if (/cancel|stop service|don.t need|no longer|end my/.test(m))                           return 'cancellation';
  if (/skip|no laundry this|not this week|don.t have laundry|no pickup this|away|out of town|traveling|vacation|pause/.test(m)) return 'skip_request';
  if (/new order|book|schedule.*pickup|want.*pickup|need.*pickup|sign.*up|add.*address/.test(m)) return 'new_order';
  return 'general';
}

const INTENT_INSTRUCTION: Record<string, string> = {
  pricing_inquiry:   'The customer is asking about pricing. Our rates: $59 per bag (up to 25 lbs), $3/lb for each pound over 25, plus a $9.95 pickup and delivery fee. Be clear and specific. Do not guess at other charges.',
  reschedule_request:'The customer wants to reschedule. Acknowledge the request warmly and confirm what time you can offer — use the order data if available. Note that the actual change still needs to be made in the admin dashboard; the draft should tell the customer what you are doing.',
  status_check:      'The customer wants a status update. Use the order data provided to give a specific, accurate answer — pickup date, time window, or delivery window. Do not guess or make up times.',
  payment_issue:     'The customer has a billing or payment question. Be empathetic and direct. If it is a failed payment, let them know and ask them to update their card in the app at app.familylaundry.com.',
  complaint:         'The customer is frustrated or reporting a problem. Open with a genuine apology. Do not make excuses. Offer a clear next step or ask what would make it right.',
  cancellation:      'The customer may want to cancel or pause service. Acknowledge warmly and without pressure. Ask if there is anything we can do to help.',
  skip_request:      'The customer wants to skip a pickup. Confirm that the skip has been noted and when we will see them next.',
  new_order:         'The customer wants to book a pickup or is asking about starting service. Be enthusiastic and direct them to book at app.familylaundry.com, or offer to help manually.',
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
    return `${fmt(new Date(s))}\u2013${fmt(new Date(e))}`;
  } catch { return ''; }
}

// ── Fetch real admin voice examples from sms_messages ──
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
      `&order=created_at.desc&limit=60` +
      `&select=body,customer_id,created_at`
    );
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const seen = new Set<string>();
    const examples: string[] = [];
    for (const row of rows) {
      const body = (row.body || '').trim();
      if (!body || seen.has(body) || body.length < 15) continue;
      seen.add(body);
      examples.push(`"${body}"`);
      if (examples.length >= 8) break;
    }
    return examples.length > 0 ? examples.join('\n') : '';
  } catch (e) {
    console.warn('[draft-reply] fetchVoiceExamples failed:', e);
    return '';
  }
}

// ── Resolve action for skip_request ──
// Returns a structured action object the admin UI can render as an action card.
// Only resolves for recurring orders — one-time orders can't be "skipped" the same way.
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
      // Pre-written confirmation the admin can edit before sending
      confirmation_draft: `Got it, ${firstName} — we'll skip your ${pickupLabel} pickup. See you next time!`,
    };
  } catch (e) {
    console.warn('[draft-reply] resolveSkipAction failed:', e);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  try {
    if (!ANTHROPIC_KEY) {
      console.error('[draft-reply] ANTHROPIC_API_KEY secret not set');
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500, headers: CORS });
    }

    const { customer_id, phone, current_draft, admin_profile_id } = await req.json();
    if (!customer_id && !phone) {
      return new Response(JSON.stringify({ error: 'customer_id or phone is required' }), { status: 400, headers: CORS });
    }

    const isRefineMode = typeof current_draft === 'string' && current_draft.trim().length > 0;
    console.log(`[draft-reply] mode=${isRefineMode ? 'refine' : 'generate'} customer=${customer_id || phone}`);

    // ── 1. Fetch customer ──
    let customer: any = null;
    if (customer_id) {
      const rows = await dbGet(`customers?id=eq.${customer_id}&select=id,first_name_cache,last_name_cache,phone_cache,address_cache&limit=1`);
      customer = Array.isArray(rows) ? rows[0] : null;
    }
    const customerFirstName = customer?.first_name_cache?.trim() || '';
    const customerName = customer
      ? `${customerFirstName} ${customer.last_name_cache || ''}`.trim() || phone
      : (phone || 'Customer');

    // ── 2. Fetch SMS history ──
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

    // ── 3. Detect intent from the last inbound message ──
    const lastInbound = [...msgs].reverse().find((m: any) => m.direction === 'inbound');
    const intent      = lastInbound ? detectIntent(lastInbound.body || '') : 'general';
    const intentGuide = INTENT_INSTRUCTION[intent] || INTENT_INSTRUCTION.general;
    console.log(`[draft-reply] intent=${intent}`);

    // ── 4. Fetch recent order context ──
    let orderContext = 'No recent orders found.';
    if (customer_id) {
      const ordRows = await dbGet(
        `orders?customer_id=eq.${customer_id}&order=created_at.desc&select=order_number,status,pickup_window_start,pickup_window_end,delivery_window_start,delivery_window_end,total_bags,total_amount,recurring_interval&limit=2`
      );
      const orders = Array.isArray(ordRows) ? ordRows : [];
      if (orders.length > 0) {
        orderContext = orders.map((o: any) => {
          const pu = `${fmtDate(o.pickup_window_start)} ${fmtWindow(o.pickup_window_start, o.pickup_window_end)}`.trim();
          const dl = `${fmtDate(o.delivery_window_start)} ${fmtWindow(o.delivery_window_start, o.delivery_window_end)}`.trim();
          return `Order #${o.order_number}: status=${o.status}, pickup=${pu || 'TBD'}, delivery=${dl || 'TBD'}, bags=${o.total_bags || '?'}, $${Number(o.total_amount || 0).toFixed(2)}${o.recurring_interval ? ' [recurring]' : ''}`;
        }).join('\n');
      }
    }

    // ── 5. Resolve action (generate mode only) ──
    // In refine mode the admin is editing — don't surface action cards.
    let action: any = null;
    if (!isRefineMode && customer_id && intent === 'skip_request') {
      action = await resolveSkipAction(customer_id, customerFirstName);
      if (action) console.log(`[draft-reply] action=skip order=${action.order_number}`);
      else        console.log(`[draft-reply] skip_request but no upcoming recurring order found`);
    }

    // ── 6. Fetch real admin voice examples ──
    const voiceExamples = await fetchVoiceExamples();
    const voiceSection  = voiceExamples
      ? `Here are recent real replies sent by the Family Laundry team. Match this voice exactly:\n${voiceExamples}`
      : '';

    // ── 7. Build system prompt ──
    const systemPrompt = `You are a writing assistant for Family Laundry, a laundry pickup and delivery service in the East Bay. You help the admin team compose SMS replies to customers.

Voice and style rules:
- SHORT: 1 to 3 sentences maximum
- Use the customer's first name at the start if you have it
- Direct and specific — always include actual dates, times, or amounts when available from the order data
- Warm but not overly casual. Not corporate.
- No emojis. No markdown. No bullet points. Plain SMS text only.
- Do not add sign-offs like "Family Laundry" or "the team" — the customer knows who they're texting.
- Never make up information you do not have.

${voiceSection}

IMPORTANT: Return ONLY the message text. No labels, no quotes, no explanation, no preamble.`;

    // ── 8. Build user prompt based on mode ──
    let userPrompt: string;

    if (isRefineMode) {
      userPrompt = `Customer name: ${customerName}

Recent orders:
${orderContext}

Conversation history:
${conversationText}

The admin has already drafted this reply:
---
${current_draft.trim()}
---

Please refine this draft for clarity, grammar, and tone while preserving the admin's intent and all specific details (names, times, amounts, addresses). Do not change the meaning. Return only the improved message text.`;
    } else {
      userPrompt = `Customer name: ${customerName}

Recent orders:
${orderContext}

Conversation history (oldest to newest):
${conversationText}

What the customer is asking about: ${intent.replace(/_/g, ' ')}
Drafting guidance: ${intentGuide}

Draft a reply to the customer's most recent message.`;
    }

    // ── 9. Call Anthropic ──
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

    // ── Log usage to draft_events (fire-and-forget, never blocks the response) ──
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

    return new Response(JSON.stringify({
      ok:     true,
      draft,
      intent,
      mode:   isRefineMode ? 'refine' : 'generate',
      action: action || null,   // null when no actionable intent or no matching order
    }), { headers: CORS });

  } catch (e) {
    console.error('[draft-reply] Unhandled error:', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
});
