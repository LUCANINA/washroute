-- Session 297b: add the standard ownership guard (enforce_caller_owns_order) to the
-- two feedback functions so the authorization audit recognises them. Behaviour is
-- unchanged: both already refused non-owners; the friendly message stays first.
DO $mig$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.submit_order_feedback(uuid,int,text,text)'::regprocedure);
  v_old := $n$  IF v_order.status <> 'delivered' THEN$n$;
  v_new := $n$  PERFORM public.enforce_caller_owns_order(p_order_id);
  IF v_order.status <> 'delivered' THEN$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'submit_order_feedback anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  v_def := pg_get_functiondef('public.mark_review_link_clicked(uuid)'::regprocedure);
  v_old := $n$BEGIN
  UPDATE public.order_feedback f$n$;
  v_new := $n$BEGIN
  PERFORM public.enforce_caller_owns_order(p_order_id);
  UPDATE public.order_feedback f$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'mark_review_link_clicked anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
        AND proname IN ('submit_order_feedback','mark_review_link_clicked')
        AND prosrc ~ 'enforce_caller_owns_order') <> 2 THEN
    RAISE EXCEPTION 'assert failed: guard missing';
  END IF;
END
$mig$;
