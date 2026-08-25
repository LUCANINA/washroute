-- session 232 (2026-08-25) — a period that turned out never to exist can be VOIDED
-- ============================================================================
-- WHY
-- BayFirst SBA 2 carried a pending card for period 2026-08. That period's payment
-- actually cleared on 2026-08-03 and was coded in Xero by the CPA; the card was an
-- artifact of a projection dated on the wrong day of the month (fixed in c692d19).
-- Removing its stage was not enough: a pending_review split on a pre-staging loan is,
-- to this app, work waiting to be staged, so the app offered it straight back — and
-- rule 1 of ensureUpcomingSplit ("one active card per loan") meant it also BLOCKED the
-- correct September card from ever appearing. There was no way to say "this period is
-- finished, stop asking".
--
-- WHAT VOID IS, AND IS NOT
-- Void retires work that never happened. It is NOT a way to make a real transaction
-- disappear: a split that reached Xero (posted / staged / already_in_xero) can never be
-- voided — remove the stage or reverse the journal first. Enforced twice, in the RPC and
-- in the trigger, because the trigger is the only thing a raw UPDATE cannot route around.
--
-- KNOWN, DELIBERATE LIMITATION
-- loan_splits carries UNIQUE (loan_account_id, period_label). A voided split keeps its
-- period label, so voiding RETIRES that label for that loan — a second split for the same
-- period cannot be created afterwards. That is why void is reversible: if a period turns
-- out to be real after all, reverse the void (p_voided => false) rather than trying to
-- create a second card for it.
-- ============================================================================

-- ── 1. Audit columns (all nullable, no default, no backfill) ────────────────
ALTER TABLE public.loan_splits
  ADD COLUMN IF NOT EXISTS voided_at   timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by   text,
  ADD COLUMN IF NOT EXISTS void_reason text;

COMMENT ON COLUMN public.loan_splits.void_reason IS
  'Why this period was voided. Required by void_loan_split — a voided card must say why.';

-- ── 2. enforce_split_invariant: 'voided' is terminal, and unreachable from Xero ──
-- Rewritten in full from pg_get_functiondef() as it stood after session 231. The ONLY
-- changes are the two blocks marked "session 232"; everything else is byte-identical.
-- The rollback at the foot of this file restores the prior definition verbatim.
CREATE OR REPLACE FUNCTION public.enforce_split_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v       jsonb;
  v_note  text;
  v_introduced boolean;
  v_row_date date;
