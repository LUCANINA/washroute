-- session_326c — stamp orders.processed_site_id, without touching record_order_intake.
-- APPLIED 2026-10-01 via apply_migration (same name)
--
-- WHY THIS SHAPE: the first plan appended a parameter to record_order_intake, which
-- creates a second overload and therefore requires dropping the 12-argument version in
-- the same transaction. That DROP is correctly treated as destructive by the migration
-- tooling and could not be completed (one cancel, one 180s timeout; verified afterwards
-- that nothing applied and no locks were left held). Rather than hide the drop inside
-- dynamic SQL to evade that check, this takes the additive route: a small dedicated RPC.
-- record_order_intake — the central money path, with the credit-refund logic behind the
-- Adriana #2034 / Sameer #2988 re-intake bug class — is not modified at all, which is
-- strictly less risk than rewriting it for a provenance field.
--
-- TRADE-OFF, stated plainly: the stamp is a second call after intake, so it is not
-- atomic with the weight. The failure mode is benign and visible — the order reads
-- "not recorded" rather than showing a wrong site — and the dashboard checks the error
-- and toasts. A missing stamp is never silently wrong data.
--
-- The site comes from the Processing Queue's site filter (session 149, persisted as
-- wr-proc-site-filter), which is "the facility whose queue I am working". "All sites"
-- sends NULL and stamps nothing. Nothing in the database knows where a staff member is
-- standing: launderers, profiles and racks all carry no site.
--
-- IDEMPOTENT: re-stamping the same site is a no-op, so a re-intake is harmless.
-- An order_event is written ONLY when this CHANGES an already-recorded site — that is
-- the interesting case (bag reprocessed at the other facility). A first stamp logs
-- nothing, to keep the History tab uncluttered.
--
-- SECURITY DEFINER checklist (session 148): assert_staff guard because it mutates a
-- customer-visible order; explicit search_path; both REVOKEs plus the GRANT, because
-- Supabase grants anon separately and REVOKE PUBLIC alone does not cover it.
-- processed_site_id is on enforce_protected_order_columns' deny-list (session_326),
-- so customers cannot write it directly — only through this guard.
--
-- TESTED in a rolled-back transaction against order #16365: first stamp sets the site;
-- re-stamping the same site is a no-op; changing the site writes exactly one
-- order_event (proving the first stamp logs nothing); a NULL site returns cleanly
-- rather than erroring. Rollback confirmed — the order was left untouched.
--
-- ROLLBACK: DROP FUNCTION public.set_order_processed_site(uuid, uuid);

CREATE OR REPLACE FUNCTION public.set_order_processed_site(
  p_order_id uuid,
  p_site_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_prev      uuid;
  v_prev_name text;
  v_name      text;
  v_num       int;
BEGIN
  PERFORM public.assert_staff('set_order_processed_site');

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_site_id IS NULL THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'no_site_selected');
  END IF;

  SELECT name INTO v_name FROM sites WHERE id = p_site_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site % not found', p_site_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT processed_site_id, order_number INTO v_prev, v_num
  FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order % not found', p_order_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_prev IS NOT DISTINCT FROM p_site_id THEN
    RETURN jsonb_build_object('stamped', false, 'reason', 'unchanged', 'site', v_name);
  END IF;

  IF v_prev IS NOT NULL THEN
    SELECT name INTO v_prev_name FROM sites WHERE id = v_prev;
    INSERT INTO order_events (order_id, event_type, description, old_value, new_value, actor_name)
    VALUES (
      p_order_id, 'manual_fix',
      'Processing site changed from ' || COALESCE(v_prev_name, '—') || ' to ' || v_name,
      COALESCE(v_prev_name, '—'), v_name,
      COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), 'Staff')
    );
  END IF;

  UPDATE orders
     SET processed_site_id = p_site_id,
         updated_at        = NOW()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'stamped', true,
    'site', v_name,
    'order_number', v_num,
    'replaced', v_prev IS NOT NULL
  );
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.set_order_processed_site(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_order_processed_site(uuid, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_order_processed_site(uuid, uuid) TO authenticated, service_role;
