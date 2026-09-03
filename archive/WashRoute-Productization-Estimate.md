# WashRoute — Productization Estimate & Pricing Strategy

*Prepared July 16, 2026. Planning estimate only — figures are rough ranges to guide decisions, not a fixed quote or financial advice.*

**Assumptions (from your answers):** you build it yourself with AI assistance (as WashRoute is built today), you're targeting a mix of laundry businesses, and — updated — your preferred destination is a **true multi-tenant SaaS that's open to all, including self-serve customers**, investing more up front to get there.

**Velocity note:** you got WashRoute live in ~3 weeks. That's a real data point, and I've recalibrated the numbers below to your pace — the earlier estimate was too conservative. One honest caveat to keep in mind: "3 weeks to live" got a working v1 running for *your own* business, where you control the data and tolerate rough edges; the depth it has now (subscriptions, POS, KPIs, holidays, credit ledger) accreted over ~4 more months. Multi-tenant-for-strangers has the same shape — a fast first-live, then a hardening tail — but the tail matters more here, because the failure mode is one laundry seeing another's data.

---

## Bottom line up front

Since the goal is **self-serve, open to all**, the destination is a **true multi-tenant SaaS**: one shared system where every laundry signs up, sees only its own data, connects its own phone number and payment account, and pays you a subscription. You can't hand-provision a separate instance for every self-serve signup, so the up-front investment in shared infrastructure is the right call.

Recalibrated to your demonstrated pace (~3 weeks to a live app):

- **To a private multi-tenant beta** (self-serve signup works; you hand-hold the first few tenants; not yet open to the public): roughly **4–7 focused weeks**, ≈ **1.5–2.5 months** calendar part-time.
- **To a public self-serve launch** (hardened tenant isolation, automated Twilio + Stripe onboarding, SaaS billing, security-audited): **~2–4 months** calendar total, part-time.
- **Then continuous iteration**, the same tail WashRoute itself had.

**What genuinely doesn't compress, even at your speed** (plan around these — they're external or high-stakes):
1. **Tenant-isolation security** — one gap and a laundry sees another's customers/revenue. Needs a dedicated audit before you open the doors; budget for an external review.
2. **Twilio A2P 10DLC per tenant** — every business must register to send SMS; weeks of lead time each. Automate the request on signup, but you can't remove the wait.
3. **Stripe Connect + SaaS billing edge cases** — trials, upgrades, failed payments, and routing each tenant's customer payments to *them* while you take a platform fee.
4. **Support shifts shape** — self-serve means everyone hits a bug at the same time with no one holding their hand, so the app has to be more self-explanatory and resilient than a tool you personally operate.

There's a fast-path option too: a **1–2 week per-instance shortcut** to get a first paying customer live *while* you build the real multi-tenant system in parallel. It's covered at the end as "Path A" — optional, purely to earn revenue and gather feedback during the build.

---

## Where WashRoute is today (your head start)

A lot of the hard product work is already done, which is why this is measured in weeks, not years:

- Four working apps (admin, driver, customer, POS) that a real business runs on daily.
- Deep operational logic already built and battle-tested: routing, subscriptions, SMS automation, billing/Stripe, POS with card reader, reporting/KPIs, holidays, credit ledger, issue tracking.
- **Multi-site already exists** (23rd Ave + Foothill) — you've already proven the app can run more than one location. That muscle extends toward multi-customer.
- Clean-ish separation in places that matter: brand assets live in `/assets`, colors are CSS variables, secrets live in Supabase (not hardcoded in most places), and database logic is centralized in triggers/RPCs.

What's **single-tenant today** and needs work: the Supabase project ID + keys are hardcoded in each app, the Twilio number and Stripe account are one shared set, the brand name ("Family Laundry / Oakland CA") is baked into the wordmark, and there's one deployment.

---

## The multi-tenant build — work breakdown

Recalibrated to your pace. Ranges are "focused weeks of effort"; calendar time runs longer since you're also operating the laundry. The order matters — isolation and auth come first because everything else sits on top of them.

**1 — Tenant model & data isolation · ~2–4 weeks (the core)**
Add an `org_id` (tenant) to every table, backfill your existing data as tenant #1, and enforce database security rules (RLS) so every read and write is automatically scoped to the logged-in user's org. Then make every trigger, RPC, and cron job tenant-aware. This is the biggest and highest-stakes chunk because WashRoute is logic-heavy in the database — but it's also mechanical, which is exactly where AI assistance shines. **Must be security-audited before launch.**

**2 — Auth & tenant context · ~1 week**
Sign-up creates an org; each user belongs to one org; the app reads the org from the logged-in user and scopes everything to it. Your role system (admin / manager / driver / attendant / POS) already exists — it just gains an org boundary around it.

**3 — Self-serve onboarding wizard · ~1.5–3 weeks**
The UI that replaces your white-glove steps: create business → set service area and zones → set pricing → connect phone (Twilio) → connect payments (Stripe) → invite drivers. This is net-new product, but each step mirrors something WashRoute already does internally.

