-- Session 315 (2026-09-23): coupons can be limited to N orders per customer (1 = one-time).
-- Applied via apply_migration as session_315d_discount_use_limit. Tested in a rolled-back DO block:
-- redeem -> attach, first use -> removed, cancel that order -> restored, SENIORS (unlimited) untouched.
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_enforce_discount_use_limit ON public.orders;
--   DROP FUNCTION IF EXISTS public.enforce_discount_use_limit();
--   ALTER TABLE public.discounts DROP COLUMN IF EXISTS max_orders_per_customer;
ALTER TABLE public.discounts
  ADD COLUMN max_orders_per_customer integer
  CHECK (max_orders_per_customer IS NULL OR max_orders_per_customer >= 1);
COMMENT ON COLUMN public.discounts.max_orders_per_customer IS
  'How many orders per customer this code applies to. NULL = every order. 1 = one-time. Session 315.';

CREATE OR REPLACE FUNCTION public.enforce_discount_use_limit()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_max integer; v_live boolean; v_used integer;
BEGIN
  IF NEW.discount_id IS NULL OR NEW.customer_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.discount_id IS NOT DISTINCT FROM OLD.discount_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NULL; END IF;
  SELECT max_orders_per_customer, (active IS TRUE AND deleted_at IS NULL) INTO v_max, v_live
    FROM public.discounts WHERE id = NEW.discount_id;
  IF v_max IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_used FROM public.orders
   WHERE customer_id = NEW.customer_id AND discount_id = NEW.discount_id
     AND status NOT IN ('cancelled', 'skipped', 'pickup_failed');
  PERFORM public.wr_allow_protected_write();
  IF v_used >= v_max THEN
    UPDATE public.customers SET discount_id = NULL, updated_at = now()
     WHERE id = NEW.customer_id AND discount_id = NEW.discount_id;
  ELSIF TG_OP = 'UPDATE' AND NEW.status IN ('cancelled', 'skipped', 'pickup_failed')
        AND OLD.status IS DISTINCT FROM NEW.status AND v_live THEN
    UPDATE public.customers SET discount_id = NEW.discount_id, updated_at = now()
     WHERE id = NEW.customer_id AND discount_id IS NULL;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.enforce_discount_use_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_discount_use_limit() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enforce_discount_use_limit() FROM authenticated;
CREATE TRIGGER trg_enforce_discount_use_limit
  AFTER INSERT OR UPDATE OF discount_id, status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_discount_use_limit();
UPDATE public.discounts SET max_orders_per_customer = 1 WHERE name = 'LOVELAUNDRY';
NOTIFY pgrst, 'reload schema';
