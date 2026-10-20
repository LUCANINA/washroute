-- Session 354a — Route override moves from the CUSTOMER to each ADDRESS.
--
-- Bug (admins, 2026-10-20): customers.route_template_override_id forced EVERY
-- address of a customer onto the override route, wherever the address was.
-- Fix: addresses.route_template_override_id. Routing reads the override of the
-- address the stop is actually at (pickup leg = pickup address, delivery leg =
-- delivery address). No address known (old callers) = the customer's default
-- address, which is what they got before.
--
-- Zero behaviour change on apply: every address of a customer who has an
-- override today inherits it. Admins then clear it on the address(es) that
-- shouldn't have it. customers.route_template_override_id is kept (deprecated,
-- unread by routing) for rollback; drop it in a later session.

-- 0. Rollback snapshot ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_354a (
  proname name, def text, saved_at timestamptz DEFAULT now());
INSERT INTO _archive.fn_snapshot_354a (proname, def)
SELECT p.proname, pg_get_functiondef(p.oid)
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('auto_route_order','trg_auto_route_new_order',
    'sync_pickup_stop_on_window_change','sync_delivery_stop_on_window_change',
    'trg_create_recurring_order_fn','get_slot_availability','get_nearest_available_slots');

-- 1. Column ----------------------------------------------------------------------
ALTER TABLE public.addresses
  ADD COLUMN route_template_override_id uuid
  REFERENCES public.route_templates(id) ON DELETE SET NULL;
CREATE INDEX idx_addresses_route_override
  ON public.addresses(route_template_override_id)
  WHERE route_template_override_id IS NOT NULL;
COMMENT ON COLUMN public.addresses.route_template_override_id IS
  'Session 354a: force stops AT THIS ADDRESS onto this route template instead of the zone''s routes. NULL = zone-based. Staff-only (trg_enforce_protected_address_columns).';
COMMENT ON COLUMN public.customers.route_template_override_id IS
  'DEPRECATED 354a — routing reads addresses.route_template_override_id. Kept for rollback only; do not read or write.';

-- 2. Backfill: identical routing on apply ------------------------------------------
UPDATE public.addresses a
SET route_template_override_id = c.route_template_override_id
FROM public.customers c
WHERE c.id = a.customer_id
  AND c.route_template_override_id IS NOT NULL;

