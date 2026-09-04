-- ═══════════════════════════════════════════════════════════════════════════
-- session 273 cont. — A VOID THAT A PLAIN UPDATE CAN LIFT IS NOT A VOID
-- ═══════════════════════════════════════════════════════════════════════════
-- enforce_split_invariant already refuses to void a split that has reached Xero
-- (session 232). It guarded one direction only. Nothing guarded the reverse:
--
--   Funding Circle 2026-08 (loan_splits 3daf1dc1-019b-4144-827d-fbfed9c396b6)
--   was voided on 2026-08-25 with a three-sentence reason, and then on
--   2026-08-31 an ordinary "mark as already handled in Xero" update moved its
--   status to already_in_xero. voided_at, voided_by and void_reason stayed on
--   the row. It read as voided AND handled at the same time, and its $1,025.71
--   went on being counted in the loan's variance for a week.
--
-- One row in the whole book was in that state, so this is an edge case and not
-- a widespread pattern -- but it is the edge case that cost a week of hunting a
-- $980.93 gap, and the reason it survived is that the two fields recording the
-- same fact were only ever kept in step by convention.
--
-- This makes them agree by construction: voided_at is set exactly when the
-- status is 'voided', in both directions, on INSERT and UPDATE.
--
-- UN-VOIDING IS STILL ALLOWED. It just has to say so. Clearing voided_at,
-- voided_by and void_reason in the same statement reinstates a card -- which is
-- a deliberate act that leaves a diff, rather than a side effect of a status
-- change that mentioned nothing about the void.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- session 232: void can never reach into Xero. Two conditions, not one -- a split
  -- can carry a real Xero journal while its status says otherwise (Funding Circle
  -- 2026-07 sits at pending_review with a journal id right now).
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

  -- ── session 273 cont.: THE VOID STAMP AND THE STATUS ARE ONE FACT ─────────
  -- Checked BEFORE the closed_period/voided early return below, because that
  -- return is exactly what let a half-voided row through untouched.
  IF NEW.voided_at IS NOT NULL AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION
      'loan_splits: this split was voided on % by % -- it cannot be moved to ''%'' while that void stands. To reinstate it, clear voided_at, voided_by and void_reason in the SAME update and record why in review_notes.',
      NEW.voided_at, coalesce(NEW.voided_by, 'unknown'), NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- The mirror. A void with no stamp is a void with no audit trail, and the
  -- reason a card was voided is the most valuable thing about it.
  IF NEW.status = 'voided' AND NEW.voided_at IS NULL THEN
    RAISE EXCEPTION
      'loan_splits: refusing to void this split without a void stamp -- set voided_at, voided_by and void_reason. Use the void_loan_split RPC, which writes all three.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A closed period is settled by the CPA's own adjustment; nothing here reopens it.
  -- session 232: a voided period is terminal for the same reason. Both MUST return
  -- before the invariant check below, which rewrites a failing split's status to
  -- 'needs_attention' and would otherwise quietly resurrect a voided card.
  IF NEW.status IN ('closed_period', 'voided') THEN
    RETURN NEW;
  END IF;

  -- A payment that has not happened cannot have been posted (session 231)
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
