-- Session 291b — Closing a CS issue requires stating what CHANGED
--
-- SEPARATE FROM 291a ON PURPOSE. This constraint rejects any UPDATE that sets
-- status='resolved' without a resolution_action. Two existing client paths do
-- exactly that today:
--   admin-dashboard/index.html  changeIssueStatus()   (~line 35855)
--   admin-dashboard/index.html  resolveLostFound()    (~line 34991)
-- Apply this migration ONLY in the same release as the dashboard change that
-- sends resolution_action. Applying it early breaks the Resolve button with an
-- opaque PostgREST constraint error.

BEGIN;

-- Legacy rows are marked so the constraint can be added VALIDATED.
UPDATE public.cs_issues
   SET resolution_action = '(legacy — closed before resolution notes were required)'
 WHERE status = 'resolved' AND resolution_action IS NULL;

-- Lost & Found already captures a real answer in resolved_returned_to; carry it
-- across rather than stamping those rows 'legacy'.
UPDATE public.cs_issues
   SET resolution_action = 'Returned to customer: ' || resolved_returned_to
 WHERE status = 'resolved'
   AND resolved_returned_to IS NOT NULL
   AND length(btrim(resolved_returned_to)) > 0
   AND resolution_action = '(legacy — closed before resolution notes were required)';

ALTER TABLE public.cs_issues
  ADD CONSTRAINT cs_issues_close_requires_action CHECK (
    status <> 'resolved'
    OR (resolution_action IS NOT NULL AND length(btrim(resolution_action)) >= 10)
  );

COMMIT;

-- Rollback:
--   ALTER TABLE public.cs_issues DROP CONSTRAINT cs_issues_close_requires_action;
