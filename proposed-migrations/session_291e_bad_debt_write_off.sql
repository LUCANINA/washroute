-- Session 291e — Bad-debt write-off: audit trail, freeze link, and the RPC.
--
-- Today this is a manual SQL ritual. Both frozen customers carry
-- frozen_reason = 'Unpaid order #NNNN written off as uncollectible', and all 8
-- written_off orders carry NO date, NO author and NO reason -- unusable for
-- accounting. This makes the ritual one auditable action.
--
-- RULES (David, session 291):
--   * Any ADMIN or MANAGER can write off. NOT is_staff() and NOT is_admin():
--     is_admin() returns true for 'laundry_tech' despite its name, and the folding
--     floor must not be able to destroy revenue. The roles are spelled out in the
--     function so the guard cannot drift with a helper's meaning.
--   * ON-ACCOUNT customers are EXCLUDED. They are invoiced; an unpaid invoice is
--     a collections matter and may need a Xero credit note, not a write-off here.
--   * Writing off FREEZES the customer. trg_enforce_not_frozen already blocks new
--     orders and silently skips recurring generation, so no other wiring is needed.
--
-- WHY frozen_by_order_id: auto-unfreeze on payment must release ONLY a freeze
-- caused by this debt, never one an admin set for another reason. Without the
-- link there is no way to tell those apart.
--
-- Accounting note: revenue reaches Xero via Stripe payouts (collected money), so
-- an uncollected card order never entered Xero as revenue. There is nothing to
-- reverse -- this is revenue never recognised, not an expense to book. Hence an
-- audit trail and a report, not a journal. On-account is excluded above precisely
-- because that assumption does not hold there.

BEGIN;

-- ── 1. Audit trail on the order ──────────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS written_off_at     timestamptz,
  ADD COLUMN IF NOT EXISTS written_off_by     text,
  ADD COLUMN IF NOT EXISTS written_off_reason text;

-- ── 2. Link a freeze to the debt that caused it ──────────────────────────────
-- ⚠️ SUPERSEDED BY 291e-3: the REFERENCES clause below was DROPPED minutes after
-- this migration applied. It created a second orders<->customers relationship and
-- made every PostgREST embed between those tables ambiguous, taking the Orders
-- page down. Add the column WITHOUT the foreign key:
--   ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS frozen_by_order_id uuid;
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS frozen_by_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_written_off_at ON public.orders (written_off_at DESC) WHERE written_off_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_frozen_by_order ON public.customers (frozen_by_order_id) WHERE frozen_by_order_id IS NOT NULL;

-- ── 3. Backfill what can be known about the 8 existing write-offs ────────────
-- updated_at is the closest honest proxy for when it happened. Marked as migrated
-- rather than invented, so a reader can tell a real reason from a reconstructed one.
UPDATE public.orders
   SET written_off_at     = COALESCE(written_off_at, updated_at, created_at),
       written_off_by     = COALESCE(written_off_by, 'migration'),
       written_off_reason = COALESCE(written_off_reason,
                            '(migrated — written off before a reason was recorded)')
 WHERE billing_status = 'written_off';

-- Link the two existing debt freezes to the orders their reason already names.
UPDATE public.customers c
   SET frozen_by_order_id = o.id
  FROM public.orders o
 WHERE c.frozen_at IS NOT NULL
   AND c.frozen_by_order_id IS NULL
   AND c.frozen_reason ~ ('#' || o.order_number::text || '\M')
   AND o.customer_id = c.id;

-- ── 4. Protected-column deny-lists (CLAUDE.md: same migration, no exceptions) ─
-- These arrays are deny-lists: a new money/identity column is writable by any
-- customer until it is listed.
--
-- Rewritten from pg_get_functiondef() by string insertion rather than by pasting
-- the bodies back in. Session 227's lesson: hand-copying a function body to change
-- one line risks a silent transcription error in the 40 lines you did not mean to
-- touch. Snapshot first, insert, then assert -- apply_migration wraps this in a
-- transaction, so a failed assert rolls the whole migration back.
INSERT INTO public._archive_rpc_defs (label, proname, definition)
SELECT 'session_291e_pre', p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('enforce_protected_order_columns','enforce_protected_customer_columns');

DO $rewrite$
DECLARE
  r        record;
  v_anchor text;
  v_add    text;
  v_def    text;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('enforce_protected_order_columns','enforce_protected_customer_columns')
  LOOP
    IF r.proname = 'enforce_protected_order_columns' THEN
      -- Dollar-quoted: no escape processing, so nothing can silently collapse.
      v_anchor := $a$'archived_at','archived_by','archived_reason',$a$;
      v_add    := $a$'archived_at','archived_by','archived_reason',
    'written_off_at','written_off_by','written_off_reason',$a$;
    ELSE
      v_anchor := $a$'frozen_at','frozen_reason',$a$;
      v_add    := $a$'frozen_at','frozen_reason','frozen_by_order_id',$a$;
    END IF;

    IF strpos(r.def, v_anchor) = 0 THEN
      RAISE EXCEPTION 'anchor not found in % -- refusing to rewrite blind', r.proname;
    END IF;

    v_def := replace(r.def, v_anchor, v_add);
    EXECUTE v_def;
  END LOOP;
