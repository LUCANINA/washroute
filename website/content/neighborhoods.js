// Neighborhood pages under a city page: /laundry-delivery-<city>/<slug>. Keyed by the parent city slug.
// Added Oct 12, 2026 to compete for San Francisco searches (Rinse, PurpleTie and Mulberrys are all strong in SF).
//
// Same rule as the city pages: every page needs real local content or Google treats it as a near-duplicate.
// Every fact here is ours:
//  - zips + rank facts come from WashRoute customers active in the past 12 months, grouped by their address ZIP
//    (query run Oct 12, 2026: 94110 15 households; 94109 12; 94115 12; 94118 9; 94103 9; 94117 8; 94105 7; …).
//    Raw counts are small, so pages state where customers are, not how many.
//  - reviews are 5-star after-delivery ratings (order_feedback) from customers in that ZIP, first name + initial.
// Never type a price, fee or pickup time here: the page builder renders those live from WashRoute.
// index: true = open to Google and listed in the sitemap.
module.exports = {
  sf: [
    {
      slug: 'mission', index: true,
      name: 'the Mission & Bernal Heights',
      short: 'Mission',
      zips: ['94110'],
      intro: "94110 is our busiest ZIP code in San Francisco. We pick up all over the Mission and up the hill in Bernal Heights, on our evening routes.",
      about: [
        "No washer in your building? Leave a bag at your door instead of hauling it to the laundromat.",
        "Your laundry crosses the Bay Bridge to our own plant in Oakland, where our team washes it fragrance-free and folds it. It comes back the next service day, bundled by family member.",
      ],
      areas: ['the Mission', 'Mission Dolores', 'the Inner Mission', 'Valencia Street', 'La Lengua', 'Bernal Heights', 'Precita Park', 'Holly Park'],
      review: { who: 'Gregg C, the Mission', text: 'Best laundry service I’ve ever used!' },
      faqs: [
        ['Do you pick up in Bernal Heights?', 'Yes, all of 94110, including the top of the hill. Leave your bag at your door and tell us where in the app.'],
        ['My building has a gate. How does pickup work?', 'Add your gate or buzzer code under Delivery Instructions in the app. Your driver uses it for both pickup and delivery.'],
      ],
    },
    {
      slug: 'soma', index: true,
      name: 'SoMa, Rincon Hill & Mission Bay',
      short: 'SoMa',
      zips: ['94103', '94105', '94107', '94111', '94158'],
      intro: "We pick up across SoMa, Rincon Hill, South Beach and Mission Bay on our evening routes. In buildings with a front desk or a security guard, we pick up from the lobby.",
      about: [
        "Leave your bag with the front desk, the concierge or in the package room if your building allows it. Our drivers check in with building staff, and we text you when your laundry is on the way back.",
        "Everything is washed by our own team at our plant in Oakland, never sent to a third party, and comes back folded the next service day.",
      ],
      areas: ['SoMa', 'South Beach', 'Rincon Hill', 'the East Cut', 'Yerba Buena', 'Mission Bay', 'Potrero Hill', 'Dogpatch', 'the Embarcadero'],
      review: { who: 'Ellie J, Rincon Hill', text: 'It was a first time and drivers were very kind to coordinate with the security guard.' },
      faqs: [
        ['Can I leave my bag with the front desk or concierge?', 'Yes. Tell us in the app who to ask or where the bag will be (front desk, concierge, package room). Our driver checks in with building staff.'],
        ['Do you deliver to Potrero Hill and Dogpatch?', 'Yes. Potrero Hill and Dogpatch are on the same evening routes as SoMa and Mission Bay.'],
      ],
    },
    {
      slug: 'nob-hill', index: true,
      name: 'Nob Hill, Russian Hill & North Beach',
      short: 'Nob Hill',
      zips: ['94109', '94108', '94133'],
      intro: "94109 is one of our two busiest San Francisco ZIP codes after the Mission. We pick up across Nob Hill, Russian Hill, Polk Gulch and down into North Beach.",
      about: [
        "If you live in a walk-up on a steep block, you don't carry the bag anywhere. Your driver picks it up at your door or in your lobby, and brings it back the same way.",
        "Your laundry is washed fragrance-free at our own plant in Oakland and comes back folded the next service day.",
      ],
      areas: ['Nob Hill', 'Lower Nob Hill', 'Russian Hill', 'Polk Gulch', 'Cathedral Hill', 'Chinatown', 'North Beach', 'Telegraph Hill'],
      faqs: [
        ['I live in a walk-up. Do I need to bring my bag downstairs?', 'No. Leave it at your apartment door if your building allows it, or in the lobby. Add your buzzer code under Delivery Instructions in the app.'],
        ['Do you pick up in North Beach and Telegraph Hill?', 'Yes. North Beach, Telegraph Hill and Chinatown are on the same evening routes as Nob Hill and Russian Hill.'],
      ],
    },
    {
      slug: 'pacific-heights', index: true,
      name: 'Pacific Heights & the Marina',
      short: 'Pacific Heights',
      zips: ['94115', '94123'],
      intro: "94115 is one of our two busiest San Francisco ZIP codes after the Mission. We pick up across Pacific Heights, Japantown and the Fillmore, and down to the Marina and Cow Hollow.",
      about: [
        "Hand off the weekly load: clothes, sheets, towels. Everything comes back folded and bundled by family member, so putting it away takes a few minutes.",
        "We wash with Free & Clear detergent and ozone at our own plant in Oakland. No fragrance, no softener, no bleach.",
      ],
      areas: ['Pacific Heights', 'Lower Pacific Heights', 'Japantown', 'the Fillmore', 'the Western Addition', 'Anza Vista', 'the Marina', 'Cow Hollow'],
      faqs: [
        ['Do you pick up in the Marina and Cow Hollow?', 'Yes. The Marina and Cow Hollow are on the same evening routes as Pacific Heights.'],
        ['Can you keep each family member’s laundry separate?', 'Yes. We fold and bundle laundry by family member as standard. Add any notes for the team in the app.'],
      ],
    },
    {
      slug: 'richmond', index: true,
      name: 'the Richmond District',
      short: 'Richmond District',
      zips: ['94118', '94121', '94129'],
      intro: "We pick up across the Inner and Outer Richmond, from Laurel Heights and Lone Mountain out to Sea Cliff, plus the Presidio.",
      about: [
        "The Inner Richmond is one of the areas where we have the most San Francisco customers. Leave your bag at the front door, on the steps or by the garage, wherever you tell us in the app.",
        "Your laundry is washed by our own team in Oakland, never outsourced, and comes back folded the next service day.",
      ],
      areas: ['the Inner Richmond', 'the Outer Richmond', 'Laurel Heights', 'Jordan Park', 'Lone Mountain', 'Presidio Heights', 'Sea Cliff', 'the Presidio'],
      faqs: [
        ['Do you pick up in the Outer Richmond and Sea Cliff?', 'Yes, all the way to the ocean. The whole Richmond District is on our evening routes.'],
        ['Can I leave my bag by the garage door?', 'Yes. Tell us where in the app under Delivery Instructions, and we deliver it back to the same spot.'],
      ],
    },
    {
      slug: 'haight', index: true,
      name: 'Hayes Valley, the Haight & Cole Valley',
      short: 'Haight & Hayes Valley',
      zips: ['94117', '94102'],
      intro: "We pick up in Hayes Valley, the Lower Haight, Haight-Ashbury, Cole Valley, NoPa and around Alamo Square, on our evening routes.",
      about: [
        "Live in a flat with steps up to the front door? Leave your bag at the top of the stairs or in the entryway, and add a note in the app if it's hard to find.",
        "Your laundry is washed fragrance-free at our own plant in Oakland and comes back folded the next service day.",
      ],
      areas: ['Hayes Valley', 'the Lower Haight', 'Haight-Ashbury', 'Cole Valley', 'NoPa', 'Alamo Square', 'Duboce Triangle', 'Buena Vista', 'Civic Center'],
      faqs: [
        ['Do you pick up in Cole Valley and Ashbury Heights?', 'Yes. Cole Valley, Ashbury Heights and Buena Vista are on the same evening routes as the Haight.'],
        ['My flat has a shared entry. Where should I leave my bag?', 'Wherever is easiest for you: inside the shared entry, on the stairs or at your door. Tell us under Delivery Instructions in the app.'],
      ],
    },
    {
      slug: 'noe-valley', index: true,
      name: 'Noe Valley, the Castro & Glen Park',
      short: 'Noe Valley',
      zips: ['94114', '94131'],
      intro: "We pick up across Noe Valley, the Castro, Glen Park and Diamond Heights, stairs and hills included, on our evening routes.",
      about: [
        "If your home sits up a long flight of steps, you don't haul the bag down. Our drivers pick up and deliver at your front door.",
        "Everything is washed by our own team at our plant in Oakland, fragrance-free, and comes back folded and bundled by family member.",
      ],
      areas: ['Noe Valley', 'the Castro', 'Eureka Valley', 'Corona Heights', 'Glen Park', 'Diamond Heights', 'Twin Peaks', 'Miraloma Park'],
      review: { who: 'Jessica A, the Castro', text: 'Andre does a great job picking up and delivering our clothes. [...] there are 60 stairs to our front door.' },
      faqs: [
        ['Do you pick up in Glen Park and Diamond Heights?', 'Yes. Glen Park, Diamond Heights and Twin Peaks are on the same evening routes as Noe Valley and the Castro.'],
        ['Will the driver come up the stairs to my door?', 'Yes. We pick up and deliver at your door. If the entrance is hard to find, add a note under Delivery Instructions in the app.'],
      ],
    },
    {
      slug: 'sunset', index: true,
      name: 'the Sunset & West Portal',
      short: 'Sunset',
      zips: ['94122', '94116', '94127', '94132'],
      intro: "We pick up across the Inner and Outer Sunset, Parkside, West Portal and around Lake Merced, on our evening routes.",
      about: [
        "Leave your bag on the front steps or by the garage. Comforters, sheets and towels can go in with your order too.",
        "Your laundry is washed by our own team at our plant in Oakland, never outsourced, and comes back folded the next service day.",
      ],
      areas: ['the Inner Sunset', 'the Outer Sunset', 'Parkside', 'West Portal', 'Forest Hill', 'St. Francis Wood', 'Lake Merced', 'Parkmerced'],
      faqs: [
        ['Do you pick up in the Outer Sunset?', 'Yes, all the way to Ocean Beach. The whole Sunset is on our evening routes.'],
        ['Can you wash comforters and bedding?', 'Yes. Comforters, duvets and pillows go in the same Family Laundry bag as the rest of your laundry, at the same per-bag price.'],
      ],
      related: '/comforter-cleaning',
    },
  ],
};
