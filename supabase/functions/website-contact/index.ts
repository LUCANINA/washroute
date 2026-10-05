// website-contact — the familylaundry.com contact + commercial-quote forms.
//
// Public (deploy with --no-verify-jwt). Two things happen for every real submission:
//   1. An email goes to info@familylaundry.com (From info@, Reply-To = the visitor), so staff
//      can just hit Reply. The recipient is FIXED — this function can never email anyone else.
//   2. If the visitor is an existing customer (exact email match, else phone match), the message
//      is saved to that customer's history (email_messages, inbound). email_messages has no
//      triggers, so this write cannot fan out. gmail-sync will NOT copy the info@ email again
//      (its sender is info@, which gmail-sync skips), so there is no duplicate.
// Spam guards: Origin allowlist, honeypot field, minimum fill time, size limits, per-IP throttle.
// Accepts JSON (fetch from the site) or a plain form post (no-JS fallback → 303 to /thankyou).
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INFO = 'info@familylaundry.com';
const ADMIN_URL = 'https://admin.familylaundry.com';
const SITE = 'https://www.familylaundry.com';

const ORIGIN_OK = (o: string) =>
  /^https:\/\/(www\.)?familylaundry\.com$/i.test(o) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(o) || /^http:\/\/localhost(:\d+)?$/.test(o);

