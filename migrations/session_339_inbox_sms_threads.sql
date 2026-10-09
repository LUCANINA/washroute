-- Session 339: inbox_sms_threads() — one row per SMS conversation, for the admin Inbox.
--
-- Why: the Inbox built its thread list from the newest 1,000 sms_messages rows (the
-- Data API's row cap). At ~1,700 texts/day that is ~2 days of history, so any thread
-- quiet for 2+ days silently dropped out of the Inbox — including an unanswered
-- customer text (it vanished from Needs Reply). This returns the per-thread summary
-- the Inbox needs, computed over ALL messages, so nothing ages out.
--
-- Rows returned: every thread that has at least one inbound text AND either
--   (a) had activity in the last p_days days, or (b) the customer texted last
--   (possibly unanswered, any age).
-- The client pages with .range() because this can exceed the 1,000-row cap.
--
-- Read-only. SECURITY INVOKER: sms_messages / customers RLS still applies
-- (admins see everything; nobody else needs this).
-- Rollback: DROP FUNCTION public.inbox_sms_threads(integer);

CREATE OR REPLACE FUNCTION public.inbox_sms_threads(p_days integer DEFAULT 30)
RETURNS TABLE (
  conv_key            text,
  customer_id         uuid,
  latest_id           uuid,
  latest_direction    text,
  latest_body         text,
  latest_media_urls   jsonb,
  latest_from_number  text,
  latest_to_number    text,
  latest_at           timestamptz,
  last_outbound_at    timestamptz,
  inbound_after_reply integer,
  first_name_cache    text,
  last_name_cache     text,
  phone_cache         text,
  email_cache         text,
  sms_consent_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH m AS (
    SELECT s.id, s.direction, s.created_at,
           COALESCE(s.customer_id::text,
                    CASE WHEN s.direction = 'inbound' THEN s.from_number ELSE s.to_number END) AS k
    FROM sms_messages s
  ),
  w AS (
    SELECT m.*,
           row_number() OVER (PARTITION BY k ORDER BY created_at DESC, id DESC)            AS rn,
           max(created_at) FILTER (WHERE direction = 'outbound') OVER (PARTITION BY k)  AS last_out,
           bool_or(direction = 'inbound') OVER (PARTITION BY k)                         AS has_in
    FROM m
  ),
  t AS (
    SELECT k,
           (array_agg(id) FILTER (WHERE rn = 1))[1]        AS latest_id,
           max(direction) FILTER (WHERE rn = 1)            AS latest_dir,
           max(created_at)                                 AS latest_at,
           max(last_out)                                   AS last_out,
           count(*) FILTER (WHERE direction = 'inbound'
                              AND created_at > COALESCE(last_out, '-infinity'::timestamptz))::int AS inb
    FROM w
    WHERE has_in
    GROUP BY k
  )
  SELECT t.k, s.customer_id, s.id, s.direction, s.body, s.media_urls, s.from_number, s.to_number,
         t.latest_at, t.last_out, t.inb,
         c.first_name_cache, c.last_name_cache, c.phone_cache, c.email_cache, c.sms_consent_at
  FROM t
  JOIN sms_messages s ON s.id = t.latest_id
  LEFT JOIN customers c ON c.id = s.customer_id
  WHERE t.latest_at > now() - make_interval(days => GREATEST(COALESCE(p_days, 30), 1))
     OR t.latest_dir = 'inbound'
  ORDER BY t.latest_at DESC, t.k;
$fn$;

REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.inbox_sms_threads(integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
