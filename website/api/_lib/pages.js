// Page builders. Each returns { path, title, description, body, jsonld?, noindex?, status? }.
// Marketing copy comes from the former Wix site; every price is a live token.
const C = require('../../assets/fl-content.js');
const wix = require('../../content/wix-export.json');
const { APP, ORIGIN } = require('./layout.js');
const { esc } = C;

// Render a short content string (tokens + light markdown) to HTML.
const md = (text, v) => C.renderContent(text, v).html;
// Inline (no <p>) version for headings / list items.
const mdi = (text, v) => md(text, v).replace(/^<p>|<\/p>$/g, '');

const DEFAULT_DESC = "Wash & fold laundry pickup and delivery from an Oakland family business. Washed fragrance-free at our own plant in Oakland, never outsourced, and back the next day.";

function cta(label = 'Schedule a pickup') {
  return `<a class="btn" href="${APP}">${esc(label)}</a>`;
}

// ── Home ────────────────────────────────────────────────────────────────
function home(v) {
  const reviews = [
    ['Kether A, Alameda', 'The way my laundry was returned was so neat and organized that it only took a few minutes to put away. It made me happy, as silly as it seems. The prices seem very fair and the folks were most kind and helpful. You should try it.'],
    ['Chimed D, Oakland', 'Amazing, a godsend, the bomb, so helpful, artistic and beautiful presentation of returned laundry - impressive!!! 5 shining stars!'],
    ['Frisbee G, San Francisco', 'I cannot emphasize enough how quality this experience was in action [...] My items came back clean, neatly folded, and smelling better than when they were new, which is to say delightfully scent free.'],
  ];
  // Layout and look follow the original Wix homepage (David prefers it); copy and prices are the corrected, live versions.
  const body = `
<section class="h-hero">
  <img class="h-hero-img" src="/assets/img/hero-wide.jpg" alt="A woman smelling freshly cleaned laundry" width="1920" height="984">
  <div class="wrap h-hero-copy">
    <h1><span class="h-kicker">Family Laundry</span>Premium Wash &amp; Fold for Busy Households</h1>
    <p class="h-hero-sub">Picked up, washed at our own plant in Oakland and back folded the next day. ${mdi('{site:service_days}', v)}.</p>
    ${ratingBadge(v)}
    <a class="h-btn h-btn-lg" href="${APP}">Get started</a>
    <img class="h-stamp" src="/assets/img/free-clear-stamp.png" alt="Hypoallergenic, Free &amp; Clear, no nasty stuff" width="236" height="236">
  </div>
</section>

<section class="h-van">
  <div class="h-van-art">
    <img src="/assets/img/electric-truck-trim.png" alt="Family Laundry electric delivery van" loading="lazy">
    <span class="h-arrow" aria-hidden="true"></span>
    <p class="h-electric">I'm electric</p>
  </div>
  <div class="h-van-copy">
    <h2>Delivering laundry across the Bay since ${esc(v.site?.founded || '2019')}.</h2>
    <p>We pick up your laundry, wash it ourselves and bring it back folded the next day. <a href="/post/premium-laundry-delivery-at-your-doorstep">What makes us different</a>.</p>
    <p>We're an Oakland family business with more than 30 employees. We run our own wash &amp; fold plant and our own delivery vans, and we never outsource. Not happy with an order? Tell us and we'll make it right.</p>
    <p>Let us take care of your laundry. <a href="${APP}">Create an account</a> and book your first pickup.</p>
  </div>
</section>

<section class="h-pricing" id="pricing">
  <div class="h-tile h-tile-1">
    <h2>Per Bag<br>${mdi('{price:Wash & Fold}', v)} + Delivery</h2>
    <p class="h-note">(Great for occasional users).</p>
    <div class="h-bags h-bags-1" aria-hidden="true">
      <img src="/assets/img/two-bags-trim.png" alt="" loading="lazy"><span class="h-curve"></span><img src="/assets/img/fl-bag-trim.png" alt="" loading="lazy">
    </div>
    <ul class="h-dots">
      <li>25 lbs Wash &amp; Fold (about 2–3 loads)*</li>
      <li>Next-day Delivery: ${mdi('{fee:Delivery Fee}', v)}</li>
      <li>Same-day Delivery: +${mdi('{fee:Same-Day Surcharge}', v)} (where available)</li>
    </ul>
    <p class="h-fine">*Bags weighing more than 25 lbs are an extra ${mdi('{site:overweight_rate}', v)}.</p>
    <p class="h-tile-cta"><a class="btn" href="${APP}">Book one bag</a></p>
  </div>
  <div class="h-tile h-tile-2">
    <h2>Subscribe<br>${mdi('{plan:price}', v)}/month</h2>
    <p class="h-note">(Best value).</p>
    <div class="h-bags h-bags-2" aria-hidden="true">
      <img src="/assets/img/fl-bag-trim.png" alt="" loading="lazy"><img src="/assets/img/fl-bag-trim.png" alt="" loading="lazy"><img src="/assets/img/fl-bag-trim.png" alt="" loading="lazy"><img src="/assets/img/fl-bag-trim.png" alt="" loading="lazy">
    </div>
    <ul class="h-dots">
      <li>${mdi('{plan:lbs}', v)} lbs Wash &amp; Fold*</li>
      <li>Unlimited pickups</li>
      <li>Next-day Delivery: FREE</li>
      <li>Same-day Delivery: +${mdi('{fee:Same-Day Surcharge}', v)} (where available)</li>
      <li>No minimum lbs. per order</li>
    </ul>
    <p class="h-fine">*Usage above ${mdi('{plan:lbs}', v)} lbs per month is ${mdi('{plan:overage}', v)} per lb.</p>
    <p class="h-tile-cta"><a class="btn" href="${APP}">Subscribe</a></p>
  </div>
</section>

<section class="h-clean">
  <h2>How we clean</h2>
  <p>We wash with Free &amp; Clear hypoallergenic detergent and ozone. We never use fragrance, bleach, softener or dry-cleaning solvents.</p>
  <p>Your laundry comes back with a neutral, clean smell and no detergent or softener residue.</p>
  <div class="h-steps">
    <div><img src="/assets/img/step-prep.jpg" alt="" width="121" height="121" loading="lazy"><h3>Prep</h3><p>We empty all pockets and separate lights and darks.</p></div>
    <div><img src="/assets/img/step-wash.jpg" alt="" width="121" height="121" loading="lazy"><h3>Wash, Sanitize, Dry</h3><p>We wash in cold water with Free &amp; Clear detergent and ozone, then dry on medium.</p></div>
    <div><img src="/assets/img/step-fold.png" alt="" width="121" height="121" loading="lazy"><h3>Fold</h3><p>We neatly fold your laundry, ball socks, and bundle your laundry by family member.</p></div>
  </div>
</section>

<section class="h-bubbles">
  <div class="h-bubbles-copy">
    <h2>Bubble Power</h2>
    <p>The washers at our plant run on ozone-injected water. Ozone sanitizes your laundry (and the machines as they run) and helps a mild detergent clean better.</p>
  </div>
</section>

${ownRatingLine(v) ? `<p class="h-own">${ownRatingLine(v)}</p>` : ''}
<section class="h-quotes" aria-label="What customers say">
  ${reviews.map(([who, q]) => `<figure><span class="h-qmark" aria-hidden="true">&ldquo;</span><figcaption>${esc(who)}</figcaption><blockquote>"${esc(q)}"</blockquote></figure>`).join('')}
</section>

<section id="story" class="h-story">
  <h2>Our story</h2>
  <div class="h-video"><iframe src="https://www.youtube-nocookie.com/embed/342c6q6Ly-I" title="Family Laundry - Laundry service for busy households" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>
  <p>Our Family Laundry adventure began in early 2018, the day we closed on our first laundromat in Oakland. Our respective backgrounds didn't make us laundry delivery experts from the get-go, but we got our hands dirty and learned along the way.</p>
  <p>We run Family Laundry the way we think all companies should be run: we put employees first, we actively engage with the communities we operate in, and we do our part to reduce our impact on the environment.</p>
  <p>Thank you for trusting us with your laundry.</p>
  <p>Laura Guevara &amp; David Macquart-Moulin</p>
  <p><a href="/about-us">Meet the team →</a></p>
</section>

${contactBlock(v)}`;
  return {
    path: '/',
    title: 'Laundry Pickup & Delivery in Oakland & the East Bay | Family Laundry',
    description: "Wash & fold laundry pickup and delivery from an Oakland family business. Washed fragrance-free at our own plant in Oakland, never outsourced, and back the next day. Serving Oakland, Berkeley, the East Bay and San Francisco, Monday to Saturday.",
    body,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'DryCleaningOrLaundry', '@id': BIZ_ID, name: 'Family Laundry',
      url: 'https://www.familylaundry.com', telephone: v.site?.phone, email: v.site?.email,
      image: 'https://www.familylaundry.com/assets/img/logo-circle-512.png', logo: 'https://www.familylaundry.com/assets/img/logo-circle-512.png',
      address: { '@type': 'PostalAddress', streetAddress: '2609 Foothill Blvd', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94601', addressCountry: 'US' },
      areaServed: (v.cities || []).map(c => ({ '@type': 'City', name: c })),
      // Rating markup = our OWN after-delivery ratings (order_feedback), never Google's numbers: Google's rules
      // forbid marking up ratings copied from another site. The same figure is shown visibly (ratingBadge).
      ...ownRatingLd(v),
    },
  };
}

