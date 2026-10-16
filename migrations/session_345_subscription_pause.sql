-- Session 345 — Oct 15, 2026: subscription Pause (one month, customer self-serve)
--
-- What David decided: a customer can pause for ONE billing month. The pause starts when the
-- month they already paid for ends, they are not charged at that renewal, and the plan restarts
-- automatically one month later (same renewal day). While paused they can still order, at
-- pay-per-bag prices; their repeating pickup is skipped for the pause weeks.
--
-- This migration only adds state + one guard. The work happens in edge functions:
--   pause-subscription  (schedule / undo)   and   subscription-pause-tick  (start, end, reminder)
--
-- 1) subscriptions: pause window + bookkeeping
-- 2) subscription_usage_log: allow the pause event types (CLAUDE.md: new enum value → CHECK)
-- 3) link_subscription_on_order_fn: an order CREATED during a pause is never linked to the plan
--    later. Without this, a per-bag order picked up on the last pause day and updated after the
--    plan restarts would be linked on that UPDATE, lose its delivery fee and eat plan pounds.
--    Rewritten from the live definition (session-227 method), needle asserted, snapshot kept.

-- 0) Snapshot (rollback source)
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_session_345 AS
SELECT 'link_subscription_on_order_fn'::text AS proname,
       pg_get_functiondef('public.link_subscription_on_order_fn'::regproc) AS def,
       now() AS snapshot_at;

-- 1) Columns (nullable, no defaults → instant, no rewrite)
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS pause_starts_at        timestamptz,
  ADD COLUMN IF NOT EXISTS pause_ends_at          timestamptz,
  ADD COLUMN IF NOT EXISTS pause_requested_at     timestamptz,
  ADD COLUMN IF NOT EXISTS pause_reminder_sent_at timestamptz;

COMMENT ON COLUMN public.subscriptions.pause_starts_at IS
  'Session 345: start of the (latest) one-month pause = end of the paid period it was requested in. Kept after the pause ends as history; status says whether it is current.';
COMMENT ON COLUMN public.subscriptions.pause_ends_at IS
  'Session 345: when the plan restarts and Stripe charges again (one billing month after pause_starts_at).';

-- 2) Usage-log event types
ALTER TABLE public.subscription_usage_log DROP CONSTRAINT subscription_usage_log_event_type_check;
ALTER TABLE public.subscription_usage_log ADD CONSTRAINT subscription_usage_log_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'pickup_weighed','pickup_counted','overage_calculated','overage_charged','overage_invoiced',
    'final_overage_invoiced','period_reset','manual_adjustment','order_ready','order_delivered',
    'pause_scheduled','pause_cancelled','pause_started','pause_ended'
  ]::text[]));

-- 3) Guard in the order→plan linker
DO $m$
DECLARE
  v_def text := pg_get_functiondef('public.link_subscription_on_order_fn'::regproc);
  -- needle B: a NEW order never joins a paused plan, whoever creates it (customer app,
  -- admin, POS, Maya all pass subscription_id straight through create_order_for_customer).
  v_b_old text := $n$
  IF NEW.subscription_id IS NULL AND NEW.customer_id IS NOT NULL AND NOT v_settled THEN
$n$;
  v_b_new text := $n$
  -- Session 345: a NEW order never joins a paused plan.
  IF TG_OP = 'INSERT' AND NEW.subscription_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM subscriptions ps WHERE ps.id = NEW.subscription_id AND ps.status = 'paused') THEN
    NEW.subscription_id := NULL;
  END IF;

  IF NEW.subscription_id IS NULL AND NEW.customer_id IS NOT NULL AND NOT v_settled THEN
$n$;
  v_old text := $n$    IF v_pricelist = 'Subscription' THEN$n$;
  v_new text := $n$    -- Session 345: an order created during a pause stays pay-per-bag for life.
    IF v_pricelist = 'Subscription' AND NOT EXISTS (
         SELECT 1 FROM subscriptions ps
          WHERE ps.customer_id = NEW.customer_id
            AND ps.pause_starts_at IS NOT NULL
            AND COALESCE(NEW.created_at, now()) >= ps.pause_starts_at
            AND COALESCE(NEW.created_at, now()) <  ps.pause_ends_at) THEN$n$;
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'link fn needle not found exactly once';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_b_old, ''))) / length(v_b_old) <> 1 THEN
    RAISE EXCEPTION 'link fn needle B not found exactly once';
  END IF;
  EXECUTE replace(replace(v_def, v_old, v_new), v_b_old, v_b_new);
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.link_subscription_on_order_fn'::regproc),
            'Session 345: an order created during a pause') = 0
     OR strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.link_subscription_on_order_fn'::regproc),
            'Session 345: a NEW order never joins a paused plan.') = 0 THEN
    RAISE EXCEPTION 'link fn rewrite did not take';
  END IF;
END
$m$;

-- Rollback:
-- DO $r$ BEGIN EXECUTE (SELECT def FROM _archive.fn_snapshot_session_345 WHERE proname = 'link_subscription_on_order_fn'); END $r$;
-- ALTER TABLE public.subscriptions DROP COLUMN pause_starts_at, DROP COLUMN pause_ends_at,
--   DROP COLUMN pause_requested_at, DROP COLUMN pause_reminder_sent_at;
-- (restore the old CHECK list without the four pause_* values)
