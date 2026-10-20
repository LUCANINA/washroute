-- Session 352a (2026-10-20) — APPLIED. Staff-only read of the CloudPRNT printer token.
-- Any logged-in customer could read settings.printer_token, which is the only thing the
-- cloudprnt function checks before handing over queued receipts / bag tags (customer
-- names + addresses). The admin dashboard now reads it through this RPC instead.
CREATE OR REPLACE FUNCTION public.get_printer_token()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only admin staff can read the printer token' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT printer_token FROM public.settings WHERE id = 1);
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_printer_token() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_printer_token() FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_printer_token() TO authenticated, service_role;
-- Verified per role: admin / manager / laundry_tech get the token; attendant, cpa,
-- customer, driver, pos_device are refused.
