-- Session 339b: inbox_sms_threads v2 — same result as 339, ~4x faster, one call.
--
-- v1 (SECURITY INVOKER) took ~4s for an admin: the sms_messages RLS check ran on
-- each of ~100k rows, and the result (1,251 threads) exceeded the Data API's
-- 1,000-row cap, so the client had to run the whole query twice to page it.
-- v2: SECURITY DEFINER with ONE up-front guard that admits exactly the roles the
-- sms_messages admin policy admits (is_admin() = admin/manager/laundry_tech) plus
-- service_role; returns a single jsonb array (not subject to the row cap).
-- Read-only. Rollback: DROP FUNCTION public.inbox_sms_threads(integer); then re-apply 339.

DROP FUNCTION IF EXISTS public.inbox_sms_threads(integer);

CREATE FUNCTION public.inbox_sms_threads(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET work_mem TO '32MB'
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT (public.is_admin() OR coalesce(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'inbox_sms_threads: staff only' USING ERRCODE = '42501';
  END IF;

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
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'conv_key', t.k, 'customer_id', s.customer_id,
           'latest_id', s.id, 'latest_direction', s.direction, 'latest_body', s.body,
           'latest_media_urls', s.media_urls, 'latest_from_number', s.from_number,
           'latest_to_number', s.to_number, 'latest_at', t.latest_at,
           'last_outbound_at', t.last_out, 'inbound_after_reply', t.inb,
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
$fn$;

REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.inbox_sms_threads(integer) FROM anon;
GRANT  EXECUTE ON FUNCTION public.inbox_sms_threads(integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
