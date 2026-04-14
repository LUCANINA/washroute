---
name: washroute-audit
description: >
  Run a daily health audit on the WashRoute database. Use this skill at the start
  of EVERY session — especially when David says "load up", "morning rounds",
  "run audit", "daily check", "health check", "check the system", or any phrasing
  that implies checking for data issues before starting work. Also run proactively
  at the start of any session where David plans to work on orders, routes, or
  customers. This catches data integrity issues (orphaned stops, unrouted orders,
  unpaid deliveries, duplicate accounts) before they become customer-facing problems.
  The audit takes about 30 seconds and prevents hours of debugging later.
---

# WashRoute — Daily Health Audit ("Morning Rounds")

Run all 11 checks below against the Supabase database using `execute_sql` with
project ID `umjpbuxrdydwejqtensq`. Present results as a clean, scannable summary
— never dump raw SQL output on David.

## How to Run

Execute each check as a single combined SQL query (or a few grouped queries).
For each check:

- **0 rows** → ✅ (all clear)
- **Rows found, P0** → 🔴 + list affected records with customer names and order numbers
- **Rows found, P1** → ⚠️ + list affected records
- **Rows found, P2/P3** → 📋 + count only (details on request)

Present results in this format:

```
## Morning Rounds — Mar 26, 2026

✅ 1. Unrouted orders — all clear
🔴 2. Wrong-date stops — 3 stops on wrong routes
✅ 3. Unpaid delivered orders — all clear
✅ 3b. Charged but billing_status missing — all clear
✅ 4. Stop/order status desync — all clear
⚠️ 5. Duplicate customers — 2 new pairs found
✅ 6. Duplicate orders — all clear
✅ 7. Over-capacity routes — all clear
📋 8. Driverless routes — 4 (next week, low priority)
✅ 9. SMS opt-out sync — all clear
📋 10. Orphaned records — 12 duplicate addresses, 8 orphan profiles

### Action needed:
- [P0] 3 delivery stops on wrong routes — want me to move them?
- [P1] Sandeep Vadivel has 2 accounts again — want me to merge?
```

If ALL checks pass: **"All clear — system is healthy. What are we working on today?"**

If any P0 issues are found, **offer to fix them immediately** before moving on.

---

## The 10 Checks

### Check 1 — Unrouted Orders (P0)

Active orders missing route stops entirely, or flagged with a routing error.

```sql
SELECT o.id, o.order_number, o.status, o.routing_error,
       c.first_name_cache || ' ' || c.last_name_cache AS customer,
       (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::text AS pickup_pt
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status IN ('scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery')
  AND (o.routing_error IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM route_stops rs WHERE rs.order_id = o.id AND rs.stop_type = 'pickup'))
ORDER BY o.pickup_window_start;
```

**Why this matters:** Unrouted orders won't appear on any driver's route — the customer
expects a pickup but nobody is coming. This was a recurring issue in sessions 65-70 when
capacity limits or zone mismatches caused `auto_route_order()` to fail silently.

---

### Check 2 — Wrong-Date Stops (P0)

Pending stops sitting on a route whose `run_date` doesn't match the order's actual
pickup/delivery window in Pacific time.

```sql
SELECT rs.id AS stop_id, o.order_number, rs.stop_type, rs.status AS stop_status,
       r.run_date AS route_date,
       (CASE WHEN rs.stop_type = 'pickup'
             THEN o.pickup_window_start
             ELSE o.delivery_window_start
        END AT TIME ZONE 'America/Los_Angeles')::date AS correct_date,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
JOIN routes r ON rs.route_id = r.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE rs.status IN ('pending', 'en_route')
  AND r.run_date != (CASE WHEN rs.stop_type = 'pickup'
                          THEN o.pickup_window_start
                          ELSE o.delivery_window_start
                     END AT TIME ZONE 'America/Los_Angeles')::date;
```

**Why this matters:** This was the #1 recurring bug across sessions 62-70. UTC-to-Pacific
date conversion errors caused PM delivery stops to land on the next day's route. The
`trg_sync_delivery_stop_on_window_change` trigger (session 65) prevents new occurrences,
but edge cases can still slip through.

