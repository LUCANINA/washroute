-- Session 291 — Customer-service escalation & pattern detection
-- Design: docs/washroute/DESIGN-CS-ESCALATION.md
--
-- Re-keys cs_issues from customer_id to contact_phone (so non-customers —
-- neighbours, prospects, landlords — stop being invisible), enforces a theme
-- vocabulary, makes "resolved" require a statement of what CHANGED, and adds
-- cs_signals as the fingerprint-deduped output of the nightly detector.
--
-- NO drops, NO renames, NO type changes. Purely additive.
--
-- PART A of two. The close-requires-a-note CHECK lives in session_291b and is
-- applied ONLY with the dashboard change that supplies the note -- adding it
-- here would break the existing Resolve button (admin-dashboard changeIssueStatus
-- and the Lost & Found return path both set status='resolved' with no action text).

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. cs_issues — contact-keyed columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.cs_issues
  ADD COLUMN IF NOT EXISTS contact_phone      text,
  ADD COLUMN IF NOT EXISTS contact_email      text,
  ADD COLUMN IF NOT EXISTS contact_name       text,
  ADD COLUMN IF NOT EXISTS is_customer        boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS theme              text,
  ADD COLUMN IF NOT EXISTS subject_ref        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS first_reported_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_reported_at   timestamptz,
  ADD COLUMN IF NOT EXISTS report_count       integer  NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS severity           smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS resolution_action  text,
  ADD COLUMN IF NOT EXISTS reopened_count     integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS verify_by          date;

-- Backfill the clocks from what we already know, so aging is not reset to now().
UPDATE public.cs_issues
   SET first_reported_at = COALESCE(first_reported_at, created_at),
       last_reported_at  = COALESCE(last_reported_at,  updated_at, created_at)
 WHERE first_reported_at IS NULL OR last_reported_at IS NULL;

-- is_customer reflects reality for existing rows.
UPDATE public.cs_issues SET is_customer = (customer_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────
-- 2. theme vocabulary — replaces free-text category
--    (category is KEPT for one release; it is not dropped here.)
-- ─────────────────────────────────────────────────────────────
UPDATE public.cs_issues SET theme = CASE lower(coalesce(category,''))
    WHEN 'billing'              THEN 'billing'
    WHEN 'damaged'              THEN 'damage'
    WHEN 'lost_found'           THEN 'lost_item'
    WHEN 'delivery'             THEN 'missed_service'
    WHEN 'schedule'             THEN 'missed_service'
    WHEN 'account_cancellation' THEN 'account'
    WHEN 'complaint'            THEN 'other'
    WHEN 'note'                 THEN 'other'
    ELSE 'other'
  END
 WHERE theme IS NULL;

ALTER TABLE public.cs_issues
  ADD CONSTRAINT cs_issues_theme_check CHECK (
    theme IS NULL OR theme IN (
      'parking','driver_conduct','damage','lost_item','missed_service',
      'quality','billing','app','account','other'
    )
  );

ALTER TABLE public.cs_issues
  ADD CONSTRAINT cs_issues_severity_check CHECK (severity BETWEEN 1 AND 3);

-- ─────────────────────────────────────────────────────────────
-- 3. Indexes — every column the dashboard card filters or sorts on
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cs_issues_contact_phone   ON public.cs_issues (contact_phone);
CREATE INDEX IF NOT EXISTS idx_cs_issues_open_severity   ON public.cs_issues (severity DESC, last_reported_at DESC) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS idx_cs_issues_theme_reported  ON public.cs_issues (theme, last_reported_at DESC);
CREATE INDEX IF NOT EXISTS idx_cs_issues_noncustomer     ON public.cs_issues (last_reported_at DESC) WHERE is_customer = false;

-- ─────────────────────────────────────────────────────────────
-- 4. cs_signals — nightly detector output, fingerprint-deduped
--    Same carry-across-runs pattern as reconciliation_findings.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cs_signals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint       text NOT NULL UNIQUE,
  signal_type       text NOT NULL CHECK (signal_type IN (
                      'repeat_contact','noncustomer_complaint','escalation_language',
                      'theme_spike','aging_issue')),
  severity          smallint NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN (
                      'open','acknowledged','suppressed','resolved')),
  contact_phone     text,
  customer_id       uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  issue_id          integer REFERENCES public.cs_issues(id) ON DELETE SET NULL,
  theme             text,
  headline          text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  llm_verdict       jsonb,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  notified_at       timestamptz,
  notified_severity smallint,
  acknowledged_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  acknowledged_at   timestamptz,
  suppressed_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cs_signals IS
  'Output of the nightly cs-signal-scan. One row per distinct finding, keyed by fingerprint and carried across runs so a known signal does not re-alarm nightly. Suppression is sticky unless severity rises. Session 291.';
COMMENT ON COLUMN public.cs_signals.llm_verdict IS
  'Classification only. The model may never close an issue, notify anyone, or send a message.';

CREATE INDEX IF NOT EXISTS idx_cs_signals_open      ON public.cs_signals (severity DESC, last_seen_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_cs_signals_phone     ON public.cs_signals (contact_phone);
CREATE INDEX IF NOT EXISTS idx_cs_signals_issue     ON public.cs_signals (issue_id);
CREATE INDEX IF NOT EXISTS idx_cs_signals_type_seen ON public.cs_signals (signal_type, last_seen_at DESC);

-- Data API exposure (session 162 rule): explicit grants, no reliance on
-- default ACLs. Staff-only table — anon is deliberately NOT granted.
ALTER TABLE public.cs_signals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cs_signals TO authenticated;
GRANT ALL ON public.cs_signals TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5. RLS — the CS team must be able to see this, not only the 2 admins
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_cs_team()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin','manager','attendant')
  );
$fn$;

REVOKE EXECUTE ON FUNCTION public.is_cs_team() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_cs_team() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_cs_team() TO authenticated, service_role;

DROP POLICY IF EXISTS cs_signals_cs_team ON public.cs_signals;
CREATE POLICY cs_signals_cs_team ON public.cs_signals
  FOR ALL TO authenticated
  USING (public.is_cs_team()) WITH CHECK (public.is_cs_team());

-- cs_issues today is admin-only (policy admin_all_cs_issues, is_admin()), which
-- means exactly 2 of 30 staff can see it. That is part of why the tool went
-- unused. Widen to the CS team; the admin policy is left in place untouched.
DROP POLICY IF EXISTS cs_issues_cs_team ON public.cs_issues;
CREATE POLICY cs_issues_cs_team ON public.cs_issues
  FOR ALL TO authenticated
  USING (public.is_cs_team()) WITH CHECK (public.is_cs_team());

DROP POLICY IF EXISTS cs_issue_comments_cs_team ON public.cs_issue_comments;
CREATE POLICY cs_issue_comments_cs_team ON public.cs_issue_comments
  FOR ALL TO authenticated
  USING (public.is_cs_team()) WITH CHECK (public.is_cs_team());

COMMIT;
