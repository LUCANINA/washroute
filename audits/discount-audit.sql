-- Discount audit — are customers with a standing discount actually being charged it?
-- Session 291n (2026-09-10). Re-runnable; read-only.
--
-- Scope: customers.discount_id pointing at an ACTIVE discount of type 'percent'.
-- Fixed-dollar discounts are one-time promo codes (WELCOME15, referral codes) and are
-- NOT expected on every order, so including them produces pure false positives.
--
-- Expected amount follows the session-146 policy: a percent discount applies to all
-- SERVICE charges — base + overage + addon + addon_service + pref_service — and never
-- to delivery_fee or same_day_surcharge.
--
-- THREE CLASSES THAT LOOK WRONG BUT ARE NOT. Check these before acting on any result:
--   1. Orders from 2026-03-31 to 2026-05-29 that match a BASE-ONLY calculation. That
--      was the policy before session 146 widened the scope. Correct for their time.
--   2. Orders with no discount line that predate the customer's FIRST discounted
--      order. The discount was almost certainly granted after that order was placed;
--      you cannot retroactively discount an order from before the customer qualified.
--   3. Subscription / $0-base orders. Nothing is discountable, so no line is right.
--
-- What is left after those three is real.

WITH o AS (
  SELECT ord.id, ord.order_number, ord.created_at, ord.status, ord.customer_id,
    c.first_name_cache||' '||COALESCE(c.last_name_cache,'') AS cust,
    d.name AS dname, d.value AS dvalue,
    (SELECT COALESCE(sum((li->>'amount')::numeric),0) FROM jsonb_array_elements(ord.line_items) li
      WHERE li->>'type' = 'base') AS base,
    (SELECT COALESCE(sum((li->>'amount')::numeric),0) FROM jsonb_array_elements(ord.line_items) li
      WHERE li->>'type' IN ('base','overage','addon','addon_service','pref_service')) AS discountable,
    (SELECT COALESCE(sum((li->>'amount')::numeric),0) FROM jsonb_array_elements(ord.line_items) li
      WHERE li->>'type' = 'discount') AS disc_line
  FROM orders ord
  JOIN customers c ON c.id = ord.customer_id
  JOIN discounts d ON d.id = c.discount_id AND d.active AND d.type = 'percent'
  WHERE ord.line_items IS NOT NULL
    AND ord.status NOT IN ('cancelled','skipped')
), firstdisc AS (
  SELECT customer_id, min(created_at) AS fd FROM o WHERE disc_line <> 0 GROUP BY 1
)
SELECT o.cust, o.dname, o.order_number, o.status, o.created_at::date AS d,
       o.discountable, -o.disc_line AS charged_discount,
       round(o.discountable * (o.dvalue/100.0), 2) AS expected_discount,
       round(round(o.discountable * (o.dvalue/100.0), 2) + o.disc_line, 2) AS owed_to_customer
FROM o LEFT JOIN firstdisc f ON f.customer_id = o.customer_id
WHERE o.discountable > 0
  AND (
        -- wrong amount, and not explainable by the old base-only policy
        (o.disc_line <> 0
          AND round(-o.disc_line,2) <> round(o.discountable * (o.dvalue/100.0), 2)
          AND round(-o.disc_line,2) <> round(o.base * (o.dvalue/100.0), 2))
        -- or missing on an order placed AFTER the customer was already being discounted
        OR (o.disc_line = 0 AND (f.fd IS NULL OR o.created_at > f.fd))
      )
ORDER BY owed_to_customer DESC;
