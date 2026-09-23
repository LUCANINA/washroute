-- Session 318: conversation log for the admin "Ask Claude" assistant (Phase 1, read-only).
-- Written ONLY by the admin-assistant edge function (service role). Admins/managers can read it.
CREATE TABLE public.assistant_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  conversation_id  uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  user_name        text,
  user_role        text,
  question         text        NOT NULL,
  answer           text,
  tools_used       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  error            text
);
CREATE INDEX assistant_log_created_at_idx   ON public.assistant_log (created_at DESC);
CREATE INDEX assistant_log_conversation_idx ON public.assistant_log (conversation_id);
CREATE INDEX assistant_log_user_idx         ON public.assistant_log (user_id, created_at DESC);

ALTER TABLE public.assistant_log ENABLE ROW LEVEL SECURITY;

-- Admin-only table: no anon access at all.
REVOKE ALL ON public.assistant_log FROM anon;
REVOKE ALL ON public.assistant_log FROM authenticated;
GRANT SELECT ON public.assistant_log TO authenticated;
GRANT ALL    ON public.assistant_log TO service_role;

CREATE POLICY assistant_log_admin_read ON public.assistant_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p
                 WHERE p.id = auth.uid() AND p.role IN ('admin','manager')));
-- No INSERT/UPDATE/DELETE policies: only the service role (edge function) writes.
