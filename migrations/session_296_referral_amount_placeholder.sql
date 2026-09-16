-- Session 296 (2026-09-16): referral share text fills in the amount itself.
--
-- The share message had "$15" typed in while friend_credit was 20. Amounts must
-- live ONLY in referral_config (CLAUDE.md). This migration:
--   1. get_or_create_referral_code: replaces {{amount}} with friend_credit ($20 / $20.50)
--   2. set_referral_config: refuses a share_message containing a typed dollar amount
--   3. rewrites the saved message: "$15" -> "{{amount}}"
-- Both functions are rewritten from pg_get_functiondef() so signature, defaults,
-- SECURITY DEFINER, search_path and grants are untouched. Old defs are archived first.

-- 0. Snapshot (this is the rollback)
INSERT INTO _archive._backup_function_defs (saved_at, function_name, definition)
SELECT now(), 'session_296:' || p.oid::regprocedure::text, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.oid IN ('public.get_or_create_referral_code(uuid)'::regprocedure,
                'public.set_referral_config(jsonb,text)'::regprocedure);

INSERT INTO _archive._backup_function_defs (saved_at, function_name, definition)
SELECT now(), 'session_296:settings.referral_config', referral_config::text
FROM public.settings WHERE id = 1;

DO $mig$
DECLARE
  v_def    text;
  v_old    text;
  v_new    text;
BEGIN
  -- 1. {{amount}} placeholder ------------------------------------------------
  v_def := pg_get_functiondef('public.get_or_create_referral_code(uuid)'::regprocedure);
  v_old := $n$    'share_message',   replace(replace(COALESCE(v_cfg->>'share_message', ''),
                         '{{code}}', v_code),
                         '{{link}}', 'https://app.familylaundry.com/r/' || v_code),$n$;
  v_new := $n$    'share_message',   replace(replace(replace(COALESCE(v_cfg->>'share_message', ''),
                         '{{code}}', v_code),
                         '{{link}}', 'https://app.familylaundry.com/r/' || v_code),
                         '{{amount}}', '$' || CASE
                           WHEN (v_cfg->>'friend_credit')::numeric = trunc((v_cfg->>'friend_credit')::numeric)
                             THEN trunc((v_cfg->>'friend_credit')::numeric)::bigint::text
                           ELSE to_char((v_cfg->>'friend_credit')::numeric, 'FM999990.00') END),$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'get_or_create_referral_code: share_message block not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- 2. refuse typed amounts ----------------------------------------------------
  v_def := pg_get_functiondef('public.set_referral_config(jsonb,text)'::regprocedure);
  v_old := $n$  v_new := v_new || jsonb_build_object(
    'updated_at',$n$;
  v_new := $n$  IF COALESCE(v_new->>'share_message', '') ~ '\$\s*[0-9]' THEN
    RETURN jsonb_build_object('ok', false, 'message',
      'Don''t type a dollar amount in the message. Use {{amount}} and it will always match "Friend gets".');
  END IF;

  v_new := v_new || jsonb_build_object(
    'updated_at',$n$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'set_referral_config: anchor not found exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- 3. fix the saved message ---------------------------------------------------
  UPDATE public.settings
     SET referral_config = jsonb_set(referral_config, '{share_message}',
           to_jsonb(regexp_replace(referral_config->>'share_message', '\$\s*[0-9]+(\.[0-9]{2})?', '{{amount}}', 'g'))),
         updated_at = now()
   WHERE id = 1;

  -- asserts (strpos, not LIKE) ------------------------------------------------
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.get_or_create_referral_code(uuid)'::regprocedure), $n$'{{amount}}'$n$) = 0 THEN
    RAISE EXCEPTION 'assert failed: {{amount}} not in get_or_create_referral_code';
  END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.set_referral_config(jsonb,text)'::regprocedure), $n$~ '\$\s*[0-9]'$n$) = 0 THEN
    RAISE EXCEPTION 'assert failed: amount guard not in set_referral_config';
  END IF;
  IF (SELECT referral_config->>'share_message' FROM public.settings WHERE id = 1) ~ '\$\s*[0-9]' THEN
    RAISE EXCEPTION 'assert failed: saved message still has a typed amount';
  END IF;
END
$mig$;
