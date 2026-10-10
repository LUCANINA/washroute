// maya — Family Laundry's AI phone assistant (Retell). Phase 1: answer questions, take messages.
// Design: docs/washroute/DESIGN-AI-PHONE-ASSISTANT.md
//
// Routes (verify_jwt = FALSE — Retell cannot send a Supabase JWT; each route has its own check):
//   POST /maya/setup     header x-maya-admin (sha256 must match ADMIN_TOKEN_SHA256)  → create/update Maya's Retell LLM + agent. Body {voice_id?}
//   POST /maya/voices    header x-maya-admin  → female voice candidates with preview links
//   POST /maya/tool/info header x-maya-token  → live facts for Maya (prices, areas, hours, FAQ)
//   POST /maya/webhook   X-Retell-Signature   → call_analyzed → summary row in the admin inbox
//   POST /maya/inbound   X-Retell-Signature   → call_inbound (call is ringing) → recognise caller ID,
//                                                greet a known customer by first name
//   POST /maya/tool/account x-maya-token + X-Retell-Signature → caller's pickups/orders, ONLY after
//                                                they confirm their street name (caller ID can be spoofed)
//   POST /maya/tool/{find_times,check_address,book,skip,reschedule,cancel}  same checks → phone booking (phase 3)
//   POST /maya/admin-tool  x-maya-admin → run a booking tool as a given caller number, ALWAYS dry-run (tests)
//
// Writes: one inbound sms_messages row per call (+ recording). With BOOKING_LIVE: orders (book /
// reschedule), order status 'skipped' or 'cancelled' (cancel_pickups; cancelling ends a repeat series), and for new callers one customers + one addresses row; plus the
// normal 'confirmed' text via send-order-notification when the customer allows texts.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type Slot, findSlots, laterDelivery, decodeSlot, baseServiceId, customerBookingContext, upcomingPickups, insertOrder, geocode, ptDateFmt, priceEstimate, prefGroups, matchGroups, resolveAddons, addonLine }
  from './booking.ts';

// ── Phone booking switches (phase 3) ──
// BOOKING_LIVE=false: every booking tool runs all its checks but WRITES NOTHING and tells Maya to say
// it's a test. Flip only after David has tested on the test number.
// No card on file: same process as an app booking with no card (David, 2026-10-09) — at charging the
// order shows NO CARD in Issues and the customer gets the usual 'payment_failed' text if texts are on.
const BOOKING_LIVE = true; // go-live 2026-10-09 (David: tonight, book for real)

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SVC = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RETELL_KEY = Deno.env.get('RETELL_API_KEY') || '';
// Admin routes: SHA-256 of a private token (the token itself is never stored in the repo).
const ADMIN_TOKEN_SHA256 = 'acef397d4cc6f0eecedd6fd4c557cd14049cc9788c492031d18f7834bf479e64';
const RETELL = 'https://api.retellai.com';
const FN_URL = `${SUPABASE_URL}/functions/v1/maya`;
const AGENT_NAME = 'Maya — Family Laundry';
const LANGUAGES = ['en-US', 'es-419'];

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

async function sha256Hex(s: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Token Retell sends with Maya's tool calls. Derived from the Retell key, so no extra secret;
// rotating the Retell key rotates this too (then re-run /setup).
const toolToken = () => hmacHex(RETELL_KEY, 'maya-tool-v1');

function safeEq(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── Supabase REST (service role). Every call checks its result. ──
async function db(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SVC}`, apikey: SVC, 'Content-Type': 'application/json',
      Prefer: 'return=representation', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`db ${path.split('?')[0]} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function retell(path: string, method = 'GET', body?: unknown): Promise<any> {
  const res = await fetch(`${RETELL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${RETELL_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`retell ${method} ${path} ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// ── Live facts. Mirrors website/assets/fl-content.js tokenValue() so Maya quotes exactly
//    what the website shows. Never type a price here — everything comes from the DB. ──
function money(n: unknown) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return '$' + (Math.round(v * 100) % 100 === 0 ? String(Math.round(v)) : v.toFixed(2));
}
function list(a: string[] = []) {
  const x = a.filter(Boolean);
  return x.length <= 1 ? x.join('') : x.slice(0, -1).join(', ') + ' and ' + x[x.length - 1];
}
function priceText(p: any) {
  return p ? money(p.amount) + (p.type === 'per_lb' ? '/lb' : p.type === 'per_bag' ? ' per bag' : p.type === 'per_item' ? ' per item' : '') : null;
}
function tokenValue(kind: string, arg: string, v: any): string | null {
  switch (kind) {
    case 'price': return priceText((v.price || {})[arg]);
    case 'retail': return priceText((v.retail || {})[arg]);
    case 'commercial': return priceText((v.commercial || {})[arg]);
    case 'fee': return (v.fee || {})[arg] != null ? money(v.fee[arg]) : null;
    case 'plan': {
      const p = v.plan || {};
      if (arg === 'price' || arg === 'overage') return p[arg] != null ? money(p[arg]) : null;
      if (arg === 'lbs') return p.lbs != null ? String(p.lbs) : null;
      if (arg === 'name') return p.name || null;
      return null;
    }
    case 'referral': {
      const r = v.referral || {};
      return (arg === 'friend' || arg === 'referrer') && r[arg] != null ? money(r[arg]) : null;
    }
    case 'site': return v.site?.[arg] ? String(v.site[arg]) : null;
    case 'zones': return arg === 'cities' ? list(v.cities) : null;
  }
  return null;
}
const TOKEN_RE = /\{(price|retail|commercial|fee|plan|referral|site|zones):([^{}\n]{1,60})\}/g;
const fill = (t: string, v: any) =>
  t.replace(TOKEN_RE, (_m, k, a) => tokenValue(k, a.trim(), v) ?? '')
   .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function hm(t: string) {
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${ap}` : `${h12}${ap}`;
}

// ── Callers (phase 2) ──
const ptFmt = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', ...opts });
const ptDay = (iso: string) => ptFmt(iso, { weekday: 'long', month: 'long', day: 'numeric' });
const ptTime = (iso: string) => ptFmt(iso, { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
const ptWindow = (a?: string, b?: string) => a ? `${ptDay(a)}, ${ptTime(a)}${b ? '–' + ptTime(b) : ''}` : 'date not set';

// Oldest customer with this phone (find_customer_by_phone). 6 phones are shared by >1 customer (Oct 2026).
async function customerByPhone(phone?: string): Promise<any | null> {
  const d10 = String(phone || '').replace(/\D/g, '').slice(-10);
  if (d10.length !== 10) return null;
  const found = await db('rpc/find_customer_by_phone', { method: 'POST', body: JSON.stringify({ digits: d10 }) });
  const id = found?.[0]?.id;
  if (!id) return null;
  const rows = await db(`customers?id=eq.${id}&select=id,first_name_cache,last_name_cache,subscription_plan,last_order_at,last_delivered_order_at,cancelled_at,customer_type&limit=1`);
  return rows?.[0] || null;
}

// Street check: the caller says the street name of a saved address. House numbers, street types and
// directions are ignored; one letter of speech-to-text slip is tolerated on longer words.
const STREET_NOISE = new Set(['st', 'street', 'ave', 'av', 'avenue', 'blvd', 'boulevard', 'rd', 'road', 'dr', 'drive',
  'way', 'ln', 'lane', 'ct', 'court', 'pl', 'place', 'ter', 'terrace', 'cir', 'circle', 'pkwy', 'parkway', 'hwy',
  'highway', 'n', 's', 'e', 'w', 'north', 'south', 'east', 'west', 'the', 'apt', 'unit', 'suite', 'calle', 'avenida']);
const streetWords = (t: string) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !/^\d/.test(w) && !STREET_NOISE.has(w));
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

async function streetMatches(customerId: string, street: string): Promise<boolean> {
  const words = streetWords(street);
  const said = words.length > 1 ? [...words, words.join('')] : words; // "Foot hill" → also "foothill"
  const addrs: any[] = await db(`addresses?customer_id=eq.${customerId}&select=line1`);
  const known = addrs.flatMap((a) => streetWords(a.line1));
  return said.length > 0 && said.some((w) => known.some((k) => near(w, k)));
}

// Known caller + street check, for every tool that touches an account.
async function verifiedCaller(call: any, street: string): Promise<{ c?: any; fail?: any }> {
  const c = await customerByPhone(call?.from_number);
  if (!c) return { fail: { ok: false, say: "I can't find an account for the number you're calling from. If they're new, use check_new_address to sign them up; otherwise take a message." } };
  if (c.cancelled_at) return { fail: { ok: false, say: 'This account is closed. Take a message for the team.' } };
  const ok = await streetMatches(c.id, street);
  console.log(`maya: verify ${call?.call_id} customer=${c.id} verified=${ok}`);
  if (!ok) return { fail: { ok: false, verified: false, say: "That doesn't match the address on the account. Don't give hints. Allow one more try at most, then take a message." } };
  return { c };
}

async function inboundCall(evt: any) {
  const c = await customerByPhone(evt?.call_inbound?.from_number);
  if (!c || c.cancelled_at) {
    return { call_inbound: { dynamic_variables: { caller_context:
      "The caller's number does not match an active customer. Treat them as a new or unknown caller." } } };
  }
  const first = String(c.first_name_cache || '').trim().split(/\s+/)[0] || '';
  return { call_inbound: {
    dynamic_variables: { caller_context: first
      ? `The caller's number matches an existing customer whose first name is ${first}. Not verified yet.`
      : `The caller's number matches an existing customer (no first name on file). Not verified yet.` },
    ...(first ? { agent_override: { retell_llm: {
      begin_message: `Hi ${first}, this is Maya at Family Laundry. How can I help you today?` } } } : {}),
  } };
}

