// send-feedback (session 298) — emails customer feedback to info@familylaundry.com.
//
// Called ONLY by the database (trigger notify_feedback_email via pg_net) with the
// x-wr-internal secret. Two kinds:
//   { kind: 'message', id }                 → a customer_messages row (in-app feedback)
//   { kind: 'rating', order_id, updated }   → an order_feedback row (1–3★ or with a comment)
// The recipient is fixed (info@). Reply-To is the customer so staff can just hit Reply.
// This function never emails a customer.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SENDGRID_API_KEY = Deno.env.get('SENDGRID_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TO_EMAIL   = 'info@familylaundry.com';
const FROM_EMAIL = 'info@familylaundry.com';
const ADMIN_URL  = 'https://admin.familylaundry.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOPIC_LABEL: Record<string, string> = {
  idea: 'Idea', problem: 'Problem', delivery: 'Driver/Delivery', billing: 'Billing', compliment: 'Compliment',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtPhone(v: string | null) {
  const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10})/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (v || '—');
}
function fmtDate(v: string | null) {
  if (!v) return '';
  return new Date(v).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });
}
function b64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function isInternal(req: Request, db: ReturnType<typeof createClient>) {
  const got = req.headers.get('x-wr-internal') || '';
  if (!got) return false;
  const { data } = await db.from('wr_internal_auth').select('secret').maybeSingle();
  return !!data?.secret && got === data.secret;
}

