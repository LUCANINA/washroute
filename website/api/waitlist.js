// POST /api/waitlist { zip, email } — homepage ZIP check, "not yet" sign-up (Oct 12, 2026).
// Saves to WashRoute table service_area_waitlist (insert-only for the public key; admins read it).
// Served ZIPs are refused here too, so the list only holds areas we don't cover yet.
const { SUPABASE_URL, ANON } = require('./_lib/data.js');
const ZIPS = require('../content/zips.js');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Use POST.' });
  let body = req.body;
  if (!body || typeof body !== 'object') {
    try { body = JSON.parse(await new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 2000) no(new Error('too big')); }); req.on('end', () => ok(s)); req.on('error', no); })); }
    catch (e) { return send(res, 400, { ok: false, error: 'Something went wrong. Please try again.' }); }
  }
  if (body.website) return send(res, 200, { ok: true }); // honeypot field: bots fill it, people don't see it
  const zip = String(body.zip || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^\d{5}$/.test(zip)) return send(res, 400, { ok: false, error: 'Enter a 5-digit ZIP code.' });
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { ok: false, error: 'Enter a valid email address.' });
  const z = ZIPS[zip];
  if (z && !(typeof z === 'object' && z.partial)) return send(res, 200, { ok: true, served: true });
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/service_area_waitlist`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ zip, email }),
      signal: AbortSignal.timeout(8000),
    });
    // 409 = already on the list for this ZIP: still a success for the visitor.
    if (r.ok || r.status === 409) return send(res, 200, { ok: true });
    console.error('waitlist insert failed', r.status, (await r.text()).slice(0, 300));
  } catch (e) { console.error('waitlist insert error', e); }
  return send(res, 502, { ok: false, error: 'Sorry, that did not go through. Please try again in a minute.' });
};
