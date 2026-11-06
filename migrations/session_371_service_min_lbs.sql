-- Session 371 (applied 2026-11-06 as migration "session_370_service_min_lbs" — the
-- name predates renumbering; session 370 was the same day's bookkeeping session).
-- Per-lb minimum order weight, set per service (price list). Orders weighing less than
-- min_lbs are billed a "Minimum order adjustment" line for the difference at the
-- service's own per-lb rate. Applies to orders picked up on/after min_lbs_from (Pacific).
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS min_lbs numeric CHECK (min_lbs IS NULL OR min_lbs > 0),
  ADD COLUMN IF NOT EXISTS min_lbs_from date;

COMMENT ON COLUMN public.services.min_lbs IS 'Per-lb services only: minimum billable weight. NULL = no minimum.';
COMMENT ON COLUMN public.services.min_lbs_from IS 'First pickup date (Pacific) the minimum applies to. NULL = always (when min_lbs set).';

-- David, 2026-11-06: 25 lb minimum on Commercial + on-account per-lb (HCEB) from 2026-12-01.
UPDATE public.services SET min_lbs = 25, min_lbs_from = DATE '2026-12-01'
 WHERE pricing_type = 'per_lb' AND is_addon = false AND pricelist IN ('Commercial','HCEB');

NOTIFY pgrst, 'reload schema';

-- Rollback:
-- ALTER TABLE public.services DROP COLUMN min_lbs, DROP COLUMN min_lbs_from;
