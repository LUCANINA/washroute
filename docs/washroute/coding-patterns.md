# WashRoute — Coding Patterns

*Split out of the `washroute` skill 2026-09-02. CSS variables, brand assets, JS conventions, POS i18n, refunds, receipts, timezone rules, route stops, order status pipeline.*

## Coding Patterns

### CSS Variables (use these, never hardcode colours)

**Two palette identities — DO NOT mix them across apps:**

```
admin-dashboard / customer-app / driver-app
  --accent: #3b82f6 (admin) or #635bff (customer-app, driver-app)
  --gray-50 / ... / --gray-900
  --green / --green-light, --red, --amber, --radius: 10px

pos/index.html (session 137 migration — blue everywhere, no purple)
  --accent:       #3b82f6   (blue — interactive chrome + primary actions)
  --accent-dark:  #1d4ed8
  --accent-light: #dbeafe
  --brand-navy:   #0f2744   (matches admin --sidebar-bg)
                            used for primary dark surfaces ONLY:
                            .tab.active, .walk-in-btn, .pay-total,
                            .flow-btn.active. NOT for text — text uses
                            --gray-900 (#111827) for legibility on light
                            backgrounds.
  --info-blue family       legacy alias of --accent (same hex). Future
                            cleanup can collapse, but anything still
                            referencing it works correctly today.
```

**Color discipline — applies across all four apps:**
- `--accent` family: interactive chrome (hover/focus/active), primary actions
- `--brand-navy`: primary dark surfaces ONLY (POS only at the moment)
- `--green` / `--green-light`: STATUS only (connected, success, paid).
  Never as a primary action color — actions use --accent.
- `--amber` / `--red`: warning / error STATUS only. Never decorative.

**Lesson from session 137 POS theming pass:** when David asked for "no
purple anywhere" in the POS, the fix was a single-line change at the
`:root` `--accent` variable. Every existing `var(--accent)` reference
cascaded automatically. **Define accent ONCE at the root and let the
cascade do the work — never hardcode hex values in component CSS.** Any
component that hardcodes a brand hex (the prior `.charge-btn { background:
var(--green); }` was the worst offender) won't follow theme migrations.

### Brand assets (session 137)

Brand wordmark + iconography lives at `/assets/`. Same path resolves from
any of the four apps via `../assets/...` (relative to their index.html
locations: `/admin-dashboard/`, `/customer-app/`, `/driver-app/`, `/pos/`).

| File | Use |
|---|---|
| `assets/logo_white_bg.png` | Dark navy wordmark on white background — use in light topbars. POS topbar uses this at 48px tall. |
| `assets/logo_white.png` | White wordmark on transparent — use on dark backgrounds. |
| `assets/logo_dark.png` | Dark navy wordmark on navy background. |
| `assets/logo_sidebar.png` | Small/cropped variant, optimised for sidebars (~5KB). |
| `assets/icon-customer.png` etc. | Per-role app icons (mobile/PWA). |

The wordmark text bakes in "Family Laundry / Oakland CA" — per-location
labels (Foothill, Berkeley, etc.) are surfaced via the site selector or
device-name fields, not the brand mark.

### JS Conventions
- `db` = Supabase client (already initialised globally)
- `SUPA_URL` and `SUPA_ANON_KEY` are global constants
- `showToast(msg, type)` — use for all user feedback ('success' | 'error' | '')
- `fmtDate(d)`, `fmtMoney(n)`, `fmtTime(d)` — use these helpers, don't reformat inline
- `allOrders`, `allCustomers`, `allDriversCache` — cached arrays, update after mutations
- Status badges: use `statusBadge(status)` helper
- `esc(s)` — HTML-escape any DB-sourced string before stitching into `innerHTML` template literals. Defined in admin-dashboard (~line 11659) and POS (added session 139). Mandatory anywhere customer name / order description / item label flows into innerHTML — those are user-controlled inputs that can carry HTML.

