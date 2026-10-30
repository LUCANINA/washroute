-- PART 2 — backfill (~1,965 orders: folder set, folded_at empty).
-- folded_at := time of the first 'folded' (assignment) event in order_events.
-- Only orders.folded_at changes. Several orders triggers fire on ANY update
-- (subscription re-link/reprice on unpaid orders, route-stop resync), so they
-- are disabled for this one transaction only. None send messages.
CREATE TABLE _archive.folded_at_backfill_20261030 AS
SELECT o.id, o.folded_at AS old_folded_at,
       (SELECT min(e.created_at) FROM public.order_events e
         WHERE e.order_id = o.id AND e.event_type = 'folded') AS new_folded_at
FROM public.orders o
WHERE o.folded_by_id IS NOT NULL AND o.folded_at IS NULL;

ALTER TABLE public.orders DISABLE TRIGGER USER;
UPDATE public.orders o SET folded_at = b.new_folded_at
FROM _archive.folded_at_backfill_20261030 b
WHERE o.id = b.id AND b.new_folded_at IS NOT NULL AND o.folded_at IS NULL;
ALTER TABLE public.orders ENABLE TRIGGER USER;

DO $$ BEGIN
  -- all orders triggers were enabled before this ran (checked 2026-10-30); prove they still are
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.orders'::regclass
             AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'an orders trigger is still disabled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE folded_by_id IS NOT NULL AND folded_at IS NULL
             AND id IN (SELECT id FROM _archive.folded_at_backfill_20261030 WHERE new_folded_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'backfill incomplete';
  END IF;
END $$;
-- Rollback: UPDATE public.orders o SET folded_at = NULL
--   FROM _archive.folded_at_backfill_20261030 b WHERE o.id = b.id AND o.folded_at = b.new_folded_at;
