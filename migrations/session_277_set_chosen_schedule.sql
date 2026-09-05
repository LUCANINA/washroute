-- session 277 (2026-09-05) — public.set_loan_chosen_schedule
--
-- The answer half of David's rule. An ask with no way to answer it is a nag, and the
-- rule itself says a nag is the failure mode this module keeps re-fixing — so the
-- question in the Action field and this function ship together.
--
-- THE CPA IS THE INTENDED DECIDER (David's choice): the person who reads schedules
-- and Xero and can say which projection matches the drafts the lender actually takes.
-- So 'cpa' is allowed here, which is DELIBERATELY WIDER than the module's other
-- writes (void_loan_split, loan-xero-post: admin/manager only) and safe for one
-- specific reason: this function writes NOTHING to Xero and moves no money. It
-- records which of two documents already on file this loan follows. The CPA having
-- read-only access to posting and decision rights over evidence is the shape David
-- described — the tool making their job faster, not replacing them.
--
-- A REASON IS REQUIRED. A decision with no reason cannot be reviewed, and the next
-- person to look will re-ask — which turns a settled question back into a nag. Same
-- standard as void_loan_split's p_reason and the unmark mode's reason.
--
-- IT REFUSES A SCHEDULE THAT IS NOT A CANDIDATE. Choosing a schedule belonging to
-- another loan, or one with no payment rows, would record a decision that resolves
-- nothing while reading as settled — worse than the tie-break it replaces.
--
-- Passing NULL for p_schedule_id CLEARS the decision (and its provenance, in the same
-- statement — session 273's lesson that a stamp and its status are ONE fact, and a
-- decision a plain update can half-lift is not a decision).

CREATE OR REPLACE FUNCTION public.set_loan_chosen_schedule(
  p_loan_account_id uuid,
  p_schedule_id     uuid,
  p_reason          text DEFAULT NULL,
  p_actor           text DEFAULT NULL
)
RETURNS public.loan_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_role  text;
  v_who   text := nullif(btrim(coalesce(p_actor, '')), '');
  v_loan  public.loan_accounts;
  v_rows  int;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
    IF v_role IS NULL OR v_role NOT IN ('admin', 'manager', 'cpa') THEN
      RAISE EXCEPTION 'set_loan_chosen_schedule: requires admin, manager or cpa (role: %).', coalesce(v_role, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO v_loan FROM public.loan_accounts WHERE id = p_loan_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_loan_chosen_schedule: no loan with id %.', p_loan_account_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Clearing the decision: the pointer and its provenance go together or not at all.
  IF p_schedule_id IS NULL THEN
    UPDATE public.loan_accounts SET
      chosen_schedule_id = NULL, chosen_schedule_reason = NULL,
      chosen_schedule_set_at = NULL, chosen_schedule_set_by = NULL
    WHERE id = p_loan_account_id
    RETURNING * INTO v_loan;
    RETURN v_loan;
  END IF;

  IF v_who IS NULL THEN
    RAISE EXCEPTION 'set_loan_chosen_schedule: p_actor is required -- a recorded decision must say who made it.'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'set_loan_chosen_schedule: p_reason is required -- a decision with no reason cannot be reviewed, and the next person will re-ask.'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- The schedule must belong to THIS loan and actually carry payment rows. A
  -- decision that resolves nothing while reading as settled is worse than the
  -- tie-break it replaces.
  SELECT count(*) INTO v_rows
  FROM public.loan_amortization_rows r
  JOIN public.loan_amortization_schedules s ON s.id = r.schedule_id
  WHERE s.id = p_schedule_id
    AND s.loan_account_id = p_loan_account_id
    AND r.row_type = 'payment'
    AND r.balance IS NOT NULL;

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'set_loan_chosen_schedule: schedule % is not a usable schedule for this loan (wrong loan, or no payment rows with balances).', p_schedule_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.loan_accounts SET
    chosen_schedule_id     = p_schedule_id,
    chosen_schedule_reason = btrim(p_reason),
    chosen_schedule_set_at = now(),
    chosen_schedule_set_by = v_who
  WHERE id = p_loan_account_id
  RETURNING * INTO v_loan;

  RETURN v_loan;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.set_loan_chosen_schedule(uuid, uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_loan_chosen_schedule(uuid, uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_loan_chosen_schedule(uuid, uuid, text, text) TO authenticated, service_role;
