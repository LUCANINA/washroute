-- Session 291c — "Stalled in process" must measure time in OUR BUILDING,
--                not time since the order row was created.
--
-- THE BUG
-- v_outstanding_orders classified an in-process order as stuck_in_process when
-- `created_at < now() - 7 days`. Recurring orders are minted ~14 days ahead of
-- the pickup date by generate_route_runs(14), so that clock starts while the
-- customer's bag is still in their own hallway. On 2026-09-10 the card showed
-- 6 orders; ALL SIX had moved that same day, and 0 had genuinely not moved in
-- 7 days. #12874 displayed "23d" and had been picked up the previous afternoon.
-- 100% false positives, which is why the card was being ignored.
--
-- THE RULE (David, session 291): a real issue is "the customer's laundry has
-- been sitting in the warehouse for more than a week". Anything else resolves
-- itself as the order is processed and does not belong on Overview.
--
-- THE CLOCK
--   delivery orders (customer_app / recurring / scheduled) -> actual_pickup_at,
--     the moment a driver took possession.
--   walk_in orders -> created_at. The customer carried it in, so there is no
--     pickup leg and creation IS arrival. Verified: all 1,962 walk_in orders
--     have actual_pickup_at NULL, and 0 non-walk_in in-process orders do.
--   NULL in_building_since is deliberately NOT flagged (NULL < ts is NULL).
--     Unknown arrival time fails safe: no alarm rather than a false one.
--
-- age_days is UNCHANGED. The Unpaid Orders page uses it for "how long has this
-- money been owed", where age-since-creation is the correct meaning. This adds
-- days_in_building alongside it rather than redefining a column with two callers.
--
-- Additive: two new columns at the END of the view, so CREATE OR REPLACE is legal
-- and existing SELECTs are unaffected.

CREATE OR REPLACE VIEW public.v_outstanding_orders AS
 WITH base AS (
         SELECT o.id, o.order_number, o.status, o.billing_status, o.billing_payment_method,
            o.charge_failed_at, o.billed_at, o.total_amount, o.tip_amount, o.tip_type,
            o.amount_refunded, o.created_at, o.archived_at, o.archived_reason, o.source,
            o.customer_id, o.pickup_window_start, o.delivery_window_start,
            c_1.first_name_cache, c_1.last_name_cache, c_1.phone_cache, c_1.billing_type,
            COALESCE(o.billing_status, ''::text) = 'failed'::text OR o.charge_failed_at IS NOT NULL AS has_failed_charge,
            COALESCE(o.status, ''::text) = ANY (ARRAY['ready_for_delivery'::text, 'out_for_delivery'::text, 'delivered'::text, 'delivery_failed'::text]) AS is_post_wash,
            round(COALESCE(o.total_amount, 0::numeric) +
                CASE
                    WHEN COALESCE(o.tip_amount, 0::numeric) = 0::numeric THEN 0::numeric
                    WHEN o.tip_type = 'pct'::text THEN round(COALESCE(o.total_amount, 0::numeric) * o.tip_amount / 100.0, 2)
                    ELSE o.tip_amount
                END - COALESCE(o.amount_refunded, 0::numeric), 2) AS amount_due,
            -- When the laundry physically entered our possession. See header.
            CASE WHEN COALESCE(o.source, ''::text) = 'walk_in'::text
                 THEN o.created_at
                 ELSE o.actual_pickup_at
            END AS in_building_since
           FROM orders o
             LEFT JOIN customers c_1 ON c_1.id = o.customer_id
          WHERE COALESCE(o.billing_status, ''::text) <> ALL (ARRAY['paid'::text, 'refunded'::text, 'written_off'::text])
        ), classified AS (
         SELECT b.id, b.order_number, b.status, b.billing_status, b.billing_payment_method,
            b.charge_failed_at, b.billed_at, b.total_amount, b.tip_amount, b.tip_type,
            b.amount_refunded, b.created_at, b.archived_at, b.archived_reason, b.source,
            b.customer_id, b.pickup_window_start, b.delivery_window_start,
            b.first_name_cache, b.last_name_cache, b.phone_cache, b.billing_type,
            b.has_failed_charge, b.is_post_wash, b.amount_due, b.in_building_since,
                CASE
                    WHEN b.has_failed_charge AND COALESCE(b.billing_type, ''::text) <> 'on_account'::text THEN 'card_declined'::text
                    WHEN COALESCE(b.billing_type, ''::text) = 'on_account'::text AND (b.has_failed_charge OR b.is_post_wash) THEN 'on_account'::text
                    WHEN b.is_post_wash THEN 'awaiting_payment'::text
                    ELSE 'stuck_in_process'::text
                END AS bucket
           FROM base b
          WHERE b.amount_due > 0::numeric
            AND (
                  b.has_failed_charge
               OR b.is_post_wash
               OR (
                    (COALESCE(b.status, ''::text) = ANY (ARRAY['picked_up'::text, 'processing'::text, 'folding'::text]))
                    -- was: b.created_at < (now() - '7 days')  -- see header
                AND b.in_building_since < (now() - '7 days'::interval)
                  )
            )
        )
 SELECT id, order_number, status, billing_status, billing_payment_method, charge_failed_at,
    billed_at, total_amount, tip_amount, tip_type, amount_refunded, created_at, archived_at,
    archived_reason, source, customer_id, pickup_window_start, delivery_window_start,
    first_name_cache, last_name_cache, phone_cache, billing_type, has_failed_charge,
    is_post_wash, amount_due, bucket,
    bucket <> 'stuck_in_process'::text AND archived_at IS NULL AS counts_as_due,
    archived_at IS NOT NULL AS is_archived,
    COALESCE(billing_type, ''::text) = 'on_account'::text AND has_failed_charge AS on_account_card_error,
    (now() AT TIME ZONE 'America/Los_Angeles'::text)::date - (created_at AT TIME ZONE 'America/Los_Angeles'::text)::date AS age_days,
    -- NEW, appended so CREATE OR REPLACE is legal and no existing caller shifts.
    in_building_since,
    (now() AT TIME ZONE 'America/Los_Angeles'::text)::date - (in_building_since AT TIME ZONE 'America/Los_Angeles'::text)::date AS days_in_building
   FROM classified c;

COMMENT ON VIEW public.v_outstanding_orders IS
  'Single source of truth for what money is owed and why. stuck_in_process measures time since the laundry entered OUR BUILDING (actual_pickup_at, or created_at for walk_ins) -- NOT since the order row was created, which for recurring orders begins ~14 days before pickup. Session 291c.';
