# familylaundry.com (website)

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
- City pages: one per entry in `content/cities.js` → `/laundry-delivery-<slug>` (old Wix URLs kept). Pickup windows
  render live from `site_public_values().zones` (session 332), never typed.
- Blog: `content/posts.json` (copied from Wix Oct 5, 2026), `/blog` = "Our story", `/post/<slug>`, no dates.
- Forms: contact (every page) + commercial quote (`/commercial-laundry`, old `/services-4` 301s) post to the
  `website-contact` edge function (verify_jwt false): emails info@ and saves to the matching customer's history.
- Google rating badge appears when `site_info` has `google_rating` + `google_reviews` (+ optional `google_reviews_url`).

## Not done yet
- Google rating badge: add `google_rating`, `google_reviews`, `google_reviews_url` to site_info.
- Gift Up widget on `/gifts-cards` — needs the Gift Up company id
- App store links (`site_info.app_ios_url`, `app_android_url` are empty)
- Vercel project (Root Directory `website`) + domain switch. DNS is run by Wix today (GoDaddy registrar);
  every record must be recreated in Vercel DNS before the nameserver change. Checklist in the plan doc:
  https://claude.ai/code/artifact/02c6f193-aad5-4b26-a664-507348cb464f
