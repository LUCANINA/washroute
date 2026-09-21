-- Dedupe conversations: one row per (channel, customer) or (channel, phone) when no customer.
-- Cause: inbox loaded conversations unfiltered (API capped at 1,000 rows), so Archive
-- inserted a fresh row each time. Client fixed in commit 293444a.
-- Keep rule = newest updated_at (what the fixed inbox reads). Rollback: _archive snapshots.

-- 1. Snapshots (rollback source)
CREATE TABLE _archive.conversations_20260921 AS SELECT * FROM public.conversations;
CREATE TABLE _archive.cs_issues_conv_20260921 AS
  SELECT id, conversation_id FROM public.cs_issues WHERE conversation_id IS NOT NULL;
CREATE TABLE _archive.fn_merge_duplicate_customer_20260921 AS
  SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p
  WHERE p.proname = 'merge_duplicate_customer' AND p.pronamespace = 'public'::regnamespace;

-- 2. Rank rows; survivor = rn 1
CREATE TEMP TABLE _conv_rank ON COMMIT DROP AS
SELECT id, first_value(id) OVER w AS keep_id, row_number() OVER w AS rn
FROM public.conversations
WINDOW w AS (PARTITION BY channel, coalesce(customer_id::text, phone, '')
             ORDER BY updated_at DESC NULLS LAST, created_at DESC);

-- 3. Repoint issues, then delete duplicates
UPDATE public.cs_issues i SET conversation_id = r.keep_id
  FROM _conv_rank r WHERE i.conversation_id = r.id AND r.rn > 1;
DELETE FROM public.conversations c USING _conv_rank r WHERE c.id = r.id AND r.rn > 1;

-- 4. merge_duplicate_customer must not create a duplicate when both customers have a thread
DO $m$
DECLARE v_def text; v_old text := 'UPDATE conversations         SET customer_id = p_keep WHERE customer_id = p_dup;';
  v_new text := $g$-- conversations: keep's thread wins per channel (unique index, 2026-09-21)
  UPDATE cs_issues i SET conversation_id = k.id
    FROM conversations d JOIN conversations k ON k.customer_id = p_keep AND k.channel = d.channel
   WHERE d.customer_id = p_dup AND i.conversation_id = d.id;
  DELETE FROM conversations d USING conversations k
   WHERE d.customer_id = p_dup AND k.customer_id = p_keep AND k.channel = d.channel;
  UPDATE conversations         SET customer_id = p_keep WHERE customer_id = p_dup;$g$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   WHERE p.proname = 'merge_duplicate_customer' AND p.pronamespace = 'public'::regnamespace;
  IF strpos(v_def, v_old) = 0 THEN RAISE EXCEPTION 'merge_duplicate_customer: anchor not found'; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF (SELECT strpos(prosrc, 'keep''s thread wins per channel') FROM pg_proc
       WHERE proname = 'merge_duplicate_customer' AND pronamespace = 'public'::regnamespace) = 0
  THEN RAISE EXCEPTION 'merge_duplicate_customer patch not applied'; END IF;
END $m$;

-- 5. Block future duplicates
CREATE UNIQUE INDEX uq_conversations_channel_customer
  ON public.conversations (channel, customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX uq_conversations_channel_phone
  ON public.conversations (channel, phone) WHERE customer_id IS NULL AND phone IS NOT NULL;

-- 6. Assert
DO $a$ BEGIN
  IF EXISTS (SELECT 1 FROM public.conversations
             GROUP BY channel, coalesce(customer_id::text, phone, '') HAVING count(*) > 1)
  THEN RAISE EXCEPTION 'duplicates remain'; END IF;
  IF EXISTS (SELECT 1 FROM public.cs_issues i LEFT JOIN public.conversations c ON c.id = i.conversation_id
             WHERE i.conversation_id IS NOT NULL AND c.id IS NULL)
  THEN RAISE EXCEPTION 'orphaned cs_issues'; END IF;
END $a$;