// Google/Yelp rating badge: each shown only when its site_info rating + review count are set (Admin → App Content → Business info).
function ratingBadge(v) {
  // One line (David, Oct 5): "★★★★★ 4.8 from 500+ reviews on Google & Yelp". Our own after-delivery rating is shown
  // in the footer (and above the homepage quotes), which keeps the page's rating markup visible to visitors.
  const s = v.site || {};
  const g = Number(s.google_reviews) || 0, y = Number(s.yelp_reviews) || 0;
  const rating = s.google_rating || s.yelp_rating;
  if (!rating || !(g + y)) return '';
  const total = g + y;
  const count = total >= 100 ? `${Math.floor(total / 100) * 100}+` : String(total);
  const where = [g && 'Google', y && 'Yelp'].filter(Boolean).join(' &amp; ');
  const text = `<span class="rating-stars" aria-hidden="true">★★★★★</span> <strong>${esc(rating)}</strong> from ${count} reviews <span class="nowrap">on ${where}</span>`;
  return `<p class="rating">${s.google_reviews_url ? `<a href="${esc(s.google_reviews_url)}" rel="noopener">${text}</a>` : text}</p>`;
}
// Google/Yelp line plus our own rating with its count, high on the page. The own figure is what the page's
// rating markup says, and Google trusts markup more when the same numbers are prominent on the page (Oct 6).
function ratingBlock(v) {
  const own = ownRatingLine(v);
  return ratingBadge(v) + (own ? `\n  <p class="rating-own">${own}</p>` : '');
}
// One @id for the business, so every page's markup points at the same entity (Oct 6).
const BIZ_ID = ORIGIN + '/#business';
function ownRatingLine(v) {
  const r = ownRating(v);
  return r ? `<strong>${esc(r.avg.toFixed(1))} ★</strong> from ${esc(String(r.count))} ratings left after delivery` : '';
}

// Our own after-delivery ratings (site_public_values().ratings, from order_feedback). Shown once there are 20+.
function ownRating(v) {
  const r = v.ratings || {};
  const avg = Number(r.avg), count = Number(r.count);
  return count >= 20 && avg > 0 ? { avg, count } : null;
}
function ownRatingLd(v) {
  const r = ownRating(v);
  return r ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: r.avg, ratingCount: r.count, bestRating: 5, worstRating: 1 } } : {};
}

const FORM_URL = 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/website-contact';
function contactForm(kind) {
  const biz = kind === 'commercial';
  return `<form class="form" method="post" action="${FORM_URL}" data-contact>
  <input type="hidden" name="kind" value="${kind}"><input type="hidden" name="t" value="">
  <div class="hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
  <div class="two"><label>Name <input name="name" required autocomplete="name"></label>
  ${biz ? '<label>Business or school <input name="business" autocomplete="organization"></label>' : '<label>Phone (optional) <input name="phone" type="tel" autocomplete="tel"></label>'}</div>
  ${biz ? '<div class="two"><label>Email <input name="email" type="email" required autocomplete="email"></label><label>Phone <input name="phone" type="tel" autocomplete="tel"></label></div>' : '<label>Email <input name="email" type="email" required autocomplete="email"></label>'}
  <label>${biz ? 'What do you need washed, and how much per week?' : 'Message'} <textarea name="message" required maxlength="5000"></textarea></label>
  <p class="form-msg" role="status"></p>
  <p><button class="btn" type="submit">Send</button></p>
</form>`;
}

