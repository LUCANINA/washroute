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
         jsonb_build_object('storage_path',            sc.storage_path,
                            'contract_id',             sc.contract_id,
                            'schedule_generated_date', sc.schedule_generated_date,
                            'loan_account_id',         sc.loan_account_id,
                            'balance_basis',           sc.balance_basis,
                            'amort_type',              sc.amort_type) as loan_amortization_schedules
  from loan_amortization_rows r
  left join loan_amortization_schedules sc on sc.id = r.schedule_id
) x;

-- → the remaining flat tables, one object, one key per table
select jsonb_build_object(
  'loan_documents',                (select jsonb_agg(to_jsonb(x) order by x.created_at desc)  from (select * from loan_documents) x),
  'payroll_imports',               (select jsonb_agg(to_jsonb(x) order by x.pay_period_end desc) from (select * from payroll_imports) x),
  'payroll_import_employee_lines', (select jsonb_agg(to_jsonb(x)) from (
      select id, import_id, raw_full_name, department_key, matched_employee_id, wage_amount,
             er_tax_amount, er_health_amount, er_401k_amount, paycheck_tips_amount, line_type
      from payroll_import_employee_lines) x),
  'payroll_departments',           (select jsonb_agg(to_jsonb(x) order by x.sort_order) from (select * from payroll_departments) x),
  'payroll_employees',             (select jsonb_agg(to_jsonb(x) order by x.full_name)  from (select * from payroll_employees) x),
  'payroll_notices',               (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (select * from payroll_notices where active) x),
  'bk_issue_dismissals',           (select jsonb_agg(to_jsonb(x)) from (select * from bk_issue_dismissals) x),
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
  'reconciliation_findings', (select jsonb_agg(to_jsonb(x) order by x.last_seen_at desc)
                              from (select * from reconciliation_findings where status in ('open','resolved')) x),
  'loan_tie_outs',           (select jsonb_agg(to_jsonb(x)) from (
                                select loan_account_id, status, difference, xero_balance, lender_balance,
                                       as_of, anchor_source, run_id
                                from loan_tie_outs where run_id = (select id from newest)) x)
);
