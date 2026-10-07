// familylaundry.com — one server-rendered page per request, cached at Vercel's edge.
const { load } = require('./_lib/data.js');
const { layout, ORIGIN } = require('./_lib/layout.js');
const { ROUTES, notFound, CITIES } = require('./_lib/pages.js');

// One service-area list everywhere: the zone cities from WashRoute plus every city page (Emeryville, Piedmont
// and Richmond sit inside other zones, so the zone list alone left them out of the FAQ answer).
const withCities = v => ({ ...v, cities: [...new Set([...(v.cities || []), ...CITIES.map(c => c.name)])].sort() });

// Old Wix URLs that moved (keep links and Google rankings working).
const REDIRECTS = {
  '/home': '/',
  '/pricing': '/#pricing',
  '/services-4': '/commercial-laundry',
};

function isProductionHost(host) {
  return /^(www\.)?(familylaundry|sudzee)\.com$/i.test(String(host || '').split(':')[0]);
}
// sudzee.com (our laundromat) is one page from the same project. On preview hosts, add ?site=sudzee to see it.
const sudzee = require('./_lib/sudzee.js');
const isSudzeeHost = host => /^(www\.)?sudzee\.com$/i.test(String(host || '').split(':')[0]);

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = url.searchParams.get('p') || url.pathname || '/';
  path = ('/' + path.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  try { path = decodeURIComponent(path); } catch (_) {}
  path = path.toLowerCase();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const indexable = isProductionHost(host);
  const onSudzee = isSudzeeHost(host) || (!indexable && url.searchParams.get('site') === 'sudzee');

  if (onSudzee) {
    if (path === '/robots.txt') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(indexable ? `User-agent: *\nAllow: /\nSitemap: ${sudzee.ORIGIN}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
    }
    if (path === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${sudzee.ORIGIN}/</loc></url></urlset>`);
    }
    if (path !== '/') { res.statusCode = 301; res.setHeader('Location', '/'); return res.end(); }
    let d;
    try { d = await load(); } catch (e) {
      console.error('content load failed', e); res.statusCode = 503;
      return res.end('Sudzee Wash & Fold, 2609 Foothill Blvd, Oakland. Please try again in a minute.');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    if (!indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.end(sudzee.page(d.values, { indexable }));
  }

  if (REDIRECTS[path]) {
    res.statusCode = 301; res.setHeader('Location', REDIRECTS[path]); return res.end();
  }

  let data;
  try {
    data = await load();
    data = { ...data, values: withCities(data.values) };
  } catch (e) {
    console.error('content load failed', e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end('<!doctype html><title>Family Laundry</title><p style="font-family:sans-serif;padding:40px">We\'re updating the site. Please try again in a minute, or <a href="https://app.familylaundry.com">schedule a pickup in the app</a>.</p>');
  }

  if (path === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.end(indexable ? `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
  }
  if (path === '/sitemap.xml') {
    // Only pages open to Google: a page that sets noindex (thank-you, thin city pages) stays out.
    const listed = p => { try { return !ROUTES[p](data.values, data.faq).noindex; } catch (e) { return false; } };
    const urls = Object.keys(ROUTES).filter(listed)
      .map(p => `<url><loc>${ORIGIN}${p === '/' ? '' : encodeURI(p)}</loc></url>`).join('');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
  }

  const build = ROUTES[path];
  let page;
  try {
    page = build ? build(data.values, data.faq) : notFound();
  } catch (e) {
    console.error('render failed', path, e);
    page = notFound(); page.status = 500;
  }
  res.statusCode = page.status || 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', page.status ? 'public, s-maxage=60' : 'public, s-maxage=300, stale-while-revalidate=86400');
  if (!indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(layout(page, data.values, { indexable }));
};
