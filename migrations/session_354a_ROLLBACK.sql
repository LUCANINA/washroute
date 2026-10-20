-- Rollback for session_354a_address_route_override. Run ONLY if 354a must be undone.
-- Restores the 7 functions from the snapshot taken inside 354a, then removes the
-- per-address column, guard trigger and helper. customers.route_template_override_id
-- was never changed, so customer-level routing resumes exactly as before.
DROP FUNCTION IF EXISTS public.get_slot_availability(uuid, date, uuid, uuid);
DROP FUNCTION IF EXISTS public.get_nearest_available_slots(uuid, date, time, text, integer, integer, uuid, uuid);
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT ON (proname) proname, def FROM _archive.fn_snapshot_354a ORDER BY proname, saved_at LOOP
    EXECUTE r.def;
  END LOOP; END $$;
REVOKE EXECUTE ON FUNCTION public.get_slot_availability(uuid, date, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_slot_availability(uuid, date, uuid) TO anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_nearest_available_slots(uuid, date, time, text, integer, integer, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_nearest_available_slots(uuid, date, time, text, integer, integer, uuid) TO anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_enforce_protected_address_columns ON public.addresses;
DROP FUNCTION IF EXISTS public.enforce_protected_address_columns();
DROP FUNCTION IF EXISTS public.route_override_for(uuid, uuid);
ALTER TABLE public.addresses DROP COLUMN IF EXISTS route_template_override_id;
COMMENT ON COLUMN public.customers.route_template_override_id IS NULL;
NOTIFY pgrst, 'reload schema';
