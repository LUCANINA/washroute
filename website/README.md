# familylaundry.com (website)

Project notes, decisions, publishing steps and DNS cutover: `../PROJECT-NOTES-WEBSITE.md`.

Server-rendered website for Family Laundry, replacing Wix. Separate Vercel project
with **Root Directory = `website`**. No build step, no dependencies.

- `api/render.js` — renders every page (Vercel rewrites all non-asset URLs to it).
  Pages are cached at the edge for 5 minutes. Preview hosts get `noindex`; only
  `familylaundry.com` / `www.familylaundry.com` are indexable.
- `api/_lib/pages.js` — page builders. URLs match the old Wix site exactly.
- `api/_lib/data.js` — reads `site_public_values()`, `faq_topics`, `faq_items`
  from Supabase with the public (anon) key.
- `assets/fl-content.js` — shared content renderer (tokens + light markdown), also
  meant for the customer app and admin editor.
- `content/wix-export.json` — text exported from Wix (legal, community, city pages).

## Live tokens (never type a price)
`{price:Wash & Fold}` `{retail:…}` `{commercial:…}` `{fee:Delivery Fee}`
`{plan:price|lbs|overage}` `{referral:friend|referrer}` `{site:phone}` `{zones:cities}`

## Pages
- Gift cards: Gift Up checkout on `/gifts-cards`, company id in `site_info.giftup_site_id`.
- Ratings: Google badge from `site_info.google_*`; our own after-delivery ratings (`order_feedback`, via
  `site_public_values().ratings`) are shown and marked up for Google (never Google's numbers in markup).
- City pages: one per entry in `content/cities.js` → `/laundry-delivery-<slug>` (old Wix URLs kept). Pickup windows
  render live from `site_public_values().zones` (session 332), never typed.
- Blog: `content/posts.json` (copied from Wix Oct 5, 2026), `/blog` = "Our story", `/post/<slug>`, no dates.
- Forms: contact (every page) + commercial quote (`/commercial-laundry`, old `/services-4` 301s) post to the
  `website-contact` edge function (verify_jwt false): emails info@ and saves to the matching customer's history.
- Google rating badge appears when `site_info` has `google_rating` + `google_reviews` (+ optional `google_reviews_url`).

## Not done yet
- App store links (`site_info.app_ios_url`, `app_android_url` are empty)
- Vercel project (Root Directory `website`) + domain switch. DNS is run by Wix today (GoDaddy registrar);
  every record must be recreated in Vercel DNS before the nameserver change. Checklist in the plan doc:
  https://claude.ai/code/artifact/02c6f193-aad5-4b26-a664-507348cb464f
