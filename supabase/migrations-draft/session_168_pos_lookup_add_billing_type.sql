-- Session 168 (APPLIED) — POS customer lookup also returns billing_type so the
-- POS can recognize on-account customers (City of Oakland etc.) and offer
-- "Charge to Account". Return-type change requires DROP + CREATE. Sole consumer
-- is the POS (pos/index.html lookupCustomerByPhone). Re-grant EXECUTE after
-- recreate. Reversible: recreate without the billing_type column.

DROP FUNCTION IF EXISTS public.pos_lookup_customer_by_phone(text);

CREATE FUNCTION public.pos_lookup_customer_by_phone(p_digits text)
 RETURNS TABLE(id uuid, first_name_cache text, last_name_cache text, phone_cache text, email_cache text, address_cache text, total_orders integer, pricelist text, billing_type text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT c.id, c.first_name_cache, c.last_name_cache, c.phone_cache,
         c.email_cache, c.address_cache, c.total_orders, c.pricelist, c.billing_type
  FROM customers c
  WHERE LENGTH(REGEXP_REPLACE(COALESCE(p_digits, ''), '[^0-9]', '', 'g')) >= 10
    AND RIGHT(REGEXP_REPLACE(c.phone_cache, '[^0-9]', '', 'g'), 10)
        = RIGHT(REGEXP_REPLACE(p_digits, '[^0-9]', '', 'g'), 10)
  ORDER BY c.created_at ASC
  LIMIT 20;
$function$;

GRANT EXECUTE ON FUNCTION public.pos_lookup_customer_by_phone(text) TO anon, authenticated, service_role;
