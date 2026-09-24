-- Session 318d: Ask Claude can propose creating a customer account ('create_customer').
-- Only the action-type list changes; the account itself is created by the edge function
-- as the confirming staff member (RLS admin_all_customers / admin_insert_addresses).
ALTER TABLE public.assistant_actions DROP CONSTRAINT IF EXISTS assistant_actions_action_type_check;
ALTER TABLE public.assistant_actions ADD CONSTRAINT assistant_actions_action_type_check
  CHECK (action_type IN ('reschedule','skip_or_cancel','adjust_credit','update_instructions',
                         'create_issue','add_issue_comment','undo','create_customer'));
-- Rollback: same constraint without 'create_customer' (only if no such rows exist).
