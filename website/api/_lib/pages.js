// Page builders. Each returns { path, title, description, body, jsonld?, noindex?, status? }.
// Marketing copy comes from the former Wix site; every price is a live token.
const C = require('../../assets/fl-content.js');
const wix = require('../../content/wix-export.json');
const { APP } = require('./layout.js');
const { esc } = C;

// Render a short content string (tokens + light markdown) to HTML.
const md = (text, v) => C.renderContent(text, v).html;
// Inline (no <p>) version for headings / list items.
const mdi = (text, v) => md(text, v).replace(/^<p>|<\/p>$/g, '');

const DEFAULT_DESC = "Wash & fold laundry pickup and delivery for busy Bay Area households. Free & Clear detergents, our own facilities in Oakland, next-day and same-day service.";

function cta(label = 'Schedule a pickup') {
  return `<a class="btn" href="${APP}">${esc(label)}</a>`;
}

// ── Home ────────────────────────────────────────────────────────────────
function home(v) {
  const fee = (v.fee || {});
  const sameDayPerBag = C.money(Number(fee['Delivery Fee'] || 0) + Number(fee['Same-Day Surcharge'] || 0));
  const reviews = [
    ['Kether A, Alameda', 'The way my laundry was returned was so neat and organized that it only took a few minutes to put away. It made me happy, as silly as it seems. The prices seem very fair and the folks were most kind and helpful. You should try it.'],
    ['Chimed D, Oakland', 'Amazing, a godsend, the bomb, so helpful, artistic and beautiful presentation of returned laundry - impressive!!! 5 shining stars!'],
    ['Frisbee G, San Francisco', 'I cannot emphasize enough how quality this experience was in action [...] My items came back clean, neatly folded, and smelling better than when they were new, which is to say delightfully scent free.'],
  ];
  const body = `
<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <h1><span class="kicker">Family Laundry</span>Wash &amp; Fold for Busy Households</h1>
      <p class="lead">We pick up your laundry, wash and fold it in our own Oakland facilities, and bring it back the next day. Serving San Francisco, Oakland and the East Bay.</p>
      <div class="row">${cta('Get started')}<a class="btn btn-ghost" href="#pricing">See pricing</a></div>
      <img class="stamp" src="/assets/img/free-clear-stamp.png" alt="Hypoallergenic, Free &amp; Clear, no nasty stuff" width="150" height="150">
    </div>
    <img class="hero-img" src="/assets/img/hero.jpg" alt="A woman smelling freshly cleaned laundry" width="700" height="624">
  </div>
</section>

<section class="band">
  <div class="wrap split">
    <img src="/assets/img/electric-truck.png" alt="Family Laundry electric delivery truck" width="450" height="348" loading="lazy">
    <div>
      <p class="eyebrow">I'm electric</p>
      <h2>Delivering the freshest laundry in the Bay since ${esc(v.site?.founded || '2019')}.</h2>
      <p>Imagine a service that picks up your dirty laundry, then returns it perfectly washed and folded. Within a day. Like magic. That's Family Laundry.</p>
      <p>We're an Oakland-based family business with more than 30 employees. We operate our own laundering facilities (we never, ever outsource) and our own delivery vehicles. It's 100% Family Laundry, satisfaction guaranteed.</p>
      <p>${cta('Create an account')}</p>
    </div>
  </div>
</section>

<section id="pricing" class="wrap section">
  <h2 class="center">Pricing</h2>
  <div class="cards">
    <article class="card">
      <h3>Per Bag</h3>
      <p class="price">${mdi('{price:Wash & Fold}', v)} <small>+ delivery</small></p>
      <p class="muted">Great for occasional users.</p>
      <ul class="ticks">
        <li>25 lbs wash &amp; fold (about 2–3 loads)*</li>
        <li>Next-day delivery: ${mdi('{fee:Delivery Fee}', v)}</li>
        <li>Same-day delivery: ${esc(sameDayPerBag)}</li>
      </ul>
      <p class="fine">*Bags weighing more than 25 lbs are an extra $3 per lb.</p>
      ${cta('Book a bag')}
    </article>
    <article class="card card-best">
      <p class="badge">Best value</p>
      <h3>Subscribe</h3>
      <p class="price">${mdi('{plan:price}', v)}<small>/month</small></p>
      <p class="muted">For regular laundry.</p>
      <ul class="ticks">
        <li>${mdi('{plan:lbs}', v)} lbs wash &amp; fold*</li>
        <li>Unlimited pickups</li>
        <li>Next-day delivery: FREE</li>
        <li>Same-day delivery: +${mdi('{fee:Same-Day Surcharge}', v)}</li>
        <li>No minimum per order</li>
      </ul>
      <p class="fine">*Usage above ${mdi('{plan:lbs}', v)} lbs per month is ${mdi('{plan:overage}', v)} per lb.</p>
      ${cta('Subscribe')}
    </article>
  </div>
  <p class="center muted">Add-ons: Air Dry ${mdi('{price:Air Dry}', v)} · Shirt service ${mdi('{price:Shirt Service}', v)}/shirt · Vinegar or Oxi ${mdi('{price:Oxi}', v)}/bag · Double wash ${mdi('{price:Double Wash}', v)}/bag</p>
</section>

<section class="band">
  <div class="wrap section">
    <h2 class="center">How we clean</h2>
    <p class="center narrow">We use only hypoallergenic Free &amp; Clear detergents and ozone. No fragrances, no bleach, no softeners, no dry-cleaning solvents, ever. The result is a neutral, clean smell with no detergent residue.</p>
    <div class="steps">
      <div><img src="/assets/img/step-prep.jpg" alt="Laundry basket full of clothes" loading="lazy"><h3>Prep</h3><p>We empty all pockets and separate lights and darks.</p></div>
      <div><img src="/assets/img/step-wash.jpg" alt="Laundry in a washing machine" loading="lazy"><h3>Wash, sanitize, dry</h3><p>Warm water, Free &amp; Clear detergent only, dried on medium.</p></div>
      <div><img src="/assets/img/step-fold.png" alt="A neatly folded shirt" loading="lazy"><h3>Fold</h3><p>We fold neatly, ball socks, and bundle laundry by family member.</p></div>
    </div>
  </div>
</section>

<section class="wrap section split">
  <div>
    <h2>Bubble power</h2>
    <p>Our facilities use ozone water-injection systems that sanitize your laundry (and our machines as they run) while boosting the cleaning power of our detergents.</p>
  </div>
  <img src="/assets/img/bubbles.jpg" alt="Bubbles" loading="lazy">
</section>

<section class="band">
  <div class="wrap section">
    <h2 class="center">What customers say</h2>
    <div class="quotes">${reviews.map(([who, q]) => `<figure><blockquote>“${esc(q)}”</blockquote><figcaption>${esc(who)}</figcaption></figure>`).join('')}</div>
  </div>
</section>

<section id="story" class="wrap section narrow">
  <h2>Our story</h2>
  <p>Our Family Laundry adventure began in early 2018, the day we closed on our first laundromat in Oakland. Our backgrounds didn't make us laundry delivery experts from the get-go, but we got our hands dirty and learned along the way.</p>
  <p>We run Family Laundry the way we think all companies should be run: we put employees first, we actively engage with the communities we operate in, and we do our part to reduce our impact on the environment.</p>
  <p>Thank you for trusting us with your laundry.</p>
  <p class="sig">Laura Guevara &amp; David Macquart-Moulin</p>
</section>

${contactBlock(v)}`;
  return {
    path: '/',
    title: 'Family Laundry | laundry pickup and delivery | San Francisco Bay Area, CA, USA',
    description: "Family Laundry is the Bay Area's #1 best-rated wash and fold delivery service. We process your laundry in our own facilities in Oakland, CA, with Free & Clear detergents only. Serving San Francisco, Oakland and the East Bay, with same-day pickup and delivery in most areas.",
    body,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'LaundryOrDryCleaning', name: 'Family Laundry',
      url: 'https://www.familylaundry.com', telephone: v.site?.phone, email: v.site?.email,
      image: 'https://www.familylaundry.com/assets/img/logo.png',
      address: { '@type': 'PostalAddress', streetAddress: '5215 Genoa St', addressLocality: 'Oakland', addressRegion: 'CA', postalCode: '94608', addressCountry: 'US' },
      areaServed: v.cities || [],
    },
  };
}

