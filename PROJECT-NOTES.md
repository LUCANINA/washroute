# Family Laundry — Project Notes
*Last updated: Feb 24, 2026*

---

## What We're Building

Three connected web apps, one shared database. Focused on **delivery first** (retail/drop-off in a later phase).

| App | URL (planned) | Who uses it |
|---|---|---|
| Admin Dashboard | admin.yourdomain.com | Owner + managers |
| Customer App | app.yourdomain.com | Customers |
| Driver App | driver.yourdomain.com | 9+ drivers |

---

## Services Offered
- Wash & Fold (by weight)
- Shirt Service (per item)
- Hang Dry / Delicates (special handling)
- Monthly Subscription — flat fee, unlimited pickups

---

## Full Integration Stack

| Tool | Purpose | Status |
|---|---|---|
| Supabase | Database + authentication | 🔲 Setting up |
| Stripe | Subscriptions + payments | 🔲 Pending |
| Twilio | Transactional SMS + 2-way inbox | 🔲 Pending |
| SendGrid | Transactional email + inbound parsing | 🔲 Pending |
| Klaviyo | Marketing broadcasts + segments | 🔲 Pending |
| Google Maps | Driver navigation + live tracking | 🔲 Pending |
| Google Route Optimization API | Auto-sort route stops | 🔲 Pending |
| Xero | Accounting sync | 🔲 Pending |
| Vercel | App hosting | 🔲 Pending |

---

## Key Features

### Admin Dashboard
- Customer management (lifetime value, repeat rate, at-risk flagging)
- Order management with status pipeline
- Route builder with auto-optimization
- Driver assignment
- Unified inbox (SMS + email from customers)
- Reports: revenue, driver performance, retention/churn, service mix

### Customer App
- Sign up + login
- Choose subscription plan
- Set pickup address + preferences (detergent, folding, special instructions)
- Schedule on-demand pickups
- View order history
- Manage subscription (upgrade, pause, cancel)
- Live driver tracking link

### Driver App
- Daily route loads automatically
- Per-stop details (customer, address, order type, special instructions)
- One-tap Google Maps navigation
- Mark pickup / delivery complete
- Triggers SMS to customer on completion

---

## Build Order
1. ✅ Prototype dashboard designed
2. 🔲 Supabase account + database schema
3. 🔲 Admin dashboard (live data)
4. 🔲 Customer app
5. 🔲 Driver app
6. 🔲 Reports module
7. 🔲 Inbox (SMS + email)
8. 🔲 Klaviyo marketing integration
9. 🔲 Xero accounting sync
10. 🔲 Live driver tracking

---

## Folder Structure
```
WashRoute/
├── admin-dashboard/       # Dashboard app files
│   └── dashboard-prototype.html
├── customer-app/          # Customer-facing app files
├── driver-app/            # Driver app files
├── database/              # Schema, migrations, seed data
├── assets/                # Logos, icons, images
└── PROJECT-NOTES.md       # This file
```
