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
    <a class="logo" href="/" aria-label="Family Laundry home"><img src="/assets/img/logo.png" alt="Family Laundry" width="56" height="56"></a>
    ${phone ? `<a class="head-phone" href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''}
    <input type="checkbox" id="nav-toggle" class="nav-toggle" aria-label="Menu">
    <label for="nav-toggle" class="nav-burger" aria-hidden="true"><span></span></label>
    <nav class="nav">${links}<a class="btn btn-sm" href="${APP}">Schedule pickup</a></nav>
  </div>
</header>`;
}

function footer(v) {
  const s = (v && v.site) || {};
  return `<footer class="site-foot">
  <div class="wrap foot-grid">
    <div>
      <img src="/assets/img/logo.png" alt="" width="64" height="64" loading="lazy">
      <p>Wash &amp; fold pickup and delivery.<br>Family-owned since 2018, delivering since ${esc(s.founded || '2019')}.</p>
      <p>Family Laundry<br>${esc(ADDRESS)}</p>
      <p>${s.phone ? `<a href="${esc(telHref(s.phone))}">${esc(s.phone)}</a><br>` : ''}${s.email ? `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}</p>
    </div>
    <div>
      <h4>Company</h4>
      <a href="/blog">Our story</a><a href="/service-map">Service area</a><a href="/faq">FAQ</a>
      <a href="/community">Community</a><a href="/gifts-cards">Gift cards</a>
    </div>
    <div>
      <h4>Services</h4>
      <a href="/laundry-delivery-services">Wash &amp; fold</a><a href="/commercial-laundry">Commercial laundry</a>
      <a href="/laundry-delivery-oakland">Oakland</a><a href="/laundry-delivery-berkeley">Berkeley</a>
      <a href="/laundry-delivery-alameda">Alameda</a><a href="/laundry-delivery-sf">San Francisco</a>
    </div>
    <div>
      <h4>Get started</h4>
      <a href="${APP}">Schedule a pickup</a><a href="/download">Get the app</a>
      <a href="/privacy-policy">Privacy policy</a><a href="/terms-conditions">Terms &amp; conditions</a>
    </div>
  </div>
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
<link rel="icon" href="/assets/img/logo.png">
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
