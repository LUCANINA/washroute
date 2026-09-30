-- Session 324 (2026-09-30). Mirror a Twilio-level STOP back into our own record.
--
-- APPLIED BY HAND in the Supabase SQL editor on 2026-09-30, not via apply_migration
-- (the session running it had no production-deploy permission). Steps 1 and 4 below
-- were NOT run: _archive_rpc_defs has no 'session_324_before_sms_optout_mirror' row,
-- so there is no stored copy of the previous body. Steps 2 and 3 are live and verified.
--
-- Problem: send-sms hands a message to Twilio and records whatever Twilio says at that
-- moment ('queued'). Twilio later POSTs the terminal status to twilio-status-callback
-- -> record_sms_delivery_status, which updated sms_messages and nothing else. So error
-- 21610 ("recipient unsubscribed", i.e. they texted STOP to Twilio) never reached
-- customers.sms_marketing_opt_out_at, and we kept sending marketing to people whose
-- carrier blocks it, recording those attempts as 'sent'. Found while auditing the
-- WB-2026-10-A win-back batch: 11 customers had hit 21610, 7 had no opt-out recorded.
--
-- Deliberately NOT touching sms_notifications_opt_out_at: a STOP does block transactional
-- texts at Twilio too, but recording it here would permanently suppress pickup
-- confirmations even after the customer texts START, which is the worse failure.

-- 1. Rollback snapshot. (NOT RUN on 2026-09-30 — see header.)
INSERT INTO public._archive_rpc_defs (label, proname, definition)
SELECT 'session_324_before_sms_optout_mirror', p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'record_sms_delivery_status';

-- 2. The function. Signature and defaults byte-for-byte as before.
CREATE OR REPLACE FUNCTION public.record_sms_delivery_status(
  p_sid text,
  p_status text,
  p_error_code text DEFAULT NULL::text,
  p_error_message text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows int;
  v_opted int := 0;
BEGIN
  PERFORM public.assert_staff('record_sms_delivery_status');
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
     -- Don't let a late, out-of-order non-terminal callback (e.g. 'sent' arriving
     -- after 'delivered') clobber a terminal status.
     AND (
       status IS NULL
       OR status NOT IN ('delivered', 'failed', 'undelivered')
       OR p_status IN ('delivered', 'failed', 'undelivered')
     );

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- 21610 = the recipient texted STOP to Twilio. Twilio is the source of truth for
  -- that; record it so our own sends stop attempting it.
  IF p_error_code = '21610' THEN
    UPDATE public.customers c
       SET sms_marketing_opt_out_at = now()
      FROM public.sms_messages m
     WHERE m.twilio_sid = p_sid
       AND c.id = m.customer_id
       AND c.sms_marketing_opt_out_at IS NULL;
    GET DIAGNOSTICS v_opted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('updated', v_rows, 'opted_out', v_opted);
END;
$function$;

-- 3. Grants: anon must never execute this.
REVOKE EXECUTE ON FUNCTION public.record_sms_delivery_status(text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_sms_delivery_status(text,text,text,text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.record_sms_delivery_status(text,text,text,text) TO authenticated, service_role;

-- 4. Assert the change landed. (NOT RUN on 2026-09-30 — verified by SELECT instead.)
DO $assert$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_sms_delivery_status';

  IF strpos(v_src, '21610') = 0 THEN
    RAISE EXCEPTION 'record_sms_delivery_status: 21610 branch missing after replace';
  END IF;
  IF strpos(v_src, 'sms_marketing_opt_out_at') = 0 THEN
    RAISE EXCEPTION 'record_sms_delivery_status: opt-out write missing after replace';
  END IF;
  IF strpos(v_src, 'sms_notifications_opt_out_at') > 0 THEN
    RAISE EXCEPTION 'record_sms_delivery_status: must not touch notifications opt-out';
  END IF;
END
$assert$;
