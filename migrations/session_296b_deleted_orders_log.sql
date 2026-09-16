-- Session 296b (2026-09-16): keep a record of every deleted order.
--
-- Admin "Cancel & Delete" (delete_orders RPC) removes an order outright and
-- left no trace — two June SMS bookings (#7420, #8142) vanished with no way to
-- tell who or why. A BEFORE DELETE trigger now snapshots the whole row, whatever
-- deletes it (RPC, direct delete, cascade).
--
-- Admin-only read. Nobody writes to it directly — only the trigger (SECURITY DEFINER).
-- Rollback: DROP TRIGGER trg_log_order_delete ON public.orders;
--           DROP FUNCTION public.log_order_delete(); DROP TABLE public.deleted_orders_log;

CREATE TABLE public.deleted_orders_log (
  id              bigserial PRIMARY KEY,
  order_id        uuid        NOT NULL,
  order_number    bigint,
  customer_id     uuid,
  status          text,
  deleted_at      timestamptz NOT NULL DEFAULT now(),
  deleted_by      uuid,
  deleted_by_name text,
  order_row       jsonb       NOT NULL
);
CREATE INDEX deleted_orders_log_order_number_idx ON public.deleted_orders_log (order_number);
CREATE INDEX deleted_orders_log_customer_id_idx  ON public.deleted_orders_log (customer_id);
CREATE INDEX deleted_orders_log_deleted_at_idx   ON public.deleted_orders_log (deleted_at DESC);

ALTER TABLE public.deleted_orders_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deleted_orders_log FROM anon, authenticated;
GRANT SELECT ON public.deleted_orders_log TO authenticated;
GRANT ALL ON public.deleted_orders_log TO service_role;
CREATE POLICY deleted_orders_log_admin_read ON public.deleted_orders_log
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.log_order_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')
      INTO v_name FROM public.profiles WHERE id = v_uid;
  END IF;
  INSERT INTO public.deleted_orders_log
    (order_id, order_number, customer_id, status, deleted_by, deleted_by_name, order_row)
  VALUES
    (OLD.id, OLD.order_number, OLD.customer_id, OLD.status::text, v_uid,
     COALESCE(v_name, CASE WHEN v_uid IS NULL THEN current_user::text END),
     to_jsonb(OLD));
  RETURN OLD;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_order_delete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_order_delete() FROM anon;
REVOKE EXECUTE ON FUNCTION public.log_order_delete() FROM authenticated;

CREATE TRIGGER trg_log_order_delete
  BEFORE DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.log_order_delete();

-- Seed with the test order removed earlier today (already archived).
INSERT INTO public.deleted_orders_log
  (order_id, order_number, customer_id, status, deleted_at, deleted_by_name, order_row)
SELECT a.id, a.order_number, a.customer_id, a.status::text, '2026-09-16 23:05:00+00',
       'Claude (SMS PICKUP live test)', to_jsonb(a)
FROM _archive._deleted_test_order_15237_20260916 a;
