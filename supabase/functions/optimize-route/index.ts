import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DONE_STATUSES = ['complete', 'failed', 'skipped'];
const SERVICE_TIME_SEC = 240; // 4 minutes per stop (park, walk, handoff, return)

// Session 178: order statuses whose stops the driver will NOT visit, even though
// the route_stops row is still 'pending'. reconcile_order_stops returns early for
// these (v_leg_eligible = false) so the stop lingers on the route. The admin RCC
// and the driver app both already hide them; optimize-route used to route to them
// anyway, inflating every downstream ETA with drive time to a stop nobody makes.
//
// Live case 2026-07-25 Berkeley PM: Leif Martinson and Gadise Reg were both
// on_hold, one of them 8 miles north in El Cerrito. The detour added ~26 minutes
// to the ETA of every stop after them.
const INACTIVE_ORDER_STATUSES = ['on_hold', 'cancelled', 'skipped'];

// Session 178: how old a driver GPS fix may be before we stop trusting it.
const GPS_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes

// Session 335: where every van starts and ends its shift -- the plant at
// 2015 23rd Ave, Oakland (US Census geocoder, 2026-10-07; a van parked at the
// plant reports 37.7881, -122.2322). Used as the starting point when the driver
// has no live GPS yet, and as the finish line of every optimization, because the
// van returns to the plant with its pickups.
//
// Before: no GPS -> origin was the NORTHERNMOST stop, and the finish line was the
// stop FURTHEST from the origin. On 2026-10-01 (Andres, SF) that made a Marina
// customer stop 1 by construction -- the van actually enters SF off the Bay Bridge
// -- and forced the route to end in the Outer Sunset, so Google zig-zagged through
// the middle of the city to get there. And because "furthest stop" moved as the
// driver moved, every re-optimization could flip the whole order.
const PLANT = { lat: 37.78783, lng: -122.23215 };

// Google Directions accepts at most 25 waypoints besides origin + destination.
const GOOGLE_MAX_WAYPOINTS = 25;

