-- session_230_split_invariant  (applied 2026-08-24 via apply_migration)
--
-- THE SPLIT INVARIANT, enforced in the database rather than in each writer.
-- loan_splits has five writers (loan-ingest-statement x4 paths,
-- loan-generate-schedule-split, _shared/staging-next, xero-payout-sync, hand SQL);
-- a rule implemented in each is a rule the sixth writer skips. Same placement
-- decision as trg_enforce_protected_customer_columns.
--
-- WHY: statement_delta computes interest = total_due - (prior_balance - balance),
-- which holds only if exactly one scheduled payment fell between the two statements.
-- An extra principal payment inside the window pushes the excess into interest as a
-- NEGATIVE number. Nothing rejected it, so it posted. Found live (both in Xero):
--   E-Transit Loan E5-4751  2026-06  principal 3,862.49  interest -2,815.54
--   E-Transit Loan E6-7410  2026-06  principal 1,385.79  interest   -742.29
--
-- NOT violations (verified against all 687 splits before shipping: 681 pass):
--   net-zero RECLASSIFICATION (total 0, principal = -interest) -- Rapid's fee rows;
--   DRAW (total < 0, all principal) -- Funding Circle 2025-04-18, -46,843.84.
-- The rule is therefore stated on the TOTAL, never on the signs.
--
-- Callers: trg_enforce_split_invariant (below) and loan-xero-post v48, which calls
-- split_invariant_check() by RPC BEFORE any Xero write -- so the trigger's refusal
-- can never strand a real journal in Xero with no row to record it.
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_enforce_split_invariant ON public.loan_splits;
--   DROP FUNCTION IF EXISTS public.enforce_split_invariant();
--   DROP FUNCTION IF EXISTS public.split_invariant_check(numeric,numeric,numeric);
--
-- The authoritative bodies as applied are reproduced below verbatim from
-- pg_get_functiondef().

CREATE OR REPLACE FUNCTION public.split_invariant_check(p_principal numeric, p_interest numeric, p_total numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  eps  numeric := 0.01;
BEGIN
  IF p_total IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'total_missing', 'shape', 'invalid',
      'note', 'This split has no total amount, so its principal/interest breakdown cannot be checked.');
  END IF;

  -- A missing component is not a violation on its own: some lenders report a balance
  -- delta before the total due is known, and the caller stores NULL deliberately.
  IF p_principal IS NULL OR p_interest IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'code', null,
      'shape', CASE WHEN p_total > eps THEN 'payment' ELSE 'reclassification' END, 'note', '');
  END IF;

  IF abs(p_principal + p_interest - p_total) > eps THEN
    RETURN jsonb_build_object('ok', false, 'code', 'components_do_not_sum', 'shape', 'invalid',
      'note', format('Principal $%s plus interest $%s is $%s, which does not equal the total $%s. Somebody has to say which of the three figures is right before this can be booked.',
        to_char(p_principal,'FM999,999,990.00'), to_char(p_interest,'FM999,999,990.00'),
        to_char(p_principal + p_interest,'FM999,999,990.00'), to_char(p_total,'FM999,999,990.00')));
  END IF;

  -- A draw: we borrowed more, so the balance went UP. All principal by definition --
  -- you do not pay interest by borrowing.
  IF p_total < -eps THEN
    IF abs(p_interest) <= eps AND abs(p_principal - p_total) <= eps THEN
      RETURN jsonb_build_object('ok', true, 'code', null, 'shape', 'draw', 'note', '');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'malformed_draw', 'shape', 'invalid',
      'note', format('This split total of $%s reads as a draw -- money borrowed, not repaid. A draw is all principal with no interest, but this one shows principal $%s and interest $%s. Confirm what this transaction was before booking it.',
        to_char(p_total,'FM999,999,990.00'), to_char(p_principal,'FM999,999,990.00'), to_char(p_interest,'FM999,999,990.00')));
  END IF;

  -- Net-zero reclassification.
  IF abs(p_total) <= eps THEN
    RETURN jsonb_build_object('ok', true, 'code', null, 'shape', 'reclassification', 'note', '');
  END IF;

  -- A real cash payment: both components must live inside it.
  IF p_interest < -eps THEN
    RETURN jsonb_build_object('ok', false, 'code', 'negative_interest', 'shape', 'invalid',
      'note', format('This period''s interest works out to -$%s, which is impossible -- interest cannot be negative. The balance fell $%s but the payment was only $%s, so $%s of principal came from somewhere else, almost always an extra principal payment made inside this period. Book that extra payment as its own entry and this period will compute correctly.',
        to_char(abs(p_interest),'FM999,999,990.00'), to_char(p_principal,'FM999,999,990.00'),
        to_char(p_total,'FM999,999,990.00'), to_char(p_principal - p_total,'FM999,999,990.00')));
  END IF;

  IF p_principal < -eps THEN
    RETURN jsonb_build_object('ok', false, 'code', 'negative_principal', 'shape', 'invalid',
      'note', format('This period''s principal works out to -$%s, which is impossible on a $%s payment. The balance fell less than the payment covers, which usually means interest was capitalised, or a payment was missed, deferred or only partly made. Confirm what actually happened before booking it.',
        to_char(abs(p_principal),'FM999,999,990.00'), to_char(p_total,'FM999,999,990.00')));
  END IF;

  IF p_interest > p_total + eps THEN
    RETURN jsonb_build_object('ok', false, 'code', 'interest_exceeds_total', 'shape', 'invalid',
      'note', format('Interest of $%s is more than the whole $%s payment. Confirm what happened in this period before booking it.',
        to_char(p_interest,'FM999,999,990.00'), to_char(p_total,'FM999,999,990.00')));
  END IF;

  IF p_principal > p_total + eps THEN
    RETURN jsonb_build_object('ok', false, 'code', 'principal_exceeds_total', 'shape', 'invalid',
      'note', format('Principal of $%s is more than the whole $%s payment. That usually means an extra principal payment landed inside this period and needs to be booked as its own entry.',
        to_char(p_principal,'FM999,999,990.00'), to_char(p_total,'FM999,999,990.00')));
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', null, 'shape', 'payment', 'note', '');
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.split_invariant_check(numeric, numeric, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.split_invariant_check(numeric, numeric, numeric) FROM anon;
GRANT  EXECUTE ON FUNCTION public.split_invariant_check(numeric, numeric, numeric) TO authenticated, service_role;

-- Two asymmetric jobs:
--   * a NON-booked status carrying an impossible shape is REWRITTEN to
--     needs_attention with the explanation appended -- the numbers are evidence.
--   * a BOOKED status (posted/staged/already_in_xero) carrying an impossible shape
--     is REFUSED, but only when this statement introduces it (INSERT, status change,
--     or amount change). An unrelated UPDATE to a legacy invalid row -- a sweep
--     timestamp, an attached document -- passes through untouched, because blocking
--     those would wedge the sweep and rewriting them would un-post real history.
CREATE OR REPLACE FUNCTION public.enforce_split_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v       jsonb;
  v_note  text;
  v_introduced boolean;
BEGIN
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

DROP TRIGGER IF EXISTS trg_enforce_split_invariant ON public.loan_splits;
CREATE TRIGGER trg_enforce_split_invariant
  BEFORE INSERT OR UPDATE ON public.loan_splits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_split_invariant();
