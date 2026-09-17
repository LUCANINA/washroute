-- Session 300 (2026-09-17): delete a single feedback entry from
-- Reports → Customers → Feedback (test posts, junk, duplicates).
--
-- * delete_feedback_entry(p_kind, p_id) — ADMIN ONLY. Note public.is_admin() also
--   allows manager/laundry_tech, so this uses the strict public.is_role_admin()
--   (role = 'admin'), added in session_300b.
--   p_kind 'rating'  → public.order_feedback
--   p_kind 'message' → public.customer_messages
-- * If the entry opened a cs_issue itself (created_by = 'customer-feedback') and
--   nothing else still points at that issue, the issue goes too. A staff-authored
--   issue, or one still referenced by another feedback row, is left alone.
-- * Photo files live in the private feedback-photos bucket. SQL cannot remove the
--   object from storage, so the RPC returns the paths and the dashboard deletes
--   them with storage.remove() — hence the admin DELETE policy below.
--
-- Rollback:
--   DROP FUNCTION public.delete_feedback_entry(text, bigint);
--   DROP FUNCTION public.is_role_admin();
--   DROP POLICY feedback_photos_admin_delete ON storage.objects;

CREATE OR REPLACE FUNCTION public.is_role_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin');
$function$;

REVOKE EXECUTE ON FUNCTION public.is_role_admin() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_role_admin() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_role_admin() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_feedback_entry(p_kind text, p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_issue         integer;
  v_paths         text[] := '{}';
  v_issue_deleted boolean := false;
  v_found         boolean := false;
BEGIN
  PERFORM public.assert_staff('delete_feedback_entry');
  IF NOT (public.is_role_admin() OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'forbidden — admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('rating', 'message') THEN
    RAISE EXCEPTION 'unknown feedback kind: %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'missing feedback id' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_kind = 'rating' THEN
    DELETE FROM public.order_feedback WHERE id = p_id
      RETURNING issue_id INTO v_issue;
    v_found := FOUND;
  ELSE
    DELETE FROM public.customer_messages WHERE id = p_id
      RETURNING issue_id, COALESCE(photo_paths, '{}') INTO v_issue, v_paths;
    v_found := FOUND;
  END IF;

  IF NOT v_found THEN
    RAISE EXCEPTION 'that feedback entry no longer exists' USING ERRCODE = 'no_data_found';
  END IF;

  -- Only the issue this entry opened, and only if nothing else still points at it.
  IF v_issue IS NOT NULL THEN
    DELETE FROM public.cs_issues i
     WHERE i.id = v_issue
       AND i.created_by = 'customer-feedback'
       AND NOT EXISTS (SELECT 1 FROM public.order_feedback f    WHERE f.issue_id = v_issue)
       AND NOT EXISTS (SELECT 1 FROM public.customer_messages m WHERE m.issue_id = v_issue);
    v_issue_deleted := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'issue_id', v_issue,
    'issue_deleted', v_issue_deleted,
    'photo_paths', to_jsonb(COALESCE(v_paths, '{}'::text[]))
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.delete_feedback_entry(text, bigint) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_feedback_entry(text, bigint) FROM anon;
GRANT  EXECUTE ON FUNCTION public.delete_feedback_entry(text, bigint) TO authenticated, service_role;

-- Let an admin remove the photo objects that belonged to a deleted message.
DROP POLICY IF EXISTS feedback_photos_admin_delete ON storage.objects;
CREATE POLICY feedback_photos_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'feedback-photos' AND public.is_role_admin());
