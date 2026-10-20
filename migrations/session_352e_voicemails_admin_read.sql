-- Session 352e (2026-10-20) — APPLIED. Admin staff (admin/manager/laundry_tech) may sign voicemail
-- links, ahead of making the bucket private. Same rule sms-media already uses.
CREATE POLICY voicemails_admin_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'voicemails' AND (SELECT public.is_admin()));
