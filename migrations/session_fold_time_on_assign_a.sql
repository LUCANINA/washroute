-- PART 1 — forward fix (Blanca, 2026-10-30)
-- POS folder assignment never stamped orders.folded_at, so Foothill folds were
-- invisible in Admin → Launderers → history (filters by folded_at).
-- The non-folding branch of assign_order_launderers now stamps folded_at when
-- empty (never overwrites). No signature/default/grant change.
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_20261030 (proname text, def text, taken_at timestamptz default now());
INSERT INTO _archive.fn_snapshot_20261030 (proname, def)
VALUES ('assign_order_launderers', pg_get_functiondef('public.assign_order_launderers'::regproc));

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.assign_order_launderers'::regproc);
  v_old text := $o$    UPDATE public.orders
       SET folded_by_id = v_primary,
           updated_at   = NOW()
     WHERE id = p_order_id;$o$;
  v_new text := $n$    UPDATE public.orders
       SET folded_by_id = v_primary,
           folded_at    = COALESCE(folded_at, NOW()),
           updated_at   = NOW()
     WHERE id = p_order_id;$n$;
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one match of the else-branch UPDATE';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid='public.assign_order_launderers'::regproc),
            'folded_at    = COALESCE(folded_at, NOW())') = 0 THEN
    RAISE EXCEPTION 'rewrite did not land';
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.assign_order_launderers(uuid, jsonb, text, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_order_launderers(uuid, jsonb, text, boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.assign_order_launderers(uuid, jsonb, text, boolean) TO authenticated, service_role;
-- Rollback: EXECUTE (SELECT def FROM _archive.fn_snapshot_20261030 WHERE proname='assign_order_launderers');
