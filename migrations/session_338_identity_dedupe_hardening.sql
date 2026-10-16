-- =====================================================================
-- Session 338 — Oct 9, 2026: one person, one identity
--
-- Paste this WHOLE file into Supabase → SQL Editor → Run. It is one
-- transaction: if any step fails, nothing is changed.
-- Copy it from the file itself, not from a chat window: an earlier copy
-- through chat lost everything after a "less than" sign. This version has
-- none, and avoids SELECT ... INTO (Supabase's editor mistook v_ids for a table).
--
-- PART A — prevention (schema/functions)
--   A1  Snapshot the two functions we touch (rollback source)
--   A2  merge_duplicate_customer: stop silently deleting the merged-away
--       account's history. 13 child tables CASCADE-deleted with the dup
--       (referral codes, win-back grants, feedback, message/send logs...).
--       They are now moved to the surviving account first.
--   A3  find_duplicate_customer_pairs: "same phone + same FULL name" →
--       "same phone + same FIRST name". Catches surname changes
--       (Danielle Ross / Randle-Ross) and short names (Blanca Ca), still
--       ignores households (Casey/Galen) and business sites (Homebase /
--       Soul Sanctuary). Verified Oct 9: matches exactly 3 pairs.
--   A4  cleanup_orphan_phone_auth_users(): nightly removal of abandoned
--       phone sign-ups (never confirmed, never signed in, >24h old, no
--       customer, not staff/driver/launderer/POS). Mirror of the existing
--       email cleanup. Capped at 50/run; 181 in the backlog → ~4 nights.
--       Every deleted id/phone is archived first.
--   A5  Cron: daily 10:05 UTC, 5 min after the email cleanup.
--
-- PART B — today's fixes
--   B1  Peter Eggenberger: delete his abandoned phone sign-up
--   B2  Merge Danielle Ross (2022) into Danielle Randle-Ross (her login)
--   B3  Merge Blanca Ca (2022) into Blanca Cervantes (created Oct 7)
--
-- Nothing here sends a message. The only trigger on a moved table that
-- calls out (trg_order_feedback_notify) returns early when rating and
-- comment are unchanged, which they are during a merge.
--
-- ROLLBACK (functions only; deleted abandoned sign-ups are archived, not restorable):
--   DO $r$ DECLARE r record; BEGIN
--     FOR r IN SELECT def FROM _archive.fn_snapshot_session_338 LOOP EXECUTE r.def; END LOOP;
--   END $r$;
--   SELECT cron.unschedule('cleanup-orphan-phone-auth-users');
--   DROP FUNCTION public.cleanup_orphan_phone_auth_users();
-- =====================================================================

BEGIN;

-- ── A1 ──────────────────────────────────────────────────────────────
CREATE TABLE _archive.fn_snapshot_session_338 AS
SELECT p.proname, pg_get_functiondef(p.oid) AS def, now() AS snapshot_at
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('merge_duplicate_customer', 'find_duplicate_customer_pairs');

-- ── A2 ──────────────────────────────────────────────────────────────
DO $do$
DECLARE
  v_def  text;
  v_pos  int;
  v_snip text := $snip$  -- ── (session 338) Child rows the original merge forgot. Each of these
  --    CASCADE-deletes with the duplicate, so history was silently lost.
  --    Where a unique key says the surviving account already holds the
  --    equivalent row, the duplicate's copy is left to be dropped.
  UPDATE order_feedback             SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE customer_messages          SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE referral_events            SET referrer_customer_id = p_keep WHERE referrer_customer_id = p_dup;
  UPDATE sms_optout_restore_log     SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE invoice_adjustments        SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE subscription_receipt_sends SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE cs_signals                 SET customer_id = p_keep WHERE customer_id = p_dup;
  UPDATE referrals                  SET referrer_customer_id = p_keep WHERE referrer_customer_id = p_dup;
  -- If BOTH accounts were referred, the dup's row stays and the delete below
  -- fails on its FK: the merge rolls back and a human decides. Deliberate.
  UPDATE referrals r SET referred_customer_id = p_keep
   WHERE r.referred_customer_id = p_dup
     AND NOT EXISTS (SELECT 1 FROM referrals x WHERE x.referred_customer_id = p_keep);
  UPDATE referral_codes rc SET customer_id = p_keep
   WHERE rc.customer_id = p_dup
     AND NOT EXISTS (SELECT 1 FROM referral_codes x WHERE x.customer_id = p_keep);
  UPDATE email_send_log e SET customer_id = p_keep
   WHERE e.customer_id = p_dup
     AND NOT EXISTS (SELECT 1 FROM email_send_log x WHERE x.customer_id = p_keep AND x.kind = e.kind);
  UPDATE marketing_sms_log m SET customer_id = p_keep
   WHERE m.customer_id = p_dup
     AND NOT EXISTS (SELECT 1 FROM marketing_sms_log x WHERE x.customer_id = p_keep AND x.kind = m.kind);
  UPDATE winback_grants w SET customer_id = p_keep
   WHERE w.customer_id = p_dup
     AND NOT EXISTS (SELECT 1 FROM winback_grants x WHERE x.customer_id = p_keep AND x.batch = w.batch);

$snip$;
BEGIN
  v_def := pg_get_functiondef('public.merge_duplicate_customer(uuid,uuid)'::regprocedure);
  IF strpos(v_def, 'UPDATE order_feedback') > 0 THEN
    RAISE EXCEPTION 'merge_duplicate_customer is already patched';
  END IF;
  v_pos := strpos(v_def, '  -- ── Roll up the numbers');
  IF v_pos = 0 THEN
    RAISE EXCEPTION 'insertion marker not found in merge_duplicate_customer';
  END IF;
  v_def := overlay(v_def PLACING v_snip FROM v_pos FOR 0);

  -- Pre-existing bug (since the 2026-09-21 conversations dedupe): the two
  -- conversations statements alias a table as "d", which is also the name of
  -- this function's record variable. PL/pgSQL resolves d.channel to the
  -- unassigned record and EVERY merge fails ("record d is not assigned yet").
  -- No merge has succeeded since Sep 21. Rename the alias to dc.
  IF (length(v_def) - length(replace(v_def, 'FROM conversations d JOIN conversations k ON k.customer_id = p_keep AND k.channel = d.channel', ''))) = 0
  OR (length(v_def) - length(replace(v_def, 'DELETE FROM conversations d USING conversations k', ''))) = 0 THEN
    RAISE EXCEPTION 'conversations statements not found as expected in merge_duplicate_customer';
  END IF;
  v_def := replace(v_def,
    'FROM conversations d JOIN conversations k ON k.customer_id = p_keep AND k.channel = d.channel',
    'FROM conversations dc JOIN conversations k ON k.customer_id = p_keep AND k.channel = dc.channel');
  v_def := replace(v_def,
    'WHERE d.customer_id = p_dup AND i.conversation_id = d.id;',
    'WHERE dc.customer_id = p_dup AND i.conversation_id = dc.id;');
  v_def := replace(v_def,
    'DELETE FROM conversations d USING conversations k',
    'DELETE FROM conversations dc USING conversations k');
  v_def := replace(v_def,
    'WHERE d.customer_id = p_dup AND k.customer_id = p_keep AND k.channel = d.channel;',
    'WHERE dc.customer_id = p_dup AND k.customer_id = p_keep AND k.channel = dc.channel;');

  EXECUTE v_def;

  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.merge_duplicate_customer(uuid,uuid)'::regprocedure),
            'UPDATE winback_grants w SET customer_id = p_keep') = 0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.merge_duplicate_customer(uuid,uuid)'::regprocedure),
            'DELETE FROM customers WHERE id = p_dup') = 0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.merge_duplicate_customer(uuid,uuid)'::regprocedure),
            'conversations d ') > 0
  OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.merge_duplicate_customer(uuid,uuid)'::regprocedure),
            ' d.channel') > 0 THEN
    RAISE EXCEPTION 'merge_duplicate_customer patch did not land as expected';
  END IF;
