-- Session 346: inbox_sms_threads v3 — "needs a human reply" is measured against the
-- last STAFF reply, not against any outbound text.
--
-- Why: v2 counted inbound_after_reply as "inbound messages since the last outbound
-- message of any kind". Automated texts (order updates, rating asks, STOP
-- confirmations, win-back nudges) are outbound, so an automated text landing after a
-- customer's question reset the count to 0 and, combined with the dashboard's
-- "reopen only if the latest message is inbound" rule, made the thread look handled.
-- Measured 2026-10-15: 260 threads in 30 days were hidden this way, ~118 of them
-- more than a pleasantry. Jay Meissner asked "So the $300 credit I had is gone?" at
-- 17:37 and an automated "Would you like to schedule your first pick up?" at 17:40
-- buried it.
--
-- Changes, all additive to the returned JSON:
--   * inbound_after_reply  — now counted against the last reply sent by a logged-in
--                            staff user (sms_messages.sent_by_user_id IS NOT NULL),
--                            which is what send-sms stamps for dashboard replies.
--   * last_inbound_at      — NEW: when the customer last texted.
--   * last_staff_reply_at  — NEW: when a human last replied (NULL if never).
--   * last_outbound_at     — unchanged, still any outbound (dashboard still reads it).
--
-- Read-only reporting function. No schema change, no new/renamed/dropped columns, so
-- no PostgREST schema-cache exposure. Signature and defaults unchanged
-- (p_days integer DEFAULT 30). Only caller is admin-dashboard/index.html loadInbox().
-- Rollback: re-apply migrations/session_339b_inbox_sms_threads_fast.sql.

CREATE OR REPLACE FUNCTION public.inbox_sms_threads(p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET work_mem TO '32MB'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT (public.is_admin() OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'inbox_sms_threads: staff only' USING ERRCODE = '42501';
  END IF;

  WITH m AS (
    SELECT s.id, s.direction, s.created_at, s.sent_by_user_id,
           COALESCE(s.customer_id::text,
                    CASE WHEN s.direction = 'inbound' THEN s.from_number ELSE s.to_number END) AS k
    FROM sms_messages s
  ),
  w AS (
    SELECT m.*,
           row_number() OVER (PARTITION BY k ORDER BY created_at DESC, id DESC)          AS rn,
           max(created_at) FILTER (WHERE direction = 'outbound') OVER (PARTITION BY k)   AS last_out,
           -- a human reply: sent from the dashboard by a signed-in staff user
           max(created_at) FILTER (WHERE direction = 'outbound'
                                     AND sent_by_user_id IS NOT NULL) OVER (PARTITION BY k) AS last_staff,
           max(created_at) FILTER (WHERE direction = 'inbound')  OVER (PARTITION BY k)   AS last_in,
           bool_or(direction = 'inbound') OVER (PARTITION BY k)                          AS has_in
    FROM m
  ),
  t AS (
    SELECT k,
           (array_agg(id) FILTER (WHERE rn = 1))[1] AS latest_id,
           max(direction) FILTER (WHERE rn = 1)     AS latest_dir,
           max(created_at)                          AS latest_at,
           max(last_out)                            AS last_out,
           max(last_staff)                          AS last_staff,
           max(last_in)                             AS last_in,
           -- last_staff is a per-partition window value, identical on every row of the
           -- partition, so it is safe to read inside this FILTER (same shape v2 used
           -- for last_out).
           count(*) FILTER (WHERE direction = 'inbound'
                              AND created_at > COALESCE(last_staff, '-infinity'::timestamptz))::int AS inb
    FROM w
    WHERE has_in
    GROUP BY k
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'conv_key', t.k, 'customer_id', s.customer_id,
           'latest_id', s.id, 'latest_direction', s.direction, 'latest_body', s.body,
           'latest_media_urls', s.media_urls, 'latest_from_number', s.from_number,
           'latest_to_number', s.to_number, 'latest_at', t.latest_at,
           'last_outbound_at', t.last_out, 'inbound_after_reply', t.inb,
           'last_inbound_at', t.last_in, 'last_staff_reply_at', t.last_staff,
           'first_name_cache', c.first_name_cache, 'last_name_cache', c.last_name_cache,
           'phone_cache', c.phone_cache, 'email_cache', c.email_cache, 'sms_consent_at', c.sms_consent_at
         ) ORDER BY t.latest_at DESC, t.k), '[]'::jsonb)
    INTO v_out
  FROM t
  JOIN sms_messages s ON s.id = t.latest_id
  LEFT JOIN customers c ON c.id = s.customer_id
  WHERE t.latest_at > now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1))
     OR t.latest_dir = 'inbound';

  RETURN v_out;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.inbox_sms_threads(integer) TO authenticated, service_role;

-- Assert the new shape actually landed (apply_migration is transactional, so a failed
-- assert rolls the whole thing back).
DO $assert$
BEGIN
  IF strpos((SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace
               AND proname = 'inbox_sms_threads'), 'last_staff_reply_at') = 0 THEN
    RAISE EXCEPTION 'session_346: last_staff_reply_at missing from inbox_sms_threads body';
  END IF;
END
$assert$;
