// maya/booking.ts — phone booking for Maya (phase 3). Ported from twilio-webhook handlePickup
// (sessions 325/2026-09-16 rules: same slot availability as the customer app, capacity, booking
// cutoff, holidays, delivery on the next day a route runs). Kept beside maya for now; move to
// _shared/ when twilio-webhook is switched over to it (one booking engine for SMS + phone).
//
// Nothing here talks to the caller. index.ts turns results into what Maya says.

export type Db = (path: string, init?: RequestInit) => Promise<any>; // throws on non-2xx

const TZ = 'America/Los_Angeles';
export const ptDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const wrDow = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0=Mon

// Offset for the DATE being booked, not today (DST — see twilio-webhook 2026-09-16 note).
function ptOffsetHours(y: number, mo: number, d: number): number {
  const noon = new Date(Date.UTC(y, mo - 1, d, 12));
  const h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(noon));
  return 12 - h;
}
export const ptToUtc = (y: number, mo: number, d: number, h: number, min: number) =>
  new Date(Date.UTC(y, mo - 1, d, h + ptOffsetHours(y, mo, d), min, 0)).toISOString();

function nextDeliveryDay(py: number, pm: number, pd: number, turnaround: number, sched: number[], hol: Set<string>) {
  for (let extra = 0; extra <= 21; extra++) {
    const dt = new Date(Date.UTC(py, pm - 1, pd + turnaround + extra));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (sched.includes(wrDow(y, m, d)) && !hol.has(ds)) return { y, m, d };
  }
  const fb = new Date(Date.UTC(py, pm - 1, pd + turnaround));
  return { y: fb.getUTCFullYear(), m: fb.getUTCMonth() + 1, d: fb.getUTCDate() };
}

export type Slot = {
  id: string; date: string; templateId: string; sameDay: boolean;
  pickupStart: string; pickupEnd: string; deliveryStart: string; deliveryEnd: string;
};
const encodeSlot = (date: string, templateId: string, hhmm: string, sameDay: boolean) =>
  btoa(JSON.stringify([date, templateId, hhmm, sameDay ? 1 : 0])).replace(/=+$/, '');
export function decodeSlot(id: string): { date: string; templateId: string; hhmm: string; sameDay: boolean } | null {
  try {
    const [date, templateId, hhmm, sd] = JSON.parse(atob(String(id)));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[0-9a-f-]{36}$/.test(templateId) || !/^\d{2}:\d{2}$/.test(hhmm)) return null;
    return { date, templateId, hhmm, sameDay: !!sd };
  } catch { return null; }
}

// Open pickup slots for a zone (honours the customer's route override), today + `days`.
// sameDay=true → only morning slots whose order can come back the same evening, with that delivery.
export async function findSlots(db: Db, o: {
  zoneId: string; customerId?: string | null; overrideId?: string | null; sameDay?: boolean; days?: number;
}): Promise<Slot[]> {
  const days = o.days ?? 7;
  const [holRows, tmplRows] = await Promise.all([
    db('holidays?select=holiday_date'),
    db('route_templates?is_active=eq.true&' + (o.overrideId ? `id=eq.${o.overrideId}` : `zone_id=eq.${o.zoneId}`) +
      '&select=id,schedule_days,turnaround_days,turnaround_hours,booking_cutoff_minutes'),
  ]);
  const hol = new Set<string>((holRows || []).map((h: any) => h.holiday_date));
  const tmpl = new Map<string, any>((tmplRows || []).map((t: any) => [t.id, t]));
  const nowMs = Date.now();
  const dates: { date: string; y: number; m: number; d: number }[] = [];
  for (let ahead = 0; ahead <= days; ahead++) {
    const date = ptDateFmt.format(new Date(nowMs + ahead * 86_400_000));
    if (hol.has(date) || dates.some((x) => x.date === date)) continue;
    const [y, m, d] = date.split('-').map(Number);
    dates.push({ date, y, m, d });
  }
  const perDate = await Promise.all(dates.map((dt) =>
    db('rpc/get_slot_availability', { method: 'POST',
      body: JSON.stringify({ p_zone_id: o.zoneId, p_date: dt.date, p_customer_id: o.customerId ?? null }) })
      .catch(() => [])));

  const hm = (t: string) => String(t).split(':').map(Number);
  const out: Slot[] = [];
  perDate.forEach((rows: any[], i) => {
    const dt = dates[i];
    const open = (rows || []).filter((r) => !(r.sub_window_limit != null && Number(r.active_stops) >= Number(r.sub_window_limit)));
    for (const r of open) {
      const t = tmpl.get(r.template_id);
      if (!t) continue;
      const [sh, sm] = hm(r.sub_window_start), [eh, em] = hm(r.sub_window_end);
      const pickupStart = ptToUtc(dt.y, dt.m, dt.d, sh, sm), pickupEnd = ptToUtc(dt.y, dt.m, dt.d, eh, em);
      if (new Date(pickupEnd).getTime() - (t.booking_cutoff_minutes ?? 60) * 60_000 <= nowMs) continue; // too late
      const hhmm = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
      if (o.sameDay) {
        // Same rule as customer-app _checkSameDayAvailable: delivery slot the same day that
        // starts at/after pickup slot end + turnaround_hours, and isn't full.
        if (!(Number(t.turnaround_hours) > 0)) continue;
        const readyMs = new Date(pickupEnd).getTime() + Number(t.turnaround_hours) * 3_600_000;
        const del = open.filter((x) => x !== r)
          .map((x) => { const [a, b] = hm(x.sub_window_start), [c, e] = hm(x.sub_window_end);
            return { s: ptToUtc(dt.y, dt.m, dt.d, a, b), e: ptToUtc(dt.y, dt.m, dt.d, c, e) }; })
          .filter((x) => new Date(x.s).getTime() >= readyMs)
          .sort((a, b) => a.s.localeCompare(b.s))[0];
        if (!del) continue;
        out.push({ id: encodeSlot(dt.date, r.template_id, hhmm, true), date: dt.date, templateId: r.template_id, sameDay: true,
          pickupStart, pickupEnd, deliveryStart: del.s, deliveryEnd: del.e });
      } else {
        const nd = nextDeliveryDay(dt.y, dt.m, dt.d, t.turnaround_days ?? 1, t.schedule_days ?? [0, 1, 2, 3, 4, 5], hol);
        out.push({ id: encodeSlot(dt.date, r.template_id, hhmm, false), date: dt.date, templateId: r.template_id, sameDay: false,
          pickupStart, pickupEnd,
          deliveryStart: ptToUtc(nd.y, nd.m, nd.d, sh, sm), deliveryEnd: ptToUtc(nd.y, nd.m, nd.d, eh, em) });
      }
    }
  });
  return out.sort((a, b) => a.pickupStart.localeCompare(b.pickupStart));
}