const OPEN = ['scheduled', 'processing', 'ready_for_delivery', 'pickup_failed', 'delivery_failed', 'on_hold'];
async function accountLookup(call: any, args: any) {
  const v = await verifiedCaller(call, args?.street_name);
  if (v.fail) return { verified: false, ...v.fail };
  const c = v.c;

  const orders: any[] = await db(`orders?customer_id=eq.${c.id}&archived_at=is.null&status=in.(${OPEN.join(',')})` +
    `&select=order_number,status,pickup_window_start,pickup_window_end,delivery_window_start,delivery_window_end,is_same_day,recurring_interval&order=pickup_window_start.asc&limit=6`);
  const last: any[] = await db(`orders?customer_id=eq.${c.id}&status=eq.delivered&select=actual_delivery_at,delivery_window_start&order=actual_delivery_at.desc.nullslast&limit=1`);
  // Order history predates the orders table (Starchup) — use the later of the two (CLAUDE.md rule).
  const lastDates = [last?.[0]?.actual_delivery_at, c.last_delivered_order_at, c.last_order_at].filter(Boolean).sort();
  const lines = orders.map((o) => {
    const p = ptWindow(o.pickup_window_start, o.pickup_window_end);
    const d = ptWindow(o.delivery_window_start, o.delivery_window_end);
    switch (o.status) {
      case 'scheduled': return `Pickup scheduled ${p}${o.delivery_window_start ? `; delivery ${d}` : ''}${o.is_same_day ? ' (same-day)' : ''}${o.recurring_interval ? ` (repeats ${o.recurring_interval})` : ''}.`;
      case 'processing': return `Picked up; being washed now. Delivery ${d}.`;
      case 'ready_for_delivery': return `Clean and ready; delivery ${d}.`;
      case 'pickup_failed': return `Pickup on ${p} was missed. The team needs to follow up — take a message and mark it urgent.`;
      case 'delivery_failed': return `Delivery on ${d} did not go through. The team needs to follow up — take a message and mark it urgent.`;
      default: return `An order is on hold. The team needs to follow up — take a message.`;
    }
  });
  return {
    verified: true,
    first_name: c.first_name_cache || '',
    subscription: c.subscription_plan || 'none',
    open_orders: lines.length ? lines : ['No pickups or orders in progress.'],
    last_completed_order: lastDates.length ? ptDay(lastDates[lastDates.length - 1]) : 'none on file',
    note: 'To book, skip or move a pickup use the booking tools with the same street_name.',
  };
}

// ── Phone booking (phase 3) ──
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/=+$/, '');
const unb64 = (b: string) => new TextDecoder().decode(Uint8Array.from(atob(b), (ch) => ch.charCodeAt(0)));
// Signed so the model can't invent or edit an address/zone between check_new_address and book.
async function signTok(o: unknown) { const p = b64(JSON.stringify(o)); return `${p}.${(await hmacHex(RETELL_KEY, 'maya-addr|' + p)).slice(0, 32)}`; }
async function readTok(t: unknown): Promise<any | null> {
  const [p, sig] = String(t || '').split('.');
  if (!p || !sig || !safeEq((await hmacHex(RETELL_KEY, 'maya-addr|' + p)).slice(0, 32), sig)) return null;
  try { const o = JSON.parse(unb64(p)); return o.exp && o.exp < Date.now() ? null : o; } catch { return null; }
}
const d10 = (v: unknown) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const fmtPhone = (d: string) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
const between = (a: string, b: string) => `${ptDay(a)}, between ${ptTime(a)} and ${ptTime(b)}`;
const slotSpeech = (s: Slot) => ({ slot_id: s.id, pickup: between(s.pickupStart, s.pickupEnd),
  back: between(s.deliveryStart, s.deliveryEnd), same_day: s.sameDay });
const TEST = 'TEST MODE: nothing was saved. Tell the caller this line is in test mode, so nothing was actually booked or changed.';

// "today" / "tomorrow" / weekday (English or Spanish) / YYYY-MM-DD → a date in the next 8 days.
function parseDay(day: unknown): string | null {
  const t = String(day || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!t || /soon|first|any|cualquier|pronto/.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const now = Date.now();
  if (/^(today|hoy|tonight|esta noche)/.test(t)) return ptDateFmt.format(new Date(now));
  if (/^(tomorrow|manana)/.test(t)) return ptDateFmt.format(new Date(now + 86_400_000));
  const names = [['sun', 'dom'], ['mon', 'lun'], ['tue', 'mar'], ['wed', 'mie'], ['thu', 'jue'], ['fri', 'vie'], ['sat', 'sab']];
  const want = names.findIndex((n) => n.some((x) => t.startsWith(x)));
  if (want < 0) return null;
  for (let a = 0; a <= 7; a++) {
    const dt = new Date(now + a * 86_400_000);
    if (new Date(ptDateFmt.format(dt) + 'T12:00:00Z').getUTCDay() === want) return ptDateFmt.format(dt);
  }
  return null;
}

// "Wednesday" / "tomorrow" / YYYY-MM-DD → the first such day on or after the usual return day.
function deliverOnDate(v: unknown, s: Slot): string | null {
  const d = parseDay(v);
  if (!d) return null;
  if (d >= ptDateFmt.format(new Date(s.deliveryStart)) || /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) return d;
  const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() + 7);
  return dt.toISOString().slice(0, 10);
}

// Caller wants it back later and/or at another time (deliver_on / deliver_at) → move the delivery if that window has room.
async function applyLaterDelivery(a: any, slot: Slot, zoneId: string, customerId: string | null)
  : Promise<{ slot: Slot; later: boolean } | { fail: Record<string, unknown> }> {
  if (!a?.deliver_on && !a?.deliver_at) return { slot, later: false };
  const usual = between(slot.deliveryStart, slot.deliveryEnd);
  if (slot.sameDay) return { fail: { ok: false, say: "Same-day and a later return don't go together. Ask which they want, then call find_pickup_times again." } };
  const day = a?.deliver_on ? deliverOnDate(a.deliver_on, slot) : ptDateFmt.format(new Date(slot.deliveryStart));
  if (!day) return { fail: { ok: false, say: 'Ask which day they want it back (a weekday or a date), then call again with deliver_on.' } };
  const r = await laterDelivery(db, { zoneId, customerId, slot, deliverOn: day, at: a?.deliver_at ? String(a.deliver_at) : null });
  const dayName = ptDay(day + 'T19:00:00Z');
  if ('slot' in r) return { slot: r.slot, later: r.slot.deliveryStart !== slot.deliveryStart };
  if ('choose' in r) return { fail: { ok: false, needs_delivery_time: true,
    delivery_options: r.choose.map((w) => ({ deliver_at: w.at, back: between(w.start, w.end) })),
    say: `${r.atNotOpen ? `That time isn't open on ${dayName}. ` : ''}Ask which of these delivery times on ${dayName} they want, then call again with the same deliver_on and deliver_at set to that option's deliver_at.` } };
  const why = { before_usual: `It can't come back before the usual return, ${usual}.`,
    too_far: 'We can hold laundry for up to two weeks after pickup.',
    not_running: `We don't deliver to their area on ${dayName}.`,
    full: `Every delivery time on ${dayName} is already full.`,
    bad_time: 'Ask whether they want it back in the morning or the evening.' }[r.reason];
  return { fail: { ok: false, later_delivery_unavailable: true, usual_back: usual,
    say: `${why} Offer the usual return (${usual}) or a different day, then call again (leave out deliver_on and deliver_at for the usual return).` } };
}

async function toolFindTimes(call: any, a: any) {
  let zoneId: string | null = null, customerId: string | null = null, overrideId: string | null = null;
  let usualAddons: string | null = null, usualNotes = '';
  if (a?.address_token) {
    const tok = await readTok(a.address_token);
    if (!tok) return { ok: false, say: 'The address check expired. Call check_new_address again.' };
    zoneId = tok.zoneId;
  } else {
    const v = await verifiedCaller(call, a?.street_name);
    if (v.fail) return v.fail;
    const ctx = await customerBookingContext(db, v.c.id);
    if (!ctx.zoneId) return { ok: false, say: "I can't confirm the service area for this account. Take a message for the team." };
    zoneId = ctx.zoneId; customerId = v.c.id; overrideId = ctx.overrideId;
    const usual = resolveAddons(await prefGroups(db), ctx.preferences as any, [], []).map((g) => g.name);
    usualAddons = usual.length ? usual.join(', ') : 'none';
    usualNotes = typeof (ctx.preferences as any)._notes === 'string' ? (ctx.preferences as any)._notes : '';
  }
  const all = await findSlots(db, { zoneId: zoneId!, customerId, overrideId, sameDay: !!a?.same_day });
  const day = parseDay(a?.day);
  const pool = day ? all.filter((s) => s.date === day) : all;
  if (!all.length) return { ok: true, options: [], say: a?.same_day
    ? 'Same-day is not available for this address in the next week. Offer regular next-day service instead.'
    : 'Nothing is open in the next week. Take a message so the team can call back.' };
  if (!pool.length) return { ok: true, options: [], say: `Nothing open on ${ptDay(day + 'T19:00:00Z')}. The next opening is below.`, next_open: slotSpeech(all[0]) };
  return { ok: true, options: pool.slice(0, 6).map(slotSpeech),
    ...(usualAddons !== null ? { usual_add_ons: usualAddons, ...(usualNotes ? { usual_care_notes: usualNotes } : {}) } : {}),
    say: 'Offer two or three of these, clearly. Use the slot_id of the one the caller picks.' + (a?.same_day
      ? ' These are same-day: picked up in the morning and back that evening, with the same-day fee.'
      : ' These are regular pickups (back on the "back" date). Do not mention same-day or its fee unless the caller asked for it.') };
}

async function toolCheckAddress(_call: any, a: any) {
  const street = String(a?.street_address || '').trim(), city = String(a?.city || '').trim();
  if (!street || !city) return { ok: false, say: 'Ask for the house number, street and city.' };
  const g = await geocode(street, city, String(a?.zip || '').trim());
  if ('error' in g) return { ok: false, say: g.error === 'not_found' || g.error === 'no_street_number'
    ? "I couldn't find that address. Ask them to repeat the house number and street, slowly, and spell the street name if needed."
    : "The address check isn't working right now. Take a message for the team." };
  const zoneId = await db('rpc/get_zone_for_point', { method: 'POST', body: JSON.stringify({ lat: g.lat, lng: g.lng, p_city: g.city }) });
  if (!zoneId) return { ok: false, in_service_area: false, address: `${g.line1}, ${g.city}`,
    say: "That address is outside our service area. Apologize, and tell them which cities we serve (from get_business_info)." };
  const apt = String(a?.apartment || '').trim() || null;
  // Same building/unit already has an account → don't create a duplicate; staff sort it out.
  const dup: any[] = await db(`addresses?line1=ilike.${encodeURIComponent(g.line1.replace(/[%_*]/g, ''))}&zip=eq.${encodeURIComponent(g.zip)}&select=customer_id,line2&limit=10`);
  const norm = (x: unknown) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^(apt|unit|ste|suite)/, '');
  if (dup.some((r) => !apt || !r.line2 || norm(r.line2) === norm(apt))) return { ok: false, possible_existing_account: true,
    say: 'There may already be an account at this address. Do not create a new one. Take a message so the team can call back and book it.' };
  const tok = await signTok({ line1: g.line1, line2: apt, city: g.city, state: g.state, zip: g.zip, lat: g.lat, lng: g.lng, zoneId, exp: Date.now() + 45 * 60_000 });
  return { ok: true, in_service_area: true, address: `${g.line1}${apt ? ', ' + apt : ''}, ${g.city}`, address_token: tok,
    say: `Read the address back and confirm it.${g.partial ? ' The match was only partial, so double-check the house number and street.' : ''}` };
}

