# WashRoute — Technology Stack

*Last updated: February 2026*

---

## Infrastructure

| Technology | What It Does |
|---|---|
| **Supabase** | The backbone of the whole app. Stores all data — customers, orders, routes, drivers, services — in a PostgreSQL database. Also handles user login/authentication for all three apps, and runs Edge Functions (small server-side scripts used for things like payments). |
| **Vercel** | Hosts the three web apps (customer app, admin dashboard, driver app) on the internet at `washroute.vercel.app`. Connected to GitHub so every push automatically goes live within 30 seconds. |
| **GitHub** | Version control and backup. Every code change is saved here with a history of what changed and when. Acts as the source of truth that Vercel deploys from. |

---

## Frontend Libraries (built into the apps)

| Technology | What It Does |
|---|---|
| **Chart.js** | Renders the charts on the admin Reports page — bar charts for revenue over time, donut chart for orders by status, horizontal bar chart for route performance. |
| **Leaflet.js** | Powers the interactive maps in the admin dashboard — the customer location map, the live route tracking map, and the delivery zone view. |
| **Leaflet Draw** | An add-on to Leaflet that allows drawing custom shapes directly on the map. Used in the admin dashboard to define delivery zones. |

---

## External Services — Active

| Technology | What It Does |
|---|---|
| **Google Maps** | Provides turn-by-turn navigation for drivers. When a driver taps "Navigate" on a stop, it opens Google Maps with the customer's address pre-filled. No account or API key required — uses a standard directions link. |

---

## External Services — Coming Next

| Technology | What It Does |
|---|---|
| **Stripe** | Handles all customer payments. Will power one-time order payments (customer pays for a pickup/delivery) and recurring subscription billing (Basic, Standard, Premium monthly plans). Stripe stores card info securely — no card data ever touches our app. |
| **Twilio** | Will send automated SMS text messages to customers — for example: "Your laundry has been picked up" or "Your order is out for delivery." |

---

## The Three Apps

| App | URL | Who Uses It |
|---|---|---|
| Customer App | `washroute.vercel.app` | Customers — place orders, track status, manage subscription |
| Admin Dashboard | `washroute.vercel.app/admin` | You — manage customers, orders, routes, view reports |
| Driver App | `washroute.vercel.app/driver` | Drivers — see their route, navigate to stops, mark pickups/deliveries complete |

---

## How It All Connects

```
Customer App  ─────┐
Admin Dashboard ───┼──▶  Supabase (database + auth)  ◀──▶  Stripe (payments)
Driver App  ───────┘              │                          Twilio (SMS)
                                  │
                              Vercel (hosting)
                                  │
                              GitHub (code backup)
```