// Base service for the customer's price list (same rule as twilio-webhook / customer-app getCustomerService).
export async function baseServiceId(db: Db, pricelist: string | null): Promise<string | null> {
  const svcs: any[] = await db('services?is_active=eq.true&is_addon=eq.false&order=sort_order.asc&select=id,pricelist');
  for (const pl of [pricelist || 'Delivery', 'Delivery']) {
    const hit = svcs.find((s) => s.pricelist === pl);
    if (hit) return hit.id;
  }
  return null;
}

// Where and how an existing customer's pickups go: last delivered order first (same as SMS PICKUP),
// else the default address + its zone.
export async function customerBookingContext(db: Db, customerId: string) {
  const [lastRows, custRows] = await Promise.all([
    db(`orders?customer_id=eq.${customerId}&status=eq.delivered&order=created_at.desc&limit=1` +
      '&select=zone_id,pickup_address_id,delivery_address_id,total_bags'),
    db(`customers?id=eq.${customerId}&select=pricelist,route_template_override_id,stripe_default_payment_method_id,sms_notifications_opt_out_at,phone_cache,fee_exempt,preferences&limit=1`),
  ]);
  const last = lastRows?.[0] || null, cust = custRows?.[0] || {};
  let zoneId: string | null = last?.zone_id || null;
  let pickupAddrId: string | null = last?.pickup_address_id || null;
  let deliveryAddrId: string | null = last?.delivery_address_id || last?.pickup_address_id || null;
  if (!pickupAddrId || !zoneId) {
    const addr = (await db(`addresses?customer_id=eq.${customerId}&order=is_default.desc,created_at.desc&limit=1&select=id,lat,lng,city`))?.[0];
    if (addr && !pickupAddrId) { pickupAddrId = addr.id; deliveryAddrId = addr.id; }
    if (addr && !zoneId && addr.lat != null && addr.lng != null) {
      zoneId = await db('rpc/get_zone_for_point', { method: 'POST',
        body: JSON.stringify({ lat: Number(addr.lat), lng: Number(addr.lng), p_city: addr.city || null }) });
    }
  }
  const cards: any[] = await db(`customer_payment_methods?customer_id=eq.${customerId}&select=id&limit=1`).catch(() => []);
  return {
    zoneId, pickupAddrId, deliveryAddrId, lastBags: last?.total_bags || null,
    pricelist: cust.pricelist || 'Delivery', overrideId: cust.route_template_override_id || null,
    hasCard: (cards?.length || 0) > 0 || !!cust.stripe_default_payment_method_id,
    textsOff: !!cust.sms_notifications_opt_out_at, phone: cust.phone_cache || null, feeExempt: !!cust.fee_exempt,
    preferences: (cust.preferences && typeof cust.preferences === 'object') ? cust.preferences : {},
  };
}

