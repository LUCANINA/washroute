-- session_326 — record WHERE an order was physically processed.
-- APPLIED 2026-10-01 via apply_migration (same name)
--
-- WHY: when a bag comes back with a major stain there is currently no way to tell
-- which facility handled it. orders.site_id looks like the answer but is not: it is
-- written once at creation from the customer's default_site_id and never updated,
-- so it means "the customer's home site". order_events has no site column, racks are
-- named by ROUTE (Alameda, Berkeley, Hayward, Oakland, San Francisco) not facility,
-- and neither launderers nor profiles carry a site. The place is simply not recorded.
--
-- Evidence it already bites: order #16064 was rung up on the Foothill POS device by a
-- 23rd Ave customer, and the chip said "23rd Ave".
--
-- WHAT THIS ADDS: one nullable column, stamped at intake (the first moment the bag is
-- physically at a facility). NULL means "not recorded" and is rendered as such — it is
-- never silently shown as the customer's home site. Every pre-existing row stays NULL
-- on purpose: we cannot honestly backfill a site we never captured.
--
-- NOT INDEXED, deliberately: there are two sites, so a btree is near-useless for
-- selectivity and would only add write cost on a hot table.
--
-- PROTECTED COLUMN: added to enforce_protected_order_columns' deny-list in the SAME
-- migration. That trigger is a deny-list, so a new column is writable by any customer
-- until listed — and this is a provenance field a customer must not be able to rewrite.
--
-- VERIFIED after apply: PostgREST serves the column (GET .../orders?select=processed_site_id
-- returned 200, while a deliberately bogus column returned 42703, proving the check
-- can actually detect a miss). This matters because of the session 176/177 incident,
-- where a same-push column + code deploy silently broke all charging for ~15 hours.
--
-- ROLLBACK:
--   ALTER TABLE public.orders DROP COLUMN processed_site_id;
--   (and remove 'processed_site_id' from enforce_protected_order_columns)

ALTER TABLE public.orders
  ADD COLUMN processed_site_id uuid REFERENCES public.sites(id);

COMMENT ON COLUMN public.orders.processed_site_id IS
  'The facility that physically processed this order, stamped at intake. NULL = not recorded. Distinct from site_id, which is the customer''s home site and is set once at creation.';

DO $do$
DECLARE
  v_def    text;
  v_n      int;
  v_anchor text := $a$    'overage_invoiced_at',$a$;
  v_repl   text := $g$    'overage_invoiced_at',
    'processed_site_id',$g$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'enforce_protected_order_columns';

  IF v_def IS NULL THEN RAISE EXCEPTION 'enforce_protected_order_columns not found'; END IF;
  IF strpos(v_def, 'processed_site_id') <> 0 THEN
    RAISE EXCEPTION 'already protected — refusing to double-patch';
  END IF;

  v_n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor matched % times, expected exactly 1', v_n; END IF;

  EXECUTE replace(v_def, v_anchor, v_repl);
END
$do$;

DO $do$
BEGIN
  IF (SELECT strpos(prosrc, 'processed_site_id') FROM pg_proc
      WHERE pronamespace='public'::regnamespace
        AND proname='enforce_protected_order_columns') = 0 THEN
    RAISE EXCEPTION 'protected-column rewrite did not land — rolling back';
  END IF;
  IF (SELECT strpos(prosrc, 'total_amount') FROM pg_proc
      WHERE pronamespace='public'::regnamespace
        AND proname='enforce_protected_order_columns') = 0 THEN
    RAISE EXCEPTION 'existing protected columns lost — rolling back';
  END IF;
END
$do$;
