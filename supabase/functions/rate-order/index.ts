// rate-order (session 333) — rate an order from a signed link, no sign-in.
//
// Public endpoint (verify_jwt FALSE — the caller is a customer with no login).
// Every request must carry the order id + its HMAC token (see _shared/rate-token.ts);
// without a valid token it does nothing. Writes go through submit_order_feedback
// (same rules as the app: delivered orders only, editable 14 days, 1–3★ opens a
// staff issue, Google link offered to every rater).
//
// POST { action: 'load' | 'submit' | 'clicked', o, t, rating?, comment? }
// POST { action: 'make_link', o } — staff or internal (x-wr-internal) only: returns the
//   signed link for an order, e.g. to resend it by hand to a customer.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { verifyRateToken, rateLink } from '../_shared/rate-token.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const APP = 'https://app.familylaundry.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORIGIN_OK = (o: string) => o === APP || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin': ORIGIN_OK(origin) ? origin : APP,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-client-info',
    'Vary': 'Origin',
  };
}

const LINK_ROLES = new Set(['admin', 'manager', 'attendant']);

// Same pattern as charge-order authorize(): DB callers send the wr_internal_auth
// secret; people send their own staff session.
async function isStaffOrInternal(req: Request, db: ReturnType<typeof createClient>): Promise<boolean> {
  const internal = req.headers.get('x-wr-internal') || '';
  if (internal) {
    const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle();
    if (data?.secret && internal === data.secret) return true;
  }
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const { data: { user } } = await db.auth.getUser(m[1]);
  if (!user) return false;
  const { data: prof } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
  return !!prof && LINK_ROLES.has(prof.role);
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin') || '';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json(405, { ok: false, message: 'Method not allowed' });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json(400, { ok: false, message: 'Bad request' }); }
  const action  = String(body.action || '');
  const orderId = String(body.o || '').toLowerCase();
  const token   = String(body.t || '');

  const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY, { auth: { persistSession: false } });

  if (action === 'make_link') {
    if (!UUID_RE.test(orderId)) return json(400, { ok: false, message: 'Bad order id' });
    if (!(await isStaffOrInternal(req, db))) return json(403, { ok: false, message: 'Staff only' });
    return json(200, { ok: true, link: await rateLink(orderId) });
  }

  if (!UUID_RE.test(orderId) || !(await verifyRateToken(orderId, token))) {
    return json(403, { ok: false, code: 'bad_link', message: 'This link isn’t valid anymore.' });
  }

  if (action === 'load') {
    const { data: order, error } = await db.from('orders')
      .select('id, order_number, status, customers(first_name_cache)')
      .eq('id', orderId).maybeSingle();
    if (error) { console.error('load order', error); return json(500, { ok: false, message: 'Something went wrong. Please try again.' }); }
    if (!order) return json(404, { ok: false, code: 'not_found', message: 'We couldn’t find that order.' });
    const { data: fb, error: fbErr } = await db.from('order_feedback')
      .select('rating, comment, created_at').eq('order_id', orderId).maybeSingle();
    if (fbErr) { console.error('load feedback', fbErr); return json(500, { ok: false, message: 'Something went wrong. Please try again.' }); }
    const cust = (order as any).customers || {};
    return json(200, {
      ok: true,
      first_name:   cust.first_name_cache || '',
      order_number: order.order_number,
      delivered:    order.status === 'delivered',
      status:       order.status,
      rating:       fb?.rating ?? null,
      comment:      fb?.comment ?? null,
      can_edit:     !fb || (Date.now() - new Date(fb.created_at).getTime()) < 14 * 86_400_000,
    });
  }

  if (action === 'submit') {
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(400, { ok: false, message: 'Please pick 1 to 5 stars.' });
    const comment = typeof body.comment === 'string' ? body.comment.slice(0, 2000) : null;
    const { data, error } = await db.rpc('submit_order_feedback', {
      p_order_id: orderId, p_rating: rating, p_comment: comment, p_source: 'link',
    });
    if (error) { console.error('submit_order_feedback', error); return json(500, { ok: false, message: 'Could not send your rating. Please try again.' }); }
    console.log(`rate-order submit order=${orderId} rating=${rating} ok=${data?.ok}`);
    return json(200, data);
  }

  if (action === 'clicked') {
    const { error } = await db.from('order_feedback')
      .update({ review_link_clicked_at: new Date().toISOString() })
      .eq('order_id', orderId).is('review_link_clicked_at', null);
    if (error) console.error('mark clicked', error);
    return json(200, { ok: !error });
  }

  return json(400, { ok: false, message: 'Unknown action' });
});
