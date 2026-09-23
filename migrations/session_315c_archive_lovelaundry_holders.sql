-- Session 315 (2026-09-23): David ended LOVELAUNDRY (15% off EVERY order) for all 50 current holders.
-- Step 1 (migration): snapshot holders into _archive_lovelaundry_holders_315.
-- Step 2 (data): UPDATE customers SET discount_id = NULL for those 50 (applied via execute_sql, 50 rows cleared).
-- Orders already stamped with LOVELAUNDRY at intake keep their discount line.
-- UNDO: UPDATE customers c SET discount_id = a.discount_id, updated_at = now()
--         FROM _archive_lovelaundry_holders_315 a WHERE a.customer_id = c.id AND c.discount_id IS NULL;
CREATE TABLE public._archive_lovelaundry_holders_315 AS
  SELECT c.id AS customer_id, c.discount_id, now() AS archived_at
    FROM public.customers c JOIN public.discounts d ON d.id = c.discount_id
   WHERE d.name = 'LOVELAUNDRY';
ALTER TABLE public._archive_lovelaundry_holders_315 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._archive_lovelaundry_holders_315 FROM anon, authenticated;
