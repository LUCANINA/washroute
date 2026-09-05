-- session 277 (2026-09-05) — loan_accounts.close_evidence_exception
--
-- WHY (David): "closing BayFirst will require statements + a screenshot. If this is
-- the case, it should be flagged as a requirement... eg. upload statement AND
-- screenshot showing balance." Then, on the first draft of this column: "How do you
-- make this scaleable?"
--
-- That question killed the first version, which recorded a hand-typed requirement on
-- every loan. This module already knows what happens to hand-typed policy: five wrong
-- interest_rate values still on file, prestage_enabled documented as four loans and
-- measured at eleven. A stale REQUIREMENT is worse than a stale number, because it
-- asks a person for the wrong thing every month until they learn to ignore the ask —
-- and an ignored gate is the failure this module keeps re-fixing.
--
-- So the requirement is DERIVED, in `_loanCloseEvidenceNeeded`, from two things the
-- data already answers:
--   * when this loan's balance actually MOVES (the median day it fell), and
--   * what has actually CLOSED its months — a run of `direct` anchors means one
--     in-month observation suffices; only `rolled_back` succeeding means the loan
--     structurally needs one dated after month end.
-- Measured, per loan, self-updating when a lender changes its cycle, and nothing to
-- maintain when a loan is added. BayFirst SBA Loan derives to one document (5 for 5
-- this year); BayFirst SBA 2 derives to a post-month-end balance, which is the fact
-- David hit.
--
-- THIS COLUMN IS THE EXCEPTION LAYER, and only that: facts about the OUTSIDE WORLD
-- that no amount of our own history can reveal.
--   Stripe Capital   the verdict needs a withholding export from a system we cannot
--                    read (session 245). Nothing in our data says that.
--   Ford Pro (x4)    the portal offers no export at all, so a photograph is the only
--                    form the history comes in (session 230).
-- A loan whose requirement is derivable must be left NULL here. Recording one anyway
-- re-creates the maintenance burden the derivation exists to remove.
--
-- SHAPE — a jsonb ARRAY, because the answer is genuinely plural ("statement AND
-- screenshot"). One object per required item:
--   kind         'lender_statement' | 'portal_balance' | 'withholding_export'
--                | 'transaction_history' — read through an ALLOWLIST, so a kind
--                nobody has taught the readers about is ignored rather than printed
--                as a raw slug. Same reasoning as loan_statements.source (s245): a
--                new value fails safe.
--   label        the ask in the words a person should read ("a screenshot of the
--                portal balance"). The chore falls to the business owner in Client
--                View, which is what makes asking cheap (session 262).
--   window       'in_month' | 'after_month_end'
--   earliest_day day of that window's month from which fetching is worth anything —
--                what lets the gate tell "cannot exist yet" from "late". Today those
--                render identically and only one of them is anybody's fault.
--   note         why this loan needs it.
--
-- AND THE DERIVATION IS NEVER SILENTLY OVERRIDDEN. Where a recorded item and the
-- derivation disagree, both are shown and the disagreement is a FINDING — the same
-- treatment interest_rate gets beside fitted_annual_rate (session 230), for the same
-- reason: the discrepancy is the useful part, and hiding it is how a wrong typed
-- value survives for months.
--
-- NO CHECK CONSTRAINT, NO DEFAULT. NULL means "no exception recorded", which is the
-- correct state for most loans and reads as the truth rather than as a claim. Seeding
-- Stripe and the four Fords is a separate, reviewable statement — not this one.
--
-- REPLACE SEMANTICS: written whole. Nothing in the four SPAs writes it today
-- (grepped: zero references). A future UI must MERGE, or refuse an empty array, never
-- blind-replace — the upsert_service_zone lesson (session 133), where a stale tab
-- wiped a good polygon.

ALTER TABLE public.loan_accounts
  ADD COLUMN IF NOT EXISTS close_evidence_exception jsonb;

COMMENT ON COLUMN public.loan_accounts.close_evidence_exception IS
  'EXCEPTION LAYER ONLY. What closing this loan requires is normally DERIVED from its '
  'own payment cadence and anchor history (_loanCloseEvidenceNeeded). Use this column '
  'only for a constraint that cannot be measured from our data at all — Stripe needs a '
  'withholding export from a system we cannot read; Ford offers no export, so a '
  'photograph is the only form its history comes in. jsonb array of {kind, label, '
  'window, earliest_day, note}; plural because a loan can need a statement AND a '
  'balance observation. NULL = no exception, which is correct for most loans. Where a '
  'recorded item and the derivation disagree, both are shown and the disagreement is a '
  'finding — never a silent override.';