// --- Haversine fallback (km) ---
function haversine(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 +
    Math.cos(a.lat * Math.PI/180) * Math.cos(b.lat * Math.PI/180) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// --- The stop's ACTUAL booked window start, in minutes-from-midnight PT ---
// Session 178: the ETA clock floor used to be the template-snapped slot start
// rather than what the customer was actually promised. Those agree while every
// window is grid-aligned, but the booked value is the honest one to hold an ETA
// against -- and it is what the customer was texted.
function getStopBookedStartMins(stop: any): number | null {
  const ts = stop.stop_type === 'delivery'
    ? (stop._order?.delivery_window_start || stop._order?.pickup_window_start)
    : (stop._order?.pickup_window_start || stop._order?.delivery_window_start);
  if (!ts) return null;

  const d = new Date(ts);
  const pacificStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  // Format: "M/D/YYYY, HH:MM:SS"
  const timePart = pacificStr.split(', ')[1] || '00:00:00';
  const [h, m] = timePart.split(':').map(Number);
  return h * 60 + m;
}

// --- The stop's booked window END, in minutes-from-midnight PT ---
function getStopBookedEndMins(stop: any): number | null {
  const ts = stop.stop_type === 'delivery'
    ? (stop._order?.delivery_window_end || stop._order?.pickup_window_end)
    : (stop._order?.pickup_window_end || stop._order?.delivery_window_end);
  if (!ts) return null;

  const d = new Date(ts);
  const pacificStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const timePart = pacificStr.split(', ')[1] || '00:00:00';
  const [h, m] = timePart.split(':').map(Number);
  return h * 60 + m;
}

// --- Determine which time-window slot a stop belongs to ---
// Returns the slot start time in minutes-from-midnight (local),
// e.g. 1080 for 6 PM, 1200 for 8 PM.
// Clamped to valid template range so reassigned stops from other routes
// never create phantom window groups outside the destination route's window.
function getStopWindowStart(
  stop: any,
  tmplStartM: number,
  tmplEndM: number,
  slotDurM: number,
): number {
  const localMins = getStopBookedStartMins(stop);
  if (localMins === null) return tmplStartM; // fallback to first window

  // Snap to slot boundary, clamped to valid template range
  if (slotDurM <= 0) return tmplStartM;
  const slotIdx = Math.floor((localMins - tmplStartM) / slotDurM);
  const maxSlotIdx = Math.max(0, Math.ceil((tmplEndM - tmplStartM) / slotDurM) - 1);
  const clampedIdx = Math.max(0, Math.min(slotIdx, maxSlotIdx));
  return tmplStartM + clampedIdx * slotDurM;
}

// --- Call Google Directions API with optimize:true ---
async function callGoogleOptimize(
  apiKey: string,
  originStr: string,
  destStr: string,
  waypointStops: any[],
  optimize = true,
): Promise<{ waypointOrder: number[]; legs: any[]; distM: number; durSec: number } | null> {
  if (waypointStops.length === 0) {
    // Direct route: origin -> destination, no waypoints
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', originStr);
    url.searchParams.set('destination', destStr);
    url.searchParams.set('departure_time', 'now');
    url.searchParams.set('traffic_model', 'best_guess');
    url.searchParams.set('key', apiKey);
    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.status !== 'OK' || !data.routes?.length) return null;
    const legs = data.routes[0].legs || [];
    const distM = legs.reduce((s: number, l: any) => s + (l.distance?.value || 0), 0);
    const durSec = legs.reduce((s: number, l: any) => s + (l.duration_in_traffic?.value || l.duration?.value || 0), 0);
    return { waypointOrder: [], legs, distM, durSec };
  }

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', originStr);
  url.searchParams.set('destination', destStr);
  url.searchParams.set('waypoints',
    `${optimize ? 'optimize:true|' : ''}${waypointStops.map(s => `${s.lat},${s.lng}`).join('|')}`);
  url.searchParams.set('departure_time', 'now');
  url.searchParams.set('traffic_model', 'best_guess');
  url.searchParams.set('key', apiKey);

  const resp = await fetch(url.toString());
  const data = await resp.json();

  if (data.status !== 'OK' || !data.routes?.length) {
    console.error('Google Directions error:', data.status, data.error_message);
    return null;
  }

  const legs = data.routes[0].legs || [];
  const waypointOrder: number[] = data.routes[0].waypoint_order || [];
  const distM = legs.reduce((s: number, l: any) => s + (l.distance?.value || 0), 0);
  const durSec = legs.reduce((s: number, l: any) => s + (l.duration_in_traffic?.value || l.duration?.value || 0), 0);

  return { waypointOrder, legs, distM, durSec };
}

// --- Order a group of stops (single time window) ---
// origin -> [stops] -> endPoint. endPoint is NOT a stop: it is the plant for the
// last window, or the middle of the next window's stops for an earlier window, so
// the order leans toward where the van goes next. The drive leg to endPoint is
// only there to shape the order; it is not counted in any ETA.
// optimize=false keeps the stops in the order given (ETA-only refresh, pinned
// en-route stops).
// Returns: ordered stops with _legDurSec (drive time to reach this stop from previous)
async function orderWindow(
  apiKey: string,
  stops: any[],
  origin: { lat: number; lng: number },
  endPoint: { lat: number; lng: number },
  optimize: boolean,
): Promise<{ ordered: any[]; totalDurSec: number } | null> {
  if (stops.length === 0) return { ordered: [], totalDurSec: 0 };
  if (stops.length > GOOGLE_MAX_WAYPOINTS) {
    console.error(`[optimize-route] ${stops.length} stops in one group exceeds Google's ` +
      `${GOOGLE_MAX_WAYPOINTS}-waypoint limit -- keeping their current order`);
    return null;
  }

  const result = await callGoogleOptimize(
    apiKey,
    `${origin.lat},${origin.lng}`,
    `${endPoint.lat},${endPoint.lng}`,
    stops,
    optimize,
  );
  if (!result) return null;

  const ordered = (optimize && result.waypointOrder.length === stops.length)
    ? result.waypointOrder.map((idx: number) => stops[idx])
    : [...stops];

  // legs[0] is origin->first stop, legs[i] is stop i-1 -> stop i. The final leg
  // (last stop -> endPoint) is deliberately ignored.
  let totalDurSec = 0;
  for (let i = 0; i < ordered.length; i++) {
    const leg = result.legs[i];
    ordered[i]._legDurSec = leg?.duration_in_traffic?.value || leg?.duration?.value || 0;
    totalDurSec += ordered[i]._legDurSec;
  }
  return { ordered, totalDurSec };
}

