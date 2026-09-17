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

## Not done yet
- Admin → App Content editor (edit FAQ + site info) — phase 1
- Contact / commercial quote forms (mailto for now) — phase 4
- Blog (5 posts; `/blog` and `/post/*` redirect home for now) — phase 4
- Gift Up widget on `/gifts-cards` — needs the Gift Up company id
- App store links (`site_info.app_ios_url`, `app_android_url` are empty)
- Domain switch — phase 5, see the migration plan doc. Do NOT touch DNS without the checklist.
