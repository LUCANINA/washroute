-- Applied 2026-09-21 via MCP (migration name: discounts_admin_only_employee).
-- Staff-only discounts (e.g. EMPLOYEE 50%): assignable by admin, never self-redeemable as a promo code.
-- Before this, ANY discount name typed into the customer app's promo box was applied by
-- redeem_discount_code — so "EMPLOYEE" would have given any customer 50% off permanently.
-- Rollback: _archive._fn_redeem_discount_code_20260921.def holds the original function.
ALTER TABLE public.discounts ADD COLUMN IF NOT EXISTS admin_only boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.discounts.admin_only IS 'Staff-assigned only. redeem_discount_code refuses it when a customer types it as a code.';

CREATE TABLE IF NOT EXISTS _archive._fn_redeem_discount_code_20260921 AS
  SELECT now() AS saved_at, pg_get_functiondef(p.oid) AS def
  FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='redeem_discount_code';

DO $mig$
DECLARE
  v_oid oid; v_def text;
  a1 text := $a$SELECT id, name, type, value, active, deleted_at
    INTO v_discount FROM public.discounts$a$;
  b1 text := $b$SELECT id, name, type, value, active, deleted_at, admin_only
    INTO v_discount FROM public.discounts$b$;
  a2 text := $a$  IF v_discount.type NOT IN ('fixed','percent') THEN$a$;
  b2 text := $b$  -- Staff-only discounts can't be typed in by customers: look like an unknown code.
  IF v_discount.admin_only IS TRUE AND v_actor = 'self' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'That code doesn''t exist.');
  END IF;

  IF v_discount.type NOT IN ('fixed','percent') THEN$b$;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='redeem_discount_code';
  v_def := pg_get_functiondef(v_oid);
  IF (length(v_def) - length(replace(v_def, a1, ''))) / length(a1) <> 1 THEN RAISE EXCEPTION 'anchor a1 not unique'; END IF;
  IF (length(v_def) - length(replace(v_def, a2, ''))) / length(a2) <> 1 THEN RAISE EXCEPTION 'anchor a2 not unique'; END IF;
  v_def := replace(replace(v_def, a1, b1), a2, b2);
  EXECUTE v_def;
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid=v_oid), 'v_discount.admin_only IS TRUE AND v_actor = ''self''') = 0 THEN
    RAISE EXCEPTION 'guard not installed';
  END IF;
END
$mig$;

-- EMPLOYEE 50% created the same day (INSERT via SQL), then flagged staff-only here.
UPDATE public.discounts SET admin_only = true, active = true
 WHERE id = 'ac0889cb-54a0-4121-802a-4f72d9997ded' AND name = 'EMPLOYEE';