// Upcoming pickups the caller could skip/move: still 'scheduled', pickup not yet started.
export async function upcomingPickups(db: Db, customerId: string) {
  return await db(`orders?customer_id=eq.${customerId}&status=eq.scheduled&archived_at=is.null` +
    `&pickup_window_start=gte.${new Date().toISOString()}` +
    '&select=id,order_number,pickup_window_start,pickup_window_end,delivery_window_start,total_bags,recurring_interval,pickup_address_id,delivery_address_id,zone_id,service_id,special_instructions' +
    '&order=pickup_window_start.asc&limit=5') as any[];
}

// Same insert as twilio-webhook PICKUP (price $0 here; intake prices it and adds delivery/same-day fees).
export async function insertOrder(db: Db, p: {
  customerId: string; serviceId: string; bags: number; slot: Slot; zoneId: string;
  pickupAddrId: string; deliveryAddrId: string; notes?: string | null;
  repeat?: string | null; addonLines?: any[];
}) {
  // Phone requests (add-ons, wash preferences) ride on special_instructions for staff to apply at intake.
  const rows = await db('orders', { method: 'POST', body: JSON.stringify({
    customer_id: p.customerId, service_id: p.serviceId, status: 'scheduled', total_bags: p.bags, total_amount: 0,
    pickup_window_start: p.slot.pickupStart, pickup_window_end: p.slot.pickupEnd,
    delivery_window_start: p.slot.deliveryStart, delivery_window_end: p.slot.deliveryEnd,
    zone_id: p.zoneId, pickup_address_id: p.pickupAddrId, delivery_address_id: p.deliveryAddrId,
    line_items: [{ type: 'base', label: `${p.bags} bag${p.bags !== 1 ? 's' : ''}`, amount: 0 }, ...(p.addonLines || [])],
    // weekly/biweekly/monthly: trg_create_recurring_order_fn books the next one after each delivery/skip
    // (same as a customer-app recurring booking; anchors left NULL like the app).
    source: 'scheduled', recurring_interval: ['weekly', 'biweekly', 'monthly'].includes(String(p.repeat)) ? p.repeat : null,
    special_instructions: p.notes || null,
  }) });
  const o = Array.isArray(rows) ? rows[0] : rows;
  if (!o?.id) throw new Error('order insert returned no row');
  return o as { id: string; order_number: number; routing_error?: string | null };
}

// ── Add-on preferences ──
// Same storage as the customer app: customers.preferences = { "<preferences.id>": "<option id>", _notes }.
// Admin intake prices add-ons FROM these preferences (not from the order), and the app pre-fills the next
// booking from them — so saving them here is what makes future orders follow the caller's choice.
export type PrefGroup = { id: string; name: string; yesId: string; noId: string; price: number; type: string };
export async function prefGroups(db: Db): Promise<PrefGroup[]> {
  const [prefs, svcs] = await Promise.all([
    db('preferences?category=eq.Delivery&select=id,name,options&order=sort_order.asc'),
    db('services?is_active=eq.true&is_addon=eq.true&pricelist=eq.Delivery&linked_preference_id=not.is.null&select=linked_preference_id,base_price,pricing_type'),
  ]);
  const out: PrefGroup[] = [];
  for (const p of prefs || []) {
    const opts: any[] = Array.isArray(p.options) ? p.options : [];
    const no = opts.find((o) => o.is_default) || opts.find((o) => /^no$/i.test(o.label));
    const yes = opts.find((o) => o !== no && /^yes/i.test(o.label)) || opts.find((o) => o !== no);
    const svc = (svcs || []).find((v: any) => v.linked_preference_id === p.id);
    if (!yes || !no) continue;
    out.push({ id: p.id, name: p.name, yesId: yes.id, noId: no.id,
      price: Number(svc?.base_price ?? yes.price_mod ?? 0), type: svc?.pricing_type || 'per_bag' });
  }
  return out;
}
const normName = (x: unknown) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
export function matchGroups(groups: PrefGroup[], names: unknown): PrefGroup[] {
  const want = (Array.isArray(names) ? names : names ? [names] : []).map(normName).filter(Boolean);
  return groups.filter((g) => want.some((w) => { const n = normName(g.name); return n.startsWith(w) || w.startsWith(n) || (w.length >= 4 && n.includes(w)); }));
}
// The caller's add-ons for this order: their saved "Yes" choices, plus what they asked for, minus what they turned off.
export function resolveAddons(groups: PrefGroup[], saved: Record<string, unknown>, on: unknown, off: unknown) {
  const offIds = new Set(matchGroups(groups, off).map((g) => g.id));
  const onIds = new Set(matchGroups(groups, on).map((g) => g.id));
  return groups.filter((g) => !offIds.has(g.id) && (onIds.has(g.id) || saved[g.id] === g.yesId));
}
export const addonLine = (g: PrefGroup, bags: number) => g.type === 'per_item'
  ? { type: 'addon', label: `${g.name} (per item · billed at processing)`, amount: 0, taxable: false }
  : { type: 'addon', label: g.name, amount: g.type === 'flat' ? g.price : g.price * bags, taxable: false };