function contactBlock(v) {
  const s = v.site || {};
  const tel = s.phone ? s.phone.replace(/[^\d+]/g, '') : '';
  return `<section class="h-contact" id="contact">
  <h2>Contact us</h2>
  <div class="h-contact-form">${contactForm('contact')}</div>
  <div class="h-contact-info">
    ${s.phone ? `<p><strong>Call or text</strong><br><a href="tel:${esc(tel)}">${esc(s.phone)}</a><br><span class="muted">Leave a message and we'll call you back the same day. Customers can also reply to our last text.</span></p>` : ''}
    ${s.email ? `<p><strong>Email</strong><br><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>` : ''}
    <p><strong>Drop-off</strong><br>${esc(s.dropoff_address || '')}<br>Open ${esc(s.dropoff_hours || '')}<br><span class="muted">${esc(s.dropoff_cutoff || '')} Drop-off wash &amp; fold: ${mdi('{retail:Wash & Fold}', v)}.</span></p>
  </div>
</section>`;
}

// ── FAQ ─────────────────────────────────────────────────────────────────
function faq(v, faqTopics) {
  const nav = faqTopics.map(t => `<a href="#${esc(t.slug)}">${esc(t.name)}</a>`).join('');
  const sections = faqTopics.map(t => `
  <section class="faq-topic" id="${esc(t.slug)}">
    <h2>${esc(t.name)}</h2>
    ${t.items.map(i => `<details class="faq-item" id="q-${i.id}">
      <summary>${esc(i.question)}</summary>
      <div class="faq-a">${md(i.answer, v)}</div>
    </details>`).join('')}
  </section>`).join('');
  return {
    path: '/faq',
    title: 'Family Laundry | FAQ',
    description: 'Answers about Family Laundry pickup and delivery: service area, pricing, minimums, turnaround, detergents, subscriptions and more.',
    body: `<section class="wrap section narrow">
  <h1>Frequently asked questions</h1>
  <nav class="pills" aria-label="FAQ topics">${nav}</nav>
  ${sections}
  <p class="still">Still have a question? <a href="#contact">Contact us</a>.</p>
</section>
${contactBlock(v)}`,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: faqTopics.flatMap(t => t.items).map(i => ({
        '@type': 'Question', name: i.question,
        acceptedAnswer: { '@type': 'Answer', text: C.renderPlain(i.answer, v) },
      })),
    },
  };
}

// ── Services ────────────────────────────────────────────────────────────
// Pill links to the topic pages of one group (content/topics.js), for the Services and Commercial pages.
function topicLinks(group, heading, extra = []) {
  const links = [...require('../../content/topics.js').filter(t => t.group === group).map(t => [t.path, t.nav]), ...extra];
  return `<div class="related"><h2>${esc(heading)}</h2><ul>${links.map(([h, l]) => `<li><a href="${esc(h)}">${esc(l)}</a></li>`).join('')}</ul></div>`;
}

function services(v) {
  // One type family, two weights (400 text, 700 names and prices), one tile style for every picture (David, Oct 5:
  // the old Wix layout mixed too many sizes and weights).
  const addon = (img, alt, name, desc, price, unit) => `<div class="sv-addon">
      <div class="sv-tile"><img src="/assets/img/${img}" alt="${esc(alt)}" loading="lazy"></div>
      <div><h3>${name}</h3><p>${desc}</p><p class="sv-price">${price} <span>${unit}</span></p></div>
    </div>`;
  const extra = (name, desc, price, unit) => `<div class="sv-extra"><h3>${name}</h3><p>${desc}</p><p class="sv-price">${price} <span>${unit}</span></p></div>`;
  return {
    path: '/laundry-delivery-services',
    title: 'Laundry Services & Prices: Wash & Fold Pickup and Delivery | Family Laundry',
    description: 'Wash & fold pickup and delivery, plus Air Dry, shirt service, Vinegar, Oxi and Double Wash. Washed fragrance-free at our own plant in Oakland. Serving the East Bay and San Francisco.',
    body: `<section class="wrap section sv">
  <p class="eyebrow">Services &amp; prices</p>
  <h1>Wash &amp; fold, done for you</h1>
  <p class="sv-lead">Picked up at your door, washed fragrance-free at our own plant in Oakland, and back folded the next day.</p>

  <div class="sv-main">
    <div class="sv-tile sv-tile-lg"><img src="/assets/img/svc-washfold-cut.png" alt="A Family Laundry bag of clean, folded laundry"></div>
    <div>
      <h2>Wash &amp; Fold</h2>
      <p>Your everyday household laundry: clothes, towels and sheets. Washed cold with Free &amp; Clear detergent and ozone, dried on medium, then folded and bundled by family member.</p>
      <div class="sv-plans">
        <div class="sv-plan">
          <h3>Per bag</h3>
          <p class="sv-price">${mdi('{price:Wash & Fold}', v)} <span>per bag, up to 25 lbs</span></p>
          <p>+ ${mdi('{fee:Delivery Fee}', v)} delivery. Over 25 lbs: ${mdi('{site:overweight_rate}', v)}.</p>
        </div>
        <div class="sv-plan">
          <h3>Subscription</h3>
          <p class="sv-price">${mdi('{plan:price}', v)} <span>per month</span></p>
          <p>${mdi('{plan:lbs}', v)} lbs, delivery included. Extra: ${mdi('{plan:overage}', v)}/lb.</p>
        </div>
      </div>
      <p><a href="/laundry-service-cost">Which is cheaper for me?</a></p>
    </div>
  </div>

  <h2 class="sv-h">Add-ons</h2>
  <div class="sv-addons">
    ${addon('svc-delicates-cut.png', 'A mesh delicates bag', 'Air Dry', 'For delicates, lingerie and workout gear. Put them in a separate bag and choose Air Dry when you book.', '+' + mdi('{price:Air Dry}', v), 'per delicates bag')}
    ${addon('svc-shirt-cut.png', 'A hand-steamed shirt on a hanger', 'Shirt service', 'Shirts and blouses laundered, hand-steamed and delivered on hangers.', '+' + mdi('{price:Shirt Service}', v), 'per shirt')}
  </div>
  <div class="sv-extras">
    ${extra('Vinegar rinse', 'Softens fabric and rinses out detergent residue.', '+' + mdi('{price:Vinegar}', v), 'per bag')}
    ${extra('Oxi', 'Brighter whites without bleach.', '+' + mdi('{price:Oxi}', v), 'per bag')}
    ${extra('Double Wash', 'A second full wash, for very dirty loads or pet beds.', '+' + mdi('{price:Double Wash}', v), 'per bag')}
    ${extra('Same-day', 'Back the same day, where available. Enter your address in the app to check.', '+' + mdi('{fee:Same-Day Surcharge}', v), 'per order')}
  </div>

  ${topicLinks('Residential', 'Guides by situation')}
  ${topicLinks('Getting started', 'New to Family Laundry?', [['/laundry-service-cost', 'What laundry service costs']])}
  <p class="center sv-cta">${cta()}</p>
</section>`,
  };
}

// ── Commercial ──────────────────────────────────────────────────────────
function commercial(v) {
  const s = v.site || {};
  const logos = [1, 2, 3, 4, 5, 6].map(n => `<img src="/assets/img/client-${n}-trim.png" alt="" loading="lazy">`).join('');
  return {
    path: '/commercial-laundry',
    title: 'Commercial Laundry Service for Schools, Daycares & Businesses | Family Laundry',
    description: 'Commercial laundry pickup and delivery for schools, daycares and businesses in San Francisco and the East Bay: nap mats, bibs, towels, uniforms and linens. Washed at our own plant in Oakland on a schedule that fits yours.',
    body: `<section class="wrap section narrow sv">
  <p class="eyebrow">Commercial</p>
  <h1>Commercial laundry</h1>
  <p class="sv-lead">Schools, daycares and businesses in San Francisco and the East Bay trust us with their laundry every week.</p>
  <div class="sv-plans">
    <div class="sv-plan">
      <h3>Schools &amp; daycares</h3>
      <p>Nap-time bedding, bibs, smocks, towels and cloth napkins, picked up and returned on your schedule. Washed fragrance-free with Free &amp; Clear and ozone, for sensitive skin. <a href="/daycare-laundry-service">More</a></p>
    </div>
    <div class="sv-plan">
      <h3>Businesses</h3>
      <p>Gyms, salons, clinics, offices and Airbnb hosts. We build a plan around your volume and schedule, with monthly invoicing. <a href="/airbnb-laundry-service">Airbnb</a> · <a href="/gym-towel-laundry-service">Gyms</a> · <a href="/salon-spa-laundry-service">Salons</a></p>
    </div>
  </div>
  <p class="sv-price">From ${mdi('{commercial:Wash & Fold}', v)} <span>commercial wash &amp; fold, monthly invoicing available</span></p>
  <p class="logos-label">Trusted by</p>
  <div class="logos">${logos}</div>
  <div class="card">
    <h2>Get a quote</h2>
    <p>Tell us what you need washed and roughly how much per week. We reply within one business day.</p>
    ${contactForm('commercial')}
    ${s.phone ? `<p class="muted">Or call ${esc(s.phone)}.</p>` : ''}
  </div>
  ${topicLinks('Commercial', 'Laundry by business type')}
</section>`,
  };
}

// ── Service area ────────────────────────────────────────────────────────
function serviceMap(v) {
  return {
    path: '/service-map',
    title: 'Laundry Delivery Area | Family Laundry',
    description: `Family Laundry picks up and delivers in ${C.list(CITIES.map(c => c.name))}.`,
    body: `<section class="wrap section">
  <h1>Service area</h1>
  <p class="lead">Family Laundry is headquartered in Oakland and serves most of the East Bay and San Francisco.</p>
  <p>Not sure about your street? Enter your address in the app and we'll tell you right away.</p>
  <ul class="city-list">${CITIES.map(c => `<li><a href="${cityPath(c)}">${esc(c.name)}</a></li>`).join('')}</ul>
  <p class="muted">We pick up and deliver ${mdi('{site:service_days}', v)}.</p>
  <p>${cta('Check my address')}</p>
  <img class="map" src="/assets/img/delivery-map.png" alt="Map of the Family Laundry delivery area" loading="lazy">
</section>`,
  };
}

// ── City pages ──────────────────────────────────────────────────────────
// One page per entry in content/cities.js. Old Wix city URLs (oakland, berkeley,
// alameda, sf) keep their addresses; the stale Wix copy is no longer used.
const CITIES = require('../../content/cities.js');
const DETAILS = require('../../content/city-details.js');
const cityPath = c => `/laundry-delivery-${c.slug}`;

// Live pickup windows for a city, from site_public_values().zones (route_templates).
// Returns [] until that key exists, so pages simply omit the windows block.
function cityWindows(c, v) {
  const zones = Array.isArray(v.zones) ? v.zones : [];
  const z = zones.find(x => (x.cities || []).includes(c.name)) || zones.find(x => x.name === c.zone);
  if (!z) return [];
  const hm = t => { const [h, m] = String(t).split(':').map(Number); return { h, m }; };
  const part = ({ h, m }) => `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}`;
  const ap = h => (h < 12 ? 'am' : 'pm');
  return (z.windows || []).map(w => {
    const a = hm(w.start), b = hm(w.end);
    const range = ap(a.h) === ap(b.h) ? `${part(a)}–${part(b)} ${ap(b.h)}` : `${part(a)} ${ap(a.h)}–${part(b)} ${ap(b.h)}`;
    const label = a.h < 12 ? 'Morning' : a.h < 17 ? 'Midday' : 'Evening';
    return { label, range };
  });
}

function city(c, v) {
  const name = c.name;
  const d = DETAILS[c.slug] || {};
  const hoodList = d.hoods || c.hoods;
  const plain = t => C.renderPlain(t, v);
  const nearby = CITIES.filter(o => o.region === c.region && o.slug !== c.slug).slice(0, 6);
  const wins = cityWindows(c, v);
  const winText = wins.map(w => `${w.label.toLowerCase()} (${w.range})`);
  const days = plain('{site:service_days}');
  const faqs = [
    [`Do you pick up laundry in ${name}?`, wins.length
      ? `Yes. Family Laundry picks up and delivers in ${name} ${days}, with ${wins.length > 1 ? `${C.list(winText)} windows` : `${/^[aeiou]/.test(winText[0]) ? 'an' : 'a'} ${winText[0]} window`}. Pick yours when you book in the app.`
      : `Yes. Family Laundry picks up and delivers in ${name} ${days}. Enter your address in the app to see the pickup windows for your street.`],
    ...(d.faqs || []).map(([q, a]) => [q, plain(a)]),
    ['When do I get my laundry back?', 'The next service day. We wash and fold it at our own plant in Oakland, so a Saturday pickup comes back Monday.'],
    ['Do I need to be home?', "No. Leave your bag at the door, with your building's front desk, or wherever you tell us in the app."],
    ['What detergent do you use?', 'Free & Clear hypoallergenic detergent and ozone. We never use bleach, softener or fragrance.'],
  ];
  const hoodsBlock = !hoodList.length ? '' : d.hoods
    ? `<h2>Neighborhoods we serve in ${esc(name)}</h2>
  <ul class="city-list">${hoodList.map(h => `<li>${esc(h.replace(/^the /, 'The '))}</li>`).join('')}</ul>
  <p class="muted">Not sure about your street? <a href="${APP}">Enter your address in the app</a> and we'll tell you right away.</p>`
    : `<p>We pick up all over ${esc(name)}, including ${esc(C.list(hoodList))}.</p>`;
  return {
    path: cityPath(c),
    noindex: !c.index,
    title: `Laundry Pickup & Delivery in ${name} | Family Laundry`,
    description: `Wash & fold laundry pickup and delivery in ${name}. Washed fragrance-free at our own plant in Oakland, never outsourced, and back the next day.`,
    body: `<section class="wrap section narrow">
  <h1>Laundry pickup &amp; delivery in ${esc(name)}</h1>
  <p class="lead">${esc(c.intro)}</p>
  ${ratingBlock(v)}
  ${(d.about || []).map(p => `<p>${esc(p)}</p>`).join('\n  ')}
  ${d.households ? `<p class="city-stat"><strong>${esc(d.households.charAt(0).toUpperCase() + d.households.slice(1))} ${esc(name)} households</strong> used Family Laundry in the past year.</p>` : ''}
  ${wins.length ? `<div class="card">
    <h2>Pickup windows in ${esc(name)}</h2>
    <ul class="ticks">${wins.map(w => `<li><strong>${esc(w.label)}:</strong> ${esc(w.range)}</li>`).join('')}</ul>
    <p class="muted">${esc(days)}. Choose your window when you book; we text you when the driver is on the way.</p>
  </div>` : ''}
  ${d.photo ? `<figure class="city-photo"><img src="/assets/img/${esc(d.photo)}" alt="A Family Laundry bag of folded, bundled laundry delivered to a doorstep" width="900" height="1200" loading="lazy"><figcaption>Back at your door, folded and bundled by family member.</figcaption></figure>` : ''}
  ${hoodsBlock}
  ${d.review ? `<figure class="city-quote"><blockquote>“${esc(d.review.text)}”</blockquote><figcaption>${esc(d.review.who)}</figcaption></figure>` : ''}
  <div class="why why-2">
    <div><h3>Cleaned in-house</h3><p>Washed by our own team at our Oakland plant. Never outsourced.</p></div>
    <div><h3>Fragrance-free</h3><p>Free &amp; Clear detergent and ozone. Nothing that lingers on skin.</p></div>
    <div><h3>Back the next day</h3><p>Folded neatly, socks balled, bundled by family member.</p></div>
    <div><h3>No need to be home</h3><p>Leave your bag at the door. We text you when we're on the way.</p></div>
  </div>
  <div class="card">
    <h2>Pricing in ${esc(name)}</h2>
    <ul class="ticks">
      <li>Per bag: ${mdi('{price:Wash & Fold}', v)} for up to 25 lbs, plus ${mdi('{fee:Delivery Fee}', v)} delivery</li>
      <li>Subscription: ${mdi('{plan:price}', v)}/month for ${mdi('{plan:lbs}', v)} lbs, delivery included</li>
    </ul>
    <p>${cta()}</p>
  </div>
  <h2>Schools, daycares and businesses in ${esc(name)}</h2>
  <p>We also handle laundry for schools, daycares, gyms, clinics and offices. <a href="/commercial-laundry">See commercial laundry</a>.</p>
  <h2>Questions from ${esc(name)} customers</h2>
  ${faqs.map(([q, a]) => `<details class="faq-item"><summary>${esc(q)}</summary><div class="faq-a"><p>${esc(a)}</p></div></details>`).join('')}
  ${nearby.length ? `<p class="muted nearby">We also serve ${nearby.map(o => `<a href="${cityPath(o)}">${esc(o.name)}</a>`).join(', ')}. <a href="/service-map">See the full service area</a>.</p>` : ''}
</section>`,
    jsonld: {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage',
          mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
        { '@type': 'DryCleaningOrLaundry', '@id': ORIGIN + cityPath(c) + '#business', parentOrganization: { '@id': BIZ_ID },
          name: 'Family Laundry', url: ORIGIN + cityPath(c), telephone: v.site?.phone,
          image: ORIGIN + '/assets/img/logo-circle-512.png',
          address: { '@type': 'PostalAddress', streetAddress: '2609 Foothill Blvd', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94601', addressCountry: 'US' },
          areaServed: { '@type': 'City', name },
          ...ownRatingLd(v) },
      ],
    },
  };
}

