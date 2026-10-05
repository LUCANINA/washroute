-- Session 333 (2026-10-05): rate an order from a signed link, no sign-in needed.
-- Why: the rating email/text opened the customer app, which made you sign in first.
-- Customers with no app login (e.g. Ellen Konnert, 46 orders) could never rate:
-- ~225 asks to no-login customers since Sep 17 produced 0 ratings.
-- New edge function `rate-order` verifies an HMAC token in the link and calls
-- submit_order_feedback with the service role. This migration lets that caller in.
--
-- Changes:
--   1. order_feedback.source accepts 'link'.
--   2. submit_order_feedback: service_role may submit (token already verified by the
--      edge function). Behaviour for every other caller is byte-for-byte unchanged.
--
-- Rollback: re-run the previous definition (session_297_order_feedback.sql) and
--   restore the CHECK to ('app','sms','admin') after updating any 'link' rows.

ALTER TABLE public.order_feedback DROP CONSTRAINT order_feedback_source_check;
ALTER TABLE public.order_feedback ADD CONSTRAINT order_feedback_source_check
  CHECK (source = ANY (ARRAY['app'::text, 'sms'::text, 'admin'::text, 'link'::text]));

CREATE OR REPLACE FUNCTION public.submit_order_feedback(p_order_id uuid, p_rating integer, p_comment text DEFAULT NULL::text, p_source text DEFAULT 'app'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_svc     boolean := COALESCE(auth.role() = 'service_role', false);   -- session 333: rate-order edge function (signed link)
  v_order   RECORD;
  v_fb      RECORD;
  v_comment text := NULLIF(left(TRIM(COALESCE(p_comment, '')), 2000), '');
  v_issue   integer;
  v_link    text;
  v_title   text;
BEGIN
  IF v_uid IS NULL AND NOT v_svc THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please sign in to rate your order.');
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Please pick 1 to 5 stars.');
  END IF;

  SELECT o.id, o.order_number, o.status, o.customer_id, c.profile_id, c.first_name_cache, c.last_name_cache
    INTO v_order
    FROM public.orders o JOIN public.customers c ON c.id = o.customer_id
   WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Order not found.');
  END IF;
  IF v_order.profile_id IS DISTINCT FROM v_uid AND NOT public.is_staff() AND NOT v_svc THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Not authorized.');
  END IF;
  PERFORM public.enforce_caller_owns_order(p_order_id);
  IF v_order.status <> 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'You can rate an order once it has been delivered.');
  END IF;

  SELECT * INTO v_fb FROM public.order_feedback WHERE order_id = p_order_id;
  IF v_fb.id IS NOT NULL AND v_fb.created_at < now() - interval '14 days' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Ratings can be changed for 14 days.');
  END IF;

  INSERT INTO public.order_feedback (order_id, customer_id, rating, comment, source)
  VALUES (p_order_id, v_order.customer_id, p_rating, v_comment,
          CASE WHEN p_source IN ('app','sms','admin','link') THEN p_source ELSE 'app' END)
  ON CONFLICT (order_id) DO UPDATE
     SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, updated_at = now()
  RETURNING issue_id INTO v_issue;

  -- 1–3 stars: make sure staff see it.
  IF p_rating <= 3 THEN
    v_title := format('Low rating (%s★) on order #%s', p_rating, v_order.order_number);
    IF v_issue IS NOT NULL THEN
      UPDATE public.cs_issues
         SET title = v_title,
             notes = COALESCE(v_comment, notes),
             priority = CASE WHEN p_rating <= 2 THEN 'high' ELSE 'normal' END,
             status = 'open', resolved_at = NULL,
             last_reported_at = now(), report_count = report_count + 1, updated_at = now()
       WHERE id = v_issue;
    ELSE
      INSERT INTO public.cs_issues
        (customer_id, order_id, title, notes, category, theme, priority, status,
         severity, created_by, is_customer, first_reported_at, last_reported_at)
      VALUES
        (v_order.customer_id, p_order_id, v_title,
         COALESCE(v_comment, '(no comment left)'),
         'complaint', 'quality',
         CASE WHEN p_rating <= 2 THEN 'high' ELSE 'normal' END, 'open',
         CASE WHEN p_rating <= 2 THEN 3 ELSE 2 END,
         'customer-feedback', true, now(), now())
      RETURNING id INTO v_issue;
      UPDATE public.order_feedback SET issue_id = v_issue WHERE order_id = p_order_id;
    END IF;
  END IF;

  -- The same review link for every rating (no review gating).
  SELECT NULLIF(TRIM(review_link), '') INTO v_link FROM public.settings WHERE id = 1;
  IF v_link ILIKE '%yelp.%' THEN v_link := NULL; END IF;   -- Yelp asks businesses not to request reviews

  RETURN jsonb_build_object(
    'ok', true,
    'low', p_rating <= 3,
    'review_link', v_link,
    'message', CASE WHEN p_rating <= 3
                    THEN 'Thanks for telling us. We''re sorry — someone from our team will follow up today.'
                    ELSE 'Thanks for your feedback!' END
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.submit_order_feedback(uuid, integer, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_order_feedback(uuid, integer, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_order_feedback(uuid, integer, text, text) TO authenticated, service_role;

DO $chk$
DECLARE s text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc WHERE oid = 'public.submit_order_feedback(uuid,integer,text,text)'::regprocedure;
  IF strpos(s, $n$v_svc     boolean := COALESCE(auth.role() = 'service_role', false)$n$) = 0
     OR strpos(s, $n$IN ('app','sms','admin','link')$n$) = 0 THEN
    RAISE EXCEPTION 'submit_order_feedback rewrite did not land';
  END IF;
END $chk$;
