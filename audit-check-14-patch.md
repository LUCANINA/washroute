# Audit Check #14 — paste into washroute-audit SKILL.md

**Where to paste:** After the end of Check #13 block (after the `DELETE FROM auth.users WHERE id = '<attempted_auth_id>';` code fence), immediately before the `---` that precedes `## After the Audit`.

**File path on your machine:** wherever the washroute-audit skill lives — likely `~/.claude/skills/washroute-audit/SKILL.md`.

---

### Check 14 — Window / Sub-Window Alignment (P1)

Active orders whose `pickup_window_start` or `delivery_window_start` doesn't line up with a valid sub-window boundary on the assigned route template. "Valid sub-window" means: `template.window_start + N × arrival_window_hours` for some integer N ≥ 0, within the template's full window, on the route's `run_date`.

Examples of what this catches:
- **Outside-template:** Oakland PM route (6–10 PM) but order window stored as 7–9 AM. Driver won't arrive when the customer expects.
- **Misaligned inside template:** Oakland PM route has 2-hour sub-windows (6–8 PM, 8–10 PM). An order stored at 7 PM or 9 PM is misaligned — no such slot exists.
- **Wrong date:** stored window date doesn't equal the route's `run_date`.

```sql
SELECT
  CASE WHEN rs.stop_type = 'pickup' THEN 'pickup' ELSE 'delivery' END AS side,
  o.order_number, o.status, o.source, o.recurring_interval,
  (CASE WHEN rs.stop_type = 'pickup'
        THEN o.pickup_window_start ELSE o.delivery_window_start END
    AT TIME ZONE 'America/Los_Angeles')::text AS stored_window_pt,
  rt.name AS assigned_route, r.run_date,
  rt.window_start || '–' || rt.window_end AS template_window,
  rt.arrival_window_hours || 'h' AS sub_window_size
FROM orders o
JOIN route_stops rs ON rs.order_id = o.id AND rs.status IN ('pending','en_route')
JOIN routes r ON r.id = rs.route_id
JOIN route_templates rt ON rt.id = r.template_id
WHERE o.status IN ('scheduled','picked_up','processing','folding',
                   'ready_for_delivery','out_for_delivery')
  AND rt.arrival_window_hours > 0
  AND (
    (rs.stop_type = 'pickup' AND (
      (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time <  rt.window_start
      OR (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time >= rt.window_end
      OR (o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::date <> r.run_date
      OR MOD(
           EXTRACT(EPOCH FROM ((o.pickup_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))::int / 60,
           rt.arrival_window_hours * 60
         ) <> 0
    ))
    OR
    (rs.stop_type = 'delivery' AND (
      (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time <  rt.window_start
      OR (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time >= rt.window_end
      OR (o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::date <> r.run_date
      OR MOD(
           EXTRACT(EPOCH FROM ((o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))::int / 60,
           rt.arrival_window_hours * 60
         ) <> 0
    ))
  )
ORDER BY r.run_date, rt.name;
```

**Why this matters:** Admin dashboard and customer-facing SMS both render `*_window_start` directly. If that value is outside the template window or doesn't line up with any real sub-window (6–8 PM, 8–10 PM for Oakland PM), the customer sees a time the driver will never confirm. Session 113 (Apr 15, 2026) caught 47 outside-template delivery rows + 2 outside-template pickup rows + 3 misaligned-inside-template rows, and patched `auto_route_order` to preserve valid sub-windows while rewriting outside-window values to the chosen template's window.

**To fix when reported — snap each misaligned row to the nearest lower sub-window boundary:**

```sql
BEGIN;
ALTER TABLE orders DISABLE TRIGGER trg_sync_delivery_stop_on_window_change;
ALTER TABLE orders DISABLE TRIGGER trg_sync_pickup_stop_on_window_change;

-- Delivery side
UPDATE orders o
SET delivery_window_start =
      (r.run_date::timestamp
        + rt.window_start
        + (FLOOR(
             EXTRACT(EPOCH FROM ((o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))
             / (rt.arrival_window_hours * 3600)
           ) * rt.arrival_window_hours) * INTERVAL '1 hour'
      ) AT TIME ZONE 'America/Los_Angeles',
    delivery_window_end =
      (r.run_date::timestamp
        + rt.window_start
        + (FLOOR(
             EXTRACT(EPOCH FROM ((o.delivery_window_start AT TIME ZONE 'America/Los_Angeles')::time - rt.window_start))
             / (rt.arrival_window_hours * 3600)
           ) * rt.arrival_window_hours + rt.arrival_window_hours) * INTERVAL '1 hour'
      ) AT TIME ZONE 'America/Los_Angeles'
FROM route_stops rs
JOIN routes r ON r.id = rs.route_id
JOIN route_templates rt ON rt.id = r.template_id
WHERE rs.order_id = o.id
  AND rs.stop_type = 'delivery'
  AND rs.status IN ('pending','en_route')
  AND o.order_number = <ORDER_NUMBER>;  -- fill in the flagged order

-- Pickup side (same structure, swap delivery→pickup)
-- ...

ALTER TABLE orders ENABLE TRIGGER trg_sync_delivery_stop_on_window_change;
ALTER TABLE orders ENABLE TRIGGER trg_sync_pickup_stop_on_window_change;
COMMIT;
```

For outside-window cases (e.g. AM time on a PM route) the floor snaps to `window_start` automatically — end result is the earliest valid sub-window, which is almost always the right call. Eyeball each case before applying.

---
