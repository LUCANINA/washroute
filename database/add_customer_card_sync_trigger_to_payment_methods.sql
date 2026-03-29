-- Migration: add_customer_card_sync_trigger_to_payment_methods
-- Applied: 2026-03-29
-- Purpose: Keep customer_payment_methods in sync with customers.stripe_default_payment_method_id.
-- Previously, code paths that updated customers directly (older Stripe webhook handlers, admin
-- manual updates) would set stripe_default_payment_method_id but never insert into
-- customer_payment_methods. The dashboard's _custWithCard set reads from customer_payment_methods,
-- so those customers showed a false "no card on file" warning. Discovered with Level Up Wellness
-- #522 and Jon Relyea (both manually backfilled).
--
-- Rollback:
--   DROP TRIGGER IF EXISTS trg_sync_customer_card_to_payment_methods ON customers;
--   DROP FUNCTION IF EXISTS sync_customer_card_to_payment_methods();
--   ALTER TABLE customer_payment_methods DROP CONSTRAINT IF EXISTS uq_customer_payment_method;

-- ── Step 1: Unique constraint (enables safe upsert) ──────────────────────────
ALTER TABLE customer_payment_methods
  ADD CONSTRAINT uq_customer_payment_method
  UNIQUE (customer_id, stripe_payment_method_id);

-- ── Step 2: Sync function ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_customer_card_to_payment_methods()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only act when a payment method is being set or changed
  IF NEW.stripe_default_payment_method_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.stripe_default_payment_method_id IS NOT DISTINCT FROM NEW.stripe_default_payment_method_id
     AND OLD.card_last4 IS NOT DISTINCT FROM NEW.card_last4
     AND OLD.card_exp_month IS NOT DISTINCT FROM NEW.card_exp_month
     AND OLD.card_exp_year IS NOT DISTINCT FROM NEW.card_exp_year THEN
    RETURN NEW; -- nothing card-related changed, skip
  END IF;

  -- Demote any existing default rows for this customer
  UPDATE customer_payment_methods
  SET is_default = false
  WHERE customer_id = NEW.id
    AND stripe_payment_method_id IS DISTINCT FROM NEW.stripe_default_payment_method_id;

  -- Upsert the new default card
  INSERT INTO customer_payment_methods
    (customer_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, is_default)
  VALUES
    (NEW.id, NEW.stripe_default_payment_method_id,
     NEW.card_brand, NEW.card_last4, NEW.card_exp_month, NEW.card_exp_year,
     true)
  ON CONFLICT (customer_id, stripe_payment_method_id) DO UPDATE SET
    card_brand     = EXCLUDED.card_brand,
    card_last4     = EXCLUDED.card_last4,
    card_exp_month = EXCLUDED.card_exp_month,
    card_exp_year  = EXCLUDED.card_exp_year,
    is_default     = true;

  RETURN NEW;
END;
$function$;

-- ── Step 3: Attach trigger ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sync_customer_card_to_payment_methods ON customers;

CREATE TRIGGER trg_sync_customer_card_to_payment_methods
AFTER INSERT OR UPDATE ON customers
FOR EACH ROW
WHEN (NEW.stripe_default_payment_method_id IS NOT NULL)
EXECUTE FUNCTION sync_customer_card_to_payment_methods();
