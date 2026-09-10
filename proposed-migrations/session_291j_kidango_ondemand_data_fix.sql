-- session 291j — DATA fix (not schema). APPLIED then PARTIALLY REVERTED 2026-09-10.
--
-- WHAT WAS KEPT (correct):
--   Kidango - Hesperian Center and Kidango - Del Rey Center were the only 2 of 20
--   Kidango centres with billing_type='automatic' and no billing group. David
--   confirmed both are billed on the Kidango account like the other 18.
--     customers -> billing_type='on_account',
--                  billing_group_id='b0000002-0000-0000-0000-000000000002' (Kidango Group)
--
-- WHAT WAS REVERTED (my error):
--   I also cancelled and archived their standing orders 13117/13119 and cleared
--   recurring_interval, on the reading that "on demand" meant no standing weekly
--   pickup. WRONG. Jessica Perez Barragan's email of 21 Aug asked for both centres
--   to start WEEKLY service effective Thursday 24 Sep — the orders were correct
--   onboarding, created the same day the email arrived. Restored:
--     orders 13117, 13119 -> status='scheduled', cancelled_by=NULL,
--                            recurring_interval='weekly', archived_at=NULL,
--                            archived_reason=NULL
--     their 4 route_stops -> status='pending' (cancelling had marked them 'skipped')
--
-- LESSON: "zero orders ever delivered" on an account created three weeks ago is not
-- evidence of a dead account — it can equally mean service has not started yet. The
-- pickup date (24 Sep, in the future) said exactly that and I read it as a stale
-- placeholder. Check the START date against the account's creation date before
-- concluding an order is abandoned, and confirm the operational fact with David
-- rather than inferring it from row shape.
--
-- Verified against the customer email after restore: 620 Drew St, San Lorenzo 94580
-- (Hesperian, skumar@kidango.org) and 1510 Via Sonya, San Lorenzo 94580 (Del Rey,
-- sliang@kidango.org) both match, pickup 24 Sep / delivery 25 Sep on the Kidango route.
--
-- Snapshot of pre-change values: public._archive_kidango_ondemand_291j.

-- KEPT:
UPDATE customers SET billing_type = 'on_account',
       billing_group_id = 'b0000002-0000-0000-0000-000000000002'
WHERE first_name_cache ILIKE '%kidango%' AND COALESCE(billing_type,'') <> 'on_account';

-- REVERTED (restore, run after the erroneous cancel):
UPDATE orders SET status='scheduled', cancelled_by=NULL, recurring_interval='weekly',
       archived_at=NULL, archived_reason=NULL
WHERE order_number IN (13117,13119);

UPDATE route_stops rs SET status='pending'
FROM orders o WHERE o.id = rs.order_id AND o.order_number IN (13117,13119);
