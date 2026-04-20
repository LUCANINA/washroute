-- Session 131 follow-up — protect dedicated commercial routes (stop_limit = 0)
-- from the Phase 2 overcap logic.
--
-- Rationale
-- ---------
-- Kidango (and any future dedicated commercial route) uses route_templates.stop_limit = 0
-- as a convention meaning "no capacity check — this is a special route." Phase 2's three
-- functions (auto_route_order, sync_pickup_stop_on_window_change,
-- sync_delivery_stop_on_window_change) only guarded with `stop_limit IS NOT NULL`, so 0
-- was interpreted as "limit = 0" → FLOOR(0/num_subs) = 0 sub-limit → every stop flagged
-- as overcap.
--
-- This patch tightens the guard to `IS NOT NULL AND > 0` at 4 sites (2 in
-- auto_route_order, 1 each in the two sync functions). No other logic changes.
--
-- Applied as migration: session_131_phase2_skip_stop_limit_zero
--
-- Reversibility
-- -------------
-- To revert: replace `v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN`
-- with `v_tmpl.stop_limit IS NOT NULL THEN` in the same three functions.

DO $migrate$
DECLARE
  v_def TEXT;
BEGIN
  FOR v_def IN
    SELECT pg_get_functiondef(oid)
    FROM pg_proc
    WHERE proname IN (
      'auto_route_order',
      'sync_pickup_stop_on_window_change',
      'sync_delivery_stop_on_window_change'
    )
    AND pronamespace = 'public'::regnamespace
  LOOP
    v_def := REPLACE(
      v_def,
      'v_tmpl.stop_limit IS NOT NULL THEN',
      'v_tmpl.stop_limit IS NOT NULL AND v_tmpl.stop_limit > 0 THEN'
    );
    EXECUTE v_def;
  END LOOP;
END $migrate$;
