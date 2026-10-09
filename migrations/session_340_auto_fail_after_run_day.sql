-- Session 340 — auto_fail_expired_orders: never fail a stop during its route's day.
--
-- Before: every 30 min, any scheduled pickup / ready delivery still open 2h after the
-- ROUTE TEMPLATE's window_end was set to pickup_failed / delivery_failed and its stop
-- to 'failed' -- which removes it from the driver app while the driver is still out.
-- 10/9: Hayward AM (window ends 10:00) -- Denise Ryan's delivery auto-failed at 12:00;
-- the driver was working the route until 15:03.
-- After (David's call): for a stop on a route, the clock starts at MIDNIGHT after the
-- route's run_date (so it fires ~02:00 PT the next morning, + the existing 2h).
-- Orders with no open route stop keep the old rule (own window_end + 2h).
-- Only the CASE branch changes; signature, SECURITY DEFINER, search_path, grants,
-- assert_staff guard and SMS logic are untouched (rewritten from pg_get_functiondef).
-- Rollback: EXECUTE the definition saved in _archive._backup_function_defs
--           WHERE function_name = 'auto_fail_expired_orders (pre-session-340)'.
DO $mig$
DECLARE
  v_def  text;
  v_old  text := $o$CASE WHEN r.run_date IS NOT NULL AND rt.window_end IS NOT NULL
                 THEN (r.run_date + rt.window_end) AT TIME ZONE 'America/Los_Angeles'$o$;
  v_new  text := $n$CASE WHEN r.run_date IS NOT NULL
                 THEN (r.run_date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles'$n$;
  v_cnt  int;
  v_src  text;
BEGIN
  SELECT pg_get_functiondef('public.auto_fail_expired_orders()'::regprocedure) INTO v_def;
  INSERT INTO _archive._backup_function_defs(function_name, definition)
    VALUES ('auto_fail_expired_orders (pre-session-340)', v_def);
  v_cnt := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_cnt <> 2 THEN RAISE EXCEPTION 'expected 2 CASE branches (pickup + delivery), found %', v_cnt; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.auto_fail_expired_orders()'::regprocedure;
  IF strpos(v_src, v_new) = 0 OR strpos(v_src, v_old) > 0
     OR strpos(v_src, $a$PERFORM public.assert_staff('auto_fail_expired_orders')$a$) = 0 THEN
    RAISE EXCEPTION 'post-rewrite assertion failed';
  END IF;
END
$mig$;
