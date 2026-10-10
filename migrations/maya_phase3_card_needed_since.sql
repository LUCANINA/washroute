-- Maya phase 3 (phone booking) — "collect card" hold for customers who book by phone with no card.
-- 2026-10-09. Design: docs/washroute/DESIGN-AI-PHONE-ASSISTANT.md
--
-- card_needed_since: set by the maya edge function (service role) when a customer with NO card on
-- file books by phone. While set AND the customer still has no card, charge-order returns
-- code 'awaiting_card' instead of stamping billing_status='failed' and texting 'payment_failed';
-- the rack shows "Call customer for card". Once a card exists, charge-order ignores the flag and
-- charges normally (the autocharge sweep already skips cardless customers, so no new retry logic).
--
-- Not read/written by any existing code. Added to the protected-columns deny-list so a customer
-- session can't set/clear it (staff + service role still can).

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS card_needed_since timestamptz;
COMMENT ON COLUMN public.customers.card_needed_since IS
  'Phone (Maya) booking with no card on file: charge-order holds instead of failing; staff call for a card. Null = normal.';

-- Snapshot the trigger function first (rollback source), then add the column to v_protected.
CREATE TABLE IF NOT EXISTS _archive._fn_snapshots (taken_at timestamptz DEFAULT now(), proname text, def text);
INSERT INTO _archive._fn_snapshots (proname, def)
  SELECT 'enforce_protected_customer_columns', pg_get_functiondef('public.enforce_protected_customer_columns'::regproc);

DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.enforce_protected_customer_columns'::regproc);
  v_old text := $o$'invoice_to_email','invoice_cc_emails','invoice_subject_template','invoice_body_template'
  ];$o$;
  v_new text := $n$'invoice_to_email','invoice_cc_emails','invoice_subject_template','invoice_body_template',
    'card_needed_since'
  ];$n$;
BEGIN
  IF strpos(v_def, 'card_needed_since') > 0 THEN RETURN; END IF;           -- already applied
  IF strpos(v_def, v_old) = 0 THEN RAISE EXCEPTION 'v_protected array not in expected shape'; END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF strpos(pg_get_functiondef('public.enforce_protected_customer_columns'::regproc), $c$'card_needed_since'$c$) = 0 THEN
    RAISE EXCEPTION 'card_needed_since not added to v_protected';
  END IF;
END
$mig$;

/* ROLLBACK
ALTER TABLE public.customers DROP COLUMN IF EXISTS card_needed_since;
-- then restore the function from _archive._fn_snapshots (latest row for enforce_protected_customer_columns):
-- SELECT def FROM _archive._fn_snapshots WHERE proname='enforce_protected_customer_columns' ORDER BY taken_at DESC LIMIT 1;  → EXECUTE it
*/
