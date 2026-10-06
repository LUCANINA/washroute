// Extra local content for the city pages that are open to Google (index: true in cities.js).
// Keyed by city slug. Every fact here is ours: neighborhoods come from where WashRoute customers actually
// live (delivered orders, Oct 2025 – Oct 2026, grouped by ZIP); household counts are rounded down from the
// same data. Reviews are real Google/site reviews, quoted with first name + initial (David OK'd, Oct 5 2026).
// Answers may use live tokens ({site:dropoff_address}, {retail:Wash & Fold} …) — never type a price or a time.
module.exports = {
  oakland: {
    households: 'more than 600',
    photo: 'porch-bag-1.jpg',
    about: [
      "Our laundry facilities are on Foothill Boulevard in East Oakland, so Oakland laundry never crosses a bridge. It is washed by our own team, a few miles from your door.",
      "Oakland is our biggest city. Most of our Oakland customers live around Lake Merritt, Grand Lake, Rockridge, Temescal and Glenview, but our vans cover the whole city, from West Oakland to the hills.",
    ],
    hoods: ['Grand Lake', 'Lakeshore', 'Adams Point', 'Crocker Highlands', 'Trestle Glen', 'Piedmont Avenue', 'Rockridge', 'Temescal', 'Longfellow', 'Montclair', 'Glenview', 'Dimond', 'Oakmore', 'Redwood Heights', 'Laurel', 'Millsmont', 'Clinton', 'San Antonio', 'Eastlake', 'Fruitvale', 'Jingletown', 'Uptown', 'Downtown', 'Lake Merritt', 'Jack London Square', 'West Oakland'],
    review: { who: 'Chimed D, Oakland', text: 'Amazing, a godsend, the bomb, so helpful, artistic and beautiful presentation of returned laundry - impressive!!! 5 shining stars!' },
    faqs: [
      ['Can I drop my laundry off myself in Oakland?', 'Yes. Our drop-off counter is at {site:dropoff_address}, open {site:dropoff_hours}. Drop-off wash & fold is {retail:Wash & Fold}.'],
      ['Do you pick up in the Oakland hills?', 'Yes. We serve Montclair, Crocker Highlands, Oakmore, Redwood Heights and the rest of the hills. Leave your bag wherever is easiest and note it in the app.'],
      ['Do you work with Oakland schools, daycares and businesses?', 'Yes. Schools, daycares, gyms, clinics and offices across Oakland use our commercial service, with pickups on a schedule that fits them.'],
    ],
  },
  berkeley: {
    households: 'more than 150',
    photo: 'porch-bag-2.jpg',
    about: [
      "Berkeley is our second-busiest city. Customers stretch from the Elmwood and Claremont up into the hills and down to West Berkeley, with a lot of students, faculty and staff around campus.",
      "Your laundry is washed in our own facility in East Oakland, about 20 minutes away, and comes back folded and bundled by family member.",
    ],
    hoods: ['Elmwood', 'Claremont', 'Southside', 'Downtown Berkeley', 'Northside', 'North Berkeley', 'the Gourmet Ghetto', 'Thousand Oaks', 'the Berkeley Hills', 'South Berkeley', 'Lorin', 'Le Conte', 'West Berkeley', 'the UC Berkeley campus area'],
    review: { who: "Kimberly R, Berkeley", text: "Their customer service is supreme! They are extremely attentive and helpful! And it is such a joy to have fresh, beautifully cared for laundry without it being perfumed." },
    faqs: [
      ['Do you pick up from student apartments near UC Berkeley?', 'Yes. Leave your bag with the front desk or wherever your building allows, and add the details in the app so the driver knows where to look.'],
      ['Do you serve the Berkeley Hills?', 'Yes, including Thousand Oaks and the streets above Euclid. Steep stairs? Leave the bag at the curb or wherever is easiest.'],
      ['Is the price the same in Berkeley?', 'Yes. Every city we serve pays the same price, with no extra fee for Berkeley.'],
    ],
  },
  alameda: {
    households: 'more than 100',
    photo: 'porch-bag-1.jpg',
    about: [
      "Alameda is right across the Fruitvale Bridge from our East Oakland facility, so it is one of the quickest trips our vans make.",
      "We serve the whole island, from the East End to the West End, plus Bay Farm Island and Harbor Bay.",
    ],
    hoods: ['the East End', 'the West End', 'Park Street', 'Webster Street', 'Fernside', 'the Gold Coast', 'Alameda Point', 'Bay Farm Island', 'Harbor Bay'],
    review: { who: 'Kether A, Alameda', text: 'The way my laundry was returned was so neat and organized that it only took a few minutes to put away. It made me happy, as silly as it seems.' },
    faqs: [
      ['Do you serve Bay Farm Island?', 'Yes. Bay Farm Island and Harbor Bay are part of our regular Alameda routes.'],
      ['Can I leave my bag on the porch?', 'Yes. Most Alameda customers leave the bag on the porch or by the door, and we bring it back to the same spot.'],
    ],
  },
  'san-leandro': {
    photo: 'porch-bag-2.jpg',
    about: [
      "San Leandro is just down Foothill Boulevard from our facility, one of the closest cities we serve.",
      "Customers here are spread across Downtown, Estudillo Estates, Broadmoor and Washington Manor, and we pick up across the whole city.",
    ],
    hoods: ['Downtown San Leandro', 'Estudillo Estates', 'Broadmoor', 'Bancroft', 'Bay-O-Vista', 'Floresta', 'Washington Manor', 'Mulford Gardens', 'the Marina'],
    review: { who: "Joyce P, San Leandro", text: "I would recommend Family Laundry in a heartbeat. They provide outstanding service, respond promptly to your questions always polite." },
    faqs: [
      ['Do you serve all of San Leandro?', 'Yes, from the hills to the Marina. Enter your address in the app to see your pickup windows.'],
      ['Can I drop off instead of booking a pickup?', 'Yes. Our drop-off counter at {site:dropoff_address} is a short drive up Foothill Boulevard, open {site:dropoff_hours}.'],
    ],
  },
  emeryville: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Emeryville is mostly apartments, condos and lofts, so most pickups here happen at a front desk, package room or lobby.",
      "Emeryville is on our Oakland routes, so it gets the same pickup windows as Oakland.",
    ],
    hoods: ['the Watergate', 'Bay Street', 'the Park Avenue district', 'the Triangle neighborhood', 'Emery Station'],
    review: { who: "Loren L, Emeryville", text: "So prompt with pick up and delivery. My clothes are fresh and clean without fragrances [...] and the clothes come bundled and tied with string." },
    faqs: [
      ['Can you pick up from my apartment building?', 'Yes. Leave the bag with the front desk or in the spot your building allows, and add instructions in the app.'],
      ['Do you serve Emeryville offices and gyms?', 'Yes. Our commercial service handles towels, uniforms and linens for Emeryville businesses on a regular schedule.'],
    ],
  },
  piedmont: {
    photo: 'porch-bag-2.jpg',
    about: [
      "Piedmont sits in the middle of our Oakland routes, so it gets the same pickup windows and the same next-day turnaround.",
      "For busy families, a subscription makes sense: one monthly price for all the laundry a household makes.",
    ],
    hoods: ['Lower Piedmont', 'Upper Piedmont', 'around Piedmont Park', 'the Grand Avenue border', 'the Moraga Avenue corridor'],
    faqs: [
      ['Is there a plan for big family loads?', 'Yes. The subscription is {plan:price} a month for {plan:lbs} lbs, with unlimited pickups and free next-day delivery.'],
      ['Do you sort by family member?', 'Yes. Every load is folded and bundled by family member, so putting it away takes minutes.'],
    ],
  },
  albany: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Albany shares our Berkeley routes, so it gets the same pickup windows as Berkeley.",
      "We pick up from houses around Solano Avenue and Albany Hill as well as the apartments at University Village.",
    ],
    hoods: ['Solano Avenue', 'Albany Hill', 'University Village', 'the Cornell and Pierce Street area', 'the Thousand Oaks border'],
    faqs: [
      ['Do you pick up at University Village?', 'Yes. Leave your bag at your door or wherever your building allows, and add details in the app.'],
    ],
  },
  sf: {
    households: 'more than 100',
    photo: 'porch-bag-2.jpg',
    about: [
      "We have served San Francisco since 2022, when we acquired Sudzee, the city's laundry delivery pioneer founded in 2011.",
      "San Francisco pickups and deliveries run in the evening. Your laundry crosses the Bay Bridge to our own facility in East Oakland, is washed by our team and comes back folded.",
      "Our San Francisco customers are spread across the city, with the most in the Mission and Bernal Heights, Nob Hill and Russian Hill, Pacific Heights and Japantown, and the Inner Richmond.",
    ],
    hoods: ['the Mission', 'Bernal Heights', 'Nob Hill', 'Russian Hill', 'Polk Gulch', 'Pacific Heights', 'Japantown', 'Lower Pacific Heights', 'the Western Addition', 'Laurel Heights', 'the Inner Richmond', 'the Outer Richmond', 'Hayes Valley', 'Civic Center', 'SoMa', 'Rincon Hill', 'the Financial District', 'Haight-Ashbury', 'Cole Valley', 'NoPa', 'the Marina', 'Cow Hollow', 'the Inner Sunset', 'the Outer Sunset', 'Parkside', 'Glen Park', 'Noe Valley', 'the Castro', 'Twin Peaks', 'West Portal', 'Potrero Hill', 'Dogpatch', 'Mission Bay', 'North Beach', 'Chinatown', 'Union Square', 'the Presidio', 'the Excelsior', 'Visitacion Valley', 'Lake Merced', 'Treasure Island'],
    review: { who: 'Frisbee G, San Francisco', text: 'My items came back clean, neatly folded, and smelling better than when they were new, which is to say delightfully scent free.' },
    faqs: [
      ['Why are San Francisco pickups in the evening?', 'San Francisco is served on our evening routes. Pick your window in the app; you get a text when the driver is on the way.'],
      ['I was a Sudzee customer. Can I keep using my bag?', 'Yes. Keep using your Sudzee bag; we know it well.'],
      ['Do you pick up from apartment buildings with a doorman or lobby?', 'Yes. Leave the bag with the doorman or front desk, or in your lobby if the building allows, and add instructions in the app.'],
    ],
  },
  // Opened Oct 6, 2026 (Hayward, Castro Valley, El Cerrito). Neighborhood mix from delivered orders by ZIP,
  // Oct 2025 – Oct 2026. Customer counts are too small to show (left out on purpose).
  hayward: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Hayward is on our south routes, which also cover San Leandro, San Lorenzo, Castro Valley, Union City, Fremont and Newark. Your laundry is washed by our own team in East Oakland and comes back folded and bundled by family member.",
      "Most of our Hayward customers live in north Hayward and around downtown, but we pick up across the city, from the Hayward Hills and Cal State East Bay down to Tennyson-Alquire and West Hayward.",
    ],
    hoods: ['Downtown Hayward', 'Upper B Street', 'Prospect Hill', 'Burbank', 'the Hayward Hills', 'Hayward Highlands', 'the Cal State East Bay area', 'Fairway Park', 'Harder-Tennyson', 'Tennyson-Alquire', 'Mount Eden', 'Southgate', 'West Hayward'],
    review: { who: "Nicole B, Hayward", text: "They are very communicative about delivery pick-up's & drop off's, and they bring your clothes back to you folded nicely with a personal touch." },
    faqs: [
      ['Do you pick up near Cal State East Bay?', 'Yes. The Hayward Hills get the same pickup windows as the rest of Hayward. Leave your bag wherever your building allows and add the details in the app.'],
      ['Can I drop my laundry off instead?', 'Yes. Our drop-off counter is at {site:dropoff_address}, a short drive up I-580, open {site:dropoff_hours}.'],
      ['Is the price the same in Hayward?', 'Yes. Every city we serve pays the same price, with no extra fee for Hayward.'],
    ],
  },
  'castro-valley': {
    photo: 'porch-bag-2.jpg',
    about: [
      "Castro Valley is on our south routes, a quick trip out I-580 from our facility in East Oakland.",
      "Most of our Castro Valley customers live up in Five Canyons and the Palomares Hills, east of I-580. The rest are around Castro Valley Boulevard and the center of town, and we pick up everywhere in between.",
    ],
    hoods: ['Five Canyons', 'the Palomares Hills', 'Jensen Ranch', 'Columbia', 'Crow Canyon', 'the Lake Chabot area', 'Castro Valley Boulevard', 'Downtown Castro Valley'],
    faqs: [
      ['Do you pick up in Five Canyons and the Palomares Hills?', 'Yes. Leave your bag at the door, on the porch or wherever is easiest up the driveway, and note it in the app.'],
      ['Is there a plan for big family loads?', 'Yes. The subscription is {plan:price} a month for {plan:lbs} lbs, with unlimited pickups and free next-day delivery.'],
      ['Can I drop my laundry off instead?', 'Yes. Our drop-off counter is at {site:dropoff_address}, open {site:dropoff_hours}.'],
    ],
  },
  'el-cerrito': {
    photo: 'porch-bag-1.jpg',
    about: [
      "El Cerrito shares our Berkeley routes, so it gets the same pickup windows as Berkeley, Albany and Kensington.",
      "Houses up in the hills or apartments near El Cerrito Plaza and El Cerrito del Norte: leave the bag at the door, the curb or the front desk. Everything is washed by our own team in East Oakland and comes back folded.",
    ],
    hoods: ['the El Cerrito Hills', 'Mira Vista', 'Arlington Park', 'Fairmont', 'the San Pablo Avenue corridor', 'El Cerrito Plaza', 'El Cerrito del Norte'],
    faqs: [
      ['Do you pick up in the El Cerrito Hills?', 'Yes. Steep street or long stairs? Leave the bag at the curb or wherever is easiest, and tell us in the app.'],
      ['Do you pick up from apartments near the BART stations?', 'Yes. Leave your bag with the front desk or wherever your building allows, and add the details in the app.'],
      ['Is the price the same in El Cerrito?', 'Yes. Every city we serve pays the same price, with no extra fee for El Cerrito.'],
    ],
  },
  // Opened Oct 6, 2026 (San Lorenzo, Fremont, Newark). Same rules: neighborhoods from delivered orders by ZIP
  // (Fremont: 94536, 94538, 94539, 94555), counts too small to show.
  'san-lorenzo': {
    photo: 'porch-bag-2.jpg',
    about: [
      "San Lorenzo is on our south routes, right between San Leandro and Hayward, a short drive down I-880 from our facility in East Oakland.",
      "Leave the bag on the porch or by the front door. It is washed by our own team, never handed to a third party, and comes back folded and bundled by family member.",
    ],
    hoods: ['San Lorenzo Village', 'Ashland', 'Hesperian Boulevard', 'Lewelling Boulevard', 'the Grant Avenue area'],
    faqs: [
      ['Can I drop my laundry off instead?', 'Yes. Our drop-off counter is at {site:dropoff_address}, open {site:dropoff_hours}.'],
      ['Is the price the same in San Lorenzo?', 'Yes. Every city we serve pays the same price, with no extra fee for San Lorenzo.'],
    ],
  },
  fremont: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Fremont is at the far end of our south routes, which run down through San Leandro, Hayward and Union City. Your laundry is washed by our own team in East Oakland and comes back the next day, folded and bundled by family member.",
      "We pick up across Fremont's districts, from Centerville and Niles to Ardenwood, Irvington, Mission San Jose and Warm Springs.",
    ],
    hoods: ['Centerville', 'Niles', 'Ardenwood', 'Northgate', 'Cabrillo', 'Central Fremont', 'Irvington', 'Glenmoor', 'Mission San Jose', 'Warm Springs'],
    faqs: [
      ['Is the price the same in Fremont?', 'Yes. Every city we serve pays the same price, with no extra fee for Fremont, even though it is one of our longest drives.'],
      ['Do you pick up from apartments and townhomes?', 'Yes. Leave your bag at your door, with the front desk or wherever your complex allows, and add the details in the app.'],
    ],
  },
  newark: {
    photo: 'porch-bag-2.jpg',
    about: [
      "Newark is on our south routes with Fremont and Union City, so it gets the same pickup windows as its neighbors.",
      "Leave your bag at the door, on the porch or with your building's front desk. It is washed by our own team in East Oakland, never handed to a third party, and comes back folded and bundled by family member.",
    ],
    hoods: ['Old Town Newark', 'Lakeshore', 'the NewPark Mall area', 'Thornton Avenue', 'Cedar Boulevard'],
    faqs: [
      ['Is the price the same in Newark?', 'Yes. Every city we serve pays the same price, with no extra fee for Newark.'],
      ['Is there a plan for big family loads?', 'Yes. The subscription is {plan:price} a month for {plan:lbs} lbs, with unlimited pickups and free next-day delivery.'],
    ],
  },
  // Opened Oct 6, 2026 (Kensington, Walnut Creek, Orinda, Union City, Richmond) after David's active-customers list.
  // Richmond has no zone of its own: 94801/94804/94805 addresses sit inside the Berkeley polygon (checked Oct 6).
  // El Sobrante is NOT inside any service_zones polygon, so it has no page until the zone covers it.
  kensington: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Kensington shares our Berkeley routes, so it gets the same pickup windows as Berkeley, Albany and El Cerrito.",
      "Most of Kensington is houses on steep, winding streets above Berkeley and Albany. Leave the bag wherever is easiest: at the door, at the top of the driveway or by the curb, and tell us in the app.",
    ],
    hoods: ['Arlington Avenue', 'Colusa Circle', 'Kensington Park', 'the Berkeley border', 'the Albany border'],
    faqs: [
      ['My street is steep. Where should I leave the bag?', 'Wherever is easiest for you: the door, the top of the driveway or the curb. Add a note in the app and the driver will find it.'],
      ['Is the price the same in Kensington?', 'Yes. Every city we serve pays the same price, with no extra fee for Kensington.'],
    ],
  },
  'walnut-creek': {
    photo: 'porch-bag-2.jpg',
    about: [
      "Walnut Creek is on our Contra Costa route, which also covers Concord, Pleasant Hill, Lafayette, Orinda, Moraga and Martinez. Pickups there run in the morning.",
      "We pick up from downtown apartments and condos as well as houses out toward Northgate and Rossmoor. Your laundry comes through the tunnel to our own facility in East Oakland, is washed by our team and comes back folded.",
    ],
    hoods: ['Downtown Walnut Creek', 'Northgate', 'Rossmoor', 'Saranap', 'Parkmead', 'Ygnacio Valley'],
    faqs: [
      ['Why are Walnut Creek pickups only in the morning?', 'Walnut Creek is on our morning Contra Costa route. Pick the morning window in the app; we text you when the driver is on the way.'],
      ['Is the price the same in Walnut Creek?', 'Yes. Every city we serve pays the same price, with no extra fee for Walnut Creek.'],
    ],
  },
  orinda: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Orinda is on our Contra Costa route, just through the Caldecott Tunnel from Oakland. Pickups there run in the morning.",
      "Many Orinda homes sit on hillside lots with long driveways. Leave the bag at the door, by the garage or at the top of the driveway, and note it in the app.",
    ],
    hoods: ['Orinda Village', 'the Crossroads', 'Glorietta', 'Sleepy Hollow', 'El Toyonal', 'Orinda Downs'],
    faqs: [
      ['Is there a plan for big family loads?', 'Yes. The subscription is {plan:price} a month for {plan:lbs} lbs, with unlimited pickups and free next-day delivery.'],
      ['Is the price the same in Orinda?', 'Yes. Every city we serve pays the same price, with no extra fee for Orinda.'],
    ],
  },
  'union-city': {
    photo: 'porch-bag-2.jpg',
    about: [
      "Union City is on our south routes with Hayward, Fremont and Newark, so it gets the same pickup windows as its neighbors.",
      "We pick up across the city, from Alvarado and Decoto to the neighborhoods around Union Landing. Leave the bag at the door or with your building's front desk, and it comes back washed by our own team and folded.",
    ],
    hoods: ['Alvarado', 'Decoto', 'Union Landing', 'the Mission Boulevard area', 'the Union City BART area'],
    faqs: [
      ['Do you pick up from apartments and townhomes?', 'Yes. Leave your bag at your door, with the front desk or wherever your complex allows, and add the details in the app.'],
      ['Is the price the same in Union City?', 'Yes. Every city we serve pays the same price, with no extra fee for Union City.'],
    ],
  },
  richmond: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Richmond is on our Berkeley routes, so it gets the same pickup windows as El Cerrito and Albany.",
      "Our Richmond customers are in the southern half of the city: Point Richmond, Marina Bay, the Richmond Annex and Richmond Heights. Further north? Enter your address in the app to check your street.",
    ],
    hoods: ['Point Richmond', 'Marina Bay', 'the Richmond Annex', 'Panhandle Annex', 'Richmond Heights', 'Downtown Richmond'],
    faqs: [
      ['Do you serve all of Richmond?', 'We serve most of south and central Richmond. Enter your address in the app to see whether your street is covered and which pickup windows it gets.'],
      ['Is the price the same in Richmond?', 'Yes. Every city we serve pays the same price, with no extra fee for Richmond.'],
    ],
  },
  // Opened Oct 6, 2026 (Concord, Lafayette, Moraga, Pleasant Hill, Martinez): David wants to grow Contra Costa.
  // Few customers yet, so no customer-based claims. All five are bookable through the Concord zone's city list
  // (get_zone_for_point falls back to the city name when an address is outside the polygon).
  concord: {
    photo: 'porch-bag-2.jpg',
    about: [
      "Concord is the hub of our Contra Costa route, which also covers Walnut Creek, Pleasant Hill, Martinez, Lafayette, Orinda and Moraga. Pickups there run in the morning.",
      "Your bag rides back through the Caldecott Tunnel to our own facility in East Oakland, where our team washes it fragrance-free, folds it and bundles it by family member, then brings it back to your door the next day.",
    ],
    hoods: ['Downtown Concord', 'Todos Santos Plaza', 'Ygnacio Valley', 'Dana Estates', 'Sun Terrace', 'Holbrook Heights', 'Crystal Ranch', 'the Concord BART area'],
    faqs: [
      ['Why are Concord pickups only in the morning?', 'Concord is on our morning Contra Costa route. Pick the morning window in the app; we text you when the driver is on the way.'],
      ['Do you pick up from apartments near downtown and BART?', 'Yes. Leave your bag with the front desk, in the package room or at your door, and add the details in the app.'],
      ['Is the price the same in Concord?', 'Yes. Every city we serve pays the same price, with no extra fee for Concord.'],
    ],
  },
  lafayette: {
    photo: 'porch-bag-1.jpg',
    about: [
      "Lafayette is on our morning Contra Costa route, one exit past the Caldecott Tunnel from our facility in East Oakland.",
      "School clothes, sports kits, towels and sheets: hand off the whole week. Everything comes back folded and bundled by family member, so putting it away takes minutes.",
    ],
    hoods: ['Downtown Lafayette', 'Happy Valley', 'Burton Valley', 'Reliez Valley', 'Acalanes Ridge', 'Springhill'],
    faqs: [
      ['Is there a plan for big family loads?', 'Yes. The subscription is {plan:price} a month for {plan:lbs} lbs, with unlimited pickups and free next-day delivery.'],
      ['Do you sort by family member?', 'Yes. Every load is folded and bundled by family member.'],
      ['Is the price the same in Lafayette?', 'Yes. Every city we serve pays the same price, with no extra fee for Lafayette.'],
    ],
  },
  moraga: {
    photo: 'porch-bag-2.jpg',
    about: [
      "Moraga is on our morning Contra Costa route, just over the hills from our facility in East Oakland.",
      "We pick up from family homes across Moraga and from apartments near Saint Mary's College. Your laundry is washed by our own team in East Oakland, never handed to a third party, and comes back folded the next day.",
    ],
    hoods: ['Moraga Center', 'Rheem Valley', 'Campolindo', 'Sanders Ranch', 'the Moraga Country Club area', "around Saint Mary's College"],
    faqs: [
      ['Do you pick up near Saint Mary\'s College?', 'Yes, from apartments and houses around campus. Leave your bag at the door or wherever your building allows, and add the details in the app.'],
      ['Is the price the same in Moraga?', 'Yes. Every city we serve pays the same price, with no extra fee for Moraga.'],
    ],
  },
  'pleasant-hill': {
    photo: 'porch-bag-1.jpg',
    about: [
      "Pleasant Hill sits between Walnut Creek, Concord and Martinez on our morning Contra Costa route.",
      "Leave your bag on the porch or with your building's front desk. It is washed fragrance-free with Free & Clear and ozone by our own team in East Oakland, folded, and back at your door the next day.",
    ],
    hoods: ['Downtown Pleasant Hill', 'Gregory Gardens', 'Poets Corner', 'the Pleasant Hill BART area', 'around Diablo Valley College'],
    faqs: [
      ['Do you pick up from apartments near BART and Diablo Valley College?', 'Yes. Leave your bag with the front desk or wherever your building allows, and add the details in the app.'],
      ['Is the price the same in Pleasant Hill?', 'Yes. Every city we serve pays the same price, with no extra fee for Pleasant Hill.'],
    ],
  },
  martinez: {
    photo: 'porch-bag-2.jpg',
    about: [
      "Martinez is the northern end of our morning Contra Costa route, which runs through Pleasant Hill and Concord.",
      "From the historic downtown and the waterfront to the Alhambra Valley and the hills, leave your bag at the door and get it back washed by our own team, folded and bundled by family member.",
    ],
    hoods: ['Downtown Martinez', 'the waterfront', 'Alhambra Valley', 'Muir Oaks', 'Virginia Hills'],
    faqs: [
      ['Why are Martinez pickups only in the morning?', 'Martinez is on our morning Contra Costa route. Pick the morning window in the app; we text you when the driver is on the way.'],
      ['Is the price the same in Martinez?', 'Yes. Every city we serve pays the same price, with no extra fee for Martinez.'],
    ],
  },
};
