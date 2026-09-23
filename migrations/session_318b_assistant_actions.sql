-- Session 318b: Ask Claude Phase 2 — proposed actions that wait for a staff "Confirm" click,
-- plus a p_notify switch on reschedule_order_to_window so staff choose whether the customer is texted.

-- 1) Pending/decided actions. Written only by the admin-assistant edge function (service role).
CREATE TABLE public.assistant_actions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  conversation_id   uuid        NOT NULL,
  proposed_by       uuid        NOT NULL,
  proposed_by_name  text,
  action_type       text        NOT NULL CHECK (action_type IN
                      ('reschedule','skip_or_cancel','adjust_credit','update_instructions','create_issue','add_issue_comment')),
  params            jsonb       NOT NULL,
  summary           text        NOT NULL,
  preview           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executing','done','failed','cancelled')),
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  decided_at        timestamptz,
  decided_by        uuid,
  notify            boolean,
  result            jsonb,
  error             text
);
CREATE INDEX assistant_actions_conversation_idx ON public.assistant_actions (conversation_id);
CREATE INDEX assistant_actions_created_at_idx   ON public.assistant_actions (created_at DESC);
ALTER TABLE public.assistant_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_actions FROM anon;
REVOKE ALL ON public.assistant_actions FROM authenticated;
GRANT SELECT ON public.assistant_actions TO authenticated;
GRANT ALL    ON public.assistant_actions TO service_role;
CREATE POLICY assistant_actions_admin_read ON public.assistant_actions
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','manager')));

-- 2) reschedule_order_to_window gains p_notify (DEFAULT true = today's behaviour for the two
--    existing callers, which both pass named args). Rewritten from pg_get_functiondef so the
--    body, defaults, SECURITY DEFINER and search_path survive byte-for-byte.
DO $mig$
DECLARE
  v_oid  oid := 'public.reschedule_order_to_window(uuid,text,date,text,text,boolean)'::regprocedure;
  v_def  text;
  v_new  text;
  v_hdr_old text := $h$p_dry_run boolean DEFAULT false)$h$;
  v_hdr_new text := $h$p_dry_run boolean DEFAULT false, p_notify boolean DEFAULT true)$h$;
  v_call_old text := $c$    p_actor_name => p_actor_name
  ) INTO v_rpc_result;$c$;
  v_call_new text := $c$    p_actor_name => p_actor_name,
    p_notify => p_notify
  ) INTO v_rpc_result;$c$;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  INSERT INTO _archive._backup_function_defs (saved_at, function_name, definition)
  VALUES (now(), 'reschedule_order_to_window (pre-318b)', v_def);

  IF (length(v_def) - length(replace(v_def, v_hdr_old, ''))) / length(v_hdr_old) <> 1 THEN
    RAISE EXCEPTION 'header anchor not found exactly once';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_call_old, ''))) / length(v_call_old) <> 1 THEN
    RAISE EXCEPTION 'call anchor not found exactly once';
  END IF;
  v_new := replace(replace(v_def, v_hdr_old, v_hdr_new), v_call_old, v_call_new);

  DROP FUNCTION public.reschedule_order_to_window(uuid,text,date,text,text,boolean);
  EXECUTE v_new;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.reschedule_order_to_window(uuid,text,date,text,text,boolean,boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reschedule_order_to_window(uuid,text,date,text,text,boolean,boolean) FROM anon;
GRANT  EXECUTE ON FUNCTION public.reschedule_order_to_window(uuid,text,date,text,text,boolean,boolean) TO authenticated, service_role;

DO $chk$
DECLARE v_src text; v_secdef bool;
BEGIN
  SELECT prosrc, prosecdef INTO v_src, v_secdef FROM pg_proc
   WHERE oid = 'public.reschedule_order_to_window(uuid,text,date,text,text,boolean,boolean)'::regprocedure;
  IF strpos(v_src, 'p_notify => p_notify') = 0 THEN RAISE EXCEPTION 'p_notify not threaded through'; END IF;
  IF strpos(v_src, 'IF NOT is_admin() THEN') = 0 THEN RAISE EXCEPTION 'admin guard missing'; END IF;
  IF NOT v_secdef THEN RAISE EXCEPTION 'lost SECURITY DEFINER'; END IF;
END
$chk$;

NOTIFY pgrst, 'reload schema';