### POS i18n (`pos/index.html`, session 139)
- `_lang` state (module-level, persisted in `localStorage('wr-pos-lang')`). English is the source of truth.
- `t(en)` → returns Spanish if `_lang === 'es'` and the key is in `TRANSLATIONS_ES`, else returns English. Missing keys are NOT bugs — they fall through to English.
- `applyTranslations()` walks `[data-i18n]` (text), `[data-i18n-placeholder]`, `[data-i18n-title]` selectors. Captures the original English text on first run via `dataset.i18nOriginal` so flipping back is lossless.
- Static markup: tag with `data-i18n` (text content) / `data-i18n-placeholder` / `data-i18n-title`. Selectors are exact-match — `data-i18n` does NOT match `data-i18n-title`.
- Dynamic JS: wrap user-visible strings in `t(...)`. Toasts, template literals, textContent assignments, modal subtitle text built dynamically.
- DB-sourced strings (services.name, merchandise.name, customer names, order descriptions) intentionally NOT translated — pricelist content + customer data, not UI chrome.

### POS refund accumulator (`orders.amount_refunded`, session 139)
- `NUMERIC(8,2) NOT NULL DEFAULT 0`. Backfilled from `customer_transactions` refund rows.
- Compute remaining refundable as `total_amount + tip_amount - amount_refunded`. The edge function `refund_pos_payment` (stripe-terminal v9) reads, validates, and writes this column atomically per request.
- `billing_status='refunded'` only flips when fully refunded; partial refunds leave it as `'paid'` and rely on the accumulator for source-of-truth. Admin UI consumers should READ `amount_refunded`, not infer from `billing_status`.

### Receipt / invoice rendering — always query `customer_transactions` (session 150)

When rendering ANY receipt or invoice (admin printInvoice, customer email via `send-receipt`, POS thermal markup, POS HTML fallback, monthly statements), **never trust `order.total_amount` as "what was charged on the card."** The order's total is the gross value of services. When account credit was applied via `apply_customer_credit_to_order`, the card was only charged `total_amount - credit_use`. Every receipt path must:

