// sudzee.com — one page for Sudzee Wash & Fold, our laundromat at 2609 Foothill Blvd (replaced Wix, Oct 2026).
// Served by the same Vercel project as familylaundry.com; render.js picks this page by host name.
// Hours, prices and the drop-off cutoff are live WashRoute tokens (never typed), so this page and
// familylaundry.com always agree.
const C = require('../../assets/fl-content.js');
const { esc } = C;

const ORIGIN = 'https://www.sudzee.com';
const FL = 'https://www.familylaundry.com';
const APP = 'https://app.familylaundry.com';
const MAP = 'https://www.google.com/maps/search/?api=1&query=Sudzee+Wash+%26+Fold+2609+Foothill+Blvd+Oakland+CA+94601';

const plain = (t, v) => C.renderPlain(t, v);

function page(v, { indexable }) {
  const s = v.site || {};
  const tel = s.phone ? 'tel:' + s.phone.replace(/[^\d+]/g, '') : '';
  const t = x => esc(plain(x, v));
  const title = 'Sudzee Wash & Fold | Laundromat in Oakland';
  const description = `Self-service laundromat and drop-off wash & fold (${plain('{retail:Wash & Fold}', v)}) at 2609 Foothill Blvd, Oakland. Open ${plain('{site:dropoff_hours}', v)}. Part of Family Laundry.`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'DryCleaningOrLaundry', '@id': ORIGIN + '/#business',
    name: 'Sudzee Wash & Fold', url: ORIGIN, telephone: s.phone, image: ORIGIN + '/assets/img/sudzee-logo.png',
    address: { '@type': 'PostalAddress', streetAddress: '2609 Foothill Blvd', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94601', addressCountry: 'US' },
    parentOrganization: { '@type': 'Organization', '@id': FL + '/#business', name: 'Family Laundry', url: FL },
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${ORIGIN}">
${indexable ? '' : '<meta name="robots" content="noindex, nofollow">'}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${ORIGIN}">
<meta property="og:image" content="${ORIGIN}/assets/img/sudzee-logo.png">
<link rel="icon" href="/assets/img/sudzee-icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/sudzee-icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { --ink: #111; --muted: #5c5c5c; --pink: #ff5fb4; --pink-soft: #ffe3f1; --line: #f1d3e3; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: var(--ink); font: 400 17px/1.6 Poppins, system-ui, sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 20px; }
  header.wrap { text-align: center; padding: 40px 20px 8px; }
  header img { width: min(340px, 78vw); height: auto; }
  .tag { font-weight: 700; font-size: 22px; margin: 4px 0 0; }
  .visit { background: var(--pink-soft); border-radius: 18px; padding: 22px 24px; margin: 28px 0; display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
  .visit p { margin: 0; }
  .visit strong { display: block; font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  @media (max-width: 560px) { .visit { grid-template-columns: 1fr; } }
  h2 { font-size: 24px; margin: 40px 0 8px; }
  h2::after { content: ""; display: block; width: 44px; height: 5px; border-radius: 3px; background: var(--pink); margin-top: 6px; }
  ul.prices { list-style: none; padding: 0; margin: 12px 0; border-top: 1px solid var(--line); }
  ul.prices li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  ul.prices b { white-space: nowrap; }
  .muted { color: var(--muted); }
  a { color: inherit; }
  .btn { display: inline-block; background: var(--ink); color: #fff; text-decoration: none; font-weight: 600; padding: 12px 22px; border-radius: 999px; margin-top: 6px; }
  .btn:hover { background: #333; }
  .btn-ghost { background: transparent; color: var(--ink); border: 2px solid var(--ink); }
  .truck { max-width: 760px; margin: 32px auto 0; padding: 0 20px; }
  .truck img { width: 100%; height: auto; display: block; }
  footer.wrap { margin-top: 48px; padding: 24px 20px 40px; border-top: 1px solid var(--line); font-size: 15px; color: var(--muted); }
</style>
<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>
</head>
<body>
<header class="wrap">
  <h1 style="margin:0"><img src="/assets/img/sudzee-logo-tagline.jpg" alt="Sudzee: Laundromat + Wash &amp; Fold" width="682" height="700"></h1>
  <p class="tag">The Friendliest People. Outstanding Wash &amp; Fold.</p>
</header>
<main class="wrap">
  <div class="visit">
    <p><strong>Address</strong>2609 Foothill Blvd<br>Oakland, CA 94601<br><a href="${MAP}" rel="noopener">Get directions</a></p>
    <p><strong>Open</strong>${t('{site:dropoff_hours}')}</p>
  </div>

  <h2>Do it yourself</h2>
  <p>Self-service washers and dryers, open every day. Come in any time we're open, no appointment needed.</p>

  <h2>Or drop it off</h2>
  <p>Leave your laundry at the counter and our team washes, dries and folds it for you, with Free &amp; Clear detergent and no fragrance, bleach or softener.</p>
  <ul class="prices">
    <li><span>Wash &amp; fold</span><b>${t('{retail:Wash & Fold}')}</b></li>
    <li><span>Wash &amp; dry (no folding)</span><b>${t('{retail:Wash & Dry}')}</b></li>
    <li><span>Vinegar rinse</span><b>${t('{retail:Vinegar}')}</b></li>
    <li><span>Oxi (brighter whites)</span><b>${t('{retail:Oxi}')}</b></li>
    <li><span>Double Wash</span><b>${t('{retail:Double Wash}')}</b></li>
  </ul>
  <p class="muted">${t('{site:dropoff_cutoff}')}</p>

  <h2>Rather not come in?</h2>
  <p>Our pickup and delivery service, Family Laundry, collects your laundry from your door across Oakland, the East Bay and San Francisco, ${t('{site:service_days}')}, and brings it back folded the next day.</p>
  <p><a class="btn" href="${APP}">Schedule a pickup</a> <a class="btn btn-ghost" href="${FL}">About Family Laundry</a></p>
</main>
<p class="truck"><a href="${FL}"><img src="/assets/img/sudzee-brought-by-fl.jpg" alt="Brought to you by Family Laundry" width="1000" height="1000" loading="lazy"></a></p>
<footer class="wrap">
  <p>Sudzee Wash &amp; Fold · 2609 Foothill Blvd, Oakland, CA 94601</p>
</footer>
</body>
</html>`;
}

module.exports = { page, ORIGIN };