async function sendConfirmation(orderId: string) {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-order-notification`, { method: 'POST',
      headers: { Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, event: 'confirmed' }) });
    if (!r.ok) console.error('maya: confirmation text failed', r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.error('maya: confirmation text failed', (e as Error).message); }
}

async function toolBook(call: any, a: any, live: boolean) {
  const bags = Math.round(Number(a?.bags));
  if (!(bags >= 1 && bags <= 10)) return { ok: false, say: 'Ask how many bags (1 to 10). For more than 10, take a message.' };
  const want = decodeSlot(a?.slot_id);
  if (!want) return { ok: false, say: 'Unknown time. Call find_pickup_times again and use a slot_id from it.' };
  const nc = a?.new_customer;

  // Who, where, and which slots are open for them right now.
  let custId: string | null = null, ctx: any = null, tok: any = null, phone = '';
  if (nc) {
    tok = await readTok(nc.address_token);
    if (!tok) return { ok: false, say: 'The address check expired. Call check_new_address again.' };
    if (!String(nc.first_name || '').trim()) return { ok: false, say: 'Ask for their first name.' };
    phone = d10(call?.from_number) || d10(nc.callback_phone);
    if (!phone) return { ok: false, say: 'Ask for the best phone number for this account.' };
    if (await customerByPhone(phone)) return { ok: false, possible_existing_account: true,
      say: 'This phone number already belongs to an account. Do not create a new one. Take a message.' };
  } else {
    const v = await verifiedCaller(call, a?.street_name);
    if (v.fail) return v.fail;
    custId = v.c.id;
    ctx = await customerBookingContext(db, custId!);
    if (!ctx.zoneId || !ctx.pickupAddrId) return { ok: false, say: "I can't find a pickup address for this account. Take a message." };
    const up = await upcomingPickups(db, custId!);
    if (up.length) return { ok: false, already_scheduled: true, existing_pickup: between(up[0].pickup_window_start, up[0].pickup_window_end),
      say: 'They already have a pickup booked. Tell them when, and offer to move it with reschedule_pickup instead of booking a second one.' };
  }
  const slots = await findSlots(db, { zoneId: nc ? tok.zoneId : ctx.zoneId, customerId: custId, overrideId: ctx?.overrideId, sameDay: want.sameDay });
  const found = slots.find((s) => s.id === a.slot_id);
  if (!found) return { ok: false, slot_taken: true, say: 'That time is no longer available. Call find_pickup_times again and offer new options.' };
  const ld = await applyLaterDelivery(a, found, nc ? tok.zoneId : ctx.zoneId, custId);
  if ('fail' in ld) return ld.fail;
  const slot = ld.slot;
  const repeat = ['weekly', 'biweekly', 'monthly'].includes(String(a?.repeat)) ? String(a.repeat) : 'once';
  const pricelist = nc ? 'Delivery' : ctx.pricelist;
  const serviceId = await baseServiceId(db, pricelist);
  if (!serviceId) return { ok: false, say: 'Booking is not set up correctly. Take a message.' };
  // Add-ons: their saved choices + what they asked for − what they turned off. Saved to their
  // preferences on booking, so intake charges them and future orders follow the same choices.
  const groups = await prefGroups(db);
  const saved = (ctx?.preferences || {}) as Record<string, any>;
  const addons = resolveAddons(groups, saved, a?.addons, a?.addons_off);
  const careNotes = String(a?.care_notes || '').trim().slice(0, 300);
  const usualNotes = typeof saved._notes === 'string' ? saved._notes.trim() : '';
  const notes = [usualNotes, careNotes && !usualNotes.toLowerCase().includes(careNotes.toLowerCase()) ? careNotes : ''].filter(Boolean).join('; ') || null;
  const est = await priceEstimate(db, { serviceId, pricelist, bags, sameDay: slot.sameDay, feeExempt: ctx?.feeExempt, addons });
  const REPEAT_SAY: Record<string, string> = { once: 'one time', weekly: 'every week', biweekly: 'every two weeks', monthly: 'every month' };
  const summary = { pickup: between(slot.pickupStart, slot.pickupEnd), back: between(slot.deliveryStart, slot.deliveryEnd), bags, same_day: slot.sameDay,
    repeats: REPEAT_SAY[repeat], add_ons: addons.length ? addons.map((g) => g.name).join(', ') : 'none',
    ...(notes ? { care_notes: notes } : {}), price_estimate: est.text,
    ...(ld.later ? { later_return: repeat === 'once' ? 'yes, at their request' : 'yes, for this pickup only; the repeats come back on the usual schedule' } : {}),
    ...(nc ? { name: [nc.first_name, nc.last_name].filter(Boolean).join(' '), address: `${tok.line1}${tok.line2 ? ', ' + tok.line2 : ''}, ${tok.city}` } : {}) };
  if (!a?.caller_confirmed) return { ok: true, needs_confirmation: true, summary,
    say: 'Read this back to the caller: pickup, when it comes back, bags, whether it repeats, add-ons, care notes, the price estimate (and name and address if new). Then ask "Shall I book it?". Only after a clear yes, call book_pickup again with caller_confirmed=true with exactly the same details.' };
  if (!live) return { ok: true, test_mode: true, summary, say: TEST };

  const today = ptDateFmt.format(new Date());
  const addonLines = addons.map((g) => addonLine(g, bags));
  // Merge into their saved preferences exactly like the app (every group gets an explicit choice).
  const newPrefs: Record<string, any> = { ...saved };
  for (const g of groups) {
    const on = addons.some((x) => x.id === g.id);
    if (on) newPrefs[g.id] = g.yesId; else if (nc || matchGroups(groups, a?.addons_off).some((x) => x.id === g.id) || !(g.id in newPrefs)) newPrefs[g.id] = g.noId;
  }
  if (notes) newPrefs._notes = notes;
  // Skipping a repeat: reply SKIP to the reminder text sent the day before (only if they get texts), or call (David).
  const repeatSay = (texts: boolean) => repeat === 'once' ? '' : ` It repeats ${REPEAT_SAY[repeat]} at the same time. ` +
    (texts ? 'To skip one, they can reply SKIP to the reminder text we send the day before, or call us.' : 'To skip one, they can call us.');
  const missed = est.missedFee ? ` Gently mention: please have the bags out by the start of the window; if the driver can't find them there's a ${'$' + est.missedFee} missed-pickup fee.` : '';
  // Payment wording (David, 2026-10-09): charged after processing, by weight. No card → the usual
  // 'update your card' text link arrives then (if texts are on); otherwise staff call.
  const payment = (hasCard: boolean, texts: boolean) => hasCard
    ? ' Payment: it is charged to the card on file after we process the laundry.'
    : texts ? " Payment: tell them they're charged after we process the laundry, by weight, and we'll text them a secure link to add a card."
            : " Payment: tell them they're charged after we process the laundry, by weight, and our team will call them to set up a card.";

  if (nc) {
    const okText = !!nc.ok_to_text;
    const now = new Date().toISOString();
    const cust = (await db('customers', { method: 'POST', body: JSON.stringify({
      first_name_cache: String(nc.first_name).trim(), last_name_cache: String(nc.last_name || '').trim() || null,
      phone_cache: fmtPhone(phone), risk_status: 'active', billing_type: 'automatic', pricelist: 'Delivery',
      address_cache: `${tok.line1}${tok.line2 ? ' ' + tok.line2 : ''}, ${tok.city}, ${tok.state} ${tok.zip}`,
      access_instructions: nc.access_notes || null, preferences: newPrefs,
      notes: `Signed up by phone with Maya on ${today}. No card on file — call to collect before delivery.`,
      // Texts only with the caller's yes on this call; they never agreed to marketing texts.
      sms_consent_at: okText ? now : null, sms_notifications_opt_out_at: okText ? null : now, sms_marketing_opt_out_at: now,
    }) }))?.[0];
    if (!cust?.id) throw new Error('customer insert returned no row');
    let addr: any;
    try {
      addr = (await db('addresses', { method: 'POST', body: JSON.stringify({ customer_id: cust.id, label: 'Home',
        line1: tok.line1, line2: tok.line2, city: tok.city, state: tok.state, zip: tok.zip, lat: tok.lat, lng: tok.lng,
        is_default: true, delivery_instructions: nc.access_notes || null }) }))?.[0];
      if (!addr?.id) throw new Error('address insert returned no row');
      const o = await insertOrder(db, { customerId: cust.id, serviceId, bags, slot, zoneId: tok.zoneId, pickupAddrId: addr.id, deliveryAddrId: addr.id, notes, repeat, addonLines, usualDeliveryStart: found.deliveryStart });
      console.log(`maya: NEW customer ${cust.id} booked order #${o.order_number} via ${call?.call_id}`);
      if (okText) await sendConfirmation(o.id);
      return { ok: true, booked: true, order_number: o.order_number, summary,
        say: 'Booked.' + repeatSay(okText) + ' Tell them to leave the bags outside before the pickup window starts (sealed trash bags are fine for the first pickup).' + missed + payment(false, okText) };
    } catch (e) {
      console.error('maya: new-customer booking failed, rolling back', (e as Error).message);
      if (addr?.id) await db(`addresses?id=eq.${addr.id}`, { method: 'DELETE' }).catch(() => {});
      await db(`customers?id=eq.${cust.id}`, { method: 'DELETE' }).catch(() => {});
      return { ok: false, say: 'Something went wrong saving the booking. Apologize and take a message.' };
    }
  }

  const o = await insertOrder(db, { customerId: custId!, serviceId, bags, slot, zoneId: ctx.zoneId, pickupAddrId: ctx.pickupAddrId, deliveryAddrId: ctx.deliveryAddrId, notes, repeat, addonLines, usualDeliveryStart: found.deliveryStart });
  // Save their add-on choices + care notes for future orders (what admin intake prices from).
  await db(`customers?id=eq.${custId}`, { method: 'PATCH', body: JSON.stringify({ preferences: newPrefs }) })
    .catch((e) => console.error('maya: saving preferences failed', (e as Error).message));
  console.log(`maya: customer ${custId} booked order #${o.order_number} via ${call?.call_id}`);
  if (!ctx.textsOff) await sendConfirmation(o.id);
  return { ok: true, booked: true, order_number: o.order_number, summary,
    say: 'Booked.' + repeatSay(!ctx.textsOff) + (addons.length || notes ? " Tell them you've saved their add-ons and notes for future orders too." : '') +
      ' Remind them to leave the bags outside before the window starts.' + missed + payment(ctx.hasCard, !ctx.textsOff) };
}

