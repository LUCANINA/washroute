// Topic pages: one page per service, business type and common question — the structure that works for
// 2ULaundry (analysis Oct 5 2026), written from Family Laundry's own facts (WashRoute FAQ + price list).
// Text is light markdown (paragraphs, "- " lists, **bold**, [links](/path)) with live tokens: never type a
// price, fee or time. `group` places the page in the footer; `cta` = 'pickup' | 'quote'; `service` adds
// Service markup for Google.
module.exports = [
  // ── Residential ──────────────────────────────────────────────────────────────────────────────────────
  {
    path: '/comforter-cleaning', group: 'Residential', nav: 'Comforters & bedding', cta: 'pickup',
    service: 'Comforter and bedding laundry',
    photo: { src: 'bag-deck.jpg', w: 1400, h: 883, alt: 'A zipped Family Laundry bag waiting on a sunny deck', caption: 'Bags close with a zipper and are yours to keep.' },
    title: 'Comforter & Bedding Laundry Service with Pickup | Family Laundry',
    description: 'Comforters, duvets, blankets, pillows and sleeping bags washed fragrance-free at our own plant in Oakland, picked up and delivered across the East Bay and San Francisco.',
    h1: 'Comforter and bedding laundry',
    lead: "We wash comforters, duvets, pillows and sleeping bags in our large machines and bring them back clean, fully dry and folded.",
    sections: [
      { h: 'What we wash', md: "- Comforters and duvets\n- Blankets and throws\n- Bed pillows\n- Sheets, pillowcases and mattress pads\n- Sleeping bags\n- Dog and cat beds" },
      { h: 'How much fits in a bag', md: "Bedding goes in the same Family Laundry bag as everything else, priced per bag. One bag holds about **3 standard pillows, 3 standard blankets or 2 standard duvets**. If it fits in the bag, we'll wash it.\n\nPer bag: {price:Wash & Fold} plus {fee:Delivery Fee} delivery. Bags over 25 lbs are an extra {site:overweight_rate}. Subscribers pay one monthly price instead: {plan:price} for {plan:lbs} lbs." },
      { h: 'How we clean it', md: "Free & Clear hypoallergenic detergent and ozone, cold water, dried on medium. No fragrance, no bleach and no softener, so nothing lingers on the fabric you sleep on. For a pet bed or a sick-day comforter, add **Double Wash** ({price:Double Wash} per bag), a second full wash, when you book." },
      { h: "What we can't take", md: "Anything labeled dry clean only or hand wash only, and anything that doesn't fit in a Family Laundry bag." },
    ],
    faqs: [
      ['Can you wash a king-size comforter?', 'Yes, if it fits in a Family Laundry bag. Our large machines handle bulky bedding.'],
      ['Do you wash pet beds?', 'Yes. Dog and cat beds that fit in a bag are welcome. Double Wash is a good add-on for them.'],
      ['Will my down comforter come back dry?', 'Yes. Everything is fully dried before it is folded and bagged.'],
    ],
    related: ['/delicate-laundry-service', '/fragrance-free-laundry-service', '/laundry-service-cost'],
  },
  {
    path: '/delicate-laundry-service', group: 'Residential', nav: 'Delicates & air dry', cta: 'pickup',
    service: 'Delicates laundry with air drying',
    title: 'Delicate Laundry Service: Air Dry for Delicates | Family Laundry',
    description: 'Lingerie, workout gear and delicates washed gently and air dried, fragrance-free, at our own plant in Oakland. Pickup and delivery across the East Bay and San Francisco.',
    h1: 'Delicates and air dry',
    lead: "Bras, swimwear and workout gear last longer when they skip the dryer. Put them in a separate bag, choose Air Dry, and we hang them to dry.",
    sections: [
      { h: 'How it works', md: "- Put your delicates in their own bag. We give you a reusable 15\" × 19\" delicates bag at no extra cost.\n- Choose **Air Dry** when you book in the app.\n- We wash them gently with Free & Clear detergent and hang them to dry instead of tumbling.\n- They come back folded with the rest of your order." },
      { h: 'Good candidates for Air Dry', md: "- Bras, lingerie and swimwear\n- Leggings and technical workout gear\n- Anything that shrinks, pills or loses its shape in a dryer" },
      { h: 'Price', md: "Air Dry is {price:Air Dry} per delicates bag, added to your regular order." },
      { h: 'What to keep out', md: "Dry-clean-only and hand-wash-only items. We don't offer dry cleaning. We only do wash & fold, with water and hypoallergenic detergent." },
    ],
    faqs: [
      ['Do I need a special bag for delicates?', 'Use any separate bag for your first order. After that, use the reusable delicates bag we give you at no extra cost.'],
      ['Can you hand wash items?', 'No. Please keep hand-wash-only items out of your order.'],
    ],
    related: ['/shirt-laundry-service', '/fragrance-free-laundry-service', '/comforter-cleaning'],
  },
  {
    path: '/shirt-laundry-service', group: 'Residential', nav: 'Shirt service', cta: 'pickup',
    service: 'Shirt laundering, hand-steamed and on hangers',
    title: 'Shirt Laundry Service: Hand-Steamed on Hangers | Family Laundry',
    description: 'Dress shirts and blouses laundered fragrance-free, hand-steamed and returned on hangers. Picked up and delivered across the East Bay and San Francisco.',
    h1: 'Shirt service',
    lead: "Shirts and blouses laundered, hand-steamed and delivered on hangers, ready to wear.",
    sections: [
      { h: 'How it works', md: "- Add **Shirt service** when you book and tell us how many shirts.\n- Send them in your regular bag with the rest of your laundry.\n- We launder them with Free & Clear detergent, hand-steam them and hang them.\n- They come back on hangers with your folded order." },
      { h: 'Price', md: "{price:Shirt Service} per shirt, on top of your regular order." },
      { h: 'Not dry cleaning', md: "We launder shirts in water. We don't dry clean, so please keep dry-clean-only shirts out of your order." },
    ],
    faqs: [
      ['Do you starch shirts?', 'No. We keep everything fragrance-free and additive-free; shirts are laundered and hand-steamed.'],
    ],
    related: ['/delicate-laundry-service', '/laundry-service-cost', '/laundry-delivery-services'],
  },
  {
    path: '/fragrance-free-laundry-service', group: 'Residential', nav: 'Fragrance-free laundry', cta: 'pickup',
    service: 'Fragrance-free hypoallergenic laundry',
    title: 'Fragrance-Free, Hypoallergenic Laundry Service | Family Laundry',
    description: 'Laundry washed with Free & Clear hypoallergenic detergent and ozone only: no fragrance, bleach or softener. For sensitive skin, babies and anyone who wants laundry that smells of nothing.',
    h1: 'Fragrance-free laundry',
    lead: "We wash every order with Free & Clear hypoallergenic detergent and ozone. Your laundry comes back smelling of nothing at all.",
    sections: [
      { h: 'What we use, and what we never use', md: "- **We use:** Free & Clear hypoallergenic detergent, ozone-injected water, and white vinegar or Oxi when you ask for them.\n- **We never use:** fragrances, chlorine bleach, fabric softener, dryer sheets or dry-cleaning solvents." },
      { h: 'Why it matters', md: "A lot of people are sensitive to fragrances and the additives in conventional detergents, and plenty of households simply prefer to avoid them. Free & Clear works for everyone, so we use it on every order at no extra cost. The result is a neutral, clean smell with no detergent or softener residue." },
      { h: 'Ozone in the wash', md: "The washers at our plant run on ozone-injected water. Ozone sanitizes laundry (and our machines as they run) and boosts the cleaning power of a mild detergent, so we don't need harsh chemicals." },
      { h: 'Optional add-ons', md: "Add **Oxi** ({price:Oxi} per bag) for brighter whites without bleach, or a white **Vinegar** rinse ({price:Vinegar} per bag) to soften fabric and rinse out residue." },
      { h: 'Washed on its own', md: "Delivery orders are washed separately at our plant, never mixed with another customer's, so nobody else's scented detergent ends up in your clothes. If you're highly sensitive, choose pickup and delivery over drop-off, because our laundromat's machines are open to the public." },
    ],
    faqs: [
      ['Is your detergent safe for babies?', 'Yes. It is hypoallergenic Free & Clear detergent with no fragrance, dyes, bleach or softener, and daycares send us their crib sheets and bibs every week.'],
      ['Will my clothes smell like anything?', 'No. Expect a neutral, clean smell with no perfume.'],
    ],
    related: ['/daycare-laundry-service', '/comforter-cleaning', '/delicate-laundry-service'],
  },
  {
    path: '/apartment-laundry-service', group: 'Residential', nav: 'Apartments & condos', cta: 'pickup',
    service: 'Apartment and condo laundry pickup',
    title: 'Apartment Laundry Service: Pickup from Your Building | Family Laundry',
    description: 'Laundry pickup and delivery for apartments and condos in Oakland, Berkeley, Emeryville and San Francisco: front desk, lobby or doorstep, plus group discounts for buildings.',
    h1: 'Laundry service for apartments and condos',
    lead: "We pick up from your door, front desk or lobby and bring your laundry back folded the next day.",
    sections: [
      { h: 'Pickup in buildings', md: "- Leave your bag at your door, with the front desk or doorman, or in your lobby if your building allows it.\n- Add instructions in the app: gate code, buzzer, where to leave the bag.\n- You get a text when the driver is on the way." },
      { h: 'Discounts for your building', md: "Get your neighbors together. We offer discounts for coordinated pickups in multi-unit buildings. Email {site:email} to set it up." },
      { h: 'Building managers', md: "Laundry pickup is an easy amenity to offer residents. Write to {site:email} and we'll set up a schedule that suits your building." },
      { h: 'Across all our cities', md: "We pick up from apartment and condo buildings everywhere we serve, including Lake Merritt, Grand Lake and Uptown in [Oakland](/laundry-delivery-oakland), [Emeryville](/laundry-delivery-emeryville), Southside near campus in [Berkeley](/laundry-delivery-berkeley), and Nob Hill, Pacific Heights and the Mission in [San Francisco](/laundry-delivery-sf)." },
    ],
    faqs: [
      ['Do I need to be home?', 'No. Leave the bag where your building allows and tell us in the app.'],
      ['Can several neighbors share one pickup?', "Yes. Email us and we'll set up a coordinated pickup with a building discount."],
    ],
    related: ['/leaving-laundry-out-for-pickup', '/first-laundry-pickup', '/laundry-service-cost'],
  },
  {
    path: '/drop-off-laundry-oakland', group: 'Residential', nav: 'Drop-off in Oakland', cta: 'pickup',
    service: 'Drop-off wash and fold laundry',
    title: 'Drop-Off Laundry Service in Oakland, Open 7 Days | Family Laundry',
    description: 'Drop off your laundry at 2609 Foothill Blvd, Oakland. Wash & fold by the pound, open 7 days a week, same-day if you drop off early. No machines to babysit.',
    h1: 'Drop-off laundry in Oakland',
    lead: "Drop your laundry at the counter of our Oakland laundromat and pick it up washed and folded. No machines to babysit.",
    sections: [
      { h: 'Where and when', md: "**{site:dropoff_address}**, near Fruitvale. Open {site:dropoff_hours}, with self-service washers and dryers as well as the drop-off counter. [sudzee.com](https://www.sudzee.com)\n\n{site:dropoff_cutoff}" },
      { h: 'Price', md: "- Wash & fold: {retail:Wash & Fold}\n- Wash & dry (no folding): {retail:Wash & Dry}\n- Add-ons: Vinegar {retail:Vinegar}, Oxi {retail:Oxi}, Double Wash {retail:Double Wash}" },
      { h: 'How we wash it', md: "Our own staff wash drop-off orders here at the laundromat with the same Free & Clear detergent we use for delivery. No fragrance, bleach or softener.\n\nThe laundromat's machines are open to the public, so they may hold traces of other customers' products. If you're highly sensitive to fragrance, choose pickup and delivery. Those orders are washed separately at our own plant." },
      { h: "Don't want to drive?", md: "We also pick up and deliver {site:service_days}, all over Oakland and the East Bay. [See pickup and delivery in Oakland](/laundry-delivery-oakland)." },
    ],
    faqs: [
      ['Is this a self-service laundromat?', "Both. Sudzee has self-service washers and dryers, or you can drop off at the counter and our team does the washing and folding."],
      ['Can I get it back the same day?', '{site:dropoff_cutoff}'],
    ],
    related: ['/laundry-delivery-oakland', '/laundry-service-cost', '/fragrance-free-laundry-service'],
  },
  // ── Commercial ───────────────────────────────────────────────────────────────────────────────────────
  {
    path: '/daycare-laundry-service', group: 'Commercial', nav: 'Schools & daycares', cta: 'quote',
    service: 'Laundry service for schools and childcare centers',
    title: 'Daycare & School Laundry Service in the East Bay | Family Laundry',
    description: 'Nap-time bedding, bibs, smocks, towels and cloth napkins for East Bay daycares and schools, washed fragrance-free and picked up on your schedule.',
    h1: 'Laundry service for daycares and schools',
    lead: "Childcare centers and schools across the East Bay send us their laundry every week, so their staff can spend the time with the kids.",
    sections: [
      { h: 'What we wash', md: "- Nap mat covers, crib sheets and blankets\n- Bibs, smocks and burp cloths\n- Towels, washcloths and cloth napkins\n- Dress-up clothes and spare clothes\n- Staff aprons and uniforms" },
      { h: 'Safe for little ones', md: "Everything is washed with Free & Clear hypoallergenic detergent and ozone, with no fragrance, bleach or softener. That matters for babies and children with sensitive skin, and for parents who ask what touches their child." },
      { h: 'On your schedule', md: "Regular pickups on the days that suit you, returned the next day. Monthly invoicing is available. Commercial pricing starts at {commercial:Wash & Fold}." },
    ],
    faqs: [
      ['Do you pick up weekly?', 'Yes. Most centers have a fixed weekly or twice-weekly pickup.'],
      ['Can we be invoiced monthly?', 'Yes. Monthly invoicing is available for business accounts.'],
    ],
    related: ['/commercial-laundry', '/fragrance-free-laundry-service', '/gym-towel-laundry-service'],
  },
  {
    path: '/airbnb-laundry-service', group: 'Commercial', nav: 'Airbnb & vacation rentals', cta: 'quote',
    service: 'Laundry service for Airbnb and short-term rental hosts',
    title: 'Airbnb Laundry Service for Bay Area Hosts | Family Laundry',
    description: 'Sheets and towels for Airbnb and short-term rental hosts in Oakland, Berkeley, Alameda and San Francisco: picked up between guests, washed fragrance-free, back the next day.',
    h1: 'Laundry service for Airbnb hosts',
    lead: "We pick up sheets and towels between guests and bring them back clean and folded the next day.",
    sections: [
      { h: 'What hosts send us', md: "- Sheets, duvet covers and pillowcases\n- Bath and hand towels, bath mats\n- Kitchen towels\n- Blankets and throws" },
      { h: 'Why hosts like it', md: "- Fragrance-free, so nothing bothers sensitive guests and no residue builds up on white linens\n- Next-day turnaround, {site:service_days}\n- Pickup from the door, lockbox area or wherever you tell us in the app\n- Folded neatly and bundled, ready for the next make-up" },
      { h: 'Pricing', md: "Occasional hosts can book per bag ({price:Wash & Fold} plus {fee:Delivery Fee} delivery). Hosts with several units or weekly turnovers get commercial pricing from {commercial:Wash & Fold}; ask for a quote." },
    ],
    faqs: [
      ['Can you pick up when I\'m not there?', 'Yes. Leave the bag where you tell us in the app, and we\'ll deliver to the same spot.'],
      ['Do you serve hotels too?', 'Yes. Ask for a quote and tell us your volume.'],
    ],
    related: ['/commercial-laundry', '/comforter-cleaning', '/apartment-laundry-service'],
  },
  {
    path: '/gym-towel-laundry-service', group: 'Commercial', nav: 'Gyms & studios', cta: 'quote',
    service: 'Gym and fitness studio towel laundry',
    title: 'Gym Towel Laundry Service in the Bay Area | Family Laundry',
    description: 'Towel and mat-cover laundry for gyms, yoga and fitness studios in Oakland, Berkeley and the East Bay. Sanitized with ozone, fragrance-free, picked up on your schedule.',
    h1: 'Towel laundry for gyms and studios',
    lead: "We pick up towels from your gym or studio, sanitize them with ozone and bring them back folded, ready for the shelf.",
    sections: [
      { h: 'What we wash', md: "- Gym and bath towels\n- Yoga towels and mat covers\n- Hand towels and washcloths\n- Staff shirts and uniforms" },
      { h: 'Clean without the chemical smell', md: "Ozone-injected water sanitizes towels while they wash, with Free & Clear detergent and no bleach, fragrance or softener. Softener coats towels and makes them less absorbent; we never use it." },
      { h: 'A schedule that matches your classes', md: "Weekly or several pickups a week, returned the next day. Monthly invoicing available. Commercial pricing starts at {commercial:Wash & Fold}." },
    ],
    faqs: [
      ['Can you pick up several times a week?', 'Yes. Tell us your volume and class schedule and we\'ll set a pickup plan.'],
    ],
    related: ['/commercial-laundry', '/salon-spa-laundry-service', '/daycare-laundry-service'],
  },
  {
    path: '/salon-spa-laundry-service', group: 'Commercial', nav: 'Salons, spas & massage', cta: 'quote',
    service: 'Laundry service for salons, spas, massage and chiropractic practices',
    title: 'Salon, Spa & Massage Laundry Service | Family Laundry',
    description: 'Towels, sheets, face cradle covers and capes for salons, spas, massage therapists and chiropractors in the East Bay and San Francisco, washed fragrance-free.',
    h1: 'Laundry for salons, spas and massage practices',
    lead: "Salons, spas, massage therapists and chiropractors use us for the towels and linens that pile up every day.",
    sections: [
      { h: 'What we wash', md: "- Towels of every size\n- Massage table sheets and face cradle covers\n- Salon capes and smocks\n- Robes and blankets" },
      { h: 'Fragrance-free matters here', md: "Massage clients spend an hour face-down on your linens, so they notice any smell. We use Free & Clear detergent and ozone only, so linens come back neutral, with nothing that clashes with your own products or bothers sensitive clients." },
      { h: 'Pickup that fits your day', md: "Regular pickups, returned the next day, with monthly invoicing available. Commercial pricing starts at {commercial:Wash & Fold}." },
    ],
    faqs: [
      ['Can you wash sheets with massage oil on them?', 'Yes. Add Double Wash or Oxi when you book, and tell us about heavier loads so we can plan for them.'],
    ],
    related: ['/commercial-laundry', '/gym-towel-laundry-service', '/fragrance-free-laundry-service'],
  },
  // ── Getting started ──────────────────────────────────────────────────────────────────────────────────
  {
    path: '/first-laundry-pickup', group: 'Getting started', nav: 'Your first order', cta: 'pickup',
    photo: { src: 'bag-deck.jpg', w: 1400, h: 883, alt: 'A zipped Family Laundry bag waiting on a sunny deck', caption: 'Bags close with a zipper and are yours to keep.' },
    title: 'What to Expect From Your First Laundry Pickup | Family Laundry',
    description: 'How your first Family Laundry order works: booking, packing your laundry, pickup, how we wash it, and what comes back the next day.',
    h1: 'What to expect from your first order',
    lead: "How your first order works, from booking to putting it away.",
    sections: [
      { h: '1. Book a pickup', md: "Book in the app or at [app.familylaundry.com](https://app.familylaundry.com). Pick a pickup window; you can book up to 60 minutes before a window ends. Later on, regular customers can also text **PICKUP** to {site:phone}." },
      { h: '2. Pack your laundry', md: "For your first order, put your laundry in sealed trash bags. A Family Laundry bag holds about 2 tall kitchen bags, or 25 lbs. Keep delicates in a separate bag and choose Air Dry if you want them hung to dry." },
      { h: "3. Leave it out", md: "You don't need to be home. Leave the bags at your door, porch or front desk and tell us where in the app. [Tips for leaving laundry out](/leaving-laundry-out-for-pickup)." },
      { h: '4. We wash it ourselves', md: "At our own plant in Oakland, we empty pockets, separate lights and darks, wash in cold water with Free & Clear detergent and ozone, and dry on medium. Your laundry is never mixed with anyone else's and never sent to another company." },
      { h: '5. It comes back folded', md: "Usually the next service day, in Family Laundry bags that are yours to keep for next time. Everything is folded, socks balled, and bundled by family member." },
      { h: '6. Pay and tip', md: "Your card on file is charged when your order is ready for delivery. You can set a default tip for your driver in the app." },
    ],
    faqs: [
      ['What if I\'m not happy with my order?', 'Tell us and we\'ll make it right. If something is lost or damaged, let us know within 48 hours.'],
      ["What can't I send?", "Dry-clean-only and hand-wash-only items, shoes, and anything that doesn't fit in a Family Laundry bag."],
    ],
    related: ['/leaving-laundry-out-for-pickup', '/laundry-service-cost', '/faq'],
  },
  {
    path: '/leaving-laundry-out-for-pickup', group: 'Getting started', nav: 'Leaving laundry out', cta: 'pickup',
    photo: { src: 'bag-deck.jpg', w: 1400, h: 883, alt: 'A zipped Family Laundry bag waiting on a sunny deck', caption: 'Bags close with a zipper and are yours to keep.' },
    title: 'Leaving Your Laundry Out for Pickup: Tips | Family Laundry',
    description: 'Where to leave your laundry bag for pickup, how to give drivers instructions in apartments and gated buildings, and how to avoid a missed pickup.',
    h1: 'Leaving your laundry out for pickup',
    lead: "Most of our customers aren't home at pickup time. These tips help the driver find your bag every time.",
    sections: [
      { h: 'Where to leave it', md: "- On the porch or right by your front door\n- With the front desk, doorman or in the package room, if your building allows it\n- Somewhere visible from the door, not around the side of the house" },
      { h: 'Tell us in the app', md: "Add delivery instructions: gate or door codes, buzzer number, which door, where to leave it. Drivers read them on every stop, and we bring your clean laundry back to the same spot." },
      { h: 'Put it out before your window starts', md: "Your window is when the driver arrives, so set the bag out before it begins. You get a text when the driver is on the way." },
      { h: 'If we miss it', md: "If the driver can't find or reach your bag, there is a {fee:Missed Pickup Fee} missed pickup fee. Clear instructions are the best way to avoid it. Need to change plans? Reply **SKIP** to our text, or cancel in the app. Please don't text CANCEL or STOP. Those words unsubscribe you from all our texts." },
    ],
    faqs: [
      ['Is it safe to leave laundry outside?', 'Most customers leave bags at the door without a problem. In busy buildings, the front desk or package room is safest.'],
    ],
    related: ['/first-laundry-pickup', '/apartment-laundry-service', '/faq'],
  },
];