// Spoken price estimate for a booking, from the live price list (services + service_fees) — the same
// numbers intake charges (base per bag + delivery fee by price list, + same-day surcharge). Intake sets
// the real price by weight; this is only what Maya reads back. Per-lb price lists get no dollar figure.
const usd = (n: number) => '$' + (Math.round(n * 100) % 100 === 0 ? String(Math.round(n)) : n.toFixed(2));
export async function priceEstimate(db: Db, o: { serviceId: string; pricelist: string; bags: number; sameDay: boolean; feeExempt?: boolean; addons?: PrefGroup[] }) {
  const [svcRows, fees] = await Promise.all([
    db(`services?id=eq.${o.serviceId}&select=base_price,pricing_type&limit=1`),
    db('service_fees?is_active=eq.true&select=name,pricelist,amount'),
  ]);
  const svc = svcRows?.[0];
  const fee = (name: string) => {
    const rows = (fees || []).filter((f: any) => f.name === name);
    const r = rows.find((f: any) => f.pricelist === o.pricelist) || rows.find((f: any) => f.pricelist == null);
    return r ? Number(r.amount) : 0;
  };
  const missed = fee('Missed Pickup Fee');
  const same = o.sameDay ? fee('Same-Day Surcharge') : 0;
  if (!svc || svc.pricing_type !== 'per_bag') {
    return { total: null, missedFee: missed, text: 'Priced by weight once we process it' + (same ? `, plus ${usd(same)} for same-day.` : '.') };
  }
  const base = Number(svc.base_price) * o.bags;
  const delivery = o.feeExempt ? 0 : fee('Delivery Fee');
  const adds = (o.addons || []).map((g) => ({ g, amt: g.type === 'flat' ? g.price : g.type === 'per_item' ? 0 : g.price * o.bags }));
  const addAmt = adds.reduce((t, x) => t + x.amt, 0);
  const perItem = adds.filter((x) => x.g.type === 'per_item').map((x) => `${x.g.name} at ${usd(x.g.price)} per item`);
  if (base === 0) {
    return { total: base + delivery + same, missedFee: missed,
      text: `Covered by their plan${delivery ? `, plus ${usd(delivery)} delivery` : ' (delivery included)'}${same ? `, plus ${usd(same)} for same-day` : ''}. Weight over the plan and add-ons are extra.` };
  }
  const parts = [`${o.bags} bag${o.bags > 1 ? 's' : ''} at ${usd(Number(svc.base_price))}`];
  for (const x of adds) if (x.amt) parts.push(`${usd(x.amt)} ${x.g.name}`);
  if (delivery) parts.push(`${usd(delivery)} delivery`);
  if (same) parts.push(`${usd(same)} same-day`);
  const total = base + addAmt + delivery + same;
  return { total, missedFee: missed,
    text: `About ${usd(total)} (${parts.join(' plus ')})${perItem.length ? `, plus ${perItem.join(' and ')}` : ''}. The final price is set when we weigh it: each bag covers up to 25 pounds, and extra weight costs more.` };
}

// ── Address lookup for new callers (copy of admin-assistant/actions.ts geocode, plus line1) ──
export type Geo = { lat: number; lng: number; line1: string; city: string; state: string; zip: string; formatted: string; partial: boolean };
export async function geocode(street: string, city: string, zip: string): Promise<Geo | { error: string }> {
  const q = [street, city, 'CA', zip].filter(Boolean).join(', ');
  const key = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';
  if (!key) return { error: 'not_configured' };
  let j: any;
  try { j = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:US&key=${key}`)).json(); }
  catch { return { error: 'unreachable' }; }
  if (j.status === 'ZERO_RESULTS') return { error: 'not_found' };
  if (j.status !== 'OK' || !j.results?.length) return { error: 'lookup_failed' };
  const r0 = j.results[0];
  const comp = (t: string, short = false) => (r0.address_components || []).find((c: any) => (c.types || []).includes(t))?.[short ? 'short_name' : 'long_name'] || '';
  if (!comp('street_number') || !comp('route')) return { error: 'no_street_number' };
  return {
    lat: r0.geometry.location.lat, lng: r0.geometry.location.lng,
    line1: `${comp('street_number')} ${comp('route', true)}`,
    city: comp('locality') || comp('sublocality') || comp('neighborhood') || city,
    state: comp('administrative_area_level_1', true) || 'CA', zip: comp('postal_code') || zip,
    formatted: r0.formatted_address, partial: !!r0.partial_match,
  };
}
