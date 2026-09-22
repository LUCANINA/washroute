-- Session 314 — Referral funnel: record invites sent and invite links opened.
-- Until now "Send Invite" only opened the customer's own Messages app and nothing
-- was written, so the report could only see friends who had already signed up.
-- Analytics only: no money, no messages, no change to existing tables.

CREATE TABLE public.referral_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  code                 text NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN ('invite_sent', 'link_opened')),
  surface              text CHECK (surface IN ('account', 'home', 'post_delivery')),
  method               text CHECK (method IN ('share_sheet', 'sms_app')),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_events_created_idx  ON public.referral_events (created_at);
CREATE INDEX referral_events_referrer_idx ON public.referral_events (referrer_customer_id, created_at);
CREATE INDEX referral_events_code_idx     ON public.referral_events (code, event_type, created_at);

ALTER TABLE public.referral_events ENABLE ROW LEVEL SECURITY;
-- Staff read (the report). No insert/update/delete policies: writes go through the RPCs below.
CREATE POLICY referral_events_staff_read ON public.referral_events
  FOR SELECT TO authenticated USING (public.is_staff());
REVOKE ALL ON public.referral_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.referral_events FROM authenticated;
GRANT SELECT ON public.referral_events TO authenticated;
GRANT ALL    ON public.referral_events TO service_role;

-- A signed-in customer tapped Send Invite / Text a friend / Invite and picked an app.
CREATE OR REPLACE FUNCTION public.log_referral_invite(p_customer_id uuid, p_surface text, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'You must be signed in.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customers
                  WHERE id = p_customer_id AND (profile_id = auth.uid() OR public.is_staff())) THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Not authorized.');
  END IF;

  SELECT code INTO v_code FROM public.referral_codes WHERE customer_id = p_customer_id;
  IF v_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'No referral code.');
  END IF;

  -- Keep the log honest: 30 a day per customer is far past any real use.
  IF (SELECT count(*) FROM public.referral_events
       WHERE referrer_customer_id = p_customer_id AND event_type = 'invite_sent'
         AND created_at > now() - interval '1 day') >= 30 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'daily_cap');
  END IF;

  INSERT INTO public.referral_events (referrer_customer_id, code, event_type, surface, method)
  VALUES (p_customer_id, v_code, 'invite_sent',
          CASE WHEN p_surface IN ('account','home','post_delivery') THEN p_surface END,
          CASE WHEN p_method  IN ('share_sheet','sms_app')          THEN p_method  END);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- A friend opened https://app.familylaundry.com/r/CODE. The friend is usually NOT
-- signed in, so this one is callable by anon (same exposure as referral_code_preview).
CREATE OR REPLACE FUNCTION public.log_referral_link_open(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_code text := upper(trim(COALESCE(p_code, '')));
  v_cust uuid;
BEGIN
  IF COALESCE((public.referral_config()->>'enabled')::boolean, false) = false THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'disabled');
  END IF;
  SELECT customer_id INTO v_cust FROM public.referral_codes WHERE code = v_code AND active;
  IF v_cust IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'unknown_code');
  END IF;
  -- Cap per code per day so an anonymous caller cannot flood the table.
  IF (SELECT count(*) FROM public.referral_events
       WHERE code = v_code AND event_type = 'link_opened'
         AND created_at > now() - interval '1 day') >= 50 THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'daily_cap');
  END IF;
  INSERT INTO public.referral_events (referrer_customer_id, code, event_type)
  VALUES (v_cust, v_code, 'link_opened');
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_referral_invite(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_referral_invite(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.log_referral_invite(uuid, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.log_referral_link_open(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.log_referral_link_open(text) TO anon, authenticated, service_role;

-- Rollback:
--   DROP FUNCTION public.log_referral_link_open(text);
--   DROP FUNCTION public.log_referral_invite(uuid, text, text);
--   DROP TABLE public.referral_events;
