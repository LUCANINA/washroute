-- Rollback for session_355_rewash_orders.sql. Restores the six functions from the
-- _archive snapshot, removes the trigger/RPC. Columns are dropped LAST and only if
-- no rewash orders exist (otherwise keep them — they are history).
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT def FROM _archive.fn_rewash_355_20261021 LOOP EXECUTE r.def; END LOOP;
END $do$;
DROP TRIGGER IF EXISTS trg_zzz_rewash_is_free ON public.orders;
DROP FUNCTION IF EXISTS public.enforce_rewash_is_free();
DROP FUNCTION IF EXISTS public.create_rewash_order(uuid,text,text,integer,uuid,timestamptz,timestamptz,timestamptz,timestamptz,uuid,uuid,uuid,text,text);
-- Only if SELECT count(*) FROM orders WHERE is_rewash = 0:
-- ALTER TABLE public.orders DROP CONSTRAINT orders_rewash_needs_reason, DROP CONSTRAINT orders_rewash_reason_check,
--   DROP COLUMN rewash_note, DROP COLUMN rewash_reason, DROP COLUMN rewash_of_order_id, DROP COLUMN is_rewash;