**To fix:** Move the stop to the correct route. Use `auto_route_order()` logic or manually
reassign by finding the route with the matching `run_date` and `template_id`.

---

### Check 3 — Unpaid Delivered Orders (P0)

Orders delivered (or ready to deliver) without a successful Stripe charge.

```sql
SELECT o.id, o.order_number, o.status, '$' || o.total_amount AS amount,
       o.billing_status, o.stripe_payment_intent_id IS NOT NULL AS has_stripe,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status IN ('delivered', 'ready_for_delivery', 'out_for_delivery')
  AND o.total_amount > 0
  AND (o.stripe_payment_intent_id IS NULL OR o.billing_status IS NULL OR o.billing_status != 'paid')
ORDER BY o.total_amount DESC;
```

**Why this matters:** Session 61 discovered $4,200+ in revenue not being tracked because
`charge-order` wasn't setting `billing_status`. The edge function was fixed (v25), but
orders that slip through the cracks (manual status changes, edge function failures) still
need to be caught.

---

### Check 3b — Charged But billing_status Missing (P1)

Orders that have a Stripe payment intent and a `billed_at` timestamp but no `billing_status = 'paid'`
— indicating `charge-order` collected money but failed to write the final status update.

```sql
SELECT o.order_number, o.status, '$' || o.total_amount AS amount,
       o.billing_status, o.billed_at AT TIME ZONE 'America/Los_Angeles' AS billed_pt,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.stripe_payment_intent_id IS NOT NULL
  AND o.billed_at IS NOT NULL
  AND o.charge_failed_at IS NULL
  AND (o.billing_status IS NULL OR o.billing_status NOT IN ('paid', 'refunded'))
ORDER BY o.billed_at DESC;
```

**Why this matters:** Discovered session 77 — `charge-order` does two separate DB writes:
(1) stamps `billed_at` at charge time, (2) sets `billing_status='paid'` after Stripe confirms.
If step 2 silently fails (timeout, edge function error), the order looks unpaid in the system
but money has already been collected. Caught 13 such orders totalling ~$1,388 in session 77.
These must be verified in Stripe live mode before marking paid — never assume without checking.

**To fix:** Verify each payment intent in Stripe Dashboard (live mode). If confirmed Succeeded,
run: `UPDATE orders SET billing_status = 'paid' WHERE stripe_payment_intent_id IN (...)`

**Root-cause fix needed (tech debt):** Consolidate the two DB writes in `charge-order` into
a single atomic UPDATE so there's no partial-state window.

---

### Check 4 — Stop / Order Status Desync (P1)

Stops stuck in wrong status relative to their parent order.

```sql
SELECT rs.id AS stop_id, o.order_number,
       o.status AS order_status, rs.status AS stop_status, rs.stop_type,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE
  (o.status IN ('delivered','cancelled','skipped','pickup_failed','delivery_failed')
   AND rs.status IN ('pending','en_route'))
  OR (o.status IN ('picked_up','processing','folding','ready_for_delivery','out_for_delivery','delivered')
      AND rs.stop_type = 'pickup' AND rs.status NOT IN ('complete','skipped','failed'))
ORDER BY o.order_number;
```

**Why this matters:** Ghost stops inflate route counts, confuse drivers, and break progress
bars. Triggers `trg_sync_stops_on_order_terminal` and `trg_sync_stops_on_order_advance`
(sessions 3 and 65) handle most cases, but manual admin status changes can bypass them.

**To fix:** Set the stop's status to match the order (delivered→complete, cancelled→skipped,
pickup_failed→failed for pickup stops + skipped for delivery stops).

---

### Check 5 — Duplicate Customers (P1)

Accounts sharing the same phone or email — usually Starchup migration shells paired
with new customer app signups.

