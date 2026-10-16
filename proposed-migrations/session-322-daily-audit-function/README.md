# session 322 — `run_daily_audit()`: the daily audit, inside the database

## Why

`database/audits/daily_audit.sql` holds 41 check entries (8 of them P0) and is the
first and most valuable step of the daily bug check. But it is a **file on David's
Mac**, so a cloud-only scheduled run cannot read it. On Sep 29 2026 the daily check
ran with no folder access and silently skipped all 41 — the report looked clean.

Binding the scheduled task to the Mac (done Sep 29) fixes it only while the Mac is
awake with the Claude desktop app open. This migration removes the dependency
entirely: the checks move into a read-only database function, and any cloud run can
call it.

## What to run

```sql
SELECT * FROM public.run_daily_audit();
```

One row per check: `check_id`, `check_name`, `priority`, `row_count`, `error`.

- `row_count = 0` → clear.
- `row_count > 0` → classify by priority, exactly as before (P0 fix now, P1
  investigate, P2/P3 count only).
- `error IS NOT NULL` → that one check failed to run; the other 41 still reported.
  Each check has its own EXCEPTION block, so one broken query can no longer blank
  the whole audit.

## How it was built

`gen_audit_fn.py` parses `daily_audit.sql` and emits the migration. The query bodies
are copied **verbatim** — the generator only strips comments in order to split
statements, then wraps each query as `SELECT count(*) FROM ( <query> ) q`.

`daily_audit.sql` stays the single source of truth. To change a check: edit that
file, re-run `python3 gen_audit_fn.py` from the repo root, review the diff, apply.
**Do not hand-edit the generated SQL.**

Two notes on the mapping:
- Check 16 ("Service-Zone Polygon Integrity") contains two independent queries in
  one entry. They are emitted as `16a` and `16b` so their counts stay separate.
  That is why 41 file entries become 42 reported checks.
- Check 24 (driver-app RPC call sites) is a filesystem scan, not SQL, and is not
  included. It still needs `scripts/audit-rpc-call-sites.sh` and therefore still
  needs the Mac.

## Safety review (washroute-migration-review, Oct 1 2026)

- **Read-only.** No INSERT / UPDATE / DELETE / DDL in the body. The only matches for
  those words are inside a comment and inside check 22's regex *string literal*,
  which scans `cron.job.command` text.
- **No schema change.** Creates one function. No table, column, constraint, index or
  RLS policy is touched, so none of the DROP/RENAME, FK, grant-on-new-table or
  PostgREST stale-cache rules apply.
- **SECURITY DEFINER, deliberately** — the audit must see every row regardless of
  RLS, as David's admin session does today. Per the session 148 checklist:
  `PERFORM assert_staff()` on entry; `REVOKE EXECUTE` from both `PUBLIC` **and**
  `anon`; `GRANT EXECUTE` to `authenticated, service_role`; explicit
  `SET search_path TO 'public', 'pg_temp'`. It PERFORMs only `assert_staff()`, so
  there is no transitive-RPC surface.
- **New signature**, so there is no parameter-default drift to match.
- Validated before handoff: dollar-quoting is `$fn$` and appears exactly twice;
  42 BEGIN/END blocks and 42 EXCEPTION handlers; parentheses balance 378/378 once
  comments and string literals are excluded. The wrapper pattern was smoke-tested
  live against checks L3 and L8 (returned 76 and 20 rows).

### Still to verify after it is applied

1. **Runtime.** 42 `count(*)` queries in one call, some over heavy CTEs (checks 18
   and 26 are the big ones). If the total exceeds the API statement timeout, add a
   `p_priority text DEFAULT NULL` filter so the scheduled run can call P0/P1
   separately. Measure first.
2. **Role coverage.** Confirm `assert_staff()` admits admin, manager, laundry_tech,
   driver, attendant and pos_device, and refuses `customer` and `anon`.

## Reversibility

```sql
DROP FUNCTION IF EXISTS public.run_daily_audit();
```

Nothing else changes, so dropping it fully restores the prior state. The scheduled
task keeps working off the file while it is bound to the Mac, so applying this is
additive — nothing depends on it until the task's prompt is pointed at it.
