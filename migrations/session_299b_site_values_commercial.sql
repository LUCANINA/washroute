-- Session 299b: site_public_values() also returns the Commercial price list
-- (website /services-4 shows "Commercial pricing starts at {commercial:Wash & Fold}").
-- Applied as an in-place rewrite of the function definition (same signature, same grants).
DO $m$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.site_public_values()'::regprocedure);
  IF strpos(v_def, $o$    'fee', COALESCE($o$) = 0 THEN RAISE EXCEPTION 'anchor not found'; END IF;
  v_def := replace(v_def, $o$    'fee', COALESCE($o$,
    $n$    'commercial', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Commercial'), '{}'::jsonb),
    'fee', COALESCE($n$);
  EXECUTE v_def;
END $m$;
REVOKE EXECUTE ON FUNCTION public.site_public_values() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.site_public_values() TO anon, authenticated, service_role;