```sql
WITH phone_dups AS (
  SELECT RIGHT(REGEXP_REPLACE(phone_cache,'[^0-9]','','g'),10) AS match_key,
         'phone' AS match_type, COUNT(*) AS cnt,
         ARRAY_AGG(first_name_cache||' '||last_name_cache ORDER BY created_at) AS names,
         ARRAY_AGG(id ORDER BY created_at) AS ids
  FROM customers
  WHERE phone_cache IS NOT NULL
    AND LENGTH(REGEXP_REPLACE(phone_cache,'[^0-9]','','g')) >= 10
  GROUP BY match_key HAVING COUNT(*) > 1
),
email_dups AS (
  SELECT email_cache AS match_key, 'email' AS match_type, COUNT(*) AS cnt,
         ARRAY_AGG(first_name_cache||' '||last_name_cache ORDER BY created_at) AS names,
         ARRAY_AGG(id ORDER BY created_at) AS ids
  FROM customers
  WHERE email_cache IS NOT NULL AND email_cache != ''
  GROUP BY email_cache HAVING COUNT(*) > 1
)
SELECT * FROM phone_dups
UNION ALL
SELECT * FROM email_dups
ORDER BY cnt DESC;
```

**Known intentional duplicates to SKIP (don't flag these):**
- Phone `4156085446` — David's test accounts (3 records)
- Phone `5109270366` — Myra Greene / Sarang Rahmani (different people)
- Phone `5109270618` — Charlene Davis / Charlene Bachemin (uncertain match)

Filter these out of the results before reporting.

---

### Check 6 — Duplicate Orders (P1)

Same customer + same pickup date + both in active status = likely accidental double-booking
from recurring order trigger or customer double-tap.

```sql
SELECT o.customer_id,
       c.first_name_cache || ' ' || c.last_name_cache AS customer,
       (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date AS pickup_date,
       COUNT(*) AS order_count,
       ARRAY_AGG(o.order_number ORDER BY o.created_at) AS order_numbers,
       ARRAY_AGG(o.status ORDER BY o.created_at) AS statuses
FROM orders o
LEFT JOIN customers c ON c.id = o.customer_id
WHERE o.status IN ('scheduled','picked_up','processing','folding','ready_for_delivery','out_for_delivery')
  AND o.pickup_window_start IS NOT NULL
GROUP BY o.customer_id, c.first_name_cache, c.last_name_cache,
         (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date
HAVING COUNT(*) > 1
ORDER BY pickup_date;
```

**To fix:** Compare the two orders — if truly identical (same service, same bags), delete
the newer one. If different (e.g., one is recurring, one is walk-in), they may both be
intentional — ask David.

---

### Check 7 — Over-Capacity Routes (P1)

Routes with more active stops than the template allows.

```sql
SELECT r.id, rt.name, r.run_date, rt.stop_limit,
       COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) AS active_stops
FROM routes r
JOIN route_templates rt ON r.template_id = rt.id
LEFT JOIN route_stops rs ON r.id = rs.route_id
WHERE r.run_date >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date
GROUP BY r.id, rt.name, r.run_date, rt.stop_limit
HAVING COUNT(rs.id) FILTER (WHERE rs.status IN ('pending','en_route')) > rt.stop_limit
ORDER BY r.run_date, rt.name;
```

---

### Check 8 — Driverless Routes (P2)

Future routes with no driver assigned anywhere (not on the route, not in the schedule).

```sql
SELECT r.id, rt.name, r.run_date
FROM routes r
JOIN route_templates rt ON r.template_id = rt.id
WHERE r.run_date >= (NOW() AT TIME ZONE 'America/Los_Angeles')::date
  AND r.run_date <= (NOW() AT TIME ZONE 'America/Los_Angeles')::date + INTERVAL '7 days'
  AND r.driver_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM route_driver_schedule rds
    WHERE rds.template_id = r.template_id
      AND rds.day_of_week = (EXTRACT(ISODOW FROM r.run_date)::int - 1)
      AND rds.driver_id IS NOT NULL
  )
ORDER BY r.run_date, rt.name;
```

---

### Check 9 — SMS Opt-Out Sync (P2)

Customers who texted STOP (sms_consent_at = NULL) but marketing toggle is still on.

```sql
SELECT COUNT(*) AS out_of_sync_count
FROM customers
WHERE phone_cache IS NOT NULL
  AND sms_consent_at IS NULL
  AND sms_marketing_opt_out_at IS NULL;
```

If count > 0, report the number and offer to backfill (same pattern as session 69).

---

### Check 10 — Orphaned Records (P3)

Leftover data from customer merges and deletions.

```sql
-- Duplicate addresses
SELECT COUNT(*) AS duplicate_address_count FROM (
  SELECT customer_id, line1, city
  FROM addresses WHERE customer_id IS NOT NULL
  GROUP BY customer_id, line1, city HAVING COUNT(*) > 1
) t;
```

```sql
-- Orphaned customer profiles
SELECT COUNT(*) AS orphan_profile_count FROM (
  SELECT p.id FROM profiles p
  LEFT JOIN customers c ON c.profile_id = p.id
  WHERE c.id IS NULL AND p.role = 'customer'
) t;
```

Report counts only. These are informational — clean up when David asks.

---

### Check 11 — Ghost Delivery Stops (P1)

Delivery stops scheduled on past routes whose parent order never made it
to `ready_for_delivery`. Almost always caused by orders processed at a site
without admin-software access — the bag was handled, but the order status
was never advanced. Left unchecked, the driver would drive to the delivery
location expecting to hand off laundry he doesn't have.

```sql
-- NOTE: restricted to PAST run_dates (strictly before today). Same-day
-- delivery stops whose parent order is still processing are legitimately
-- in-flight and should NOT be flagged here — the driver-app/admin RCC
-- filters hide them at the UI layer so no one acts on them prematurely.
SELECT rs.id AS stop_id, o.order_number, o.status AS order_status,
       rt.name AS route_name, r.run_date,
       c.first_name_cache || ' ' || c.last_name_cache AS customer
FROM route_stops rs
JOIN orders o ON rs.order_id = o.id
JOIN routes r ON rs.route_id = r.id
JOIN route_templates rt ON r.template_id = rt.id
LEFT JOIN customers c ON c.id = o.customer_id
WHERE rs.stop_type = 'delivery'
  AND rs.status IN ('pending', 'en_route')
  AND r.run_date < (NOW() AT TIME ZONE 'America/Los_Angeles')::date
  AND o.status IN ('picked_up', 'processing', 'folding')
ORDER BY r.run_date, rt.name;
```

**Why this matters:** The admin dashboard RCC filter hides these stops, and
as of session 106 the driver app also hides them. But the underlying issue
— orders stuck in a pre-ready status past their delivery window — means the
customer isn't getting their laundry back on schedule.

**To fix (case by case):**
- Call/text the processing site, confirm the bag is done, and manually advance
  the order to `ready_for_delivery` → the stop will reappear on the driver's
  route automatically.
- If the delivery already happened off-software, mark the order `delivered`
  directly (the delivery stop will auto-sync via `trg_sync_stops_on_order_terminal`).
- If the order was abandoned, cancel it and issue a refund/credit as appropriate.

**Root cause (structural, not yet fixed):** There's no trigger that flags
orders whose delivery window has passed without reaching `ready_for_delivery`.
Consider adding `routing_error = 'delivery_orphaned'` on such orders via a
nightly cron job so they surface in the Issues tab automatically.

---

### Check 12 — Orphan Auth Users (P1)

Auth users with an email but no linked customer record. Customers in this
state are silently stuck — every magic link request creates another orphan,
they can never sign in, and they have no way to tell us short of emailing.
This is the bug Thomas Cannon and Emily Heath hit in session 110.

```sql
-- Orphan = auth.users with an email but no customer in profiles.id linkage,
-- AND not a known staff/internal email. Excludes empty-email phone-only users.
SELECT au.id AS orphan_auth_id,
       au.email,
       au.created_at,
       au.last_sign_in_at,
       -- Is there a customer with this email_cache linked to a different
       -- (phone-only) auth user? That customer is currently STUCK.
       (SELECT c.id FROM customers c
          WHERE c.email_cache = au.email
            AND c.profile_id IS NOT NULL
            AND c.profile_id != au.id
          LIMIT 1) AS shadowed_customer_id,
       (SELECT c.first_name_cache || ' ' || c.last_name_cache FROM customers c
          WHERE c.email_cache = au.email
            AND c.profile_id IS NOT NULL
            AND c.profile_id != au.id
          LIMIT 1) AS shadowed_name
FROM auth.users au
LEFT JOIN customers c ON c.profile_id = au.id
WHERE au.email IS NOT NULL
  AND au.email != ''
  AND c.id IS NULL
  -- Skip known staff / internal accounts (David maintains this list)
  AND au.email NOT IN (
    'lili@familylaundry.com',
    'info@familylaundry.com',
    'john@familylaundry.com'
  )
  AND au.email NOT LIKE '%@washroute.test'
ORDER BY au.created_at DESC;
```

**Why this matters:** Three real customers (Norine, Nathie, Pree) and several
test accounts were quietly stuck this way before session 110's sweep. Without
an audit check, the same condition silently re-accumulates. `send-magic-link`
v17 (session 110) prevents new orphans for phone-auth customers, but other
flows can still produce them (typos, abandoned signups).

**To fix when reported:**

- **If `shadowed_customer_id` is populated** (highest priority): there's a
  real customer being blocked. Delete the orphan auth user, then ask the
  customer to click "send magic link" again — v17 will link the email to
  their phone-auth user automatically and the link will land cleanly.
- **If `shadowed_customer_id` is NULL**: this is a typo or an abandoned
  signup. Safe to delete the orphan to keep the database tidy.

```sql
-- Delete a single orphan
DELETE FROM auth.users WHERE id = '<orphan_auth_id>';
-- Cascades to profiles + auth.identities automatically.
```

**Never delete:** `lili@`, `info@`, `john@` `@familylaundry.com` are staff
emails. Add new staff to the exclusion list above when onboarding.

---

### Check 13 — Stuck Phone-OTP Attempts (P1)

Phone-OTP confirmation tokens belonging to auth users that shadow a real
existing customer. Same shape as Check 12 but on the phone-auth side: the
customer has a real auth user (probably email-based), they tried to sign
in via phone OTP, Supabase created a NEW phone-only auth user, and they
either never completed the code or completed it but landed on a useless
ghost account with no customer linkage.

```sql
WITH stuck AS (
  SELECT u.id AS attempted_auth_id, u.phone, t.created_at AS token_at,
         u.last_sign_in_at
  FROM auth.one_time_tokens t
  JOIN auth.users u ON u.id = t.user_id
  WHERE t.token_type = 'confirmation_token'
    AND u.email IS NULL
    AND u.phone IS NOT NULL
)
SELECT s.attempted_auth_id, s.token_at, s.last_sign_in_at,
       c.id AS real_customer_id,
       c.first_name_cache || ' ' || c.last_name_cache AS customer_name,
       c.total_orders
FROM stuck s
JOIN customers c
  ON RIGHT(REGEXP_REPLACE(c.phone_cache,'[^0-9]','','g'),10) = RIGHT(s.phone,10)
WHERE c.profile_id IS NOT NULL
  AND c.profile_id != s.attempted_auth_id
ORDER BY c.total_orders DESC NULLS LAST, s.token_at DESC;
```

**Why this matters:** Session 110 found 29 high-value customers stuck this
way (Patricia Hedl 107 orders, Rebekah Black 73, Michael Sullivan 50,
Andrew Chamberlain 25, etc.). The structural fix `prepare-phone-otp`
(session 110) prevents new orphans, but other paths (e.g., orphan auth
created by old code, third-party signups) can still produce them.

**To fix when reported:** Delete the orphan auth user. The customer's real
account (email-auth) is unaffected. The next time they request OTP via
the customer app, `prepare-phone-otp` will attach the phone to their real
auth user and the OTP will land cleanly.

```sql
DELETE FROM auth.users WHERE id = '<attempted_auth_id>';
```

---

## After the Audit

1. Present the summary
2. **P0 issues:** Offer to fix immediately — these affect today's operations
3. **P1 issues:** Note them and ask David's preference (fix now or later)
4. **P2/P3 issues:** Report counts, move on unless David asks to dig in
5. **Root-cause rule:** For every one-time data fix applied, identify WHY the bad data was created and flag the root-cause code fix needed. If the root cause can be fixed now, do it. If not, log it as tech debt in PROJECT-NOTES.md with a clear next step.
6. Proceed to whatever David wants to work on for the day
