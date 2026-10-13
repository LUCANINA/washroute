// Named service-zips.js, NOT zips.js: the repo .gitignore pattern `zi[A-Za-z0-9]*` silently ignored zips.js, so it
// never reached Vercel and every page crashed (500) on Oct 13, 2026.
// "Do we serve your area?" ZIP check on the homepage (Oct 12, 2026).
// ZIP → the city page it belongs to (name must match content/cities.js). Built from the ZIPs of WashRoute customer
// addresses in served cities (query run Oct 12, 2026). Pickup windows are NOT typed here: the homepage looks them
// up live from the city's zone.
// partial: true = only some streets are inside a zone, so the visitor is sent to the app to check the address.
// label = what the visitor sees when a ZIP spans two cities.
// To add a ZIP when you open a new area: add one line here.
module.exports = {
  // San Francisco
  94102: 'San Francisco', 94103: 'San Francisco', 94104: 'San Francisco', 94105: 'San Francisco', 94107: 'San Francisco',
  94108: 'San Francisco', 94109: 'San Francisco', 94110: 'San Francisco', 94111: 'San Francisco', 94112: 'San Francisco',
  94114: 'San Francisco', 94115: 'San Francisco', 94116: 'San Francisco', 94117: 'San Francisco', 94118: 'San Francisco',
  94121: 'San Francisco', 94122: 'San Francisco', 94123: 'San Francisco', 94124: 'San Francisco', 94127: 'San Francisco',
  94129: 'San Francisco', 94131: 'San Francisco', 94132: 'San Francisco', 94133: 'San Francisco', 94134: 'San Francisco',
  94158: 'San Francisco',
  // Oakland, Piedmont, Emeryville
  94601: 'Oakland', 94602: 'Oakland', 94603: 'Oakland', 94605: 'Oakland', 94606: 'Oakland', 94607: 'Oakland',
  94608: { city: 'Oakland', label: 'Oakland & Emeryville' }, 94609: 'Oakland', 94610: { city: 'Oakland', label: 'Oakland & Piedmont' },
  94611: { city: 'Oakland', label: 'Oakland & Piedmont' }, 94612: 'Oakland', 94613: 'Oakland', 94618: 'Oakland', 94619: 'Oakland',
  94621: 'Oakland',
  // Berkeley zone
  94702: 'Berkeley', 94703: 'Berkeley', 94704: 'Berkeley', 94705: 'Berkeley', 94706: 'Albany', 94707: { city: 'Berkeley', label: 'Berkeley, Albany & Kensington' },
  94708: { city: 'Berkeley', label: 'Berkeley & Kensington' }, 94709: 'Berkeley', 94710: 'Berkeley', 94720: 'Berkeley',
  94530: 'El Cerrito',
  94801: { city: 'Richmond', partial: true }, 94804: { city: 'Richmond', partial: true }, 94805: { city: 'Richmond', partial: true },
  // Alameda
  94501: 'Alameda', 94502: 'Alameda',
  // Hayward zone
  94577: 'San Leandro', 94578: 'San Leandro', 94579: 'San Leandro', 94580: 'San Lorenzo',
  94541: 'Hayward', 94542: 'Hayward', 94544: 'Hayward', 94545: 'Hayward', 94546: 'Castro Valley', 94552: 'Castro Valley',
  94536: 'Fremont', 94538: 'Fremont', 94539: 'Fremont', 94555: 'Fremont', 94560: 'Newark', 94587: 'Union City',
  // Concord zone (Contra Costa)
  94518: 'Concord', 94519: 'Concord', 94520: 'Concord', 94521: 'Concord', 94523: 'Pleasant Hill', 94549: 'Lafayette',
  94553: 'Martinez', 94556: 'Moraga', 94563: 'Orinda', 94595: 'Walnut Creek', 94596: 'Walnut Creek', 94597: 'Walnut Creek',
  94598: 'Walnut Creek',
};