1. Fetch `customer_transactions` for the order_id with `type = 'credit_use'` and sum the amounts → `creditApplied`.
2. Render a green "Account credit applied −$X" line under subtotal when `creditApplied > 0`.
3. Show the PAID amount as `chargedTotal - creditApplied` (matches the customer's bank statement), not the gross total.
4. Special-case `billing_payment_method = 'credit'` (fully-credit path): skip the split, keep the single "(Account Credit)" label.

Session 150 patched three paths (`admin/printInvoice`, `send-receipt` v31, `pos/buildPosReceiptMarkup` + HTML fallback). The bulk monthly INVOICE generators (`generateInvoiceHTML`, `buildInvoicePdfBase64`) don't have PAID lines so they're invoice-only and unaffected, but if you ever add a payment status to those, follow the same pattern.

**The invariant:** `Grand Total = creditApplied + cardPaid` always. If your receipt math doesn't balance to this, it's lying to the customer.

### TIMEZONE RULES (mandatory — enforced session 67)
All three apps define `const BIZ_TZ = 'America/Los_Angeles'`. Edge functions use the string directly.

**EVERY date/time formatting call MUST include `timeZone: BIZ_TZ`.** No exceptions. This was the source of 45+ bugs fixed in session 67 — wrong dates in SMS, reports shifting by a day after 5 PM Pacific, booking flow showing tomorrow instead of today. JavaScript's `Date` silently uses UTC or browser locale depending on the method, and after 5 PM Pacific, UTC rolls to the next calendar day.

| BANNED pattern | USE INSTEAD |
|---|---|
| `toISOString().split('T')[0]` | `toLocaleDateString('en-CA', {timeZone: BIZ_TZ})` |
| `toLocaleDateString()` (no options) | `toLocaleDateString('en-US', {timeZone: BIZ_TZ})` |
| `toLocaleTimeString()` (no timeZone) | `toLocaleTimeString('en-US', {timeZone: BIZ_TZ})` |
| `toLocaleString()` (no timeZone) | `toLocaleString('en-US', {timeZone: BIZ_TZ})` |
| `new Date().getHours()` for business logic | Convert via `toLocaleString('en-US', {timeZone: BIZ_TZ, hour12: false})` then parse |
| Hardcoded UTC offsets (`-07:00`, `-08:00`) | Dynamic offset via Intl (see optimize-route for pattern) |

If you write ANY date formatting code in ANY WashRoute file, check it against this table before committing. If a `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` call doesn't have `timeZone` in its options, it's a bug.

**Pacific helper library (session 134) — use these instead of inlining TZ math:**

In **admin-dashboard**, near `today()`:
- `addDaysPacific(iso, n)` — DST-safe Pacific date arithmetic on YYYY-MM-DD strings
- `pacificOffsetStr(iso)` — returns `'-07:00'` or `'-08:00'` for the given Pacific date
- `pacificDayStart(iso)` / `pacificDayEnd(iso)` — Date instants at Pacific 00:00 / 23:59:59.999. Use for query filter boundaries.

In **customer-app**, near `localIso()`:
- Same `addDaysPacific` and `pacificOffsetStr`.
- `pacificMinutesOfDay(iso)` — extract hour+min as minutes-of-day via `Intl.DateTimeFormat`. **Use this instead of `new Date(toLocaleString(...))` round-trips**, which silently corrupt on non-Pacific browsers.
- `pacificIsoFromMins(date, mins)` — build an ISO timestamp at a Pacific-local time-of-day. **Use this instead of `new Date(`${date}T${HH}:${MM}:00`).toISOString()`** — the no-offset pattern interprets as browser-local and silently writes wrong UTC to the DB.

Session 134 patched 16 sites across admin + customer to use these helpers. Any new code that does date math should follow the same pattern.

### Route Stop Reassignment Logic
When admin picks route's default driver in the reassign dropdown, set `driver_id = NULL` (not the explicit UUID). Variable `routeLiveDefaultDriverId` tracks this.

### Order Status Pipeline
```
STATUS_FLOW = {
  scheduled:          'picked_up',        // ready_for_pickup removed (session 6)
  picked_up:          'processing',
  processing:         'ready_for_delivery',
  ready_for_delivery: 'out_for_delivery',
  out_for_delivery:   'delivered'
}
```
Side statuses (off the main flow): `skipped`, `pickup_failed`, `delivery_failed`, `on_hold`, `cancelled`
Legacy/retired (kept for old records): `ready_for_pickup`, `assembled`, `pickup_missed`, `delivery_missed`, `pending_pickup`, `ready`

**`cancelled_by` field:** Always set on skip/cancel. Tracks WHO initiated the action ('customer', 'driver', 'admin', 'system') — attribution only. Does NOT control recurring chain behavior.

**⚠️ CRITICAL — Recurring order chain rule:** `trg_create_recurring_order_fn` fires on ANY skip, regardless of `cancelled_by`. A skip means "skip this one occurrence" — the subscription always continues. This was broken in session 70i when `cancelled_by` was changed from always-'customer' to actual-actor for attribution, but the trigger still checked `cancelled_by = 'customer'`. Fixed session 73. **Never add a `cancelled_by` condition to the recurring trigger again.**

**Issues tab filtering:** Customer-initiated skips (`cancelled_by = 'customer'`) AND skipped recurring orders (any actor) are excluded from Issues — they auto-create the next occurrence, nothing to action. Non-recurring skipped orders from driver/admin still show in Issues.

**Rack action** sets status directly to `ready_for_delivery` (skips assembled).
**Charge trigger** fires when advancing from `processing → ready_for_delivery`.

---

