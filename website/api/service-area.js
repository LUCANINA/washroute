// GET /api/service-area — the served ZIPs and cities as JSON, for Maya (the phone assistant) (Oct 13, 2026).
// One list everywhere: Maya reads THIS, the homepage ZIP check reads the same content/service-zips.js and
// content/cities.js, so the phone and the website can't disagree. Pickup windows are NOT here: Maya reads them
// live from site_public_values().zones using the zone name each entry resolves to.
//   zips[zip]   = { city, label?, zone, partial?, mixed? }  zone = the zone it books into when that is NOT simply the
//                                                            zone listing its city (null = look the city up in the zones)
//   cities[name]= { zone, partial?, varies? }                partial = every ZIP is partial (only some streets)
//                                                            varies  = pickup windows differ by neighborhood
const ZIPS = require('../content/service-zips.js');
const CITIES = require('../content/cities.js');
const DETAILS = require('../content/city-details.js');

function build() {
  const cities = {};
  for (const c of CITIES) cities[c.name] = { zone: c.zone || null, ...(DETAILS[c.slug]?.windows === false ? { varies: true } : {}) };
  const zips = {}, perCity = {};
  for (const [zip, raw] of Object.entries(ZIPS)) {
    const e = typeof raw === 'string' ? { city: raw } : raw;
    if (!cities[e.city]) cities[e.city] = { zone: null };
    zips[zip] = { city: e.city, ...(e.label ? { label: e.label } : {}), zone: e.zone || cities[e.city].zone,
      ...(e.partial ? { partial: true } : {}), ...(e.mixed ? { mixed: true } : {}) };
    (perCity[e.city] ||= []).push(e);
  }
  for (const [name, list] of Object.entries(perCity)) {
    if (list.every(e => e.partial)) cities[name].partial = true;
    if (list.some(e => e.mixed || e.zone)) cities[name].varies = true; // e.zone = this ZIP books into another zone
  }
  return { zips, cities };
}

const DATA = build();

module.exports = (req, res) => {
  res.statusCode = req.method === 'GET' ? 200 : 405;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  res.end(JSON.stringify(req.method === 'GET' ? DATA : { error: 'Use GET.' }));
};
module.exports.build = build;
