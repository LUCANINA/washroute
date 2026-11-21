-- Session 352g (2026-11-20) - APPLIED. Phase 2: stop-photos private (David confirmed).
-- Texts since Oct 20 use /functions/v1/photo links; texts sent Mar 23-Oct 20 no longer open their photo.
UPDATE storage.buckets SET public = false WHERE id = 'stop-photos';
-- Rollback: UPDATE storage.buckets SET public = true WHERE id = 'stop-photos';
