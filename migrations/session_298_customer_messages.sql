-- Session 298 (2026-09-17): customer feedback messages (in-app "Send us feedback").
--
-- * customer_messages: free-form feedback, with or without an order, optional photos
--   (private bucket feedback-photos, path "<auth uid>/<file>"). Customers read their own,
--   staff read all. Writes only through submit_customer_message (SECURITY DEFINER).
-- * Topic 'problem' or 'billing' opens a cs_issues row.
-- * Email to info@familylaundry.com: AFTER INSERT triggers queue a pg_net call to the
--   send-feedback edge function (internal secret). Same for order ratings that are 1–3★
--   or carry a comment. The email only ever goes to info@ — never to a customer.
-- * Max 5 messages per customer per 24h.
--
-- Rollback:
--   DROP TRIGGER trg_order_feedback_notify ON public.order_feedback;
--   DROP TRIGGER trg_customer_messages_notify ON public.customer_messages;
--   DROP FUNCTION public.notify_feedback_email();
--   DROP FUNCTION public.submit_customer_message(text,text,uuid,boolean,text[]);
--   DROP TABLE public.customer_messages;
--   DROP POLICY feedback_photos_own_insert ON storage.objects;
--   DROP POLICY feedback_photos_read ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'feedback-photos';  (only if empty)

CREATE TABLE public.customer_messages (
  id             bigserial   PRIMARY KEY,
  customer_id    uuid        NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  order_id       uuid        REFERENCES public.orders(id) ON DELETE SET NULL,
  topic          text        NOT NULL CHECK (topic IN ('idea','problem','delivery','billing','compliment')),
  message        text        NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  photo_paths    text[]      NOT NULL DEFAULT '{}',
  contact_ok     boolean     NOT NULL DEFAULT true,
  source         text        NOT NULL DEFAULT 'app' CHECK (source IN ('app','admin')),
  issue_id       integer     REFERENCES public.cs_issues(id) ON DELETE SET NULL,
  email_sent_at  timestamptz,
  email_error    text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_messages_customer_id_idx ON public.customer_messages (customer_id);
CREATE INDEX customer_messages_order_id_idx    ON public.customer_messages (order_id);
CREATE INDEX customer_messages_created_at_idx  ON public.customer_messages (created_at DESC);

ALTER TABLE public.customer_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_messages FROM anon, authenticated;
GRANT SELECT ON public.customer_messages TO authenticated;
GRANT ALL ON public.customer_messages TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.customer_messages_id_seq TO service_role;

CREATE POLICY customer_messages_staff_read ON public.customer_messages
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY customer_messages_own_read ON public.customer_messages
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.customers c WHERE c.id = customer_messages.customer_id AND c.profile_id = auth.uid())
  );

-- Photos: private bucket, 8 MB, images only.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('feedback-photos', 'feedback-photos', false, 8388608,
        ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY feedback_photos_own_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'feedback-photos' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY feedback_photos_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'feedback-photos'
         AND ((storage.foldername(name))[1] = auth.uid()::text OR public.is_staff()));

