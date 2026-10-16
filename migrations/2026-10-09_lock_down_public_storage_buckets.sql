-- 2026-10-09 — Lock down public storage buckets (Supabase security lints)
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.

BEGIN;

-- stop-photos: anon had FULL access (list/upload/overwrite/delete); any logged-in user too.
DROP POLICY IF EXISTS "Anon stop-photos all" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated stop-photos all" ON storage.objects;
DROP POLICY IF EXISTS stop_photos_staff_select ON storage.objects;
DROP POLICY IF EXISTS stop_photos_staff_insert ON storage.objects;
DROP POLICY IF EXISTS stop_photos_staff_update ON storage.objects;
DROP POLICY IF EXISTS stop_photos_admin_delete ON storage.objects;
-- Driver app uploads with upsert:true, which needs SELECT + INSERT + UPDATE.
CREATE POLICY stop_photos_staff_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'stop-photos' AND (SELECT public.is_staff()));
CREATE POLICY stop_photos_staff_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'stop-photos' AND (SELECT public.is_staff()));
CREATE POLICY stop_photos_staff_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'stop-photos' AND (SELECT public.is_staff()))
  WITH CHECK (bucket_id = 'stop-photos' AND (SELECT public.is_staff()));
CREATE POLICY stop_photos_admin_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'stop-photos' AND (SELECT public.is_admin()));

-- voicemails: written by the server only; public file links keep working without this policy.
DROP POLICY IF EXISTS "Public can read voicemails" ON storage.objects;

-- sms-media: anyone-can-list -> admin-only (admin upload uses upsert:true, which needs SELECT).
DROP POLICY IF EXISTS sms_media_public_read ON storage.objects;
DROP POLICY IF EXISTS sms_media_admin_select ON storage.objects;
CREATE POLICY sms_media_admin_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sms-media' AND (SELECT public.is_admin()));

COMMIT;

/* ---------- ROLLBACK (only if something breaks) ----------
BEGIN;
DROP POLICY IF EXISTS stop_photos_staff_select ON storage.objects;
DROP POLICY IF EXISTS stop_photos_staff_insert ON storage.objects;
DROP POLICY IF EXISTS stop_photos_staff_update ON storage.objects;
DROP POLICY IF EXISTS stop_photos_admin_delete ON storage.objects;
DROP POLICY IF EXISTS sms_media_admin_select ON storage.objects;
CREATE POLICY "Anon stop-photos all" ON storage.objects FOR ALL TO anon
  USING (bucket_id = 'stop-photos') WITH CHECK (bucket_id = 'stop-photos');
CREATE POLICY "Authenticated stop-photos all" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'stop-photos') WITH CHECK (bucket_id = 'stop-photos');
CREATE POLICY "Public can read voicemails" ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'voicemails');
CREATE POLICY sms_media_public_read ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'sms-media');
COMMIT;
---------------------------------------------------------- */
