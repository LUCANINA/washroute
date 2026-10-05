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
};
