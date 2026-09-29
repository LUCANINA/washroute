-- Session 322b (2026-09-29): duplicate discount names.
-- 3VFHQ and 76EG3 were re-typed by hand on 2026-05-26 (the originals were redeemed for one
-- customer 20 min later); WY3QW was entered as 100% by mistake, archived, re-entered as $100.
-- redeem_discount_code looked codes up with "WHERE UPPER(name)=code LIMIT 1" and no ORDER BY,
-- so with duplicates it could pick an archived copy and say "no longer valid".
-- 1) Archive the two unused 2026-05-26 copies.
-- 2) Lookup prefers the active copy, then the newest.
-- 3) At most ONE active code per name (case-insensitive) — backstop for the admin form check.
-- Rollback: _archive._fn_redeem_discount_code_20260929 holds the prior definition;
--   DROP INDEX public.discounts_one_active_name; restore the two rows' active/deleted_at by id.

CREATE TABLE IF NOT EXISTS _archive._fn_redeem_discount_code_20260929 AS
  SELECT p.proname, pg_get_functiondef(p.oid) AS def, now() AS saved_at
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='redeem_discount_code';

UPDATE public.discounts
   SET active = false, deleted_at = now()
 WHERE id IN ('45d1c869-5ffb-4438-ab9c-5a59258a0ed2','480ad689-242c-4223-a9d6-3c441f052aab')
   AND type = 'fixed'
   AND NOT EXISTS (SELECT 1 FROM public.discount_redemptions r WHERE r.discount_id = discounts.id);

DO $m$
DECLARE
  v_oid oid; v_def text;
  a text := $a$INTO v_discount FROM public.discounts WHERE UPPER(name) = v_normalized_code LIMIT 1;$a$;
  b text := $b$INTO v_discount FROM public.discounts WHERE UPPER(name) = v_normalized_code
    ORDER BY (active IS TRUE AND deleted_at IS NULL) DESC, created_at DESC LIMIT 1;$b$;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='redeem_discount_code';
  v_def := pg_get_functiondef(v_oid);
  IF strpos(v_def, a) = 0 THEN RAISE EXCEPTION 'lookup line not found in redeem_discount_code'; END IF;
  EXECUTE replace(v_def, a, b);
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = v_oid), 'ORDER BY (active IS TRUE AND deleted_at IS NULL) DESC, created_at DESC LIMIT 1;') = 0 THEN
    RAISE EXCEPTION 'redeem_discount_code rewrite did not take';
  END IF;
END $m$;

CREATE UNIQUE INDEX IF NOT EXISTS discounts_one_active_name
  ON public.discounts (UPPER(name)) WHERE active IS TRUE AND deleted_at IS NULL;
