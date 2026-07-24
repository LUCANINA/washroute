# WashRoute — Thin-Slice Scope: Staging Environment + Config Decoupling

*Scoped July 16, 2026. Purpose: the internal-only slice of "productization" worth doing even if we never sell WashRoute as SaaS. The prize is a safe staging environment; the config work is the same first step the SaaS path would need, so it's never wasted.*

---

## Goal & non-goals

**Goal:** a place to test migrations, SMS-template changes, and bulk operations against real-shaped data with **zero risk of texting or charging real customers** — plus centralize the few connection/brand constants so a second location or an eventual sale stays cheap and possible.

**Non-goals (skip until/unless we sell):** per-tenant isolation, white-label branding UI, self-serve signup, SaaS billing. None of that serves the internal business.

---

## What's already decoupled (do NOT redo)

A quick audit shows WashRoute is already more portable than a typical single-tenant app:

- **Business data is in the database, not code** — pricing, tax rate, and sites live in the `services` / `settings` / `sites` tables. No hardcoded prices to extract.
- **Secrets are in Supabase, not the client** — Twilio number/auth and Stripe keys live in Supabase Secrets and edge-function env, not in the four `index.html` files.
- **Brand is in image assets** — the "Family Laundry / Oakland CA" wordmark is baked into the logo *images* under `/assets`, referenced by path. Swapping brand = swapping files, not editing code.
- **Connection is a single const pair per app** — each app defines `SUPA_URL` + `SUPA_ANON_KEY` once (e.g. admin at ~line 5310) and every query and edge-function call reads those consts. So pointing an app at a different backend is a **one-place change**, not a find-and-replace.

The practical takeaway: the client barely needs touching. The work is standing up the staging backend and guaranteeing it can't reach real customers.

---

## Track A — Staging environment (the priority) · ~2–3 days

**A1 · Environment switch in each app** (~½ day)
Replace the two hardcoded `SUPA_URL` / `SUPA_ANON_KEY` consts (in all four apps: admin, customer, driver, POS) with a tiny resolver that picks **prod vs staging** by hostname — e.g. a `staging.` subdomain or `localhost` resolves to the staging keys, everything else to prod. Every existing `SUPA_ANON_KEY` / `db` reference keeps working unchanged because they already read the const.

**A2 · Stand up the staging backend** (~½–1 day)
Two options, pick per need:
- *Supabase branch* (lightweight, ephemeral) — good for testing a single migration in isolation; spins up a clone of the DB, tear down after. Cheapest for "will this migration break anything?"
- *Dedicated staging project* (persistent) — a second Supabase project that mirrors the schema (apply the migration history) and has all edge functions deployed. Better for ongoing end-to-end testing of SMS/booking/billing flows.
Recommendation: dedicated staging project for the real value; use branches ad-hoc for one-off migration checks.

**A3 · Outbound safety kill-switch (the whole point)** (~½–1 day)
Guarantee staging can never contact a real person or move real money:
- Staging Twilio → a test number or disabled; Stripe → **test-mode keys**.
- Add a global "non-production" guard inside the SMS and charge edge functions that **hard-refuses** any real send/charge when running against staging (belt *and* suspenders — don't rely on config alone).
- Verify with the preflight mindset before trusting it. This item is why the whole slice is worth doing.

**A4 · Seed staging with safe data** (~½ day)
Load a small, **anonymized** subset of prod (scrub names / phones / emails) or a synthetic seed, so tests are realistic without exposing real customer PII in a second system.

**A5 · Deploy staging front-end + document the flow** (~½ day)
A staging subdomain / Vercel preview pointed at staging via the A1 switch. Update the `washroute-test` skill to run against **staging** instead of the live instance, and write the short "how to test safely" runbook.

---

## Track B — Config centralization (nice-to-have) · ~1 day

**B1 · One small `WR_CONFIG` block per app** (~½ day)
A single object holding the env resolver (from A1) plus any stray constants worth naming (support email, `BIZ_TZ`, brand text if any). Point scattered references at it. Note: `BIZ_TZ = 'America/Los_Angeles'` is fine hardcoded while we're one region — only worth parameterizing if a second-timezone location opens.

**B2 · Stray-literal audit** (~½ day)
Grep for any leftover project-id / URL / phone-number literals that would bite a second location or a provider migration, and fold them into `WR_CONFIG`. Confirm nothing else is welded to the current Supabase project.

---

## Order, effort, and payoff

**Do first (safety-critical):** A1 (env switch) → A3 (kill-switch). Nothing else matters if staging can text real customers.
**Then:** A2 → A4 → A5 for a usable staging environment; Track B is polish.

**Total: ~3–5 days at your pace.**

**Payoff, even if we never sell:**
1. A real staging environment retires the scariest production-incident class — the accidental mass-SMS that the preflight skill exists to prevent. Test migrations and SMS changes for real, safely.
2. Provider/portability insurance — the app stops being welded to one Supabase project.
3. Optionality kept cheap — a second location, a one-off license to a laundry owner you know, or a future sale all stay possible.
4. Zero waste — this is the exact same first step the multi-tenant SaaS path needs, so if you later decide to sell, none of it is thrown away.
