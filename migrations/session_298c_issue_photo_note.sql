-- Session 298c: issue note says photos are shown in the issue panel (admin now renders them there).
-- Body otherwise identical to 298b.

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
                     THEN format(E'\n\n(%s photo%s attached — shown below)',
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
