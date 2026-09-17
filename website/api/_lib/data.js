// Content loader: public WashRoute data via the anon (publishable) key.
// Cached in memory per warm function for 60 s; Vercel's CDN caches pages for 5 min.
const SUPABASE_URL = 'https://umjpbuxrdydwejqtensq.supabase.co';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtanBidXhyZHlkd2VqcXRlbnNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NjgzMDQsImV4cCI6MjA4NzU0NDMwNH0.22WyUfBsqPaaza_HiDo1f_tQE3sGUDEJYYyV29XUSeY';
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };

let cache = null, cachedAt = 0;

async function j(path, init) {
  const r = await fetch(SUPABASE_URL + path, { ...init, headers: H, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function load() {
  if (cache && Date.now() - cachedAt < 60_000) return cache;
  const [values, topics, items] = await Promise.all([
    j('/rest/v1/rpc/site_public_values', { method: 'POST', body: '{}' }),
    j('/rest/v1/faq_topics?select=id,slug,name,sort_order&order=sort_order.asc,id.asc'),
    j('/rest/v1/faq_items?select=id,topic_id,question,answer,audience,sort_order&show_on_web=is.true&order=sort_order.asc,id.asc'),
  ]);
  cache = { values, faq: topics.map(t => ({ ...t, items: items.filter(i => i.topic_id === t.id) })).filter(t => t.items.length) };
  cachedAt = Date.now();
  return cache;
}

module.exports = { load };