// Middle of a set of stops -- where the van is heading next.
function centroid(stops: any[]): { lat: number; lng: number } {
  const lat = stops.reduce((t, s) => t + Number(s.lat), 0) / stops.length;
  const lng = stops.reduce((t, s) => t + Number(s.lng), 0) / stops.length;
  return { lat, lng };
}


Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'GOOGLE_MAPS_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Session 335: mode 'eta_only' (the 5-minute background refresh) recomputes
    // ETAs along the CURRENT order and never renumbers stops -- the driver's list
    // must not reshuffle while he is driving. Re-ordering happens only when a stop
    // is completed / skipped / added, or when someone presses Optimize.
    // dry_run: compute and return the plan, write nothing.
    const { route_id, driver_lat, driver_lng, mode, dry_run } = await req.json();
    const etaOnly = mode === 'eta_only';
    const dryRun = dry_run === true;
    if (!route_id) {
      return new Response(JSON.stringify({ error: 'route_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, supabaseKey);

    // -- 1. Fetch route + template --
    const { data: route } = await db.from('routes')
      .select('id, template_id, run_date, driver_id')
      .eq('id', route_id)
      .single();
    if (!route) {
      return new Response(JSON.stringify({ error: 'Route not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: template } = await db.from('route_templates')
      .select('window_start, window_end, arrival_window_hours')
      .eq('id', route.template_id)
      .single();

    // Parse template time windows (local time)
    const toMins = (t: string) => {
      const [h, m] = (t || '00:00').split(':').map(Number);
      return h * 60 + (m || 0);
    };
    const tmplStartM = toMins(template?.window_start || '18:00');
    const tmplEndM = toMins(template?.window_end || '22:00');
    const arrivalHrs = template?.arrival_window_hours || 2;
    const slotDurM = arrivalHrs * 60;

    // -- 2. Fetch all stops with order + address data --
    // Session 178: also pull orders.status (to drop stops the driver will never
    // make) and route_stops.completed_at (to anchor the ETA clock on the last
    // stop the driver actually finished when GPS is missing or stale).
    const { data: stops, error: stopsErr } = await db.from('route_stops')
      .select(`id, stop_number, stop_type, status, address_id, completed_at,
               orders!inner(id, customer_id, status, pickup_address_id, delivery_address_id,
                 pickup_window_start, pickup_window_end, delivery_window_start, delivery_window_end)`)
      .eq('route_id', route_id)
      .order('stop_number');

    if (stopsErr) throw stopsErr;
    if (!stops || stops.length === 0) {
      return new Response(JSON.stringify({ success: true, stops_optimized: 0, message: 'No stops found', at_risk: [] }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // -- 3. Resolve addresses --
    const explicitAddrIds = stops.flatMap((s: any) => {
      return [s.address_id, s.orders?.pickup_address_id, s.orders?.delivery_address_id].filter(Boolean);
    });
    const custIds = [...new Set(stops.map((s: any) => s.orders?.customer_id).filter(Boolean))];

    const [{ data: explicitAddrs }, { data: fallbackAddrs }] = await Promise.all([
      explicitAddrIds.length
        ? db.from('addresses').select('id, customer_id, lat, lng').in('id', [...new Set(explicitAddrIds)])
        : Promise.resolve({ data: [] }),
      custIds.length
        ? db.from('addresses').select('id, customer_id, lat, lng, is_default').in('customer_id', custIds).order('is_default', { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);

    const addrById: Record<string, any> = {};
    (explicitAddrs || []).forEach((a: any) => { addrById[a.id] = a; });
    const fallbackByCust: Record<string, any> = {};
    (fallbackAddrs || []).forEach((a: any) => { if (!fallbackByCust[a.customer_id]) fallbackByCust[a.customer_id] = a; });

    // Enrich stops with lat/lng and order data
    const enriched = stops.map((s: any) => {
      const sameLeg = s.stop_type === 'pickup' ? s.orders?.pickup_address_id : s.orders?.delivery_address_id;
      const otherLeg = s.stop_type === 'pickup' ? s.orders?.delivery_address_id : s.orders?.pickup_address_id;
      const addrId = s.address_id || sameLeg || otherLeg;
      const addr = (addrId && addrById[addrId]) || fallbackByCust[s.orders?.customer_id] || null;
      return {
        ...s,
        _order: s.orders,
        lat: addr?.lat || null,
        lng: addr?.lng || null,
      };
    });

    // -- 4. Separate done vs pending --
    const done = enriched.filter((s: any) => DONE_STATUSES.includes(s.status));

    // Session 178: a stop whose ORDER is on hold / cancelled / skipped is not
    // going to be visited, even though its route_stops row still reads 'pending'.
    // Leave its stop_number and estimated_arrival untouched and keep it out of
    // both the geographic optimization and the ETA chain.
    const allPending = enriched.filter((s: any) => !DONE_STATUSES.includes(s.status));
    const inactive = allPending.filter((s: any) => INACTIVE_ORDER_STATUSES.includes(s._order?.status));
    const pending = allPending.filter((s: any) => !INACTIVE_ORDER_STATUSES.includes(s._order?.status));

    if (inactive.length > 0) {
      console.log(`[optimize-route] Excluding ${inactive.length} stop(s) whose order is ` +
        `${INACTIVE_ORDER_STATUSES.join('/')}: ` +
        inactive.map((s: any) => `${s.id.slice(0,8)}(${s._order?.status})`).join(', '));
    }

    const pendingWithAddr = pending.filter((s: any) => s.lat && s.lng);
    const pendingNoAddr = pending.filter((s: any) => !s.lat || !s.lng);

    // -- 4b. Decide where the driver actually is --
    // Session 178: previously, with no driver GPS the origin fell back to the
    // NORTHERNMOST pending stop, and that stop then got a zero-minute drive leg --
    // i.e. the model teleported the van to a stop it had not reached yet. On
    // 2026-07-25 the driver's phone last reported at 6:54 PM; the 9:19 PM recompute
    // anchored the whole chain in El Cerrito, 8 miles from where he was.
    //
    // Preference order:
    //   1. driver GPS passed in by the caller (assumed fresh)
    //   2. the last stop the driver actually completed on this route
    //   3. driver row's last known location, if recent enough
    //   4. the plant (session 335 -- was: northernmost pending stop)
    const lastCompleted = done
      .filter((s: any) => s.completed_at && s.lat && s.lng)
      .sort((a: any, b: any) =>
        new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())[0] || null;

    let staleDriverFix: { lat: number; lng: number } | null = null;
    if ((!driver_lat || !driver_lng) && !lastCompleted && route.driver_id) {
      const { data: drv } = await db.from('drivers')
        .select('current_lat, current_lng, last_location_update')
        .eq('id', route.driver_id)
        .maybeSingle();
      if (drv?.current_lat && drv?.current_lng && drv?.last_location_update) {
        const age = Date.now() - new Date(drv.last_location_update).getTime();
        if (age <= GPS_MAX_AGE_MS) {
          staleDriverFix = { lat: Number(drv.current_lat), lng: Number(drv.current_lng) };
        } else {
          console.log(`[optimize-route] Ignoring driver GPS fix ${Math.round(age/60000)}min old`);
        }
      }
    }

    let originSource = 'plant';
    let resolvedOrigin: { lat: number; lng: number } | null = null;
    if (driver_lat && driver_lng) {
      resolvedOrigin = { lat: Number(driver_lat), lng: Number(driver_lng) };
      originSource = 'driver_gps';
    } else if (lastCompleted) {
      resolvedOrigin = { lat: Number(lastCompleted.lat), lng: Number(lastCompleted.lng) };
      originSource = 'last_completed_stop';
    } else if (staleDriverFix) {
      resolvedOrigin = staleDriverFix;
      originSource = 'driver_row_recent';
    }

    if (pendingWithAddr.length < 2) {
      // Nothing meaningful to optimize -- just compute ETA for single stop
      if (pendingWithAddr.length === 1 && resolvedOrigin) {
        const s = pendingWithAddr[0];
        const dist = haversine(resolvedOrigin, s);
        const durSec = Math.round(dist / 40 * 3600);
        const eta = new Date(Date.now() + durSec * 1000);
        await db.from('route_stops').update({ estimated_arrival: eta.toISOString() }).eq('id', s.id);
      }
      return new Response(JSON.stringify({
        success: true, stops_optimized: pendingWithAddr.length,
        message: 'Too few stops to optimize', at_risk: [],
        excluded_inactive: inactive.length,
        origin_source: originSource,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // -- 5. Group pending stops by time window --
    const windowGroups: Record<number, any[]> = {};
    pendingWithAddr.forEach(s => {
      const winStart = getStopWindowStart(s, tmplStartM, tmplEndM, slotDurM);
      if (!windowGroups[winStart]) windowGroups[winStart] = [];
      windowGroups[winStart].push(s);
    });

    // Sort window keys chronologically
    const windowKeys = Object.keys(windowGroups).map(Number).sort((a, b) => a - b);
    console.log(`[optimize-route] ${pendingWithAddr.length} stops in ${windowKeys.length} window(s): ${windowKeys.map(k => `${Math.floor(k/60)}:${String(k%60).padStart(2,'0')}(${windowGroups[k].length})`).join(', ')}`);

    // -- 5b. Single-pass optimization for routes within Google waypoint limit --
    // Single-pass optimization is only safe when all stops share one booked window.
    // When multiple windows are present (e.g. a PM route covering both 6-8 PM and
    // 8-10 PM slots), merging them would let Google reorder purely by geography
    // and hand 8 PM customers an ETA of 6:08 PM. Optimize each window separately.
    const useSinglePass = pendingWithAddr.length <= GOOGLE_MAX_WAYPOINTS && windowKeys.length === 1;
    if (useSinglePass) {
      console.log(`[optimize-route] Single-pass mode: ${pendingWithAddr.length} stops in 1 window`);
    }

    // -- 6. Determine starting position --
    let currentOrigin: { lat: number; lng: number };
    if (resolvedOrigin) {
      currentOrigin = resolvedOrigin;
    } else {
      // No GPS and nothing completed yet -- the van leaves from the plant.
      currentOrigin = { ...PLANT };
      originSource = 'plant';
    }
    console.log(`[optimize-route] Origin source: ${originSource} (${currentOrigin.lat.toFixed(5)}, ${currentOrigin.lng.toFixed(5)})`);

    // -- 7. Build the driving order --
    const finalOrder: any[] = [];
    let totalDriveSec = 0;
    let googleCallCount = 0;

    // Append stops in a fixed order (Google gives drive times only), in chunks
    // that fit the waypoint limit. If Google fails, the stops still go in, with
    // no drive time -- same fallback as before.
    const appendInOrder = async (list: any[]) => {
      for (let i = 0; i < list.length; i += GOOGLE_MAX_WAYPOINTS) {
        const chunk = list.slice(i, i + GOOGLE_MAX_WAYPOINTS);
        googleCallCount++;
        const r = await orderWindow(apiKey, chunk, currentOrigin, PLANT, false);
        finalOrder.push(...(r ? r.ordered : chunk));
        if (r) totalDriveSec += r.totalDurSec;
        const last = chunk[chunk.length - 1];
        currentOrigin = { lat: Number(last.lat), lng: Number(last.lng) };
      }
    };

    if (etaOnly) {
      // Keep today's order exactly as the driver sees it (stops arrive sorted by
      // stop_number). Only the ETAs move.
      await appendInOrder(pendingWithAddr);
    } else {
      // Session 335: a stop the driver is already heading to ('en_route' -- he
      // tapped Notify and the customer was texted) always stays first.
      const pinned = pendingWithAddr.filter((s: any) => s.status === 'en_route');
      if (pinned.length > 0) {
        console.log(`[optimize-route] Keeping ${pinned.length} en-route stop(s) first`);
        await appendInOrder(pinned);
      }

      // Optimize each window in turn. The last window finishes at the plant; an
      // earlier one finishes toward the middle of the next window's stops.
      const windowList = windowKeys
        .map(k => windowGroups[k].filter((s: any) => s.status !== 'en_route'))
        .filter(g => g.length > 0);
      for (let w = 0; w < windowList.length; w++) {
        const group = windowList[w];
        const endPoint = w < windowList.length - 1 ? centroid(windowList[w + 1]) : PLANT;
        googleCallCount++;

        const result = await orderWindow(apiKey, group, currentOrigin, endPoint, true);
        const placed = (result && result.ordered.length > 0) ? result.ordered : group; // Google failed -> original order
        if (result) totalDriveSec += result.totalDurSec;
        finalOrder.push(...placed);
        // Next window starts from last stop of this window
        const last = placed[placed.length - 1];
        currentOrigin = { lat: Number(last.lat), lng: Number(last.lng) };
      }
    }

    // Add stops without addresses at the end (rare edge case)
    finalOrder.push(...pendingNoAddr);

    // -- 8. Compute ETAs --
    const now = new Date();
    let clock = now.getTime(); // milliseconds
    const atRisk: any[] = [];

    // Helper: convert minutes-from-midnight PT on run_date to a UTC timestamp (ms).
    const runDate = route.run_date || now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const winStartMsCache = new Map<number, number>();
    const ptMinsToUtcMs = (mins: number): number => {
      const cached = winStartMsCache.get(mins);
      if (cached !== undefined) return cached;
      const hour = Math.floor(mins / 60);
      const min = mins % 60;
      const pacificDateStr = `${runDate}T${String(hour).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
      const tempDate = new Date(pacificDateStr + 'Z'); // treat as UTC temporarily
      const utcStr = tempDate.toLocaleString('en-US', { timeZone: 'UTC' });
      const ptStr = tempDate.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const offsetMs = new Date(utcStr).getTime() - new Date(ptStr).getTime();
      const ms = tempDate.getTime() + offsetMs;
      winStartMsCache.set(mins, ms);
      return ms;
    };

    // If no driver GPS, start the clock at route window start (today's date + window_start)
    if (!driver_lat || !driver_lng) {
      let refMs = ptMinsToUtcMs(tmplStartM);
      // Session 335: leaving from the plant, assume the van departs early enough
      // to reach the first stop at window start (it used to "start" AT stop 1).
      if (originSource === 'plant' && finalOrder[0]?._legDurSec) {
        refMs -= finalOrder[0]._legDurSec * 1000;
      }
      if (refMs > now.getTime()) {
        clock = refMs;
      }
    }

    // Session 178: never rewind the clock behind the last stop the driver finished.
    if (lastCompleted?.completed_at) {
      const doneMs = new Date(lastCompleted.completed_at).getTime();
      if (doneMs > clock) clock = doneMs;
    }

    for (const stop of finalOrder) {
      // Add drive time to this stop
      const driveSec = stop._legDurSec || 0;
      clock += driveSec * 1000;

      // Clock floor: a stop's ETA can never be earlier than its booked window's start.
      // Without this, a driver running ahead of schedule would be told to arrive at
      // an 8-10 PM customer at 6:08 PM. If we arrive early, the clock waits.
      //
      // Session 178: hold the ETA against the window the customer was actually
      // promised, not the template-snapped slot. These agree whenever the window is
      // grid-aligned; the booked value is the one that was texted to the customer.
      const slotStart = getStopWindowStart(stop, tmplStartM, tmplEndM, slotDurM);
      const bookedStart = getStopBookedStartMins(stop);
      const floorMins = (bookedStart !== null && bookedStart >= tmplStartM && bookedStart < tmplEndM)
        ? bookedStart
        : slotStart;
      const winStartMs = ptMinsToUtcMs(floorMins);
      if (clock < winStartMs) clock = winStartMs;

      const eta = new Date(clock);
      stop._eta = eta;

      // Check if at-risk (ETA past this stop's window deadline).
      // Session 178: measure against the booked window end where we have one.
      const bookedEnd = getStopBookedEndMins(stop);
      const winEnd = (bookedEnd !== null && bookedEnd > floorMins)
        ? bookedEnd
        : slotStart + slotDurM; // e.g., 1080 + 120 = 1200 (8 PM)
      const etaPacific = eta.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
      const etaTimePart = etaPacific.split(', ')[1] || '00:00:00';
      const [eh, em] = etaTimePart.split(':').map(Number);
      const etaMins = eh * 60 + em;

      if (etaMins > winEnd) {
        const custId = stop._order?.customer_id || '';
        atRisk.push({
          stop_id: stop.id,
          stop_type: stop.stop_type,
          customer_id: custId,
          eta: eta.toISOString(),
          window_end_mins: winEnd,
          eta_mins: etaMins,
          late_by_mins: etaMins - winEnd,
        });
      }

      // Add service time (driver is at this stop for ~4 min)
      clock += SERVICE_TIME_SEC * 1000;
    }

    // -- 9. Write updated stop_number + estimated_arrival to DB --
    // Session 178: renumber above BOTH the done stops and any inactive stops we
    // skipped, so an excluded on-hold stop never collides with an active one.
    const numbered = [...done, ...inactive];
    const maxDone = numbered.length > 0
      ? Math.max(...numbered.map((s: any) => s.stop_number || 0))
      : 0;

    // eta_only never touches stop_number (no reshuffle); dry_run writes nothing.
    if (!dryRun) {
      const updates = finalOrder.map((s: any, i: number) =>
        db.from('route_stops').update(etaOnly
          ? { estimated_arrival: s._eta?.toISOString() || null }
          : { stop_number: maxDone + i + 1, estimated_arrival: s._eta?.toISOString() || null }
        ).eq('id', s.id)
      );
      const writeResults = await Promise.all(updates);
      const writeErrors = writeResults.filter((r: any) => r.error);
      if (writeErrors.length > 0) {
        console.error(`[optimize-route] ${writeErrors.length} stop update(s) failed:`, writeErrors[0].error);
      }
    }

    // -- 10. Log & return summary --
    const totalDriveMin = Math.round(totalDriveSec / 60);
    console.log(
      `[optimize-route] Done: ${finalOrder.length} stops, ` +
      `${totalDriveMin}min drive, ${atRisk.length} at-risk, ` +
      `${googleCallCount} Google calls, origin=${originSource}, ` +
      `excluded_inactive=${inactive.length}, mode=${etaOnly ? 'eta_only' : 'optimize'}` +
      (dryRun ? ', DRY RUN' : '')
    );

    return new Response(JSON.stringify({
      success: true,
      mode: etaOnly ? 'eta_only' : 'optimize',
      dry_run: dryRun,
      stops_optimized: finalOrder.length,
      total_drive_minutes: totalDriveMin,
      at_risk: atRisk,
      google_calls: googleCallCount,
      driver_origin_used: !!(driver_lat && driver_lng),
      origin_source: originSource,
      excluded_inactive: inactive.length,
      excluded_inactive_stop_ids: inactive.map((s: any) => s.id),
      windows: windowKeys.map(k => ({
        start_mins: k,
        label: `${Math.floor(k/60) % 12 || 12}:${String(k%60).padStart(2,'0')} ${k >= 720 ? 'PM' : 'AM'}`,
        stops: windowGroups[k]?.length || 0,
      })),
      ...(dryRun ? { planned_order: finalOrder.map((s: any) => ({ id: s.id, eta: s._eta?.toISOString() || null })) } : {}),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('optimize-route error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
