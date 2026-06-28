-- RPC the twilio-status-callback edge function calls to record a message's
-- final delivery outcome. Keeps column writes server-side (immune to the
-- PostgREST schema-cache trap) and centralizes the update logic.
CREATE OR REPLACE FUNCTION public.record_sms_delivery_status(
  p_sid           TEXT,
  p_status        TEXT,
  p_error_code    TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_sid IS NULL OR p_status IS NULL THEN
    RETURN jsonb_build_object('updated', 0, 'reason', 'missing_sid_or_status');
  END IF;

  UPDATE public.sms_messages
     SET status            = p_status,
         error_code        = COALESCE(p_error_code, error_code),
         error_message     = COALESCE(p_error_message, error_message),
         delivered_at      = CASE WHEN p_status = 'delivered' THEN now() ELSE delivered_at END,
         status_updated_at = now()
   WHERE twilio_sid = p_sid
     -- Don't let a late, out-of-order non-terminal callback (e.g. 'sent'
     -- arriving after 'delivered') clobber a terminal status.
     AND (
       status IS NULL
       OR status NOT IN ('delivered', 'failed', 'undelivered')
       OR p_status IN ('delivered', 'failed', 'undelivered')
     );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_rows);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_sms_delivery_status(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_sms_delivery_status(TEXT,TEXT,TEXT,TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_sms_delivery_status(TEXT,TEXT,TEXT,TEXT) TO authenticated, service_role;
