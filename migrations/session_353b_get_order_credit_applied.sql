-- Session 353b — Oct 20, 2026
-- POS receipts read customer_transactions directly to print the
-- "Credit applied / Paid by card" split, but RLS on that table only admits
-- admins and the customer themself — the POS always read 0, so the split never
-- printed. Rather than open every customer's payment history to the counter,
-- expose one number per order: net account credit used (use − refund).
CREATE OR REPLACE FUNCTION public.get_order_credit_applied(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_net numeric;
BEGIN
  PERFORM public.assert_staff('get_order_credit_applied');
  IF p_order_id IS NULL THEN RETURN 0; END IF;
  SELECT COALESCE(SUM(CASE WHEN type = 'credit_use'    THEN amount
                           WHEN type = 'credit_refund' THEN -amount
                           ELSE 0 END), 0)
    INTO v_net
    FROM public.customer_transactions
   WHERE order_id = p_order_id
     AND type IN ('credit_use', 'credit_refund');
  RETURN GREATEST(ROUND(v_net, 2), 0);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_order_credit_applied(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_order_credit_applied(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_order_credit_applied(uuid) TO authenticated, service_role;

-- Rollback:
-- DROP FUNCTION public.get_order_credit_applied(uuid);