END
$rewrite$;

-- Assert the deny-lists actually took, and that nothing else was lost. strpos,
-- never LIKE: LIKE treats backslash as an escape and would eat what we verify.
DO $assert$
DECLARE v_o text; v_c text;
BEGIN
  SELECT prosrc INTO v_o FROM pg_proc WHERE proname='enforce_protected_order_columns'    AND pronamespace='public'::regnamespace;
  SELECT prosrc INTO v_c FROM pg_proc WHERE proname='enforce_protected_customer_columns' AND pronamespace='public'::regnamespace;

  IF strpos(v_o, 'written_off_reason') = 0 THEN RAISE EXCEPTION 'order deny-list did not take'; END IF;
  IF strpos(v_c, 'frozen_by_order_id') = 0 THEN RAISE EXCEPTION 'customer deny-list did not take'; END IF;

  -- The pre-existing entries and the escape hatches must all still be there.
  IF strpos(v_o, 'billing_status') = 0 OR strpos(v_o, 'actual_delivery_at') = 0
     OR strpos(v_o, 'pos_session_active') = 0 THEN
    RAISE EXCEPTION 'order trigger lost pre-existing content';
  END IF;
  IF strpos(v_c, 'lifetime_value') = 0 OR strpos(v_c, 'invoice_body_template') = 0
     OR strpos(v_c, 'paygo') = 0 OR strpos(v_c, 'pos_session_active') = 0 THEN
    RAISE EXCEPTION 'customer trigger lost pre-existing content';
  END IF;
END
$assert$;

-- ── 5. The action itself ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.write_off_order(
  p_order_id uuid,
  p_reason   text DEFAULT NULL,
  p_actor    text DEFAULT NULL
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_o        record;
  v_btype    text;
  v_actor    text;
  v_reason   text;
  v_is_auto  boolean := (COALESCE(auth.role(), '') = 'service_role');
BEGIN
  -- Any ADMIN, plus the nightly job (service_role).
  -- Deliberately NOT is_staff() (drivers, attendants, pos_device) and deliberately
  -- NOT is_admin() either: despite the name, is_admin() returns true for
  -- 'laundry_tech', and the folding floor must not be able to destroy revenue and
  -- freeze a customer. The role list is spelled out here so it cannot drift.
  IF NOT v_is_auto AND NOT EXISTS (
       SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role IN ('admin','manager')
     ) THEN
    RAISE EXCEPTION 'Only an admin can write off an order.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT o.*, c.billing_type INTO v_o
  FROM public.orders o LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.' USING ERRCODE = 'no_data_found';
  END IF;

  -- Terminal states are terminal. Writing off paid money would silently destroy
  -- a settled order's billing history.
  IF COALESCE(v_o.billing_status,'') IN ('paid','refunded','written_off') THEN
    RAISE EXCEPTION 'Order #% is already %, nothing to write off.',
      v_o.order_number, v_o.billing_status USING ERRCODE = 'check_violation';
  END IF;

  -- David's rule: on-account is excluded. Those are invoiced customers whose
  -- unpaid balance is a collections matter, settled in Reports -> On Account.
  IF COALESCE(v_o.billing_type,'') = 'on_account' THEN
    RAISE EXCEPTION 'Order #% belongs to an on-account customer — write-offs are excluded for invoiced accounts.',
      v_o.order_number USING ERRCODE = 'check_violation';
  END IF;

  v_actor  := COALESCE(NULLIF(BTRIM(COALESCE(p_actor,'')), ''),
                       CASE WHEN v_is_auto THEN 'auto (30-day rule)' ELSE 'admin' END);
  v_reason := COALESCE(NULLIF(BTRIM(COALESCE(p_reason,'')), ''),
                       'Uncollectible');

  UPDATE public.orders
     SET billing_status     = 'written_off',
         written_off_at     = now(),
         written_off_by     = v_actor,
         written_off_reason = v_reason,
         updated_at         = now()
   WHERE id = p_order_id;

  -- Freeze the account. Only sets frozen_at if not already frozen, so an existing
  -- freeze (and its reason) is never overwritten by a second write-off.
  IF v_o.customer_id IS NOT NULL THEN
    UPDATE public.customers
       SET frozen_at          = COALESCE(frozen_at, now()),
           frozen_reason      = COALESCE(frozen_reason,
                                  'Unpaid order #' || v_o.order_number || ' written off as uncollectible'),
           frozen_by_order_id = COALESCE(frozen_by_order_id, p_order_id)
     WHERE id = v_o.customer_id;
  END IF;

  RETURN jsonb_build_object(
    'order_id', p_order_id, 'order_number', v_o.order_number,
    'amount', v_o.total_amount, 'customer_id', v_o.customer_id,
    'written_off_by', v_actor, 'reason', v_reason, 'auto', v_is_auto
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.write_off_order(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.write_off_order(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.write_off_order(uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.write_off_order(uuid, text, text) IS
  'Marks an unpaid order uncollectible and freezes the customer, in one transaction. Admin-only (or the nightly 30-day job as service_role). Refuses paid/refunded/already-written-off orders and on-account customers. Session 291e.';

COMMIT;
