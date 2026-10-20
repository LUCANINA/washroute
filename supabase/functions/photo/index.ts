// photo — permanent, private link to a pickup/delivery proof photo (session 352).
//
// Texts used to carry the raw public storage URL of the photo. The stop-photos bucket is
// going private, so texts now carry  /functions/v1/photo?s=<route_stop_id>&t=<token>
// where token = first 20 hex chars of HMAC-SHA256(wr_internal_auth.secret, "photo:" + stop id).
// The link never expires and can't be guessed or altered to reach another stop. Each visit
// redirects to a 5-minute signed URL for the image. verify_jwt must stay FALSE (customers
// open it from a text, not logged in). Rotating wr_internal_auth.secret invalidates every link.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{20}$/i;
const BUCKET = 'stop-photos';

let secretCache: string | null = null;
async function secret(): Promise<string> {
  if (secretCache) return secretCache;
  const { data, error } = await db.from('wr_internal_auth').select('secret').maybeSingle();
  if (error || !data?.secret) throw new Error('secret unavailable');
  secretCache = data.secret;
  return secretCache!;
}

async function expectedToken(stopId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('photo:' + stopId.toLowerCase())));
  return Array.from(sig).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function page(status: number, title: string, msg: string) {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 20px;text-align:center;color:#1a1a2e">` +
    `<h2 style="margin:0 0 10px">${title}</h2><p style="color:#555;line-height:1.5">${msg}</p>` +
    `<p><a href="https://app.familylaundry.com" style="color:#2563eb">Open Family Laundry</a></p></div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const s = (url.searchParams.get('s') || '').trim();
  const t = (url.searchParams.get('t') || '').trim().toLowerCase();
  const notFound = () => page(404, 'Photo not available', 'This photo link is not valid. If you need it, reply to our text and we will send it.');
  if (!UUID_RE.test(s) || !TOKEN_RE.test(t)) return notFound();

  try {
    if (!sameText(t, await expectedToken(s))) return notFound();

    const { data: stop } = await db.from('route_stops').select('proof_photo_url').eq('id', s).maybeSingle();
    const stored = String(stop?.proof_photo_url || '');
    const m = stored.match(/\/storage\/v1\/object\/(?:public|sign)\/stop-photos\/([^?#]+)/);
    if (!m) return page(404, 'Photo not available', 'There is no photo for this stop.');

    const { data: signed, error } = await db.storage.from(BUCKET).createSignedUrl(decodeURIComponent(m[1]), 300);
    if (error || !signed?.signedUrl) throw error || new Error('sign failed');
    return new Response(null, { status: 302, headers: { Location: signed.signedUrl, 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('photo: error', (e as Error)?.message || e);
    return page(500, 'Photo temporarily unavailable', 'Please try again in a minute.');
  }
});
