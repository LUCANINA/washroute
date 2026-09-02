# WashRoute — Cleanest Architectural Path Principle

*Split out of the `washroute` skill 2026-09-02. The full principle plus the 7 banked principles from session 148.*

## ⚠️ Cleanest Architectural Path Principle (session 134, strengthened session 143)

**This is now a hard rule, not a guideline.** When two implementations are on
the table — a quick patch that handles 90% of cases vs. a thoughtful design
that handles all of them correctly — **always pick the second one, and
always propose it to David before he has to ask.**

**WashRoute is past MVP.** It serves real, paying customers. It needs to scale.
We are optimizing for a system that doesn't accumulate edge-case footguns and
that compounds in quality, not technical debt. Spending an extra 30–60 minutes
(or a full session) on the right shape is always cheaper than the future
session where the edge case bites and the fix is twice as invasive because
production data is now entangled with the shortcut.

**When you spot two paths, surface both to David — explain the tradeoffs and
explicitly recommend the cleaner one.** Don't quietly take the quick path.
Don't even mention the quick path as the default. The default is the clean
path. If you're not sure which is cleaner, ask.

**Concrete checks before writing any non-trivial code or SQL:**
1. Where does this invariant *actually* belong? (UI / RPC / DB trigger — usually
   the answer is "all three layers".)
2. Is the inconsistent state representable in the UI? If yes, the UI is wrong.
3. Is the mutation leg-scoped when the invariant is order-scoped (or worse)?
   If yes, the API surface is wrong.
4. Will this code path's caller need to remember to do something to keep two
   fields in sync? If yes, hide it inside an RPC or trigger.
5. Could a future call site bypass this safety net? If yes, the safety net is
   in the wrong layer — push it down.
6. Are we storing a fact that's derivable from other columns? If yes, consider
   a generated column or computed view to eliminate drift bugs.

**Examples of the principle in action:**

Session 143 (this session) — Kalen Gleeson #4238 booked pickup + delivery on
the same time slot. The minimum patch was a DB trigger. The cleanest path was
three layers: UI auto-derives delivery from pickup so the bad state is
unrepresentable; new `reschedule_order` RPC takes both legs atomically (instead
of two separate `reschedule_order_leg` calls that have a temporary-inconsistent
state between them); DB trigger as final backstop. All three shipped.

Session 134:
- Timezone cluster used a single helper library everywhere instead of inlining
  quick fixes per site.
- `reoptimize_active_routes` rewritten to derive the active driver from
  `route_stops.driver_id` (handles split-driver days, per-stop overrides,
  future routing models) instead of just adding a second loop on
  `delivery_driver_id`.
- 3 credit + ledger sites replaced with one `apply_customer_credit_to_order` RPC.
- `routes.date` + `run_date` redundancy resolved by dropping `date` entirely
  (after verifying every reader) rather than keeping both columns in sync.

**If you catch yourself reaching for "good enough" — stop and propose the
cleanest path instead.** That is the work now.

---

### Session 148 — 7 additional cleanest-path principles banked

These came from a single day of 9 parts including 2 production regressions
and 1 customer-reported credit drain. All preventable. All now permanent
principles.

**A. Dead features destroy data silently. Disable infrastructure same-day
when a campaign ends.** The `expire-migration-credits` cron (pt 9) was a
March 2026 launch promo mechanism that kept running 6+ weeks after the
promo deadline, silently destroying $684+ in customer credit (and untold
migration credit invisible to the audit). When a one-time feature
completes, the supporting cron / edge function / trigger / config flag
MUST be disabled the same day. Leaving infrastructure alive "just in case"
is how silent harm accumulates.

**B. Don't fragment authorization bypass lists by role. Use a single
`is_staff()`-style helper covering every internal role at once.** The pt 3
→ pt 5 → pt 7 cascade shipped 3 incidents from the same architectural
mistake: each new role (driver, then pos_device, then attendant) had to be
added to a separate bypass list. After unifying into `is_staff()` (admin /
manager / laundry_tech / driver / attendant / pos_device), adding a new
internal role is a one-line change in one place. The fragmented model was
destined to keep missing roles.

**C. Cron jobs are invisible writers.** They have the same blast radius as
app code but don't show up in `db.from(...).update(...)` grep audits.
Every cron's `command` is part of the audit surface. If a cron contains
inline UPDATE / DELETE / INSERT on a critical table (orders, customers,
route_stops, addresses, routes), it MUST follow the same paired-transaction
discipline as app code — either go through an RPC or include the
`customer_transactions` (or analogous ledger) insert in the same
transaction. Check `cron.job` as part of every blast-radius audit.

**D. Batch corrections need snapshot-then-apply to avoid races with
parallel human actions.** When auto-correcting many rows in a batch, take
a snapshot of the affected rows BEFORE starting the writes. For each row,
verify the snapshot's expected state still holds at write time; skip the
row otherwise. Pt 9: I batch-restored 19 customers' credits while David
was manually refunding Cindy's card via admin in parallel. My batch
over-compensated her by $201.30 before I caught it 30 seconds later.
Snapshot-then-apply would have caught the divergence and skipped Cindy.

**E. `pg_proc.prosrc` regex audits hit comments and error-message text.**
Every match in a transitive-PERFORM audit (or any prosrc grep) requires
manual triage. Pt 7 had 5 matches; 3 were false positives (comments
referencing function names). Document this in any audit doc using the
pattern.

**F. REVOKE PUBLIC alone is not sufficient in Supabase.** Postgres'
`PUBLIC` and Supabase's `anon` role are independent grants. Every new
SECURITY DEFINER function must include BOTH `REVOKE EXECUTE ... FROM
PUBLIC` AND `REVOKE EXECUTE ... FROM anon`, then `GRANT EXECUTE ... TO
authenticated, service_role`. Pt 8 audit found 5 functions with anon
EXECUTE despite REVOKE PUBLIC in their migrations. See the mandatory
checklist in `washroute-migration-review.skill`.

**G. Test every distinct `profiles.role` value when adding an
authorization guard.** Pt 3 tested admin/customer/service_role/anon and
missed driver — Javier blocked mid-route. Pt 5 fix missed pos_device +
attendant — POS broken silently. By pt 7 the test set covered all 7
distinct values. Don't ship a new guard without coverage for every role:
`admin`, `manager`, `laundry_tech`, `driver`, `attendant`, `pos_device`,
`customer` (+ service_role + anon as JWT-context tests).

---

