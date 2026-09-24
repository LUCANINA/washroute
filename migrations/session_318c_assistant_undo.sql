-- Session 318c: Ask Claude — Undo for changes confirmed through the assistant.
--
-- An undo is itself an assistant_actions row (action_type 'undo', params.undoes =
-- the original's id), so it goes through the same Confirm click, the same atomic
-- claim, and the same order-history entry as any other change. The original row is
-- stamped undone_at / undone_by_action_id once the undo succeeds.

-- 1) Allow 'undo' as an action type.
ALTER TABLE public.assistant_actions DROP CONSTRAINT IF EXISTS assistant_actions_action_type_check;
ALTER TABLE public.assistant_actions ADD CONSTRAINT assistant_actions_action_type_check
  CHECK (action_type IN ('reschedule','skip_or_cancel','adjust_credit','update_instructions',
                         'create_issue','add_issue_comment','undo'));

-- 2) Which undo reversed this change, and when.
ALTER TABLE public.assistant_actions
  ADD COLUMN IF NOT EXISTS undone_at           timestamptz,
  ADD COLUMN IF NOT EXISTS undone_by_action_id uuid REFERENCES public.assistant_actions(id);

-- 3) At most one undo can be running or done per original change. (Pending ones
--    are not included: an abandoned pending undo simply expires after 30 min.)
CREATE UNIQUE INDEX IF NOT EXISTS assistant_actions_one_undo_per_action
  ON public.assistant_actions ((params->>'undoes'))
  WHERE action_type = 'undo' AND status IN ('executing','done');

-- 4) Restore a skipped/cancelled order to scheduled in ONE transaction:
--    terminal → on_hold → scheduled (advance_order_status refuses a direct jump),
--    then revive its pickup + delivery stops (the terminal trigger marked them
--    skipped, and nothing revives a pickup stop on 'scheduled' by itself).
--    SECURITY INVOKER: runs as the staff member; every inner RPC keeps its own guard.
CREATE OR REPLACE FUNCTION public.restore_order_to_scheduled(p_order_id uuid, p_actor_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_status text;
BEGIN
  PERFORM public.assert_staff('restore_order_to_scheduled');
  SELECT status INTO v_status FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order % not found', p_order_id; END IF;
  IF v_status NOT IN ('skipped','cancelled') THEN
    RAISE EXCEPTION 'Order is % — only skipped or cancelled orders can be restored', v_status;
  END IF;

  PERFORM public.advance_order_status(p_order_id => p_order_id, p_new_status => 'on_hold',
            p_actor_name => p_actor_name, p_notify_sms => false);
  PERFORM public.advance_order_status(p_order_id => p_order_id, p_new_status => 'scheduled',
            p_actor_name => p_actor_name, p_notify_sms => false);
  PERFORM public.reconcile_order_stops(p_order_id, 'pickup');
  PERFORM public.reconcile_order_stops(p_order_id, 'delivery');

  RETURN jsonb_build_object('order_id', p_order_id, 'old_status', v_status, 'new_status', 'scheduled');
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.restore_order_to_scheduled(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.restore_order_to_scheduled(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.restore_order_to_scheduled(uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Rollback (if ever needed):
--   DROP FUNCTION IF EXISTS public.restore_order_to_scheduled(uuid, text);
--   DROP INDEX IF EXISTS public.assistant_actions_one_undo_per_action;
--   DELETE FROM public.assistant_actions WHERE action_type = 'undo';   -- only if none should be kept
--   ALTER TABLE public.assistant_actions DROP COLUMN undone_by_action_id, DROP COLUMN undone_at;
--   ALTER TABLE public.assistant_actions DROP CONSTRAINT assistant_actions_action_type_check;
--   ALTER TABLE public.assistant_actions ADD CONSTRAINT assistant_actions_action_type_check CHECK (action_type IN
--     ('reschedule','skip_or_cancel','adjust_credit','update_instructions','create_issue','add_issue_comment'));
