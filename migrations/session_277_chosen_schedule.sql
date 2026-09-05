-- session 277 (2026-09-05) — loan_accounts.chosen_schedule_*
--
-- WHY (David, and this is now a standing rule): "The purpose of this tool is not to
-- completely erase the work of the accountant, but rather to make their job easier
-- and faster. If the best way to derive a split or settle a question the system
-- can't answer, the simple answer is: ask the person in charge, in the Action field."
--
-- THE QUESTION THIS SETTLES. Measured 2026-09-05: EIGHT active loans carry more than
-- one live payment schedule, and `_loanScheduleRows` picks between them on a sort key
-- — schedule_generated_date, then created_at, then schedule_id. Arbitrary, stable and
-- invisible. Funding Circle has four. BayFirst SBA 2's two date every payment two
-- days apart (month end vs the 2nd). PCV's differ by a whole row.
--
-- ALL EIGHT HAVE prestage_enabled. So on every one of them the projection that
-- CREATES a transaction in Xero is chosen by a tie-break with no evidence behind it.
-- Session 231 already wrote down where that leads: a stage dated later than the real
-- payment trips matched_early_suspect every period forever, and one dated in the
-- wrong month books the payment into the wrong period, WHICH NO INVARIANT CATCHES.
--
-- Two of the eight need no ask: PCV and Verdant each carry a `client_parsed_verified`
-- schedule beside a `claude_assisted_parse` one, and a human having verified one
-- beats a machine parse. Ranking settles those. An ask nobody needs is a nag, and
-- this module's history is people learning to ignore nags.
--
-- The other six are derived-vs-derived with nothing to prefer, so they get the
-- question — addressed to the CPA, who can say which projection matches the drafts
-- the lender actually takes.
--
-- SHAPE follows close_basis exactly (session 262), because it is the same kind of
-- thing: a recorded human decision that outranks inference. Four columns, not a
-- jsonb blob, so the decision is queryable and its provenance cannot be edited away
-- from the value it justifies.
--
-- FK WITH ON DELETE SET NULL, deliberately. If the chosen schedule is deleted the
-- decision is VOID and the question must come back — not silently point at nothing,
-- and not block the delete. A dangling pointer here would be read as a settled
-- decision by every caller.
--
-- NOT A DEFAULT AND NOT A BACKFILL. NULL means "nobody has decided", which is the
-- truth on all eight today. Picking one now on the same sort key the code already
-- uses would record an arbitrary choice as a human decision — the exact laundering
-- of a guess into evidence that session 230's typed-number rule exists to stop.

ALTER TABLE public.loan_accounts
  ADD COLUMN IF NOT EXISTS chosen_schedule_id uuid
    REFERENCES public.loan_amortization_schedules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS chosen_schedule_reason text,
  ADD COLUMN IF NOT EXISTS chosen_schedule_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS chosen_schedule_set_by text;

COMMENT ON COLUMN public.loan_accounts.chosen_schedule_id IS
  'A recorded human decision: WHICH payment schedule this loan actually follows, when '
  'more than one live schedule exists and nothing in the data prefers either. Read by '
  '_loanScheduleRows ahead of its sort key. NULL = undecided, which is honest and must '
  'be SAID wherever the projection is used rather than resolved by a tie-break. FK is '
  'ON DELETE SET NULL so deleting the chosen schedule voids the decision and brings '
  'the question back, rather than leaving a pointer that reads as settled.';
COMMENT ON COLUMN public.loan_accounts.chosen_schedule_reason IS
  'Why this schedule and not the other, in the decider''s own words. Required by the '
  'RPC: a decision with no reason cannot be reviewed, and the next person will re-ask.';
