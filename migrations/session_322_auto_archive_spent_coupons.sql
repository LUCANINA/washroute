-- Session 322 (2026-09-29): auto-archive spent one-time ($) coupons.
-- A fixed-amount code can be redeemed ONCE in total (redeem_discount_code refuses a
-- second claim), so the moment its redemption row lands the code is spent. Archive it
-- (same active=false + deleted_at the Archive button writes) so it leaves the active list.
-- % codes are never touched: they are reusable per customer.
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_archive_spent_fixed_discount ON public.discount_redemptions;
--   DROP FUNCTION IF EXISTS public.archive_spent_fixed_discount();
CREATE OR REPLACE FUNCTION public.archive_spent_fixed_discount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.discount_type_snapshot = 'fixed' THEN
    UPDATE public.discounts
       SET active = false, deleted_at = COALESCE(deleted_at, now())
     WHERE id = NEW.discount_id
       AND type = 'fixed'
       AND (active IS TRUE OR deleted_at IS NULL);
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.archive_spent_fixed_discount() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.archive_spent_fixed_discount() FROM anon;
REVOKE EXECUTE ON FUNCTION public.archive_spent_fixed_discount() FROM authenticated;

DROP TRIGGER IF EXISTS trg_archive_spent_fixed_discount ON public.discount_redemptions;
CREATE TRIGGER trg_archive_spent_fixed_discount
  AFTER INSERT ON public.discount_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.archive_spent_fixed_discount();

-- Sweep: any fixed code already redeemed but still active (0 rows on 2026-09-29).
UPDATE public.discounts d
   SET active = false, deleted_at = COALESCE(d.deleted_at, now())
 WHERE d.type = 'fixed'
   AND (d.active IS TRUE OR d.deleted_at IS NULL)
   AND EXISTS (SELECT 1 FROM public.discount_redemptions r
                WHERE r.discount_id = d.id AND r.discount_type_snapshot = 'fixed');
