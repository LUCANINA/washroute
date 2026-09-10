-- session 291j — DATA fix (not schema). APPLIED 2026-09-10.
--
-- Kidango - Hesperian Center and Kidango - Del Rey Center were the only 2 of 20
-- Kidango centres not set up like their siblings: billing_type='automatic', no
-- billing_group, no card, no Stripe customer, and zero orders ever picked up or
-- delivered since being created 2026-08-21. Each carried one placeholder order
-- (13117, 13119) stuck in 'scheduled' with recurring_interval='weekly' but
-- source='scheduled' — flagged weekly, never actually generating anything.
--
-- They surfaced because "no card on file" made them look like orders we could not
-- charge for. David confirmed both are on-demand accounts billed on the Kidango
-- account like the other 18.
--
-- Applied:
--   customers  -> billing_type = 'on_account', billing_group_id = Kidango Group
--                 (b0000002-0000-0000-0000-000000000002)
--   orders     -> 13117, 13119: status='cancelled', cancelled_by='admin',
--                 recurring_interval=NULL, archived with a reason
--
-- Preflight: no SMS-sending trigger on customers or orders (notifications are sent
-- by app code, not triggers). trg_sync_customer_type_pricelist only acts when
-- pricelist/customer_type change — neither was touched. Blast radius 2 customers,
-- 2 orders, 0 customers contacted.
--
-- Rollback snapshot: public._archive_kidango_ondemand_291j (old billing_type,
-- billing_group_id, order status and recurring_interval per row).

CREATE TABLE IF NOT EXISTS public._archive_kidango_ondemand_291j AS
SELECT c.id customer_id, c.billing_type old_billing_type, c.billing_group_id old_billing_group_id,
       o.id order_id, o.status old_status, o.recurring_interval old_recurring_interval, now() snapped_at
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE c.first_name_cache ILIKE '%kidango%' AND COALESCE(c.billing_type,'') <> 'on_account';

UPDATE customers SET billing_type = 'on_account',
       billing_group_id = 'b0000002-0000-0000-0000-000000000002'
WHERE first_name_cache ILIKE '%kidango%' AND COALESCE(billing_type,'') <> 'on_account';

UPDATE orders SET status='cancelled', cancelled_by='admin', recurring_interval=NULL,
       archived_at=now(),
       archived_reason='On-demand account — standing weekly order removed (291j)'
WHERE order_number IN (13117,13119) AND status='scheduled';
