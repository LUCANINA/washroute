-- session 291j — sweep_autocharge_ready_orders: retry a FAILED order once the
-- customer puts a new card on file.
--
-- APPLIED 2026-09-11 22:44 UTC, after washroute-preflight. First run at 22:50
-- charged the one eligible order: #14759 Jenny Brandt $192.95 -> billing_status
-- 'paid', one payment_received SMS, no duplicates. #14729 Sandra Lawson correctly
-- left alone (no new card).
--
-- Problem
-- -------
-- The sweep only picks orders with `billing_status IS NULL` ("never charged").
-- charge-order stamps `billing_status='failed'` + `charge_failed_at` on a decline,
-- so a failed order leaves the safety net permanently. Nothing puts it back:
-- the stripe-webhook `setup` branch saves the new card and the Stripe default, and
-- neither it nor any trigger on customers / customer_payment_methods clears the
-- stamp or re-calls charge-order. A customer can update their card and the order
-- still sits unpaid until a human clicks Retry charge in the dashboard.
--
-- Fix
-- ---
-- Add a second eligibility branch: billing_status='failed' AND the customer has a
-- customer_payment_methods row created AFTER the failure. The failure stamp is
-- left intact (it is the audit record, and 291f's write-off logic reads it).
--
-- Why this is self-limiting: charge-order's stampChargeFailed() rewrites
-- charge_failed_at on every new failure, so after a retry that also declines the
-- newest card is older than the failure again and the order drops out. One
-- automatic attempt per card added — no loop, one "update your card" SMS per
-- attempt.
--
-- Deliberate bounds
--   * 30-day recency: an order that failed months ago should not silently charge a
--     card added today. Matches the 291f write-off window.
--   * The legacy `customers.stripe_default_payment_method_id` column has no
--     timestamp, so it cannot gate a retry. Only the customer_payment_methods
--     table can. Adding a card always writes a row there (stripe-webhook
--     saveCardToTable), so this costs nothing in practice — the 15 customers with
--     a row but no default column (291i) are unaffected.
--   * Also note upsert semantics: saveCardToTable upserts on
--     stripe_payment_method_id, so re-attaching the SAME Stripe payment method
--     keeps the old created_at and will NOT trigger a retry. A genuinely new card
--     gets a new pm id and a fresh row.
--
-- Blast radius, measured 2026-09-11 before writing this:
--   2 orders at billing_status='failed' (both active, both ready_for_delivery),
--   of which 1 becomes eligible immediately — #14759 Jenny Brandt, $192.95
--   (card on file is newer than her failure). #14729 Sandra Lawson is NOT
--   eligible: no new card yet, so she still needs the Update-card link.
--
-- Interaction to watch: the sweep is ORDER BY o.updated_at LIMIT 20. Failed
-- orders are older than fresh ones, so a large failed backlog could crowd out
-- never-charged orders in a single run. Harmless at 2 rows; revisit if the
-- failed count ever runs into the dozens.
--
-- Rollback: public._archive_sweep_autocharge_291j holds the pre-change
-- pg_get_functiondef output; EXECUTE it to restore.

DO $mig$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'sweep_autocharge_ready_orders';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'sweep_autocharge_ready_orders not found';
  END IF;

  CREATE TABLE IF NOT EXISTS public._archive_sweep_autocharge_291j (
    archived_at timestamptz DEFAULT now(),
    def text
  );
  INSERT INTO public._archive_sweep_autocharge_291j (def) VALUES (v_def);
END
$mig$;

CREATE OR REPLACE FUNCTION public.sweep_autocharge_ready_orders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- anon key (already public in all client apps); charge-order is verify_jwt:false
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtanBidXhyZHlkd2VqcXRlbnNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NjgzMDQsImV4cCI6MjA4NzU0NDMwNH0.22WyUfBsqPaaza_HiDo1f_tQE3sGUDEJYYyV29XUSeY';
  r RECORD;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT o.id
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.status IN ('ready_for_delivery','out_for_delivery','delivered')
      AND (
        o.billing_status IS NULL                         -- never charged
        OR (                                             -- 291j: failed, but a NEW card has since been added
          o.billing_status = 'failed'
          AND o.charge_failed_at IS NOT NULL
          AND o.charge_failed_at > now() - interval '30 days'
          AND EXISTS (
            SELECT 1 FROM customer_payment_methods pm
            WHERE pm.customer_id = c.id
              AND pm.created_at > o.charge_failed_at
          )
        )
      )
      AND COALESCE(o.total_amount, 0) + COALESCE(o.tip_amount, 0) > 0
      AND COALESCE(o.source, '') <> 'walk_in'            -- retail is paid at the counter
      AND COALESCE(c.billing_type, '') <> 'on_account'   -- on-account is invoiced, not card-charged
      AND (EXISTS (SELECT 1 FROM customer_payment_methods pm WHERE pm.customer_id = c.id)
           OR c.stripe_default_payment_method_id IS NOT NULL)   -- card on file (table, or legacy column)
      AND o.archived_at IS NULL
      AND o.updated_at < now() - interval '3 minutes'    -- let the client's own charge finish first
    ORDER BY o.updated_at
    LIMIT 20                                             -- cap per-run volume
  LOOP
    PERFORM net.http_post(
      url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/charge-order',
      headers := jsonb_build_object('x-wr-internal', public.wr_internal_secret(),
                   'Content-Type', 'application/json',
                   'apikey', v_anon,
                   'Authorization', 'Bearer ' || v_anon
                 ),
      body    := jsonb_build_object('orderId', r.id)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;

-- GRANTS: deliberately untouched. CREATE OR REPLACE preserves the existing ACL,
-- which today is {postgres, service_role} only (verified 2026-09-11) — tighter
-- than the usual SECURITY DEFINER pattern because only pg_cron calls this. Do NOT
-- add `authenticated` here; that would expose a customer-charging fan-out to every
-- logged-in session. Asserted below.

-- Assert the new branch actually landed (apply_migration is transactional, so a
-- failed assert rolls the whole thing back).
DO $chk$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname='public' AND p.proname='sweep_autocharge_ready_orders'),
            'pm.created_at > o.charge_failed_at') = 0 THEN
    RAISE EXCEPTION '291j did not apply: retry branch missing';
  END IF;

  IF (SELECT p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname='public' AND p.proname='sweep_autocharge_ready_orders')
     <> '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION '291j: EXECUTE grants drifted — expected postgres + service_role only';
  END IF;
END
$chk$;