END
$do$;

-- ── A3 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.find_duplicate_customer_pairs(p_days_back integer DEFAULT NULL::integer)
 RETURNS TABLE(pair_key text, keep_id uuid, keep_name text, keep_orders integer, keep_created timestamp with time zone, dup_id uuid, dup_name text, dup_orders integer, dup_created timestamp with time zone, match_reason text, contact text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
  WITH n AS (
    SELECT c.id, c.total_orders, c.created_at,
           TRIM(COALESCE(c.first_name_cache,'') || ' ' || COALESCE(c.last_name_cache,'')) AS disp,
           NULLIF(lower(trim(c.email_cache)), '')                                     AS email_n,
           NULLIF(RIGHT(regexp_replace(COALESCE(c.phone_cache,''),'\D','','g'),10),'') AS p10,
           -- session 338: FIRST name only. Full-name matching missed surname
           -- changes and shortened names; households/businesses sharing a
           -- phone almost always differ in first name.
           regexp_replace(lower(COALESCE(c.first_name_cache,'')), '[^a-z]', '', 'g')  AS first_n,
           (SELECT count(*) FROM orders o WHERE o.customer_id = c.id)                  AS live_orders,
           COALESCE(c.last_order_at, '-infinity'::timestamptz)                         AS seen
    FROM customers c
    WHERE c.cancelled_at IS NULL
  ),
  pairs AS (
    SELECT a.id AS a_id, b.id AS b_id, 'same email' AS reason, a.email_n AS contact
    FROM n a JOIN n b ON b.id > a.id AND a.email_n = b.email_n
    WHERE a.email_n IS NOT NULL
    UNION
    SELECT a.id, b.id, 'same phone + same first name', a.p10
    FROM n a JOIN n b ON b.id > a.id AND a.p10 = b.p10 AND a.first_n = b.first_n
    WHERE a.p10 IS NOT NULL AND a.first_n != ''
  ),
  rolled AS (
    SELECT a_id, b_id,
           string_agg(DISTINCT reason,  ' + ' ORDER BY reason)  AS reason,
           string_agg(DISTINCT contact, ' / ' ORDER BY contact) AS contact
    FROM pairs GROUP BY a_id, b_id
  ),
  ranked AS (
    SELECT LEAST(r.a_id, r.b_id)::text || '|' || GREATEST(r.a_id, r.b_id)::text AS pair_key,
           CASE WHEN (na.live_orders, na.seen, -extract(epoch FROM na.created_at))
                  >= (nb.live_orders, nb.seen, -extract(epoch FROM nb.created_at))
                THEN na.id ELSE nb.id END AS keep_id,
           CASE WHEN (na.live_orders, na.seen, -extract(epoch FROM na.created_at))
                  >= (nb.live_orders, nb.seen, -extract(epoch FROM nb.created_at))
                THEN nb.id ELSE na.id END AS dup_id,
           r.reason, r.contact
    FROM rolled r
    JOIN n na ON na.id = r.a_id
    JOIN n nb ON nb.id = r.b_id
  )
  SELECT r.pair_key, k.id, k.disp, k.total_orders, k.created_at,
         d.id, d.disp, d.total_orders, d.created_at, r.reason, r.contact
  FROM ranked r
  JOIN n k ON k.id = r.keep_id
  JOIN n d ON d.id = r.dup_id
  WHERE NOT EXISTS (SELECT 1 FROM customer_duplicate_dismissals x WHERE x.pair_key = r.pair_key)
    AND (p_days_back IS NULL OR d.created_at >= now() - make_interval(days => p_days_back))
  ORDER BY d.created_at DESC;
$fn$;

DO $chk$
DECLARE v_src text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.find_duplicate_customer_pairs(integer)'::regprocedure);
BEGIN
  -- strpos, not LIKE: LIKE would eat the backslash we are checking for.
  IF strpos(v_src, '''\D''') = 0 OR strpos(v_src, 'same phone + same first name') = 0 THEN
    RAISE EXCEPTION 'find_duplicate_customer_pairs did not land as expected';
  END IF;
END
$chk$;

-- ── A4 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS _archive.orphan_phone_auth_deleted (
  id          uuid        NOT NULL,
  phone       text,
  created_at  timestamptz,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.cleanup_orphan_phone_auth_users()
 RETURNS TABLE(deleted_count integer, deleted_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ids uuid[];
BEGIN
  PERFORM public.assert_staff('cleanup_orphan_phone_auth_users');
  -- Abandoned phone sign-up = phone-only auth user that never confirmed its
  -- code and never signed in, >24h old, with no customer and no staff link.
  -- These are what made Peter Eggenberger's later phone sign-in land on an
  -- empty account (session 338). Whitelisted roles only; capped at 50/run.
  v_ids := ARRAY(
  SELECT v.id FROM (
    SELECT au.id
    FROM auth.users au
    LEFT JOIN public.profiles p ON p.id = au.id
    WHERE COALESCE(au.email, '') = ''
      AND au.phone IS NOT NULL
      AND au.phone_confirmed_at IS NULL
      AND au.last_sign_in_at IS NULL
      AND now() - interval '24 hours' > au.created_at
      AND (p.role IS NULL OR p.role = 'customer')
      AND NOT EXISTS (SELECT 1 FROM public.customers   c WHERE c.profile_id   = au.id)
      AND NOT EXISTS (SELECT 1 FROM public.drivers     d WHERE d.profile_id   = au.id)
      AND NOT EXISTS (SELECT 1 FROM public.launderers  l WHERE l.profile_id   = au.id)
      AND NOT EXISTS (SELECT 1 FROM public.pos_devices x WHERE x.auth_user_id = au.id)
    ORDER BY au.created_at ASC
    LIMIT 50
  ) v);

  IF COALESCE(array_length(v_ids, 1), 0) > 0 THEN
    INSERT INTO _archive.orphan_phone_auth_deleted (id, phone, created_at)
    SELECT id, phone, created_at FROM auth.users WHERE id = ANY(v_ids);
    DELETE FROM auth.users WHERE id = ANY(v_ids);
  END IF;

  RETURN QUERY SELECT COALESCE(array_length(v_ids, 1), 0), v_ids;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.cleanup_orphan_phone_auth_users() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_orphan_phone_auth_users() FROM anon;
GRANT  EXECUTE ON FUNCTION public.cleanup_orphan_phone_auth_users() TO authenticated, service_role;

-- ── A5 ──────────────────────────────────────────────────────────────
SELECT cron.schedule('cleanup-orphan-phone-auth-users', '5 10 * * *',
                     'SELECT public.cleanup_orphan_phone_auth_users();');

-- ── B1 Peter Eggenberger ────────────────────────────────────────────
INSERT INTO _archive.orphan_phone_auth_deleted (id, phone, created_at)
SELECT id, phone, created_at FROM auth.users
WHERE id = '2c2125fc-c253-4f7c-98e3-37a08a1eb523' AND phone_confirmed_at IS NULL AND last_sign_in_at IS NULL;
DELETE FROM auth.users
WHERE id = '2c2125fc-c253-4f7c-98e3-37a08a1eb523'
  AND COALESCE(email, '') = '' AND phone_confirmed_at IS NULL AND last_sign_in_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.customers WHERE profile_id = '2c2125fc-c253-4f7c-98e3-37a08a1eb523');

-- ── B2 Danielle: keep the account she signs in to ───────────────────
SELECT public.merge_duplicate_customer('bf060968-66e7-4f31-8347-394f9748c8e8',   -- keep: Randle-Ross, has login
                                       '9991933f-0498-4558-a357-abb618ce9539');  -- dup: Ross, 2022, 9 legacy orders
UPDATE public.addresses SET is_default = true
WHERE customer_id = 'bf060968-66e7-4f31-8347-394f9748c8e8'
  AND (SELECT count(*) FROM public.addresses WHERE customer_id = 'bf060968-66e7-4f31-8347-394f9748c8e8') = 1;

-- ── B3 Blanca: keep the Oct 7 record ────────────────────────────────
SELECT public.merge_duplicate_customer('a5cb4398-f387-4780-aa7b-a1aa5068fdea',   -- keep: Blanca Cervantes
                                       '6e88afd1-644c-448e-aa84-fcfb65f3179b');  -- dup: Blanca Ca, 2022

COMMIT;

-- ── Check (run after; expect: false / 0 / 0 / 1 / 1) ────────────────
SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = '2c2125fc-c253-4f7c-98e3-37a08a1eb523') AS peter_leftover_still_there,
       (SELECT count(*) FROM customers WHERE id IN ('9991933f-0498-4558-a357-abb618ce9539','6e88afd1-644c-448e-aa84-fcfb65f3179b')) AS old_records_left,
       (SELECT count(*) FROM find_duplicate_customer_pairs(NULL) WHERE keep_name NOT ILIKE 'Kristen%') AS open_pairs_besides_kristen,
       (SELECT count(*) FROM cron.job WHERE jobname = 'cleanup-orphan-phone-auth-users') AS cron_installed,
       (SELECT count(*) FROM _archive.orphan_phone_auth_deleted) AS archived_rows;