// ── Topic pages (services, business types, guides) ─────────────────────────
const TOPICS = require('../../content/topics.js');
const SERVICE_AREA = v => (v.cities || []).map(c => ({ '@type': 'City', name: c }));

function relatedLinks(paths) {
  const label = p => (TOPICS.find(t => t.path === p) || {}).nav
    || ({ '/laundry-service-cost': 'How much laundry service costs', '/commercial-laundry': 'Commercial laundry',
          '/laundry-delivery-services': 'Wash & fold service', '/faq': 'FAQ', '/laundry-delivery-oakland': 'Laundry delivery in Oakland' })[p] || p;
  return paths && paths.length ? `<div class="related"><h2>Related</h2><ul>${paths.map(p => `<li><a href="${esc(p)}">${esc(label(p))}</a></li>`).join('')}</ul></div>` : '';
}

function topic(t, v) {
  const faqs = (t.faqs || []).map(([q, a]) => [q, C.renderPlain(a, v)]);
  const ctaBlock = t.cta === 'quote'
    ? `<div class="card" id="quote">
    <h2>Get a quote</h2>
    <p>Tell us what you need washed and roughly how much per week. We reply within one business day.</p>
    ${contactForm('commercial')}
    ${v.site?.phone ? `<p class="muted">Or call ${esc(v.site.phone)}.</p>` : ''}
  </div>`
    : `<div class="card">
    <h2>Book a pickup</h2>
    <p>Pickup and delivery ${mdi('{site:service_days}', v)}. Per bag: ${mdi('{price:Wash & Fold}', v)} plus ${mdi('{fee:Delivery Fee}', v)} delivery, or ${mdi('{plan:price}', v)}/month with a subscription.</p>
    <p>${cta()}</p>
  </div>`;
  const graph = [];
  if (faqs.length) graph.push({ '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) });
  if (t.service) graph.push({ '@type': 'Service', name: t.h1, serviceType: t.service, url: ORIGIN + t.path, areaServed: SERVICE_AREA(v),
    provider: { '@type': 'DryCleaningOrLaundry', '@id': BIZ_ID, name: 'Family Laundry', url: ORIGIN, telephone: v.site?.phone,
      address: { '@type': 'PostalAddress', streetAddress: '2609 Foothill Blvd', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94601', addressCountry: 'US' },
      ...ownRatingLd(v) } });
  return {
    path: t.path, title: t.title, description: t.description,
    body: `<section class="wrap section narrow topic">
  <p class="eyebrow">${esc(t.group)}</p>
  <h1>${esc(t.h1)}</h1>
  <p class="lead">${esc(t.lead)}</p>
  ${ratingBlock(v)}
  ${t.photo ? `<figure class="about-photo"><img src="/assets/img/${esc(t.photo.src)}" alt="${esc(t.photo.alt)}" width="${t.photo.w}" height="${t.photo.h}"><figcaption>${esc(t.photo.caption)}</figcaption></figure>` : ''}
  ${t.sections.map(s => `<h2>${esc(s.h)}</h2>\n  ${md(s.md, v)}`).join('\n  ')}
  ${ctaBlock}
  ${faqs.length ? `<h2>Questions</h2>
  ${faqs.map(([q, a]) => `<details class="faq-item"><summary>${esc(q)}</summary><div class="faq-a"><p>${esc(a)}</p></div></details>`).join('')}` : ''}
  ${relatedLinks(t.related)}
</section>`,
    jsonld: graph.length ? { '@context': 'https://schema.org', '@graph': graph } : undefined,
  };
}

// "How much does laundry service cost?" — every number computed from the live price list.
function cost(v) {
  const n = x => Number(x || 0);
  const bag = n(v.price?.['Wash & Fold']?.amount), del = n(v.fee?.['Delivery Fee']), same = n(v.fee?.['Same-Day Surcharge']);
  const plan = n(v.plan?.price), lbs = n(v.plan?.lbs), over = n(v.plan?.overage), retail = n(v.retail?.['Wash & Fold']?.amount);
  const m = C.money;
  const perOrder = bag + del;
  const rows = [1, 2, 4, 6].map(bags => {
    const pounds = bags * 25, perBag = bags * perOrder;
    const sub = plan + Math.max(0, pounds - lbs) * over;
    const best = sub < perBag ? 'Subscription' : 'Per bag';
    return `<tr><td>${bags} bag${bags > 1 ? 's' : ''} (about ${pounds} lbs)</td><td>${esc(m(perBag))}</td><td>${esc(m(sub))}</td><td class="best">${best}</td></tr>`;
  }).join('');
  const faqs = [
    ['How much is laundry pickup and delivery per pound?', `A ${m(bag)} bag holds up to 25 lbs, about ${m(bag / 25)} per lb before delivery. Drop-off wash & fold at our Oakland counter is ${m(retail)}/lb.`],
    ['Is a laundry subscription worth it?', `From about four bags a month. Each bag costs ${m(perOrder)} with delivery, so four bags cost ${m(4 * perOrder)}, against ${m(plan)} for the subscription.`],
    ['Is there a minimum?', `One bag: ${m(bag)} plus ${m(del)} delivery. Subscribers have no minimum per order.`],
  ];
  return {
    path: '/laundry-service-cost',
    title: 'How Much Does Laundry Service Cost in the Bay Area? | Family Laundry',
    description: `Wash & fold pickup and delivery costs ${m(bag)} per 25-lb bag plus ${m(del)} delivery, or ${m(plan)}/month for ${lbs} lbs. See what a month of laundry costs and which option is cheaper.`,
    body: `<section class="wrap section narrow topic">
  <p class="eyebrow">Getting started</p>
  <h1>How much does laundry service cost?</h1>
  <p class="lead">Pickup and delivery wash &amp; fold in the Bay Area with Family Laundry costs ${esc(m(bag))} per bag (up to 25 lbs) plus ${esc(m(del))} delivery, or ${esc(m(plan))} a month for ${esc(String(lbs))} lbs with delivery included.</p>
  ${ratingBlock(v)}
  <h2>Our prices</h2>
  <ul>
    <li><strong>Per bag:</strong> ${esc(m(bag))} for up to 25 lbs (about 2–3 loads), plus ${esc(m(del))} delivery per order. Over 25 lbs: ${mdi('{site:overweight_rate}', v)}.</li>
    <li><strong>Subscription:</strong> ${esc(m(plan))}/month for ${esc(String(lbs))} lbs, unlimited pickups, free next-day delivery, no minimum per order. Above ${esc(String(lbs))} lbs: ${esc(m(over))}/lb.</li>
    <li><strong>Drop-off</strong> at ${mdi('{site:dropoff_address}', v)}: ${esc(m(retail))}/lb wash &amp; fold. <a href="/drop-off-laundry-oakland">Drop-off details</a>.</li>
    <li><strong>Add-ons:</strong> Air Dry ${mdi('{price:Air Dry}', v)} per delicates bag, shirts ${mdi('{price:Shirt Service}', v)} each, Vinegar or Oxi ${mdi('{price:Oxi}', v)} per bag, Double Wash ${mdi('{price:Double Wash}', v)} per bag, same-day delivery +${esc(m(same))} where available.</li>
    <li><strong>Businesses:</strong> from ${mdi('{commercial:Wash & Fold}', v)}. <a href="/commercial-laundry">Commercial laundry</a>.</li>
  </ul>
  <h2>What a month of laundry costs</h2>
  <p>Assuming 25 lbs per bag and one bag per pickup:</p>
  <div class="table-wrap"><table class="price-table">
    <thead><tr><th>Laundry per month</th><th>Per bag</th><th>Subscription</th><th>Cheaper</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <p class="muted">Sending two bags in one pickup saves a delivery fee. Prices update automatically from our price list.</p>
  <h2>What's included either way</h2>
  <ul>
    <li>Pickup and delivery to your door ${mdi('{site:service_days}', v)}, back the next service day</li>
    <li>Washed at our own plant in Oakland by our own team, never outsourced</li>
    <li>Free &amp; Clear hypoallergenic detergent and ozone, with no fragrance, bleach or softener</li>
    <li>Folded, socks balled, bundled by family member, in bags that are yours to keep</li>
  </ul>
  <div class="card"><h2>Try it</h2><p>New customers: your friend's referral code takes ${mdi('{referral:friend}', v)} off your first order.</p><p>${cta()}</p></div>
  <h2>Questions</h2>
  ${faqs.map(([q, a]) => `<details class="faq-item"><summary>${esc(q)}</summary><div class="faq-a"><p>${esc(a)}</p></div></details>`).join('')}
  ${relatedLinks(['/first-laundry-pickup', '/laundry-delivery-services', '/drop-off-laundry-oakland'])}
</section>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
  };
}

// Generic renderer for exported Wix text blocks (escaped).
function renderBlocks(blocks, { skipFirstIfTitle } = {}) {
  let out = '', inList = false;
  blocks.forEach((b, idx) => {
    if (skipFirstIfTitle && idx === 0 && /laundry delivery service in|laundry delivery service in/i.test(b.x) && b.x.length < 80) return;
    if (b.t === 'li') { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${esc(b.x)}</li>`; return; }
    if (inList) { out += '</ul>'; inList = false; }
    if (b.t === 'h') { const l = Math.min(Math.max(b.l, 2), 4); out += `<h${l}>${esc(b.x)}</h${l}>`; }
    else if (b.x.trim()) out += `<p>${esc(b.x)}</p>`;
  });
  if (inList) out += '</ul>';
  return out;
}

// ── About us: the team, the facility, the vans (David's photos, Oct 5 2026) ──
// Google rewards proof of a real local business; visitors want to see who handles their laundry.
function about(v) {
  const img = f => `${ORIGIN}/assets/img/${f}`;
  return {
    path: '/about-us',
    title: 'About Us: an Oakland Family Business | Family Laundry',
    description: 'Meet Family Laundry: an Oakland family business since 2018 with more than 30 employees. We wash every delivery order at our own plant in Oakland and deliver it in our own electric vans.',
    body: `<section class="wrap section narrow about">
  <p class="eyebrow">About us</p>
  <h1>The people who do your laundry</h1>
  <p class="lead">Family Laundry is an Oakland family business. We started in early 2018, the day we closed on our first laundromat, and began pickup and delivery in 2019.</p>
  ${ratingBlock(v)}
  <figure class="about-photo"><img src="/assets/img/team.jpg" alt="The Family Laundry team in aprons in Oakland" width="1078" height="588">
    <figcaption>Part of the Family Laundry team in Oakland.</figcaption></figure>
  <h2>Our own team, never outsourced</h2>
  <p>We have more than 30 employees, and every order is washed, dried and folded by them. Your laundry never goes to a third party. When you call or text, you reach the same team.</p>
  <figure class="about-photo"><img src="/assets/img/facility.jpg" alt="A Family Laundry team member in front of the commercial washers" width="1140" height="766" loading="lazy">
    <figcaption>Our commercial washers in Oakland.</figcaption></figure>
  <h2>Our own plant in Oakland</h2>
  <p>Every delivery order is washed at our own plant in Oakland, in commercial machines with Free &amp; Clear hypoallergenic detergent and ozone. We never use fragrance, bleach or softener. Your order is folded, socks balled, and bagged in Family Laundry bags that are yours to keep.</p>
  <p>Drop-off orders are washed at our laundromat, Sudzee Wash &amp; Fold, at 2609 Foothill Boulevard. It shares its name with Sudzee, the San Francisco delivery company we acquired in 2022.</p>
  <figure class="about-photo"><img src="/assets/img/bag-deck.jpg" alt="A zipped Family Laundry bag on a sunny deck" width="1400" height="883" loading="lazy">
    <figcaption>Every customer gets their own Family Laundry bags.</figcaption></figure>
  <figure class="about-photo"><img src="/assets/img/vans.jpg" alt="Family Laundry electric Ford E-Transit vans parked in a row" width="1144" height="907" loading="lazy">
    <figcaption>Our electric delivery vans.</figcaption></figure>
  <h2>Our own electric vans</h2>
  <p>Our drivers pick up and deliver ${mdi('{site:service_days}', v)} in our own electric Ford E-Transit vans, across Oakland, Berkeley, San Francisco and much of the East Bay. <a href="/service-map">See the full service area</a>.</p>
  <h2>How we run the business</h2>
  <p>We put employees first, we take part in the communities we serve (<a href="/community">see our community program</a>), and we do our part to reduce our impact on the environment.</p>
  <p>Thank you for trusting us with your laundry.<br><strong>Laura Guevara &amp; David Macquart-Moulin</strong>, founders</p>
  <div class="card">
    <h2>Try us</h2>
    <p>Per bag: ${mdi('{price:Wash & Fold}', v)} plus ${mdi('{fee:Delivery Fee}', v)} delivery, or ${mdi('{plan:price}', v)}/month with a subscription.</p>
    <p>${cta()}</p>
  </div>
</section>`,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'AboutPage', url: ORIGIN + '/about-us',
      mainEntity: {
        '@type': 'DryCleaningOrLaundry', '@id': BIZ_ID, name: 'Family Laundry', url: ORIGIN, telephone: v.site?.phone,
        foundingDate: '2018', founder: [{ '@type': 'Person', name: 'Laura Guevara' }, { '@type': 'Person', name: 'David Macquart-Moulin' }],
        numberOfEmployees: { '@type': 'QuantitativeValue', minValue: 30 },
        image: [img('team.jpg'), img('facility.jpg'), img('vans.jpg')],
        address: { '@type': 'PostalAddress', streetAddress: '2609 Foothill Blvd', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94601', addressCountry: 'US' },
        ...ownRatingLd(v),
      },
    },
  };
}

// ── Our story (blog) ────────────────────────────────────────────────────
// Posts copied from Wix (content/posts.json). Same /post/<slug> URLs, no dates shown.
const POSTS = require('../../content/posts.json');
const postPath = p => `/post/${p.slug}`;

function postBody(blocks) {
  let out = '', list = false;
  for (const b of blocks) {
    if (b.t === 'li') { if (!list) { out += '<ul>'; list = true; } out += `<li>${esc(b.x)}</li>`; continue; }
    if (list) { out += '</ul>'; list = false; }
    if (b.t === 'img') out += `<img src="${esc(b.x)}" alt="" loading="lazy">`;
    else if (/^h[2-4]$/.test(b.t)) out += `<${b.t}>${esc(b.x)}</${b.t}>`;
    else if (b.t === 'blockquote') out += `<blockquote>${esc(b.x)}</blockquote>`;
    else out += `<p>${esc(b.x).replace(/\n/g, '<br>')}</p>`;
  }
  return out + (list ? '</ul>' : '');
}

function blogIndex() {
  return {
    path: '/blog',
    title: 'Our Story | Family Laundry',
    description: 'How an Oakland laundromat became a family-run laundry delivery service, and the people and partners behind it.',
    body: `<section class="wrap section narrow">
  <h1>Our story</h1>
  <p class="lead">How a run-down Oakland laundromat became Family Laundry, and the people and partners behind it.</p>
  <div class="post-list">${POSTS.map(p => `<a href="${esc(postPath(p))}" lang="${p.lang}">
    ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : '<span></span>'}
    <div><h2 style="font-size:24px;margin:0 0 6px">${esc(p.title)}</h2><p class="muted" style="margin:0">${esc(p.description)}</p></div>
  </a>`).join('')}</div>
</section>`,
  };
}

