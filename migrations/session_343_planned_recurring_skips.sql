-- Session 343 — Planned skips for repeating orders ("skip Oct 22, I'm out of town").
-- APPLIED 2026-10-10 by David via SQL Editor. Verified: table + RLS + grants (no anon), generator rewritten, REST sees table; rollback test on #17017 skipped Thu Oct 22 → next Thu Oct 29.
-- Reviewed with washroute-migration-review: clear to apply. Reversible (see bottom).
--
-- Problem: only an order that already exists can be skipped, and a repeating series only
-- ever has ONE future order (the next one is created when the current one is delivered or
-- skipped). So a customer asking to skip a week two+ weeks out could not be helped.
--
-- Fix:
--   1) public.recurring_skip_dates — staff write "skip the occurrence nearest <date>".
--   2) trg_create_recurring_order_fn — when it builds the next order, it jumps over any
--      planned date (weekly ±3 days, biweekly ±6, monthly ±13 — i.e. the occurrence
--      nearest the date) and logs a 'planned_skip' event on the order it creates.
--      No skipped order row is created, so no text goes out and the "2 skips in a row
--      ends the series" rule is not tripped by a planned week off.
-- The function is rewritten from its live definition (session-227 method), not retyped.

-- 0) Snapshot the live function (rollback source)
CREATE TABLE IF NOT EXISTS _archive.fn_snapshot_session_343 AS
SELECT 'trg_create_recurring_order_fn'::text AS proname,
       pg_get_functiondef('public.trg_create_recurring_order_fn'::regproc) AS def,
       now() AS snapshot_at;

-- 1) Table
CREATE TABLE IF NOT EXISTS public.recurring_skip_dates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  pickup_address_id uuid REFERENCES public.addresses(id) ON DELETE SET NULL,
  skip_date         date NOT NULL,
  note              text,
  created_by        uuid DEFAULT auth.uid(),
  created_by_name   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  used_at           timestamptz,
  used_by_order_id  uuid REFERENCES public.orders(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS recurring_skip_dates_pending_uq
  ON public.recurring_skip_dates (customer_id, skip_date, pickup_address_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS recurring_skip_dates_customer_idx
  ON public.recurring_skip_dates (customer_id) WHERE used_at IS NULL;

ALTER TABLE public.recurring_skip_dates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recurring_skip_dates FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_skip_dates TO authenticated, service_role;
DROP POLICY IF EXISTS admin_all_recurring_skip_dates ON public.recurring_skip_dates;
CREATE POLICY admin_all_recurring_skip_dates ON public.recurring_skip_dates
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 2) Rewrite the generator from its live definition
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.trg_create_recurring_order_fn'::regproc);
  v_a_old text := $a$  v_extra_item JSONB;
BEGIN
$a$;
  v_a_new text := $a$  v_extra_item JSONB;
  v_skip_tol      INTEGER;
  v_skip_guard    INTEGER := 0;
  v_skipped_dates DATE[]  := '{}';
  v_new_order_id  UUID;
BEGIN
$a$;
  v_b_old text := $b$  v_next_anchor       := v_next_pickup_start;
$b$;
  v_b_new text := $b$  v_next_anchor       := v_next_pickup_start;

  -- Session 343: planned skips. Jump over the occurrence nearest any date staff marked
  -- as skipped (half an interval either side, so one planned date = one occurrence).
  v_skip_tol := CASE NEW.recurring_interval WHEN 'weekly' THEN 3 WHEN 'biweekly' THEN 6 ELSE 13 END;
  LOOP
    EXIT WHEN v_skip_guard >= 12;
    UPDATE public.recurring_skip_dates s
       SET used_at = now(), used_by_order_id = NEW.id
     WHERE s.customer_id = NEW.customer_id
       AND (s.pickup_address_id IS NULL OR s.pickup_address_id IS NOT DISTINCT FROM NEW.pickup_address_id)
       AND s.used_at IS NULL
       AND s.skip_date BETWEEN (v_next_anchor AT TIME ZONE 'America/Los_Angeles')::date - v_skip_tol
                           AND (v_next_anchor AT TIME ZONE 'America/Los_Angeles')::date + v_skip_tol;
    EXIT WHEN NOT FOUND;
    v_skipped_dates     := v_skipped_dates || (v_next_anchor AT TIME ZONE 'America/Los_Angeles')::date;
    v_skip_guard        := v_skip_guard + 1;
    v_next_pickup_start := v_next_pickup_start + v_interval;
    v_next_pickup_end   := v_next_pickup_end   + v_interval;
    v_next_anchor       := v_next_pickup_start;
  END LOOP;
$b$;
  v_c_old text := $c$    v_tip_amount, v_tip_type
  );

  RETURN NEW;
$c$;
  v_c_new text := $c$    v_tip_amount, v_tip_type
  ) RETURNING id INTO v_new_order_id;

  IF array_length(v_skipped_dates, 1) > 0 THEN
    INSERT INTO order_events (order_id, event_type, description, actor_name)
    VALUES (v_new_order_id, 'planned_skip',
            'Skipped as planned: ' || (SELECT string_agg(to_char(d, 'Dy Mon FMDD'), ', ' ORDER BY d)
                                         FROM unnest(v_skipped_dates) d),
            'System');
  END IF;

  RETURN NEW;
$c$;
BEGIN
  IF (length(v_def) - length(replace(v_def, v_a_old, ''))) / length(v_a_old) <> 1 THEN RAISE EXCEPTION 'needle A not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, v_b_old, ''))) / length(v_b_old) <> 1 THEN RAISE EXCEPTION 'needle B not found exactly once'; END IF;
  IF (length(v_def) - length(replace(v_def, v_c_old, ''))) / length(v_c_old) <> 1 THEN RAISE EXCEPTION 'needle C not found exactly once'; END IF;
  v_def := replace(v_def, v_a_old, v_a_new);
  v_def := replace(v_def, v_b_old, v_b_new);
  v_def := replace(v_def, v_c_old, v_c_new);
  EXECUTE v_def;
END
$do$;

-- 3) Assert (rolls everything back if it fails)
DO $chk$
DECLARE s text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.trg_create_recurring_order_fn'::regproc);
BEGIN
  IF strpos(s, 'public.recurring_skip_dates') = 0
     OR strpos(s, 'RETURNING id INTO v_new_order_id') = 0
     OR strpos(s, '''planned_skip''') = 0
     OR strpos(s, 'recurring_stopped') = 0 THEN
    RAISE EXCEPTION 'generator rewrite incomplete';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.trg_create_recurring_order_fn'::regproc) THEN
    RAISE EXCEPTION 'generator lost SECURITY DEFINER';
  END IF;
END
$chk$;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK:
-- DO $r$ BEGIN EXECUTE (SELECT def FROM _archive.fn_snapshot_session_343 WHERE proname = 'trg_create_recurring_order_fn'); END $r$;
-- DROP TABLE IF EXISTS public.recurring_skip_dates;
