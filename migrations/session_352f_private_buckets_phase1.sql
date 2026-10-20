-- Session 352f — Phase 1: voicemails + sms-media private. Apply ONLY after the admin build with the
-- wrSignStorageUrl watcher (session 352) is live and maya v29 (signed email links) is deployed.
UPDATE storage.buckets SET public = false WHERE id IN ('voicemails', 'sms-media');
-- Rollback: UPDATE storage.buckets SET public = true WHERE id IN ('voicemails', 'sms-media');
--
-- Phase 2 (~2026-11-20, David's call): UPDATE storage.buckets SET public = false WHERE id = 'stop-photos';
-- New photo texts use /functions/v1/photo links from Oct 20; texts sent before that keep raw
-- storage URLs and stop working at the flip (David accepted this when choosing the phased plan).