**4 — Automated integrations · ~2–3 weeks (+ external lead time)**
Programmatic Twilio provisioning (subaccount + A2P registration kicked off automatically on signup) and Stripe Connect (each tenant's customer payments flow to *them*; you take a platform fee). The code is bounded; the Twilio A2P *approval wait* is the external gate you can't code away.

**5 — SaaS billing · ~1–2 weeks**
A Stripe subscription for the product itself: plans, free trial, upgrade/downgrade, failed-payment dunning. You already know this machinery from building it into WashRoute — you're reusing patterns, not learning them.

**6 — White-label per tenant · ~1 week**
Per-tenant logo, colors, business name, and a subdomain (e.g. `acme.washroute.app`). Your brand assets already live in `/assets` and colors are already CSS variables, so this is mostly plumbing config through.

**7 — Security hardening + audit · ~1–2 weeks (don't skip)**
A dedicated pass — and ideally an external review — proving no tenant can reach another's data through any query, RPC, edge function, or API path. This is the one line item where "move fast" is the wrong instinct.

**8 — Operator console, monitoring, backups, support · ~1–2 weeks**
A dashboard to see all tenants' health (your audit skill, run across orgs), error monitoring, per-tenant backups, and a basic support/status setup for when self-serve users hit issues.

**Rollup at your pace:** private multi-tenant beta ≈ **4–7 focused weeks**; public self-serve launch ≈ **2–4 months** calendar, part-time. Steps 1, 2, and 7 are the ones that decide whether you can sleep at night — give them room.

---

## Pricing strategy

### The levers you can pull

- **Flat monthly subscription (tiered)** — predictable, easy to sell. The backbone.
- **One-time setup / onboarding fee** — white-glove setup is real work (Twilio, Stripe, data import, training). Charge for it. Also filters out non-serious prospects.
- **Usage pass-through** — SMS (Twilio) and card processing (Stripe) are real costs. Pass them through at cost, or add a modest markup as a revenue line.
- **Percentage of volume (GMV)** — take a small cut of what flows through the platform (e.g., via Stripe Connect). Aligns your revenue with their growth; best reserved for larger accounts.

### Recommended tiers

| Tier | Best for | What's included | Monthly | One-time setup |
|---|---|---|---|---|
| **Basic** | Single-location / starter | Admin dashboard, customer booking app, driver app, SMS reminders, standard reporting. 1 location, up to ~2 drivers. | **$149–$249** | **$500–$1,000** |
| **Pro** | Mid-size delivery laundry (your profile) | Everything in Basic + route optimization, subscriptions, POS + card reader, multi-site (up to 3), KPI/retention reports, priority support. | **$349–$699** | **$1,000–$2,500** |
| **Custom / Enterprise** | Franchise / multi-location | Unlimited sites, white-label domain, custom integrations (e.g. Xero), custom pricing models, dedicated support / SLA. | **From $900** (or 1–2% of GMV) | **$2,500+** |

On top of any tier: **SMS and payment processing passed through** (at cost, or with a small markup). For Custom accounts, a **% of GMV** often earns more than a flat fee as they grow. With self-serve signup, add a **free trial** (e.g. 14 days) as the top of the funnel.

### A note on your economics (self-serve changes this)

With white-glove, your constraint was *your time*, which pushed you toward a few high-value customers. **Self-serve lifts that ceiling** — the automated onboarding wizard means a Basic customer can sign themselves up without costing you a day of setup, so the low-touch **Basic tier finally makes sense as a volume play**, not just a funnel. Two revenue shapes now coexist: a **long tail of self-serve Basic/Pro** accounts that scale without your time, plus **hand-sold Custom** accounts where you still add white-glove value. Rough feel: 40 self-serve accounts averaging ~$250/mo ≈ **$10k/month recurring** with little marginal effort per account — the payoff for the bigger up-front build. The flip side: self-serve support is diffuse and constant, so budget for help (docs, in-app guidance, maybe a part-time support person) before you scale the tail.

---

## Suggested sequencing

1. **Build isolation + auth first (steps 1–2)** and re-onboard your own WashRoute data as tenant #1. If your live business runs cleanly *as a tenant*, the hardest part is proven.
2. **Get to a private beta** — self-serve signup working, but invite-only. Onboard 1–2 friendly laundries by hand through the new wizard to shake out the flow. Start their Twilio registration immediately (it's the long pole).
3. **Security-audit before you open the doors (step 7).** Treat the external review as a launch gate, not a nice-to-have — one isolation gap undoes everything.
4. **Launch self-serve** with a free trial + the three tiers. Set final pricing once the beta tells you your true support load per account.
5. **Instrument and iterate** — the same continuous-improvement loop WashRoute already runs on, now watching signup conversion, trial-to-paid, and churn.

---

## Path A — the per-instance shortcut (optional, for revenue during the build)

If you want cash flow and real-world feedback *before* the multi-tenant system is ready, you can stand up a first paying customer the quick way in parallel: **clone WashRoute as a separate instance** (their own Supabase project + deploy) and make the hardcoded bits — Supabase keys, Twilio number, Stripe account, brand name, logo, pricing — configurable. That's a **~1–2 week** decouple, then a per-customer onboarding you do by hand.

It's throwaway-ish scaffolding relative to the real product, but not wasted: the config extraction (pulling hardcoded values out into settings) is work the multi-tenant build needs anyway, and a live external customer is the best possible source of "what did I forget." Just don't over-invest in per-instance tooling (provisioning scripts, cross-instance migration runners) — that's effort the multi-tenant system makes obsolete. Use Path A to learn and earn; build Path B to scale.
