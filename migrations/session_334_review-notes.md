# Proposed: guard `record_order_intake` against lowering the total of an already-charged order

**Status: APPLIED 2026-10-06 as `session_334_intake_blocks_downward_reprice_after_charge`.**
Kept as the review record for that migration. Decision taken: **block downward only**.

Reviewed against `washroute-migration-review`. Findings and open questions below — the
decision in "Open question" has to be settled first, because it changes what the code does.

## The bug

Order #14859 (Morgan Connolly), 2026-09-18:

```
18:26:09  Charged $30.00 incl. tip     <- correct: $15 service + $15 tip
18:49:31  Moved back to Intake
18:50:10  Re-intake: Total $15.00 -> $0.00
18:58:14  Racked again; already 'paid', so no re-charge and no refund
```

`record_order_intake` lowered `total_amount` on an order that had already been successfully
charged. Nothing warned, nothing reconciled, no `billing_discrepancy` event was written. The
$15 difference sat on the customer's card.

Session 281 built a guard for exactly this hazard and put it on `opSaveDetails` — the
Billing-details Save path. **Intake Save is a second branch reaching the same write and never
got one.** Session 175 covered the opposite direction on this same path (total raised after a
$0 order was marked paid, so the customer was never charged); the downward direction was
never covered.

## Shape of the change

`CREATE OR REPLACE FUNCTION public.record_order_intake(...)` — 12 args, SECURITY DEFINER,
VOLATILE, body ~3,800 chars.

After the order row is locked and before `total_amount` is written, compute what has
actually been collected and compare:

```sql
-- collected = card charges net of refunds, plus credit actually spent
SELECT COALESCE(SUM(CASE WHEN type IN ('refund','credit_refund') THEN -amount ELSE amount END), 0)
  INTO v_collected
  FROM customer_transactions
 WHERE order_id = p_order_id
   AND type IN ('charge','credit_use','refund','credit_refund');

-- tip is charged ON TOP of total_amount by charge-order, so add it back before comparing
v_tip := CASE WHEN v_order.tip_type = 'pct'
              THEN ROUND(v_order.total_amount * COALESCE(v_order.tip_amount,0) / 100, 2)
              ELSE COALESCE(v_order.tip_amount, 0) END;

IF v_collected > (p_total_amount + v_tip) + 0.01 THEN
   -- already-charged order being re-priced DOWNWARD
END IF;
```

The `+ v_tip` term is not optional. `total_amount` is **pre-tip and post-credit**; a
comparison that drops the tip reports a false overcharge on every tipped order. That exact
mistake produced ~100 phantom rows in session 281 and two more in today's pass.

## Decision taken — block (downward only)

Both are defensible and they behave differently on the rack floor:

- **Block** (`RAISE EXCEPTION`): the re-intake fails, the operator sees why, nothing drifts.
  Strongest guarantee, but it stops a legitimate correction dead at the counter, and the
  operator's only route forward is to find someone who can refund first.
- **Record and proceed**: write the new total, emit a `billing_discrepancy` order event
  naming both numbers and the amount outstanding, and surface it in the admin "For your
  review" queue. Matches what session 281 chose for `opSaveDetails`, keeps the floor moving,
  and relies on somebody working the queue.

Session 281 chose record-and-confirm, with a human confirming in the browser. An RPC has no
dialog, so the equivalent here is record-and-proceed plus a queue item — **recommended**, for
consistency with the path that already has a guard.

## Review notes

- **Signature:** `CREATE OR REPLACE` rejects any drift in parameter defaults. Re-fetch
  `pg_get_function_arguments(p.oid)` and match byte-for-byte before writing the replacement.
  Current identity args: `p_order_id uuid, p_weight_lbs numeric, p_bags integer,
  p_total_amount numeric, p_line_items jsonb, p_service_id uuid, p_discount_id uuid,
  p_is_same_day boolean, p_notes text, p_credit_applied numeric, p_customer_id uuid,
  p_actor_name text`.
- **search_path:** must keep `SET search_path TO 'public', 'pg_temp'`.
- **Grants:** SECURITY DEFINER — preserve the existing grants exactly. Re-assert
  `REVOKE ... FROM PUBLIC` and `FROM anon`, `GRANT ... TO authenticated, service_role`, and
  confirm `exec_grantees` afterwards shows only authenticated / postgres / service_role.
- **Snapshot first:** `INSERT INTO _archive._backup_function_defs` with
  `pg_get_functiondef()` before replacing. That snapshot is the rollback script.
- **Assert after:** end the migration with a `strpos(prosrc, '<marker>') = 0 → RAISE
  EXCEPTION` check so a bad rewrite rolls back inside the migration's own transaction. Use
  `strpos`, not `LIKE` — `LIKE` eats backslashes.
- **No schema change:** no new column, no new table. The PostgREST stale-cache trap
  (sessions 176/177) does not apply, and no edge-function deploy is needed.
- **Role coverage:** intake is driven by `laundry_tech`, `manager`, `admin` and `attendant`.
  Test the new branch under each before shipping — session 148's fix missed `pos_device` and
  `attendant` and silently broke the POS.
- **Reversible:** yes, by executing the snapshotted definition.

## Also needs doing in the same pass

Grep every other branch that writes `orders.total_amount` and check which of them can lower
it after a charge. `opSaveDetails` is guarded; `record_order_intake` is the subject here;
`rack_order`, `apply_subscription_usage_fn` and `link_subscription_on_order_fn` all touch it
and have not been audited for this direction. That audit is the actual lesson from session
281, and this migration only closes one branch of it.

## Detection in the meantime

Audit check **30** (added 2026-10-06) catches the record-level symptom within a day of it
recurring. It does not prevent the overcharge — it just means the next one surfaces the next
morning instead of four weeks later.
