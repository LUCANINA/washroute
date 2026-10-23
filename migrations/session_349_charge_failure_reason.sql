-- Session 349: record WHY a card charge failed, and which Stripe PaymentIntent
-- declined, directly on the order so staff don't have to open Stripe.
-- Apply BEFORE deploying charge-order v52 (stale-cache rule, session 176/177).
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS charge_failure_reason text,
  ADD COLUMN IF NOT EXISTS charge_failed_pi_id   text;

COMMENT ON COLUMN public.orders.charge_failure_reason IS 'Human-readable reason for the most recent failed charge (written only by charge-order). Cleared on successful payment.';
COMMENT ON COLUMN public.orders.charge_failed_pi_id   IS 'Stripe PaymentIntent id of the most recent declined attempt (written only by charge-order). Cleared on successful payment.';

-- Snapshot the protected-columns trigger function before rewriting it (rollback script).
CREATE TABLE IF NOT EXISTS _archive.fn_enforce_protected_order_columns_s349 AS
  SELECT now() AS archived_at, pg_get_functiondef('public.enforce_protected_order_columns'::regproc) AS def;

-- Add the two new columns to the customer-write deny-list, preserving everything else byte-for-byte.
DO $$
DECLARE
  v_def    text := pg_get_functiondef('public.enforce_protected_order_columns'::regproc);
  v_needle text := $n$'charge_failed_at','charge_in_progress_at',$n$;
  v_new    text := $n$'charge_failed_at','charge_in_progress_at','charge_failure_reason','charge_failed_pi_id',$n$;
BEGIN
  IF strpos(v_def, $n$'charge_failure_reason'$n$) > 0 THEN
    RETURN; -- already patched
  END IF;
  IF strpos(v_def, v_needle) = 0 THEN
    RAISE EXCEPTION 'enforce_protected_order_columns: expected anchor not found';
  END IF;
  v_def := replace(v_def, v_needle, v_new);
  EXECUTE v_def;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.enforce_protected_order_columns'::regproc), $n$'charge_failed_pi_id'$n$) = 0 THEN
    RAISE EXCEPTION 'enforce_protected_order_columns: patch did not land';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Rollback:
--   ALTER TABLE public.orders DROP COLUMN charge_failure_reason, DROP COLUMN charge_failed_pi_id;
--   then EXECUTE the def stored in _archive.fn_enforce_protected_order_columns_s349.
