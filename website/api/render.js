// familylaundry.com — one server-rendered page per request, cached at Vercel's edge.
const { load } = require('./_lib/data.js');
const { layout, ORIGIN } = require('./_lib/layout.js');
const { ROUTES, notFound } = require('./_lib/pages.js');

// Old Wix URLs that moved (keep links and Google rankings working).
const REDIRECTS = {
  '/home': '/',
  '/pricing': '/#pricing',
  '/about-us': '/#story',
  '/blog': '/',            // TODO(phase 4): blog
};

function isProductionHost(host) {
  return /^(www\.)?familylaundry\.com$/i.test(String(host || '').split(':')[0]);
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = url.searchParams.get('p') || url.pathname || '/';
  path = ('/' + path.replace(/^\/+/, '')).replace(/\/+$/, '') || '/';
  path = path.toLowerCase();
  const indexable = isProductionHost(req.headers['x-forwarded-host'] || req.headers.host);

  if (REDIRECTS[path]) {
    res.statusCode = 301; res.setHeader('Location', REDIRECTS[path]); return res.end();
  }
  if (path.startsWith('/post/')) {           // TODO(phase 4): blog posts
    res.statusCode = 302; res.setHeader('Location', '/'); return res.end();
  }

  let data;
  try {
    data = await load();
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
    const urls = Object.keys(ROUTES).filter(p => p !== '/thankyou')
      .map(p => `<url><loc>${ORIGIN}${p === '/' ? '' : p}</loc></url>`).join('');
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
