-- session_260_payout_retry_state.sql
--
-- WHY. On 2026-08-27 and 2026-09-02 a Stripe payout webhook fired while Xero's
-- accounting API was at its 1,000/day cap. xero-payout-sync's pre-check (the
-- session-241 "ask Xero before posting" guard) got a 429, correctly refused to
-- post blind, and marked the row 'failed'. Nothing retried it and nothing told
-- anyone: the row sat in a table no screen reads. The Wells Fargo feed line
-- arrives the NEXT morning, so by the time a human sees the unreconciled line
-- there is no Xero transaction to match, and Xero's "suggest previous entries"
-- offers the prior payout's coding collapsed to a single line. That is exactly
-- how $7,813.03 landed entirely in 405 Delivery - Subscription Fees.
--
-- WHAT. Three columns so a retry can tell a TRANSIENT refusal (nothing reached
-- Xero; safe to re-run, because the pre-check makes a re-run idempotent) from a
-- PERMANENT one (unclassified transactions, Xero validation) that genuinely
-- needs a human. The watchdog's standing rule -- it "deliberately does NOT retry
-- automatically" -- is preserved for everything except the transient class.
--
-- No backfill: both historical failures were repaired to 'posted' in session 260
-- before this ran, so there are no 'failed' rows to classify.

ALTER TABLE public.xero_payout_syncs
  ADD COLUMN IF NOT EXISTS failure_kind  text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

-- A new value must fail SAFE: anything not explicitly 'transient' is never
-- auto-retried, so an unrecognised kind waits for a human rather than looping.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'xero_payout_syncs_failure_kind_chk'
  ) THEN
    ALTER TABLE public.xero_payout_syncs
      ADD CONSTRAINT xero_payout_syncs_failure_kind_chk
      CHECK (failure_kind IS NULL OR failure_kind IN ('transient','permanent','unknown'));
  END IF;
END $$;

-- The retry sweep's only query: failed + transient + due.
CREATE INDEX IF NOT EXISTS xero_payout_syncs_retry_due_idx
  ON public.xero_payout_syncs (next_retry_at)
  WHERE status = 'failed' AND failure_kind = 'transient';

COMMENT ON COLUMN public.xero_payout_syncs.failure_kind IS
  'transient = nothing reached Xero (429/network on the pre-check), safe to auto-retry. permanent = needs a human. unknown = stranded pending, state genuinely unknown. NULL when not failed.';
COMMENT ON COLUMN public.xero_payout_syncs.attempt_count IS
  'Automatic post attempts made for this payout. Caps the retry sweep.';
COMMENT ON COLUMN public.xero_payout_syncs.next_retry_at IS
  'Earliest time the retry sweep may re-attempt. NULL = not scheduled for retry.';
