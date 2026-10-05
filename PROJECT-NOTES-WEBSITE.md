# familylaundry.com — project notes

The public website, moved off Wix in October 2026. This file is the single place for how the site works,
the decisions behind it, and what's left. Technical file map: `website/README.md`. Newest log entries at the
bottom.

## At a glance

| | |
| --- | --- |
| Code | `website/` in this repo (no build step, no dependencies) |
| Hosting | Vercel project **familylaundry-website**, team LUCANINA, Root Directory `website` |
| Preview | https://familylaundry-website.vercel.app (always hidden from Google) |
| Live domain | familylaundry.com + www (switching from Wix — see Cutover) |
| Data | Supabase `site_public_values()`, `faq_topics`, `faq_items`, read with the public key |
| Deploys | Automatic ~30 s after a push to `main` |
| Plans | [Website fixes & city SEO plan](https://claude.ai/code/artifact/02c6f193-aad5-4b26-a664-507348cb464f) · [SEO visibility audit & growth plan](https://claude.ai/code/artifact/6b33bf5a-4cbc-40e0-bfa1-c59a82237ec6) |

## Rules for this site

- **Never type a price, fee, pickup time or rating.** They come live from WashRoute (`site_public_values()`)
  through tokens like `{price:Wash & Fold}` and `{site:phone}`. Change them in WashRoute, not in code.
- **Positioning:** cleaned in-house (never outsourced), fragrance-free (Free & Clear + ozone), back the next
  day, local family business with 30+ employees. Price is never the lead. Don't promise same-day.
- **Facts that must stay right:** family-owned since 2018, delivering since 2019. Address
  2609 Foothill Blvd, Oakland, CA 94601. Phone (510) 588-4102. Pickup and delivery Monday–Saturday;
  drop-off counter open 7 days.
- **Homepage keeps the original Wix look** (David's call): "FAMILY LAUNDRY / Wash & Fold for Busy Households",
  pink van block, yellow pricing tiles, How we clean, Bubble Power, quote cards, Our story video, contact form.
- **Reviews:** never ask only happy customers for reviews; never reward reviews. Quote reviews with first name
  + last initial only (David OK'd quoting Google reviews, Oct 5 2026).
- **Rating markup:** the hidden Google markup uses only our OWN after-delivery ratings (`order_feedback`).
  Never put Google's 4.8 / 327 in markup — Google forbids marking up ratings copied from another site.
  The visible Google badge is fine.
- **City pages open to Google only when they have real local content** (`index: true` in
  `website/content/cities.js`). Near-identical city pages drag the whole site down.

## Publishing a change (David's Terminal)

David's laptop usually sits on the side branch `session-326-winback-exclusions`, which holds an unreleased
win-back change that must NOT reach `main` with the website. So website commits are copied onto `main`
through a temporary folder:

```
cd ~/Projects/WashRoute
git add website
git commit -m "Website: <what changed>"
git worktree add ../wr-website-push origin/main
cd ../wr-website-push
git cherry-pick session-326-winback-exclusions
git push origin HEAD:main
cd ../WashRoute
git worktree remove ../wr-website-push
```

If David is on `main`, a plain `git add website && git commit -m "…" && git push` is enough. The four
WashRoute apps don't change when only `website/` changes (the build-version hook ignores it).

## Where things live

| What | Where |
| --- | --- |
| Page builders | `website/api/_lib/pages.js` |
| Header, footer, page shell | `website/api/_lib/layout.js` |
| Routing, redirects, sitemap, robots | `website/api/render.js` |
| City list + which are open to Google | `website/content/cities.js` |
| Local content for open city pages | `website/content/city-details.js` |
| Topic pages (service, business type, how-to) | `website/content/topics.js` — add an entry, it gets a route, sitemap entry and footer link |
| Blog posts (5, from Wix, no dates) | `website/content/posts.json` |
| Styles | `website/assets/site.css` |
| Contact + quote forms | Supabase edge function `website-contact` (verify_jwt **false**) |
| Business info (phone, hours, Google rating, Gift Up id) | `site_info` table — Admin → App Content |
| Pickup windows per city | `route_templates`, read live via `site_public_values().zones` |
| Our own customer rating | `order_feedback`, via `site_public_values().ratings` |

## Pages

- **Homepage**, Services, Commercial (`/commercial-laundry`; old `/services-4` redirects), FAQ (from WashRoute),
  Service area, Community, Our story (`/blog`) + 5 posts at their old Wix addresses, Gift cards, Download,
  Privacy, Terms, Opt-out, Thank you.
- **23 city pages** at `/laundry-delivery-<city>`. **Open to Google (8):** San Francisco, Oakland, Berkeley,
  Alameda, San Leandro, Emeryville, Piedmont, Albany. These have local write-ups, neighborhoods (from where
  customers actually order), household counts, a photo, a review where one exists and city FAQs.
  **Hidden (15):** live for visitors, `noindex, follow`, left out of the sitemap. Open one by adding
  `index: true` once it has real local content; the sitemap updates itself.
- **12 topic pages** (2ULaundry pattern, from `content/topics.js`): Residential — comforters & bedding,
  delicates & air dry, shirt service, fragrance-free, apartments & condos, drop-off in Oakland; Commercial —
  daycares & schools, Airbnb hosts, gyms & studios, salons/spas/massage; Getting started — first order, leaving
  laundry out. Each has FAQ + Service markup and links to related pages. Plus **`/laundry-service-cost`**, a
  per-bag vs subscription table computed from the live price list.
- **About us** (`/about-us`, was a redirect to the homepage story): team, facility and electric-van photos
  (`team.jpg`, `facility.jpg`, `vans.jpg`), founders, AboutPage markup. Linked from the footer and homepage story.
- **Footer = link hub**: Get started / Residential / Commercial / Areas (the 8 open cities) / Company, built
  from `topics.js` and `cities.js`, so every page links to every important page.
- **Contact form** (every page) emails info@ with Reply-To = visitor and saves the message to the customer's
  WashRoute history when the email or phone matches. Commercial quote form on `/commercial-laundry`.
- **Gift cards**: Gift Up checkout (company id `2017a1d8-10dc-4d23-7124-08dc6b5e520e` in
  `site_info.giftup_site_id`). The Gift Up artwork says "same-day"; David chose to leave it.
- **Ratings**: "4.8 ★ on Google · 327 reviews" (from `site_info.google_rating/google_reviews`, update by hand)
  and "4.9 ★ from N customer ratings after delivery" (live, shown once there are 20+).

## Cutover from Wix (DNS)

Domain registered at **GoDaddy**; DNS currently run by **Wix** (ns6/ns7.wixdns.net).

- **DONE Mon Oct 5 (moved up from Tuesday):** Vercel DNS enabled for familylaundry.com (team LUCANINA / slug
  family-laundry). 25 records added and checked against live Wix DNS: 5 Google MX, 2 google-site-verification
  TXT, 3 `_dmarc*` TXT, `_twilio` TXT, 11 SendGrid + 3 ActiveCampaign CNAMEs. App subdomains need no records:
  they're on the `washroute` project in the same team, served by Vercel's automatic `@`/`*` ALIAS. Project
  `familylaundry-website` has www.familylaundry.com (primary) + familylaundry.com (308 → www).
- **DONE Mon Oct 5, 3:57 pm:** David switched GoDaddy nameservers to Vercel (registry showed NS1/NS2.VERCEL-DNS.COM
  at 3:58 pm). Vercel issued the www/apex certificate by 4:00 pm; site, redirects, sitemap (39 URLs) and
  admin/driver/pos all verified on Vercel. Resolvers drop the cached Wix answers within ~24h.
- **Was planned for Wednesday Oct 7, morning:** GoDaddy → Nameservers → ns1.vercel-dns.com, ns2.vercel-dns.com. Then: test
  email to info@, open app/admin/driver/pos, load the site, confirm SendGrid domain auth still verified,
  submit `https://www.familylaundry.com/sitemap.xml` in Search Console, request indexing of the SF, Oakland
  and Berkeley pages.
- **Rollback:** set GoDaddy nameservers back to ns6/ns7.wixdns.net. Keep Wix paid for 30 days.

Records to copy: Google Workspace MX (5); TXT: 2 × google-site-verification, `_dmarc`, `_dmarc.mail`,
`_dmarc.news`, `_twilio`; SendGrid CNAMEs: `em6523`, `sg._domainkey`, `sg2._domainkey`, `em3250`, `em3739`,
`s1/s2._domainkey.mail`, `em5898.mail`, `s1/s2._domainkey.news`, `em408.news`; ActiveCampaign (likely
unused, copied anyway): `acdkim1/acdkim2._domainkey`, `em-2342381`; apps: `app`, `admin`, `driver`, `pos`
→ cname.vercel-dns.com; `@` + `www` → the website project.
**Not copied:** Wix email (`s1/s2/sel1/sel2._domainkey`, `sg`), Wix A records + www, and all Klaviyo records
(Klaviyo no longer used).

## SEO baseline (Search Console, Jul 4 – Oct 3, 2026)

1,890 clicks, 46.3K impressions, average position 12.2. About 4 in 5 visible-query clicks are brand searches.
Non-brand ≈ 77 clicks/month. Oakland ~#5 on core searches; Berkeley #11–12; San Francisco #12–15 with
0 clicks. Goal: non-brand clicks 160+/month within 90 days of launch. Full audit and plan in the SEO doc.

## Open items

- [ ] Tuesday/Wednesday cutover (above)
- [ ] Google Business Profile name "Family Laundry: Premium Wash & Fold Delivery" breaks Google's no-tagline
      rule — David to decide
- [ ] More Google reviews quoted on city pages (David to paste favorites that mention a city)
- [ ] Open the 15 hidden city pages a few a week as they get local content
- [ ] SF and Oakland neighborhood pages (2ULaundry has ~90; ours need real local content first)
- [ ] PARKED Oct 5 (David likes it, not now): "Neighborhood Laundry Day" — one discounted pickup day per ZIP.
  Why: Monday has 2–3x the pickups of Tue/Thu in most ZIPs; same-day neighbors = denser routes. Open choices:
  discount (free delivery vs $5), subscribers, pilot ZIPs (e.g. 94610, 94611, Alameda).
- [ ] App store links (`site_info.app_ios_url`, `app_android_url` empty)
- [ ] Admin → App Content editor for FAQ + site info (phase 1 of the original plan)

## Log (oldest first)

- **Sep 17, 2026 (session 299):** first build of `website/`, shared FAQ content in WashRoute; not deployed.
- **Oct 5, 2026:** finished and launched to preview.
  - New headline/positioning, launch-checklist fixes, 23 city pages, blog moved, contact + quote forms
    (`website-contact` edge function, deployed and redeployed by David), Vercel project created.
  - Migration `session_332`: `zones` added to `site_public_values()` (live pickup windows).
  - Homepage rebuilt in the original Wix look at David's request; headline back to "Wash & Fold for Busy
    Households".
  - SEO audit vs Rinse and Mulberrys; plan doc written. Only 8 strong city pages open to Google; sitemap
    lists only open pages.
  - Google rating badge (4.8 / 327) added; Google-rating markup removed; migration `session_332b` adds
    `ratings` (our own `order_feedback`) and the site marks that up instead.
  - Gift Up checkout live on `/gifts-cards`.
  - Note: rapid automated Google searches from David's browser triggered a Google "not a robot" check;
    measure rankings through Search Console instead.
  - 2ULaundry (Houston) studied: they win with many narrow pages (one per service, business type, question and
    neighborhood) tied together by a big footer. Added 12 topic pages, the cost page and the footer hub;
    sitemap now 38 pages (was 25).
  - About us page added with David's team, facility and van photos. Bag-on-deck photo (`bag-deck.jpg`) on
    About us and the comforter, first-order and leaving-laundry-out pages (topic `photo` field).
  - Design critique fixes: dark text on yellow buttons (white failed contrast at 1.5:1), "Book" button in the phone
    header, blue "Book one bag" / "Subscribe" buttons under the prices, same-day shown as +surcharge everywhere,
    Google rating as the headline with Yelp + own ratings smaller, contact Send button in the standard style.