function layout(title: string, badge: string, badgeColor: string, message: string, rows: [string, string][]) {
  const tr = rows.map(([k, v]) =>
    `<tr><td style="padding:6px 10px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${v}</td></tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:620px;color:#1a1a2e">
  <div style="font-size:12px;font-weight:700;color:#fff;background:${badgeColor};display:inline-block;padding:3px 8px;border-radius:5px">${esc(badge)}</div>
  <h2 style="font-size:18px;margin:10px 0 12px">${esc(title)}</h2>
  <div style="font-size:15px;line-height:1.55;border-left:3px solid #e2e8f0;padding-left:12px;margin-bottom:16px;white-space:pre-wrap">${message}</div>
  <table style="font-size:13px;border-collapse:collapse">${tr}</table>
  <p style="font-size:12px;color:#94a3b8;margin-top:18px">Sent from the Family Laundry app. Reply to this email to answer the customer directly.</p>
</div>`;
}

async function sendMail(subject: string, html: string, replyTo: { email: string; name?: string } | null,
                        attachments: { content: string; filename: string; type: string }[]) {
  const body: Record<string, unknown> = {
    personalizations: [{ to: [{ email: TO_EMAIL }] }],
    from: { email: FROM_EMAIL, name: 'Family Laundry App' },
    subject,
    content: [{ type: 'text/html', value: html }],
  };
  if (replyTo?.email) body.reply_to = replyTo;
  if (attachments.length) body.attachments = attachments.map(a => ({ ...a, disposition: 'attachment' }));
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`SendGrid ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

function custName(c: any) {
  return `${c?.first_name_cache || ''} ${c?.last_name_cache || ''}`.trim() || 'A customer';
}
function custRows(c: any): [string, string][] {
  return [[
    'Customer',
    `${esc(custName(c))} · ${esc(fmtPhone(c?.phone_cache))} · ${c?.email_cache ? `<a href="mailto:${esc(c.email_cache)}">${esc(c.email_cache)}</a>` : 'no email on file'}`,
  ]];
}

async function handleMessage(db: any, id: number) {
  const { data: m, error } = await db.from('customer_messages')
    .select('id, customer_id, order_id, topic, message, photo_paths, contact_ok, issue_id, email_sent_at, created_at')
    .eq('id', id).maybeSingle();
  if (error || !m) return json(404, { ok: false, error: 'message not found' });
  if (m.email_sent_at) return json(200, { ok: true, skipped: 'already sent' });

  const [{ data: c }, { data: o }] = await Promise.all([
    db.from('customers').select('first_name_cache, last_name_cache, phone_cache, email_cache').eq('id', m.customer_id).maybeSingle(),
    m.order_id
      ? db.from('orders').select('order_number, status, actual_delivery_at').eq('id', m.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  let rating: number | null = null;
  if (m.order_id) {
    const { data: fb } = await db.from('order_feedback').select('rating').eq('order_id', m.order_id).maybeSingle();
    rating = fb?.rating ?? null;
  }

  // Photos → attachments (private bucket; service role downloads).
  const attachments: { content: string; filename: string; type: string }[] = [];
  for (const [i, path] of (m.photo_paths || []).entries()) {
    try {
      const { data: blob, error: dErr } = await db.storage.from('feedback-photos').download(path);
      if (dErr || !blob) continue;
      const ext = (path.split('.').pop() || 'jpg').toLowerCase();
      attachments.push({ content: b64(await blob.arrayBuffer()), filename: `photo-${i + 1}.${ext}`, type: blob.type || 'image/jpeg' });
    } catch (e) { console.warn('photo download failed', path, String(e)); }
  }

  const label = TOPIC_LABEL[m.topic] || m.topic;
  const name = custName(c);
  const orderTxt = o ? `Order #${o.order_number}` : 'General — no order';
  const subject = `[Feedback · ${label}] ${name} — ${orderTxt}`;
  const rows: [string, string][] = [
    ...custRows(c),
    ['Order', o ? esc(`#${o.order_number} · ${o.status}${o.actual_delivery_at ? ` · delivered ${fmtDate(o.actual_delivery_at)}` : ''}${rating ? ` · rated ${rating}★` : ''}`) : 'General — no order'],
    ['OK to contact?', m.contact_ok ? 'Yes' : '<b>No — customer asked not to be contacted</b>'],
    ['Photos', attachments.length ? `${attachments.length} attached` : 'None'],
  ];
  if (m.issue_id) rows.push(['Staff issue', `Opened in <a href="${ADMIN_URL}">Admin dashboard</a> (#${m.issue_id})`]);
  const color = m.topic === 'compliment' ? '#16a34a' : (m.topic === 'problem' || m.topic === 'billing') ? '#dc2626' : '#2a6fc9';
  const html = layout(`${label} from ${name}`, label.toUpperCase(), color, esc(m.message), rows);

  try {
    await sendMail(subject, html, c?.email_cache ? { email: c.email_cache, name } : null, attachments);
    await db.from('customer_messages').update({ email_sent_at: new Date().toISOString(), email_error: null }).eq('id', m.id);
    return json(200, { ok: true });
  } catch (e) {
    const msg = String((e as Error).message || e);
    await db.from('customer_messages').update({ email_error: msg.slice(0, 500) }).eq('id', m.id);
    return json(502, { ok: false, error: msg });
  }
}

async function handleRating(db: any, orderId: string, updated: boolean) {
  const { data: fb } = await db.from('order_feedback')
    .select('rating, comment, source, issue_id, customer_id, updated_at').eq('order_id', orderId).maybeSingle();
  if (!fb) return json(404, { ok: false, error: 'rating not found' });
  // Only fresh writes (the trigger fires right away); ignores replays.
  if (Date.now() - new Date(fb.updated_at).getTime() > 10 * 60 * 1000) return json(200, { ok: true, skipped: 'stale' });

  const [{ data: c }, { data: o }] = await Promise.all([
    db.from('customers').select('first_name_cache, last_name_cache, phone_cache, email_cache').eq('id', fb.customer_id).maybeSingle(),
    db.from('orders').select('order_number, actual_delivery_at').eq('id', orderId).maybeSingle(),
  ]);
  const name = custName(c);
  const stars = '★'.repeat(fb.rating) + '☆'.repeat(5 - fb.rating);
  const subject = `[Rating · ${fb.rating}★${updated ? ' · updated' : ''}] ${name} — Order #${o?.order_number ?? '?'}`;
  const rows: [string, string][] = [
    ...custRows(c),
    ['Order', esc(`#${o?.order_number ?? '?'}${o?.actual_delivery_at ? ` · delivered ${fmtDate(o.actual_delivery_at)}` : ''}`)],
    ['Rating', `<span style="color:#f5a623;font-size:16px">${stars}</span> (${fb.rating}/5)`],
  ];
  if (fb.issue_id) rows.push(['Staff issue', `Opened in <a href="${ADMIN_URL}">Admin dashboard</a> (#${fb.issue_id})`]);
  const color = fb.rating <= 3 ? '#dc2626' : '#16a34a';
  const html = layout(`${fb.rating}★ rating from ${name}`, `${fb.rating}★ RATING`, color,
    fb.comment ? esc(fb.comment) : '<i style="color:#94a3b8">(no comment left)</i>', rows);
  try {
    await sendMail(subject, html, c?.email_cache ? { email: c.email_cache, name } : null, []);
    return json(200, { ok: true });
  } catch (e) {
    return json(502, { ok: false, error: String((e as Error).message || e) });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
  const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  if (!(await isInternal(req, db))) return json(403, { ok: false, error: 'internal callers only' });
  let p: any;
  try { p = await req.json(); } catch { return json(400, { ok: false, error: 'bad json' }); }
  try {
    if (p?.kind === 'message' && Number.isInteger(p.id)) return await handleMessage(db, p.id);
    if (p?.kind === 'rating' && typeof p.order_id === 'string' && UUID_RE.test(p.order_id)) {
      return await handleRating(db, p.order_id, !!p.updated);
    }
    return json(400, { ok: false, error: 'unknown payload' });
  } catch (e) {
    console.error('send-feedback error', e);
    return json(500, { ok: false, error: String((e as Error).message || e) });
  }
});