function contactBlock(v) {
  const s = v.site || {};
  const tel = s.phone ? s.phone.replace(/[^\d+]/g, '') : '';
  return `<section class="band" id="contact">
  <div class="wrap section contact">
    <div>
      <h2>Contact us</h2>
      <p>Questions? We're happy to help.</p>
      ${s.phone ? `<p><a class="big" href="tel:${esc(tel)}">${esc(s.phone)}</a><br><span class="muted">Leave a message and we'll call you back the same day.</span></p>` : ''}
      ${s.email ? `<p><a class="big" href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>` : ''}
      <p class="muted">Customers can also reply to our last text.</p>
    </div>
    <div class="card">
      <h3>Drop-off location</h3>
      <p><strong>${esc(s.dropoff_address || '')}</strong><br>${esc(s.dropoff_hours || '')}</p>
      <p class="muted">${esc(s.dropoff_cutoff || '')}</p>
      <p>Drop-off wash &amp; fold: ${mdi('{retail:Wash & Fold}', v)}</p>
    </div>
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
function services(v) {
  return {
    path: '/laundry-delivery-services',
    title: 'Family Laundry | Laundry Services for Pickup & Delivery',
    description: wix['/laundry-delivery-services'].description,
    body: `<section class="wrap section">
  <h1>Services</h1>
  <p class="lead">Thank you for trusting us with your laundry.</p>
  <div class="svc">
    <img src="/assets/img/svc-washfold.png" alt="A bag full of clean laundry" loading="lazy">
    <div>
      <h2>Wash &amp; Fold</h2>
      <p>Household laundry: it's what put us on the map, our bread and butter, our raison d'être. "Wash &amp; Fold" doesn't quite do the service justice, but you get the point. We just want to do your laundry.</p>
      <p class="price">${mdi('{price:Wash & Fold}', v)} <small>per bag (up to 25 lbs) + ${mdi('{fee:Delivery Fee}', v)} delivery</small></p>
      <p>Or subscribe: ${mdi('{plan:lbs}', v)} lbs a month for ${mdi('{plan:price}', v)}, delivery included. <a href="/#pricing">Compare plans</a></p>
    </div>
  </div>
  <div class="svc">
    <img src="/assets/img/svc-delicates.png" alt="Mesh delicates bag" loading="lazy">
    <div>
      <h2>Air Dry (for delicates)</h2>
      <p>Undergarments, lingerie, workout gear… some items need a little extra care. Put them in a separate bag and choose Air Dry when you book.</p>
      <p class="price">+${mdi('{price:Air Dry}', v)} <small>per delicates bag</small></p>
    </div>
  </div>
  <div class="svc">
    <img src="/assets/img/svc-shirt.png" alt="A hand-steamed blue shirt" loading="lazy">
    <div>
      <h2>Shirt service (blouses too!)</h2>
      <p>For that sharp, professional touch: your shirts are laundered, hand-steamed and delivered on hangers.</p>
      <p class="price">+${mdi('{price:Shirt Service}', v)} <small>per shirt</small></p>
    </div>
  </div>
  <div class="svc svc-plain">
    <div>
      <h2>Extras</h2>
      <ul class="ticks">
        <li>Vinegar rinse: ${mdi('{price:Vinegar}', v)} per bag</li>
        <li>Oxi (bleach alternative): ${mdi('{price:Oxi}', v)} per bag</li>
        <li>Double wash: ${mdi('{price:Double Wash}', v)} per bag</li>
        <li>Same-day delivery: +${mdi('{fee:Same-Day Surcharge}', v)}</li>
      </ul>
    </div>
  </div>
  <p class="center">${cta()}</p>
</section>`,
  };
}

// ── Commercial ──────────────────────────────────────────────────────────
function commercial(v) {
  const s = v.site || {};
  const subject = encodeURIComponent('Commercial laundry quote');
  const bodyTxt = encodeURIComponent('Business name:\nType of business:\nAddress:\nApproximate laundry volume (lbs or bags per week):\nPickup days/times:\nContact name and phone:\n');
  return {
    path: '/services-4',
    title: 'Commercial Laundry Service | Family Laundry',
    description: 'Commercial laundry pickup and delivery for Bay Area businesses: Airbnb hosts, hotels, gyms, salons, offices and schools. Custom plans for your volume and schedule.',
    body: `<section class="wrap section narrow">
  <h1>Commercial laundry</h1>
  <p class="lead">Known as the Bay's favorite residential laundry service, Family Laundry is also a trusted partner for dozens of Bay Area businesses.</p>
  <p>From gyms and hotels to corporate offices and schools, nearly every business generates laundry, and we're here to handle it. We'll build a custom plan that fits your volume, schedule and needs, so you can focus on running your business.</p>
  <p class="price">Commercial pricing starts at ${mdi('{commercial:Wash & Fold}', v)}</p>
  <div class="logos">${[1, 2, 3, 4, 5, 6].map(n => `<img src="/assets/img/client-${n}.${[3, 4].includes(n) ? 'jpg' : 'png'}" alt="" loading="lazy">`).join('')}</div>
  <div class="card">
    <h2>Get a quote</h2>
    <p>Tell us about your laundry needs (the more details the better). We'll be in touch within 24 hours.</p>
    ${s.email ? `<p><a class="btn" href="mailto:${esc(s.email)}?subject=${subject}&amp;body=${bodyTxt}">Email us for a quote</a></p>` : ''}
    ${s.phone ? `<p class="muted">Or call ${esc(s.phone)}.</p>` : ''}
  </div>
</section>`,
  };
}

// ── Service area ────────────────────────────────────────────────────────
function serviceMap(v) {
  return {
    path: '/service-map',
    title: 'Laundry Delivery Area | Family Laundry',
    description: `Family Laundry picks up and delivers in ${C.list(v.cities || [])}.`,
    body: `<section class="wrap section">
  <h1>Service area</h1>
  <p class="lead">Family Laundry is headquartered in Oakland and serves most of the East Bay and San Francisco.</p>
  <p>We currently serve <strong>${esc(C.list(v.cities || []))}</strong>. Not sure about your street? Enter your address in the app and we'll tell you right away.</p>
  <p>${cta('Check my address')}</p>
  <img class="map" src="/assets/img/delivery-map.png" alt="Map of the Family Laundry delivery area" loading="lazy">
</section>`,
  };
}

// ── City pages ──────────────────────────────────────────────────────────
function city(key, v) {
  const src = wix[key];
  const DROP = /^(Pickup\/Delivery (days|windows)|Turnaround:|Same-day service available|Ready to Experience)/i;
  const blocks = src.blocks.filter(b => !DROP.test(b.x));
  const names = { '/laundry-delivery-oakland': 'Oakland', '/laundry-delivery-berkeley': 'Berkeley', '/laundry-delivery-alameda': 'Alameda', '/laundry-delivery-sf': 'San Francisco' };
  const name = names[key];
  return {
    path: key,
    title: src.title,
    description: src.description.replace(/,? ?7 days a week\.?/i, '.').replace(/\.\./g, '.'),
    body: `<section class="wrap section narrow">
  <h1>Laundry delivery in ${esc(name)}</h1>
  ${renderBlocks(blocks, { skipFirstIfTitle: true })}
  <div class="card">
    <h2>How it works in ${esc(name)}</h2>
    <ul class="ticks">
      <li>Pick a pickup window in the app: morning, midday or evening, depending on your neighborhood.</li>
      <li>Leave your bag at your door. No need to be home.</li>
      <li>Get it back washed and folded, usually the next day. Same-day is available in most areas for +${mdi('{fee:Same-Day Surcharge}', v)}.</li>
      <li>${mdi('{price:Wash & Fold}', v)} per bag + ${mdi('{fee:Delivery Fee}', v)} delivery, or ${mdi('{plan:price}', v)}/month with a subscription.</li>
    </ul>
    <p>${cta()}</p>
  </div>
</section>`,
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

function community() {
  const pics = ['community-clinic.jpg', 'community-1.jpg', 'community-2.jpg', 'community-3.jpg', 'community-wash-read.jpg', 'community-lot.jpg']
    .map(f => `<img src="/assets/img/${f}" alt="" loading="lazy">`).join('');
  const p = exported('/community', 'Family Laundry - Community Program', null, 'Community', `<div class="gallery">${pics}</div>`);
  return p;
}

function download(v) {
  const s = v.site || {};
  const stores = [
    s.app_ios_url ? `<a class="btn" href="${esc(s.app_ios_url)}">Download for iPhone</a>` : '',
    s.app_android_url ? `<a class="btn" href="${esc(s.app_android_url)}">Download for Android</a>` : '',
  ].join(' ');
  return {
    path: '/download', title: 'Download the Family Laundry App', description: 'Schedule pickups, track orders and manage your Family Laundry account.',
    body: `<section class="wrap section narrow center">
  <h1>Get the Family Laundry app</h1>
  <p class="lead">Schedule pickups, track your order and manage your account.</p>
  <p>${stores}</p>
  <p>${cta('Use it on the web')}</p>
</section>`,
  };
}

function giftCards(v) {
  const s = v.site || {};
  return {
    path: '/gifts-cards', title: 'Gift Cards | Family Laundry', description: 'Give the gift of clean laundry: Family Laundry e-gift cards.',
    body: `<section class="wrap section narrow center">
  <h1>Gift cards</h1>
  <p class="lead">Give the gift of clean, folded laundry.</p>
  <p>The recipient creates a Family Laundry account and enters the gift card code at checkout.</p>
  <!-- TODO(launch): embed the Gift Up checkout widget here (company id from the Gift Up dashboard). -->
  ${s.email ? `<p>To buy a gift card now, email <a href="mailto:${esc(s.email)}?subject=Gift%20card">${esc(s.email)}</a>.</p>` : ''}
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
  '/': home,
  '/faq': faq,
  '/laundry-delivery-services': services,
  '/services-4': commercial,
  '/service-map': serviceMap,
  '/laundry-delivery-oakland': v => city('/laundry-delivery-oakland', v),
  '/laundry-delivery-berkeley': v => city('/laundry-delivery-berkeley', v),
  '/laundry-delivery-alameda': v => city('/laundry-delivery-alameda', v),
  '/laundry-delivery-sf': v => city('/laundry-delivery-sf', v),
  '/community': community,
  '/privacy-policy': () => exported('/privacy-policy', 'Privacy Policy | Family Laundry', 'How Family Laundry collects, uses and protects your information.', 'Privacy policy'),
  '/terms-conditions': () => exported('/terms-conditions', 'Terms & Conditions | Family Laundry', 'Terms and conditions for Family Laundry services.', 'Terms & conditions'),
  '/download': download,
  '/gifts-cards': giftCards,
  '/opt-out': optOut,
  '/thankyou': thankYou,
};

module.exports = { ROUTES, notFound, DEFAULT_DESC };
