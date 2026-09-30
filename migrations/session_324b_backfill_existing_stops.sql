-- Session 324b (2026-09-30). One-time backfill of Twilio STOPs that predate the
-- session_324 fix. APPLIED BY HAND in the SQL editor on 2026-09-30.
-- Scoped by IS NULL, so it is idempotent and only ever suppresses sends.
-- Result: 11 customers now marked, 0 unmarked. Two of them were still pending in
-- win-back batch WB-2026-10-A and are now correctly skipped.

UPDATE public.customers c
   SET sms_marketing_opt_out_at = s.first_stop
  FROM (SELECT customer_id, min(created_at) AS first_stop
          FROM public.sms_messages
         WHERE error_code = '21610' AND customer_id IS NOT NULL
         GROUP BY customer_id) s
 WHERE c.id = s.customer_id
   AND c.sms_marketing_opt_out_at IS NULL;

-- Verify — expect marked = 11, unmarked = 0:
-- SELECT count(*) FILTER (WHERE c.sms_marketing_opt_out_at IS NOT NULL) AS marked,
--        count(*) FILTER (WHERE c.sms_marketing_opt_out_at IS NULL)     AS unmarked
-- FROM customers c
-- WHERE c.id IN (SELECT customer_id FROM sms_messages WHERE error_code='21610' AND customer_id IS NOT NULL);

-- Rollback (only if needed):
-- UPDATE public.customers SET sms_marketing_opt_out_at = NULL
--  WHERE id IN (SELECT customer_id FROM sms_messages WHERE error_code='21610' AND customer_id IS NOT NULL)
--    AND sms_marketing_opt_out_at < '2026-10-01';
