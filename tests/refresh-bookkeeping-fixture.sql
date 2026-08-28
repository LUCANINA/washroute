-- ═══════════════════════════════════════════════════════════════════════════
-- Refresh tests/fixtures/bookkeeping-fixture.json
--
-- READ-ONLY. Every statement here is a SELECT. Run them against
-- umjpbuxrdydwejqtensq and drop each result into the fixture JSON under the
-- key named in the comment. The harness asserts the fixture's shape on
-- startup, so a bad refresh fails loudly instead of quietly testing nothing.
--
-- The two joined shapes matter: the page's own selects embed a child object,
-- and the stub serves rows verbatim, so the fixture has to carry the same
-- shape or the page reads `undefined` where it expects a join.
--
-- Every ORDER BY carries a unique tiebreak (usually the id). Without one,
-- jsonb_agg's row order is whatever the plan happened to produce, so two
-- refreshes of unchanged data give two different fixtures and the diff
-- cannot be read. The ONE deliberate exception is loan_amortization_rows,
-- which is pulled unordered on purpose: the page orders it row_date desc and
-- the stub's sort is stable, so the fixture's own order is what decides the
-- Dexter 2026-08-31 tie between the rate_change row (balance 0.00) and the
-- real payment row (86,066.61). Imposing an order here would quietly resolve
-- a coin flip that production leaves open, and hide the hazard from the test.
-- ═══════════════════════════════════════════════════════════════════════════

-- → "loan_accounts"
select jsonb_agg(to_jsonb(x) order by x.lender_account_number)
from (select * from loan_accounts) x;

-- → "loan_statements"
select jsonb_agg(to_jsonb(x) order by x.statement_date desc, x.id)
from (select * from loan_statements) x;

-- → "loan_splits"   (NOTE the embedded loan_accounts object — the page joins it)
select jsonb_agg(to_jsonb(x) - 'pre_split_line_items_snapshot' order by x.period_label desc, x.id)
from (
  select s.*,
         jsonb_build_object('lender_account_number', a.lender_account_number,
                            'xero_account_name',     a.xero_account_name,
                            'lender',                a.lender) as loan_accounts
  from loan_splits s
  left join loan_accounts a on a.id = s.loan_account_id
) x;

-- → "loan_amortization_rows"  (NOTE the embedded loan_amortization_schedules object)
select jsonb_agg(to_jsonb(x))
from (
  select r.id, r.schedule_id, r.row_date, r.row_type, r.balance, r.principal,
         r.interest, r.payment, r.rate, r.loan_amt,
         -- id + created_at are the deterministic tiebreak when a loan has two
         -- schedules (Verdant has two, with overlapping rows and duplicate
         -- dates): newest schedule_generated_date, tie-broken by created_at.
         -- Without them "pick the newest schedule" is not implementable.
         jsonb_build_object('id',                      sc.id,
                            'storage_path',            sc.storage_path,
                            'contract_id',             sc.contract_id,
                            'schedule_generated_date', sc.schedule_generated_date,
                            'created_at',              sc.created_at,
                            'loan_account_id',         sc.loan_account_id,
                            'balance_basis',           sc.balance_basis,
                            'amort_type',              sc.amort_type) as loan_amortization_schedules
  from loan_amortization_rows r
  left join loan_amortization_schedules sc on sc.id = r.schedule_id
) x;

-- → "loan_book_balances"
--   The books-side (Xero-rebuilt) balance per loan per date. Independent of any
--   amortization schedule, which is the whole point: without it a schedule-based
--   closing balance compared against a schedule-based opening agrees by
--   construction and tests nothing.
--
--   NO LONGER EMPTY. reconciliation-run v50 (2026-08-28) writes it: 44 rows,
--   22 loans x the closing and prior month ends. Two consequences for anyone
--   refreshing this fixture. First, several loans that printed a $0.00 tie now
--   report a real variance, because the opening moved from a lender statement
--   to Xero's own rebuilt ledger and the books are finally inside the check —
--   that is the design working, not a regression (see the closing-evidence
--   group, section 19, which cross-checks each one against loan_tie_outs).
--   Second, any harness scenario that plants a books balance must REPLACE the
--   loan's rows rather than append to them, or it lands beside a real row and
--   _loanBookBalanceAsOf picks whichever was computed later.
--
--   The coalesce stays: an empty array is still the correct fixture value if
--   this is ever pulled against a project where the run has not happened, and
--   the table must stay registered in FIXTURE_TABLES so the harness fails
--   loudly if the key disappears rather than silently serving [].
select coalesce(jsonb_agg(to_jsonb(x) order by x.as_of desc, x.loan_account_id), '[]'::jsonb)
from (select * from loan_book_balances) x;

-- → the remaining flat tables, one object, one key per table
select jsonb_build_object(
  'loan_documents',                (select jsonb_agg(to_jsonb(x) order by x.created_at desc)  from (select * from loan_documents) x),
  'payroll_imports',               (select jsonb_agg(to_jsonb(x) order by x.pay_period_end desc, x.id) from (select * from payroll_imports) x),
  'payroll_import_employee_lines', (select jsonb_agg(to_jsonb(x) order by x.id) from (
      select id, import_id, raw_full_name, department_key, matched_employee_id, wage_amount,
             er_tax_amount, er_health_amount, er_401k_amount, paycheck_tips_amount, line_type
      from payroll_import_employee_lines) x),
  'payroll_departments',           (select jsonb_agg(to_jsonb(x) order by x.sort_order) from (select * from payroll_departments) x),
  'payroll_employees',             (select jsonb_agg(to_jsonb(x) order by x.full_name)  from (select * from payroll_employees) x),
  'payroll_notices',               (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from payroll_notices where active) x),
  'bk_issue_dismissals',           (select jsonb_agg(to_jsonb(x) order by x.item_key) from (select * from bk_issue_dismissals) x),
  'bookkeeping_kpi_snapshots',     (select jsonb_agg(to_jsonb(x)) from (
      select captured_at, payload from bookkeeping_kpi_snapshots where error is null
      order by captured_at desc limit 1) x)
);

-- → reconciliation. loan_tie_outs is scoped to the newest COMPLETED run,
--   exactly as loadReconciliation() scopes it.
with newest as (
  select id from reconciliation_runs
  where finished_at is not null and status <> 'failed'
  order by started_at desc limit 1
)
select jsonb_build_object(
  'reconciliation_runs',     (select jsonb_agg(to_jsonb(x) order by x.started_at desc)
                              from (select * from reconciliation_runs order by started_at desc limit 10) x),
  'reconciliation_findings', (select jsonb_agg(to_jsonb(x) order by x.last_seen_at desc, x.id)
                              from (select * from reconciliation_findings where status in ('open','resolved')) x),
  'loan_tie_outs',           (select jsonb_agg(to_jsonb(x) order by x.loan_account_id) from (
                                select loan_account_id, status, difference, xero_balance, lender_balance,
                                       as_of, anchor_source, run_id, detail
                                from loan_tie_outs where run_id = (select id from newest)) x)
);
