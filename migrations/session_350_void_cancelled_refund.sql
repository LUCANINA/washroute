-- Session 350: cancelled / failed Stripe refunds.
-- WashRoute records a refund when it is issued and never heard from Stripe again,
-- so a refund cancelled in Stripe kept showing as refunded (Oliver Hunt, #18954).
--
-- 1) customer_transactions.stripe_refund_id  — lets the webhook find the row (re_...).
-- 2) void_order_refund()                     — the exact reverse of record_order_refund:
--    row type 'refund' -> 'refund_cancelled' (kept for audit, drops out of every
--    type='refund' total), lifetime_value + amount, orders.amount_refunded - amount,
--    billing_status back to 'paid' if it is no longer a full refund, order_events log.

ALTER TABLE public.customer_transactions ADD COLUMN IF NOT EXISTS stripe_refund_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ct_stripe_refund_id
  ON public.customer_transactions (stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ct_stripe_pi
  ON public.customer_transactions (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.void_order_refund(
  p_refund_transaction_id uuid,
  p_reason     text DEFAULT NULL::text,
  p_actor_name text DEFAULT 'Admin'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_role     text;
  v_txn      customer_transactions%ROWTYPE;
  v_order    orders%ROWTYPE;
  v_gross    numeric := 0;
  v_new_ref  numeric := 0;
  v_new_bs   text;
BEGIN
  -- Money movement: same gate as record_order_refund.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    SELECT role INTO v_role FROM profiles WHERE id = auth.uid();
    IF COALESCE(v_role, '') NOT IN ('admin', 'manager') THEN
      RAISE EXCEPTION 'Role % is not allowed to void refunds', COALESCE(v_role, 'anonymous')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO v_txn FROM customer_transactions WHERE id = p_refund_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction % not found', p_refund_transaction_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent: Stripe retries webhooks.
  IF v_txn.type = 'refund_cancelled' THEN
    RETURN jsonb_build_object('already_voided', true, 'transaction_id', v_txn.id);
  END IF;
  IF v_txn.type <> 'refund' THEN
    RAISE EXCEPTION 'Transaction % is a %, not a refund', v_txn.id, v_txn.type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE customer_transactions
     SET type        = 'refund_cancelled',
         description = 'Refund cancelled: ' || regexp_replace(COALESCE(description, ''), '^Refund:\s*', ''),
         note        = concat_ws(' · ', note, 'Cancelled' || COALESCE(': ' || p_reason, ''))
   WHERE id = v_txn.id;

  -- Lifetime value gets the money back.
  IF v_txn.customer_id IS NOT NULL THEN
    UPDATE customers
       SET lifetime_value = COALESCE(lifetime_value, 0) + v_txn.amount,
           updated_at     = NOW()
     WHERE id = v_txn.customer_id;
  END IF;

  -- Order accumulator back down; un-flip 'refunded' if no longer a full refund.
  IF v_txn.order_id IS NOT NULL THEN
    SELECT * INTO v_order FROM orders WHERE id = v_txn.order_id FOR UPDATE;
    IF FOUND THEN
      v_gross   := COALESCE(v_order.total_amount, 0) + COALESCE(v_order.tip_amount, 0);
      v_new_ref := GREATEST(0, COALESCE(v_order.amount_refunded, 0) - v_txn.amount);
      v_new_bs  := CASE WHEN v_order.billing_status = 'refunded' AND v_new_ref < (v_gross - 0.005)
                        THEN 'paid' ELSE v_order.billing_status END;
      UPDATE orders
         SET amount_refunded = v_new_ref,
             billing_status  = v_new_bs,
             updated_at      = NOW()
       WHERE id = v_order.id;

      INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
      VALUES (v_order.id, 'billing',
              'Refund of $' || TO_CHAR(v_txn.amount, 'FM999990.00') || ' cancelled'
                || COALESCE(' (' || p_reason || ')', ''),
              v_order.billing_status, v_new_bs, COALESCE(p_actor_name, 'Admin'));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'transaction_id',        v_txn.id,
    'amount',                v_txn.amount,
    'customer_id',           v_txn.customer_id,
    'order_id',              v_txn.order_id,
    'order_amount_refunded', v_new_ref
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.void_order_refund(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_order_refund(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_order_refund(uuid, text, text) TO authenticated, service_role;