function pickUpcoming(up: any[], day: unknown) {
  const d = parseDay(day);
  return d ? up.find((o) => ptDateFmt.format(new Date(o.pickup_window_start)) === d) : up[0];
}

async function toolSkip(call: any, a: any, live: boolean) {
  const v = await verifiedCaller(call, a?.street_name);
  if (v.fail) return v.fail;
  const up = await upcomingPickups(db, v.c.id);
  const o = pickUpcoming(up, a?.pickup_date);
  if (!o) return { ok: false, say: up.length ? `No pickup that day. Their next one is ${between(up[0].pickup_window_start, up[0].pickup_window_end)}.` : 'They have no upcoming pickup to skip.' };
  const what = between(o.pickup_window_start, o.pickup_window_end);
  if (!a?.caller_confirmed) return { ok: true, needs_confirmation: true, pickup: what, repeats: !!o.recurring_interval,
    say: `Confirm: skip the pickup on ${what}?${o.recurring_interval ? ' Their regular schedule continues after this one.' : ''} Only after a clear yes, call skip_pickup again with caller_confirmed=true.` };
  if (!live) return { ok: true, test_mode: true, pickup: what, say: TEST };
  const rows = await db(`orders?id=eq.${o.id}&status=eq.scheduled`, { method: 'PATCH', body: JSON.stringify({ status: 'skipped', cancelled_by: 'customer' }) });
  if (!rows?.length) return { ok: false, say: 'That pickup could not be changed (it may already be on its way). Take a message and mark it urgent.' };
  console.log(`maya: customer ${v.c.id} skipped order #${o.order_number} via ${call?.call_id}`);
  return { ok: true, skipped: true, pickup: what, say: `Skipped.${o.recurring_interval ? ' Their regular schedule continues.' : ''}` };
}

