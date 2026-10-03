-- session_328_advance_order_status_keep_routing_error_when_unrouted.sql
--
-- PROBLEM (order #16426, 2026-10-02)
-- Sabrina Moore's order was charged $101.95, folded and racked, yet had ZERO route_stops
-- and routing_error = NULL. It appeared nowhere: not on a route, not in the Issues queue,
-- and not in any of the 41 daily_audit checks.
--
-- Sequence, from order_events:
--   08:42:58  recalled from Delivered -> re-routed to Berkeley PM
--   08:43:12  rollback_order_to_on_hold  -> DELETEs all stops, status on_hold,
--                                           routing_error set  (CORRECT, by design)
--   08:43:17  advance_order_status('ready_for_delivery')
--               -> v_is_forward is true for any move out of on_hold, so routing_error
--                  was CLEARED, and v_needs_reroute only fires when the target status is
--                  exactly 'scheduled', so nothing re-created the delivery stop.
--             Net: no stops, no flag, no visibility.
--
-- WHAT THIS MIGRATION DOES (deliberately narrow)
-- Stops the order from going INVISIBLE. If advance_order_status moves an order into an
-- active pipeline status while it has no live delivery stop, routing_error is PRESERVED
-- (or set) instead of cleared, so the order stays in the Issues queue and is picked up by
-- new audit check 28.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES *NOT* DO
-- It does not auto-re-route. Calling auto_route_order() here would be unsafe: after a
-- rollback, pickup_run_id is NULL and the pickup stop is gone, so for an order already at
-- processing/folding/ready_for_delivery the PICKUP branch of auto_route_order would fire
-- and INSERT a fresh pending pickup stop — sending a driver to collect laundry that is
-- already folded and racked — and would also rewrite pickup_window_start. Safe auto-
-- re-routing needs auto_route_order split into per-leg entry points
-- (auto_route_order_legs(p_order_id, p_do_pickup, p_do_delivery)) so this path can request
-- the delivery leg only. That is a separate, larger change.
--
-- METHOD
-- The body is rewritten programmatically from pg_get_functiondef() with exact-match
-- replace() + post-assertions, per the session-227 lesson: hand-retyping a 200-line
-- SECURITY DEFINER body invites transcription errors, and CREATE OR REPLACE rejects any
-- drift in parameter defaults. Signature, defaults, volatility, SECURITY DEFINER and
-- search_path all survive byte-for-byte. apply_migration wraps this in a transaction, so
-- a failed assertion rolls the whole thing back.

-- ---------------------------------------------------------------------------
-- Step 1: snapshot the current definition (this IS the rollback script)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_session_328 (
  proname     text        NOT NULL,
  def         text        NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO _archive.fn_snapshot_session_328 (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname = 'advance_order_status';

-- ---------------------------------------------------------------------------
-- Step 2: rewrite the body
-- ---------------------------------------------------------------------------
DO $mig$
DECLARE
  v_def       text;
  v_new       text;
  v_needle_a  text;
  v_needle_b  text;
  v_needle_c  text;
  v_block     text;
  v_case_new  text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'advance_order_status';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'advance_order_status not found';
  END IF;

  IF strpos(v_def, 'v_unrouted') > 0 THEN
    RAISE EXCEPTION 'advance_order_status already patched (v_unrouted present) — refusing to re-apply';
  END IF;

  -- (a) new DECLARE variable, anchored on the existing v_needs_reroute declaration
  v_needle_a := E'  v_needs_reroute bool := false;\n';
  IF strpos(v_def, v_needle_a) = 0 THEN
    RAISE EXCEPTION 'anchor (a) not found — body shape changed, review by hand';
  END IF;
  v_new := replace(v_def, v_needle_a,
    v_needle_a || E'  v_unrouted      bool := false;\n');

  -- (b) compute v_unrouted before the UPDATE, anchored on the v_needs_reroute assignment
  v_needle_b := E'  v_needs_reroute := (p_new_status = ''scheduled''\n                       AND (v_order.pickup_run_id IS NULL OR v_order.delivery_run_id IS NULL));\n';
  IF strpos(v_new, v_needle_b) = 0 THEN
    RAISE EXCEPTION 'anchor (b) not found — body shape changed, review by hand';
  END IF;

  -- dollar-quoted so nothing in here is escape-processed (session 227 trap #1)
  v_block := $g$
  -- Session 328: an order moved INTO an active pipeline status must have the delivery stop
  -- that status implies. rollback_order_to_on_hold deletes every stop by design and parks
  -- the order in on_hold WITH a routing_error, so Issues picks it up. A forward move out of
  -- on_hold used to clear that routing_error while only re-routing when the target status
  -- was exactly 'scheduled' — so advancing a reopened order straight to ready_for_delivery
  -- left it with no stops AND no flag: invisible to Issues and to every audit check.
  -- Keep the flag in that case so the order stays visible for a human to reschedule.
  -- walk_in is exempt: POS counter sales have no delivery leg by design.
  v_unrouted := (
    p_new_status = ANY(ARRAY['scheduled','picked_up','processing','folding',
                             'ready_for_delivery','out_for_delivery'])
    AND COALESCE(v_order.source, '') <> 'walk_in'
    AND NOT EXISTS (
      SELECT 1 FROM route_stops rs
      WHERE rs.order_id = p_order_id
        AND rs.stop_type = 'delivery'
        AND rs.status NOT IN ('skipped', 'failed')
    )
  );
$g$;

  v_new := replace(v_new, v_needle_b, v_needle_b || v_block);

  -- (c) preserve routing_error when the order is unrouted
  v_needle_c := E'    routing_error      = CASE\n                           WHEN v_is_forward THEN NULL\n                           ELSE routing_error\n                         END,\n';
  IF strpos(v_new, v_needle_c) = 0 THEN
    RAISE EXCEPTION 'anchor (c) not found — body shape changed, review by hand';
  END IF;

  v_case_new := $g$    routing_error      = CASE
                           WHEN v_unrouted THEN COALESCE(
                                  NULLIF(routing_error, ''),
                                  'Unrouted: no delivery stop — needs reassignment')
                           WHEN v_is_forward THEN NULL
                           ELSE routing_error
                         END,
$g$;

  v_new := replace(v_new, v_needle_c, v_case_new);

  EXECUTE v_new;
END
$mig$;

-- ---------------------------------------------------------------------------
-- Step 3: assert the rewrite landed (strpos, not LIKE — LIKE eats backslashes)
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'advance_order_status';

  IF strpos(v_src, 'v_unrouted      bool := false;') = 0 THEN
    RAISE EXCEPTION 'assert failed: v_unrouted was not declared';
  END IF;
  IF strpos(v_src, 'WHEN v_unrouted THEN COALESCE(') = 0 THEN
    RAISE EXCEPTION 'assert failed: routing_error CASE arm not installed';
  END IF;
  IF strpos(v_src, 'AND rs.stop_type = ''delivery''') = 0 THEN
    RAISE EXCEPTION 'assert failed: delivery-stop probe not installed';
  END IF;
  -- the pre-existing behaviour must still be intact
  IF strpos(v_src, 'WHEN v_is_forward THEN NULL') = 0 THEN
    RAISE EXCEPTION 'assert failed: original v_is_forward arm was lost';
  END IF;
  IF strpos(v_src, 'PERFORM public.enforce_caller_owns_order(p_order_id);') = 0 THEN
    RAISE EXCEPTION 'assert failed: ownership guard was lost';
  END IF;
END
$chk$;

-- ---------------------------------------------------------------------------
-- Step 4: re-assert grants (they should already be correct; this is belt-and-braces)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.advance_order_status(uuid, text, text, text, text, integer, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.advance_order_status(uuid, text, text, text, text, integer, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.advance_order_status(uuid, text, text, text, text, integer, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- ROLLBACK
--   DO $$ DECLARE d text; BEGIN
--     SELECT def INTO d FROM _archive.fn_snapshot_session_328
--      WHERE proname='advance_order_status' ORDER BY snapshot_at DESC LIMIT 1;
--     EXECUTE d;
--   END $$;
-- ---------------------------------------------------------------------------
