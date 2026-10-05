// Signed "rate your order" links (session 333).
//
// The rating text/email links to https://app.familylaundry.com/rate?o=<order id>&t=<token>.
// The token is an HMAC of the order id, so the link alone proves the reader got
// it from us — no sign-in needed. That matters because many customers book by
// text/phone and never made an app login (they could not rate at all before).
//
// Key: derived from the project's service-role key, which every edge function
// already has. If that key is ever rotated, old links simply stop working
// (the page tells the customer to open the app) — nothing else breaks.
const enc = new TextEncoder();
let _key: CryptoKey | null = null;

async function signingKey(): Promise<CryptoKey> {
  if (_key) return _key;
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!secret) throw new Error('rate-token: no signing secret');
  _key = await crypto.subtle.importKey(
    'raw', enc.encode('wr-rate-link-v1:' + secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return _key;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function rateToken(orderId: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await signingKey(), enc.encode('rate:' + orderId.toLowerCase()));
  return b64url(new Uint8Array(sig).slice(0, 16));   // 128 bits — 22 characters
}

export async function verifyRateToken(orderId: string, token: string): Promise<boolean> {
  if (!orderId || !token || token.length !== 22) return false;
  const want = await rateToken(orderId);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

export async function rateLink(orderId: string): Promise<string> {
  return `https://app.familylaundry.com/rate?o=${orderId}&t=${await rateToken(orderId)}`;
}
