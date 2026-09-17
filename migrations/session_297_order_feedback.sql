-- Session 297 (2026-09-16): per-order customer ratings (1–5 + comment).
--
-- * order_feedback: one row per order, customers read their own, staff read all.
--   Writes only through submit_order_feedback (SECURITY DEFINER).
-- * A rating of 1–3 opens (or updates) a cs_issue on the order so staff follow up.
-- * The public review link is returned to EVERY rater regardless of score —
--   Google prohibits selectively soliciting positive reviews ("review gating").
-- * Nothing here sends a message.
--
-- Rollback: DROP FUNCTION public.submit_order_feedback(uuid,int,text,text);
--           DROP FUNCTION public.mark_review_link_clicked(uuid);
--           DROP TABLE public.order_feedback;

CREATE TABLE public.order_feedback (
  id                     bigserial PRIMARY KEY,
  order_id               uuid        NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_id            uuid        NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  rating                 smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment                text,
  source                 text        NOT NULL DEFAULT 'app' CHECK (source IN ('app','sms','admin')),
  issue_id               integer     REFERENCES public.cs_issues(id) ON DELETE SET NULL,
  review_link_clicked_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_feedback_customer_id_idx ON public.order_feedback (customer_id);
CREATE INDEX order_feedback_created_at_idx  ON public.order_feedback (created_at DESC);
CREATE INDEX order_feedback_rating_idx      ON public.order_feedback (rating);

ALTER TABLE public.order_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_feedback FROM anon, authenticated;
GRANT SELECT ON public.order_feedback TO authenticated;
GRANT ALL ON public.order_feedback TO service_role;

CREATE POLICY order_feedback_staff_read ON public.order_feedback
  FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY order_feedback_own_read ON public.order_feedback
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.customers c WHERE c.id = order_feedback.customer_id AND c.profile_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.submit_order_feedback(
  p_order_id uuid, p_rating int, p_comment text DEFAULT NULL, p_source text DEFAULT 'app'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid     uuid := auth.uid();
  v_order   RECORD;
  v_fb      RECORD;
  v_comment text := NULLIF(left(TRIM(COALESCE(p_comment, '')), 2000), '');
  v_issue   integer;
  v_link    text;
  v_title   text;
BEGIN
  IF v_uid IS NULL THEN
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
  IF v_order.profile_id IS DISTINCT FROM v_uid AND NOT public.is_staff() THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Not authorized.');
  END IF;
  IF v_order.status <> 'delivered' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'You can rate an order once it has been delivered.');
  END IF;

  SELECT * INTO v_fb FROM public.order_feedback WHERE order_id = p_order_id;
  IF v_fb.id IS NOT NULL AND v_fb.created_at < now() - interval '14 days' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'Ratings can be changed for 14 days.');
  END IF;

  INSERT INTO public.order_feedback (order_id, customer_id, rating, comment, source)
  VALUES (p_order_id, v_order.customer_id, p_rating, v_comment,
          CASE WHEN p_source IN ('app','sms','admin') THEN p_source ELSE 'app' END)
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

CREATE OR REPLACE FUNCTION public.mark_review_link_clicked(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.order_feedback f
     SET review_link_clicked_at = COALESCE(f.review_link_clicked_at, now())
    FROM public.customers c
   WHERE f.order_id = p_order_id
     AND c.id = f.customer_id
     AND (c.profile_id = auth.uid() OR public.is_staff());
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.submit_order_feedback(uuid,int,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_order_feedback(uuid,int,text,text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_order_feedback(uuid,int,text,text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.mark_review_link_clicked(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mark_review_link_clicked(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.mark_review_link_clicked(uuid) TO authenticated, service_role;