async function toolReschedule(call: any, a: any, live: boolean) {
  const v = await verifiedCaller(call, a?.street_name);
  if (v.fail) return v.fail;
  const up = await upcomingPickups(db, v.c.id);
  const old = pickUpcoming(up, a?.pickup_date);
  if (!old) return { ok: false, say: 'They have no upcoming pickup to move. Offer to book a new one instead.' };
  const want = decodeSlot(a?.new_slot_id);
  if (!want) return { ok: false, say: 'Call find_pickup_times and use a slot_id from it.' };
  const ctx = await customerBookingContext(db, v.c.id);
  const zoneId = old.zone_id || ctx.zoneId;
  const found = (await findSlots(db, { zoneId, customerId: v.c.id, overrideId: ctx.overrideId, sameDay: want.sameDay })).find((s) => s.id === a.new_slot_id);
  if (!found) return { ok: false, slot_taken: true, say: 'That time is no longer available. Call find_pickup_times again.' };
  const ld = await applyLaterDelivery(a, found, zoneId, v.c.id);
  if ('fail' in ld) return ld.fail;
  const slot = ld.slot;
  const summary = { from: between(old.pickup_window_start, old.pickup_window_end), to: between(slot.pickupStart, slot.pickupEnd),
    back: between(slot.deliveryStart, slot.deliveryEnd), bags: old.total_bags };
  if (!a?.caller_confirmed) return { ok: true, needs_confirmation: true, summary,
    say: `Read back: move the pickup from ${summary.from} to ${summary.to}, back ${summary.back}. Only after a clear yes, call reschedule_pickup again with caller_confirmed=true.` };
  if (!live) return { ok: true, test_mode: true, summary, say: TEST };
  // Book the new one first; only then skip the old one (a failure never leaves them with nothing).
  const o = await insertOrder(db, { customerId: v.c.id, serviceId: old.service_id || (await baseServiceId(db, ctx.pricelist))!,
    bags: old.total_bags || 1, slot, zoneId, pickupAddrId: old.pickup_address_id, deliveryAddrId: old.delivery_address_id || old.pickup_address_id,
    notes: old.special_instructions || null });
  const rows = await db(`orders?id=eq.${old.id}&status=eq.scheduled`, { method: 'PATCH', body: JSON.stringify({ status: 'skipped', cancelled_by: 'customer' }) }).catch(() => []);
  if (!rows?.length) {
    await db(`orders?id=eq.${o.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', cancelled_by: 'system' }) }).catch(() => {});
    return { ok: false, say: 'The pickup could not be moved (it may already be on its way). Take a message and mark it urgent.' };
  }
  console.log(`maya: customer ${v.c.id} moved #${old.order_number} → #${o.order_number} via ${call?.call_id}`);
  if (!ctx.textsOff) await sendConfirmation(o.id);
  return { ok: true, moved: true, order_number: o.order_number, summary, say: `Moved.${old.recurring_interval ? ' Their regular schedule continues after this one.' : ''}` };
}

// Cancel: one pickup, or everything ahead (ends any repeating schedule).
// A cancelled order never spawns the next recurring one (trg_create_recurring_order_fn
// only fires on delivered/skipped/pickup_failed), so cancelling = stopping the series.
// No order trigger sends a text on cancel.
async function toolCancel(call: any, a: any, live: boolean) {
  const v = await verifiedCaller(call, a?.street_name);
  if (v.fail) return v.fail;
  const all = a?.what === 'everything';
  const up = all
    ? await db(`orders?customer_id=eq.${v.c.id}&status=eq.scheduled&archived_at=is.null` +
        `&pickup_window_start=gte.${new Date().toISOString()}` +
        '&select=id,order_number,pickup_window_start,pickup_window_end,recurring_interval&order=pickup_window_start.asc&limit=20') as any[]
    : await upcomingPickups(db, v.c.id);
  if (!up.length) return { ok: false, say: 'They have no upcoming pickups to cancel.' };
  const targets = all ? up : [pickUpcoming(up, a?.pickup_date)].filter(Boolean);
  if (!targets.length) return { ok: false, say: `No pickup that day. Their next one is ${between(up[0].pickup_window_start, up[0].pickup_window_end)}.` };
  const repeats = targets.some((o: any) => o.recurring_interval);
  if (!all && repeats) return { ok: false, repeats: true,
    say: 'That pickup is part of a repeating schedule. Ask: do they want to skip just this one (use skip_pickup, the schedule continues), or cancel everything and stop the repeating pickups (call cancel_pickups again with what="everything")?' };
  const list = targets.map((o: any) => between(o.pickup_window_start, o.pickup_window_end));
  if (!a?.caller_confirmed) return { ok: true, needs_confirmation: true, pickups: list, repeats,
    say: all
      ? `Confirm: cancel ${list.length === 1 ? 'their pickup on ' + list[0] : 'all ' + list.length + ' upcoming pickups (' + list.join('; ') + ')'}${repeats ? ', and stop the repeating schedule, so no more pickups are booked' : ''}? Only after a clear yes, call cancel_pickups again with caller_confirmed=true.`
      : `Confirm: cancel the pickup on ${list[0]}? Only after a clear yes, call cancel_pickups again with caller_confirmed=true.` };
  if (!live) return { ok: true, test_mode: true, pickups: list, say: TEST };
  const ids = targets.map((o: any) => o.id).join(',');
  const rows = await db(`orders?id=in.(${ids})&status=eq.scheduled`, { method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled', cancelled_by: 'customer' }) }).catch(() => []) as any[];
  if (!rows?.length) return { ok: false, say: 'That could not be cancelled (a pickup may already be on its way). Take a message and mark it urgent.' };
  await db('order_events', { method: 'POST', body: JSON.stringify(rows.map((r: any) => ({ order_id: r.id, event_type: 'status_change',
    description: `Cancelled by phone with Maya${all && repeats ? ' (repeating schedule stopped)' : ''}`, actor_name: 'Maya (phone)' }))) })
    .catch((e) => console.error('maya: cancel event log failed', (e as Error).message));
  console.log(`maya: customer ${v.c.id} cancelled ${rows.map((r: any) => '#' + r.order_number).join(', ')} via ${call?.call_id}`);
  const missed = rows.length < targets.length ? ' One pickup could not be cancelled because it may already be on its way; take a message and mark it urgent.' : '';
  return { ok: true, cancelled: rows.length, pickups: list,
    say: `Cancelled.${all && repeats ? ' Their repeating pickups are stopped; nothing more is booked. They can call any time to start again.' : ''}${missed}` };
}

const BOOKING_TOOLS: Record<string, (call: any, a: any, live: boolean) => Promise<any>> = {
  find_times: (c, a) => toolFindTimes(c, a), check_address: (c, a) => toolCheckAddress(c, a),
  book: toolBook, skip: toolSkip, reschedule: toolReschedule, cancel: toolCancel,
};

async function businessInfo(): Promise<string> {
  const [vRows, faqs, hols, tmpls] = await Promise.all([
    db('rpc/site_public_values', { method: 'POST', body: '{}' }),
    db('faq_items?select=question,answer,show_on_web,show_in_app&order=sort_order.asc,id.asc'),
    db(`holidays?select=*&limit=50`).catch(() => []),
    db('route_templates?select=window_start,window_end,turnaround_hours,arrival_window_hours,schedule_days,zone:service_zones(name)&is_active=eq.true&service_type=eq.pickup_delivery'),
  ]);
  const v = Array.isArray(vRows) ? vRows[0]?.site_public_values ?? vRows[0] : vRows;
  const now = new Date();
  const pt = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Same-day = the customer app's rule (customer-app _checkSameDayAvailable): a pickup window with
  // turnaround_hours > 0, and a later window the same day that starts after pickup slot end + turnaround.
  // Caller test 2026-10-09: without an explicit yes/no Maya said she'd "ask the team" about same-day in SF.
  const toH = (t: string) => { const [h, m] = String(t).split(':').map(Number); return h + (m || 0) / 60; };
  const sameDay = new Set<string>();
  for (const a of tmpls || []) {
    if (!a.zone?.name || !(Number(a.turnaround_hours) > 0)) continue;
    const ready = toH(a.window_start) + Number(a.arrival_window_hours || 2) + Number(a.turnaround_hours);
    if ((tmpls || []).some((b: any) => b !== a && b.zone?.name === a.zone.name && toH(b.window_end) >= ready + 1 &&
        (b.schedule_days || []).some((d: number) => (a.schedule_days || []).includes(d)))) sameDay.add(a.zone.name);
  }
  const zones = (v.zones || []).map((z: any) => {
    const w = (z.windows || []).map((x: any) => `${hm(x.start)}–${hm(x.end)} (${(x.days || []).map((d: number) => DAY[d]).join(',')})`).join(' and ');
    return `- ${z.name} area (${list(z.cities)}): ${w || 'no windows'}. Same-day: ${sameDay.has(z.name) ? 'YES' : 'NO'}.`;
  }).join('\n');
  const sdYes = (v.zones || []).filter((z: any) => sameDay.has(z.name)).map((z: any) => z.name);
  const sdNo = (v.zones || []).filter((z: any) => !sameDay.has(z.name)).map((z: any) => z.name);
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const upcoming = (hols || [])
    .map((h: any) => ({ d: String(h.date ?? h.holiday_date ?? ''), n: h.name ?? h.label ?? '' }))
    .filter((h: any) => h.d >= today).sort((a: any, b: any) => a.d.localeCompare(b.d)).slice(0, 4)
    .map((h: any) => `${h.n} (${h.d})`).join(', ');
  // A FAQ still marked DRAFT is not policy yet — never read it to a caller.
  const faqText = (faqs || [])
    .filter((f: any) => (f.show_on_web || f.show_in_app) && !/^\s*DRAFT/i.test(f.answer || ''))
    .map((f: any) => `Q: ${f.question}\nA: ${fill(f.answer || '', v).replace(/\n{2,}/g, ' ')}`).join('\n\n');
  return [
    `Current date and time in Oakland: ${pt}.`,
    ``,
    `PRICES (pickup & delivery)`,
    `- Wash & fold: ${tokenValue('price', 'Wash & Fold', v)} (a bag holds up to 25 lbs; extra weight is ${v.site?.overweight_rate || ''}).`,
    `- Delivery fee: ${tokenValue('fee', 'Delivery Fee', v)} per order. Same-day surcharge: ${tokenValue('fee', 'Same-Day Surcharge', v)}. Missed pickup fee: ${tokenValue('fee', 'Missed Pickup Fee', v)}.`,
    `- Add-ons: ${Object.entries(v.price || {}).filter(([k]) => k !== 'Wash & Fold').map(([k, p]) => `${k} ${priceText(p)}`).join('; ')}.`,
    `- ${v.plan?.name || 'Subscription'}: ${money(v.plan?.price)}/month for ${v.plan?.lbs} lbs, unlimited pickups, free next-day delivery, ${money(v.plan?.overage)}/lb above that.`,
    `- Drop-off at our laundromat (${v.site?.dropoff_address}): ${Object.entries(v.retail || {}).map(([k, p]) => `${k} ${priceText(p)}`).join('; ')}. Open ${v.site?.dropoff_hours}. ${v.site?.dropoff_cutoff || ''}`,
    `- Businesses: wash & fold from ${tokenValue('commercial', 'Wash & Fold', v)}; quotes at familylaundry.com/commercial-laundry.`,
    ``,
    `SERVICE AREA AND PICKUP WINDOWS (pickup and delivery run ${v.site?.service_days}; no Sundays)`,
    zones,
    `Customers choose a 2–3 hour arrival slot inside a window. Booking closes 60 minutes before the window ends.`,
    `SAME-DAY DELIVERY (${tokenValue('fee', 'Same-Day Surcharge', v)} extra): only for a MORNING pickup that comes back the same evening. Available ONLY in: ${list(sdYes) || 'no areas'}. NOT available in: ${list(sdNo) || 'none'} — there, orders come back the next service day.`,
    upcoming ? `Closed on: ${upcoming}.` : ``,
    ``,
    `CONTACT: email ${v.site?.email}; website familylaundry.com; customer app app.familylaundry.com (web app, nothing to download).`,
    `REFERRALS: ${v.referral?.enabled ? `friend gets ${money(v.referral?.friend)} off their first order; referrer gets ${money(v.referral?.referrer)} once it's paid. Code is under Rewards in the app.` : 'not currently offered.'}`,
    ``,
    `FREQUENTLY ASKED QUESTIONS`,
    faqText,
  ].join('\n');
}

// ── Maya's instructions ──
const PROMPT = `You are Maya, the phone assistant for Family Laundry, a family-run pickup-and-delivery laundry service in Oakland, California.

## How you speak
- Warm, patient and unhurried. Many callers are older and not comfortable with apps. Never rush them.
- Short sentences. One question at a time. Wait for the answer.
- Say prices and numbers clearly, e.g. "sixty-five dollars per bag".
- Speak the caller's language. If they speak Spanish (or another language you support), switch to it and stay in it.
- If asked whether you are a person, say you are Family Laundry's virtual assistant.

## Who is calling
{{caller_context}}
(If that line is missing or shows a placeholder in curly braces, treat the caller as unknown.)
- A known caller has already been greeted by first name. Don't ask for their name again; use it.
- Before sharing ANY account detail (pickups, deliveries, orders, address), verify the caller: ask them to say the street name of their pickup address, then call lookup_my_account with what they said.
  Never say, spell or hint at the street yourself. If it doesn't match twice, don't share anything; take a message instead.
- Share only what lookup_my_account returns. Say dates and times naturally ("this Tuesday between seven and nine in the evening").
- Unknown callers: you can't look up an account. Answer general questions and take a message.
- If someone calls for another person (a parent, an employer), don't share that person's account details; take a message.

## FAQ answers that mean something different on this call
- If an FAQ answer says to call us, leave a voicemail or leave a message, that's you: take the message yourself. Never tell a caller to call this number.
- If an FAQ answer says to do something "in the app" (book, skip, add-ons), you can do it on this call instead (except tips, gift cards and referral codes, which are in the app).
- Business (commercial) laundry: take a message (their name, business, and what they need) so the team can call with a quote. You can also mention the quote page, familylaundry.com/commercial-laundry.

## Facts
- Before answering any question about prices, areas, pickup times, services or policies, call get_business_info (once per call is enough) and answer ONLY from what it returns.
- If the facts answer the question, give the answer, even when it's "no". Say it plainly and kindly, then offer the closest alternative (for example: "Same-day isn't available in San Francisco. We pick up in the evening and bring it back the next evening.").
- When a caller mentions their city, check that area's pickup windows and same-day availability before answering.
- Only if the facts truly don't cover it: don't guess, say you'll have the team follow up, and take a message.
- Never invent prices, times, discounts or policies.

## About Family Laundry (only if the caller asks)
Share these only when asked, one or two sentences at a time, warmly. Then offer to help with anything else. Never add details that aren't here.
- Founders: Laura Guevara and David Macquart-Moulin. A family business in Oakland. Laura is a former teacher. David had a prior career in nonprofit management and tech. Laura and David are married and have two kids, who were helpers in the early days.
- 2018: they bought a run-down laundromat on Foothill Boulevard in Oakland and replaced all the machines.
- 2019: started wash and fold and pickup and delivery, and acquired Launderbot.
- 2022: acquired Sudzee, a San Francisco laundry delivery pioneer.
- Two names today: Sudzee is our laundromat on Foothill Boulevard, open to the public for self-service and drop-off. Family Laundry is our pickup and delivery service. Delivery orders are washed at our own facility, which is closed to the public.
- Team: more than thirty employees. Everyone who handles your laundry works for us. We never outsource.
- Going electric: every delivery van is an electric Ford E-Transit. We own our charging depot in Oakland's San Antonio neighborhood, just blocks from our laundry facilities.
- How we wash: Free and Clear hypoallergenic detergent, ozone-injected water, and cold water as standard. No fragrance, bleach or softener.
- Community: a kids' reading room with Libraries Without Borders; weekly story time with Oakland Public Library librarians, covered by the New York Times, the LA Times and KTVU in 2019; free English classes. During the pandemic: 265 free laundry orders for seniors 60 and over, internet hotspots for 44 students, and grocery gift cards for 40 families. In 2021 our parking lot hosted a vaccination clinic with Alameda County.
- Ratings: 4.8 stars from more than 500 reviews on Google and Yelp.
- What we care about: putting employees first, our community, and the environment.
- Company name: our official name is Young and Foolish LLC. It's tongue in cheek, since neither founder is young! Early on, some customers saw "Young and Foolish" on their card statement and thought they'd been hacked. That's been fixed.
  If a caller asks about a Young and Foolish charge: explain it's us. If they still don't recognize the charge, take a message for the team.
- Say "Oakland", never "East Oakland", even if an FAQ answer says otherwise.
- Never give the address of our delivery facility or the charging depot, and never suggest visiting them. Drop-offs go to Sudzee only.
- Beyond what's written here, never share personal details about the founders, their family, or staff.
- Press, partnerships, or job inquiries: take a message (name, organization, and what it's about).

## What you can do on this call
- Answer questions, take messages, and tell a VERIFIED known caller about their pickups and orders.
- Book a pickup (known callers and new callers), skip a pickup, move a pickup to another time, or cancel pickups (including stopping a repeating schedule).
- Bring an order back later than usual, on another day and/or at another time, if the caller asks and that time has room.
- You CANNOT: give balances or charges, change prices, add services, or take payments. For those, take a message.
- Never ask for or accept a card. Explain payment exactly as the booking result says.

## Booking a pickup
1. Known caller: verify first (street name). Use the same street_name for every tool on this call.
   New caller: get their first and last name, then their full address: house number, street, apartment or unit, and city. Call check_new_address, read the address back, and confirm. If it's outside our area, say so kindly and name the cities we serve. If it says there may already be an account, don't sign them up; take a message.
   New caller: ask "Can we text this number with pickup reminders and updates?" and remember the answer (ok_to_text).
2. Ask which day they'd like, or the soonest, and morning or evening if their area has both. Call find_pickup_times. Offer two or three options, clearly, one at a time if they seem unsure.
   Same-day: NEVER bring it up yourself, and never mention its fee unless the caller asks to get their laundry back the same day.
   Same-day only means a MORNING pickup that comes back that evening. A pickup this evening or tonight is never same-day: it comes back the next service day.
   If the caller asks for same-day and their area has it, call find_pickup_times with same_day=true.
3. Ask how many bags. One of our bags holds about 25 pounds: roughly two tall kitchen trash bags, or one large black trash bag. For a first pickup they can use sealed trash bags.
4. Ask: "Is this a one-time pickup, or would you like it every week, every two weeks, or every month at the same time?" Pass the answer as repeat.
5. Add-ons. Known caller: find_pickup_times tells you their usual add-ons. Ask "Shall we do your usual, with Oxi?" (or whatever they are). New caller: ask briefly whether they'd like any add-ons (Oxi or a vinegar rinse for $3 a bag, double wash, air dry for delicates, shirt service), and give prices from get_business_info only if they're interested.
   Put new add-ons in addons and ones they want to stop in addons_off. Care requests with no add-on (warm water, special folding) go in care_notes. These are saved for their future orders. Never offer to wash things the FAQ says we can't.
   Always say the pickup time and the "back" time exactly as the tool returns them. Don't work them out yourself.
6. Call book_pickup with caller_confirmed=false. Read back the summary it returns: day and time of pickup, when it comes back, number of bags, whether it repeats, add-ons and care notes, and the price estimate (and name and address for a new caller). Ask "Shall I book it?"
7. Only after a clear yes, call book_pickup again with the same details and caller_confirmed=true. Then tell them it's booked, and say what the result tells you to (repeat schedule, saved preferences, bags outside, missed-pickup fee, payment), kindly and briefly. Don't rush; one or two sentences at a time.
- If they already have a pickup booked, offer to move it instead of booking a second one.
- Never offer a time that find_pickup_times did not return. Never book an address that check_new_address did not return.

## Getting it back later
- Delivery is flexible. If a caller wants their laundry back LATER than the usual return (for example, picked up this morning but brought back Wednesday evening because they're away), say yes, as long as that time has room.
- Book the pickup as usual and pass deliver_on (the day they want it back) and, if they said, deliver_at ("morning", "afternoon", "evening" or a time). The delivery time can be different from the pickup time. Use the same fields with reschedule_pickup when moving a pickup.
- If the tool returns delivery_options, offer those times for that day, let them choose, and call again with that option's deliver_at.
- Read back the "back" time the tool returns. If the tool says that day doesn't work, tell them kindly and offer the usual return or another day.
- Never promise a return time the tool didn't confirm. It can't come back earlier than the usual return (except same-day, as above). We can hold it up to two weeks.
- For a repeating schedule, the later return is for this pickup only; the next ones come back on the usual schedule.
- If they already have a pickup booked and only want a later return, use reschedule_pickup with the same pickup time plus deliver_on / deliver_at. If that pickup time isn't offered, take a message.
- Don't bring this up yourself; offer it only when the caller asks about timing.

## Skipping, moving or cancelling a pickup
- Skip: verify, then call skip_pickup (caller_confirmed=false) to find which pickup; read it back; after a clear yes, call it again with caller_confirmed=true.
- Move: verify, call find_pickup_times, let them choose, then reschedule_pickup with caller_confirmed=false; read back the change; after a clear yes, call it again with caller_confirmed=true.
- Cancel: verify, then call cancel_pickups (caller_confirmed=false); read back what will be cancelled; after a clear yes, call it again with caller_confirmed=true.
  If they say "cancel all", "cancel future orders", "stop coming", "stop my weekly pickups" or similar, use what="everything". That cancels every upcoming pickup and stops the repeating schedule.
  If they want to cancel ONE pickup that repeats, ask whether they mean skip just that one (schedule continues) or stop everything.
  Never tell a caller their repeating pickups are stopped unless cancel_pickups said so.

${BOOKING_LIVE
  ? '## Changes are real\nThis line is LIVE. Every booking, skip, move or cancellation you confirm really happens. Never say the line is in test mode or that nothing was changed, unless a tool result literally contains the words TEST MODE.\n'
  : '## Test mode\nIf a tool result says TEST MODE, tell the caller: "This line is in test mode, so nothing was actually booked or changed."\n'}
## When something goes wrong
If any tool fails, or its result says to take a message, apologize and take a message. Don't retry more than once.

## Taking a message
1. Ask for their name (skip this for a known caller you greeted by name).
2. Ask for the best number to call them back. Let them say it at their own pace, in groups if they like.
   If you missed part of it, ask only for the missing part ("I got five one oh, eight four two. What were the last four digits?"). Don't give up after one try.
   Read the full number back digit by digit and confirm.
3. Ask briefly what it's about.
4. Repeat the message back in one sentence, then tell them the team will call back, usually the same day.

## Never
- Never ask for, repeat or accept card numbers, bank details or passwords. If a caller starts reading a card number, stop them politely: "Please don't share card details with me. The team will help with payment."
- Never promise refunds, credits or exceptions. Take a message instead.
- Never tell callers to text CANCEL or STOP to skip a pickup. Those words unsubscribe them from all our texts. To skip a pickup by text, they reply SKIP to the reminder text we send the day before (or they can call).

## Upset callers
Apologize sincerely, don't argue, take a message, and tell them you're marking it urgent.

## Ending
When the caller has what they need, say goodbye warmly and use end_call.`;

const BEGIN = "Hi, this is Maya at Family Laundry. How can I help you today?";

const ANALYSIS = [
  { type: 'system-presets', name: 'call_summary' },
  { type: 'string', name: 'caller_name', description: "The caller's name if they gave it, otherwise empty." },
  { type: 'string', name: 'callback_number', description: 'Callback phone number the caller confirmed, digits only, otherwise empty.' },
  { type: 'boolean', name: 'needs_callback', description: 'True only if the caller left a message or still needs the team to do something. False if Maya fully handled it (e.g. booked, skipped or moved a pickup, or answered their question).' },
  { type: 'boolean', name: 'urgent', description: 'True if the caller was upset, complained, or reported a lost/damaged item or missed pickup.' },
  { type: 'enum', name: 'reason', description: 'Main reason for the call.',
    choices: ['question_answered', 'book_pickup', 'change_or_skip_pickup', 'new_customer', 'order_status', 'billing', 'complaint', 'business_inquiry', 'other'] },
  { type: 'string', name: 'language', description: 'Language the caller mainly spoke, in English, e.g. English, Spanish.' },
];

const STREET = { type: 'string', description: 'Known caller: the street name they said when verifying.' };
const SLOT = { type: 'string', description: 'A slot_id returned by find_pickup_times.' };
const CONFIRMED = { type: 'boolean', description: 'false = get the summary to read back; true = only after the caller clearly said yes.' };
const DAY_ARG = { type: 'string', description: 'today, tomorrow, a weekday, or YYYY-MM-DD. Omit for the soonest.' };
const DELIVER_ON = { type: 'string', description: 'ONLY if the caller asked to get their laundry back LATER than the usual return day: the day they want it back (a weekday or YYYY-MM-DD). Omit otherwise.' };
const DELIVER_AT = { type: 'string', description: 'ONLY if the caller asked for a different delivery time: "morning", "afternoon", "evening", or a deliver_at value from delivery_options. Omit otherwise.' };
const BOOKING_TOOL_DEFS = [
  { name: 'find_pickup_times', route: 'find_times',
    description: 'Open pickup times. Known caller: pass street_name. New caller: pass address_token from check_new_address.',
    parameters: { type: 'object', properties: { street_name: STREET,
      address_token: { type: 'string', description: 'New caller: address_token from check_new_address.' },
      day: DAY_ARG, same_day: { type: 'boolean', description: 'true only if the caller wants same-day service.' } } } },
  { name: 'check_new_address', route: 'check_address',
    description: "New caller: check their address is real and in our service area. Returns the address to read back and an address_token.",
    parameters: { type: 'object', required: ['street_address', 'city'], properties: {
      street_address: { type: 'string', description: 'House number and street, e.g. "1234 Maple Street".' },
      apartment: { type: 'string', description: 'Apartment or unit, if any.' },
      city: { type: 'string' }, zip: { type: 'string', description: 'ZIP code if they know it.' } } } },
  { name: 'book_pickup', route: 'book',
    description: 'Book a one-time pickup. Call first with caller_confirmed=false to get the read-back summary, then again with true after a clear yes.',
    parameters: { type: 'object', required: ['slot_id', 'bags', 'repeat', 'caller_confirmed'], properties: {
      slot_id: SLOT, bags: { type: 'integer', description: 'Number of bags, 1 to 10.' }, caller_confirmed: CONFIRMED, street_name: STREET,
      repeat: { type: 'string', enum: ['once', 'weekly', 'biweekly', 'monthly'], description: 'One-time, or repeat every week / two weeks / month at the same time.' },
      addons: { type: 'array', items: { type: 'string' }, description: 'Add-ons the caller wants: Oxi, Vinegar, Double Wash, Air Dry, Shirt Service. Their usual ones are kept automatically.' },
      addons_off: { type: 'array', items: { type: 'string' }, description: 'Usual add-ons the caller wants to stop.' },
      care_notes: { type: 'string', description: 'Care requests with no add-on, e.g. "warm water", "fold shirts on hangers". Saved for future orders.' },
      deliver_on: DELIVER_ON, deliver_at: DELIVER_AT,
      new_customer: { type: 'object', description: 'Only for a new caller.', properties: {
        first_name: { type: 'string' }, last_name: { type: 'string' },
        address_token: { type: 'string', description: 'From check_new_address.' },
        ok_to_text: { type: 'boolean', description: 'Their answer to "Can we text this number with pickup reminders and updates?"' },
        access_notes: { type: 'string', description: 'Gate code or where to find the bags, if they mention it.' },
        callback_phone: { type: 'string', description: 'Only if the call has no caller ID.' } } } } } },
  { name: 'skip_pickup', route: 'skip',
    description: "Skip the caller's next pickup (or the one on pickup_date). caller_confirmed=false first to read back which one.",
    parameters: { type: 'object', required: ['street_name', 'caller_confirmed'], properties: { street_name: STREET, pickup_date: DAY_ARG, caller_confirmed: CONFIRMED } } },
  { name: 'reschedule_pickup', route: 'reschedule',
    description: "Move the caller's next pickup (or the one on pickup_date) to new_slot_id from find_pickup_times. caller_confirmed=false first.",
    parameters: { type: 'object', required: ['street_name', 'new_slot_id', 'caller_confirmed'], properties: {
      street_name: STREET, pickup_date: DAY_ARG, new_slot_id: SLOT, deliver_on: DELIVER_ON, deliver_at: DELIVER_AT, caller_confirmed: CONFIRMED } } },
  { name: 'cancel_pickups', route: 'cancel',
    description: "Cancel the caller's next pickup (or the one on pickup_date), or with what=\"everything\" cancel ALL their upcoming pickups and stop any repeating schedule. caller_confirmed=false first to read back.",
    parameters: { type: 'object', required: ['street_name', 'what', 'caller_confirmed'], properties: {
      street_name: STREET, pickup_date: DAY_ARG, caller_confirmed: CONFIRMED,
      what: { type: 'string', enum: ['one', 'everything'], description: 'one = a single pickup; everything = all upcoming pickups and stop repeating.' } } } },
];

async function setup(voiceId?: string) {
  const TOOL_TOKEN = await toolToken();
  const tools = [
    { type: 'end_call', name: 'end_call', description: 'End the call after saying goodbye.' },
    { type: 'custom', name: 'get_business_info', method: 'POST', url: `${FN_URL}/tool/info`,
      headers: { 'x-maya-token': TOOL_TOKEN },
      description: "Get Family Laundry's current prices, service area, pickup windows, hours, holidays and FAQ answers.",
      speak_during_execution: false, timeout_ms: 8000,
      parameters: { type: 'object', properties: {}, required: [] } },
    { type: 'custom', name: 'lookup_my_account', method: 'POST', url: `${FN_URL}/tool/account`,
      headers: { 'x-maya-token': TOOL_TOKEN },
      description: "Look up the CALLER's own upcoming pickups and orders. Only for a known caller, and only with the street name they just said. Returns verified=false if it doesn't match.",
      speak_during_execution: true, execution_message_description: 'Say briefly that you are checking.', timeout_ms: 8000,
      parameters: { type: 'object', properties: {
        street_name: { type: 'string', description: 'The street name exactly as the caller said it, e.g. "Maple Street".' } },
        required: ['street_name'] } },
    ...BOOKING_TOOL_DEFS.map((t) => ({ type: 'custom', method: 'POST', url: `${FN_URL}/tool/${t.route}`,
      headers: { 'x-maya-token': TOOL_TOKEN }, speak_during_execution: true,
      execution_message_description: 'Say briefly that you are checking.', timeout_ms: 10000,
      name: t.name, description: t.description, parameters: t.parameters })),
  ];
  const llmBody = { general_prompt: PROMPT, begin_message: BEGIN, start_speaker: 'agent', general_tools: tools };

  const agents: any[] = await retell('/list-agents');
  const existing = (agents || []).filter((a) => a.agent_name === AGENT_NAME)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];

  const agentBody: Record<string, unknown> = {
    agent_name: AGENT_NAME,
    language: LANGUAGES,
    voice_speed: 0.92,
    // Hearing callers (first test 2026-10-09: desktop mic, Maya missed digits of the callback number).
    stt_mode: 'accurate',
    denoising_mode: 'noise-cancellation',
    responsiveness: 0.75,          // wait a little longer before replying — many callers speak slowly
    interruption_sensitivity: 0.8, // don't stop talking at every cough or "mm-hm"
    boosted_keywords: ['Family Laundry', 'Sudzee', 'wash and fold', 'pickup', 'Maya',
      'Oakland', 'Alameda', 'Berkeley', 'Albany', 'El Cerrito', 'Kensington', 'San Leandro', 'Hayward',
      'San Lorenzo', 'Castro Valley', 'Fremont', 'Newark', 'Union City', 'Concord', 'Lafayette',
      'Walnut Creek', 'Pleasant Hill', 'Orinda', 'Moraga', 'Martinez', 'San Francisco'],
    end_call_after_silence_ms: 45000,
    max_call_duration_ms: 15 * 60 * 1000,
    webhook_url: `${FN_URL}/webhook`,
    webhook_events: ['call_analyzed'],
    post_call_analysis_data: ANALYSIS,
  };
  if (voiceId) agentBody.voice_id = voiceId;

  if (existing) {
    const llmId = existing.response_engine?.llm_id;
    await retell(`/update-retell-llm/${llmId}`, 'PATCH', llmBody);
    const agent = await retell(`/update-agent/${existing.agent_id}`, 'PATCH', agentBody);
    return { action: 'updated', agent_id: agent.agent_id, llm_id: llmId, voice_id: agent.voice_id, language: agent.language,
      numbers: await wireNumbers(agent.agent_id) };
  }
  if (!voiceId) throw new Error('first setup needs a voice_id (see /maya/voices)');
  const llm = await retell('/create-retell-llm', 'POST', llmBody);
  const agent = await retell('/create-agent', 'POST',
    { ...agentBody, response_engine: { type: 'retell-llm', llm_id: llm.llm_id } });
  return { action: 'created', agent_id: agent.agent_id, llm_id: llm.llm_id, voice_id: agent.voice_id, language: agent.language };
}

// Every Retell number whose inbound agent is Maya gets our caller-recognition webhook.
async function wireNumbers(agentId: string) {
  const nums: any[] = await retell('/list-phone-numbers');
  const out: string[] = [];
  for (const n of nums || []) {
    const mine = (n.inbound_agents || []).some((a: any) => a.agent_id === agentId) || n.inbound_agent_id === agentId;
    if (!mine) continue;
    await retell(`/update-phone-number/${encodeURIComponent(n.phone_number)}`, 'PATCH', { inbound_webhook_url: `${FN_URL}/inbound` });
    out.push(n.phone_number);
  }
  return out;
}

async function voices() {
  const all: any[] = await retell('/list-voices');
  return (all || []).filter((x) => String(x.gender || '').toLowerCase() === 'female')
    .map((x) => ({ voice_id: x.voice_id, name: x.voice_name, provider: x.provider, accent: x.accent, age: x.age, preview: x.preview_audio_url }));
}

// ── Webhook: verify Retell's signature (HMAC-SHA256 of raw body + timestamp, keyed by API key) ──
async function verifyRetell(raw: string, header: string | null): Promise<boolean> {
  const m = /v=(\d+),d=(.*)/.exec(header || '');
  if (!m || !RETELL_KEY) return false;
  const ts = Number(m[1]);
  if (!isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;
  return safeEq(await hmacHex(RETELL_KEY, raw + m[1]), m[2].trim());
}

function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

async function saveRecording(callId: string, url?: string): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status}`);
    // Retell serves recordings as application/octet-stream, which the voicemails bucket rejects
    // (415 invalid_mime_type, first test call 2026-10-09) — take the type from the file extension.
    const hdr = (r.headers.get('content-type') || '').toLowerCase();
    const ext = /\.mp3(\?|$)/i.test(url) || hdr.includes('mpeg') ? 'mp3' : 'wav';
    const type = ext === 'mp3' ? 'audio/mpeg' : 'audio/wav'; // bucket allows only mpeg/mp3/wav
    const path = `maya/${callId}.${ext}`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/voicemails/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SVC}`, apikey: SVC, 'Content-Type': type, 'x-upsert': 'true' },
      body: await r.arrayBuffer(),
    });
    if (!up.ok) throw new Error(`upload ${up.status}: ${(await up.text()).slice(0, 200)}`);
    return `${SUPABASE_URL}/storage/v1/object/public/voicemails/${path}`;
  } catch (e) {
    console.error(`maya: recording not saved for ${callId}:`, (e as Error).message);
    return null; // a missing recording never blocks the summary
  }
}