BEGIN
  -- ── session 232: void can never reach into Xero ──────────────────────────
  -- A stage is a live transaction sitting in the CPA's books and a posted split is a
  -- journal she has seen. Voiding either would delete the record of something that
  -- really happened, which is the one thing this status must never be able to do.
  -- Two conditions, not one. status is the usual signal, but a split can carry a real
  -- Xero journal while its status says otherwise -- Funding Circle 2026-07 sits at
  -- pending_review with a journal id right now (session 232, cause not yet diagnosed).
  -- Reading only the status would have let void delete the record of a live journal.
  IF NEW.status = 'voided' AND TG_OP = 'UPDATE'
     AND (OLD.status IN ('posted', 'staged', 'already_in_xero', 'closed_period')
          OR OLD.xero_manual_journal_id IS NOT NULL) THEN
    RAISE EXCEPTION
      'loan_splits: refusing to void this split -- it is currently % %. Remove the stage or reverse the journal in Xero first.',
      OLD.status,
      CASE WHEN OLD.xero_manual_journal_id IS NOT NULL
           THEN 'and carries Xero journal ' || OLD.xero_manual_journal_id
           ELSE 'and has reached Xero' END
      USING ERRCODE = 'check_violation';
  END IF;

  -- A closed period is settled by the CPA's own adjustment; nothing here reopens it.
  -- session 232: a voided period is terminal for the same reason — there is no work
  -- left in it to check. Both MUST return before the invariant check further down,
  -- which rewrites a failing split's status to 'needs_attention' and would otherwise
  -- quietly resurrect a voided card the next time anything touched the row.
  IF NEW.status IN ('closed_period', 'voided') THEN
    RETURN NEW;
  END IF;

  -- ── A payment that has not happened cannot have been posted (session 231) ──
  IF NEW.status IN ('posted', 'already_in_xero') AND NEW.amortization_row_id IS NOT NULL THEN
    SELECT r.row_date INTO v_row_date
      FROM public.loan_amortization_rows r
     WHERE r.id = NEW.amortization_row_id;
    IF v_row_date IS NOT NULL AND v_row_date > (CURRENT_DATE + 7) THEN
      v_introduced := TG_OP = 'INSERT'
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.amortization_row_id IS DISTINCT FROM NEW.amortization_row_id;
      IF v_introduced THEN
        RAISE EXCEPTION
          'loan_splits: refusing to record this split as % -- its scheduled payment date (%) is still in the future. A payment that has not happened cannot have been posted.',
          NEW.status, v_row_date
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  v := public.split_invariant_check(NEW.principal_amount, NEW.interest_amount, NEW.total_amount);
  IF (v->>'ok')::boolean THEN
    RETURN NEW;
  END IF;
  v_note := v->>'note';

  IF NEW.status IN ('posted', 'staged', 'already_in_xero') THEN
    v_introduced := TG_OP = 'INSERT'
      OR OLD.status IS DISTINCT FROM NEW.status
      OR OLD.principal_amount IS DISTINCT FROM NEW.principal_amount
      OR OLD.interest_amount  IS DISTINCT FROM NEW.interest_amount
      OR OLD.total_amount     IS DISTINCT FROM NEW.total_amount;
    IF v_introduced THEN
      RAISE EXCEPTION 'loan_splits: refusing to record this split as %. %', NEW.status, v_note
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;   -- legacy invalid row, unrelated update
  END IF;

  NEW.status := 'needs_attention';
  IF NEW.review_notes IS NULL OR position(v_note IN NEW.review_notes) = 0 THEN
    NEW.review_notes := btrim(coalesce(NEW.review_notes || ' ', '') || v_note);
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3. The only sanctioned way to void (or un-void) a split ─────────────────
-- Mirrors mark_loan_flag_resolved: a required boolean, never a raw UPDATE, so the
-- audit stamps and the guards can never be skipped by a caller in a hurry.
-- NOTE: p_voided is REQUIRED and has no default, deliberately — the same shape that
-- caught a caller out in session 219. Pass it explicitly.
CREATE OR REPLACE FUNCTION public.void_loan_split(
  p_split_id uuid,
  p_voided   boolean,
  p_reason   text DEFAULT NULL,
  p_actor    text DEFAULT NULL
)
RETURNS public.loan_splits
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_role  text;
  v_split public.loan_splits;
  v_when  text := to_char(now() AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD');
  v_who   text := nullif(btrim(coalesce(p_actor, '')), '');
BEGIN
  IF p_voided IS NULL THEN
    RAISE EXCEPTION 'void_loan_split: p_voided is required (true to void, false to restore).'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Writing is admin/manager, same contract as every other write in this module.
  -- service_role is trusted so edge functions can call this directly (session 219 pattern).
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role IS NULL OR v_role NOT IN ('admin', 'manager') THEN
      RAISE EXCEPTION 'void_loan_split: requires admin or manager (role: %).', coalesce(v_role, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO v_split FROM public.loan_splits WHERE id = p_split_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'void_loan_split: no split with id %.', p_split_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_voided THEN
    IF v_split.status = 'voided' THEN
      RETURN v_split;                      -- idempotent: a retry is a no-op, never an error
    END IF;
    IF v_split.status IN ('posted', 'staged', 'already_in_xero', 'closed_period')
       OR v_split.xero_manual_journal_id IS NOT NULL THEN
      RAISE EXCEPTION
        'void_loan_split: this split is % and has reached Xero%. Remove the stage or reverse the journal in Xero first.',
        v_split.status,
        CASE WHEN v_split.xero_manual_journal_id IS NOT NULL
             THEN ' (journal ' || v_split.xero_manual_journal_id || ')' ELSE '' END
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_who IS NULL THEN
      RAISE EXCEPTION 'void_loan_split: p_actor is required -- a voided card must record who voided it.'
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'void_loan_split: p_reason is required -- a voided card must say why.'
        USING ERRCODE = 'null_value_not_allowed';
    END IF;

    UPDATE public.loan_splits SET
      status       = 'voided',
      voided_at    = now(),
      voided_by    = v_who,
      void_reason  = btrim(p_reason),
      review_notes = btrim(coalesce(review_notes || ' -- ', '')
                     || 'Voided ' || v_when || ' by ' || v_who || ': ' || btrim(p_reason))
    WHERE id = p_split_id
    RETURNING * INTO v_split;
  ELSE
    IF v_split.status <> 'voided' THEN
      RETURN v_split;                      -- idempotent in the other direction too
    END IF;

    UPDATE public.loan_splits SET
      status       = 'pending_review',
      voided_at    = NULL,
      voided_by    = NULL,
      void_reason  = NULL,
      review_notes = btrim(coalesce(review_notes || ' -- ', '')
                     || 'Void reversed ' || v_when
                     || coalesce(' by ' || v_who, '') || '; back in review.')
    WHERE id = p_split_id
    RETURNING * INTO v_split;
  END IF;

  RETURN v_split;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.void_loan_split(uuid, boolean, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.void_loan_split(uuid, boolean, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.void_loan_split(uuid, boolean, text, text) TO authenticated, service_role;

-- ── 4. Assert the rewrite landed, or roll the whole migration back ──────────
DO $assert$
DECLARE
  s text;
BEGIN
  SELECT prosrc INTO s FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'enforce_split_invariant';

  IF strpos(s, '''closed_period'', ''voided''') = 0 THEN
    RAISE EXCEPTION 'assert failed: enforce_split_invariant does not treat voided as terminal';
  END IF;
  IF strpos(s, 'refusing to void this split') = 0 THEN
    RAISE EXCEPTION 'assert failed: enforce_split_invariant lost the reached-Xero void guard';
  END IF;
  IF strpos(s, 'OLD.xero_manual_journal_id IS NOT NULL') = 0 THEN
    RAISE EXCEPTION 'assert failed: void guard does not check for a live Xero journal';
  END IF;
  -- the session 231 guards must have survived the rewrite untouched
  IF strpos(s, 'A payment that has not happened cannot have been posted') = 0 THEN
    RAISE EXCEPTION 'assert failed: session 231 future-dated guard was lost';
  END IF;
  IF strpos(s, 'split_invariant_check') = 0 THEN
    RAISE EXCEPTION 'assert failed: the invariant check itself was lost';
  END IF;
END;
$assert$;

-- ============================================================================
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.void_loan_split(uuid, boolean, text, text);
--   ALTER TABLE public.loan_splits
--     DROP COLUMN IF EXISTS voided_at,
--     DROP COLUMN IF EXISTS voided_by,
--     DROP COLUMN IF EXISTS void_reason;
--   -- then restore enforce_split_invariant by re-running section 2 above with the
--   -- two "session 232" blocks deleted. Any row already at status='voided' must be
--   -- moved back to 'pending_review' BEFORE rolling back, or it becomes unreachable.
-- ============================================================================
