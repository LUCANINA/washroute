-- Session 342 — APPLIED 2026-10-10 by David via Supabase SQL Editor (verified: trigger live, 0 active recurring orders missing anchors)
-- Reviewed with washroute-migration-review: clear to apply. Reversible (see bottom).
--
-- A recurring order's "usual slot" (recurring_anchor_at / recurring_delivery_anchor_at)
-- was only set by the generator for 2nd+ occurrences. The FIRST order of a chain had NULL
-- anchors, so trg_create_recurring_order_fn fell back to its CURRENT window — a one-time
-- move of that first order became permanent. Fix: stamp anchors whenever an order is (or
-- becomes) recurring, never overwriting an existing anchor.

-- 1) Snapshot (rollback source)
CREATE TABLE IF NOT EXISTS _archive._backfill_recurring_anchors_20261010 AS
SELECT id, order_number, status, recurring_interval, recurring_anchor_at, recurring_delivery_anchor_at,
       pickup_window_start, delivery_window_start, now() AS snapshot_at
FROM public.orders
WHERE recurring_interval IS NOT NULL AND recurring_interval <> ''
  AND (recurring_anchor_at IS NULL OR recurring_delivery_anchor_at IS NULL)
  AND status IN ('scheduled','picked_up','processing','ready_for_delivery');

-- 2) Trigger function
CREATE OR REPLACE FUNCTION public.stamp_recurring_anchors_fn()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF NEW.recurring_interval IS NULL OR NEW.recurring_interval = '' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.recurring_interval IS NULL OR OLD.recurring_interval = '' THEN
    -- New recurring order (or just converted to recurring): its slot IS the usual slot.
    NEW.recurring_anchor_at          := COALESCE(NEW.recurring_anchor_at, NEW.pickup_window_start);
    NEW.recurring_delivery_anchor_at := COALESCE(NEW.recurring_delivery_anchor_at, NEW.delivery_window_start);
  ELSE
    -- Already recurring but anchor missing: pin to the slot BEFORE this change, so a
    -- move made now stays one-time ("apply to all future" sets the anchor itself).
    NEW.recurring_anchor_at          := COALESCE(NEW.recurring_anchor_at, OLD.pickup_window_start, NEW.pickup_window_start);
    NEW.recurring_delivery_anchor_at := COALESCE(NEW.recurring_delivery_anchor_at, OLD.delivery_window_start, NEW.delivery_window_start);
  END IF;
  RETURN NEW;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.stamp_recurring_anchors_fn() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.stamp_recurring_anchors_fn() FROM anon;

-- 3) Trigger — "zz" so it runs after every other BEFORE trigger (incl. protected-columns)
DROP TRIGGER IF EXISTS trg_zz_stamp_recurring_anchors ON public.orders;
CREATE TRIGGER trg_zz_stamp_recurring_anchors
BEFORE INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.stamp_recurring_anchors_fn();

-- 4) Backfill active orders missing anchors (5 on 2026-10-10; none had been moved in time)
UPDATE public.orders o
SET recurring_anchor_at          = COALESCE(o.recurring_anchor_at, o.pickup_window_start),
    recurring_delivery_anchor_at = COALESCE(o.recurring_delivery_anchor_at, o.delivery_window_start)
FROM _archive._backfill_recurring_anchors_20261010 b
WHERE o.id = b.id;

-- 5) Assert (rolls everything back if it fails)
DO $chk$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.orders
  WHERE recurring_interval IS NOT NULL AND recurring_interval <> ''
    AND status IN ('scheduled','picked_up','processing','ready_for_delivery')
    AND (recurring_anchor_at IS NULL OR (recurring_delivery_anchor_at IS NULL AND delivery_window_start IS NOT NULL));
  IF n > 0 THEN RAISE EXCEPTION 'still % active recurring orders without anchors', n; END IF;
END
$chk$;

-- ROLLBACK:
-- DROP TRIGGER IF EXISTS trg_zz_stamp_recurring_anchors ON public.orders;
-- DROP FUNCTION IF EXISTS public.stamp_recurring_anchors_fn();
-- UPDATE public.orders o SET recurring_anchor_at = b.recurring_anchor_at,
--        recurring_delivery_anchor_at = b.recurring_delivery_anchor_at
--   FROM _archive._backfill_recurring_anchors_20261010 b WHERE o.id = b.id;
