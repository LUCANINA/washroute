import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DONE_STATUSES = ['complete', 'failed', 'skipped'];
const SERVICE_TIME_SEC = 240; // 4 minutes per stop (park, walk, handoff, return)

// ─── Haversine fallback (km) ───
function haversine(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 +
    Math.cos(a.lat * Math.PI/180) * Math.cos(b.lat * Math.PI/180) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ─── Determine which time-window slot a stop belongs to ───
// Returns the slot start time in minutes-from-midnight (local),
// e.g. 1080 for 6 PM, 1200 for 8 PM.
function getStopWindowStart(
  stop: any,
  tmplStartM: number,
  slotDurM: number,
): number {
  // Use the order's booked window to determine the slot
  const ts = stop.stop_type === 'delivery'
    ? (stop._order?.delivery_window_start || stop._order?.pickup_window_start)
    : (stop._order?.pickup_window_start || stop._order?.delivery_window_start);
  if (!ts) return tmplStartM; // fallback to first window

  // Convert to Pacific time hours/minutes
  const d = new Date(ts);
  const pacificStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  // Format: "M/D/YYYY, HH:MM:SS"
  const timePart = pacificStr.split(', ')[1] || '00:00:00';
  const [h, m] = timePart.split(':').map(Number);
  const localMins = h * 60 + m;

  // Snap to slot boundary
  if (slotDurM <= 0) return tmplStartM;
  const slotIdx = Math.floor((localMins - tmplStartM) / slotDurM);
  return tmplStartM + Math.max(0, slotIdx) * slotDurM;
}

// ─── Call Google Directions API with optimize:true ───
async function callGoogleOptimize(
  apiKey: string,
  originStr: string,
  destStr: string,
  waypointStops: any[],
): Promise<{ waypointOrder: number[]; legs: any[]; distM: number; durSec: number } | null> {
  if (waypointStops.length === 0) {
    // Direct route: origin → destination, no waypoints
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
    `optimize:true|${waypointStops.map(s => `${s.lat},${s.lng}`).join('|')}`);
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

// ─── Optimize a group of stops (single time window) ───
// Returns: ordered stops with _legDurSec (drive time to reach this stop from previous)
async function optimizeWindow(
  apiKey: string,
  stops: any[],
  origin: { lat: number; lng: number },
): Promise<{ ordered: any[]; totalDurSec: number } | null> {
  if (stops.length === 0) return { ordered: [], totalDurSec: 0 };
  if (stops.length === 1) {
    const dur = haversine(origin, stops[0]) / 40 * 3600; // rough estimate 40km/h
    stops[0]._legDurSec = Math.round(dur);
    return { ordered: stops, totalDurSec: Math.round(dur) };
  }

  // Use geographic extremes relative to origin to pick a good destination
  // The stop furthest from origin = natural endpoint
  const byDistFromOrigin = [...stops].sort((a, b) =>
    haversine(origin, b) - haversine(origin, a)
  );
  const dest = byDistFromOrigin[0]; // furthest stop = destination
  const waypoints = stops.filter(s => s.id !== dest.id);

  const originStr = `${origin.lat},${origin.lng}`;
  const destStr = `${dest.lat},${dest.lng}`;

  const result = await callGoogleOptimize(apiKey, originStr, destStr, waypoints);
  if (!result) return null;

  // Reconstruct ordered list
  const ordered: any[] = [];
  if (waypoints.length > 0) {
    for (const idx of result.waypointOrder) {
      ordered.push(waypoints[idx]);
    }
  }
  ordered.push(dest); // destination is last

  // Attach leg durations — legs[0] is origin→first stop, legs[1] is first→second, etc.
  for (let i = 0; i < ordered.length; i++) {
    const leg = result.legs[i];
    ordered[i]._legDurSec = leg?.duration_in_traffic?.value || leg?.duration?.value || 0;
  }

  return { ordered, totalDurSec: result.durSec };
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

    const { route_id, driver_lat, driver_lng } = await req.json();
    if (!route_id) {
      return new Response(JSON.stringify({ error: 'route_id is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const db = createClient(supabaseUrl, supabaseKey);

    // ── 1. Fetch route + template ──
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

    // ── 2. Fetch all stops with order + address data ──
    const { data: stops, error: stopsErr } = await db.from('route_stops')
      .select(`id, stop_number, stop_type, status, address_id,
               orders!inner(id, customer_id, pickup_address_id, delivery_address_id,
                 pickup_window_start, pickup_window_end, delivery_window_start, delivery_window_end)`)
      .eq('route_id', route_id)
      .order('stop_number');

    if (stopsErr) throw stopsErr;
    if (!stops || stops.length === 0) {
      return new Response(JSON.stringify({ success: true, stops_optimized: 0, message: 'No stops found', at_risk: [] }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── 3. Resolve addresses ──
    // Collect all address IDs (stop-level, order-level pickup/delivery, and customer defaults)
    const explicitAddrIds = stops.map((s: any) => {
      return s.address_id
        || (s.stop_type === 'pickup' ? s.orders?.pickup_address_id : s.orders?.delivery_address_id)
        || null;
    }).filter(Boolean);
    const custIds = [...new Set(stops.map((s: any) => s.orders?.customer_id).filter(Boolean))];

    const [{ data: explicitAddrs }, { data: defaultAddrs }] = await Promise.all([
      explicitAddrIds.length
        ? db.from('addresses').select('id, customer_id, lat, lng').in('id', [...new Set(explicitAddrIds)])
        : Promise.resolve({ data: [] }),
      custIds.length
        ? db.from('addresses').select('id, customer_id, lat, lng').in('customer_id', custIds).eq('is_default', true)
        : Promise.resolve({ data: [] }),
    ]);

    const addrById: Record<string, any> = {};
    (explicitAddrs || []).forEach((a: any) => { addrById[a.id] = a; });
    const defaultByCust: Record<string, any> = {};
    (defaultAddrs || []).forEach((a: any) => { defaultByCust[a.customer_id] = a; });

    // Enrich stops with lat/lng and order data
    const enriched = stops.map((s: any) => {
      const addrId = s.address_id
        || (s.stop_type === 'pickup' ? s.orders?.pickup_address_id : s.orders?.delivery_address_id);
      const addr = (addrId && addrById[addrId]) || defaultByCust[s.orders?.customer_id] || null;
      return {
        ...s,
        _order: s.orders,
        lat: addr?.lat || null,
        lng: addr?.lng || null,
      };
    });

    // ── 4. Separate done vs pending ──
    const done = enriched.filter((s: any) => DONE_STATUSES.includes(s.status));
    const pending = enriched.filter((s: any) => !DONE_STATUSES.includes(s.status));
    const pendingWithAddr = pending.filter((s: any) => s.lat && s.lng);
    const pendingNoAddr = pending.filter((s: any) => !s.lat || !s.lng);

    if (pendingWithAddr.length < 2) {
      // Nothing meaningful to optimize — just compute ETA for single stop
      if (pendingWithAddr.length === 1 && driver_lat && driver_lng) {
        const s = pendingWithAddr[0];
        const dist = haversine({ lat: driver_lat, lng: driver_lng }, s);
        const durSec = Math.round(dist / 40 * 3600);
        const eta = new Date(Date.now() + durSec * 1000);
        await db.from('route_stops').update({ estimated_arrival: eta.toISOString() }).eq('id', s.id);
      }
      return new Response(JSON.stringify({
        success: true, stops_optimized: pendingWithAddr.length,
        message: 'Too few stops to optimize', at_risk: [],
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── 5. Group pending stops by time window ──
    const windowGroups: Record<number, any[]> = {};
    pendingWithAddr.forEach(s => {
      const winStart = getStopWindowStart(s, tmplStartM, slotDurM);
      if (!windowGroups[winStart]) windowGroups[winStart] = [];
      windowGroups[winStart].push(s);
    });

    // Sort window keys chronologically
    const windowKeys = Object.keys(windowGroups).map(Number).sort((a, b) => a - b);
    console.log(`[optimize-route] ${pendingWithAddr.length} stops in ${windowKeys.length} window(s): ${windowKeys.map(k => `${Math.floor(k/60)}:${String(k%60).padStart(2,'0')}(${windowGroups[k].length})`).join(', ')}`);

    // ── 6. Determine starting position ──
    let currentOrigin: { lat: number; lng: number };
    if (driver_lat && driver_lng) {
      currentOrigin = { lat: Number(driver_lat), lng: Number(driver_lng) };
    } else {
      // No driver GPS — use centroid of first window's stops as starting estimate,
      // then let Google optimize from the nearest stop
      const firstGroup = windowGroups[windowKeys[0]];
      const byLat = [...firstGroup].sort((a, b) => b.lat - a.lat);
      currentOrigin = { lat: byLat[0].lat, lng: byLat[0].lng }; // northernmost
    }

    // ── 7. Optimize each window sequentially ──
    const finalOrder: any[] = [];
    let totalDriveSec = 0;
    let googleCallCount = 0;

    for (const winKey of windowKeys) {
      const group = windowGroups[winKey];
      googleCallCount++;

      const result = await optimizeWindow(apiKey, group, currentOrigin);
      if (result && result.ordered.length > 0) {
        finalOrder.push(...result.ordered);
        totalDriveSec += result.totalDurSec;
        // Next window starts from last stop of this window
        const last = result.ordered[result.ordered.length - 1];
        currentOrigin = { lat: last.lat, lng: last.lng };
      } else {
        // Google failed — add stops in original order
        finalOrder.push(...group);
        if (group.length > 0) {
          const last = group[group.length - 1];
          currentOrigin = { lat: last.lat, lng: last.lng };
        }
      }
    }

    // Add stops without addresses at the end (rare edge case)
    finalOrder.push(...pendingNoAddr);

    // ── 8. Compute ETAs ──
    const now = new Date();
    let clock = now.getTime(); // milliseconds
    const atRisk: any[] = [];

    // If no driver GPS, start the clock at route window start (today's date + window_start)
    if (!driver_lat || !driver_lng) {
      // Build today's window start as a Pacific time timestamp
      const runDate = route.run_date || now.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      const startHour = Math.floor(tmplStartM / 60);
      const startMin = tmplStartM % 60;
      // Create date in Pacific time
      const pacificDateStr = `${runDate}T${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00`;
      // Parse as Pacific time by appending the offset (approximate)
      // Use Intl to get the correct offset
      const refDate = new Date(`${pacificDateStr}-07:00`); // PDT offset
      if (refDate.getTime() > now.getTime()) {
        clock = refDate.getTime();
      }
    }

    for (const stop of finalOrder) {
      // Add drive time to this stop
      const driveSec = stop._legDurSec || 0;
      clock += driveSec * 1000;

      const eta = new Date(clock);
      stop._eta = eta;

      // Check if at-risk (ETA past this stop's window deadline)
      const winStart = getStopWindowStart(stop, tmplStartM, slotDurM);
      const winEnd = winStart + slotDurM; // e.g., 1080 + 120 = 1200 (8 PM)
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

    // ── 9. Write updated stop_number + estimated_arrival to DB ──
    const maxDone = done.length > 0
      ? Math.max(...done.map((s: any) => s.stop_number || 0))
      : 0;

    const updates = finalOrder.map((s: any, i: number) =>
      db.from('route_stops').update({
        stop_number: maxDone + i + 1,
        estimated_arrival: s._eta?.toISOString() || null,
      }).eq('id', s.id)
    );
    await Promise.all(updates);

    // ── 10. Log & return summary ──
    const totalDriveMin = Math.round(totalDriveSec / 60);
    console.log(
      `[optimize-route] Done: ${finalOrder.length} stops, ` +
      `${totalDriveMin}min drive, ${atRisk.length} at-risk, ` +
      `${googleCallCount} Google calls, driver_gps=${!!driver_lat}`
    );

    return new Response(JSON.stringify({
      success: true,
      stops_optimized: finalOrder.length,
      total_drive_minutes: totalDriveMin,
      at_risk: atRisk,
      google_calls: googleCallCount,
      driver_origin_used: !!(driver_lat && driver_lng),
      windows: windowKeys.map(k => ({
        start_mins: k,
        label: `${Math.floor(k/60) % 12 || 12}:${String(k%60).padStart(2,'0')} ${k >= 720 ? 'PM' : 'AM'}`,
        stops: windowGroups[k]?.length || 0,
      })),
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