const recent = new Map<string, number[]>(); // ip → timestamps (per warm instance; a speed bump, not a wall)
function throttled(ip: string) {
  const now = Date.now(), win = 10 * 60_000;
  const list = (recent.get(ip) || []).filter(t => now - t < win);
  list.push(now); recent.set(ip, list);
  return list.length > 5;
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const digits = (s: string) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin': ORIGIN_OK(origin) ? origin : SITE,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

async function findCustomer(db: any, email: string, phone: string) {
  const cols = 'id, first_name_cache, last_name_cache, email_cache, phone_cache, last_order_at, created_at, cancelled_at';
  const rank = (x: any) => [x.cancelled_at ? 0 : 1, x.last_order_at || '', x.created_at || ''].join('|');
  const best = (rows: any[]) => rows.sort((a, b) => rank(b).localeCompare(rank(a)))[0] || null;
  if (email) {
    const { data } = await db.from('customers').select(cols).ilike('email_cache', email.replace(/[%_\\]/g, '\\$&')).limit(10);
    const exact = (data || []).filter((c: any) => String(c.email_cache || '').toLowerCase() === email);
    if (exact.length) return { c: best(exact), how: 'email' };
  }
  const d = digits(phone);
  if (d.length === 10) {
    const { data } = await db.from('customers').select(cols).ilike('phone_cache', `%${d.slice(-4)}`).limit(50);
    const hit = (data || []).filter((c: any) => digits(c.phone_cache) === d);
    if (hit.length) return { c: best(hit), how: 'phone' };
  }
  return { c: null, how: '' };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const H = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: H });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: H });

  const isForm = (req.headers.get('content-type') || '').includes('application/x-www-form-urlencoded');
  const reply = (status: number, body: Record<string, unknown>) => isForm
    ? new Response(null, { status: 303, headers: { ...H, Location: status < 300 ? `${SITE}/thankyou` : `${SITE}/#contact` } })
    : new Response(JSON.stringify(body), { status, headers: { ...H, 'Content-Type': 'application/json' } });

  if (origin && !ORIGIN_OK(origin)) return reply(403, { ok: false, error: 'origin' });

  let f: Record<string, string> = {};
  try {
    if (isForm) f = Object.fromEntries(new URLSearchParams(await req.text()));
    else f = await req.json();
  } catch { return reply(400, { ok: false, error: 'Could not read the form.' }); }

  const kind = f.kind === 'commercial' ? 'commercial' : 'contact';
  const name = String(f.name || '').trim().slice(0, 120);
  const email = String(f.email || '').trim().toLowerCase().slice(0, 200);
  const phone = String(f.phone || '').trim().slice(0, 40);
  const business = String(f.business || '').trim().slice(0, 160);
  const message = String(f.message || '').trim().slice(0, 5000);

  // Bots: honeypot filled, or form submitted faster than a person could.
  const started = Number(f.t || 0);
  if (String(f.website || '').trim() || (started && Date.now() - started < 3000)) return reply(200, { ok: true });

  if (!name || !message) return reply(400, { ok: false, error: 'Please add your name and a message.' });
  if (!EMAIL_RE.test(email)) return reply(400, { ok: false, error: 'Please check your email address.' });

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (throttled(ip)) return reply(429, { ok: false, error: 'Too many messages. Please call or text us instead.' });

  const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY, { auth: { persistSession: false } });
  let match: { c: any; how: string } = { c: null, how: '' };
  try { match = await findCustomer(db, email, phone); } catch (e) { console.error('customer lookup failed', e); }

  const label = kind === 'commercial' ? 'Commercial quote request' : 'Website message';
  const subject = `${label} from ${name}${business ? ` (${business})` : ''}`.slice(0, 300);
  const msgHtml = `<div style="white-space:pre-wrap">${esc(message)}</div>`;

  // 1) Customer history first (it is the record that matters). Check the error: supabase-js never
  //    throws, and the info@ email below must say truthfully whether the message was saved.
  let saved = false;
  if (match.c) {
    const { error } = await db.from('email_messages').insert({
      customer_id: match.c.id, direction: 'inbound', subject, body: msgHtml,
      from_email: email, to_email: INFO,
    });
    if (error) console.error('history insert failed', error); else saved = true;
  }
  const who = match.c ? esc(`${match.c.first_name_cache || ''} ${match.c.last_name_cache || ''}`.trim() || 'customer') : '';
  const rows: [string, string][] = [
    ['Name', esc(name)],
    ['Email', `<a href="mailto:${esc(email)}">${esc(email)}</a>`],
    ...(phone ? [['Phone', esc(phone)] as [string, string]] : []),
    ...(business ? [['Business', esc(business)] as [string, string]] : []),
    ['Customer', !match.c ? 'No matching customer (new lead).'
      : saved ? `Yes — ${who} (matched by ${match.how}). Saved to their history in <a href="${ADMIN_URL}">WashRoute</a>.`
      : `Yes — ${who} (matched by ${match.how}). <strong>Could not save to their WashRoute history</strong>; this email is the only copy.`],
  ];
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;color:#1a1a2e">
  <div style="font-size:12px;font-weight:700;color:#fff;background:${kind === 'commercial' ? '#0f766e' : '#2563eb'};display:inline-block;padding:3px 8px;border-radius:5px">${esc(label)}</div>
  <h2 style="font-size:18px;margin:10px 0 12px">${esc(subject)}</h2>
  <div style="font-size:15px;line-height:1.55;border-left:3px solid #e2e8f0;padding-left:12px;margin-bottom:16px">${msgHtml}</div>
  <table style="font-size:13px;border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:6px 10px 6px 0;color:#6b7280;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${v}</td></tr>`).join('')}</table>
  <p style="font-size:12px;color:#94a3b8;margin-top:18px">Sent from the familylaundry.com ${kind === 'commercial' ? 'commercial quote' : 'contact'} form. Reply to answer them directly.</p>
</div>`;

  // 2) Email info@.
  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: INFO }] }],
        from: { email: INFO, name: 'Family Laundry website' },
        reply_to: { email, name },
        subject, content: [{ type: 'text/html', value: html }],
        tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
      }),
    });
    if (!r.ok) throw new Error(`SendGrid ${r.status}: ${(await r.text()).slice(0, 300)}`);
  } catch (e) {
    console.error('email failed', e);
    // If it is in the customer's history, staff still see it; otherwise tell the visitor.
    if (!saved) return reply(502, { ok: false, error: 'Sorry, that did not go through. Please call or text us.' });
  }
  return reply(200, { ok: true });
});