function post(p) {
  return {
    path: postPath(p),
    title: `${p.title} | Family Laundry`,
    description: p.description,
    body: `<article class="wrap section narrow post-body" lang="${p.lang}">
  <p class="muted"><a href="/blog">← Our story</a></p>
  <h1>${esc(p.title)}</h1>
  ${postBody(p.blocks)}
  <p>${cta()}</p>
</article>`,
    jsonld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title, inLanguage: p.lang,
      author: { '@type': 'Organization', name: 'Family Laundry' }, ...(p.image ? { image: 'https://www.familylaundry.com' + p.image } : {}) },
  };
}

// ── Plain text pages from the Wix export ────────────────────────────────
function exported(key, title, description, heading, extra = '') {
  const src = wix[key];
  return {
    path: key, title, description: description || src.description,
    body: `<section class="wrap section narrow prose">
  ${heading ? `<h1>${esc(heading)}</h1>` : ''}
  ${renderBlocks(src.blocks)}
  ${extra}
</section>`,
  };
}

// Rewritten Oct 6 2026 from the old Wix page (frozen in 2019–2020): same facts, dated, past tense.
function community() {
  const pics = ['community-clinic.jpg', 'community-1.jpg', 'community-2.jpg', 'community-3.jpg', 'community-wash-read.jpg', 'community-lot.jpg']
    .map(f => `<img src="/assets/img/${f}" alt="" loading="lazy">`).join('');
  const quotes = [
    ['They offer very good services, especially because they are focused on children and families in general.', 'Graduate of an ESL class held at Family Laundry'],
    ['The people here are loving. It’s family oriented.', 'Customer who lives nearby'],
    ['The people who come here are happy. They like the space for kids.', 'Benita, Family Laundry worker'],
  ];
  const press = [
    ['Want Kids to Learn the Joy of Reading? Barbershops and Laundromats Can Help', 'The New York Times', 'July 2, 2019'],
    ['Want in at the Bay Area’s hottest dance party? You’ll need to bring a baby', 'Los Angeles Times', 'October 16, 2019'],
    ['Oakland laundromat promotes love of reading, offering story-time for children', 'KTVU', 'October 22, 2019'],
    ['Oaklanders Learn Reading at the Laundromat', 'Oakland Magazine', 'November 3, 2019'],
  ];
  return {
    path: '/community',
    title: 'Community | Family Laundry',
    description: 'Family Laundry in the Oakland community: a reading room with Libraries Without Borders, library story time, free English classes and pandemic relief for neighbors.',
    body: `<section class="wrap section narrow prose">
  <h1>Community</h1>
  <p class="lead">Family Laundry started in 2018 as a neighborhood laundromat in Oakland. Here is what we have done with that space, and with our partners, since then.</p>
  <h2>Reading and classes at the laundromat (2018–2020)</h2>
  <ul>
    <li>In 2018 we turned a small store in our building into a free reading room with the nonprofit Libraries Without Borders. Kids read while their parents did laundry.</li>
    <li>Librarians from the Oakland Public Library held story time at the laundromat every Thursday morning.</li>
    <li>Customers asked for English classes, so we hosted free ESL classes in our community room, taught by professional instructors. In a survey of graduates, 83% said they would take a class here again.</li>
    <li>In November 2019 we dedicated the community room to Alma Soraya and Angel Garcia Vasquez.</li>
  </ul>
  <h2>During the pandemic (2020–2021)</h2>
  <p>We closed the community room on March 16, 2020, and put the grant money to new use: 265 free laundry orders for seniors 60 and over, internet hotspots for 44 students at ICS and Garfield Elementary, and supermarket gift cards for 40 families who needed food.</p>
  <p>On April 16, 2021, we turned our parking lot into a vaccination clinic with the Alameda County Public Health Department.</p>
  <h2>What neighbors said</h2>
  ${quotes.map(([q, who]) => `<blockquote>“${esc(q)}”<br><span class="muted">${esc(who)}</span></blockquote>`).join('\n  ')}
  <h2>In the news</h2>
  <ul>${press.map(([t, src, d]) => `<li>“${esc(t)}”, ${esc(src)}, ${esc(d)}</li>`).join('')}</ul>
  <h2>How we run the business</h2>
  <p>We put employees first, we take part in the communities we serve, and we work to reduce our impact on the environment. Thank you to Libraries Without Borders, the Oakland Public Library and Alameda County for working with us.</p>
  <p>Laura, David and the Family Laundry team</p>
  <div class="gallery">${pics}</div>
</section>`,
  };
}