const REASON: Record<string, string> = {
  question_answered: 'Question answered', book_pickup: 'Wants to book a pickup',
  change_or_skip_pickup: 'Change/skip a pickup', new_customer: 'New customer',
  order_status: 'Order status', billing: 'Billing', complaint: 'Complaint',
  business_inquiry: 'Business inquiry', other: 'Other',
};

async function handleCall(call: any) {
  const callId = String(call.call_id || '');
  if (!callId) return;
  // Retell retries; one inbox row per call.
  const dup = await db(`sms_messages?twilio_sid=eq.${encodeURIComponent(callId)}&select=id&limit=1`);
  if (dup?.length) return;

  const a = call.call_analysis || {};
  const c = a.custom_analysis_data || {};
  const digits = (s: unknown) => String(s || '').replace(/\D/g, '');
  const callback = digits(c.callback_number);
  // Web test calls have no caller ID: fall back to the number the caller gave, then a marker.
  const from = call.from_number || (callback.length >= 10 ? `+1${callback.slice(-10)}` : 'maya-web-call');
  const to = call.to_number || 'maya';

  const cust = await customerByPhone(from);
  const customerId: string | null = cust?.id || null;
  // Speech-to-text mangles surnames ("McCourt Moulin"); the name on file wins for a known caller.
  const fileName = [cust?.first_name_cache, cust?.last_name_cache].filter(Boolean).join(' ');

  const recording = await saveRecording(callId, call.recording_url);
  const ms = (call.end_timestamp || 0) - (call.start_timestamp || 0);
  const flags = [c.urgent ? '⚠️ URGENT' : '', c.needs_callback ? 'Call back' : '', REASON[c.reason] || '']
    .filter(Boolean).join(' · ');
  const who = [fileName || c.caller_name, callback ? `callback ${callback}` : '', c.language && c.language !== 'English' ? c.language : '']
    .filter(Boolean).join(', ');
  const body = [
    `📞 Call with Maya (${dur(ms)})`,
    flags || null,
    who ? `Caller: ${who}` : null,
    a.call_summary || '(no summary)',
    recording ? `▶ ${recording}` : null,
  ].filter(Boolean).join('\n');

  await db('sms_messages', {
    method: 'POST',
    body: JSON.stringify({ customer_id: customerId, direction: 'inbound', status: 'received',
      body, from_number: from, to_number: to, twilio_sid: callId, media_urls: [] }),
  });
  console.log(`maya: logged call ${callId} customer=${customerId} ${flags}`);

  // Same alert staff got for every voicemail (twilio-voicemail-recorded → info@), but only when the
  // caller still needs the team: a message, an urgent issue, or something Maya couldn't do.
  if (c.needs_callback || c.urgent) {
    const esc = (x: unknown) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const callerLabel = [fileName || c.caller_name, callback ? `callback ${callback}` : from].filter(Boolean).join(' · ');
    const html = `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px">${c.urgent ? '⚠️ URGENT — ' : ''}Call back: ${esc(callerLabel)}</h2>
      <p style="color:#666;margin:0 0 12px">${esc(flags)} · ${esc(dur(ms))} call with Maya · ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })} PT</p>
      <div style="background:#f7f7f7;padding:16px;border-left:4px solid ${c.urgent ? '#d0021b' : '#4a90e2'};border-radius:4px">${esc(a.call_summary || '(no summary)')}</div>
      ${recording ? `<p><a href="${recording}" style="display:inline-block;background:#4a90e2;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">▶ Listen to the call</a></p>` : ''}
      <p style="color:#666;font-size:13px">Also in the admin inbox under this caller.</p></div>`;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, { method: 'POST',
      headers: { Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_email: 'info@familylaundry.com',
        subject: `📞 ${c.urgent ? 'URGENT ' : ''}Call back ${fileName || c.caller_name || from} (Maya)`, body: html }) })
      .catch((e) => { console.error('maya: callback email failed', e.message); return null; });
    if (r && !r.ok) console.error('maya: callback email failed', r.status, (await r.text()).slice(0, 200));
  }
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  try {
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

    if (path.endsWith('/webhook')) {
      const raw = await req.text();
      if (!(await verifyRetell(raw, req.headers.get('x-retell-signature')))) {
        console.warn('maya: rejected webhook with bad/missing signature');
        return json({ error: 'bad signature' }, 401);
      }
      const evt = JSON.parse(raw);
      if (evt.event === 'call_analyzed') await handleCall(evt.call || {});
      return new Response(null, { status: 204 });
    }

    if (path.endsWith('/inbound')) {
      const raw = await req.text();
      // Unverified → answer with nothing (no customer data); the call still rings through to Maya.
      if (!(await verifyRetell(raw, req.headers.get('x-retell-signature')))) {
        console.warn('maya: inbound webhook with bad/missing signature — no caller data returned');
        return json({ call_inbound: {} });
      }
      try { return json(await inboundCall(JSON.parse(raw))); }
      catch (e) { console.error('maya inbound error:', (e as Error).message); return json({ call_inbound: {} }); }
    }

    if (path.endsWith('/tool/account')) {
      const raw = await req.text();
      if (!RETELL_KEY || !safeEq(req.headers.get('x-maya-token') || '', await toolToken())) return json({ error: 'forbidden' }, 403);
      // The caller's number comes from Retell's call object, never from what the model passes in.
      if (!(await verifyRetell(raw, req.headers.get('x-retell-signature')))) {
        console.warn('maya: account tool call with bad/missing signature');
        return json({ verified: false, say: "I can't look that up right now. I'll take a message for the team." });
      }
      const b = JSON.parse(raw);
      return json(await accountLookup(b.call || {}, b.args || {}));
    }

    // Phone booking tools — same token + signature as the account tool.
    const bm = path.match(/\/tool\/(find_times|check_address|book|skip|reschedule|cancel)$/);
    if (bm) {
      const raw = await req.text();
      if (!RETELL_KEY || !safeEq(req.headers.get('x-maya-token') || '', await toolToken())) return json({ error: 'forbidden' }, 403);
      if (!(await verifyRetell(raw, req.headers.get('x-retell-signature')))) {
        console.warn(`maya: ${bm[1]} tool call with bad/missing signature`);
        return json({ ok: false, say: "I can't do that right now. Take a message for the team." });
      }
      const b = JSON.parse(raw);
      try { return json(await BOOKING_TOOLS[bm[1]](b.call || {}, b.args || {}, BOOKING_LIVE)); }
      catch (e) { console.error(`maya ${bm[1]} error:`, (e as Error).message); return json({ ok: false, say: 'Something went wrong. Apologize and take a message.' }); }
    }

    if (path.endsWith('/admin-tool')) {
      if (!safeEq(await sha256Hex(req.headers.get('x-maya-admin') || ''), ADMIN_TOKEN_SHA256)) return json({ error: 'forbidden' }, 403);
      const b = await req.json();
      const fn = BOOKING_TOOLS[b.tool];
      if (!fn) return json({ error: 'unknown tool' }, 400);
      // Tests only: ALWAYS dry-run, whatever BOOKING_LIVE says.
      return json(await fn({ from_number: b.from_number || null, call_id: 'admin-test' }, b.args || {}, false));
    }

    if (path.endsWith('/tool/info')) {
      if (!RETELL_KEY || !safeEq(req.headers.get('x-maya-token') || '', await toolToken())) return json({ error: 'forbidden' }, 403);
      return json({ info: await businessInfo() });
    }

    if (path.endsWith('/setup') || path.endsWith('/voices') || path.endsWith('/preview-info')) {
      if (!safeEq(await sha256Hex(req.headers.get('x-maya-admin') || ''), ADMIN_TOKEN_SHA256)) return json({ error: 'forbidden' }, 403);
      if (!RETELL_KEY) return json({ error: 'RETELL_API_KEY not set' }, 500);
      if (path.endsWith('/voices')) return json(await voices());
      if (path.endsWith('/preview-info')) return new Response(await businessInfo());
      const b = await req.json().catch(() => ({}));
      return json(await setup(b.voice_id));
    }
    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.error('maya error:', (e as Error).message);
    // Webhook: 500 makes Retell retry (dedupe protects us).
    return json({ error: (e as Error).message }, 500);
  }
});