-- 3. Helper: the override for a stop ---------------------------------------------
CREATE OR REPLACE FUNCTION public.route_override_for(p_customer_id uuid, p_address_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
  SELECT CASE
    WHEN p_address_id IS NOT NULL THEN
      (SELECT a.route_template_override_id FROM public.addresses a WHERE a.id = p_address_id)
    WHEN p_customer_id IS NOT NULL THEN
      (SELECT a.route_template_override_id FROM public.addresses a
        WHERE a.customer_id = p_customer_id
        ORDER BY a.is_default DESC NULLS LAST, a.created_at DESC
        LIMIT 1)
  END
$f$;
REVOKE EXECUTE ON FUNCTION public.route_override_for(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.route_override_for(uuid, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.route_override_for(uuid, uuid) TO authenticated, service_role;

-- 4. Rewrite the 7 readers from their live definitions -----------------------------
DO $do$
DECLARE
  r record; v_def text; v_n int;
  v_fns text[] := ARRAY['auto_route_order','trg_auto_route_new_order',
    'sync_pickup_stop_on_window_change','sync_delivery_stop_on_window_change',
    'trg_create_recurring_order_fn','get_slot_availability','get_nearest_available_slots'];
  -- each row: function, regex to find (must match exactly once), replacement
  v_rules text[][] := ARRAY[
    ['auto_route_order',
     $p$SELECT route_template_override_id INTO v_override_tmpl_id\s+FROM customers WHERE id = v_order\.customer_id;$p$,
     $p$v_override_tmpl_id := public.route_override_for(v_order.customer_id, v_order.pickup_address_id);  -- 354a$p$],
    ['auto_route_order',
     $p$IF NOT v_delivery_done THEN\n\s+IF v_order\.delivery_window_start IS NOT NULL THEN$p$,
     $p$IF NOT v_delivery_done THEN
      -- 354a: the delivery leg follows the DELIVERY address's override
      v_override_tmpl_id := public.route_override_for(v_order.customer_id, COALESCE(v_order.delivery_address_id, v_order.pickup_address_id));
      IF v_order.delivery_window_start IS NOT NULL THEN$p$],
    ['trg_auto_route_new_order',
     $p$SELECT route_template_override_id INTO v_override_tmpl_id\s+FROM customers WHERE id = NEW\.customer_id;$p$,
     $p$v_override_tmpl_id := public.route_override_for(NEW.customer_id, NEW.pickup_address_id);  -- 354a$p$],
    ['sync_pickup_stop_on_window_change',
     $p$SELECT route_template_override_id INTO v_override_tmpl_id\s+FROM customers WHERE id = NEW\.customer_id;$p$,
     $p$v_override_tmpl_id := public.route_override_for(NEW.customer_id, NEW.pickup_address_id);  -- 354a$p$],
    ['sync_delivery_stop_on_window_change',
     $p$SELECT route_template_override_id INTO v_override_tmpl_id\s+FROM customers WHERE id = NEW\.customer_id;$p$,
     $p$v_override_tmpl_id := public.route_override_for(NEW.customer_id, COALESCE(NEW.delivery_address_id, NEW.pickup_address_id));  -- 354a$p$],
    ['trg_create_recurring_order_fn',
     $p$SELECT c\.route_template_override_id INTO v_override_tmpl_id\s+FROM customers c\s+WHERE c\.id = NEW\.customer_id;$p$,
     $p$v_override_tmpl_id := public.route_override_for(NEW.customer_id, NEW.pickup_address_id);  -- 354a$p$],
    ['get_slot_availability',
     $p$p_customer_id uuid DEFAULT NULL::uuid\)$p$,
     $p$p_customer_id uuid DEFAULT NULL::uuid, p_address_id uuid DEFAULT NULL::uuid)$p$],
    ['get_slot_availability',
     $p$SELECT route_template_override_id INTO v_override_id\s+FROM customers WHERE id = p_customer_id;$p$,
     $p$v_override_id := public.route_override_for(p_customer_id, p_address_id);  -- 354a$p$],
    ['get_nearest_available_slots',
     $p$p_customer_id uuid DEFAULT NULL::uuid\)$p$,
     $p$p_customer_id uuid DEFAULT NULL::uuid, p_address_id uuid DEFAULT NULL::uuid)$p$],
    ['get_nearest_available_slots',
     $p$SELECT route_template_override_id INTO v_override_id\s+FROM customers WHERE id = p_customer_id;$p$,
     $p$v_override_id := public.route_override_for(p_customer_id, p_address_id);  -- 354a$p$]
  ];
  i int;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname::text AS proname, pg_get_functiondef(p.oid) AS def,
           pg_get_function_identity_arguments(p.oid) AS idargs
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (v_fns)
  LOOP
    v_def := r.def;
    FOR i IN 1 .. array_length(v_rules, 1) LOOP
      CONTINUE WHEN v_rules[i][1] <> r.proname;
      SELECT count(*) INTO v_n FROM regexp_matches(v_def, v_rules[i][2], 'g');
      IF v_n <> 1 THEN
        RAISE EXCEPTION '354a: rule % matched % times in % (expected 1)', i, v_n, r.proname;
      END IF;
      v_def := regexp_replace(v_def, v_rules[i][2], replace(v_rules[i][3], '\', '\\'));
    END LOOP;

    IF r.proname IN ('get_slot_availability','get_nearest_available_slots') THEN
      -- signature grows a param: drop the old one so PostgREST sees ONE function
      EXECUTE format('DROP FUNCTION public.%I(%s)', r.proname, r.idargs);
    END IF;
    EXECUTE v_def;
  END LOOP;
END
$do$;

-- the two dropped+recreated RPCs: restore their previous grants exactly
REVOKE EXECUTE ON FUNCTION public.get_slot_availability(uuid, date, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_slot_availability(uuid, date, uuid, uuid) TO anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_nearest_available_slots(uuid, date, time, text, integer, integer, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_nearest_available_slots(uuid, date, time, text, integer, integer, uuid, uuid) TO anon, authenticated, service_role;

-- 5. Customers can't set or change an address's override --------------------------
CREATE OR REPLACE FUNCTION public.enforce_protected_address_columns()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE v_claims text;
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN RETURN NEW; END IF;
  IF COALESCE(auth.role(), '') = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(current_setting('washroute.trusted_write', true), '') = 'on' THEN RETURN NEW; END IF;
  IF public.is_staff() THEN RETURN NEW; END IF;
  IF public.pos_session_active() THEN RETURN NEW; END IF;
  -- Non-staff: silently keep the staff-set value (never break a customer's
  -- own address save over a field they can't see).
  IF TG_OP = 'INSERT' THEN
    NEW.route_template_override_id := NULL;
  ELSE
    NEW.route_template_override_id := OLD.route_template_override_id;
  END IF;
  RETURN NEW;
END
$f$;
REVOKE EXECUTE ON FUNCTION public.enforce_protected_address_columns() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_protected_address_columns() FROM anon;
GRANT  EXECUTE ON FUNCTION public.enforce_protected_address_columns() TO service_role;
CREATE TRIGGER trg_enforce_protected_address_columns
  BEFORE INSERT OR UPDATE ON public.addresses
  FOR EACH ROW EXECUTE FUNCTION public.enforce_protected_address_columns();

-- 6. Assert ------------------------------------------------------------------------
DO $chk$
DECLARE r record; v_bad int; v_want int; v_got int;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosrc FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('auto_route_order','trg_auto_route_new_order',
        'sync_pickup_stop_on_window_change','sync_delivery_stop_on_window_change',
        'trg_create_recurring_order_fn','get_slot_availability','get_nearest_available_slots')
  LOOP
    IF strpos(r.prosrc, 'route_override_for(') = 0 THEN
      RAISE EXCEPTION '354a assert: % not rewritten', r.proname; END IF;
    IF strpos(r.prosrc, 'route_template_override_id') > 0 THEN
      RAISE EXCEPTION '354a assert: % still reads customers.route_template_override_id', r.proname; END IF;
  END LOOP;
  SELECT count(*) INTO v_bad FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN ('get_slot_availability','get_nearest_available_slots');
  IF v_bad <> 2 THEN RAISE EXCEPTION '354a assert: expected exactly 2 slot RPCs, found %', v_bad; END IF;
  IF strpos((SELECT prosrc FROM pg_proc WHERE proname='auto_route_order'),
            'COALESCE(v_order.delivery_address_id, v_order.pickup_address_id)') = 0 THEN
    RAISE EXCEPTION '354a assert: delivery-leg override missing'; END IF;
  SELECT count(*) INTO v_want FROM addresses a JOIN customers c ON c.id = a.customer_id
   WHERE c.route_template_override_id IS NOT NULL;
  SELECT count(*) INTO v_got FROM addresses WHERE route_template_override_id IS NOT NULL;
  IF v_want <> v_got THEN RAISE EXCEPTION '354a assert: backfill % of %', v_got, v_want; END IF;
END
$chk$;

NOTIFY pgrst, 'reload schema';