function download(v) {
  const s = v.site || {};
  const stores = [
    s.app_ios_url ? `<a class="btn" href="${esc(s.app_ios_url)}">Download for iPhone</a>` : '',
    s.app_android_url ? `<a class="btn" href="${esc(s.app_android_url)}">Download for Android</a>` : '',
  ].join(' ');
  return {
    path: '/download', title: 'The Family Laundry App', description: 'Schedule pickups, track orders and manage your Family Laundry account in the web app, on your phone or computer.',
    body: `<section class="wrap section narrow center">
  <h1>The Family Laundry app</h1>
  <p class="lead">Schedule pickups, track your order and manage your account at app.familylaundry.com. It runs in the browser on your phone or computer, with nothing to download.</p>
  <p>${stores}</p>
  <p>${cta('Open the app')}</p>
</section>`,
  };
}

// Gift Up checkout (company id = site_info.giftup_site_id, Admin → App Content). The script fills the
// .gift-up-target div; the link underneath is the no-JS fallback to Gift Up's hosted checkout.
function giftUp(s) {
  const id = String(s.giftup_site_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return '';
  return `<div class="gift-up-target" data-site-id="${esc(id)}" data-platform="Other"></div>
  <script>(function (g, i, f, t, u, p, s) { g[u] = g[u] || function () { (g[u].q = g[u].q || []).push(arguments); }; p = i.createElement(f); p.async = 1; p.src = t; s = i.getElementsByTagName(f)[0]; s.parentNode.insertBefore(p, s); })(window, document, 'script', 'https://cdn.giftup.app/dist/gift-up.js', 'giftup');</script>
  <noscript><p><a class="btn" href="https://giftup.app/place-order/${esc(id)}?platform=hosted">Buy a gift card</a></p></noscript>`;
}

function giftCards(v) {
  const s = v.site || {};
  return {
    path: '/gifts-cards', title: 'Gift Cards | Family Laundry', description: 'Give the gift of clean laundry: Family Laundry e-gift cards.',
    body: `<section class="wrap section narrow center">
  <h1>Gift cards</h1>
  <p class="lead">Give the gift of clean, folded laundry.</p>
  <p>The recipient creates a Family Laundry account and enters the gift card code at checkout.</p>
  ${giftUp(s)}
  ${s.email ? `<p class="muted">Questions about a gift card? Email <a href="mailto:${esc(s.email)}?subject=Gift%20card">${esc(s.email)}</a>.</p>` : ''}
</section>`,
  };
}

function optOut() {
  return {
    path: '/opt-out', title: 'Text message opt-out | Family Laundry', description: 'How to opt out of Family Laundry text messages.',
    body: `<section class="wrap section narrow">
  <h1>Text message preferences</h1>
  <p>Customers can opt out of text messages when they create an account (shown below), at any time in the app, or by replying <strong>STOP</strong> to any of our texts. Reply <strong>START</strong> to opt back in, or <strong>HELP</strong> for help.</p>
  <img class="proof" src="/assets/img/opt-out-proof.png" alt="Family Laundry sign-up screen with the 'Opt out of text messages' checkbox" loading="lazy">
</section>`,
  };
}

function thankYou() {
  return {
    path: '/thankyou', title: 'Thank you | Family Laundry', description: 'Thanks for contacting Family Laundry.', noindex: true,
    body: `<section class="wrap section narrow center"><h1>Thank you for contacting us</h1><p>Your message has been sent. Our team will be in touch with you.</p><p><a href="/">Back to home</a></p></section>`,
  };
}

function notFound() {
  return {
    path: '/404', status: 404, noindex: true, title: 'Page not found | Family Laundry', description: '',
    body: `<section class="wrap section narrow center"><h1>Page not found</h1><p>Sorry, we couldn't find that page.</p><p><a class="btn" href="/">Go to the home page</a> <a class="btn btn-ghost" href="/faq">Read the FAQ</a></p></section>`,
  };
}

const ROUTES = {
  '/about-us': about,
  '/blog': blogIndex,
  ...Object.fromEntries(POSTS.map(p => [postPath(p), () => post(p)])),
  ...Object.fromEntries(CITIES.map(c => [cityPath(c), v => city(c, v)])),
  ...Object.fromEntries(TOPICS.map(t => [t.path, v => topic(t, v)])),
  '/laundry-service-cost': cost,
  '/': home,
  '/faq': faq,
  '/laundry-delivery-services': services,
  '/commercial-laundry': commercial,
  '/service-map': serviceMap,
  '/community': community,
  '/privacy-policy': () => exported('/privacy-policy', 'Privacy Policy | Family Laundry', 'How Family Laundry collects, uses and protects your information.', 'Privacy policy'),
  '/terms-conditions': () => exported('/terms-conditions', 'Terms & Conditions | Family Laundry', 'Terms and conditions for Family Laundry services.', 'Terms & conditions'),
  '/download': download,
  '/gifts-cards': giftCards,
  '/opt-out': optOut,
  '/thankyou': thankYou,
};

module.exports = { ROUTES, notFound, DEFAULT_DESC, CITIES, cityPath };
