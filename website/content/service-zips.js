// Named service-zips.js, NOT zips.js: the repo .gitignore pattern `zi[A-Za-z0-9]*` silently ignored zips.js, so it
// never reached Vercel and every page crashed (500) on Oct 13, 2026.
// "Do we serve your area?" ZIP check on the homepage (Oct 12, 2026).
// ZIP → the city page it belongs to (name must match content/cities.js). EVERY ZIP of every served city, including
// P.O. box, campus and unique ZIPs (Oct 13, 2026: the first list came only from customer addresses and missed
// Hayward 94540/94543/94557, so real Hayward visitors were told "not yet"). Pickup windows are NOT typed here: the homepage looks them
// up live from the city's zone.
// partial: true = only some streets are inside a zone, so the visitor is sent to the app to check the address.
// zone: 'X'   = this ZIP books into zone X, not its city's zone (pickup windows come from X). Checked Oct 13, 2026 by
//               running every customer address through get_zone_for_point (the booking rule).
// mixed: true = streets in this ZIP book into zones with different windows, so no windows are shown.
// label = what the visitor sees when a ZIP spans two cities.
// To add a ZIP when you open a new area: add one line here.
// Maya (the phone assistant) reads this same list through /api/service-area (api/service-area.js) — keep that file.
module.exports = {
  // San Francisco (whole city is bookable by city name)
  94102: 'San Francisco', 94103: 'San Francisco', 94104: 'San Francisco', 94105: 'San Francisco', 94107: 'San Francisco',
  94108: 'San Francisco', 94109: 'San Francisco', 94110: 'San Francisco', 94111: 'San Francisco', 94112: 'San Francisco',
  94114: 'San Francisco', 94115: 'San Francisco', 94116: 'San Francisco', 94117: 'San Francisco', 94118: 'San Francisco',
  94119: 'San Francisco', 94120: 'San Francisco', 94121: 'San Francisco', 94122: 'San Francisco', 94123: 'San Francisco',
  94124: 'San Francisco', 94125: 'San Francisco', 94126: 'San Francisco', 94127: 'San Francisco', 94129: 'San Francisco',
  94130: 'San Francisco', 94131: 'San Francisco', 94132: 'San Francisco', 94133: 'San Francisco', 94134: 'San Francisco',
  94137: 'San Francisco', 94139: 'San Francisco', 94140: 'San Francisco', 94141: 'San Francisco', 94142: 'San Francisco',
  94143: 'San Francisco', 94144: 'San Francisco', 94145: 'San Francisco', 94146: 'San Francisco', 94147: 'San Francisco',
  94151: 'San Francisco', 94158: 'San Francisco', 94159: 'San Francisco', 94160: 'San Francisco', 94161: 'San Francisco',
  94163: 'San Francisco', 94164: 'San Francisco', 94172: 'San Francisco', 94177: 'San Francisco', 94188: 'San Francisco',
  // Oakland, Piedmont, Emeryville
  94601: { city: 'Oakland', mixed: true }, 94602: { city: 'Oakland', mixed: true }, 94603: { city: 'Oakland', zone: 'Hayward' }, 94604: 'Oakland', 94605: { city: 'Oakland', zone: 'Hayward' }, 94606: 'Oakland', 94607: 'Oakland',
  94608: { city: 'Oakland', label: 'Oakland & Emeryville' }, 94609: 'Oakland', 94610: { city: 'Oakland', label: 'Oakland & Piedmont' },
  94611: { city: 'Oakland', label: 'Oakland & Piedmont' }, 94612: 'Oakland', 94613: { city: 'Oakland', zone: 'Hayward' }, 94614: { city: 'Oakland', zone: 'Hayward' }, 94615: 'Oakland',
  94617: 'Oakland', 94618: { city: 'Oakland', label: 'Oakland & Piedmont' }, 94619: { city: 'Oakland', zone: 'Hayward' }, 94620: 'Piedmont', 94621: { city: 'Oakland', zone: 'Hayward' },
  94622: 'Oakland', 94623: 'Oakland', 94624: 'Oakland', 94649: 'Oakland', 94659: 'Oakland', 94660: 'Oakland', 94661: 'Oakland',
  94662: 'Emeryville', 94666: 'Oakland',
  // Berkeley zone
  94701: 'Berkeley', 94702: 'Berkeley', 94703: 'Berkeley', 94704: 'Berkeley', 94705: 'Berkeley', 94706: 'Albany',
  94707: { city: 'Berkeley', label: 'Berkeley, Albany & Kensington' }, 94708: { city: 'Berkeley', label: 'Berkeley & Kensington' },
  94709: 'Berkeley', 94710: 'Berkeley', 94712: 'Berkeley', 94720: 'Berkeley',
  94530: 'El Cerrito',
  // Daly City: only the north edge (94014) is inside the San Francisco zone
  94014: { city: 'Daly City', partial: true },
  // Richmond: only some streets are inside a zone, so the app checks the address
  94801: { city: 'Richmond', partial: true }, 94802: { city: 'Richmond', partial: true }, 94804: { city: 'Richmond', partial: true },
  94805: { city: 'Richmond', partial: true }, 94806: { city: 'Richmond', partial: true }, 94807: { city: 'Richmond', partial: true },
  94808: { city: 'Richmond', partial: true }, 94850: { city: 'Richmond', partial: true },
  // Alameda
  94501: 'Alameda', 94502: 'Alameda',
  // Hayward zone
  94577: 'San Leandro', 94578: 'San Leandro', 94579: 'San Leandro', 94580: 'San Lorenzo',
  94540: 'Hayward', 94541: 'Hayward', 94542: 'Hayward', 94543: 'Hayward', 94544: 'Hayward', 94545: 'Hayward', 94557: 'Hayward',
  94546: { city: 'Castro Valley', label: 'Castro Valley & Hayward' }, 94552: 'Castro Valley',
  94536: 'Fremont', 94537: 'Fremont', 94538: 'Fremont', 94539: 'Fremont', 94555: 'Fremont', 94560: 'Newark', 94587: 'Union City',
  // Concord zone (Contra Costa)
  94518: 'Concord', 94519: 'Concord', 94520: 'Concord', 94521: 'Concord', 94522: 'Concord', 94524: 'Concord', 94527: 'Concord',
  94529: 'Concord', 94523: 'Pleasant Hill', 94549: 'Lafayette', 94553: 'Martinez', 94556: 'Moraga', 94570: 'Moraga', 94575: 'Moraga',
  94563: 'Orinda', 94595: 'Walnut Creek', 94596: 'Walnut Creek', 94597: 'Walnut Creek', 94598: 'Walnut Creek',
};
