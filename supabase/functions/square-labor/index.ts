import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Session 352: this returns every employee's name, job title and hours. It used to
// answer anyone with the URL. It now requires a signed-in admin, manager or CPA
// (the roles that can open Reports), checked from the caller's own login.
const REPORT_ROLES = new Set(['admin', 'manager', 'cpa']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function authorize(req: Request): Promise<boolean> {
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return false;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) return false;
  const { data: prof } = await db.from('profiles').select('role').eq('id', data.user.id).maybeSingle();
  return REPORT_ROLES.has(prof?.role || '');
}

const SQUARE_BASE = 'https://connect.squareup.com';
const SQ_VERSION = '2024-01-18';
const hdrs = (token: string) => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
  'Square-Version': SQ_VERSION
});

// Job titles that count as driving shifts
const DRIVER_TITLES = new Set(['Driver']);
// Job titles that count as laundry shifts
const LAUNDRY_TITLES = new Set(['Laundry Tech II', 'Laundry Technician I', 'Laundry Technician II']);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!(await authorize(req))) return json(401, { error: 'Sign in as an admin, manager or CPA.' });

  const token = Deno.env.get('SQUARE_ACCESS_TOKEN');
  if (!token) return json(500, { error: 'SQUARE_ACCESS_TOKEN not configured' });

  let from: string, to: string;
  try { ({ from, to } = await req.json()); } catch { return json(400, { error: 'from and to required (YYYY-MM-DD)' }); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return json(400, { error: 'from and to required (YYYY-MM-DD)' });
  }

  // 1. Fetch all CLOSED shifts (paginated)
  const allShifts: any[] = [];
  let cursor: string | undefined;
  do {
    const body: any = {
      query: {
        filter: {
          workday: {
            date_range: { start_date: from, end_date: to },
            match_shifts_by: 'START_AT',
            default_timezone: 'America/Los_Angeles'
          },
          status: 'CLOSED'
        }
      },
      limit: 200
    };
    if (cursor) body.cursor = cursor;
    const res = await fetch(`${SQUARE_BASE}/v2/labor/shifts/search`, {
      method: 'POST', headers: hdrs(token), body: JSON.stringify(body)
    });
    if (!res.ok) {
      const e = await res.text();
      return json(res.status, { error: `Shifts API error: ${e}` });
    }
    const data = await res.json();
    allShifts.push(...(data.shifts || []));
    cursor = data.cursor;
  } while (cursor);

  // 2. Build team member id → name map via SearchTeamMembers
  const memberNames: Record<string, string> = {};
  let tmCursor: string | undefined;
  do {
    const body: any = { limit: 200 };
    if (tmCursor) body.cursor = tmCursor;
    const tmRes = await fetch(`${SQUARE_BASE}/v2/team-members/search`, {
      method: 'POST', headers: hdrs(token), body: JSON.stringify(body)
    });
    if (tmRes.ok) {
      const tmData = await tmRes.json();
      (tmData.team_members || []).forEach((tm: any) => {
        if (tm.id) memberNames[tm.id] = `${tm.given_name || ''} ${tm.family_name || ''}`.trim();
      });
      tmCursor = tmData.cursor;
    } else {
      tmCursor = undefined;
    }
  } while (tmCursor);

  // 3. Sum hours per name, split by role; also track job titles per person
  const driver_hours:  Record<string, number> = {};
  const laundry_hours: Record<string, number> = {};
  const total_hours:   Record<string, number> = {};
  const laundry_titles: Record<string, string> = {}; // name → most specific laundry title

  for (const shift of allShifts) {
    const empId = shift.employee_id || shift.team_member_id;
    const name  = memberNames[empId];
    if (!name || !shift.end_at) continue;

    const start = new Date(shift.start_at);
    const end   = new Date(shift.end_at);
    let breakMins = 0;
    for (const brk of (shift.breaks || [])) {
      if (brk.start_at && brk.end_at && !brk.is_paid) {
        breakMins += (new Date(brk.end_at).getTime() - new Date(brk.start_at).getTime()) / 60000;
      }
    }
    const hrs = (end.getTime() - start.getTime()) / 3600000 - breakMins / 60;
    const title = shift.wage?.title || '';

    total_hours[name] = (total_hours[name] || 0) + hrs;
    if (DRIVER_TITLES.has(title))  driver_hours[name]  = (driver_hours[name]  || 0) + hrs;
    if (LAUNDRY_TITLES.has(title)) {
      laundry_hours[name] = (laundry_hours[name] || 0) + hrs;
      // Track laundry title — prefer the most recent/highest title seen
      // Normalize: 'Laundry Technician I' → 'Laundry Tech I', 'Laundry Technician II' → 'Laundry Tech II'
      let normalized = title
        .replace('Laundry Technician I', 'Laundry Tech I')
        .replace('Laundry Technician II', 'Laundry Tech II');
      // If they already have Tech II, don't downgrade to Tech I
      if (!laundry_titles[name] || normalized.includes('II')) {
        laundry_titles[name] = normalized;
      }
    }
  }

  // Round to 2 decimal places
  const round = (map: Record<string, number>) => {
    Object.keys(map).forEach(k => { map[k] = Math.round(map[k] * 100) / 100; });
    return map;
  };

  return json(200, {
    driver_hours:  round(driver_hours),
    laundry_hours: round(laundry_hours),
    total_hours:   round(total_hours),
    laundry_titles
  });
});
