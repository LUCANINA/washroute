-- session_185_enforce_issue_order_link.sql
-- Applied via Supabase apply_migration (name: enforce_issue_order_link) on 2026-07-22.
--
-- Purpose: back the new "Issues" column on the Launderers report. Order-specific
-- issue types (pickup / delivery / damaged) must be linked to an order so they can
-- be attributed to the launderer who folded that order. General CS types
-- (billing / schedule / complaint / other) and Lost & Found (found items may have
-- no known owner) stay order-optional. System/migration inserts are exempt so the
-- stripe-webhook grace-expiry 'Billing' issue and past notes migration keep working.
--
-- BEFORE INSERT only -> the 157 existing order-less rows are untouched. Not
-- SECURITY DEFINER, no column added (no PostgREST schema-cache risk), fully reversible.

CREATE OR REPLACE FUNCTION public.enforce_issue_order_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.order_id IS NULL
     AND lower(COALESCE(NEW.category, '')) IN ('pickup', 'delivery', 'damaged')
     AND COALESCE(NEW.created_by, '') NOT IN ('migration', 'system')
  THEN
    RAISE EXCEPTION 'Issues of type "%" must be linked to an order.', NEW.category
      USING ERRCODE = 'check_violation',
            HINT = 'Select the order this issue relates to before saving.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_issue_order_link ON public.cs_issues;
CREATE TRIGGER trg_enforce_issue_order_link
  BEFORE INSERT ON public.cs_issues
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_issue_order_link();

-- Report reads cs_issues by created_at range and joins on order_id.
CREATE INDEX IF NOT EXISTS idx_cs_issues_created_at ON public.cs_issues (created_at);
CREATE INDEX IF NOT EXISTS idx_cs_issues_order_id   ON public.cs_issues (order_id);

-- ── Rollback ────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS trg_enforce_issue_order_link ON public.cs_issues;
-- DROP FUNCTION IF EXISTS public.enforce_issue_order_link();
-- DROP INDEX IF EXISTS public.idx_cs_issues_created_at;
-- DROP INDEX IF EXISTS public.idx_cs_issues_order_id;