CREATE OR REPLACE FUNCTION public.submit_customer_message(
  p_topic text, p_message text, p_order_id uuid DEFAULT NULL,
  p_contact_ok boolean DEFAULT true, p_photo_paths text[] DEFAULT '{}'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_cust   RECORD;
  v_order_id uuid;
  v_order_no text;
  v_msg    text := left(TRIM(COALESCE(p_message, '')), 4000);
  v_paths  text[] := COALESCE(p_photo_paths, '{}');
  v_p      text;
  v_id     bigint;
  v_issue  integer;
  v_label  text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please sign in to send feedback.');
  END IF;
  IF p_topic IS NULL OR p_topic NOT IN ('idea','problem','delivery','billing','compliment') THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please pick a topic.');
  END IF;
  IF v_msg = '' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please write a message.');
  END IF;
  IF cardinality(v_paths) > 3 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'You can attach up to 3 photos.');
  END IF;
  FOREACH v_p IN ARRAY v_paths LOOP
    IF v_p !~ ('^' || v_uid::text || $re$/[A-Za-z0-9._-]{1,100}$$re$) THEN
      RETURN jsonb_build_object('ok', false, 'message', 'Photo upload failed — please try again.');
    END IF;
  END LOOP;

  SELECT c.id, c.first_name_cache, c.last_name_cache INTO v_cust
    FROM public.customers c WHERE c.profile_id = v_uid LIMIT 1;
  IF v_cust.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'We could not find your account.');
  END IF;

  IF p_order_id IS NOT NULL THEN
    SELECT o.id, o.order_number::text INTO v_order_id, v_order_no
      FROM public.orders o WHERE o.id = p_order_id AND o.customer_id = v_cust.id;
    IF v_order_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'message', 'Order not found.');
    END IF;
  END IF;

  IF (SELECT count(*) FROM public.customer_messages
       WHERE customer_id = v_cust.id AND created_at > now() - interval '24 hours') >= 5 THEN
    RETURN jsonb_build_object('ok', false,
      'message', 'You''ve sent several messages today. Please email info@familylaundry.com.');
  END IF;

  INSERT INTO public.customer_messages (customer_id, order_id, topic, message, photo_paths, contact_ok)
  VALUES (v_cust.id, v_order_id, p_topic, v_msg, v_paths, COALESCE(p_contact_ok, true))
  RETURNING id INTO v_id;

  IF p_topic IN ('problem','billing') THEN
    v_label := CASE p_topic WHEN 'billing' THEN 'Billing' ELSE 'Problem' END;
    INSERT INTO public.cs_issues
      (customer_id, order_id, title, notes, category, theme, priority, status, severity,
       created_by, is_customer, first_reported_at, last_reported_at)
    VALUES
      (v_cust.id, v_order_id,
       format('App feedback · %s%s', v_label,
              CASE WHEN v_order_id IS NOT NULL THEN ' on order #' || v_order_no ELSE '' END),
       v_msg || CASE WHEN cardinality(v_paths) > 0
                     THEN format(E'\n\n(%s photo%s — see Reports → Customers → Feedback)',
                                 cardinality(v_paths), CASE WHEN cardinality(v_paths) > 1 THEN 's' ELSE '' END)
                     ELSE '' END,
       CASE p_topic WHEN 'billing' THEN 'billing' ELSE 'complaint' END,
       CASE p_topic WHEN 'billing' THEN 'billing' ELSE 'other' END,
       'normal', 'open', 2, 'customer-feedback', true,
       now(), now())
    RETURNING id INTO v_issue;
    UPDATE public.customer_messages SET issue_id = v_issue WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'issue', v_issue IS NOT NULL);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.submit_customer_message(text,text,uuid,boolean,text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_customer_message(text,text,uuid,boolean,text[]) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_customer_message(text,text,uuid,boolean,text[]) TO authenticated, service_role;

-- Queue the info@ email. Never blocks the write it rides on.
CREATE OR REPLACE FUNCTION public.notify_feedback_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtanBidXhyZHlkd2VqcXRlbnNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NjgzMDQsImV4cCI6MjA4NzU0NDMwNH0.22WyUfBsqPaaza_HiDo1f_tQE3sGUDEJYYyV29XUSeY';
  v_body jsonb;
BEGIN
  IF TG_TABLE_NAME = 'customer_messages' THEN
    v_body := jsonb_build_object('kind', 'message', 'id', NEW.id);
  ELSE
    -- order_feedback: only low ratings or ones with a comment, and only when something changed.
    IF NOT (NEW.rating <= 3 OR NULLIF(TRIM(COALESCE(NEW.comment, '')), '') IS NOT NULL) THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.rating IS NOT DISTINCT FROM OLD.rating
       AND NEW.comment IS NOT DISTINCT FROM OLD.comment THEN
      RETURN NEW;
    END IF;
    v_body := jsonb_build_object('kind', 'rating', 'order_id', NEW.order_id,
                                 'updated', TG_OP = 'UPDATE');
  END IF;

  BEGIN
    PERFORM net.http_post(
      url     := 'https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/send-feedback',
      headers := jsonb_build_object('x-wr-internal', public.wr_internal_secret(),
                   'Content-Type', 'application/json',
                   'apikey', v_anon,
                   'Authorization', 'Bearer ' || v_anon),
      body    := v_body
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notify_feedback_email failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_feedback_email() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_feedback_email() FROM anon;
REVOKE EXECUTE ON FUNCTION public.notify_feedback_email() FROM authenticated;

CREATE TRIGGER trg_customer_messages_notify
  AFTER INSERT ON public.customer_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_feedback_email();

CREATE TRIGGER trg_order_feedback_notify
  AFTER INSERT OR UPDATE OF rating, comment ON public.order_feedback
  FOR EACH ROW EXECUTE FUNCTION public.notify_feedback_email();
