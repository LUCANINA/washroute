const { esc } = require('../../assets/fl-content.js');

const ORIGIN = 'https://www.familylaundry.com';
const APP = 'https://app.familylaundry.com';
// Written exactly as on the Google Business Profile (name/address/phone must match everywhere).
const ADDRESS = '2609 Foothill Blvd, Oakland, CA 94601';
const telHref = phone => 'tel:' + String(phone || '').replace(/[^\d+]/g, '');

const NAV = [
  ['/', 'Home'],
  ['/laundry-delivery-services', 'Services'],
  ['/#pricing', 'Pricing'],
  ['/faq', 'FAQ'],
  ['/commercial-laundry', 'Commercial'],
];

function header(path, v) {
  const phone = (v && v.site && v.site.phone) || '';
  const links = NAV.map(([href, label]) =>
    `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<header class="site-head">
  <div class="wrap head-row">
    <a class="logo" href="/" aria-label="Family Laundry home"><img src="/assets/img/logo-circle.svg" alt="Family Laundry" width="64" height="64"></a>
    ${phone ? `<a class="head-phone" href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''}
    <a class="btn btn-sm head-book" href="${APP}">Book</a>
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Menu">
    <label for="nav-toggle" class="nav-burger" aria-hidden="true"><span></span></label>
    <nav class="nav">${links}<a class="btn btn-sm" href="${APP}">Schedule pickup</a></nav>
  </div>
</header>`;
}

// Footer link hub (the 2ULaundry pattern): every topic page and every open city page is one click from
// any page, so Google finds them and visitors can jump straight to their situation.
const TOPICS = require('../../content/topics.js');
const CITIES = require('../../content/cities.js');
const footLinks = (group, extra = []) => [
  ...TOPICS.filter(t => t.group === group).map(t => [t.path, t.nav]), ...extra,
].map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('');

// Our own after-delivery rating (site_public_values().ratings), shown once there are 20+. It is visible in the footer
// of every page because the pages' rating markup uses it.
function ownRating(v) {
  const r = (v && v.ratings) || {};
  const avg = Number(r.avg), count = Number(r.count);
  return count >= 20 && avg > 0 ? `<p class="foot-rating"><strong>${esc(avg.toFixed(1))} ★</strong> average customer rating</p>` : '';
}

function footer(v) {
  const s = (v && v.site) || {};
  const cities = CITIES.filter(c => c.index).map(c => [`/laundry-delivery-${c.slug}`, c.name]);
  return `<footer class="site-foot">
  <div class="wrap foot-grid">
    <div class="foot-brand">
      <img src="/assets/img/logo-circle.svg" alt="" width="84" height="84" loading="lazy">
      <p>Wash &amp; fold pickup and delivery.<br>Family-owned since 2018, delivering since ${esc(s.founded || '2019')}.</p>
      <p>Family Laundry<br>${esc(ADDRESS)}</p>
      ${ownRating(v)}
      <p>${s.phone ? `<a href="${esc(telHref(s.phone))}">${esc(s.phone)}</a><br>` : ''}${s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}</p>
    </div>
    <details class="foot-col" open>
      <summary><h4>Get started</h4></summary>
      <a href="${APP}">Schedule a pickup</a>
      ${footLinks('Getting started', [['/laundry-service-cost', 'What it costs'], ['/faq', 'FAQ'], ['/download', 'Get the app'], ['/gifts-cards', 'Gift cards']])}
    </details>
    <details class="foot-col" open>
      <summary><h4>Residential</h4></summary>
      ${footLinks('Residential', [['/laundry-delivery-services', 'All services & prices']])}
    </details>
    <details class="foot-col" open>
      <summary><h4>Commercial</h4></summary>
      ${footLinks('Commercial', [['/commercial-laundry', 'All commercial laundry']])}
    </details>
    <details class="foot-col" open>
      <summary><h4>Areas</h4></summary>
      ${cities.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
      <a href="/service-map">Full service area</a>
    </details>
    <details class="foot-col" open>
      <summary><h4>Company</h4></summary>
      <a href="/about-us">About us</a><a href="/blog">Our story</a><a href="/community">Community</a>
      <a href="/privacy-policy">Privacy policy</a><a href="/terms-conditions">Terms &amp; conditions</a>
    </details>
  </div>
  <script>if(matchMedia('(max-width:600px)').matches)document.querySelectorAll('.foot-col').forEach(d=>d.open=false)</script>
  <div class="wrap foot-legal">©${new Date().getFullYear()} Young &amp; Foolish LLC dba Family Laundry</div>
</footer>`;
}

// page: { path, title, description, body, jsonld?, noindex? }
function layout(page, values, { indexable }) {
  const canonical = ORIGIN + (page.path === '/' ? '' : page.path);
  // Preview hosts: hidden entirely. A noindex page on the real site (thin city page, thank-you): kept out of
// Google, but its links are still followed so the pages it links to keep their credit.
  const robots = !indexable ? '<meta name="robots" content="noindex, nofollow">'
    : page.noindex ? '<meta name="robots" content="noindex, follow">' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description || '')}">
<link rel="canonical" href="${canonical}">
${robots}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description || '')}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${ORIGIN}/assets/img/hero.jpg">
<link rel="icon" href="/assets/img/logo-circle.svg" type="image/svg+xml">
<link rel="icon" href="/assets/img/logo-circle-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/logo-circle-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=Nunito+Sans:wght@300;400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
${page.jsonld ? `<script type="application/ld+json">${JSON.stringify(page.jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(page.path, values)}
<main id="main">
${page.body}
</main>
${footer(values)}
<script src="/assets/forms.js" defer></script>
</body>
</html>`;
}

module.exports = { layout, ORIGIN, APP, ADDRESS };
