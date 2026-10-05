-- Session 332b (Oct 5, 2026): the website marks up our OWN customer ratings (order_feedback), like Rinse does.
-- Adds one key, `ratings` = {avg (1 decimal), count}, to site_public_values(). Additive only; every existing key
-- is unchanged. Public by design: an average and a count only, no comments, names or order data.
-- Rollback: _archive.fn_site_public_values_20261005b holds the previous definition.

CREATE TABLE IF NOT EXISTS _archive.fn_site_public_values_20261005b AS
  SELECT now() AS saved_at, pg_get_functiondef('public.site_public_values'::regproc) AS def;
ALTER TABLE _archive.fn_site_public_values_20261005b ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.site_public_values()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'price', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Delivery' AND s.show_in_app), '{}'::jsonb),
    'retail', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Retail'), '{}'::jsonb),
    'commercial', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Commercial'), '{}'::jsonb),
    'fee', COALESCE((SELECT jsonb_object_agg(DISTINCT_f.name, DISTINCT_f.amount)
                       FROM (SELECT DISTINCT ON (f.name) f.name, f.amount
                               FROM public.service_fees f
                              WHERE f.show_in_app AND (f.pricelist IS NULL OR f.pricelist = 'Delivery')
                              ORDER BY f.name, (f.pricelist IS NULL)) DISTINCT_f), '{}'::jsonb),
    'plan', COALESCE((SELECT jsonb_build_object('name', p.name, 'price', p.price_monthly, 'lbs', p.weight_limit_lbs,
                                                'overage', p.overage_price_per_lb)
                        FROM public.subscription_plans p WHERE p.is_active ORDER BY p.price_monthly LIMIT 1), '{}'::jsonb),
    'referral', (SELECT jsonb_build_object('enabled', COALESCE((c->>'enabled')::boolean, false),
                                           'friend', c->'friend_credit', 'referrer', c->'referrer_credit')
                   FROM (SELECT public.referral_config() AS c) x),
    'site', COALESCE((SELECT jsonb_object_agg(i.key, i.value) FROM public.site_info i), '{}'::jsonb),
    'cities', COALESCE((SELECT jsonb_agg(DISTINCT initcap(c) ORDER BY initcap(c))
                          FROM public.service_zones z
                          CROSS JOIN LATERAL unnest(CASE WHEN cardinality(z.cities) > 0 THEN z.cities ELSE ARRAY[z.name] END) c
                         WHERE z.polygon IS NOT NULL AND z.name <> 'Commercial'), '[]'::jsonb),
    'zones', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                          'name', z.name,
                          'cities', (SELECT jsonb_agg(initcap(c) ORDER BY initcap(c))
                                       FROM unnest(CASE WHEN cardinality(z.cities) > 0 THEN z.cities ELSE ARRAY[z.name] END) c),
                          'windows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                                   'start', to_char(t.window_start, 'HH24:MI'),
                                                   'end',   to_char(t.window_end,   'HH24:MI'),
                                                   'days',  to_jsonb(t.schedule_days))
                                                 ORDER BY t.window_start)
                                                FROM public.route_templates t
                                               WHERE t.zone_id = z.id AND t.is_active
                                                 AND t.service_type = 'pickup_delivery'), '[]'::jsonb))
                        ORDER BY z.name)
                         FROM public.service_zones z
                        WHERE z.polygon IS NOT NULL AND z.name <> 'Commercial'), '[]'::jsonb),
    'ratings', (SELECT jsonb_build_object('avg', round(avg(f.rating)::numeric, 1), 'count', count(*))
                  FROM public.order_feedback f WHERE f.rating BETWEEN 1 AND 5)
  );
$function$;

GRANT EXECUTE ON FUNCTION public.site_public_values() TO anon, authenticated, service_role;
